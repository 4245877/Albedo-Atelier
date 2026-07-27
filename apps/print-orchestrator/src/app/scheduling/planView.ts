import type { Assignment, Metadata } from "../../domain/print/types";
import type { CompatibilityResult } from "../../domain/scheduling/compatibility";
import type { PrinterRelease } from "../../domain/scheduling/release";
import type {
  EtaConfidence,
  PlanExplanation,
  PrinterTimeline,
  TimelineSegment,
  UnplacedView
} from "./types";

/**
 * **Composing the operator-facing view of a plan, and reading it back.**
 *
 * Kept apart from {@link PlanningService} because it answers a different
 * question: not "what should we recommend?" but "what does this recommendation
 * look like on a timeline, and what does a stored row actually say?".
 *
 * Everything here is pure and **defensive by construction**. A plan is persisted
 * as JSON metadata and re-read across restarts and schema generations, so every
 * reader validates field by field and degrades to an honest null/UNKNOWN rather
 * than casting a half-written blob into a shape the UI then trusts.
 */

/** One placement, reduced to what a timeline lane needs. */
export interface TimelinePlacement {
  taskId: string;
  printerId: string;
  startMs: number;
  endMs: number;
}

export interface TimelineInput {
  printers: readonly { id: string; name: string }[];
  releases: Map<string, PrinterRelease>;
  /** The recommendations this plan is making. */
  assignments: readonly TimelinePlacement[];
  /** Confirmed placements carried through untouched. */
  frozen: readonly Assignment[];
  unplaced: readonly UnplacedView[];
  nowMs: number;
  titleOf: (taskId: string) => string;
}

/**
 * The per-printer lanes: real occupancy and interventions from the release
 * projection, then the frozen placements, then the recommended ones, then the
 * explicitly-approximate ghosts for unplaced work.
 *
 * The brief's worked example falls straight out of this: `printing` until 03:00,
 * `operator_wait` 03:00–08:00, `operation` 08:00–08:05, and the first
 * `planned_print` at 08:05 — the manual pause is a segment of its own, never a
 * silent gap between two blocks.
 */
export function buildTimeline(input: TimelineInput): PrinterTimeline[] {
  const { releases, frozen, assignments, unplaced, nowMs, titleOf } = input;

  return input.printers.map((printer) => {
    const release = releases.get(printer.id) ?? unknownRelease(printer.id);
    const segments: TimelineSegment[] = release.segments.map((s) => ({
      kind: s.kind,
      startMs: s.startMs,
      endMs: s.endMs,
      label: s.label,
      ...(s.operationId ? { operationId: s.operationId } : {}),
      ...(s.operationType ? { operationType: s.operationType } : {}),
      // A stretch with no computable end is an estimate by definition; flagging
      // it here is what stops the UI drawing it as a bounded, promised block.
      ...(s.endMs === null ? { approximate: true } : {})
    }));

    for (const a of frozen) {
      if (a.printerId !== printer.id) continue;
      const ex = readExplanation(a.metadata);
      segments.push({
        kind: "frozen_print",
        startMs: ex?.startMs ?? (Date.parse(a.binding.plannedStartAt ?? "") || nowMs),
        endMs: ex?.endMs ?? null,
        label: `${titleOf(a.taskId)} (подтверждено, заморожено)`,
        taskId: a.taskId
      });
    }

    for (const a of assignments) {
      if (a.printerId !== printer.id) continue;
      segments.push({
        kind: "planned_print",
        startMs: a.startMs,
        endMs: a.endMs,
        label: titleOf(a.taskId),
        taskId: a.taskId
      });
    }

    for (const u of unplaced) {
      if (!u.hint || u.hint.printerId !== printer.id) continue;
      segments.push({
        kind: "approx_print",
        startMs: u.hint.startMs,
        endMs: u.hint.endMs,
        label: `${u.title} — ${u.hint.note}`,
        taskId: u.taskId,
        approximate: true
      });
    }

    // Sorted on (start, label) rather than start alone: two segments can begin at
    // the same instant, and a lane that reordered itself between two identical
    // recomputes would make a deterministic plan look unstable.
    segments.sort((a, b) => a.startMs - b.startMs || a.label.localeCompare(b.label));
    return {
      printerId: printer.id,
      name: printer.name,
      releaseCode: release.code,
      releaseReason: release.reason,
      releaseAtMs: release.releaseAtMs,
      waitingForOperator: release.waitingForOperator,
      segments
    };
  });
}

export function readExplanation(metadata: Metadata): PlanExplanation | null {
  const raw = metadata.explanation;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as unknown as PlanExplanation;
  }
  return null;
}

