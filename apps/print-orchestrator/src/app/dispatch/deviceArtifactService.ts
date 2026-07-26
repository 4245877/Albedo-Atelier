import { readFile } from "node:fs/promises";

import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { assertTransition, DEVICE_ARTIFACT_TRANSITIONS } from "../../domain/print/states";
import type {
  Assignment,
  DeviceArtifact,
  DeviceArtifactState,
  DeviceTransferMode,
  Metadata
} from "../../domain/print/types";
import type { PrinterConfig } from "../../infra/printers/config";
import {
  normalizeStartablePath,
  supportsPrinterFiles,
  supportsPrinterUpload,
  type PrinterFilesListing
} from "../../infra/printers/files";
import type { ArtifactStorage } from "../../infra/storage/artifactStorage";
import type { StoreLogger } from "../../shared/logger";
import { recordAuditEvent } from "../audit";

/**
 * Preparing the **file on the printer** — the step between "a slice is ready"
 * and "a start command may be sent".
 *
 * Before this existed, promotion recorded an on-device *path* and the dispatch
 * pre-flight then demanded that a file already be sitting there: nothing ever
 * put it there, so the whole slice→queue→print chain terminated on
 * `DEVICE_FILE_MISSING` unless an operator had copied the file by hand without
 * the system knowing.
 *
 * Two honest modes, chosen by adapter capability — never a pretend-automatic
 * third:
 *
 *  - **adapter_upload** (Moonraker): the bytes are pushed over the file API,
 *    then the directory is re-listed and the entry compared by name and size.
 *    Moonraker exposes no content hash, so the recorded verification is
 *    `name_and_size` — accurately, not dressed up as a SHA-256 check.
 *  - **manual_file_transfer** (Bambu, Creality WS): no upload API is
 *    implemented, so the service records what the operator must copy and where,
 *    and refuses to call the file present until a named operator confirms it.
 *    The eligibility rules turn an unconfirmed manual transfer into a hard
 *    blocker, and an unattended start is refused for such printers outright.
 *
 * Nothing here ever starts a print.
 */

/** What an operator/UI needs to act on a prepared (or not-yet-prepared) file. */
export interface DevicePreparation {
  deviceArtifact: DeviceArtifact;
  /** True when the file is usable by a dispatch right now. */
  ready: boolean;
  /** Operator-facing instruction when a manual transfer is required; null otherwise. */
  manualInstruction: string | null;
}

export interface DeviceArtifactDeps {
  store: PrintQueueStore;
  storage: ArtifactStorage;
  /** Resolves a printer id to the farm config; undefined when unknown/disabled. */
  resolvePrinter(reference: string): PrinterConfig | undefined;
  /** On-device listing used for post-upload verification (injected for tests). */
  listFiles(printer: PrinterConfig, dir: string): Promise<PrinterFilesListing>;
  /** File push; only called when {@link supportsPrinterUpload} says the adapter can. */
  uploadFile(
    printer: PrinterConfig,
    remotePath: string,
    bytes: Uint8Array
  ): Promise<{ remotePath: string; sizeBytes: number }>;
  now?: () => Date;
  logger?: StoreLogger;
}

export class DeviceArtifactService {
  private readonly now: () => Date;
  private readonly logger: StoreLogger;

  constructor(private readonly deps: DeviceArtifactDeps) {
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? {};
  }

  /** Tracked files on one printer (newest first) — the execution panel's read. */
  listForPrinter(printerId: string): DeviceArtifact[] {
    return this.deps.store.repositories.deviceArtifacts.listByPrinter(printerId);
  }

  /** The tracked file an assignment's binding points at, if any. */
  forAssignment(assignment: Assignment): DeviceArtifact | null {
    const path = assignment.binding.expectedRemotePath;
    if (!path) return null;
    return this.deps.store.repositories.deviceArtifacts.findBySlot(assignment.printerId, path);
  }

