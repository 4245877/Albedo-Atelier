import { readFile, stat } from "node:fs/promises";

import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { assertTransition, DEVICE_ARTIFACT_TRANSITIONS } from "../../domain/print/states";
import type {
  Artifact,
  Assignment,
  DeviceArtifact,
  DeviceArtifactState,
  DeviceTransferMode,
  Metadata
} from "../../domain/print/types";
import { capabilitiesOf, type PrinterCapabilities } from "../../infra/printers/capabilities";
import type { PrinterConfig } from "../../infra/printers/config";
import {
  MAX_DEVICE_UPLOAD_BYTES,
  normalizeStartablePath,
  type PrinterFilesListing
} from "../../infra/printers/files";
import type { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { KeyedMutex } from "../../shared/keyedMutex";
import type { StoreLogger } from "../../shared/logger";
import { recordAuditEvent } from "../audit";
import { profileRevisionIdsOf } from "./binding";
import {
  PROFILE_REVISIONS_KEY,
  stalenessOf,
  type DeviceFileExpectation
} from "./deviceFileIdentity";

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
 * Two honest modes, chosen by declared adapter capability — never a pretend
 * automatic third:
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
 * Four properties this module is responsible for, each of which used to be
 * missing:
 *
 *  1. **Serialization.** Every mutation of one device slot runs under a per-slot
 *     mutex, so two "prepare" clicks cannot both insert a row (a unique-index
 *     crash) or both push bytes.
 *  2. **Reconciliation, not blind retry.** When an upload's *outcome* is lost
 *     (timeout, dropped socket), the device is re-listed before anything is
 *     concluded: the file may well be there. Only a listing that says otherwise
 *     produces `FAILED`.
 *  3. **Staleness.** A record is re-checked against what we would print *now*
 *     on every prepare, so a verified delivery for last week's slice becomes
 *     `STALE` instead of authorising a start.
 *  4. **Crash recovery.** `recover()` resolves rows a restart orphaned mid-upload.
 *
 * Nothing here ever starts a print.
 */

/** What an operator/UI needs to act on a prepared (or not-yet-prepared) file. */
export interface DevicePreparation {
  deviceArtifact: DeviceArtifact;
  /** True when the file is usable by a dispatch right now (VERIFIED only). */
  ready: boolean;
  /** Operator-facing instruction when a manual transfer is required; null otherwise. */
  manualInstruction: string | null;
  /**
   * The exact local file the operator must copy, for a manual transfer: the
   * artifact's name, content hash and size. Null when the adapter uploads itself.
   */
  localFile: { artifactId: string; name: string; sha256: string | null; sizeBytes: number | null } | null;
  /** The path the file must occupy on the device (echoed for the UI). */
  expectedRemotePath: string;
}

export interface DeviceArtifactDeps {
  store: PrintQueueStore;
  storage: ArtifactStorage;
  /** Resolves a printer id to the farm config; undefined when unknown/disabled. */
  resolvePrinter(reference: string): PrinterConfig | undefined;
  /** On-device listing used for post-upload verification (injected for tests). */
  listFiles(printer: PrinterConfig, dir: string): Promise<PrinterFilesListing>;
  /** File push; only called when the adapter declares `supportsUpload`. */
  uploadFile(
    printer: PrinterConfig,
    remotePath: string,
    bytes: Uint8Array
  ): Promise<{ remotePath: string; sizeBytes: number }>;
  /** Capability lookup; defaults to the declared table (overridable in tests). */
  capabilities?(printer: PrinterConfig): PrinterCapabilities;
  now?: () => Date;
  logger?: StoreLogger;
}

/** Everything `prepare` resolved before touching the device. */
interface PreparationTarget {
  assignment: Assignment;
  printer: PrinterConfig;
  capabilities: PrinterCapabilities;
  artifact: Artifact;
  remotePath: string;
  expectation: DeviceFileExpectation;
}

export class DeviceArtifactService {
  private readonly now: () => Date;
  private readonly logger: StoreLogger;
  private readonly capabilitiesOf: (printer: PrinterConfig) => PrinterCapabilities;
  /** One chain per device slot — see property (1) in the module docs. */
  private readonly slots = new KeyedMutex();

  constructor(private readonly deps: DeviceArtifactDeps) {
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? {};
    this.capabilitiesOf = deps.capabilities ?? capabilitiesOf;
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
   * Resolves rows a restart left mid-flight.
   *
   * An `UPLOADING` row means "a transfer was in progress in a process that no
   * longer exists". Whether the bytes arrived is unknown, and unknown is not a
   * usable state — but it is also not proof of failure, so the row is **not**
   * marked failed and re-uploaded blindly. It goes to `NOT_PRESENT` with the
   * interruption recorded; the next `prepare` reconciles against the device and
   * re-uploads only if the file really is not there.
   *
   * Called once at startup, like `ArtifactService.recover()`.
   */
  recover(): number {
    const repos = this.deps.store.repositories;
    const orphans = repos.deviceArtifacts.listByStates(["UPLOADING"]);
    if (orphans.length === 0) return 0;
    for (const record of orphans) {
      this.transition(
        record,
        "NOT_PRESENT",
        {
          verification: null,
          lastError: "перенос прерван перезапуском сервиса — состояние не подтверждено"
        },
        "system",
        "upload_interrupted"
      );
    }
    this.logger.warn?.({ count: orphans.length }, "device artifacts recovered after restart");
    return orphans.length;
  }

  /**
   * Ensures the assignment's exact file is on its printer.
   *
   * **Idempotent**: a `VERIFIED` record for the same slot, the same content hash
   * and the same binding is returned untouched — a repeated "prepare" click
   * re-uploads nothing. A record that no longer matches (different hash, slice,
   * profiles…) is marked `STALE` first and then re-prepared, which is the one
   * case where overwriting the slot is correct.
   *
   * **Serialized** per device slot: parallel calls run one after another, so the
   * second sees the first's committed record instead of racing it.
   *
   * Never called implicitly by a dispatch: preparing a file is an explicit
   * operator/plan step, so a failed transfer leaves the assignment un-started
   * rather than half-launched.
   */
  async prepare(assignmentId: string, actor = "operator"): Promise<DevicePreparation> {
    const target = this.resolveTarget(assignmentId);
    return this.slots.run(slotKey(target.printer.id, target.remotePath), () =>
      this.prepareLocked(target, actor)
    );
  }

  /**
   * Records that an operator physically copied the file to a printer whose
   * adapter cannot upload. The confirmation names the operator and is audited —
   * it is the evidence the eligibility check demands.
   *
   * If the adapter can nonetheless *list* files, the claim is checked against the
   * device instead of taken on faith, and only a positive match reaches
   * `VERIFIED`. With no listing at all, the named confirmation itself is the
   * verification (`operator_confirmed`) — recorded as exactly that, so nothing
   * later mistakes it for a device-side check.
   */
  async confirmManualTransfer(assignmentId: string, actor: string): Promise<DevicePreparation> {
    const who = actor.trim();
    if (!who) throw new ValidationError("Подтверждение переноса файла требует имени оператора");

    const target = this.resolveTarget(assignmentId);
    return this.slots.run(slotKey(target.printer.id, target.remotePath), () =>
      this.confirmLocked(target, who)
    );
  }

  // ── Locked bodies (one device slot at a time) ─────────────────────────────

  private async prepareLocked(
    target: PreparationTarget,
    actor: string
  ): Promise<DevicePreparation> {
    const { printer, artifact, remotePath } = target;

    const existing = this.currentRecord(target, actor);
    if (existing && existing.state === "VERIFIED") {
      // Already delivered, still describes this job: nothing to do. (Staleness
      // was resolved by `currentRecord`, so a VERIFIED here is genuinely current.)
      return this.describe(existing, target);
    }
    if (existing && existing.state === "PRESENT_UNVERIFIED") {
      // Something is already there — a confirmed manual transfer, or an upload
      // whose verification could not be read last time. Re-check it rather than
      // resetting the record (which would throw away an operator's confirmation).
      return this.describe(await this.verify(existing, target, actor), target);
    }

    if (!target.capabilities.supportsUpload) {
      // No upload API: record the intent, name the exact file and path, and stop.
      // The operator confirms via `confirmManualTransfer`; nothing pretends the
      // file arrived.
      const record = this.write(
        existing,
        this.identityOf(target),
        "NOT_PRESENT",
        { verification: null, lastError: null },
        actor,
        "manual_transfer_required"
      );
      return this.describe(record, target);
    }

    // ── adapter_upload ────────────────────────────────────────────────────────
    const bytes = await this.readArtifactBytes(artifact);

    const uploading = this.write(
      existing,
      this.identityOf(target),
      "UPLOADING",
      { verification: null, lastError: null },
      actor,
      "upload_started"
    );

    let uploadedBytes: number;
    try {
      const result = await this.deps.uploadFile(printer, remotePath, bytes);
      uploadedBytes = result.sizeBytes;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.(
        { err: error, printer: printer.id, file: remotePath },
        "device upload failed — reconciling against the device"
      );
      // The transfer's *outcome* is unknown, not necessarily its result: a lost
      // response leaves the file perfectly uploaded. Ask the device before
      // concluding anything, so a retry is never a blind second push.
      return this.describe(await this.reconcile(uploading, target, message, actor), target);
    }

    const present = this.transition(
      { ...uploading, uploadedAt: this.nowIso(), sizeBytes: uploadedBytes },
      "PRESENT_UNVERIFIED",
      { verification: null, lastError: null },
      actor,
      "uploaded"
    );
    return this.describe(await this.verify(present, target, actor), target);
  }

  private async confirmLocked(
    target: PreparationTarget,
    who: string
  ): Promise<DevicePreparation> {
    const existing = this.currentRecord(target, who);
    const record = this.write(
      existing,
      { ...this.identityOf(target), transferMode: "manual_file_transfer" },
      "PRESENT_UNVERIFIED",
      { verification: "operator_confirmed", lastError: null, confirmedBy: who },
      who,
      "manual_transfer_confirmed"
    );

    // A listing-capable adapter still gets checked — an operator's word is the
    // fallback for adapters that offer no evidence, not a way to skip evidence
    // that IS available.
    return this.describe(await this.verify(record, target, who), target);
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  /**
   * Everything a preparation needs, resolved from stored rows only and refused
   * loudly when anything does not line up.
   *
   * This is where "отменённое или устаревшее assignment не может подготовить
   * файл" and "файл берётся только из доверенного хранилища по связи с
   * конкретным SliceVariant" are enforced — before a byte is read or sent.
   */
  private resolveTarget(assignmentId: string): PreparationTarget {
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

    const raw = assignment.binding.expectedRemotePath;
    if (!raw) {
      throw new JobError("У назначения не задан путь файла на устройстве — нечего готовить");
    }
    // Rejects traversal, absolute paths, control characters, over-long names and
    // anything that is not a printable G-code extension.
    const remotePath = normalizeStartablePath(raw);

    const artifact = this.resolveArtifact(assignment);

    return {
      assignment,
      printer,
      capabilities: this.capabilitiesOf(printer),
      artifact,
      remotePath,
      expectation: {
        printerId: printer.id,
        remotePath,
        sliceVariantId: assignment.binding.sliceVariantId,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        assignmentId: assignment.id,
        profileRevisionIds: profileRevisionIdsOf(assignment.binding)
      }
    };
  }

  /**
   * The exact artifact this assignment is bound to — and the proof that it is
   * the slice variant's own output, not some other file that happens to be
   * registered. A binding that points at a variant whose output has moved (a
   * re-slice) is refused rather than resolved to the newer file: the placement
   * was confirmed for what the operator saw.
   */
  private resolveArtifact(assignment: Assignment): Artifact {
    const repos = this.deps.store.repositories;
    const artifactId = assignment.binding.artifactId;
    if (!artifactId) throw new JobError("У назначения не задан исполнимый артефакт");
    const artifact = repos.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);

    const variantId = assignment.binding.sliceVariantId;
    if (variantId) {
      const variant = repos.sliceVariants.getById(variantId);
      if (!variant) throw new NotFoundError(`Вариант слайсинга «${variantId}»`);
      if (variant.state !== "ready") {
        throw new JobError(
          `Вариант слайсинга «${variantId}» в состоянии «${variant.state}» — готового файла нет`
        );
      }
      if (variant.outputArtifactId !== artifact.id) {
        throw new JobError(
          `Назначение ссылается на артефакт «${artifact.id}», а вариант «${variantId}» выдал «${variant.outputArtifactId ?? "—"}» — требуется перепланирование`
        );
      }
    }

    const bound = assignment.binding.artifactSha256;
    if (bound !== null && artifact.sha256 !== bound) {
      throw new JobError(
        `Содержимое артефакта «${artifact.id}» изменилось после подтверждения назначения — требуется перепланирование`
      );
    }
    return artifact;
  }

  /**
   * Reads the artifact's bytes **from the artifact store only**.
   *
   * `source` is an opaque content-addressed key, and `resolvePath` accepts only
   * a well-formed `sha256/<2>/<64>` under the storage root — so no row, however
   * corrupt or hand-edited, can make this read `/etc/passwd`, a path outside the
   * store, or a URL. The size is checked against the registered size before the
   * read, which is what stops a half-written blob being pushed as a whole file.
   */
  private async readArtifactBytes(artifact: Artifact): Promise<Uint8Array> {
    if (!artifact.source) {
      throw new JobError(
        `У артефакта «${artifact.id}» нет сохранённых байтов — загрузить на принтер нечего`
      );
    }
    const path = this.deps.storage.resolvePath(artifact.source);

    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) {
      throw new JobError(`Файл артефакта «${artifact.id}» отсутствует в хранилище`);
    }
    if (info.size === 0) {
      throw new JobError(`Файл артефакта «${artifact.id}» пуст — загружать нечего`);
    }
    if (artifact.sizeBytes !== null && info.size !== artifact.sizeBytes) {
      throw new JobError(
        `Файл артефакта «${artifact.id}» в хранилище ${info.size} байт вместо ${artifact.sizeBytes} — загрузка отменена`
      );
    }
    if (info.size > MAX_DEVICE_UPLOAD_BYTES) {
      throw new JobError(
        `Файл артефакта «${artifact.id}» (${info.size} байт) превышает лимит загрузки на принтер`
      );
    }
    return readFile(path);
  }

  /**
   * The record currently occupying this slot, with staleness already resolved:
   * a row that no longer describes what we would print is transitioned to
   * `STALE` here, so every caller below sees only current records.
   *
   * A slot held by a *different, still-live* assignment is a hard conflict
   * rather than something to overwrite — two placements pointing at one device
   * path is a planning bug, and silently taking the slot is exactly how one
   * assignment ends up printing another's geometry.
   */
  private currentRecord(target: PreparationTarget, actor: string): DeviceArtifact | null {
    const repos = this.deps.store.repositories;
    const existing = repos.deviceArtifacts.findBySlot(target.printer.id, target.remotePath);
    if (!existing) return null;

    if (
      existing.assignmentId !== null &&
      existing.assignmentId !== target.assignment.id &&
      this.assignmentIsLive(existing.assignmentId)
    ) {
      throw new JobError(
        `Путь «${target.remotePath}» на «${target.printer.name}» уже занят активным назначением ${existing.assignmentId} — освободите его перед подготовкой`,
        { printerId: target.printer.id, remotePath: target.remotePath }
      );
    }

    const stale = stalenessOf(existing, target.expectation);
    if (!stale) return existing;
    if (existing.state === "STALE") return existing;
    return this.transition(
      existing,
      "STALE",
      { verification: null, lastError: stale },
      actor,
      "stale"
    );
  }

  private assignmentIsLive(assignmentId: string): boolean {
    const other = this.deps.store.repositories.assignments.getById(assignmentId);
    if (!other) return false;
    if (other.state === "RELEASED" || other.state === "CANCELLED") return false;
    return other.invalidatedAt === null;
  }

  // ── Device-side checks ────────────────────────────────────────────────────

  /**
   * Decides what a *failed* upload actually meant, by asking the device.
   *
   * Three outcomes, all honest:
   *  - the file is there and matches → the response was merely lost; the record
   *    continues to verification and no second upload happens;
   *  - the file is absent (or the wrong size) → `FAILED`, with the transport
   *    error kept so an operator can see why and a retry can re-upload;
   *  - the listing itself is unavailable → `FAILED` too, because nothing was
   *    confirmed. Fail-closed: unknown never means ready.
   */
  private async reconcile(
    record: DeviceArtifact,
    target: PreparationTarget,
    uploadError: string,
    actor: string
  ): Promise<DeviceArtifact> {
    if (!target.capabilities.supportsFileListing) {
      return this.transition(
        record,
        "FAILED",
        { verification: null, lastError: uploadError },
        actor,
        "upload_failed"
      );
    }

    const entry = await this.lookupOnDevice(target).catch(() => "unavailable" as const);
    if (entry === "unavailable") {
      return this.transition(
        record,
        "FAILED",
        {
          verification: null,
          lastError: `${uploadError}; проверить наличие файла не удалось`
        },
        actor,
        "upload_failed"
      );
    }
    if (!entry || !this.sizeMatches(entry.size, target.artifact.sizeBytes)) {
      return this.transition(
        record,
        "FAILED",
        { verification: null, lastError: uploadError },
        actor,
        "upload_failed"
      );
    }

    // The bytes are there after all — the response was lost, not the transfer.
    this.logger.warn?.(
      { printer: target.printer.id, file: target.remotePath },
      "upload response lost but file present — reconciled without re-upload"
    );
    const present = this.transition(
      { ...record, uploadedAt: this.nowIso(), sizeBytes: entry.size ?? record.sizeBytes },
      "PRESENT_UNVERIFIED",
      { verification: null, lastError: `ответ устройства потерян: ${uploadError}` },
      actor,
      "upload_reconciled"
    );
    return this.verify(present, target, actor);
  }

  /**
   * Re-reads the device listing and updates the record's verification level.
   * A file that has vanished, or whose size no longer matches the artifact, is
   * marked `INVALID` — never silently downgraded to "probably fine".
   *
   * Reaching `VERIFIED` requires *evidence*: a matching listing entry, or — only
   * for an adapter with no file API at all — a named operator confirmation. A
   * listing that could not be read leaves the record `PRESENT_UNVERIFIED`, which
   * no dispatch accepts.
   */
  private async verify(
    record: DeviceArtifact,
    target: PreparationTarget,
    actor: string
  ): Promise<DeviceArtifact> {
    const expectedSize = target.artifact.sizeBytes;

    if (!target.capabilities.supportsFileListing) {
      // Nothing on the device can be read. A named operator confirmation is the
      // only evidence obtainable, and it is recorded as exactly that.
      if (record.verification === "operator_confirmed" && record.confirmedBy) {
        return this.transition(
          { ...record, verifiedAt: this.nowIso() },
          "VERIFIED",
          { verification: "operator_confirmed", lastError: null },
          actor,
          "verified"
        );
      }
      return this.transition(
        record,
        "PRESENT_UNVERIFIED",
        { verification: null, lastError: "адаптер не умеет проверять файлы на устройстве" },
        actor,
        "unverifiable"
      );
    }

    let entry: Awaited<ReturnType<typeof this.lookupOnDevice>>;
    try {
      entry = await this.lookupOnDevice(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed listing is not proof of absence — the file stays present but
      // unverified (and therefore un-startable); the next prepare tries again.
      return this.transition(
        record,
        "PRESENT_UNVERIFIED",
        { verification: null, lastError: `листинг недоступен: ${message}` },
        actor,
        "verification_deferred"
      );
    }

    if (!entry) {
      return this.transition(
        record,
        "INVALID",
        { verification: null, lastError: "файл не найден на устройстве после переноса" },
        actor,
        "verification_failed"
      );
    }
    if (entry.size === 0) {
      return this.transition(
        record,
        "INVALID",
        { verification: null, lastError: "на устройстве лежит пустой файл" },
        actor,
        "verification_failed"
      );
    }
    if (!this.sizeMatches(entry.size, expectedSize)) {
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
    const verification =
      typeof entry.size === "number" && expectedSize !== null ? "name_and_size" : "name_only";
    return this.transition(
      { ...record, sizeBytes: entry.size ?? record.sizeBytes, verifiedAt: this.nowIso() },
      "VERIFIED",
      { verification, lastError: null },
      actor,
      "verified"
    );
  }

  /** The listing entry for the exact target path, or null when the device has none. */
  private async lookupOnDevice(
    target: PreparationTarget
  ): Promise<{ size: number | undefined } | null> {
    const slash = target.remotePath.lastIndexOf("/");
    const dir = slash === -1 ? "" : target.remotePath.slice(0, slash);
    const listing = await this.deps.listFiles(target.printer, dir);
    const entry = listing.entries.find(
      (e) => e.type === "file" && e.path === target.remotePath
    );
    return entry ? { size: entry.size } : null;
  }

  /** Sizes match when both are known and equal; an unknown device size cannot refute. */
  private sizeMatches(deviceSize: number | undefined, expected: number | null): boolean {
    if (typeof deviceSize !== "number" || expected === null) return true;
    return deviceSize === expected;
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  private identityOf(target: PreparationTarget): SlotIdentity {
    return {
      printerId: target.printer.id,
      assignmentId: target.assignment.id,
      sliceVariantId: target.assignment.binding.sliceVariantId,
      artifactId: target.artifact.id,
      artifactSha256: target.artifact.sha256,
      remotePath: target.remotePath,
      sizeBytes: target.artifact.sizeBytes,
      transferMode: target.capabilities.supportsUpload ? "adapter_upload" : "manual_file_transfer",
      profileRevisionIds: [...target.expectation.profileRevisionIds]
    };
  }

  /** Creates or re-points the record for a device slot, then moves it to `state`. */
  private write(
    existing: DeviceArtifact | null,
    identity: SlotIdentity,
    state: DeviceArtifactState,
    patch: RecordPatch,
    actor: string,
    action: string
  ): DeviceArtifact {
    return this.deps.store.transaction(() => {
      const repos = this.deps.store.repositories;
      const iso = this.nowIso();
      const { profileRevisionIds, ...columns } = identity;
      if (!existing) {
        const created: DeviceArtifact = {
          id: newId(ID_PREFIX.deviceArtifact),
          ...columns,
          state,
          verification: patch.verification ?? null,
          uploadedAt: null,
          verifiedAt: null,
          confirmedBy: patch.confirmedBy ?? null,
          lastError: patch.lastError ?? null,
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          metadata: { [PROFILE_REVISIONS_KEY]: profileRevisionIds }
        };
        repos.deviceArtifacts.insert(created);
        this.audit(created, action, actor, { to: state });
        return created;
      }

      assertTransition("файл на устройстве", DEVICE_ARTIFACT_TRANSITIONS, existing.state, state);
      const saved = repos.deviceArtifacts.update({
        ...existing,
        ...columns,
        state,
        verification: patch.verification ?? null,
        confirmedBy: patch.confirmedBy ?? existing.confirmedBy,
        lastError: patch.lastError ?? null,
        updatedAt: iso,
        metadata: { ...existing.metadata, [PROFILE_REVISIONS_KEY]: profileRevisionIds }
      });
      this.audit(saved, action, actor, { from: existing.state, to: state });
      return saved;
    });
  }

  private transition(
    record: DeviceArtifact,
    state: DeviceArtifactState,
    patch: RecordPatch,
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

  private describe(record: DeviceArtifact, target: PreparationTarget): DevicePreparation {
    const ready = record.state === "VERIFIED";
    const manual =
      record.transferMode === "manual_file_transfer" && !ready
        ? `Адаптер «${target.printer.protocol}» не поддерживает загрузку файлов. Скопируйте файл «${target.artifact.name}»` +
          (target.artifact.sha256 ? ` (sha256 ${target.artifact.sha256.slice(0, 12)}…)` : "") +
          ` на «${target.printer.name}» по пути «${record.remotePath}»` +
          (record.sizeBytes !== null ? ` (размер ${record.sizeBytes} байт)` : "") +
          " и подтвердите перенос от своего имени."
        : null;
    return {
      deviceArtifact: record,
      ready,
      manualInstruction: manual,
      localFile: {
        artifactId: target.artifact.id,
        name: target.artifact.name,
        sha256: target.artifact.sha256,
        sizeBytes: target.artifact.sizeBytes
      },
      expectedRemotePath: record.remotePath
    };
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

/** The columns a write re-points, plus the profiles the delivery is pinned to. */
interface SlotIdentity {
  printerId: string;
  assignmentId: string;
  sliceVariantId: string | null;
  artifactId: string | null;
  artifactSha256: string | null;
  remotePath: string;
  sizeBytes: number | null;
  transferMode: DeviceTransferMode;
  profileRevisionIds: string[];
}

interface RecordPatch {
  verification?: DeviceArtifact["verification"];
  lastError?: string | null;
  confirmedBy?: string | null;
}

/** Mutex key: one chain per physical device slot. */
function slotKey(printerId: string, remotePath: string): string {
  return `${printerId}::${remotePath}`;
}