export function readUnplaced(metadata: Metadata): UnplacedView[] {
  const raw = metadata.unplaced;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (item && typeof item === "object") {
      const r = item as Record<string, unknown>;
      if (typeof r.taskId === "string") {
        return [{
          taskId: r.taskId,
          title: typeof r.title === "string" ? r.title : r.taskId,
          // A row written before codes existed reads back as UNKNOWN rather than
          // as an empty string — a missing code is itself a stable answer.
          code: typeof r.code === "string" ? r.code : "UNKNOWN",
          reason: typeof r.reason === "string" ? r.reason : "",
          hint: readHint(r.hint)
        }];
      }
    }
    return [];
  });
}

/** An approximate hint reads back only when every field of it is intact. */
export function readHint(raw: unknown): UnplacedView["hint"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (
    typeof h.printerId !== "string" ||
    typeof h.startMs !== "number" ||
    typeof h.endMs !== "number"
  ) {
    return null;
  }
  return {
    approximate: true,
    printerId: h.printerId,
    startMs: h.startMs,
    endMs: h.endMs,
    note: typeof h.note === "string" ? h.note : "приблизительная оценка"
  };
}

export function readTimeline(metadata: Metadata): PrinterTimeline[] {
  const raw = metadata.timeline;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const lane = item as Record<string, unknown>;
    if (typeof lane.printerId !== "string") return [];
    const segments = Array.isArray(lane.segments)
      ? (lane.segments as unknown[]).flatMap((s) => {
          if (!s || typeof s !== "object") return [];
          const seg = s as Record<string, unknown>;
          if (typeof seg.kind !== "string" || typeof seg.startMs !== "number") return [];
          return [seg as unknown as TimelineSegment];
        })
      : [];
    return [{
      printerId: lane.printerId,
      name: typeof lane.name === "string" ? lane.name : lane.printerId,
      releaseCode: typeof lane.releaseCode === "string" ? lane.releaseCode : "UNKNOWN",
      releaseReason: typeof lane.releaseReason === "string" ? lane.releaseReason : "",
      releaseAtMs: typeof lane.releaseAtMs === "number" ? lane.releaseAtMs : null,
      waitingForOperator: lane.waitingForOperator === true,
      segments
    }];
  });
}

export function readString(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function readStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Compatibility reviews that are about **when**, not **whether** — the bed still
 * holds the previous part, or its state is not yet observed.
 *
 * `evaluateCompatibility` downgrades both to `review` because they are hard
 * blockers for a start *right now*, and the dispatch gate independently refuses
 * them (`BED_NOT_CLEAR` / `BED_STATE_UNKNOWN`, non-overridable). For a plan they
 * are neither: the release projection prices the clearance in and answers with a
 * later start time — or with an honest unknown, which then surfaces as
 * `PRINTER_RELEASE_UNKNOWN`. Excluding these printers here would instead report
 * "нет совместимых принтеров", which is simply false: the printer is compatible,
 * it is busy.
 */
export const TIMING_ONLY_REVIEW_CODES: ReadonlySet<string> = new Set([
  "bed_awaiting_clearance",
  "bed_unknown"
]);

/** Whether a compatibility result may receive a *planned* (future) placement. */
export function plannable(result: CompatibilityResult): boolean {
  if (result.verdict === "compatible") return true;
  if (result.verdict !== "review") return false;
  return (
    result.reviews.length > 0 &&
    result.reviews.every((r) => TIMING_ONLY_REVIEW_CODES.has(r.code))
  );
}

/** The fail-closed release for a printer the projection did not answer for. */
export function unknownRelease(printerId: string): PrinterRelease {
  return {
    printerId,
    releaseAtMs: null,
    code: "RELEASE_UNKNOWN_SCHEDULE",
    reason: "состояние принтера не определено",
    waitingForOperator: false,
    blockingOperationIds: [],
    segments: []
  };
}

/**
 * How much a placement's ETA can be trusted. `unknown` never appears on a real
 * placement (no ETA → the task is left unplaced); it is here so the type covers
 * the read-back of rows written before that rule existed.
 */
export function etaConfidenceOf(etaSeconds: number | null, preliminary: boolean): EtaConfidence {
  if (etaSeconds === null) return "unknown";
  return preliminary ? "preliminary" : "exact";
}

/** Same first material token (PLA vs "PLA Matte" are one family; PLA vs PETG are not). */
export function sameMaterialFamily(a: string, b: string): boolean {
  const family = (v: string): string =>
    v.toUpperCase().split(/[\s\-_/,|+]+/).filter(Boolean)[0] ?? "";
  return family(a) === family(b);
}
