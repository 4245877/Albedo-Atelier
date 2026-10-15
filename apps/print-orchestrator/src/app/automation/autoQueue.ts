import { AppError } from "../../core/errors";
import { assignmentHolds } from "../../domain/print/assignmentAuthority";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrintTask } from "../../domain/print/types";
import type { StoreLogger } from "../../shared/logger";
import type { LaunchService } from "../launch/launchService";
import type { QueueProjectionRow } from "../printQueue/projection";

/**
 * **Автоочередь — безопасный исполнитель очереди.**
 *
 * When a printer is free and the next queued job may run on it with nobody
 * pressing the button, this starts it. It is deliberately not a new way to
 * start a print: every start goes through {@link LaunchService.launch} — the
 * same preflight, delivery, final dispatch gate, idempotency and audit as the
 * operator's «Запустить» — in the dispatch policy's `auto` mode, which is at
 * least as strict as the night one:
 *
 *  - every open question (a `review`) is a refusal — there is nobody to answer
 *    it: an unrecorded bed, unreported material, unknown nozzle or size, an
 *    unapproved recipe, stale telemetry;
 *  - nothing is "confirmed" on anyone's behalf: no bed-clear tick, no material
 *    tick, no override;
 *  - the file must be provably the analysed one (content hash, verified upload
 *    — a printer that needs a manual file transfer is never auto-started);
 *  - the job itself must carry the operator's permission to run without them
 *    (`unattendedAllowed`), and its time preference is honoured (a night job
 *    only inside the night window and only if it fits; a day job only while an
 *    operator is on shift).
 *
 * **Off by default, twice.** The deployment switch (`AUTO_QUEUE_ENABLED`, off)
 * decides whether this module may start anything at all; the operator's
 * automation rule (`auto-queue`, off, persisted) arms it. Either one off — no
 * start, no timer doing anything but reporting why.
 *
 * **Double-send protection**, in depth: one tick at a time (in-process); ticks
 * serialised with the other queue dispatches (start-next, night start); at most
 * {@link AutoQueueConfig.maxStartsPerTick} starts per tick and never two on one
 * printer; an idempotency key per task version, so a repeated attempt returns
 * the first run instead of sending a second command; and below all of it the
 * database's own "one active run per printer and per task" and the durable start
 * guard the dispatch writes before any command leaves.
 *
 * **Recovery.** Nothing in-flight is kept in memory that a restart could lose:
 * a start whose outcome was lost is a run `PENDING`/`UNKNOWN` plus a start
 * guard, recovered by the lifecycle before the first tick (which waits
 * {@link AutoQueueConfig.startupDelayMs} for fresh telemetry). That printer is
 * refused by the policy until a person resolves it — and an automatic start
 * whose outcome is unknown **halts the executor** (the rule is switched off, a
 * persisted state), because "something I started may or may not be printing"
 * is not a state to keep starting things in.
 */

/** Deployment settings (`shared/config/automation.ts`). */
export interface AutoQueueConfig {
  /** `AUTO_QUEUE_ENABLED` — false: nothing here ever starts a print. */
  enabled: boolean;
  /** Pause between ticks. */
  intervalMs: number;
  /** Grace after boot before the first tick: recovery done, telemetry fresh. */
  startupDelayMs: number;
  /** Starts per tick, at most (never two on one printer). */
  maxStartsPerTick: number;
  /** How long a job the policy refused is left alone (unless it changes). */
  retryCooldownMs: number;
}

/** The automation rule that arms the executor (see `AutomationStore`). */
export const AUTO_QUEUE_RULE_ID = "auto-queue";
/** The actor every automatic start is audited under. */
export const AUTO_QUEUE_ACTOR = "auto-queue";

/** How many recent decisions the status keeps (in memory; the audit keeps the rest). */
const RECENT_LIMIT = 30;
/** How many queue rows a dry run explains. */
const PLAN_LIMIT = 20;

export type AutoDecisionOutcome =
  /** Started (or the start was accepted by the printer). */
  | "started"
  /** Not now — the policy names what stands in the way; nothing was attempted. */
  | "waiting"
  /** A start was attempted and refused before anything physical happened. */
  | "refused"
  /** An automatic start's outcome is unknown — the executor stopped itself. */
  | "halted"
  /** Not a candidate at all (no permission to run without an operator). */
  | "not_allowed"
  /** A dry run's answer: this would start now. */
  | "would_start";

