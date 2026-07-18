import type {
  Artifact,
  ArtifactAnalysis,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import type { PrinterConfig } from "../../infra/printers/config";
import { normalizeStartablePath } from "../../infra/printers/files";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { materialsIncompatible, parseEtaMinutes } from "../nightPlanner";

/** One hard reason a dispatch must not happen; `code` is stable for tests/UI. */
export interface DispatchBlocker {
  code: string;
  message: string;
}

export type DispatchMode = "manual" | "night";

export interface DispatchGateInput {
  mode: DispatchMode;
  task: PrintTask;
  entry: QueueEntry | null;
  artifact: Artifact | null;
  /** The LATEST analysis of the artifact (any state), or null when none exists. */
  analysis: ArtifactAnalysis | null;
  printer: PrinterConfig;
  /** Poll-cache live status; the physical layer re-reads fresh before sending. */
  status: PrinterLiveStatus | undefined;
  /** Whether the driver supports a remote start at all. */
  remoteStartSupported: boolean;
  /** Night window length in minutes (null = unknown/unparseable window). */
  nightWindowMinutes: number | null;
  /** Multiplier applied to the ETA before checking the window fit (≥ 1). */
  nightSafetyBufferRatio: number;
  /** The analyzer version currently shipped — an older analysis is stale. */
  currentAnalyzerVersion: string;
}

const GCODE_EXT_RE = /\.(gcode|gco|g)$/i;
const MODEL_EXT_RE = /\.(stl|3mf)$/i;

function blocker(code: string, message: string): DispatchBlocker {
  return { code, message };
}

function isUnknown(value: string | null | undefined): boolean {
  const v = value?.trim();
  return !v || v === "—";
}

/**
 * The single fail-closed admission check every canonical dispatch runs *inside
 * the reserve transaction*, immediately before the run/assignment/guard rows
 * are written. Pure and synchronous so it is exhaustively testable and cannot
 * be bypassed by a stale preview: it looks only at the rows just re-read from
 * SQLite and the live printer status — never at anything a client sent.
 *
 * Manual (attended) mode allows a task whose artifact is only an on-printer
 * file name with no registered bytes — the operator is present. It still
 * refuses any artifact whose *existing* analysis is not clean: a `blocked`,
 * `review`, `needs_preparation`, `needs_input`, unknown-format or
 * blocker-carrying result never dispatches, attended or not.
 *
 * Night (unattended) mode is strictly stronger: it requires a registered
 * artifact with an immutable sha256, a fresh `ready` analysis by the current
 * analyzer with verdict `schedulable`, content-verified `gcode` format, no
 * blockers, explicit `night` + `unattendedAllowed` on the task, a confirmed
 * idle online printer, verified material on both sides, and an ETA that fits
 * the night window with the safety buffer.
 */
export function evaluateDispatchGate(input: DispatchGateInput): DispatchBlocker[] {
  const { mode, task, entry, artifact, analysis, printer, status } = input;
  const blockers: DispatchBlocker[] = [];

  // ── Task / queue shape ────────────────────────────────────────────────────
  if (task.state !== "QUEUED") {
    blockers.push(
      blocker("TASK_STATE", `задание в состоянии «${task.state}» — запускать можно только из QUEUED`)
    );
  }
  if (!entry) {
    blockers.push(blocker("NO_QUEUE_ENTRY", "у задания нет записи в очереди"));
  } else if (entry.state !== "WAITING") {
    blockers.push(
      blocker("ENTRY_STATE", `запись очереди в состоянии «${entry.state}» — запуск только из WAITING`)
    );
  }

  // ── File identity ─────────────────────────────────────────────────────────
  const file = resolveDispatchFile(task, artifact);
  if (!file) {
    blockers.push(blocker("NO_FILE", "у задания не задан файл для запуска на принтере"));
  } else {
    try {
      normalizeStartablePath(file);
    } catch {
      blockers.push(blocker("BAD_FILE_PATH", `файл «${file}» не проходит проверку пути`));
    }
  }

  // ── Analysis honesty (both modes): an existing analysis must be clean ─────
  if (analysis) {
    if (analysis.state === "failed") {
      blockers.push(blocker("ANALYSIS_FAILED", "анализ файла завершился ошибкой — перезапустите анализ"));
    } else if (analysis.state === "pending" || analysis.state === "running") {
      blockers.push(blocker("ANALYSIS_IN_PROGRESS", "анализ файла ещё не завершён"));
    } else {
      if (analysis.blockers.length > 0) {
        blockers.push(
          blocker(
            "ANALYSIS_BLOCKERS",
            `анализ выявил критические проблемы: ${analysis.blockers.map((b) => b.message).join("; ")}`
          )
        );
      }
      if (analysis.verdict && analysis.verdict !== "schedulable") {
        blockers.push(
          blocker(
            "ANALYSIS_VERDICT",
            `вердикт анализа «${analysis.verdict}» не допускает запуск (нужен schedulable)`
          )
        );
      }
      if (analysis.detectedFormat === "unknown") {
        blockers.push(blocker("FORMAT_UNKNOWN", "формат файла не распознан по содержимому"));
      }
      // The extension is NOT proof of format — a contradiction blocks.
      if (file && analysis.detectedFormat) {
        const claimsGcode = GCODE_EXT_RE.test(file);
        const claimsModel = MODEL_EXT_RE.test(file);
        if (claimsGcode && analysis.detectedFormat !== "gcode") {
          blockers.push(
            blocker(
              "FORMAT_MISMATCH",
              `расширение обещает G-code, содержимое — «${analysis.detectedFormat}»`
            )
          );
        } else if (claimsModel && analysis.detectedFormat === "gcode") {
          blockers.push(
            blocker("FORMAT_MISMATCH", "расширение обещает модель (STL/3MF), содержимое — G-code")
          );
        }
      }
      // A file changed after (or analysed by an older analyzer than) the current
      // toolchain is stale evidence — fail-closed for unattended, and an honest
      // blocker for attended too when the artifact content is hash-tracked.
      if (artifact?.sha256) {
        if (analysis.updatedAt < artifact.updatedAt) {
          blockers.push(blocker("ANALYSIS_STALE", "файл изменился после последнего анализа"));
        }
        if (
          analysis.analyzerVersion &&
          analysis.analyzerVersion !== input.currentAnalyzerVersion
        ) {
          blockers.push(
            blocker(
              "ANALYZER_OUTDATED",
              `анализ выполнен версией ${analysis.analyzerVersion}, текущая ${input.currentAnalyzerVersion} — перезапустите анализ`
            )
          );
        }
      }
    }
  }

  // ── Printer basics (poll cache; the physical layer re-reads fresh) ────────
  if (!input.remoteStartSupported) {
    blockers.push(
      blocker("REMOTE_START_UNSUPPORTED", `удалённый запуск для «${printer.name}» не поддерживается`)
    );
  }
  if (!status || !status.online) {
    blockers.push(blocker("PRINTER_OFFLINE", `«${printer.name}» не в сети`));
  } else if (status.status === "printing" || status.status === "paused") {
    blockers.push(blocker("PRINTER_BUSY", `«${printer.name}» уже занят печатью`));
  } else if (status.status !== "idle") {
    blockers.push(
      blocker("PRINTER_NOT_IDLE", `состояние «${printer.name}» не подтверждено (${status.status})`)
    );
  }

  // A concrete material contradiction refuses in BOTH modes.
  if (
    !isUnknown(task.material) &&
    !isUnknown(printer.material) &&
    materialsIncompatible(task.material ?? "", printer.material)
  ) {
    blockers.push(
      blocker(
        "MATERIAL_MISMATCH",
        `материал задания (${task.material}) не совпадает с заправленным (${printer.material})`
      )
    );
  }

  if (mode === "night") {
    blockers.push(...nightOnlyBlockers(input, file));
  }

  return blockers;
}

/** The on-device file a dispatch would start: the task's file hint first, then the artifact locator. */
export function resolveDispatchFile(task: PrintTask, artifact: Artifact | null): string | null {
  // The task's `metadata.file` is the on-device path in every flow (legacy add,
  // import, scheduler); an artifact's `source` doubles as the on-device path
  // only for legacy name-only artifacts (content-addressed blobs use keys).
  const metaFile = task.metadata.file;
  if (typeof metaFile === "string" && metaFile.trim()) return metaFile.trim();
  if (artifact && artifact.sha256 === null && artifact.source) return artifact.source;
  return null;
}

function nightOnlyBlockers(input: DispatchGateInput, file: string | null): DispatchBlocker[] {
  const { task, artifact, analysis, printer, status } = input;
  const blockers: DispatchBlocker[] = [];

  if (task.night !== true) {
    blockers.push(
      blocker("NOT_NIGHT_FLAGGED", "задание не отмечено для печати без присмотра — подтвердите явно")
    );
  }
  if (task.unattendedAllowed !== true) {
    blockers.push(
      blocker(
        "UNATTENDED_NOT_ALLOWED",
        "для задания не дано явное разрешение unattended-печати (unattendedAllowed)"
      )
    );
  }

  // Unattended dispatch is only ever for a registered artifact with an
  // immutable content identity and a clean, fresh, content-verified analysis.
  if (!artifact) {
    blockers.push(blocker("NO_ARTIFACT", "у задания нет зарегистрированного артефакта"));
  } else {
    if (!artifact.sha256) {
      blockers.push(
        blocker(
          "NO_ARTIFACT_HASH",
          "артефакт не имеет контрольной суммы — идентичность файла нельзя доказать"
        )
      );
    }
    if (artifact.sizeBytes === null) {
      blockers.push(blocker("NO_ARTIFACT_SIZE", "размер артефакта не зафиксирован"));
    }
  }
  if (!analysis || analysis.state !== "ready") {
    blockers.push(blocker("NO_ANALYSIS", "нет завершённого анализа файла"));
  } else {
    if (analysis.verdict !== "schedulable") {
      blockers.push(
        blocker("NIGHT_VERDICT", `вердикт «${analysis.verdict ?? "—"}» не допускает ночной запуск`)
      );
    }
    if (analysis.detectedFormat !== "gcode") {
      blockers.push(
        blocker(
          "NIGHT_FORMAT",
          `ночной запуск требует подтверждённый G-code (обнаружено: ${analysis.detectedFormat ?? "—"})`
        )
      );
    }
  }

  // Material must be verifiable on BOTH sides for a print nobody watches.
  if (isUnknown(task.material) || isUnknown(printer.material)) {
    blockers.push(
      blocker("MATERIAL_UNKNOWN", "материал не подтверждён с обеих сторон — ночной запуск запрещён")
    );
  }

  // Unattended start demands a confirmed idle (the generic check above already
  // reports offline/busy/non-idle; nothing extra needed here).
  void status;

  // The ETA must be known and fit the window with the safety buffer.
  const etaMinutes = nightEtaMinutes(task, analysis);
  if (etaMinutes === null) {
    blockers.push(
      blocker("ETA_UNKNOWN", "длительность печати неизвестна — нельзя проверить ночное окно")
    );
  } else if (input.nightWindowMinutes !== null) {
    const buffered = etaMinutes * Math.max(1, input.nightSafetyBufferRatio);
    if (buffered > input.nightWindowMinutes) {
      blockers.push(
        blocker(
          "ETA_TOO_LONG",
          `печать (${Math.round(buffered)} мин с запасом) не впишется в ночное окно (${input.nightWindowMinutes} мин)`
        )
      );
    }
  }

  void file;
  return blockers;
}

/** Night ETA in minutes: the analyzer's estimate first, the operator hint second. */
export function nightEtaMinutes(
  task: PrintTask,
  analysis: ArtifactAnalysis | null
): number | null {
  if (analysis?.estimatedDurationS != null && analysis.estimatedDurationS > 0) {
    return Math.ceil(analysis.estimatedDurationS / 60);
  }
  const eta = task.metadata.eta;
  if (typeof eta === "string") return parseEtaMinutes(eta);
  return null;
}
