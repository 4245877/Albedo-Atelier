import type {
  MaterialLoadedReel,
  MaterialQueueNeed,
  MaterialStock,
  MaterialsSection,
  MaterialsSource,
  QueueJob
} from "../../domain/dashboard/types";
import type { PrinterConfig } from "../../infra/printers/config";
import type { FilamentStockView } from "../filamentStock";
import { materialsIncompatible } from "../nightPlanner";

/**
 * Representative hex for the colour keys fulfillment stores, so the board can
 * draw a swatch. Mirrors fulfillment's own `NAMED_COLOR_RGB` table (the one it
 * matches device reel hints against) — kept in the same vocabulary on purpose:
 * a colour either side can name must not turn into a grey blob here.
 *
 * A value fulfillment stored as a hex passes through untouched; anything else
 * falls back to a neutral swatch rather than to an arbitrary colour, because a
 * WRONG colour on a spool chip is worse than an obviously unknown one.
 */
const COLOR_HEX: Record<string, string> = {
  black: "#26262b",
  white: "#f2f0ea",
  gray: "#8b8b93",
  grey: "#8b8b93",
  silver: "#c0c0c0",
  red: "#d24b4b",
  blue: "#4b7fd2",
  green: "#4f9d5d",
  yellow: "#e0c04a",
  orange: "#e08a3c",
  purple: "#8a5cc4",
  pink: "#e2a5bb",
  brown: "#8b4513",
  transparent: "#9fb3c8",
  clear: "#9fb3c8",
  gold: "#c9a227",
  bronze: "#a97142",
  natural: "#e6ddc8"
};

const NEUTRAL_SWATCH = "#6f6f78";

