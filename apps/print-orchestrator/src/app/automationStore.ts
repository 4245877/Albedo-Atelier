import type { Automation } from "../domain/dashboard/types";
import { JobError, NotFoundError } from "../core/errors";
import { hhmm } from "../shared/time";
import type { EventFeed } from "./eventFeed";
import type { PersistedAutomations } from "../infra/persistence/stateStore";

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
    name: "Подсветка по солнечному расписанию",
    desc: "Включает свет активным принтерам от заката до рассвета и на время открытой панели",
    defaultOn: true
  },
  {
    id: "night-queue",
    name: "Подсказки ночной печати",
    desc: "Подбирает из очереди безопасную деталь на ночь и оценивает риск",
    defaultOn: true
  },
  {
    // Off by default, and lockable: the deployment switch AUTO_QUEUE_ENABLED
    // decides whether it may be switched on at all (see `lockedReason`).
    id: "auto-queue",
    name: "Автоочередь",
    desc:
      "Сама запускает следующее задание на свободном принтере — только задания с разрешением печатать без оператора, " +
      "только по записанной очистке стола, известному материалу и проверенному файлу. Если исход запуска потерян — выключается сама",
    defaultOn: false
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
    private readonly persist: () => void = () => {},
    /**
     * Why a rule may not be switched on right now (a deployment switch is off),
     * or null. A locked rule can still be switched OFF — only enabling is refused.
     */
    private readonly lockedReason: (id: string) => string | null = () => null
  ) {
    for (const rule of AUTOMATION_RULES) {
      const stored = initial.states[rule.id];
      this.states.set(rule.id, typeof stored === "boolean" ? stored : rule.defaultOn);
    }
    this.lastRun = initial.lastRun ?? null;
  }

  /**
   * True when a rule exists and is enabled — and is not locked: a rule its
   * deployment switch forbids counts as off even if it was stored on earlier.
   */
  isEnabled(id: string): boolean {
    return this.states.get(id) === true && this.lockedReason(id) === null;
  }

  list(): Automation[] {
    return AUTOMATION_RULES.map((rule) => {
      const locked = this.lockedReason(rule.id);
      return {
        id: rule.id,
        name: rule.name,
        desc: rule.desc,
        on: this.isEnabled(rule.id),
        ...(locked ? { locked } : {})
      };
    });
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
    const locked = this.lockedReason(id);
    if (next && locked) {
      throw new JobError(`Правило «${rule.name}» нельзя включить: ${locked}`, { code: "AUTOMATION_LOCKED" });
    }
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

  /**
   * The circuit breaker: an automation switches ITSELF off, with the reason in
   * the feed. Persisted — a restart does not re-arm what tripped; a person does.
   */
  disarm(id: string, reason: string): void {
    const rule = AUTOMATION_RULES.find((candidate) => candidate.id === id);
    if (!rule || this.states.get(id) !== true) return;
    this.states.set(id, false);
    this.lastRun = hhmm();
    this.events?.push("✠", `Правило «${rule.name}» выключено автоматически: ${reason}`, "err");
    this.persist();
  }

  /** The durable projection: on/off state by id plus the last-run stamp. */
  serialize(): PersistedAutomations {
    return { states: Object.fromEntries(this.states), lastRun: this.lastRun };
  }
}
