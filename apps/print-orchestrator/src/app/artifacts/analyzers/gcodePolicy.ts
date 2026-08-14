import type { AnalysisFinding } from "../../../domain/print/types";
import { finding } from "./types";

/**
 * Command policy for print files, by *threat model* rather than a blind denylist.
 *
 * A normal sliced print needs only: motion (G0–G5, G10/G11, G28/G29, G90–G92,
 * G20/G21, G4), extrusion mode (M82/M83), temperatures (M104/M109, M140/M190,
 * M141/M191), fans (M106/M107), steppers (M17/M18/M84), motion tuning the slicers
 * themselves emit (M201–M205, M220/M221, M900), reports (M105/M114/M115), display
 * (M117/M118) and tool selects (T*). Those pass, as does any command this policy
 * does not know: a denylist that guessed at unknown vocabulary would reject every
 * vendor dialect (Bambu alone adds ~40 M-codes) while adding no safety.
 *
 * Everything the policy *does* know falls into three classes:
 *
 * - **Forbidden** — mutates firmware/persistent configuration, manages files,
 *   resets/updates the machine, or chains other jobs. Never needed inside a print
 *   job; presence makes the file `blocked`.
 * - **Review** — legitimate in *some* attended workflows but incompatible with an
 *   unattended print (waits for a human, kills power, changes live calibration,
 *   drives raw pins). Presence forces at least `review`.
 * - **Gated** — dangerous *in some contexts and routine in others*, so a single
 *   verdict for the word alone would be wrong either way. `M500` is the case that
 *   forced this class into existence; see below.
 *
 * ## Why `M500` cannot be judged by its opcode alone
 *
 * `M500` writes the firmware's *current in-memory settings* to persistent storage.
 * On a Marlin/Klipper machine, inside a print job, that is a real attack: pair it
 * with an `M92`/`M301`/`M851` and a print file permanently re-calibrates the
 * printer for every job that follows. Blanket-forbidding it was therefore right —
 * for the machines the rule was written against.
 *
 * It is also, verbatim, part of the *stock* start G-code Bambu Lab ships for every
 * one of its printers. OrcaSlicer 2.3.0's own `resources/profiles/BBL` carries it in
 * 22 machine profiles (A1, A1 mini, P1P, P1S, X1, X1C, X1E), always in exactly this
 * shape:
 *
 * ```gcode
 * ;===== bed leveling ==================================
 * M1002 judge_flag g29_before_print_flag
 * M622 J1                       ; conditional: only if levelling is due
 *     M1002 gcode_claim_action : 1
 *     G29 A1 X109.5 Y59.3 I32.9 J137.3   ; adaptive mesh over the first layer
 *     M400                      ; wait for the probing moves to finish
 *     M500 ; save cali data     ; persist the mesh that was JUST measured
 * M623
 * ```
 *
 * Nothing there mutates a setting: `G29` *measures* the bed, and `M500` is how that
 * measurement survives. Refusing it means refusing every Bambu print — which is what
 * this farm's first real A1 slice hit: a perfectly valid 4 MB PETG G-code, `blocked`
 * on its own vendor's levelling routine.
 *
 * So the policy is contextual, and deliberately built out of evidence the file itself
 * carries rather than a trust flag:
 *
 * 1. **the machine** — the target must be a Bambu Lab printer (`printer_model`);
 * 2. **the toolchain** — an OrcaSlicer/BambuStudio banner, i.e. not hand-written;
 * 3. **the dialect** — the file must really speak Bambu (`M622`/`M623` conditionals),
 *    which no Marlin or Klipper file does;
 * 4. **the context** — each `M500` must sit inside an `M622…M623` block that already
 *    ran a `G29`, i.e. it is saving a measurement, not settings;
 * 5. **the absence of a mutation** — if *any* settings-writing command
 *    ({@link SETTINGS_MUTATING}) appeared earlier in the file, every later `M500` is
 *    forbidden again, whatever the vendor. This is the condition that actually
 *    carries the security property: an attacker cannot make `M500` harmful without
 *    first changing something for it to persist, and doing that re-arms the blocker
 *    (besides being a `review` command in its own right).
 *
 * All five must hold. Any one failing puts `M500` back where it was — a blocker —
 * and the finding says which link broke.
 *
 * ## Why not simply trust our own slicer
 *
 * The tempting shortcut is a provenance flag: "this G-code came out of our verified
 * OrcaSlicer pipeline from an approved profile set, so skip the check". It is
 * rejected on purpose. The same analyzer guards *uploaded* G-code, and a boolean
 * that disarms it would become the single thing an attacker has to forge — while the
 * evidence rules above are things a hostile file cannot fake into being dangerous.
 * Provenance also could not protect the operator from a *profile* that legitimately
 * carries a bad command (which is precisely why the output of our own slicer is
 * analysed at all). The rules stay content-derived, and they are applied identically
 * to a file we produced and a file someone handed us.
 */

/** Verdict for one command word in one file. */
export type CommandClass = "allowed" | "review" | "forbidden";