  /**
   * Ensures the assignment's exact file is on its printer.
   *
   * **Idempotent**: a `VERIFIED` record for the same slot *and the same content
   * hash* is returned untouched — a repeated "prepare" click re-uploads nothing.
   * A record for the same slot with a *different* hash is re-uploaded (the slot
   * holds the wrong bytes), which is the one case where overwriting is correct.
   *
   * Never called implicitly by a dispatch: preparing a file is an explicit
   * operator/plan step, so a failed transfer leaves the assignment un-started
   * rather than half-launched.
   */
  async prepare(assignmentId: string, actor = "operator"): Promise<DevicePreparation> {
    const repos = this.deps.store.repositories;
    const assignment = repos.assignments.getById(assignmentId);
    if (!assignment) throw new NotFoundError(`Назначение «${assignmentId}»`);
    if (assignment.state === "RELEASED" || assignment.state === "CANCELLED") {
      throw new JobError(`Назначение ${assignmentId} закрыто (${assignment.state})`);
    }
    if (assignment.invalidatedAt) {
      throw new JobError(
        `Назначение ${assignmentId} устарело${assignment.invalidatedReason ? `: ${assignment.invalidatedReason}` : ""} — подготовка файла запрещена`
      );
    }

    const printer = this.deps.resolvePrinter(assignment.printerId);
    if (!printer) {
      throw new JobError(`Принтер «${assignment.printerId}» не найден в конфигурации фермы`);
    }

    const remotePath = assignment.binding.expectedRemotePath;
    if (!remotePath) {
      throw new JobError("У назначения не задан путь файла на устройстве — нечего готовить");
    }
    const target = normalizeStartablePath(remotePath);

    const artifactId = assignment.binding.artifactId;
    if (!artifactId) throw new JobError("У назначения не задан исполнимый артефакт");
    const artifact = repos.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);

    const existing = repos.deviceArtifacts.findBySlot(printer.id, target);
    if (
      existing &&
      existing.state === "VERIFIED" &&
      existing.artifactSha256 !== null &&
      existing.artifactSha256 === artifact.sha256
    ) {
      return this.describe(existing, printer);
    }

    if (!supportsPrinterUpload(printer.protocol)) {
      // No upload API: record the intent, name the exact file and path, and stop.
      // The operator confirms via `confirmManualTransfer`; nothing pretends the
      // file arrived.
      const record = this.write(
        existing,
        {
          printerId: printer.id,
          assignmentId: assignment.id,
          sliceVariantId: assignment.binding.sliceVariantId,
          artifactId: artifact.id,
          artifactSha256: artifact.sha256,
          remotePath: target,
          sizeBytes: artifact.sizeBytes,
          transferMode: "manual_file_transfer"
        },
        "NOT_PRESENT",
        { verification: null, lastError: null },
        actor,
        "manual_transfer_required"
      );
      return this.describe(record, printer);
    }

    // ── adapter_upload ────────────────────────────────────────────────────────
    if (!artifact.source) {
      throw new JobError(
        `У артефакта «${artifact.id}» нет сохранённых байтов — загрузить на принтер нечего`
      );
    }

    const uploading = this.write(
      existing,
      {
        printerId: printer.id,
        assignmentId: assignment.id,
        sliceVariantId: assignment.binding.sliceVariantId,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        remotePath: target,
        sizeBytes: artifact.sizeBytes,
        transferMode: "adapter_upload"
      },
      "UPLOADING",
      { verification: null, lastError: null },
      actor,
      "upload_started"
    );

    let uploadedBytes: number;
    try {
      const bytes = await readFile(this.deps.storage.resolvePath(artifact.source));
      const result = await this.deps.uploadFile(printer, target, bytes);
      uploadedBytes = result.sizeBytes;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.({ err: error, printer: printer.id, file: target }, "device upload failed");
      const failed = this.transition(uploading, "INVALID", {
        lastError: message,
        verification: null
      }, actor, "upload_failed");
      return this.describe(failed, printer);
    }

    const uploadedAt = this.nowIso();
    const present = this.transition(
      { ...uploading, uploadedAt, sizeBytes: uploadedBytes },
      "PRESENT_UNVERIFIED",
      { verification: null, lastError: null },
      actor,
      "uploaded"
    );

