import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  canonicalFactsJson,
  type DiscoveredFacts,
  type PrinterDiscoveryRecord
} from "../../domain/printers/discovery";
import type { PrinterConfig } from "../../infra/printers/config";
import { discoverPrinterSpecs, type DiscoveryResult } from "../../infra/printers/discovery";
import type { StoreLogger } from "../../shared/logger";

/**
 * Keeps each printer's hardware profile current from the printer itself.
 *
 * The operator-facing promise is «подключил принтер — карточка заполнилась
 * сама», and that has two halves: learn the specification once on connect, and
 * notice when it changes. This service owns both, plus the three rules that keep
 * a background probe from being a nuisance:
 *
 *  - **a failed probe never erases what was learned.** A printer that is offline
 *    for ten minutes has not changed its bed size; blanking the card over a
 *    network blip would lose real information and look like a hardware fault.
 *    The failure is recorded, the facts stay;
 *  - **an unchanged probe never writes.** Facts are compared canonically, so the
 *    common case — nothing changed since five minutes ago — touches no row and
 *    bumps no version;
 *  - **it can never break the poll loop.** {@link refreshDue} is the entry point
 *    the poller calls, and it swallows everything: discovery is an enrichment,
 *    and telemetry, lights and filament accounting must not depend on it.
 *
 * Probing is read-only — it asks a device to describe itself and sends no
 * command — so it is safe to run against a printer that is mid-print.
 */

export interface PrinterDiscoveryServiceOptions {
  now?: () => Date;
  logger?: StoreLogger;
  /**
   * How stale a result may be before the background pass re-probes it. Short by
   * design: Bambu answers from the MQTT cache with no I/O at all, and Moonraker
   * costs three small LAN requests.
   */
  intervalMs?: number;
  /** Injected in tests so a probe never touches a real device. */
  probe?: (printer: PrinterConfig) => Promise<DiscoveryResult>;
}

const DEFAULT_INTERVAL_MS = 300_000;

export class PrinterDiscoveryService {
  private readonly nowFn: () => Date;
  private logger: StoreLogger;
  private readonly intervalMs: number;
  private readonly probe: (printer: PrinterConfig) => Promise<DiscoveryResult>;
  /**
   * The probe currently running per printer. Callers join it instead of starting
   * a second one — a Bambu can take seconds to answer, and the background pass,
   * a config change and the operator's own button can easily overlap.
   */
  private readonly inFlight = new Map<string, Promise<PrinterDiscoveryRecord | null>>();

  constructor(
    private readonly store: PrintQueueStore,
    options: PrinterDiscoveryServiceOptions = {}
  ) {
    this.nowFn = options.now ?? (() => new Date());
    this.logger = options.logger ?? {};
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.probe = options.probe ?? discoverPrinterSpecs;
  }

  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** One printer's stored discovery result, or null when it has never been probed. */
  get(printerId: string): PrinterDiscoveryRecord | null {
    return this.store.repositories.printerDiscovery.getById(printerId);
  }

  /** Every stored result, keyed by printer id — for projections over the whole farm. */
  all(): Map<string, PrinterDiscoveryRecord> {
    return new Map(
      this.store.repositories.printerDiscovery.list().map((record) => [record.id, record])
    );
  }

  // ── Probing ────────────────────────────────────────────────────────────────

  /**
   * Probes the device now and stores the result, whatever the age of the last
   * one. This is the explicit «Опросить принтер» button, and the refresh run
   * after a printer is created or re-addressed.
   *
   * A probe already in flight is *joined*, not skipped: the caller asked what
   * the device says, so it gets that answer rather than whatever happened to be
   * on disk before the running probe finishes.
   */
  refresh(printer: PrinterConfig): Promise<PrinterDiscoveryRecord | null> {
    const running = this.inFlight.get(printer.id);
    if (running) return running;

    const probe = this.probe(printer)
      .then((result) => this.persist(printer, result))
      .finally(() => this.inFlight.delete(printer.id));

    this.inFlight.set(printer.id, probe);
    return probe;
  }

  /**
   * Probes only the printers whose result is older than the interval. Called
   * from the poll loop; **never throws and never rejects** — a discovery failure
   * must not disturb telemetry.
   */
  async refreshDue(printers: readonly PrinterConfig[]): Promise<void> {
    const due = printers.filter((printer) => this.isDue(printer.id));
    if (due.length === 0) return;

    await Promise.all(
      due.map(async (printer) => {
        try {
          await this.refresh(printer);
        } catch (error) {
          this.logger.warn?.(
            { err: error, printer: printer.id },
            "printer discovery probe failed"
          );
        }
      })
    );
  }

  /** Forgets a removed printer's result (the FK cascade covers the row itself). */
  forget(printerId: string): void {
    this.inFlight.delete(printerId);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private isDue(printerId: string): boolean {
    const existing = this.get(printerId);
    if (!existing) return true;

    const probedAt = Date.parse(existing.probedAt);
    if (!Number.isFinite(probedAt)) return true;
    return this.nowFn().getTime() - probedAt >= this.intervalMs;
  }

  /**
   * Writes the probe outcome, merging over what was already known.
   *
   * A successful probe replaces the fact set wholesale rather than merging field
   * by field: facts that disappear from a device's report have genuinely stopped
   * being true (an AMS was unplugged, a nozzle field vanished after a firmware
   * change), and carrying them forever would make the card describe a machine
   * that no longer exists. A *failed* probe is the opposite case and keeps them.
   */
  private persist(printer: PrinterConfig, result: DiscoveryResult): PrinterDiscoveryRecord | null {
    const existing = this.get(printer.id);
    const probedAt = this.nowFn().toISOString();
    const facts: DiscoveredFacts = result.succeeded ? result.facts : (existing?.facts ?? {});

    const factsChanged =
      canonicalFactsJson(facts) !== canonicalFactsJson(existing?.facts ?? {});
    const statusChanged =
      existing?.succeeded !== result.succeeded ||
      existing?.error !== result.error ||
      existing?.protocol !== printer.protocol;

    // Nothing new to say: skip the write entirely so a five-minute probe of an
    // unchanging farm costs no disk churn and no version bumps.
    if (existing && !factsChanged && !statusChanged) return existing;

    const next: PrinterDiscoveryRecord = {
      id: printer.id,
      protocol: printer.protocol,
      facts,
      probedAt,
      succeeded: result.succeeded,
      error: result.error,
      version: existing?.version ?? 1
    };

    const written = this.store.transaction(() =>
      existing
        ? this.store.repositories.printerDiscovery.update(next)
        : this.store.repositories.printerDiscovery.insert(next)
    );

    if (factsChanged) {
      this.logger.info?.(
        { printer: printer.id, protocol: printer.protocol, succeeded: result.succeeded },
        "printer hardware profile updated from the device"
      );
    }
    return written;
  }
}
