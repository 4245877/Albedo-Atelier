import type { NightCandidate, QueueJob } from "../domain/dashboard/types";
import { parseLocalTimeWindow } from "../shared/time";
import type { PrinterConfig } from "../infra/printers/config";
import { normalizeStartablePath } from "../infra/printers/files";
import { supportsPrinterStart, type PrinterLiveStatus } from "../infra/printers/status";
import { isBusyStatus } from "./printerView";

/**
 * One night-print candidate with the reasoning behind it. `candidate` is the
 * dashboard-facing projection; `blockers` are the concrete, hard reasons the job
 * cannot actually be launched tonight (empty → it is startable). This keeps the
 * suggestion honest: the UI can show a recommendation while startNight refuses
 * anything with blockers instead of pretending to run it.
 */
export interface NightPlanEntry {
  candidate: NightCandidate;
  job: QueueJob;
  printer: PrinterConfig | undefined;
  blockers: string[];
}

export interface NightPlanContext {
  window: string;
  resolvePrinter: (job: QueueJob) => PrinterConfig | undefined;
  getStatus: (id: string) => PrinterLiveStatus | undefined;
}

/** Minutes of a "HH:MM – HH:MM" window, wrapping across midnight. */
export function windowLengthMinutes(window: string): number | null {
  const parsed = parseLocalTimeWindow(window);
  if (!parsed) return null;
  const { startMinutes, endMinutes } = parsed;
  if (startMinutes === endMinutes) return 24 * 60;
  return startMinutes < endMinutes ? endMinutes - startMinutes : 24 * 60 - startMinutes + endMinutes;
}

/**
 * Parses a human ETA like "2ч", "2 ч 30 м", "90 м", "1h30" into minutes.
 * Returns null when nothing recognisable is present (unknown, not zero).
 */
export function parseEtaMinutes(text: string): number | null {
  if (!text) return null;
  const hours = /(\d+(?:[.,]\d+)?)\s*(?:ч|час|h)/i.exec(text);
  const minutes = /(\d+)\s*(?:м|мин|m(?!ч))/i.exec(text);
  let total = 0;
  let matched = false;
  if (hours) {
    total += Math.round(parseFloat(hours[1].replace(",", ".")) * 60);
    matched = true;
  }
  if (minutes) {
    total += Number(minutes[1]);
    matched = true;
  }
  return matched ? total : null;
}

