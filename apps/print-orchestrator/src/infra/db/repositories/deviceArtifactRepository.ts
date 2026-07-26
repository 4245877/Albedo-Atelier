import type { DatabaseSync } from "node:sqlite";

import type { DeviceArtifactRepository } from "../../../domain/print/repositories";
import type {
  DeviceArtifact,
  DeviceArtifactState,
  DeviceTransferMode,
  DeviceVerification
} from "../../../domain/print/types";
import {
  asNumberOrNull,
  asString,
  asStringOrNull,
  BaseRepository,
  metadataToText,
  parseMetadata,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const STATES: readonly DeviceArtifactState[] = [
  "NOT_PRESENT",
  "UPLOADING",
  "PRESENT_UNVERIFIED",
  "VERIFIED",
  "INVALID",
  "FAILED",
  "STALE"
];

const MODES: readonly DeviceTransferMode[] = ["adapter_upload", "manual_file_transfer"];

const VERIFICATIONS: readonly DeviceVerification[] = [
  "name_and_size",
  "name_only",
  "operator_confirmed"
];

/** An unreadable state cell reads back as `INVALID` — never as a usable file. */
function toState(value: unknown): DeviceArtifactState {
  return STATES.includes(value as DeviceArtifactState)
    ? (value as DeviceArtifactState)
    : "INVALID";
}

/** An unreadable mode reads back as manual — the mode that demands a human. */
function toMode(value: unknown): DeviceTransferMode {
  return MODES.includes(value as DeviceTransferMode)
    ? (value as DeviceTransferMode)
    : "manual_file_transfer";
}

function toVerification(value: unknown): DeviceVerification | null {
  return VERIFICATIONS.includes(value as DeviceVerification)
    ? (value as DeviceVerification)
    : null;
}

const mapper: RowMapper<DeviceArtifact> = {
  table: "device_artifacts",
  entity: "файл на устройстве",
  columns: [
    "id",
    "printer_id",
    "assignment_id",
    "slice_variant_id",
    "artifact_id",
    "artifact_sha256",
    "remote_path",
    "size_bytes",
    "state",
    "transfer_mode",
    "verification",
    "uploaded_at",
    "verified_at",
    "confirmed_by",
    "last_error",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(d): Record<string, SqlValue> {
    return {
      id: d.id,
      printer_id: d.printerId,
      assignment_id: d.assignmentId,
      slice_variant_id: d.sliceVariantId,
      artifact_id: d.artifactId,
      artifact_sha256: d.artifactSha256,
      remote_path: d.remotePath,
      size_bytes: d.sizeBytes,
      state: d.state,
      transfer_mode: d.transferMode,
      verification: d.verification,
      uploaded_at: d.uploadedAt,
      verified_at: d.verifiedAt,
      confirmed_by: d.confirmedBy,
      last_error: d.lastError,
      created_at: d.createdAt,
      updated_at: d.updatedAt,
      version: d.version,
      metadata: metadataToText(d.metadata)
    };
  },
  fromRow(row: Row): DeviceArtifact {
    return {
      id: asString(row.id),
      printerId: asString(row.printer_id),
      assignmentId: asStringOrNull(row.assignment_id),
      sliceVariantId: asStringOrNull(row.slice_variant_id),
      artifactId: asStringOrNull(row.artifact_id),
      artifactSha256: asStringOrNull(row.artifact_sha256),
      remotePath: asString(row.remote_path),
      sizeBytes: asNumberOrNull(row.size_bytes),
      state: toState(row.state),
      transferMode: toMode(row.transfer_mode),
      verification: toVerification(row.verification),
      uploadedAt: asStringOrNull(row.uploaded_at),
      verifiedAt: asStringOrNull(row.verified_at),
      confirmedBy: asStringOrNull(row.confirmed_by),
      lastError: asStringOrNull(row.last_error),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteDeviceArtifactRepository
  extends BaseRepository<DeviceArtifact>
  implements DeviceArtifactRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  findBySlot(printerId: string, remotePath: string): DeviceArtifact | null {
    return this.queryOne(
      "SELECT * FROM device_artifacts WHERE printer_id = ? AND remote_path = ?",
      printerId,
      remotePath
    );
  }

  listByAssignment(assignmentId: string): DeviceArtifact[] {
    return this.query(
      "SELECT * FROM device_artifacts WHERE assignment_id = ? ORDER BY created_at DESC, id DESC",
      assignmentId
    );
  }

  listByPrinter(printerId: string): DeviceArtifact[] {
    return this.query(
      "SELECT * FROM device_artifacts WHERE printer_id = ? ORDER BY created_at DESC, id DESC",
      printerId
    );
  }

  listByStates(states: readonly DeviceArtifactState[]): DeviceArtifact[] {
    if (states.length === 0) return [];
    // The placeholder list is built from the array *length* only; every value is
    // bound, so no state string is ever interpolated into SQL.
    const placeholders = states.map(() => "?").join(",");
    return this.query(
      `SELECT * FROM device_artifacts WHERE state IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
      ...states
    );
  }
}
