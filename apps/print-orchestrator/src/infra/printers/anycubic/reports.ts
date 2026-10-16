import { isObject } from "../../../shared/isObject";
import type { PrinterConfig } from "../config";
import { makeOfflineStatus, resolveRemainingMinutes, roundOrNull, toFiniteNumber } from "../status/mapper";
import type { PrinterLiveStatus } from "../status/types";

/**
 * Reading Anycubic LAN reports — pure functions, no sockets, no clocks of their
 * own. The session feeds them what arrived; they say what it means.
 *
 * The rules come from what has been observed on hardware, and lean conservative
 * where the observations stop:
 *
 *  - **the job's lifecycle comes from `info` alone.** Its `data.state`
 *    (`free`/`busy`) plus `data.project.state` is the one lifecycle source every
 *    capture agrees on (chrisfore validated the machine `preheating → … →
 *    printing → pausing → paused → resuming → … → stopping → stoped`, ending in
 *    `finished` under `last_project`). `print` pushes carry progress — and so do
 *    command acks and settings snapshots on the same topic — so they enrich a
 *    job `info` already confirmed and never start, pause or finish one;
 *  - **a contradiction or a transition is `unknown`, never a guess.** `busy`
 *    with no project, `free` with a project still claiming to print, `stopping`,
 *    a `finished` that the top-level state does not confirm yet: each reads as
 *    "not confirmed", which the poller already treats as "keep the last real
 *    state" — so no start or completion is ever announced from one of them;
 *  - **an absent value is `null`.** Nothing is derived from a neighbouring field.
 */

export const ANYCUBIC_TOPIC_ROOT = "anycubic/anycubicCloud/v1";

/** The report types this adapter reads. Every other type is ignored unparsed. */
export type AnycubicReportType = "info" | "tempature" | "print" | "status";

const READ_TYPES: ReadonlySet<string> = new Set<AnycubicReportType>(["info", "tempature", "print", "status"]);

/** The one subscription: this printer's report topics. */
export function reportSubscription(modelId: string, deviceId: string): string {
  return `${ANYCUBIC_TOPIC_ROOT}/printer/public/${modelId}/${deviceId}/#`;
}

/** Where a read query for `type` is published. */
export function queryTopic(modelId: string, deviceId: string, type: string): string {
  return `${ANYCUBIC_TOPIC_ROOT}/web/printer/${modelId}/${deviceId}/${type}`;
}

/**
 * The report type a topic carries, or null when this adapter does not read it.
 *
 * Exact: `…/printer/public/{modelId}/{deviceId}/{type}/report` for THIS device.
 * The broker's generic `…/{deviceId}/response` acknowledgement answers every
 * message with a bare code and must not be mistaken for a report (OrcaCubic's
 * capture); a topic for another device is not ours to read.
 */
export function reportTypeOf(topic: string, modelId: string, deviceId: string): AnycubicReportType | null {
  const prefix = `${ANYCUBIC_TOPIC_ROOT}/printer/public/${modelId}/${deviceId}/`;
  if (!topic.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length).split("/");
  if (rest.length !== 2 || rest[1] !== "report") return null;
  return READ_TYPES.has(rest[0]) ? (rest[0] as AnycubicReportType) : null;
}

// ── Reported values ───────────────────────────────────────────────────────────

/** What one `info` report says about the job — the lifecycle source. */
export interface AnycubicJobReport {
  /** `info.data.state`: the machine as a whole. */
  work: "free" | "busy";
  /** `project.state` of the job in hand, lower-case; null when there is no project. */
  phase: string | null;
  /** `last_project.state` — how the previous job ended (`finished`, `stoped`, …). */
  lastPhase: string | null;
  /** `project.pause`: 0 running, 1 paused, 2 pausing, 3 resuming, 4 stopping. */
  pauseCode: number | null;
  /** The job's file as the printer names it (may carry its staging directory). */
  file: string | null;
  taskId: string | null;
  progressPct: number | null;
  currentLayer: number | null;
  totalLayers: number | null;
  /** `remain_time`, minutes — the printer's own countdown. */
  remainingMinutes: number | null;
}

/** Progress a `print` push carries for the running job. */
export interface AnycubicProgressReport {
  file: string | null;
  taskId: string | null;
  progressPct: number | null;
  currentLayer: number | null;
  totalLayers: number | null;
  remainingMinutes: number | null;
}

export interface AnycubicTemperatures {
  nozzle: number | null;
  nozzleTarget: number | null;
  bed: number | null;
  bedTarget: number | null;
}

/** Identity fields an `info` report carries. */
export interface AnycubicReportedIdentity {
  printerName: string | null;
  model: string | null;
  firmware: string | null;
}

export interface AnycubicInfoReport {
  /** Null when the report states no machine state — then it confirms nothing. */
  job: AnycubicJobReport | null;
  temperatures: AnycubicTemperatures | null;
  identity: AnycubicReportedIdentity;
}

/** The phases in which the job in hand is running. */
const PRINTING_PHASES: ReadonlySet<string> = new Set([
  "preheating",
  "auto_leveling",
  "vibrating",
  "flow_calibrating",
  "checking",
  "printing",
  "updated",
  "resuming",
  "resumed"
]);

