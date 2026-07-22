import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrinterConfig } from "../../infra/printers/config";
import { supportsPrinterStart, type PrinterLiveStatus } from "../../infra/printers/status";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { evaluateDispatchGate } from "../dispatch/dispatchGate";
import { windowLengthMinutes, type NightGateDecision } from "../nightPlanner";

export interface NightGateDeps {
  /** The open SQLite queue store, or null when it has not been opened yet. */
  store: PrintQueueStore | null;
  /** Resolves a queue job's free-text printer field to an enabled config. */
  resolvePrinter: (reference: string) => PrinterConfig | undefined;
  /** Live device status for the resolved printer (real poll). */
  getStatus: (printerId: string) => PrinterLiveStatus | undefined;
  nightWindow: string;
  nightSafetyBufferRatio: number;
}

/**
 * The canonical night-gate decoration for one projected queue job: the same
 * fail-closed blockers {@link evaluateDispatchGate} enforces, computed against
 * the SQLite task / artifact / analysis — plus the immutable preview identity.
 *
 * A read model: it reads through the passed-in repositories, resolves nothing
 * from a global, creates no repositories, starts no background work and mutates
 * nothing. Extracted verbatim from the former `FarmStore.nightGateInfo` so the
 * dashboard night section and the physical night start keep sharing one rule.
 */
export function buildNightGateInfo(deps: NightGateDeps, taskId: string): NightGateDecision | null {
  const store = deps.store;
  if (!store) return null;
  const repos = store.repositories;
  const task = repos.tasks.getById(taskId) ?? repos.tasks.findByLegacyRef(taskId);
  if (!task) return null;
  const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
  const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;
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
  const blockers = evaluateDispatchGate({
    mode: "night",
    task,
    entry: repos.queue.findByTaskId(task.id),
    artifact,
    analysis,
    printer,
    status: deps.getStatus(printer.id),
    remoteStartSupported: supportsPrinterStart(printer),
    nightWindowMinutes: windowLengthMinutes(deps.nightWindow),
    nightSafetyBufferRatio: deps.nightSafetyBufferRatio,
    currentAnalyzerVersion: ANALYZER_VERSION
  });
  return {
    blockers: blockers.map((b) => b.message),
    taskId: task.id,
    taskVersion: task.version,
    artifactSha256: artifact?.sha256 ?? null
  };
}