export interface AutoDecision {
  at: string;
  taskId: string;
  title: string;
  outcome: AutoDecisionOutcome;
  printerId: string | null;
  printerName: string | null;
  /** Operator-facing: what happened, or what stands in the way. */
  message: string;
  /** The stable refusal code, when there is one. */
  code: string | null;
  runId: string | null;
}

export type AutoTickSkip = "not_configured" | "disarmed" | "busy" | "stopped";

export interface AutoTickResult {
  at: string;
  /** Why nothing was attempted at all; null when the queue was examined. */
  skipped: AutoTickSkip | null;
  started: number;
  decisions: AutoDecision[];
}

export interface AutoQueueStatus {
  /** The deployment switch. */
  configured: boolean;
  /** The operator's rule. */
  armed: boolean;
  /** A tick is in flight right now. */
  running: boolean;
  intervalMs: number;
  startupDelayMs: number;
  maxStartsPerTick: number;
  retryCooldownMs: number;
  /** When the timer was started (null: not running in this process). */
  startedAt: string | null;
  lastTickAt: string | null;
  lastResult: AutoTickResult | null;
  /** Recent starts, refusals and halts, newest first. */
  recent: AutoDecision[];
  /** Jobs the executor leaves alone for now, and why. */
  cooldowns: { taskId: string; until: string; reason: string }[];
  /** Why the executor last stopped itself, if it did. */
  haltedReason: string | null;
}

export interface AutoQueueDeps {
  config: AutoQueueConfig;
  /** The open queue store; null before it is opened (nothing to do yet). */
  store: () => PrintQueueStore | null;
  /** The open queue, ordered (the projection rows the launch list reads). */
  openQueue: () => QueueProjectionRow[];
  /** The launch workflow, built fresh per use (it joins live telemetry). */
  launch: () => LaunchService;
  /** Whether the operator has armed the rule. */
  isArmed: () => boolean;
  /** Switch the rule off — the circuit breaker; persisted, a restart does not re-arm. */
  disarm: (reason: string) => void;
  /** Serialise with the other queue dispatches (start-next, night start). */
  serialize: <T>(task: () => Promise<T>) => Promise<T>;
  /** Withdraw a placement (the executor's own, left by an attempt that did not start). */
  withdrawPlacement: (assignmentId: string, reason: string) => void;
  /** One line in the farm's event feed. */
  notify?: (kind: "ok" | "err" | "info", text: string) => void;
  logger?: StoreLogger;
  now?: () => Date;
}

interface Cooldown {
  /** The task version the refusal was about — a changed task is looked at again. */
  version: number;
  until: number;
  reason: string;
}

export class AutoQueueExecutor {
  private readonly now: () => Date;
  private logger: StoreLogger;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<AutoTickResult> | null = null;
  private stopped = false;
  private startedAt: string | null = null;
  private lastTickAt: string | null = null;
  private lastResult: AutoTickResult | null = null;
  private haltedReason: string | null = null;
  private readonly recent: AutoDecision[] = [];
  private readonly cooldowns = new Map<string, Cooldown>();