/** Commands that are never acceptable inside a print job, on any machine. */
const FORBIDDEN_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["M501", "загрузка настроек из EEPROM (подменяет конфигурацию во время печати)"],
  ["M502", "сброс настроек к заводским"],
  ["M509", "изменение защиты EEPROM"],
  ["M997", "перепрошивка firmware"],
  ["M999", "перезапуск после ошибки (маскирует аварию)"],
  ["M22", "размонтирование SD-карты"],
  ["M23", "выбор другого файла на SD (сцепление заданий)"],
  ["M24", "запуск печати с SD (сцепление заданий)"],
  ["M28", "запись файла на SD"],
  ["M29", "завершение записи файла на SD"],
  ["M30", "удаление файла с SD"],
  ["M32", "запуск другого файла (сцепление заданий)"],
  ["SAVE_CONFIG", "запись конфигурации Klipper и перезапуск"],
  ["FIRMWARE_RESTART", "перезапуск firmware Klipper"],
  ["RESTART", "перезапуск Klipper"],
  ["RUN_SHELL_COMMAND", "выполнение shell-команды на хосте"]
]);

/** Legitimate in an attended workflow, never in an unattended one. */
const REVIEW_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["M0", "остановка с ожиданием человека"],
  ["M1", "остановка с ожиданием человека"],
  ["M25", "пауза SD-печати"],
  ["M112", "аварийный стоп внутри файла"],
  ["M226", "ожидание состояния пина"],
  ["M600", "смена филамента — требует присутствия"],
  ["M80", "управление питанием"],
  ["M81", "выключение питания"],
  ["M42", "прямое управление пином"],
  ["M280", "управление сервоприводом"],
  ["M302", "разрешение холодной экструзии"],
  ["M92", "изменение калибровки шагов"],
  ["M301", "изменение PID хотэнда"],
  ["M304", "изменение PID стола"],
  ["PID_CALIBRATE", "калибровка PID во время задания"],
  ["BED_MESH_CALIBRATE", "калибровка стола во время задания"],
  ["DELTA_CALIBRATE", "калибровка кинематики"]
]);

/**
 * Commands that leave behind machine calibration an `M500` would make permanent.
 * Seeing any of them arms every later `M500` as forbidden, regardless of vendor or
 * context — this is the rule that keeps the gate a security control rather than a
 * courtesy. Most are already `review` on their own; the two lists answer different
 * questions ("may this run unattended?" vs "is there now something to persist?").
 *
 * The per-print motion limits every slicer writes into a file's body (`M201`–`M205`,
 * `M220`/`M221`) are deliberately absent. `M500` would persist those too, but arming
 * on them would forbid `M500` in every sliced file ever produced — noise, not
 * safety, since a saved acceleration ceiling harms nothing and the next print
 * overwrites it anyway.
 */
const SETTINGS_MUTATING: ReadonlySet<string> = new Set([
  "M92", // steps per unit
  "M206", // home offset
  "M218", // hotend offset
  "M301", // hotend PID
  "M304", // bed PID
  "M420", // bed levelling state
  "M665", // delta geometry
  "M666", // endstop adjustment
  "M851", // probe Z offset
  "M900" // linear/pressure advance
]);

/** What the file says about itself — the evidence the gated rules are judged on. */
export interface GcodeProvenance {
  /** `; generated by OrcaSlicer 2.3.0` → `OrcaSlicer`; null when unrecognised. */
  slicer: string | null;
  /** `; printer_model = Bambu Lab A1`; null when the file names no target. */
  printerModel: string | null;
}

/** One occurrence of a gated command, with the context that decides its class. */
interface Sighting {
  word: string;
  /** 1-based line, so a finding can point the operator at it. */
  line: number;
  /** Inside at least one open Bambu `M622…M623` conditional. */
  conditional: boolean;
  /** A `G29*` (bed probing) ran earlier inside one of the open conditionals. */
  afterProbing: boolean;
  /** A {@link SETTINGS_MUTATING} command ran anywhere earlier in the file. */
  afterMutation: boolean;
}

/**
 * Streams a file's command words and classifies the gated ones at the end, when the
 * header metadata that decides them is finally known. Order matters: PrusaSlicer-
 * family files put their config block at the top and Cura's at the bottom, so no
 * judgement can be made while scanning.
 */
export class CommandPolicy {
  private readonly forbidden = new Map<string, number>();
  private readonly review = new Set<string>();
  private readonly gated: Sighting[] = [];

  /**
   * The open Bambu conditionals, innermost last, each remembering whether a `G29`
   * has run inside it. A stack rather than a counter because Bambu genuinely nests
   * these (its `change_filament_gcode` opens an `M622 J0` inside an `M622 J1`), and
   * a counter would let an inner block's close erase the outer block's probe —
   * refusing a perfectly ordinary levelling sequence.
   */
  private readonly openConditionals: boolean[] = [];
  /** Bambu's `M622`/`M623` vocabulary — a dialect fingerprint no Marlin file has. */
  private sawBambuConditionals = false;
  private sawMutation = false;

