import { ID_PREFIX, newId } from "../../../domain/print/ids";
import type { PrintQueueStore } from "../../../domain/print/repositories";
import type { BedCycle } from "../../../domain/print/types";

/**
 * Records what an operator's «стол свободен» confirmation records on a printer
 * with no bed history: a `CLEAR` cycle, attributed and dated.
 *
 * Test harnesses used to dispatch onto printers whose plate nobody had ever
 * confirmed, and that worked only because "nothing tracked" was read as
 * "clear" — the inference the bed model now refuses. A harness that wants a
 * startable printer says so explicitly, the way an operator would.
 */
export function establishClearBed(
  store: PrintQueueStore,
  printerId: string,
  at: Date = new Date(Date.now() - 60_000)
): BedCycle {
  const iso = at.toISOString();
  return store.repositories.bedCycles.insert({
    id: newId(ID_PREFIX.bedCycle),
    printerId,
    state: "CLEAR",
    assignmentId: null,
    createdAt: iso,
    updatedAt: iso,
    clearedAt: iso,
    version: 1,
    metadata: { clearance: "part_removed", clearedBy: "test-operator", established: true }
  });
}
