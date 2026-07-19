import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { FeedEvent, QueueJob } from "../../domain/dashboard/types";
import type { ConsumePayload, FilamentCarry, PendingConsume } from "../../app/filamentConsumption";
import { isObject } from "../../shared/isObject";
import { MAX_FEED } from "../../app/eventFeed";
import type { StoreLogger } from "../../shared/logger";
import { normalizeSnapshotMeta, type SnapshotMeta } from "./snapshotStore";

/** Persisted operator queue: the jobs plus the id sequence, so ids stay unique across restarts. */
export interface PersistedQueue {
  seq: number;
  jobs: QueueJob[];
}

/** Persisted today counters: the day they belong to plus the observed totals. */
export interface PersistedToday {
  key: string;
  done: number;
  failed: number;
  /**
   * Sum of observed printer-time in `printing` today, in ms, across all
   * printers. An observed metric (see PrinterPoller), so it can exceed one day.
   */
  printingMs: number;
  /**
   * Daily aggregate for the "average print duration" metric: the summed
   * duration and the count of successfully completed print runs whose start the
   * poller actually observed. `avgDurationMsTotal / avgDurationCount` is the
   * shown average; a count of 0 means "нет данных". Only runs with a known
   * start-to-finish span land here (see PrinterPoller.recordTransition), so a
   * print already running at startup, a restart mid-print, or a completion seen
   * only after coming back online never bias the average downward.
   */
  avgDurationMsTotal: number;
  avgDurationCount: number;
}

/** Persisted automation rule state: on/off by rule id plus the last-run stamp. */
export interface PersistedAutomations {
  states: Record<string, boolean>;
  lastRun: string | null;
}

/**
 * The whole persisted state in one document. Only the state that is genuinely
 * mutated at runtime and would otherwise be lost on restart lives here: the
 * operator queue, the event feed and today's counters. Live telemetry (printer
 * statuses, light overrides) is deliberately excluded — it is re-derived on the
 * next poll, and persisting it would make a restart re-announce stale events.
 */
export interface PersistedState {
  version: 1;
  queue: PersistedQueue;
  feed: FeedEvent[];
  today: PersistedToday;
  automations: PersistedAutomations;
  /** Metadata for saved camera snapshots; the image bytes are files, not JSON. */
  snapshots: SnapshotMeta[];
  /**
   * Filament deductions fulfillment has not confirmed yet (unreachable at
   * completion time), owed across restarts. See FilamentConsumption.
   */
  pendingConsumes: PendingConsume[];
  /**
   * Sub-gram consumption carried per printer×slot until it reaches the minimum
   * deductible unit, so micro-prints do not systematically evaporate across
   * restarts. See FilamentConsumption. Missing in older files → empty.
   */
  filamentCarry: FilamentCarry;
}

const CURRENT_VERSION = 1 as const;

export function emptyState(): PersistedState {
  return {
    version: CURRENT_VERSION,
    queue: { seq: 0, jobs: [] },
    feed: [],
    today: { key: "", done: 0, failed: 0, printingMs: 0, avgDurationMsTotal: 0, avgDurationCount: 0 },
    automations: { states: {}, lastRun: null },
    snapshots: [],
    pendingConsumes: [],
    filamentCarry: {}
  };
}