const PAUSED_PHASES: ReadonlySet<string> = new Set(["pausing", "paused"]);

/** `project.pause` values that mean the job is held. */
const PAUSED_CODES: ReadonlySet<number> = new Set([1, 2]);

export function parseInfoReport(payload: unknown): AnycubicInfoReport | null {
  if (!isObject(payload) || !isObject(payload.data)) return null;
  const data = payload.data;
  const identity: AnycubicReportedIdentity = {
    printerName: text(data.printerName),
    model: text(data.model),
    firmware: text(data.version)
  };
  const temperatures = isObject(data.temp) ? parseTemperatures(data.temp) : null;

  const work = lower(data.state);
  if (work !== "free" && work !== "busy") return { job: null, temperatures, identity };

  const project = isObject(data.project) ? data.project : null;
  const last = isObject(data.last_project) ? data.last_project : null;
  return {
    job: {
      work,
      phase: project ? lower(project.state) : null,
      lastPhase: last ? lower(last.state) : null,
      pauseCode: project ? integer(project.pause) : null,
      file: project ? text(project.filename) : null,
      taskId: project ? idText(project.taskid ?? project.task_id) : null,
      ...progressFields(project)
    },
    temperatures,
    identity
  };
}

/**
 * A `print` push, when it is the progress shape — discriminated by the presence
 * of `progress`, because a command ack (`taskid` alone) and a settings snapshot
 * share the topic. Its own `state`/`action` are ignored on purpose (see the
 * module note).
 */
export function parsePrintReport(payload: unknown): AnycubicProgressReport | null {
  if (!isObject(payload) || !isObject(payload.data)) return null;
  const data = payload.data;
  if (!("progress" in data)) return null;
  return {
    file: text(data.filename),
    taskId: idText(data.taskid ?? data.task_id),
    ...progressFields(data)
  };
}

/** A `tempature` push (the firmware's spelling). */
export function parseTemperatureReport(payload: unknown): AnycubicTemperatures | null {
  if (!isObject(payload) || !isObject(payload.data)) return null;
  return parseTemperatures(payload.data);
}

/** A `status` workReport: the coarse `free`/`busy`, or null. */
export function parseStatusReport(payload: unknown): "free" | "busy" | null {
  if (!isObject(payload)) return null;
  const state = lower(payload.state);
  return state === "free" || state === "busy" ? state : null;
}

function parseTemperatures(source: Record<string, unknown>): AnycubicTemperatures | null {
  const result: AnycubicTemperatures = {
    nozzle: celsius(source.curr_nozzle_temp),
    nozzleTarget: celsius(source.target_nozzle_temp),
    bed: celsius(source.curr_hotbed_temp),
    bedTarget: celsius(source.target_hotbed_temp)
  };
  return Object.values(result).some((v) => v !== null) ? result : null;
}

function progressFields(source: Record<string, unknown> | null): Pick<
  AnycubicJobReport,
  "progressPct" | "currentLayer" | "totalLayers" | "remainingMinutes"
> {
  if (!source) return { progressPct: null, currentLayer: null, totalLayers: null, remainingMinutes: null };
  const progress = toFiniteNumber(source.progress);
  const remain = toFiniteNumber(source.remain_time);
  const current = integer(source.curr_layer);
  const total = integer(source.total_layers);
  return {
    progressPct: progress !== null && progress >= 0 && progress <= 100 ? progress : null,
    currentLayer: current !== null && current >= 0 ? current : null,
    totalLayers: total !== null && total > 0 ? total : null,
    remainingMinutes: remain !== null && remain >= 0 ? remain : null
  };
}

// ── The job, as the farm reads it ─────────────────────────────────────────────

export type AnycubicLifecycle = "idle" | "printing" | "paused" | "unknown";

export function lifecycleOf(job: AnycubicJobReport): AnycubicLifecycle {
  const phase = job.phase;
  if (job.work === "free") {
    // A project still claiming to run on a free machine is mid-transition.
    if (phase && (PRINTING_PHASES.has(phase) || PAUSED_PHASES.has(phase))) return "unknown";
    return "idle";
  }
  // Busy with no job in hand: homing, loading filament, a calibration — the
  // machine is occupied, but not by a print this service can name.
  if (!phase) return "unknown";
  if (PAUSED_PHASES.has(phase)) return "paused";
  if (PRINTING_PHASES.has(phase)) {
    return job.pauseCode !== null && PAUSED_CODES.has(job.pauseCode) ? "paused" : "printing";
  }
  // `stopping`, a terminal word the top-level state has not confirmed yet, or a
  // phase nobody has captured: not confirmed.
  return "unknown";
}

/**
 * The raw words behind the state, for the operator and for the shared outcome
 * classifier (`stoped` → cancelled, `finished` → completed): the job's phase
 * while busy, how the last job ended once free, else `free`/`busy`.
 */