function riskLabel(risk: number): string {
  if (risk < 35) return "низкий риск";
  if (risk < 65) return "умеренный риск";
  return "высокий риск";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** "неизвестно" material values that cannot be compared. */
function isUnknownMaterial(value: string): boolean {
  const material = value.trim();
  return !material || material === "—";
}

/**
 * Whether a job's declared material contradicts what the printer is declared
 * to hold. The loaded value may list alternatives ("PLA / PETG / TPU"), so it
 * is tokenized and the job's material must match one token (case-insensitive).
 * Unknown on either side ("", "—") is NOT a mismatch — there is nothing to
 * contradict; only a concrete disagreement reports true.
 */
export function materialsIncompatible(needed: string, loaded: string): boolean {
  if (isUnknownMaterial(needed) || isUnknownMaterial(loaded)) return false;
  const wanted = needed.trim().toLowerCase();
  return !loaded
    .split(/[/,;+]/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}

function evaluate(job: QueueJob, ctx: NightPlanContext, windowMinutes: number | null): NightPlanEntry {
  const printer = ctx.resolvePrinter(job);
  const status = printer ? ctx.getStatus(printer.id) : undefined;
  const blockers: string[] = [];
  let risk = 15;

  // Unattended (night) print requires an explicit operator decision. An unmarked
  // job is never launched at night — the absence of a night flag must NOT, by
  // fallback, make every ready job eligible for an unattended launch.
  if (job.night !== true) {
    blockers.push("задание не отмечено для печати без присмотра — подтвердите ночной запуск явно");
    risk += 20;
  }

  if (!printer) {
    blockers.push(`принтер «${job.printer}» не найден в конфигурации`);
    risk += 35;
  } else {
    if (!supportsPrinterStart(printer)) {
      blockers.push(`удалённый запуск для «${printer.name}» не поддерживается`);
      risk += 20;
    }
    if (!status || !status.online) {
      blockers.push(`«${printer.name}» не в сети`);
      risk += 30;
    } else if (isBusyStatus(status.status)) {
      blockers.push(`«${printer.name}» уже занят печатью`);
      risk += 30;
    } else if (status.status === "error") {
      blockers.push(`«${printer.name}» в состоянии ошибки`);
      risk += 30;
    } else if (status.status !== "idle") {
      // Unattended start demands a confirmed idle. "unknown" means the device
      // has not answered honestly yet — that is a blocker, not a discount.
      blockers.push(`состояние «${printer.name}» не подтверждено (${status.status})`);
      risk += 25;
    }
    // Filament for an unattended print must be verifiable on BOTH sides: an
    // unknown material — the job's or the loaded reel's — blocks the launch,
    // because the right filament for a print nobody is watching cannot be
    // confirmed. A known but contradicting pair is likewise blocked.
    if (isUnknownMaterial(job.material) || isUnknownMaterial(printer.material)) {
      blockers.push(
        "материал не подтверждён — для ночной печати нужен известный материал с обеих сторон"
      );
      risk += 20;
    } else if (materialsIncompatible(job.material, printer.material)) {
      blockers.push(
        `материал не совпадает: заданию нужен ${job.material}, в «${printer.name}» заправлен ${printer.material}`
      );
      risk += 30;
    }
  }

  if (!job.file) {
    blockers.push("у задания не задан файл для запуска на принтере");
    risk += 15;
  } else {
    try {
      normalizeStartablePath(job.file);
    } catch {
      blockers.push(`файл «${job.file}» не пройдёт проверку пути (см. правила запуска)`);
      risk += 15;
    }
  }

  const etaMinutes = parseEtaMinutes(job.eta);
  if (etaMinutes === null) {
    // With no known duration there is no way to verify the job fits the night
    // window — for an unattended print that is a hard blocker, not a shrug.
    blockers.push("длительность печати неизвестна — нельзя проверить, что она впишется в окно");
    risk += 25;
  } else if (windowMinutes !== null && etaMinutes > windowMinutes) {
    blockers.push("печать не впишется в ночное окно");
    risk += 40;
  } else if (windowMinutes !== null) {
    risk += (etaMinutes / windowMinutes) * 30;
  }

  const finalRisk = clamp(risk, 5, 96);
  return {
    job,
    printer,
    blockers,
    candidate: {
      title: job.title,
      printer: printer?.name ?? job.printer,
      eta: job.eta,
      risk: finalRisk,
      riskLabel: riskLabel(finalRisk),
      // The dashboard shows the same hard reasons and disables the start
      // button, instead of claiming the job "fits the window" unconditionally.
      blockers: [...blockers]
    }
  };
}

/**
 * Builds ranked night-print candidates from the queue. Only jobs ready to run
 * are considered; when any are explicitly flagged `night`, the selection is
 * restricted to those, otherwise every ready job is a candidate. Sorted safest
 * first, so pick 0 is always the lowest-risk recommendation.
 */
export function buildNightPlan(queue: QueueJob[], ctx: NightPlanContext): NightPlanEntry[] {
  const ready = queue.filter((job) => job.status === "ready");
  const nightFlagged = ready.filter((job) => job.night === true);
  const pool = nightFlagged.length > 0 ? nightFlagged : ready;

  const windowMinutes = windowLengthMinutes(ctx.window);
  return pool
    .map((job) => evaluate(job, ctx, windowMinutes))
    .sort((a, b) => a.candidate.risk - b.candidate.risk);
}