  constructor(private readonly deps: AutoQueueDeps) {
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? {};
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Starts the timer — only when the deployment allows the executor at all. The
   * first tick waits {@link AutoQueueConfig.startupDelayMs}: run recovery has
   * finished by then and the poller has fresh telemetry.
   */
  start(logger?: StoreLogger): void {
    if (logger) this.logger = logger;
    if (!this.deps.config.enabled || this.timer || this.stopped) return;
    this.startedAt = this.now().toISOString();
    this.schedule(this.deps.config.startupDelayMs);
    this.logger.info?.(
      {
        intervalMs: this.deps.config.intervalMs,
        maxStartsPerTick: this.deps.config.maxStartsPerTick,
        armed: this.deps.isArmed()
      },
      "auto-queue executor started (starts only while the «auto-queue» rule is on)"
    );
  }

  /** Stops the timer and waits for a tick in flight — call before the poller and the DB go. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick()
        .catch((error) => this.logger.warn?.({ err: error }, "auto-queue tick failed"))
        .finally(() => this.schedule(this.deps.config.intervalMs));
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  status(): AutoQueueStatus {
    const nowMs = this.now().getTime();
    return {
      configured: this.deps.config.enabled,
      armed: this.deps.isArmed(),
      running: this.inFlight !== null,
      intervalMs: this.deps.config.intervalMs,
      startupDelayMs: this.deps.config.startupDelayMs,
      maxStartsPerTick: this.deps.config.maxStartsPerTick,
      retryCooldownMs: this.deps.config.retryCooldownMs,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastResult: this.lastResult,
      recent: [...this.recent],
      cooldowns: [...this.cooldowns.entries()]
        .filter(([, c]) => c.until > nowMs)
        .map(([taskId, c]) => ({ taskId, until: new Date(c.until).toISOString(), reason: c.reason })),
      haltedReason: this.haltedReason
    };
  }

  /**
   * **Dry run**: what the executor would do right now, row by row — with no
   * side effect at all (no delivery, no reservation, no start). Answered even
   * when the executor is not configured or not armed, so the policy can be
   * checked before anyone switches it on.
   */
  plan(): AutoDecision[] {
    const store = this.deps.store();
    if (!store) return [];
    const at = this.now().toISOString();
    const launch = this.deps.launch();
    const used = new Set<string>();
    return this.queuedRows()
      .slice(0, PLAN_LIMIT)
      .map((row) => {
        const task = row.task;
        if (!task.unattendedAllowed) return notAllowed(at, task);
        const cooling = this.coolingFor(task, Date.parse(at));
        if (cooling) {
          return decision(
            at,
            task,
            "waiting",
            null,
            null,
            `пауза после отказа до ${new Date(cooling.until).toISOString()}: ${cooling.reason}`,
            "AUTO_COOLDOWN"
          );
        }
        const choice = this.choose(launch, store, task, used);
        if (!choice.printerId || choice.message) {
          return decision(at, task, "waiting", choice.printerId, choice.printerName, choice.message ?? "нет готового принтера", choice.code);
        }
        used.add(choice.printerId);
        return decision(at, task, "would_start", choice.printerId, choice.printerName, `запустилось бы на «${choice.printerName}»`, null);
      });
  }

  // ── The tick ────────────────────────────────────────────────────────────────

  /** One pass over the queue. Single-flight: a tick already running answers `busy`. */
  tick(): Promise<AutoTickResult> {
    const at = this.now().toISOString();
    if (this.stopped) return Promise.resolve(skip(at, "stopped"));
    if (!this.deps.config.enabled) return Promise.resolve(skip(at, "not_configured"));
    if (!this.deps.isArmed()) return Promise.resolve(skip(at, "disarmed"));
    if (this.inFlight) return Promise.resolve(skip(at, "busy"));
    const run = this.deps
      .serialize(() => this.examine(at))
      .then((result) => {
        this.lastTickAt = at;
        this.lastResult = result;
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private async examine(at: string): Promise<AutoTickResult> {
    const store = this.deps.store();
    const result: AutoTickResult = { at, skipped: null, started: 0, decisions: [] };
    if (!store) return result;
    // Re-checked inside the serialised section: the rule may have been switched
    // off (or tripped) while this tick waited for a manual dispatch to finish.
    if (!this.deps.isArmed()) return { ...result, skipped: "disarmed" };

    // An automatic start nobody has seen begin is the executor's own unknown:
    // stop starting anything until a person has looked.
    const unconfirmed = this.unconfirmedAutoRun(store);
    if (unconfirmed) {
      this.halt(unconfirmed);
      return { ...result, skipped: "disarmed" };
    }

    const used = new Set<string>();
    const nowMs = Date.parse(at);
    for (const row of this.queuedRows()) {
      if (result.started >= this.deps.config.maxStartsPerTick) break;
      if (!this.deps.isArmed()) break;
      const task = row.task;
      if (!task.unattendedAllowed) continue;
      if (this.coolingFor(task, nowMs)) continue;

      // Leftovers of an earlier attempt of ours that never started (a delivery
      // that did not verify, a restart mid-attempt) are withdrawn first: they are
      // not a person's decision and must not tie the job to that printer. Only
      // the tick does this — never the dry run, which is polled while a start of
      // ours may be mid-delivery and must not pull its placement from under it.
      this.withdrawOwnPlacements(store, task, "автоочередь: прежняя попытка не запустилась — размещение снято");
      const launch = this.deps.launch();
      const choice = this.choose(launch, store, task, used);
      if (!choice.printerId || choice.message) {
        result.decisions.push(
          decision(at, task, "waiting", choice.printerId, choice.printerName, choice.message ?? "нет готового принтера", choice.code)
        );
        continue;
      }
      used.add(choice.printerId);
      const outcome = await this.startOne(launch, store, task, choice.printerId, at);
      result.decisions.push(outcome);
      this.remember(outcome);
      if (outcome.outcome === "started") result.started += 1;
      if (outcome.outcome === "halted") break;
    }
    return result;
  }

  /** The cool-down standing for this task, if a refusal of THIS version is still recent. */
  private coolingFor(task: PrintTask, nowMs: number): Cooldown | null {
    const cooling = this.cooldowns.get(task.id);
    return cooling && cooling.version === task.version && cooling.until > nowMs ? cooling : null;
  }

  /** The open queue rows the executor may consider, in queue order. */
  private queuedRows(): QueueProjectionRow[] {
    return this.deps.openQueue().filter((row) => row.entry.state === "WAITING" && row.task.state === "QUEUED");
  }

  /**
   * The printer this job would start on, by the `auto` policy — or what stands
   * in the way (`message`). A job already placed (a manual placement or one under
   * the confirmed plan) goes to that printer or nowhere: the executor never
   * re-plans what a person decided.
   *
   * Read-only: shared by the tick and the dry run, so it must never write.
   */
  private choose(
    launch: LaunchService,
    store: PrintQueueStore,
    task: PrintTask,
    used: ReadonlySet<string>
  ): { printerId: string | null; printerName: string | null; message: string | null; code: string | null } {
    const placed = this.placedPrinter(store, task);
    const preview = launch.preview(task.id, placed ?? undefined, { mode: "auto" });
    const targetId = placed ?? preview.recommendedPrinterId;
    const candidate = targetId ? preview.candidates.find((c) => c.printerId === targetId) ?? null : null;
    if (!candidate || !candidate.eligible || !candidate.remoteStartSupported) {
      const problem = preview.primaryProblem;
      return {
        printerId: candidate?.printerId ?? null,
        printerName: candidate?.printerName ?? null,
        message: problem ? problem.title : candidate?.reason ?? "ни один принтер сейчас не может принять это задание",
        code: problem?.code ?? candidate?.blockers[0]?.code ?? null
      };
    }
    if (used.has(candidate.printerId)) {
      return {
        printerId: candidate.printerId,
        printerName: candidate.printerName,
        message: `«${candidate.printerName}» уже получил задание в этом проходе`,
        code: "PRINTER_TAKEN_THIS_TICK"
      };
    }
    return { printerId: candidate.printerId, printerName: candidate.printerName, message: null, code: null };
  }

  /**
   * The printer a person's live placement binds this task to, if any. The
   * executor's own earlier placement (an attempt refused after the placement,
   * e.g. a delivery that did not verify) is not a person's decision: it does not
   * tie the job to that printer — the next attempt may choose again, and the
   * launch withdraws the old placement when it does.
   */
  private placedPrinter(store: PrintQueueStore, task: PrintTask): string | null {
    const repos = store.repositories;
    const holding = repos.assignments
      .listByTask(task.id)
      .filter((a) => a.createdBy !== AUTO_QUEUE_ACTOR)
      .filter((a) => assignmentHolds(a, a.planId ? (repos.plans.getById(a.planId)?.state ?? null) : null));
    return holding.at(-1)?.printerId ?? null;
  }

  private async startOne(
    launch: LaunchService,
    store: PrintQueueStore,
    task: PrintTask,
    printerId: string,
    at: string
  ): Promise<AutoDecision> {
    // Per task VERSION: a retry of this very attempt returns its run; a job
    // re-queued after a definitive refusal (its version moved) is a new one.
    const idempotencyKey = `auto:${task.id}:v${task.version}`;
    try {
      const outcome = await launch.launch(task.id, {
        printerId,
        mode: "auto",
        actor: AUTO_QUEUE_ACTOR,
        idempotencyKey
      });
      this.cooldowns.delete(task.id);
      const accepted = outcome.run.phase === "accepted";
      this.deps.notify?.(
        "ok",
        accepted
          ? `Автоочередь: «${task.title}» отправлено на «${outcome.printerName}» — ждёт подтверждения начала`
          : `Автоочередь: «${task.title}» запущено на «${outcome.printerName}»`
      );
      return {
        ...decision(
          at,
          task,
          "started",
          outcome.printerId,
          outcome.printerName,
          accepted ? "команда принята принтером, ждём начала печати" : "печать началась",
          null
        ),
        runId: outcome.run.runId
      };
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "запуск не удался";
      // Did anything leave? A run still active for this task means the command
      // may have reached the printer — the one outcome no automation may guess.
      // Without one, nothing was started (a refusal before the send, or a
      // definitive rejection the dispatch has already unwound).
      const live = store.repositories.printRuns.findActiveByTask(task.id);
      if (live && (live.idempotencyKey === idempotencyKey || live.metadata.mode === "auto")) {
        const reason = `исход автоматического запуска «${task.title}» неизвестен (${message}) — проверьте принтер и отметьте, что произошло`;
        this.halt(reason);
        return { ...decision(at, task, "halted", printerId, null, reason, codeOf(error)), runId: live.id };
      }
      if (live) {
        // Somebody else's start of the same job got there first (the operator's
        // launch window): not an unknown of ours — nothing to stop for.
        return decision(at, task, "waiting", printerId, null, `задание уже запускается другим путём (${message})`, codeOf(error));
      }
      if (!(error instanceof AppError)) {
        this.logger.warn?.({ err: error, taskId: task.id }, "auto-queue start failed unexpectedly (nothing was started)");
      }
      this.withdrawOwnPlacements(store, task, `автоочередь: попытка не удалась — ${message}`);
      this.cooldowns.set(task.id, {
        version: store.repositories.tasks.getById(task.id)?.version ?? task.version,
        until: Date.parse(at) + this.deps.config.retryCooldownMs,
        reason: message
      });
      this.deps.notify?.("info", `Автоочередь: «${task.title}» не запущено — ${message}`);
      return decision(at, task, "refused", printerId, null, message, codeOf(error));
    }
  }

  /**
   * An automatic start the printer never confirmed (its outcome is lost): run
   * `UNKNOWN` and never seen printing. A print that DID start and then lost
   * its telemetry holds only its own printer — the policy refuses that one —
   * and does not stop the others.
   */
  private unconfirmedAutoRun(store: PrintQueueStore): string | null {
    const unconfirmed = (run: { state: string; startedAt: string | null; metadata: Record<string, unknown> } | null | undefined) =>
      Boolean(run && run.state === "UNKNOWN" && run.startedAt === null && run.metadata.mode === "auto");
    for (const row of this.deps.openQueue()) {
      if (!unconfirmed(row.run)) continue;
      return `автоматический запуск «${row.task.title}» не подтверждён принтером — проверьте принтер и отметьте исход`;
    }
    const repos = store.repositories;
    for (const task of repos.tasks.list({ states: ["DISPATCHING", "PRINTING"] })) {
      if (unconfirmed(repos.printRuns.findActiveByTask(task.id))) {
        return `автоматический запуск «${task.title}» не подтверждён принтером — проверьте принтер и отметьте исход`;
      }
    }
    return null;
  }

  /** Withdraw the placements this executor made for the task that no run is using. */
  private withdrawOwnPlacements(store: PrintQueueStore, task: PrintTask, reason: string): void {
    const repos = store.repositories;
    if (repos.printRuns.findActiveByTask(task.id)) return;
    for (const assignment of repos.assignments.listByTask(task.id)) {
      if (assignment.createdBy !== AUTO_QUEUE_ACTOR) continue;
      if (assignment.state !== "PROPOSED" || assignment.invalidatedAt !== null) continue;
      this.deps.withdrawPlacement(assignment.id, reason);
    }
  }

  /** The circuit breaker: switch the rule off (persisted) and say why, loudly. */
  private halt(reason: string): void {
    this.haltedReason = reason;
    this.deps.disarm(reason);
    this.deps.notify?.("err", `Автоочередь остановлена: ${reason}`);
    this.logger.warn?.({ reason }, "auto-queue halted");
  }

  private remember(entry: AutoDecision): void {
    this.recent.unshift(entry);
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
  }
}

function decision(
  at: string,
  task: PrintTask,
  outcome: AutoDecisionOutcome,
  printerId: string | null,
  printerName: string | null,
  message: string,
  code: string | null
): AutoDecision {
  return { at, taskId: task.id, title: task.title, outcome, printerId, printerName, message, code, runId: null };
}

function notAllowed(at: string, task: PrintTask): AutoDecision {
  return decision(
    at,
    task,
    "not_allowed",
    null,
    null,
    "нет разрешения печатать без оператора — автоочередь такое задание не трогает",
    "UNATTENDED_NOT_ALLOWED"
  );
}

function skip(at: string, reason: AutoTickSkip): AutoTickResult {
  return { at, skipped: reason, started: 0, decisions: [] };
}

function codeOf(error: unknown): string | null {
  if (error instanceof AppError) {
    const detail = error.details?.code;
    return typeof detail === "string" && detail ? detail : error.code;
  }
  return null;
}