function toFeedKind(value: unknown): FeedEvent["kind"] {
  return value === "ok" || value === "err" ? value : "info";
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Coerces an arbitrary parsed JSON value into a well-formed {@link PersistedState}.
 * Tolerant like the printer-config loader: anything missing or malformed falls
 * back to an empty default so a hand-edited or partially-written file can never
 * crash startup.
 */
function normalize(raw: unknown): PersistedState {
  const base = emptyState();
  if (!isObject(raw)) return base;

  const queue = isObject(raw.queue) ? raw.queue : {};
  const jobs = Array.isArray(queue.jobs)
    ? queue.jobs.filter(isObject).map(normalizeJob)
    : [];
  base.queue = { seq: toNonNegInt(queue.seq), jobs };

  if (Array.isArray(raw.feed)) {
    base.feed = raw.feed
      .filter(isObject)
      .map((event) => ({
        icon: toStr(event.icon),
        text: toStr(event.text),
        time: toStr(event.time),
        kind: toFeedKind(event.kind)
      }))
      .slice(0, MAX_FEED);
  }

  const today = isObject(raw.today) ? raw.today : {};
  base.today = {
    key: toStr(today.key),
    done: toNonNegInt(today.done),
    failed: toNonNegInt(today.failed),
    // Missing in files written before printing-hours tracking → 0 (start fresh).
    printingMs: toNonNegInt(today.printingMs),
    // Missing in files written before average-duration tracking → 0 (start fresh).
    avgDurationMsTotal: toNonNegInt(today.avgDurationMsTotal),
    avgDurationCount: toNonNegInt(today.avgDurationCount)
  };

  const automations = isObject(raw.automations) ? raw.automations : {};
  const states: Record<string, boolean> = {};
  if (isObject(automations.states)) {
    for (const [id, value] of Object.entries(automations.states)) {
      if (typeof value === "boolean") states[id] = value;
    }
  }
  base.automations = {
    states,
    lastRun: typeof automations.lastRun === "string" ? automations.lastRun : null
  };

  if (Array.isArray(raw.snapshots)) {
    base.snapshots = raw.snapshots
      .map(normalizeSnapshotMeta)
      .filter((meta): meta is SnapshotMeta => meta !== null);
  }

  if (Array.isArray(raw.pendingConsumes)) {
    base.pendingConsumes = raw.pendingConsumes
      .map(normalizePendingConsume)
      .filter((entry): entry is PendingConsume => entry !== null);
  }

  if (isObject(raw.filamentCarry)) {
    for (const [key, value] of Object.entries(raw.filamentCarry)) {
      if (!key || !isObject(value)) continue;
      const grams = toPositiveFinite(value.grams);
      const lengthMm = toPositiveFinite(value.lengthMm);
      if (grams === undefined && lengthMm === undefined) continue;
      const entry: { grams?: number; lengthMm?: number } = {};
      if (grams !== undefined) entry.grams = grams;
      if (lengthMm !== undefined) entry.lengthMm = lengthMm;
      base.filamentCarry[key] = entry;
    }
  }

  return base;
}

function toPositiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function toOptionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Coerces one persisted retry-queue entry. An entry without the fields a
 * redelivery needs (printer, idempotency key, a positive quantity) is dropped —
 * redelivering it could never succeed or, worse, could deduct unpredictably.
 */
function normalizePendingConsume(raw: unknown): PendingConsume | null {
  if (!isObject(raw) || !isObject(raw.input)) return null;
  const source = raw.input;

  const printerId = toStr(source.printerId);
  const idempotencyKey = toStr(source.idempotencyKey);
  const lengthMm = toPositiveFinite(source.lengthMm);
  const grams = toPositiveFinite(source.grams);
  if (!printerId || !idempotencyKey || (lengthMm === undefined && grams === undefined)) {
    return null;
  }

  const amsTray =
    typeof source.amsTray === "number" && Number.isInteger(source.amsTray) && source.amsTray >= 0
      ? source.amsTray
      : undefined;

  // Optional fields are set only when present: a JSON round-trip drops
  // undefined-valued keys, so re-adding them here would make load(save(x)) ≠ x.
  const input: ConsumePayload = {
    printerId,
    printJobId: toStr(source.printJobId) || idempotencyKey,
    idempotencyKey
  };
  if (lengthMm !== undefined) input.lengthMm = lengthMm;
  if (grams !== undefined) input.grams = grams;
  if (amsTray !== undefined) input.amsTray = amsTray;
  const material = toOptionalStr(source.material);
  if (material !== undefined) input.material = material;
  const color = toOptionalStr(source.color);
  if (color !== undefined) input.color = color;
  const note = toOptionalStr(source.note);
  if (note !== undefined) input.note = note;

  return {
    input,
    printerName: toStr(raw.printerName) || printerId,
    attempts: Math.max(1, toNonNegInt(raw.attempts)),
    nextAttemptAtMs: toNonNegInt(raw.nextAttemptAtMs),
    // A missing first-failure stamp must not look ancient (that would drop the
    // entry as expired on the first retry) — restart the age clock instead.
    firstFailedAtMs:
      typeof raw.firstFailedAtMs === "number" && Number.isFinite(raw.firstFailedAtMs) && raw.firstFailedAtMs > 0
        ? raw.firstFailedAtMs
        : Date.now()
  };
}

function normalizeJob(raw: Record<string, unknown>): QueueJob {
  // Nothing in the current code ever sets a job to "error", but files written
  // by older builds may still carry it. Such a job needs the operator's
  // attention, which is exactly what "review" means — map it there instead of
  // failing the load or resurrecting the dead status.
  const legacyError = raw.status === "error";
  const status = raw.status === "review" || legacyError ? "review" : "ready";
  const job: QueueJob = {
    id: toStr(raw.id),
    title: toStr(raw.title),
    printer: toStr(raw.printer),
    material: toStr(raw.material),
    eta: toStr(raw.eta),
    status
  };
  if (typeof raw.at === "string") job.at = raw.at;
  if (raw.night === true) job.night = true;
  if (typeof raw.reason === "string") job.reason = raw.reason;
  else if (legacyError) job.reason = "задание было помечено ошибкой — проверьте его";
  if (typeof raw.file === "string" && raw.file.trim()) job.file = raw.file.trim();
  return job;
}

/**
 * A single-file JSON store for the durable slice of the farm state. Loading is
 * synchronous and tolerant (so it can run at construction time before the
 * logger exists); saving is asynchronous, serialized behind a promise chain
 * (the same idiom the poller uses for light commands) and atomic (write to a
 * temp file, then rename) so a crash mid-write can never corrupt the file.
 */
export class StateStore {
  private readonly filePath: string;
  private snapshot: (() => PersistedState) | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private logger: StoreLogger = {};
  /** Set by {@link load} when an existing file could not be read/parsed. */
  loadWarning: string | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /** Reads the persisted state. Missing file → empty defaults (first run, no warning). */
  load(): PersistedState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.loadWarning = `Не удалось прочитать файл состояния ${this.filePath} — начинаем с пустого`;
      }
      return emptyState();
    }

    try {
      return normalize(JSON.parse(raw));
    } catch {
      // Do not silently overwrite an unparseable file on the next save — move it
      // aside first so its contents can be inspected/recovered by hand.
      const backup = this.backupCorruptFile();
      this.loadWarning =
        `Файл состояния ${this.filePath} повреждён (не JSON) — начинаем с пустого` +
        (backup ? ` (сохранён бэкап ${backup})` : "");
      return emptyState();
    }
  }

  /**
   * Renames a corrupt state file to a timestamped `.corrupt-*` sibling so the
   * next {@link save} does not clobber it. Best-effort: a failure here must not
   * break startup, so the caller still proceeds with empty defaults.
   */
  private backupCorruptFile(): string | null {
    const backup = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.filePath, backup);
      return backup;
    } catch {
      return null;
    }
  }

  /** Registers the provider used to snapshot the full state on every save. */
  bind(snapshot: () => PersistedState): void {
    this.snapshot = snapshot;
  }

  /**
   * Schedules an atomic write of the current state. Fire-and-forget: writes are
   * serialized so they never interleave, and a failure is logged without
   * breaking the chain or the request that triggered it.
   */
  save(): void {
    if (!this.snapshot) return;
    this.writeChain = this.writeChain
      .then(() => (this.snapshot ? this.writeAtomic(this.snapshot()) : undefined))
      .catch((error) => {
        this.logger.error?.({ err: error, path: this.filePath }, "state persist failed");
      });
  }

  /** Resolves once all scheduled writes have settled (used on shutdown and in tests). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private async writeAtomic(data: PersistedState): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, this.filePath);
  }
}
