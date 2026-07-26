import type { PrintQueueStore } from "../../domain/print/repositories";
import type { DispatchEligibility } from "../../domain/dispatch/eligibility";
import type { PrinterConfig } from "../../infra/printers/config";
import { blockersOf } from "../dispatch/dispatchGate";
import type { NightGateDecision } from "../nightPlanner";

export interface NightGateDeps {
  /** The open SQLite queue store, or null when it has not been opened yet. */
  store: PrintQueueStore | null;
  /** Resolves a queue job's free-text printer field to an enabled config. */
  resolvePrinter: (reference: string) => PrinterConfig | undefined;
  /**
   * The SINGLE authoritative eligibility evaluator — the very call the physical
   * night start makes inside its reserve transaction. Injected (rather than
   * re-derived here) so the dashboard's night section can never show a different
   * set of reasons from the one enforcement uses.
   */
  evaluateEligibility: (input: {
    taskId: string;
    printerId: string;
    mode: "night";
  }) => DispatchEligibility;
}

/**
 * The canonical night-gate decoration for one projected queue job: the blockers
 * `DispatchEligibility` reports for a night start, plus the immutable preview
 * identity the operator confirms with `POST /api/queue/night/start`.
 *
 * A read model: it reads through the passed-in repositories, resolves nothing
 * from a global, creates no repositories, starts no background work and mutates
 * nothing.
 */
export function buildNightGateInfo(deps: NightGateDeps, taskId: string): NightGateDecision | null {
  const store = deps.store;
  if (!store) return null;
  const repos = store.repositories;
  const task = repos.tasks.getById(taskId) ?? repos.tasks.findByLegacyRef(taskId);
  if (!task) return null;
  const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
  const printerRef = task.pinnedPrinterId ?? task.targetPrinter;
  const printer = printerRef ? deps.resolvePrinter(printerRef) : undefined;
  if (!printer) {
    // This gate is the SOLE source of night blockers (the dashboard night
    // section projects it verbatim), so it must report a missing/unresolvable
    // printer itself rather than defer to a second heuristic. A night start
    // would otherwise have nothing to dispatch to.
    return {
      blockers: [
        printerRef
          ? `принтер «${printerRef}» не найден в конфигурации`
          : "принтер не назначен — закрепите принтер для ночного запуска"
      ],
      taskId: task.id,
      taskVersion: task.version,
      artifactSha256: artifact?.sha256 ?? null
    };
  }

  let blockers: string[];
  try {
    const eligibility = deps.evaluateEligibility({
      taskId: task.id,
      printerId: printer.id,
      mode: "night"
    });
    blockers = blockersOf(eligibility).map((b) => b.message);
  } catch (error) {
    // Fail-closed: an evidence-resolution failure is never "no blockers".
    blockers = [
      `готовность задания не удалось проверить (${error instanceof Error ? error.message : String(error)})`
    ];
  }
  return {
    blockers,
    taskId: task.id,
    taskVersion: task.version,
    artifactSha256: artifact?.sha256 ?? null
  };
}