export function stateTextOf(job: AnycubicJobReport): string {
  if (job.work === "busy") return job.phase ?? "busy";
  const ended = job.phase && !PRINTING_PHASES.has(job.phase) && !PAUSED_PHASES.has(job.phase) ? job.phase : null;
  return ended ?? job.lastPhase ?? "free";
}

/**
 * Folds a `print` progress push into the job `info` confirmed — only while that
 * job is running, and only when the push is about the same job (by task id, else
 * by file). Anything else is ignored: progress for a job the lifecycle has not
 * confirmed would describe a print this service has not seen start.
 */
export function applyProgress(job: AnycubicJobReport, progress: AnycubicProgressReport): AnycubicJobReport {
  const lifecycle = lifecycleOf(job);
  if (lifecycle !== "printing" && lifecycle !== "paused") return job;
  if (job.taskId && progress.taskId && job.taskId !== progress.taskId) return job;
  if (!(job.taskId && progress.taskId) && job.file && progress.file && job.file !== progress.file) return job;
  return {
    ...job,
    progressPct: progress.progressPct ?? job.progressPct,
    currentLayer: progress.currentLayer ?? job.currentLayer,
    totalLayers: progress.totalLayers ?? job.totalLayers,
    remainingMinutes: progress.remainingMinutes ?? job.remainingMinutes
  };
}

/**
 * The job file as the farm shows it: the printer's staging directory
 * (`.3mf_temp/…`, `/useremain/…`) is dropped — it is not part of what the
 * operator named the file and may expose the device's internal paths.
 */
export function displayFileName(file: string | null): string | null {
  if (!file) return null;
  const name = file.split("/").filter(Boolean).at(-1) ?? "";
  return name || null;
}

export interface AnycubicObservation {
  job: AnycubicJobReport | null;
  /** When `info` last confirmed the job state (ms epoch); null before the first. */
  jobObservedAt: number | null;
  temperatures: AnycubicTemperatures | null;
  temperaturesObservedAt: number | null;
}

/** How old a job state may be before it no longer counts as live. */
export const JOB_STATE_MAX_AGE_MS = 60_000;
/** Temperatures older than this are reported unknown rather than stale. */
export const TEMPERATURE_MAX_AGE_MS = 60_000;

/**
 * The live status for an observation, as of `now`. The session decides whether
 * the connection is up; this decides what the data says and whether it is fresh
 * enough to be believed.
 */
export function buildAnycubicStatus(
  printer: PrinterConfig,
  observation: AnycubicObservation,
  now: number
): PrinterLiveStatus {
  const temps =
    observation.temperatures &&
    observation.temperaturesObservedAt !== null &&
    now - observation.temperaturesObservedAt <= TEMPERATURE_MAX_AGE_MS
      ? observation.temperatures
      : null;
  const base: PrinterLiveStatus = {
    ...makeOfflineStatus(printer, ""),
    nozzleTemp: roundOrNull(temps?.nozzle ?? null),
    nozzleTarget: roundOrNull(temps?.nozzleTarget ?? null),
    bedTemp: roundOrNull(temps?.bed ?? null),
    bedTarget: roundOrNull(temps?.bedTarget ?? null)
  };

  const job = observation.job;
  const observedAt = observation.jobObservedAt;
  if (!job || observedAt === null) {
    // Connected, but no `info` has confirmed the job yet: telemetry without a
    // job state is not a status anything may act on.
    return {
      ...base,
      online: false,
      status: "unknown",
      error: "Anycubic LAN: ожидание актуального состояния принтера",
      updatedAt: new Date(observation.temperaturesObservedAt ?? now).toISOString()
    };
  }
  if (now - observedAt > JOB_STATE_MAX_AGE_MS) {
    return {
      ...makeOfflineStatus(printer, `Anycubic LAN: актуальное состояние не получено более ${Math.round(JOB_STATE_MAX_AGE_MS / 1000)} секунд`),
      updatedAt: new Date(observedAt).toISOString()
    };
  }

  const lifecycle = lifecycleOf(job);
  const busy = job.work === "busy";
  const active = lifecycle === "printing" || lifecycle === "paused";
  return {
    ...base,
    online: true,
    status: lifecycle,
    currentFile: busy ? displayFileName(job.file) : null,
    progressPct: busy ? roundOrNull(job.progressPct) : null,
    remainingMinutes: active
      ? resolveRemainingMinutes({
          reportedRemainingSec: job.remainingMinutes === null ? null : job.remainingMinutes * 60,
          slicerTotalSec: null,
          elapsedSec: null,
          progressPct: null
        })
      : null,
    currentLayer: active ? job.currentLayer : null,
    totalLayers: active ? job.totalLayers : null,
    stateText: stateTextOf(job),
    error: null,
    updatedAt: new Date(observedAt).toISOString()
  };
}

// ── Small readers ─────────────────────────────────────────────────────────────

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

function lower(value: unknown): string | null {
  const t = text(value);
  return t ? t.toLowerCase() : null;
}

function integer(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

function idText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

/** A plausible temperature in °C, or null. Guards against sentinel garbage. */
function celsius(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && n > -50 && n < 600 ? n : null;
}