    return this.describe(await this.verify(present, printer, artifact.sizeBytes, actor), printer);
  }

  /**
   * Records that an operator physically copied the file to a printer whose
   * adapter cannot upload. The confirmation names the operator and is audited —
   * it is the evidence the eligibility check demands.
   *
   * If the adapter can nonetheless *list* files, the claim is checked against the
   * device instead of taken on faith; only when there is no listing either does
   * the record rest on `operator_confirmed`.
   */
  async confirmManualTransfer(
    assignmentId: string,
    actor: string
  ): Promise<DevicePreparation> {
    const who = actor.trim();
    if (!who) throw new ValidationError("Подтверждение переноса файла требует имени оператора");

    const repos = this.deps.store.repositories;
    const assignment = repos.assignments.getById(assignmentId);
    if (!assignment) throw new NotFoundError(`Назначение «${assignmentId}»`);
    const printer = this.deps.resolvePrinter(assignment.printerId);
    if (!printer) {
      throw new JobError(`Принтер «${assignment.printerId}» не найден в конфигурации фермы`);
    }
    const remotePath = assignment.binding.expectedRemotePath;
    if (!remotePath) throw new JobError("У назначения не задан путь файла на устройстве");
    const target = normalizeStartablePath(remotePath);

    const artifact = assignment.binding.artifactId
      ? repos.artifacts.getById(assignment.binding.artifactId)
      : null;

    const existing = repos.deviceArtifacts.findBySlot(printer.id, target);
    const record = this.write(
      existing,
      {
        printerId: printer.id,
        assignmentId: assignment.id,
        sliceVariantId: assignment.binding.sliceVariantId,
        artifactId: artifact?.id ?? null,
        artifactSha256: artifact?.sha256 ?? null,
        remotePath: target,
        sizeBytes: artifact?.sizeBytes ?? null,
        transferMode: "manual_file_transfer"
      },
      "PRESENT_UNVERIFIED",
      { verification: "operator_confirmed", lastError: null, confirmedBy: who },
      who,
      "manual_transfer_confirmed"
    );

    // A listing-capable adapter still gets checked — an operator's word is the
    // fallback, not a way to skip evidence that IS available.
    const verified = supportsPrinterFiles(printer)
      ? await this.verify(record, printer, artifact?.sizeBytes ?? null, who)
      : record;
    return this.describe(verified, printer);
  }

  /**
   * Re-reads the device listing and updates the record's verification level.
   * A file that has vanished, or whose size no longer matches the artifact, is
   * marked `INVALID` — never silently downgraded to "probably fine".
   */
  private async verify(
    record: DeviceArtifact,
    printer: PrinterConfig,
    expectedSize: number | null,
    actor: string
  ): Promise<DeviceArtifact> {
    if (!supportsPrinterFiles(printer)) {
      return record.verification === "operator_confirmed"
        ? record
        : this.transition(record, "PRESENT_UNVERIFIED", { verification: null }, actor, "unverifiable");
    }

    const slash = record.remotePath.lastIndexOf("/");
    const dir = slash === -1 ? "" : record.remotePath.slice(0, slash);
    let listing: PrinterFilesListing;
    try {
      listing = await this.deps.listFiles(printer, dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed listing is not proof of absence — the file stays present but
      // unverified, and the dispatch pre-flight will try again.
      return this.transition(
        record,
        "PRESENT_UNVERIFIED",
        { verification: record.verification, lastError: `листинг недоступен: ${message}` },
        actor,
        "verification_deferred"
      );
    }

    const entry = listing.entries.find((e) => e.type === "file" && e.path === record.remotePath);
    if (!entry) {
      return this.transition(
        record,
        "INVALID",
        { verification: null, lastError: "файл не найден на устройстве после переноса" },
        actor,
        "verification_failed"
      );
    }
    if (expectedSize !== null && typeof entry.size === "number" && entry.size !== expectedSize) {
      return this.transition(
        record,
        "INVALID",
        {
          verification: null,
          lastError: `размер на устройстве ${entry.size} ≠ ожидаемого ${expectedSize}`
        },
        actor,
        "verification_failed"
      );
    }

    // Name + size is the strongest identity Moonraker exposes (no content hash
    // over the API). Recorded as exactly that, never as a cryptographic match.
    const verification = typeof entry.size === "number" && expectedSize !== null
      ? "name_and_size"
      : "name_only";
    return this.transition(
      { ...record, sizeBytes: entry.size ?? record.sizeBytes, verifiedAt: this.nowIso() },
      "VERIFIED",
      { verification, lastError: null },
      actor,
      "verified"
    );
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  /** Creates or re-points the record for a device slot, then moves it to `state`. */
  private write(
    existing: DeviceArtifact | null,
    identity: {
      printerId: string;
      assignmentId: string;
      sliceVariantId: string | null;
      artifactId: string | null;
      artifactSha256: string | null;
      remotePath: string;
      sizeBytes: number | null;
      transferMode: DeviceTransferMode;
    },
    state: DeviceArtifactState,
    patch: {
      verification?: DeviceArtifact["verification"];
      lastError?: string | null;
      confirmedBy?: string | null;
    },
    actor: string,
    action: string
  ): DeviceArtifact {
    return this.deps.store.transaction(() => {
      const repos = this.deps.store.repositories;
      const iso = this.nowIso();
      if (!existing) {
        const created: DeviceArtifact = {
          id: newId(ID_PREFIX.deviceArtifact),
          ...identity,
          state,
          verification: patch.verification ?? null,
          uploadedAt: null,
          verifiedAt: null,
          confirmedBy: patch.confirmedBy ?? null,
          lastError: patch.lastError ?? null,
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          metadata: {}
        };
        repos.deviceArtifacts.insert(created);
        this.audit(created, action, actor, { to: state });
        return created;
      }

      assertTransition("файл на устройстве", DEVICE_ARTIFACT_TRANSITIONS, existing.state, state);
      const saved = repos.deviceArtifacts.update({
        ...existing,
        ...identity,
        state,
        verification: patch.verification ?? null,
        confirmedBy: patch.confirmedBy ?? existing.confirmedBy,
        lastError: patch.lastError ?? null,
        updatedAt: iso
      });
      this.audit(saved, action, actor, { from: existing.state, to: state });
      return saved;
    });
  }

  private transition(
    record: DeviceArtifact,
    state: DeviceArtifactState,
    patch: {
      verification?: DeviceArtifact["verification"];
      lastError?: string | null;
      confirmedBy?: string | null;
    },
    actor: string,
    action: string
  ): DeviceArtifact {
    return this.deps.store.transaction(() => {
      assertTransition("файл на устройстве", DEVICE_ARTIFACT_TRANSITIONS, record.state, state);
      const saved = this.deps.store.repositories.deviceArtifacts.update({
        ...record,
        state,
        verification: patch.verification ?? null,
        confirmedBy: patch.confirmedBy ?? record.confirmedBy,
        lastError: patch.lastError ?? null,
        updatedAt: this.nowIso()
      });
      this.audit(saved, action, actor, { from: record.state, to: state });
      return saved;
    });
  }

  private describe(record: DeviceArtifact, printer: PrinterConfig): DevicePreparation {
    const ready = record.state === "VERIFIED" || record.state === "PRESENT_UNVERIFIED";
    const manual =
      record.transferMode === "manual_file_transfer" && !ready
        ? `Адаптер «${printer.protocol}» не поддерживает загрузку файлов. Скопируйте файл на «${printer.name}» по пути «${record.remotePath}»` +
          (record.sizeBytes !== null ? ` (размер ${record.sizeBytes} байт)` : "") +
          " и подтвердите перенос."
        : null;
    return { deviceArtifact: record, ready, manualInstruction: manual };
  }

  private audit(
    record: DeviceArtifact,
    action: string,
    actor: string,
    states: { from?: string; to?: string }
  ): void {
    const detail: Metadata = {
      printerId: record.printerId,
      remotePath: record.remotePath,
      transferMode: record.transferMode,
      verification: record.verification,
      artifactSha256: record.artifactSha256,
      sliceVariantId: record.sliceVariantId,
      assignmentId: record.assignmentId
    };
    if (record.lastError) detail.error = record.lastError;
    recordAuditEvent(this.deps.store, () => this.nowIso(), actor, {
      entityType: "device_artifact",
      entityId: record.id,
      action,
      actor,
      ...states,
      detail
    });
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
