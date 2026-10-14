import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { AnalysisFinding } from "../../../domain/print/types";
import { modelSpecForBambuModelId } from "../../../domain/printers/modelSpecs";
import { printerModelsMatchStrict } from "../../../domain/slicing/printerModel";
import { analyzeGcodeText } from "./gcode";
import { finding, type AnalyzerLimits, type AnalyzerResult } from "./types";
import { type SafeZip, ZipSafetyError } from "./zip";

/**
 * **The G-code a sliced package will actually run — found, read and judged.**
 *
 * A `.gcode.3mf` used to be judged by its `slice_info.config` alone: which
 * printer and material it *says* it was made for. The G-code inside — the only
 * part a printer executes — was never opened, so a package could carry a
 * firmware reset, a wrong-machine start sequence or a truncated plate and still
 * be offered as printable after a review click. Now the payload is streamed out
 * of the archive and put through the same analysis a bare `.gcode` gets: the
 * command policy, the header metadata, the printed box.
 *
 * "The payload" is one entry and it is named: the printer starts exactly one
 * `Metadata/plate_N.gcode`, and that name is recorded so the start command can
 * name the same entry. A package carrying several G-code entries has no single
 * answer and is refused rather than shipped as whichever comes first; one whose
 * `.md5` sidecar disagrees with its bytes is refused too — the printer verifies
 * that sum and would reject it, and a mismatch means the bytes are not the ones
 * the slicer wrote.
 */
export interface PayloadInspection {
  /** The entry the printer starts (`Metadata/plate_1.gcode`); null when there is no single one. */
  entry: string | null;
  /** The plate number the entry's name carries (`plate_2.gcode` → 2), when it does. */
  plateIndex: number | null;
  /** The embedded G-code's own analysis; null when it was not (or could not be) read. */
  gcode: AnalyzerResult | null;
  /** Inflated size of the payload, bytes. */
  bytes: number | null;
  /** Upper-case MD5 of the payload, as a Bambu `.md5` sidecar spells it. */
  md5: string | null;
  /** The sidecar agrees (true), disagrees (false), or is absent (null). */
  md5Verified: boolean | null;
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
}

const SIDECAR_MAX_BYTES = 1024;
const PLATE_NUMBER = /plate_(\d+)\.(?:gcode|gco|g)$/i;

export async function inspectSlicedPayload(input: {
  zip: SafeZip;
  gcodeEntries: readonly string[];
  plateCount: number;
  limits: AnalyzerLimits;
}): Promise<PayloadInspection> {
  const none: PayloadInspection = {
    entry: null,
    plateIndex: null,
    gcode: null,
    bytes: null,
    md5: null,
    md5Verified: null,
    warnings: [],
    blockers: []
  };
  // Several plates are several prints; which one would ship is a delivery
  // problem this farm refuses outright (see `evaluateExecutableArtifact`), so
  // there is no single payload to judge.
  if (input.plateCount > 1) return none;
  if (input.gcodeEntries.length !== 1) {
    return {
      ...none,
      blockers: [
        finding(
          "threemf_payload_ambiguous",
          `В пакете ${input.gcodeEntries.length} файлов G-code (${input.gcodeEntries.slice(0, 4).join(", ")}) — неясно, какой из них печатать`,
          "Экспортируйте из слайсера одну пластину отдельным файлом."
        )
      ]
    };
  }

  const entry = input.gcodeEntries[0];
  const plate = PLATE_NUMBER.exec(entry);
  const plateIndex = plate ? Number(plate[1]) : null;
  const hash = createHash("md5");
  let bytes = 0;
  async function* text(): AsyncGenerator<string> {
    const decoder = new StringDecoder("utf8");
    for await (const chunk of input.zip.stream(entry, input.limits.zipMaxEntryBytes)) {
      hash.update(chunk);
      bytes += chunk.length;
      const piece = decoder.write(chunk);
      if (piece) yield piece;
    }
    const tail = decoder.end();
    if (tail) yield tail;
  }

  let gcode: AnalyzerResult;
  try {
    gcode = await analyzeGcodeText(text());
  } catch (error) {
    if (error instanceof ZipSafetyError) {
      return {
        ...none,
        entry,
        plateIndex,
        blockers: [
          finding(
            error.code,
            `G-code внутри пакета не читается: ${error.message}`,
            error.hint ?? "Экспортируйте файл из слайсера заново."
          )
        ]
      };
    }
    throw error;
  }
  const md5 = hash.digest("hex").toUpperCase();

  const blockers: AnalysisFinding[] = [];
  const warnings: AnalysisFinding[] = [];
  const declaredMd5 = await readSidecar(input.zip, `${entry}.md5`);
  const md5Verified = declaredMd5 === null ? null : declaredMd5 === md5;
  if (md5Verified === false) {
    blockers.push(
      finding(
        "threemf_payload_md5_mismatch",
        `Контрольная сумма G-code внутри пакета не совпадает с записанной (${md5.slice(0, 8)}… ≠ ${(declaredMd5 ?? "").slice(0, 8)}…) — файл повреждён или изменён после нарезки`,
        "Экспортируйте файл из слайсера заново: принтер такой пакет всё равно отклонит."
      )
    );
  }
  if (bytes === 0) {
    blockers.push(finding("threemf_payload_empty", "G-code внутри пакета пуст — печатать нечего"));
  }

  return { entry, plateIndex, gcode, bytes, md5, md5Verified, warnings, blockers };
}

