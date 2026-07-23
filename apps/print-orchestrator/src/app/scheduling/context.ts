import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  DEFAULT_COMPATIBILITY_CONFIG,
  type CompatibilityConfig
} from "../../domain/scheduling/compatibility";
import { recordAuditEvent, type AuditInput } from "../audit";
import type { SchedulerConfig, SchedulerPrinterRef } from "./types";

/**
 * Shared collaborator state for the scheduler use cases (evidence resolution,
 * planning, night queries): the store, the live printer source, the config and
 * the audit sink. Not exported outside `app/scheduling`.
 */
export class SchedulerContext {
  readonly compatibilityConfig: CompatibilityConfig;

  constructor(
    readonly store: PrintQueueStore,
    readonly listPrinters: () => SchedulerPrinterRef[],
    readonly config: SchedulerConfig
  ) {
    this.compatibilityConfig = config.compatibility ?? DEFAULT_COMPATIBILITY_CONFIG;
  }

  get actor(): string {
    return this.config.actor ?? "operator";
  }

  nowIso(): string {
    return this.config.now().toISOString();
  }

  recordAudit(input: AuditInput): void {
    recordAuditEvent(this.store, () => this.nowIso(), this.actor, input);
  }
}
