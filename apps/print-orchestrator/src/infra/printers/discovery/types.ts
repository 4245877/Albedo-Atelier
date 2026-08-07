import type { DiscoveredFacts, Fact } from "../../../domain/printers/discovery";

/**
 * The adapter-facing side of hardware discovery.
 *
 * A discovery adapter answers one question — "what is this machine?" — and it
 * answers it the way the status adapters answer "what is it doing?": with only
 * what the device actually said. The shared rule is stated once here so each
 * protocol module is just its own field mapping.
 */

/** What one probe of one printer produced. */
export interface DiscoveryResult {
  /** Whether the probe reached the device at all. */
  succeeded: boolean;
  /**
   * Facts learned this time. Empty on failure — a failed probe must never
   * *erase* what an earlier one learned (a printer that is briefly offline has
   * not changed its bed size), so the service keeps the previous facts and only
   * records the failure. Merging is the service's job, not the adapter's.
   */
  facts: DiscoveredFacts;
  error: string | null;
}

export function failedDiscovery(error: string): DiscoveryResult {
  return { succeeded: false, facts: {}, error };
}

export function succeededDiscovery(facts: DiscoveredFacts): DiscoveryResult {
  return { succeeded: true, facts, error: null };
}

/** A fact the device itself stated, tagged with the wire field it came from. */
export function fromPrinter<T>(value: T, via: string): Fact<T> {
  return { value, source: "printer", via };
}

/** A fact derived from the identified model rather than read from the device. */
export function fromCatalog<T>(value: T, via = "справочник моделей"): Fact<T> {
  return { value, source: "catalog", via };
}