/** The upper-case hex a `.md5` sidecar holds, or null when there is none (or it is not one). */
async function readSidecar(zip: SafeZip, name: string): Promise<string | null> {
  const actual = zip.resolve(name);
  if (!actual) return null;
  try {
    const text = (await zip.read(actual, SIDECAR_MAX_BYTES)).toString("utf8").trim().toUpperCase();
    return /^[0-9A-F]{32}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * The machine a sliced package was made for, as ONE model name the farm's model
 * rule can compare — or a refusal when the package contradicts itself.
 *
 * Two witnesses, read differently. The payload's own header
 * (`; printer_model = Bambu Lab A1`) is what the slicer wrote into the G-code
 * the printer will run, so it is preferred. `slice_info.config` names the
 * machine by Bambu's internal id (`N2S`), which is translated through the model
 * catalogue — an id the catalogue does not know is no name at all, never the
 * nearest-looking one. When both speak and disagree, neither is believed.
 *
 * `printerModel` is the key the dispatch gate reads as "the file's declared
 * target"; the analyzer used to file this under `targetPrinter`, which nothing
 * on the gate read, so a sliced package's target was never checked at all.
 */
export function resolveSlicedTarget(input: {
  sliceInfoPrinter: string | null;
  payloadPrinterModel: string | null;
}): {
  printerModel: string | null;
  /** The raw `printer_model_id` when the slice info carried one. */
  printerModelId: string | null;
  conflict: AnalysisFinding | null;
} {
  const raw = input.sliceInfoPrinter?.trim() || null;
  const isModelId = raw !== null && BAMBU_MODEL_ID.test(raw);
  const fromInfo = raw === null ? null : isModelId ? (modelSpecForBambuModelId(raw)?.name ?? null) : raw;
  const fromPayload = input.payloadPrinterModel?.trim() || null;

  if (fromPayload && fromInfo && !printerModelsMatchStrict(fromPayload, fromInfo)) {
    return {
      printerModel: null,
      printerModelId: isModelId ? raw : null,
      conflict: finding(
        "threemf_target_conflict",
        `Пакет противоречит сам себе: G-code собран для «${fromPayload}», а описание пакета называет «${fromInfo}»`,
        "Нарежьте и экспортируйте файл заново под нужный принтер."
      )
    };
  }
  return { printerModel: fromPayload ?? fromInfo, printerModelId: isModelId ? raw : null, conflict: null };
}

/** Bambu's internal model ids (`N2S`, `C12`, `BL-P001`) — short codes, never a spelled-out name. */
const BAMBU_MODEL_ID = /^[A-Z]{1,2}[0-9A-Z]{0,3}(-[A-Z0-9]{1,6})?$/i;
