import type { Automation } from "../../domain/dashboard/types";
import { NotFoundError } from "../../core/errors";
import { hhmm } from "../../shared/time";
import type { EventFeed } from "./eventFeed";
import type { PersistedAutomations } from "./stateStore";

/**
 * The built-in automation rules. This is a deliberately small, honest model:
 * every rule here maps to real service behaviour that its toggle actually
 * gates, so flipping a switch changes what the farm does — it is not a stub.
 *
 *  - `night-lights`  → the poller's night light schedule (see PrinterPoller).
 *  - `night-queue`   → the night-print suggestions in the dashboard read model.
 *
 * New rules are added here; their on/off state is persisted by id, so removing
 * or renaming a rule never corrupts the stored state (unknown ids are ignored).
 */
export interface AutomationRule {
  id: string;
  name: string;
  desc: string;
  defaultOn: boolean;
}

export const AUTOMATION_RULES: readonly AutomationRule[] = [
  {
    id: "night-lights",
    name: "Ночная подсветка по расписанию",
    desc: "Гасит свет днём и включает его в ночном окне на управляемых принтерах",
    defaultOn: true
  },
  {
    id: "night-queue",
    name: "Подсказки ночной печати",
    desc: "Подбирает из очереди безопасную деталь на ночь и оценивает риск",
    defaultOn: true
  }
] as const;

/**
 * Runtime state of the automation rules. The set of rules is fixed in code
 * (built-in behaviour toggles); only their on/off state and the last-run stamp
 * are persisted, so the state survives a restart while the rule catalogue stays
 * a single source of truth.
 */
export class AutomationStore {
  private readonly states = new Map<string, boolean>();
  private lastRun: string | null;

  constructor(
    initial: PersistedAutomations = { states: {}, lastRun: null },
    private readonly events?: EventFeed,
    private readonly persist: () => void = () => {}
  ) {
    for (const rule of AUTOMATION_RULES) {
      const stored = initial.states[rule.id];
      this.states.set(rule.id, typeof stored === "boolean" ? stored : rule.defaultOn);
    }
    this.lastRun = initial.lastRun ?? null;
  }

  /** True when a rule exists and is enabled. Unknown ids are treated as off. */
  isEnabled(id: string): boolean {
    return this.states.get(id) === true;
  }

  list(): Automation[] {
    return AUTOMATION_RULES.map((rule) => ({
      id: rule.id,
      name: rule.name,
      desc: rule.desc,
      on: this.isEnabled(rule.id)
    }));
  }

  getLastRun(): string | null {
    return this.lastRun;
  }

  /**
   * Flips a rule (or sets it explicitly when `on` is given). Records the change
   * in the feed, stamps the last-run time and persists. Throws for an unknown
   * rule id so the caller returns a real 404 instead of pretending it worked.
   */
  toggle(id: string, on?: boolean): Automation {
    const rule = AUTOMATION_RULES.find((candidate) => candidate.id === id);
    if (!rule) {
      throw new NotFoundError(`Automation "${id}"`);
    }

    const next = typeof on === "boolean" ? on : !this.isEnabled(id);
    this.states.set(id, next);
    this.lastRun = hhmm();
    this.events?.push(
      "✠",
      `Правило «${rule.name}» ${next ? "включено" : "выключено"} оператором`,
      "info"
    );
    this.persist();

    return { id: rule.id, name: rule.name, desc: rule.desc, on: next };
  }

  /** The durable projection: on/off state by id plus the last-run stamp. */
  serialize(): PersistedAutomations {
    return { states: Object.fromEntries(this.states), lastRun: this.lastRun };
  }
}
