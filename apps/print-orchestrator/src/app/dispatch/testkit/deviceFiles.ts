import { ID_PREFIX, newId } from "../../../domain/print/ids";
import type { PrintQueueStore } from "../../../domain/print/repositories";
import type { DeviceArtifact, DeviceArtifactState } from "../../../domain/print/types";

/**
 * Test helper: put a **prepared file** on a fake printer.
 *
 * Every dispatch now requires a `VERIFIED` {@link DeviceArtifact} for the exact
 * slot it is about to start — "the path resolves" is not evidence that anything
 * delivered or checked those bytes. Tests that are about something else (bed
 * clearance, idempotency, night windows) therefore need the delivery step to
 * have happened, and this is the one-liner that makes it so.
 *
 * It writes the row the real {@link DeviceArtifactService} would write after a
 * successful upload + listing check, including the identity fields the staleness
 * comparison keys on, so a fixture cannot accidentally be "verified but stale".
 */
export function seedDeviceFile(
  store: PrintQueueStore,
  input: {
    printerId: string;
    remotePath: string;
    artifactId?: string | null;
    sliceVariantId?: string | null;
    assignmentId?: string | null;
    sha256?: string | null;
    sizeBytes?: number | null;
    state?: DeviceArtifactState;
    transferMode?: DeviceArtifact["transferMode"];
    verification?: DeviceArtifact["verification"];
    now?: string;
  }
): DeviceArtifact {
  const iso = input.now ?? new Date().toISOString();
  const state = input.state ?? "VERIFIED";
  const record: DeviceArtifact = {
    id: newId(ID_PREFIX.deviceArtifact),
    printerId: input.printerId,
    assignmentId: input.assignmentId ?? null,
    sliceVariantId: input.sliceVariantId ?? null,
    artifactId: input.artifactId ?? null,
    artifactSha256: input.sha256 ?? null,
    remotePath: input.remotePath,
    sizeBytes: input.sizeBytes ?? null,
    state,
    transferMode: input.transferMode ?? "adapter_upload",
    verification: input.verification ?? (state === "VERIFIED" ? "name_and_size" : null),
    uploadedAt: iso,
    verifiedAt: state === "VERIFIED" ? iso : null,
    confirmedBy: null,
    lastError: null,
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {}
  };
  store.repositories.deviceArtifacts.insert(record);
  return record;
}