  /**
   * Feeds one executable line (comments already stripped). `word` is the upper-cased
   * command word; `line` is its 1-based number in the file.
   */
  observe(word: string, line: number): void {
    if (word === "M622" || word.startsWith("M622.")) {
      this.openConditionals.push(false);
      this.sawBambuConditionals = true;
      return;
    }
    if (word === "M623") {
      // A stray `M623` is malformed input, not a negative depth — `pop` on an empty
      // stack is a no-op, so unbalanced markers can never open a hole in the gate.
      this.openConditionals.pop();
      this.sawBambuConditionals = true;
      return;
    }
    // `G29`, `G29.2`, `G29.4` — probing/levelling in both the Marlin and Bambu senses.
    if (word === "G29" || word.startsWith("G29.")) {
      if (this.openConditionals.length > 0) {
        this.openConditionals[this.openConditionals.length - 1] = true;
      }
      return;
    }

    if (FORBIDDEN_COMMANDS.has(word)) {
      if (!this.forbidden.has(word)) this.forbidden.set(word, line);
      return;
    }
    if (word === "M500") {
      this.gated.push({
        word,
        line,
        conditional: this.openConditionals.length > 0,
        // Any enclosing block having probed is enough: the measurement `M500`
        // persists was taken in a scope that is still open.
        afterProbing: this.openConditionals.some(Boolean),
        afterMutation: this.sawMutation
      });
      return;
    }
    if (REVIEW_COMMANDS.has(word)) this.review.add(word);
    if (SETTINGS_MUTATING.has(word)) this.sawMutation = true;
  }

  /** True when a `review`-class command was seen (the caller escalates the verdict). */
  get hasReviewCommands(): boolean {
    return this.review.size > 0;
  }

  /**
   * Classifies everything seen, now that {@link GcodeProvenance} is known.
   * Blockers make the file `blocked`; warnings are informational (a `review`
   * command is reported here *and* escalates the verdict via
   * {@link hasReviewCommands}).
   */
  evaluate(provenance: GcodeProvenance): { warnings: AnalysisFinding[]; blockers: AnalysisFinding[] } {
    const warnings: AnalysisFinding[] = [];
    const blockers: AnalysisFinding[] = [];

    for (const [word, line] of this.forbidden) {
      blockers.push(
        finding(
          "gcode_forbidden_command",
          `Запрещённая команда ${word} (строка ${line}): ${FORBIDDEN_COMMANDS.get(word)}`
        )
      );
    }
    for (const word of this.review) {
      warnings.push(
        finding("gcode_risky_command", `Команда ${word} требует присмотра: ${REVIEW_COMMANDS.get(word)}`)
      );
    }

    const bambu = this.isBambuDialect(provenance);
    // One finding per gated word, not per occurrence: a file with 170 identical
    // levelling blocks must not produce 170 identical lines in the operator's list.
    let allowedSaves = 0;
    const refusals: string[] = [];
    for (const sighting of this.gated) {
      const refusal = this.refuseSave(sighting, bambu);
      if (refusal === null) allowedSaves += 1;
      else if (refusals.length < 3) refusals.push(`строка ${sighting.line}: ${refusal}`);
    }
    if (refusals.length > 0) {
      blockers.push(
        finding(
          "gcode_forbidden_command",
          `Запрещённая команда M500 (запись настроек в постоянную память) — ${refusals.join("; ")}`,
          "M500 допускается только внутри штатного блока калибровки Bambu Lab (M622…G29…M500…M623) " +
            "и только если раньше в файле ничего не меняло настройки принтера."
        )
      );
    } else if (allowedSaves > 0) {
      warnings.push(
        finding(
          "gcode_vendor_calibration_save",
          `M500 ×${allowedSaves}: сохранение измеренной сетки стола в штатном блоке калибровки ` +
            `${provenance.printerModel ?? "Bambu Lab"} — разрешено политикой вендора`
        )
      );
    }

    return { warnings, blockers };
  }

  /**
   * Three independent signals must agree before Bambu's own semantics are applied:
   * the declared machine, the toolchain that wrote the file, and the dialect the
   * file is actually written in.
   */
  private isBambuDialect(provenance: GcodeProvenance): boolean {
    const model = provenance.printerModel ?? "";
    const slicer = (provenance.slicer ?? "").toLowerCase();
    return (
      /^\s*bambu\s*lab\b/i.test(model) &&
      (slicer === "orcaslicer" || slicer === "bambustudio") &&
      this.sawBambuConditionals
    );
  }

  /** Why this `M500` is refused, or null when the vendor exception covers it. */
  private refuseSave(sighting: Sighting, bambu: boolean): string | null {
    if (sighting.afterMutation) {
      return "ранее в файле изменялись настройки принтера — сохранять их в память запрещено";
    }
    if (!bambu) return "запись настроек в постоянную память принтера";
    if (!sighting.conditional) return "вне условного блока M622…M623 штатной калибровки";
    if (!sighting.afterProbing) return "в блоке не было замера стола (G29)";
    return null;
  }
}

/** The policy's own vocabulary, exposed so tests can assert against it by name. */
export const POLICY_COMMANDS = {
  forbidden: FORBIDDEN_COMMANDS,
  review: REVIEW_COMMANDS,
  settingsMutating: SETTINGS_MUTATING
} as const;