/** CSS colour for a warehouse colour key: a stored hex, a known name, else neutral. */
export function swatchFor(color: string): string {
  const raw = color.trim().toLowerCase();
  if (!raw) return NEUTRAL_SWATCH;
  if (/^#?[0-9a-f]{6}$/.test(raw)) return raw.startsWith("#") ? raw : `#${raw}`;
  return COLOR_HEX[raw] ?? NEUTRAL_SWATCH;
}

/** Grams → kilograms with two decimals; the unit the material card displays. */
function toKg(grams: number): number {
  return Math.round(grams / 10) / 100;
}

/** "340 г" under a kilo, "9.5 кг" above it — the way an operator says it. */
export function formatGrams(grams: number): string {
  const rounded = Math.round(grams);
  if (rounded < 1000) return `${rounded} г`;
  return `${(Math.round(rounded / 100) / 10).toFixed(1)} кг`;
}

/** "AMS-слот 1", or null for the single printer-level reel. */
function slotLabel(amsTray: number | null): string | null {
  return amsTray === null ? null : `AMS-слот ${amsTray}`;
}

export interface MaterialsDeps {
  /** The last warehouse answer plus its provenance (see FilamentStock). */
  stock: FilamentStockView;
  /** The operator queue as the board shows it. */
  queue: QueueJob[];
  /** Resolves a queue job's free-text printer field to a config (by id or name). */
  resolvePrinter: (reference: string) => PrinterConfig | undefined;
  /** The farm's enabled printers, for naming the reel bindings. */
  printers: PrinterConfig[];
}

/**
 * Projects the fulfillment warehouse + the local queue into the «Материалы»
 * card. Pure: explicit inputs, no I/O, no clock.
 *
 * Everything shown here is either measured by fulfillment (balances, thresholds,
 * reel bindings) or measured locally (the queue's per-job filament estimates).
 * Nothing is invented — in particular:
 *
 *  - resin stays empty because fulfillment tracks no resin; an empty list is the
 *    honest answer, not a zeroed-out fake column;
 *  - a position's level bar is scaled against the position's OWN low-stock
 *    threshold, and its colour comes from the warehouse's `status`, so atelier
 *    never second-guesses thresholds it does not own;
 *  - queue demand counts only jobs whose filament weight was actually measured,
 *    and says out loud how many were not.
 */
export function buildMaterials(deps: MaterialsDeps): MaterialsSection {
  const { stock, queue } = deps;

  const filament: MaterialStock[] = stock.positions.map((position) => ({
    name: position.label,
    swatch: swatchFor(position.color),
    have: toKg(position.stockG),
    unit: "кг",
    full: toKg(position.lowStockG),
    low: position.status !== "ok",
    status: position.status,
    grams: Math.round(position.stockG)
  }));

  return {
    filament,
    // fulfillment's warehouse is filament-only (its summary reports resinL: 0
    // because nothing feeds it). An empty list renders as "no resin tracked",
    // which is true; a zeroed row would read as "we have no resin", which is not.
    resin: [],
    mismatch: buildMismatch(deps),
    queueNeeds: buildQueueNeeds(deps),
    loaded: buildLoadedReels(deps),
    source: buildSource(stock)
  };
}

function buildSource(stock: FilamentStockView): MaterialsSource {
  return {
    kind: stock.connected ? "fulfillment" : "none",
    ok: stock.ok,
    pending: stock.pending,
    stale: stock.stale,
    updatedAt: stock.fetchedAt,
    error: stock.error
  };
}

/**
 * Contradictions between a queued job's declared material and its target
 * printer's declared load — the same check that blocks night starts and
 * start-next. Local knowledge, unrelated to the warehouse, so it survives a
 * fulfillment outage.
 */
function buildMismatch(deps: MaterialsDeps): MaterialsSection["mismatch"] {
  const mismatch: MaterialsSection["mismatch"] = [];
  for (const job of deps.queue) {
    if (job.status !== "ready") continue;
    const printer = deps.resolvePrinter(job.printer);
    if (!printer) continue;
    if (materialsIncompatible(job.material, printer.material)) {
      mismatch.push({
        job: job.title,
        needs: job.material,
        printer: printer.name,
        loaded: printer.material
      });
    }
  }
  return mismatch;
}

/**
 * What the queue will draw from the shelf, per material.
 *
 * Only `ready` jobs count — a job still in review or awaiting an operator's
 * verdict is not committed demand. Jobs are grouped by material and matched
 * against the SUM of that material's positions across colours: the queue names
 * a material, never a colour, so a per-colour claim would be made up.
 *
 * Unmeasured jobs are counted separately and stated, because "нужно 340 г" is a
 * dangerous half-truth when three more jobs of that material carry no estimate.
 * A material with demand and no matching position is a warning in its own right
 * — that is the case the operator most needs to see before the night run.
 */
function buildQueueNeeds(deps: MaterialsDeps): MaterialQueueNeed[] {
  const { stock } = deps;
  const demand = new Map<string, { label: string; grams: number; unmeasured: number }>();

  for (const job of deps.queue) {
    if (job.status !== "ready") continue;
    const label = job.material.trim();
    const key = label.toLowerCase();
    if (!key || key === "—") continue;
    const entry = demand.get(key) ?? { label, grams: 0, unmeasured: 0 };
    if (typeof job.filamentG === "number" && Number.isFinite(job.filamentG)) {
      entry.grams += Math.max(0, job.filamentG);
    } else {
      entry.unmeasured += 1;
    }
    demand.set(key, entry);
  }

  const needs: MaterialQueueNeed[] = [];
  for (const entry of demand.values()) {
    const positions = stock.positions.filter(
      (position) => position.material.toLowerCase() === entry.label.toLowerCase()
    );
    const availableG = positions.reduce((sum, position) => sum + position.stockG, 0);

    const wantText = entry.grams > 0 ? `нужно ${formatGrams(entry.grams)}` : "объём не измерен";
    const unmeasuredText =
      entry.unmeasured > 0 ? ` (+${entry.unmeasured} без оценки)` : "";

    // With no readable warehouse there is nothing to compare against: report the
    // demand alone rather than claiming a shortage (or an all-clear) we cannot know.
    if (!stock.ok) {
      needs.push({ text: `${entry.label} — ${wantText}${unmeasuredText}`, status: "ok" });
      continue;
    }

    if (positions.length === 0) {
      needs.push({
        text: `${entry.label} — ${wantText}${unmeasuredText}, позиции на складе нет`,
        status: "warn"
      });
      continue;
    }

    const short = entry.grams > availableG;
    needs.push({
      text: `${entry.label} — ${wantText}${unmeasuredText}, на складе ${formatGrams(availableG)}`,
      status: short ? "warn" : "ok"
    });
  }

  return needs.sort((a, b) => a.text.localeCompare(b.text, "ru"));
}

/**
 * The reels the warehouse has bound to this farm's printers. Bindings for a
 * printer atelier does not (or no longer) has are dropped: fulfillment keeps
 * them as a historical record of what was loaded, but on the farm's own board
 * they would name a machine the operator cannot see.
 */
function buildLoadedReels(deps: MaterialsDeps): MaterialLoadedReel[] {
  const byId = new Map(deps.printers.map((printer) => [printer.id, printer]));
  return deps.stock.reels
    .filter((reel) => byId.has(reel.printerId))
    .map((reel) => {
      const position = deps.stock.positions.find((entry) => entry.id === reel.stockId);
      return {
        printer: byId.get(reel.printerId)?.name ?? reel.printerName ?? reel.printerId,
        slot: slotLabel(reel.amsTray),
        material: reel.material,
        // The warehouse position knows the localized colour name; the binding
        // itself carries only the raw key, so fall back to that.
        colorName: position?.colorName ?? reel.color,
        swatch: swatchFor(reel.color),
        updatedAt: reel.updatedAt
      };
    })
    .sort((a, b) => a.printer.localeCompare(b.printer, "ru") || (a.slot ?? "").localeCompare(b.slot ?? ""));
}
