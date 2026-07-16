/**
 * How long one `POST /api/monitoring/lease` keeps the "operator is watching"
 * signal alive. The dashboard renews every ~30 s while its tab is visible, so
 * 90 s tolerates one lost renewal (plus timer jitter) before the lights are
 * handed back to the solar schedule. There is no explicit release: closing or
 * hiding the tab simply stops the renewals and the lease expires by itself.
 */
export const MONITORING_LEASE_TTL_MS = 90 * 1000;

/**
 * A single farm-wide lease of "active monitoring": while it is live, the light
 * policy keeps supported printers lit so the cameras show something. One lease
 * for the whole dashboard on purpose — the panel is one shared LAN screen, so
 * per-tab identifiers would add bookkeeping without changing the outcome
 * (any visible tab keeps the farm lit; renewals are idempotent).
 *
 * In-memory only: a backend restart forgets the lease, which is the safe
 * direction — the next visible dashboard tab re-establishes it within 30 s.
 */
export class MonitoringLease {
  private expiresAtMs = 0;

  constructor(
    private readonly ttlMs: number = MONITORING_LEASE_TTL_MS,
    private readonly nowMs: () => number = () => Date.now()
  ) {}

  /** Creates or extends the lease; repeated calls just move the expiry forward. */
  renew(): { expiresAt: Date; ttlMs: number } {
    this.expiresAtMs = this.nowMs() + this.ttlMs;
    return { expiresAt: new Date(this.expiresAtMs), ttlMs: this.ttlMs };
  }

  isActive(): boolean {
    return this.expiresAtMs > this.nowMs();
  }

  /** Current expiry while the lease is live; null once it has lapsed. */
  expiresAt(): Date | null {
    return this.isActive() ? new Date(this.expiresAtMs) : null;
  }
}
