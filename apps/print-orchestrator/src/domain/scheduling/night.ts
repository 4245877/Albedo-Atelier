/**
 * Night (unattended) print gating for the manual scheduler.
 *
 * Without automatic part removal, at most **one** unattended print per printer
 * per night is allowed, and a night recommendation is permitted *only* when every
 * gate the brief lists passes:
 *   - a ready {@link SliceVariant};
 *   - an approved {@link ProfileSet};
 *   - a known ETA;
 *   - enough material;
 *   - fresh telemetry;
 *   - `BedCycle === CLEAR`;
 *   - no maintenance blockers;
 *   - the task's explicit unattended permission.
 *
 * Any unknown critical (e.g. remaining material unknown) fails the gate — it is
 * never assumed sufficient. The ETA is the source estimate plus a configurable
 * safety buffer, and every result is flagged {@link NightEvaluation.preliminary}
 * because the farm has no historical P90 yet. Nothing here starts or schedules a
 * print — it only decides eligibility and the buffered time to show.
 */

import type { BedCycleState } from "../print/types";
import { applySafetyBuffer } from "./eta";

export interface NightGateInput {
  taskId: string;
  printerId: string;
  /** Priority carried through so at-most-one-per-printer picks the strongest. */
  priority: number;
  readySliceVariant: boolean;
  profileSetApproved: boolean;
  /** Verified/analysis ETA in seconds, or null when unknown. */
  etaSeconds: number | null;
  /** Whether remaining material covers the print. null = unknown → fails the gate. */
  materialSufficient: boolean | null;
  telemetryFresh: boolean;
  bedCycle: BedCycleState | null;
  maintenanceBlockers: string[];
  unattendedAllowed: boolean;
}

export interface NightConfig {
  /** Safety buffer applied to the ETA, e.g. 0.2 → +20%. */
  safetyBufferRatio: number;
}

export interface NightEvaluation {
  taskId: string;
  printerId: string;
  eligible: boolean;
  blockers: string[];
  /** Source ETA + safety buffer (seconds); null when the ETA is unknown. */
  bufferedEtaSeconds: number | null;
  /** Always true — no historical P90 yet, so the buffered ETA is provisional. */
  preliminary: boolean;
}

/** Evaluates one task×printer night gate; accumulates a reason for every failure. */
export function evaluateNightGate(input: NightGateInput, config: NightConfig): NightEvaluation {
  const blockers: string[] = [];

  if (!input.unattendedAllowed) blockers.push("задание не разрешено для печати без присмотра");
  if (!input.readySliceVariant) blockers.push("нет готового слайса");
  if (!input.profileSetApproved) blockers.push("набор профилей не утверждён");
  if (input.etaSeconds === null) blockers.push("ETA неизвестна");
  if (input.materialSufficient === null) blockers.push("остаток материала неизвестен");
  else if (input.materialSufficient === false) blockers.push("недостаточно материала");
  if (!input.telemetryFresh) blockers.push("телеметрия устарела");
  if (input.bedCycle !== "CLEAR") blockers.push(`стол не свободен (${input.bedCycle ?? "неизвестно"})`);
  for (const m of input.maintenanceBlockers) blockers.push(`обслуживание: ${m}`);

  const bufferedEtaSeconds =
    input.etaSeconds !== null ? applySafetyBuffer(input.etaSeconds, config.safetyBufferRatio) : null;

  return {
    taskId: input.taskId,
    printerId: input.printerId,
    eligible: blockers.length === 0,
    blockers,
    bufferedEtaSeconds,
    preliminary: true
  };
}

export interface NightSlotSelection {
  /** The one chosen candidate per printer (highest priority, then longest buffered ETA). */
  chosen: NightEvaluation[];
  /** Eligible candidates that lost their printer's single night slot to another task. */
  rejected: { taskId: string; printerId: string; reason: string }[];
}

/**
 * Enforces "at most one unattended print per printer per night": from the
 * eligible candidates, keeps the strongest per printer and rejects the rest with
 * a clear reason. Selection is deterministic — priority desc, then longer buffered
 * ETA (a longer print benefits most from the unattended slot), then task id.
 */
export function selectNightSlots(
  evaluations: NightGateInput[],
  results: NightEvaluation[]
): NightSlotSelection {
  const priorityOf = new Map(evaluations.map((e) => [e.taskId, e.priority] as const));
  const eligible = results.filter((r) => r.eligible);
  const byPrinter = new Map<string, NightEvaluation[]>();
  for (const r of eligible) {
    const list = byPrinter.get(r.printerId) ?? [];
    list.push(r);
    byPrinter.set(r.printerId, list);
  }

  const chosen: NightEvaluation[] = [];
  const rejected: { taskId: string; printerId: string; reason: string }[] = [];
  for (const [, list] of byPrinter) {
    list.sort((a, b) => {
      const pa = priorityOf.get(a.taskId) ?? 0;
      const pb = priorityOf.get(b.taskId) ?? 0;
      if (pb !== pa) return pb - pa;
      const ea = a.bufferedEtaSeconds ?? 0;
      const eb = b.bufferedEtaSeconds ?? 0;
      if (eb !== ea) return eb - ea;
      return a.taskId < b.taskId ? -1 : 1;
    });
    chosen.push(list[0]);
    for (const loser of list.slice(1)) {
      rejected.push({
        taskId: loser.taskId,
        printerId: loser.printerId,
        reason: "ночной слот принтера занят другим заданием (одна печать на принтер за ночь)"
      });
    }
  }
  return { chosen, rejected };
}
