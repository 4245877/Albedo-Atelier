import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { FeedEvent, QueueJob } from "../../domain/dashboard/types";
import type { StoreLogger } from "./printerPoller";
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
}

const CURRENT_VERSION = 1 as const;
const MAX_FEED = 50;

export function emptyState(): PersistedState {
  return {
    version: CURRENT_VERSION,
    queue: { seq: 0, jobs: [] },
    feed: [],
    today: { key: "", done: 0, failed: 0, printingMs: 0, avgDurationMsTotal: 0, avgDurationCount: 0 },
    automations: { states: {}, lastRun: null },
    snapshots: []
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

  return base;
}

function normalizeJob(raw: Record<string, unknown>): QueueJob {
  const status = raw.status === "review" || raw.status === "error" ? raw.status : "ready";
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
      this.loadWarning = `Файл состояния ${this.filePath} повреждён (не JSON) — начинаем с пустого`;
      return emptyState();
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
