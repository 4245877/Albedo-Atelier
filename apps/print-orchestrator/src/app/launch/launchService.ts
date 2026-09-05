import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import {
  selectLaunchPrinter,
  type DeviceFileState,
  type LaunchCandidate,
  type LaunchCandidateInput,
  type LaunchReason
} from "../../domain/launch/selection";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { Assignment, PrintTask } from "../../domain/print/types";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { NON_OVERRIDABLE, type EligibilityReason } from "../../domain/dispatch/reasons";
import type { DispatchEligibility } from "../../domain/dispatch/eligibility";
import type { PrinterConfig } from "../../infra/printers/config";
import { capabilitiesOf } from "../../infra/printers/capabilities";
import type { DeviceArtifactService } from "../dispatch/deviceArtifactService";
import type { DispatchResult, DispatchService } from "../dispatch/dispatchService";
import type { RunLifecycleService } from "../dispatch/runLifecycle";
import type { ManualOperationService } from "../operations/manualOperationService";
import type { PrintQueueService } from "../printQueue/printQueueService";
import { formatEta } from "../printQueue/projection";
import type { SchedulerService } from "../scheduling/schedulerService";
import { remainingBlockers } from "../dispatch/dispatchGate";
import { explainLaunchFailure, primaryProblem, type LaunchProblem } from "./problems";

/**
 * The **one** operation behind the "Запустить печать" button.
 *
 * Everything between "the operator chose a job" and "the printer is running it"
 * — picking a printer, uploading the plate package, confirming the bed, sending
 * the start — used to be separate endpoints the UI had to orchestrate in the
 * right order, and the UI did not. The queue button called a dispatch that
 * assumed the file was already delivered; delivering it meant finding the
 * assignment in the slicing screen; and the transport package could only be
 * launched by hunting for it in the printer's file browser. Each step worked;
 * the sequence existed nowhere.
 *
 * It lives here so the sequence is a single audited transaction-of-intent with
 * one idempotency key, rather than a workflow reconstructed by a browser. Two
 * calls make up the whole surface:
 *
 *   - {@link preview} — what would happen, what is missing, which printer and
 *     why. Pure reads: it never uploads, reserves or starts anything.
 *   - {@link launch} — do it, in order, with the operator's confirmations.
 *
 * It adds **no** admission rules of its own. Every refusal comes from the one
 * policy — `evaluateDispatchEligibility` — and this service only decides *when*
 * to ask it, in three stages:
 *
 *   **A · preflight** (no side effects). Everything knowable before a byte
 *   moves: printer state and class, the file's declared target and flavor, build
 *   volume, nozzle, material, bed, manual operations, remote-start capability,
 *   queue shape, reservation, telemetry freshness. Run in {@link preview}, and
 *   run *again* at the top of {@link launch} against freshly-read rows.
 *
 *   **B · delivery.** Only after A passes: assign the printer, resolve the
 *   remote name, push the file, verify what landed.
 *
 *   **C · final dispatch gate.** Inside `DispatchService`'s own transaction: A's
 *   rules plus the ones that only became answerable now — the file exists, under
 *   the expected name, at the expected size, tracked by this delivery, on a
 *   printer whose state did not change during the transfer. Only then the start.
 *
 * The property this buys: a refusal after the file has been uploaded can only be
 * caused by something that *changed*, never by something that was already true
 * when the operator was shown a green preview. The old shape — preview on
 * `evaluateCompatibility`, enforcement on the full gate — guaranteed the
 * opposite for whole classes of job (a G-code sliced for another printer among
 * them).
 */

/** A physical fact only a human can assert, surfaced as a checkbox before start. */
export type LaunchConfirmationKey = "bed_clear" | "material_loaded";

export interface LaunchConfirmation {
  code: LaunchConfirmationKey;
  /** What the operator is agreeing to. */
  label: string;
  detail: string;
  /** True when the launch is refused without it. */
  required: boolean;
  /** What ticking it actually causes the server to do — never left to guess. */
  effect: string;
}

/**
 * Eligibility codes a **tick resolves by causing a real server-side action**,
 * as opposed to ones an operator merely accepts responsibility for.
 *
 * The distinction is load-bearing and was previously invisible. `BED_STATE_UNKNOWN`
 * is in `NON_OVERRIDABLE` — no amount of accepting responsibility clears it —
 * and yet it is exactly the thing a person standing at the machine can settle,
 * because confirming it makes the launch write a real `CLEAR` bed cycle, which
 * the gate then reads as evidence. So it is neither a hard blocker (there IS a
 * way through) nor an override (nothing is being waived): it is a confirmation
 * with an effect, and the screen must say what the effect is.
 */
const CONFIRMATION_FOR_CODE: Readonly<Record<string, LaunchConfirmationKey>> = {
  BED_STATE_UNKNOWN: "bed_clear",
  BED_NOT_CLEAR: "bed_clear",
  OPERATOR_INTERVENTION_REQUIRED: "bed_clear",
  MATERIAL_UNKNOWN: "material_loaded"
};

/**
 * Bed states a `bed_clear` tick genuinely resolves.
 *
 * `BED_NOT_CLEAR` is emitted for three different situations, and only one of
 * them is a question for the person at the machine. `AWAITING_CLEARANCE` means a
 * finished part is on the plate — that is exactly what an operator removes, and
 * confirming it writes the `CLEAR` cycle the gate then reads. `RESERVED` and
 * `RUNNING` mean *another job holds this plate*, and `RunLifecycleService.clearBed`
 * refuses them outright («стол занят активной печатью»).
 *
 * Attaching the confirmation to those two was wrong twice over: it moved a hard
 * blocker into the confirmable bucket, so a printer whose plate was held by a
 * live job counted as `eligible` and could be auto-recommended; and it put a tick
 * on screen whose only possible outcome was the launch throwing when the server
 * tried to honour it. An unknown bed keeps its confirmation — nobody else holds
 * that plate, and looking at it is precisely how the unknown is resolved.
 */
const CONFIRMABLE_BED_STATES: ReadonlySet<string> = new Set(["AWAITING_CLEARANCE"]);

/** Where a task stands on the road from "prepared" to "printing". */
export type LaunchState =
  /** The artifact is still being analysed/sliced — nothing to launch yet. */
  | "preparing"
  /** A printer is available and every physical precondition is already satisfied. */
  | "ready"
  /** Startable, but a human must confirm something physical first. */
  | "needs_confirmation"
  /** No printer can run this right now, and no confirmation would change that. */
  | "blocked"
  /** A run for this task is already live. */
  | "running"
  /**
   * A start was dispatched and the printer never confirmed it.
   *
   * Deliberately not folded into `running`: the task genuinely was not printing,
   * and calling it "running" is the specific lie that let an operator watch an
   * idle machine while the UI insisted a job was under way. It is also not
   * `blocked`, because the obstacle is a question this operator can answer.
   */
  | "unconfirmed";

export interface LaunchCandidateView extends LaunchCandidate {
  /** Operator-facing rendering of the blockers/reviews/warnings. */
  problems: LaunchProblem[];
}

export interface LaunchPreview {
  taskId: string;
  title: string;
  /** Title without the source extension — what the operator called the model. */
  displayTitle: string;
  state: LaunchState;
  material: string | null;
  nozzleMm: number | null;
  etaSeconds: number | null;
  etaText: string | null;
  filamentG: number | null;
  /** Where the material fact came from, so the UI can say "внешняя катушка". */
  materialSource: "ams" | "external" | "unknown";
  recommendedPrinterId: string | null;
  /** How many *other* printers could also take this job right now. */
  alternativeCount: number;
  /** The printer this preview is actually about (chosen or recommended). */
  selectedPrinterId: string | null;
  /** Whether {@link selectedPrinterId} was picked by the server or by the operator. */
  selectionSource: "auto" | "manual" | "none";
  /**
   * One sentence explaining the choice — «единственный доступный», «выбран
   * автоматически: … Ещё 2 подходят», «Принтер выбран вручную», or, when nothing
   * is startable, the invitation to read the per-printer reasons rather than a
   * bare "нет готового принтера".
   */
  selectionNote: string;
  candidates: LaunchCandidateView[];
  /** Confirmations required for the recommended printer (or the one asked about). */
  confirmations: LaunchConfirmation[];
  /** The live run holding this task, when one exists. */
  activeRunId: string | null;
  /**
   * The single problem to show as *the* reason the launch is refused, or null.
   * Always one of the focused candidate's own `problems`, so the headline the
   * operator reads and the diagnostics list behind it are the same data.
   */
  primaryProblem: LaunchProblem | null;
  /**
   * The run whose outcome is still unresolved and is holding this task, when
   * there is one. The UI turns it into the "отметьте, что произошло" action, so
   * the way out of a failed attempt is where the attempt failed.
   */
  unresolvedRunId: string | null;
}

/**
 * The launch answer for one queue row — enough for a button label and a sentence,
 * never enough to decide anything client-side.
 */
export interface QueueLaunchReadiness {
  taskId: string;
  state: LaunchState;
  /** One sentence naming the printer and what stands in the way, if anything. */
  summary: string;
  /** The printer the launch would use, or the one whose refusal is reported. */
  printerId: string | null;
  printerName: string | null;
  /** True when the launch dialog can lead to a start right now. */
  canLaunch: boolean;
  /** True when a physical confirmation is the only thing missing. */
  needsConfirmation: boolean;
  /** How many *other* printers could also take it. */
  alternativeCount: number;
  /** The refusal to headline when `canLaunch` is false. */
  primaryProblem: LaunchProblem | null;
}

export interface LaunchRequest {
  /** Explicit operator choice; omitted means "use the recommendation". */
  printerId?: string;
  /** Confirmation codes the operator ticked. */
  confirmations?: string[];
  /**
   * An explicit, audited decision to proceed despite **overridable** warnings —
   * the `review` verdict's way out.
   *
   * The dispatch layer has always had this mechanism, with its own validation
   * (a reason and an operator are mandatory) and its own audit entry. The launch
   * path simply never passed it, so a task the gate marked `review` had no
   * confirmation path in the only UI that starts prints: the operator saw a
   * refusal listing things a human could vouch for, and no way to vouch for
   * them.
   *
   * It can never clear a hard blocker. `NON_OVERRIDABLE` — an occupied bed, a
   * file that is not the one verified, a part off the plate, a device fault, an
   * unconfirmed previous launch — is enforced inside the dispatch gate, which
   * this only forwards to.
   */
  override?: { codes: string[]; reason: string };
  /** Retry-safe key: the same key never starts a second print. */
  idempotencyKey?: string;
  actor?: string;
}

export interface LaunchOutcome {
  run: DispatchResult;
  printerId: string;
  printerName: string;
  /** Steps actually performed, for the audit trail and the UI's progress copy. */
  steps: string[];
}

export interface LaunchServiceDeps {
  store: PrintQueueStore;
  printQueue: PrintQueueService;
  scheduler: SchedulerService;
  deviceArtifacts: DeviceArtifactService;
  dispatch: () => DispatchService | null;
  runLifecycle: () => RunLifecycleService | null;
  manualOperations: ManualOperationService;
  resolvePrinter: (id: string) => PrinterConfig | undefined;
  automaticContinuationAllowed: (printerId: string) => boolean;
}

/**
 * How many queue rows {@link LaunchService.queueReadiness} answers for by
 * default. Comfortably more than the dashboard renders (8) so scrolling and the
 * planner's own list are covered, and far short of a backlog.
 */
const DEFAULT_READINESS_ROWS = 25;

export class LaunchService {
  constructor(private readonly deps: LaunchServiceDeps) {}

  // ── Preview ────────────────────────────────────────────────────────────────

  preview(taskId: string, forPrinterId?: string): LaunchPreview {
    const task = this.requireTask(taskId);
    const repos = this.deps.store.repositories;
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;
    const assignment = this.liveAssignment(task.id);
    const binding = assignment?.binding ?? null;

    const material = binding?.material ?? task.material ?? analysis?.material ?? null;
    const nozzleMm = binding?.nozzleMm ?? analysis?.nozzleDiameterMm ?? null;
    const etaSeconds = binding?.etaS ?? analysis?.estimatedDurationS ?? null;

    const candidates = this.buildCandidates(task, material, nozzleMm);
    const {
      candidates: ranked,
      recommendedPrinterId,
      alternativeCount,
      recommendation
    } = selectLaunchPrinter(candidates);
    const views: LaunchCandidateView[] = ranked.map((c) => ({
      ...c,
      problems: explainLaunchFailure(c)
    }));

    const activeRun = repos.printRuns.findActiveByTask(task.id);
    // An explicit `?printer=` is the operator overruling the recommendation. The
    // distinction has to survive to the UI: showing the *automatic* choice's
    // explanation next to a printer the operator picked themselves is the one
    // sentence guaranteed to be about a different machine.
    const manuallySelected = Boolean(forPrinterId) && forPrinterId !== recommendedPrinterId;
    const focusId = forPrinterId ?? recommendedPrinterId;
    const focus = views.find((c) => c.printerId === focusId) ?? null;

    return {
      taskId: task.id,
      title: task.title,
      displayTitle: stripExtension(task.title),
      state: this.resolveState(task, views, recommendedPrinterId, activeRun, focus, material),
      material,
      nozzleMm,
      etaSeconds,
      etaText: formatEta(etaSeconds),
      filamentG: analysis?.estimatedFilamentG ?? null,
      materialSource: this.materialSourceFor(focus),
      recommendedPrinterId,
      alternativeCount,
      selectedPrinterId: focus?.printerId ?? null,
      selectionSource: manuallySelected ? "manual" : recommendedPrinterId ? "auto" : "none",
      selectionNote: manuallySelected
        ? "Принтер выбран вручную"
        : (recommendation ??
          (views.length === 0
            ? "В ферме нет ни одного настроенного принтера"
            : "Ни один принтер сейчас не может принять это задание — причины по каждому ниже")),
      candidates: views,
      confirmations: focus ? this.confirmationsFor(focus, material) : [],
      activeRunId: activeRun?.id ?? null,
      // One cause, chosen from the problems already listed — never a new
      // sentence, so the headline and the diagnostics can never disagree. When
      // nothing is recommended at all, the least-blocked candidate supplies it:
      // "нет подходящего принтера" with no reason is the least useful true
      // statement the screen could make.
      primaryProblem: primaryProblem((focus ?? leastBlocked(views))?.problems ?? []),
      // The exit from an unconfirmed attempt, offered where the operator hits
      // the wall rather than in a separate screen they have no reason to open.
      unresolvedRunId:
        activeRun && activeRun.startedAt === null && activeRun.state !== "RUNNING"
          ? activeRun.id
          : null
    };
  }

  // ── Queue readiness ────────────────────────────────────────────────────────

  /**
   * **What each queued job's launch button should actually say.**
   *
   * A queue row used to report `QUEUED` + `WAITING` as «готово к запуску», which
   * is a statement about two database columns and not about any printer. A job
   * whose only compatible machine was mid-print, whose bed still held the last
   * part, or whose G-code was sliced for a machine this farm does not own, all
   * read identically green — and only the first row in the queue had a launch
   * button at all, so the honest answer for every other row was unobtainable.
   *
   * This answers it from the same preflight the launch itself runs, per row:
   * «Можно запустить на A1», «Стол занят — освободите», «Нет совместимого
   * принтера», «Нужно подтвердить материал». One evaluation per (row × printer),
   * which for a farm-sized queue is cheap and, unlike a cached verdict, cannot be
   * stale by the time it is read.
   */
  queueReadiness(limit = DEFAULT_READINESS_ROWS): QueueLaunchReadiness[] {
    // Bounded on purpose. Each row costs one full eligibility evaluation per
    // printer, and this is polled from the dashboard: an unbounded queue would
    // turn a 200-job backlog into 600 evaluations every few seconds, for rows
    // nobody is looking at. The head of the queue is what an operator acts on;
    // the rest is the planner's job, and the planner asks per task.
    //
    // The listing itself is read ONCE for the whole page. `readinessFor` needs
    // the open queue too — it is the per-printer tie-break depth — and reading
    // it per row made a 25-row page project the same queue 26 times over. The
    // projection is the expensive half (it joins each row's artifact, analysis
    // and run: ~45 ms against ~1 ms for the raw SELECT), so at a 6-second poll
    // that was over a second of blocked event loop per tick, spent re-deriving
    // one Map.
    const open = this.deps.printQueue.listOpenQueue();
    const depth = queueDepthOf(open);
    return open.slice(0, Math.max(1, limit)).map((row) => this.readinessFor(row.task, depth));
  }

  /**
   * Readiness for **one** task, by id — the same answer a queue row gets.
   *
   * Exists because the task panel needs it for a job that may not be in the
   * queue's first page, or in the queue at all. Asking for the whole page and
   * picking one row out of it (which is what the panel did) both evaluated the
   * farm 25 times over for one answer and silently returned nothing for any task
   * past the limit — a diagnostic screen going quiet exactly for the backlog
   * nobody can see.
   */
  readinessForTaskId(taskId: string): QueueLaunchReadiness {
    return this.readinessFor(this.requireTask(taskId));
  }

  /**
   * Readiness for one task — the row-level answer, shared with
   * {@link queueReadiness}. `depth` is the pre-computed per-printer queue depth;
   * omitted, it is read here, which is what a single-task caller wants.
   */
  readinessFor(task: PrintTask, depth?: ReadonlyMap<string, number>): QueueLaunchReadiness {
    const repos = this.deps.store.repositories;
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;
    const assignment = this.liveAssignment(task.id);
    const material = assignment?.binding.material ?? task.material ?? analysis?.material ?? null;
    const nozzleMm = assignment?.binding.nozzleMm ?? analysis?.nozzleDiameterMm ?? null;

    const activeRun = repos.printRuns.findActiveByTask(task.id);
    if (activeRun && activeRun.startedAt === null && activeRun.state !== "RUNNING") {
      return {
        taskId: task.id,
        state: "unconfirmed",
        summary: "Прошлый запуск не подтверждён — отметьте, что произошло",
        printerId: activeRun.printerId,
        printerName: this.deps.resolvePrinter(activeRun.printerId)?.name ?? activeRun.printerId,
        canLaunch: false,
        needsConfirmation: false,
        alternativeCount: 0,
        primaryProblem: null
      };
    }
    if (activeRun || task.state === "PRINTING" || task.state === "DISPATCHING") {
      return {
        taskId: task.id,
        state: "running",
        summary: "Печатается",
        printerId: activeRun?.printerId ?? task.targetPrinter,
        printerName: activeRun
          ? (this.deps.resolvePrinter(activeRun.printerId)?.name ?? activeRun.printerId)
          : null,
        canLaunch: false,
        needsConfirmation: false,
        alternativeCount: 0,
        primaryProblem: null
      };
    }

    const { candidates, recommendedPrinterId, alternativeCount } = selectLaunchPrinter(
      this.buildCandidates(task, material, nozzleMm, depth)
    );
    const views: LaunchCandidateView[] = candidates.map((c) => ({
      ...c,
      problems: explainLaunchFailure(c)
    }));
    const best = views.find((c) => c.printerId === recommendedPrinterId) ?? null;

    if (best) {
      const confirmations = this.confirmationsFor(best, material).filter((c) => c.required);
      return {
        taskId: task.id,
        state: confirmations.length > 0 ? "needs_confirmation" : "ready",
        summary:
          confirmations.length > 0
            ? `${confirmations.map((c) => c.label.toLowerCase()).join("; ")} — подтвердите и запускайте на «${best.printerName}»`
            : `Можно запустить на «${best.printerName}»`,
        printerId: best.printerId,
        printerName: best.printerName,
        canLaunch: true,
        needsConfirmation: confirmations.length > 0,
        alternativeCount,
        primaryProblem: null
      };
    }

    // Nothing startable. The most useful thing to say is the cause on the printer
    // that came closest — never the bare "нет готового принтера", which names no
    // machine, no reason and no action.
    const closest = leastBlocked(views);
    const problem = primaryProblem(closest?.problems ?? []);
    return {
      taskId: task.id,
      state: "blocked",
      summary: problem
        ? views.length === 1 || !closest
          ? problem.title
          : `${problem.title} (${closest.printerName})`
        : "Нет совместимого принтера",
      printerId: closest?.printerId ?? null,
      printerName: closest?.printerName ?? null,
      canLaunch: false,
      needsConfirmation: false,
      alternativeCount: 0,
      primaryProblem: problem
    };
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  /**
   * Runs the whole sequence: choose → assign → deliver → confirm → start.
   *
   * Ordering is deliberate and each step is skipped when already satisfied, so a
   * retry after a lost response re-enters at the right place instead of
   * re-uploading a verified file or opening a second assignment. The physical
   * start is last and goes through `DispatchService`, so the authoritative gate
   * runs against rows re-read inside its own transaction — nothing decided during
   * this method's earlier steps is trusted at the moment of dispatch.
   */
  async launch(taskId: string, request: LaunchRequest = {}): Promise<LaunchOutcome> {
    const dispatch = this.deps.dispatch();
    if (!dispatch) throw new JobError("Служба запуска ещё не инициализирована");

    const actor = request.actor?.trim() || "operator";
    const steps: string[] = [];
    const task = this.requireTask(taskId);

    // 0 ── Idempotency, before any admission rule runs.
    //
    //      A repeat of a key that already acted is not a new launch asking for
    //      permission — it is the same launch asking what happened. Admitting it
    //      again would refuse it, correctly and uselessly: the first attempt left
    //      an active run on that printer, so the preflight now (rightly) reports
    //      `ACTIVE_RUN_EXISTS`, and a double click or a retry after a lost
    //      response would surface as «нет принтера, готового принять это задание»
    //      about a job that is already printing. The dispatch layer has always
    //      resolved the key this way; the launch has to reach it to benefit.
    if (request.idempotencyKey) {
      const existing = this.deps.store.repositories.printRuns.findByIdempotencyKey(
        request.idempotencyKey
      );
      // …but only for a run that actually got somewhere. A previous attempt that
      // was dispatched and never confirmed (`startedAt === null`, PENDING/UNKNOWN)
      // must NOT be replayed as a success: the printer may or may not be
      // printing, and the only honest answer is the operator's. Falling through
      // sends the caller into the ordinary path, which reports exactly that.
      if (existing && !isUnconfirmedRun(existing)) {
        const printer = this.deps.resolvePrinter(existing.printerId);
        return {
          run: {
            runId: existing.id,
            taskId: existing.taskId,
            assignmentId: existing.assignmentId,
            attemptId: existing.dispatchAttemptId ?? "",
            printerId: existing.printerId,
            printerName: printer?.name ?? existing.printerId,
            file: existing.file ?? "",
            deduplicated: true
          },
          printerId: existing.printerId,
          printerName: printer?.name ?? existing.printerId,
          steps: ["already_started"]
        };
      }
    }

    // 1 ── Choose the printer. An explicit choice is honoured but still admitted
    //      through the same eligibility check; "I picked it" is not an override.
    const preview = this.preview(task.id, request.printerId);
    const chosenId = request.printerId ?? preview.recommendedPrinterId;
    if (!chosenId) {
      throw new JobError(
        "Нет принтера, готового принять это задание",
        { blockers: firstBlockers(preview.candidates) }
      );
    }
    const candidate = preview.candidates.find((c) => c.printerId === chosenId);
    if (!candidate) throw new NotFoundError(`Принтер «${chosenId}»`);
    if (!candidate.eligible && !request.override) {
      // Without an override this is where a refusal stops: the operator may choose
      // *among* startable printers, never past a refusal.
      //
      // WITH one, the refusal is carried to the dispatch gate instead of being
      // pre-empted here. That is not a weakening — this method has no authority
      // to admit anything, and the gate re-reads every row inside its own
      // transaction, enforces `NON_OVERRIDABLE`, requires a reason and an
      // operator, and audits the decision. Deciding here would be the second
      // implementation of an admission rule, which is exactly what this service
      // is documented not to have.
      throw new JobError(candidate.reason, {
        blockers: candidate.blockers.map((b) => ({ code: b.code, message: b.message }))
      });
    }
    const printer = this.deps.resolvePrinter(chosenId);
    if (!printer) throw new NotFoundError(`Принтер «${chosenId}»`);

    // 2 ── Physical confirmations, before anything is uploaded or reserved.
    const given = new Set(request.confirmations ?? []);
    const required = this.confirmationsFor(candidate, preview.material).filter((c) => c.required);
    const missing = required.filter((c) => !given.has(c.code));
    if (missing.length > 0) {
      throw new ValidationError(
        `Требуется подтверждение: ${missing.map((c) => c.label).join("; ")}`,
        { confirmations: missing }
      );
    }

    // 3 ── The bed. Recorded as an operator assertion *before* the start, so the
    //      dispatch gate sees a real CLEAR cycle rather than being asked to trust
    //      this method's say-so.
    if (given.has("material_loaded") && preview.material) {
      // A physical assertion by a named person is evidence, and evidence that is
      // not written down is not evidence. It clears no blocker on its own — the
      // gate treats an unknown material as a warning in attended mode — but the
      // audit trail must be able to answer "who said PETG was in that machine".
      this.recordAudit(task.id, "material_confirmed", actor, {
        printerId: printer.id,
        material: preview.material,
        source: "operator"
      });
      steps.push("material_confirmed");
    }

    if (given.has("bed_clear")) {
      const lifecycle = this.deps.runLifecycle();
      if (!lifecycle) throw new JobError("Служба запуска ещё не инициализирована");
      lifecycle.clearBed(printer.id, {
        confirmation: "part_removed",
        actor,
        note: `подтверждено при запуске «${task.title}»`,
        automaticContinuationAllowed: this.deps.automaticContinuationAllowed(printer.id)
      });
      steps.push("bed_confirmed");
    }

    // 4 ── PREFLIGHT, again, against rows re-read now.
    //
    //      Stage A of the three-stage protocol. The operator has been looking at
    //      a preview for however long it took them to tick the boxes, and the
    //      farm moved: another job took the printer, the bed filled, telemetry
    //      went stale. Re-running the SAME policy here is what keeps "preview
    //      allowed it" and "the launch refused it" from meaning two different
    //      rule sets — a divergence between them can now only be a *change*.
    //
    //      Nothing has been uploaded or reserved at this point, so a refusal here
    //      costs nothing and leaves no file on the machine.
    const gate = this.deps.scheduler.dispatchEligibility({
      taskId: task.id,
      printerId: printer.id,
      mode: "manual",
      stage: "preflight",
      automaticContinuationAllowed: this.deps.automaticContinuationAllowed(printer.id)
    });
    const remaining = remainingBlockers(gate, request.override?.codes ?? []);
    if (remaining.length > 0) {
      throw new JobError(
        `Нельзя запустить «${task.title}» на «${printer.name}»: ${remaining
          .map((r) => r.message)
          .join("; ")}`,
        { blockers: remaining.map((r) => ({ code: r.code, message: r.message })), stage: "preflight" }
      );
    }
    steps.push("preflight_passed");

    // 5 ── DELIVERY. Only now, and only after the preflight passed, do bytes
    //      move: assign the printer, resolve the remote name, push the file and
    //      verify what landed. An existing live assignment on the same printer is
    //      reused (its binding is the identity the file was built against); one
    //      pointing elsewhere is withdrawn rather than silently redirected, so
    //      the ledger never shows a placement that did not happen.
    const assignment = this.ensureAssignment(task, printer.id, actor, steps);

    //      `prepare` is idempotent and reconciles against the device: a VERIFIED
    //      copy is left alone, a stale or missing one is (re-)uploaded. This is
    //      the step the old UI made the operator do by hand in the printer's file
    //      browser.
    const delivery = await this.deps.deviceArtifacts.prepare(assignment.id, actor);
    if (!delivery.ready) {
      // Not ready means either a transfer that did not verify, or an adapter that
      // cannot upload at all — in which case `manualInstruction` tells the
      // operator exactly what to copy where, and is far more useful than the state name.
      throw new JobError(
        delivery.manualInstruction ??
          `Файл не подтверждён на принтере «${printer.name}» (${delivery.deviceArtifact.state}) — запуск отменён`,
        {
          blockers: [
            { code: "device_file_unverified", message: delivery.deviceArtifact.state }
          ]
        }
      );
    }
    steps.push("file_verified_on_device");

    // 6 ── FINAL DISPATCH GATE, then start. `startAssignment` re-reads every row
    //      inside its own transaction and runs the eligibility at its full
    //      `dispatch` stage — the preflight rules plus the ones only answerable
    //      now: the file is really there, under the expected name, at the
    //      expected size, tracked by this delivery, on a printer whose state did
    //      not change while the transfer ran.
    //
    //      The idempotency key is the caller's, so a double click or a
    //      refresh-and-retry returns the original run instead of a second print.
    const run = await dispatch.startAssignment(assignment.id, {
      mode: "manual",
      actor,
      // Forwarded, never interpreted: which codes may be waived, and whether a
      // reason and an operator were given, is the dispatch gate's decision, and
      // it records the whole thing in the audit trail under this actor's name.
      ...(request.override
        ? { override: { ...request.override, operator: actor } }
        : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {})
    });
    if (request.override) steps.push("override_accepted");
    steps.push(run.deduplicated ? "already_started" : "started");

    return { run, printerId: printer.id, printerName: printer.name, steps };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** One audit line, through the store the whole service already writes to. */
  private recordAudit(
    taskId: string,
    action: string,
    actor: string,
    detail: Record<string, unknown>
  ): void {
    const repos = this.deps.store.repositories;
    repos.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: new Date().toISOString(),
      entityType: "print_task",
      entityId: taskId,
      action,
      fromState: null,
      toState: null,
      actor,
      detail
    });
  }

  private requireTask(taskId: string): PrintTask {
    const task = this.deps.store.repositories.tasks.getById(taskId);
    if (!task) throw new NotFoundError(`Задание «${taskId}»`);
    return task;
  }

  /** The newest assignment that still describes a real placement. */
  private liveAssignment(taskId: string): Assignment | null {
    return (
      this.deps.store.repositories.assignments
        .listByTask(taskId)
        .filter(
          (a) => a.invalidatedAt === null && a.state !== "CANCELLED" && a.state !== "RELEASED"
        )
        .at(-1) ?? null
    );
  }

  private ensureAssignment(
    task: PrintTask,
    printerId: string,
    actor: string,
    steps: string[]
  ): Assignment {
    const existing = this.liveAssignment(task.id);
    if (existing && existing.printerId === printerId) {
      steps.push("assignment_reused");
      return existing;
    }
    if (existing) {
      this.deps.printQueue.invalidateAssignment(
        existing.id,
        `оператор выбрал другой принтер (${printerId})`
      );
      steps.push("assignment_replaced");
    }
    // The container the file will wear on THIS device, decided before the
    // binding captures it. An uploaded executable was queued before any printer
    // was chosen, so its name carries the artifact's own extension; a Bambu
    // starts a `.gcode.3mf` plate package and must be handed one by that name.
    // A no-op whenever the name is already right or the operator chose it.
    const retargeted = this.deps.printQueue.retargetDeviceFile(task.id, printerId, actor);
    if (retargeted.onDeviceFile !== task.onDeviceFile) steps.push("device_file_retargeted");
    const created = this.deps.printQueue.assignTask(
      task.id,
      printerId,
      { reason: "запуск из очереди" },
      actor
    );
    steps.push("assignment_created");
    return created;
  }

  /** What the device already holds for this (printer, task). */
  private deviceFileStateFor(task: PrintTask, printerId: string): DeviceFileState {
    const assignment = this.liveAssignment(task.id);
    if (!assignment || assignment.printerId !== printerId) return "missing";
    const record = this.deps.deviceArtifacts.forAssignment(assignment);
    if (!record) return "missing";
    // The artifact the task points at *now* decides staleness: a copy verified
    // against a superseded slice is not a copy of this job.
    if (task.artifactId && record.artifactId !== task.artifactId) return "stale";
    if (record.state === "VERIFIED") return "verified";
    if (record.state === "PRESENT_UNVERIFIED") return "unverified";
    return "missing";
  }

  /**
   * One candidate per printer, admitted by the **same policy the dispatch runs**
   * — {@link evaluateDispatchEligibility} at its `preflight` stage.
   *
   * This used to call `compatibilityForTask`, i.e. the planner's
   * `evaluateCompatibility` and nothing else. That answered "could this printer
   * ever make this model", which is a different question from "may this file
   * start on this machine now", and the gap was where the launch broke: a G-code
   * sliced for an A1 passed the preview for a K2 (the declared target is not a
   * compatibility rule), the operator confirmed, the file was uploaded to the
   * K2, and only the dispatch gate refused it — after the transfer.
   *
   * Now every refusal the dispatch would raise *and that does not depend on the
   * bytes having moved* is already here, so the preview can only be overtaken by
   * a change, never by something that was true all along.
   */
  private buildCandidates(
    task: PrintTask,
    requiredMaterial: string | null,
    requiredNozzleMm: number | null,
    depth?: ReadonlyMap<string, number>
  ): LaunchCandidateInput[] {
    const openByPrinter = depth ?? this.openQueueDepth();
    return this.preflight(task).map(({ printer, eligibility }) => {
      const config = this.deps.resolvePrinter(printer.id);
      const split = splitReasons(eligibility);
      return {
        printerId: printer.id,
        printerName: printer.name,
        verdict: eligibility.preflight.verdict,
        ...split,
        online: printer.online,
        status: printer.status,
        loadedMaterial: printer.material,
        requiredMaterial,
        printerNozzleMm: printer.nozzleMm,
        requiredNozzleMm,
        deviceFile: this.deviceFileStateFor(task, printer.id),
        queueLength: openByPrinter.get(printer.id) ?? 0,
        pendingManualOperations: this.deps.manualOperations.openBlockingFor(printer.id).length,
        remoteStartSupported:
          printer.remoteStartSupported && (config ? capabilitiesOf(config).supportsUpload : false)
      };
    });
  }

  /** The shared preflight evaluation — one call site for preview and launch. */
  private preflight(task: PrintTask) {
    return this.deps.scheduler.launchPreflight(task, {
      automaticContinuationAllowed: (id) => this.deps.automaticContinuationAllowed(id)
    });
  }

  /** Open queue rows already pointing at each printer — the tie-break depth. */
  private openQueueDepth(): Map<string, number> {
    return queueDepthOf(this.deps.printQueue.listOpenQueue());
  }

  /**
   * The physical facts a human must assert for this candidate.
   *
   * Derived from the *reviews* the compatibility check produced, never invented
   * here: a confirmation exists precisely when there is an open question the
   * operator can close. Asking every time regardless — the reflex that trains
   * people to click through safety prompts — is what the `required` flag avoids:
   * a bed already tracked CLEAR and a material read from live telemetry produce
   * no checkbox at all.
   */
  private confirmationsFor(
    candidate: LaunchCandidate,
    requiredMaterial: string | null
  ): LaunchConfirmation[] {
    const out: LaunchConfirmation[] = [];
    // Every reason the candidate carries, whichever bucket it landed in: a bed
    // that is not clear is a *blocker* in the dispatch vocabulary and still the
    // most confirmable fact on the screen.
    //
    // Keyed off the reason's own `confirmation`, not off its code. The two are
    // not the same question for the bed: `BED_NOT_CLEAR` is raised both for a
    // plate holding a finished part (an operator empties it) and for a plate
    // another job is running on (nobody empties that, and `clearBed` refuses).
    // `confirmationFor` has already made that distinction — reading the raw
    // codes here would undo it and put the impossible tick back on screen.
    const reasons = [...candidate.blockers, ...candidate.reviews, ...candidate.warnings];
    const bed = reasons.filter((r) => r.confirmation === "bed_clear");

    if (bed.length > 0) {
      out.push({
        code: "bed_clear",
        label: "Стол свободен",
        detail: bed.some((r) => r.code === "BED_NOT_CLEAR")
          ? "На столе осталась готовая модель — снимите её перед запуском."
          : "Система не знает, что сейчас на столе. Проверьте, что он пуст.",
        required: true,
        effect:
          "Подтверждение записывает очистку стола от вашего имени: принтер получит цикл стола CLEAR, и это попадёт в журнал."
      });
    }

    // Only when the material genuinely cannot be read. A printer reporting its
    // filament over telemetry has already answered this question — and a printer
    // whose *config* merely lists what it can print never answered it at all,
    // which is the false «material_mismatch» this whole split removed.
    if (requiredMaterial && candidate.loadedMaterial === null) {
      out.push({
        code: "material_loaded",
        label: `Установлен ${requiredMaterial}`,
        detail: `Принтер не сообщает загруженный материал. Убедитесь, что заправлен ${requiredMaterial}.`,
        required: true,
        effect: `Подтверждение записывается в журнал как ваше утверждение «в «${candidate.printerName}» заправлен ${requiredMaterial}».`
      });
    }

    return out;
  }

  /** Whether the material fact comes from an AMS, an external spool, or nowhere. */
  private materialSourceFor(candidate: LaunchCandidateView | null): "ams" | "external" | "unknown" {
    if (!candidate || candidate.loadedMaterial === null) return "unknown";
    const config = this.deps.resolvePrinter(candidate.printerId);
    if (!config) return "unknown";
    // A printer reporting a material with no AMS unit is running a single
    // external spool — worth saying plainly rather than showing an empty slot list.
    return this.deps.scheduler
      .listPrinterRefs()
      .find((p) => p.id === candidate.printerId)?.ams === true
      ? "ams"
      : "external";
  }

  private resolveState(
    task: PrintTask,
    candidates: LaunchCandidateView[],
    recommendedPrinterId: string | null,
    activeRun: { state: string; startedAt: string | null } | null,
    focus: LaunchCandidateView | null,
    requiredMaterial: string | null
  ): LaunchState {
    // A dispatched start the printer never confirmed. Reported as itself rather
    // than as `running`, because the physical truth is that nothing is printing
    // — and because the operator's next action (resolve the attempt) is
    // different from anything they would do about a live print.
    if (
      activeRun &&
      activeRun.startedAt === null &&
      (activeRun.state === "PENDING" || activeRun.state === "UNKNOWN")
    ) {
      return "unconfirmed";
    }
    if (activeRun || task.state === "PRINTING" || task.state === "DISPATCHING") return "running";
    // DRAFT is the pre-queue state: the artifact is still being analysed/sliced,
    // so there is nothing to launch yet and no printer choice to explain.
    if (task.state === "DRAFT") return "preparing";
    const startable = focus ?? candidates.find((c) => c.printerId === recommendedPrinterId) ?? null;
    if (!startable || !startable.eligible) return "blocked";
    return this.confirmationsFor(startable, requiredMaterial).some((c) => c.required) ||
      startable.reviews.length > 0
      ? "needs_confirmation"
      : "ready";
  }
}

/** Open queue rows already pointing at each printer — the tie-break depth. */
function queueDepthOf(rows: readonly { task: PrintTask }[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const row of rows) {
    const target = row.task.pinnedPrinterId ?? row.task.targetPrinter;
    if (!target) continue;
    depth.set(target, (depth.get(target) ?? 0) + 1);
  }
  return depth;
}

/**
 * The eligibility's reasons, split into the three buckets the launch screen
 * speaks — and *only* by facts the domain already decided.
 *
 *  - a `blocker` an operator may never wave through → **blocker**;
 *  - a `blocker` outside `NON_OVERRIDABLE` → **confirmable**: a named person may
 *    accept it, and the screen must offer them the way to;
 *  - a `warning` → **info**.
 *
 * The old split came from which *list* `evaluateCompatibility` put a reason in,
 * which meant the launch screen and the dispatch gate disagreed about what was
 * waivable: a preflight `review` that the dispatch had hardened into a
 * non-overridable blocker was still offered as a checkbox, and the operator's
 * confirmation was then refused by the gate.
 */
function splitReasons(eligibility: DispatchEligibility): {
  blockers: LaunchReason[];
  reviews: LaunchReason[];
  warnings: LaunchReason[];
} {
  const blockers: LaunchReason[] = [];
  const reviews: LaunchReason[] = [];
  const warnings: LaunchReason[] = [];
  for (const r of eligibility.reasons) {
    const item = toLaunchReason(r);
    if (r.severity === "blocker") {
      // A blocker refuses the start. The one exception is a blocker a tick
      // *resolves* by causing a real server action — an unknown bed becomes a
      // recorded CLEAR cycle — which is a confirmation, not a waiver, and must
      // not make the printer look impossible.
      if (item.confirmation) reviews.push(item);
      else blockers.push(item);
      continue;
    }
    // Among warnings, only the ones that began life as a preflight *review* are
    // open questions for a human; the rest are context. Severity decides whether
    // the launch may proceed, `origin` decides whether there is anything to tick.
    if (item.origin === "review") reviews.push(item);
    else warnings.push(item);
  }
  return { blockers, reviews, warnings };
}

function toLaunchReason(r: EligibilityReason): LaunchReason {
  const evidence = r.evidence as
    | { stage?: string; code?: string; origin?: string; bedState?: unknown }
    | undefined;
  const fromPreflight = evidence?.stage === "preflight";
  const preflightCode =
    fromPreflight && typeof evidence?.code === "string" ? evidence.code : undefined;
  const origin = fromPreflight && typeof evidence?.origin === "string" ? evidence.origin : undefined;
  const confirmation = confirmationFor(r, evidence);
  return {
    code: r.code,
    message: r.message,
    ...(preflightCode ? { preflightCode } : {}),
    ...(origin ? { origin } : {}),
    ...(confirmation ? { confirmation } : {}),
    overridable: !NON_OVERRIDABLE.has(r.code)
  };
}

/**
 * The confirmation that would *resolve* this reason, if any.
 *
 * Only `BED_NOT_CLEAR` needs more than the code to decide, because the same code
 * covers both a plate an operator can empty and a plate another job is using —
 * see {@link CONFIRMABLE_BED_STATES}. Two sources answer that, and the reason
 * carries whichever its origin knew:
 *
 *  - the dispatch rule states the bed state outright (`evidence.bedState`);
 *  - the lifted preflight reason states its own code, and
 *    `bed_awaiting_clearance` is raised for exactly one state — a finished part
 *    waiting to be taken off. (`RUNNING`/`RESERVED` become `printer_busy` there,
 *    never this.)
 *
 * A reason carrying neither gets no tick: an unattributed "стол не свободен" is
 * not evidence that removing something would help.
 */
function confirmationFor(
  reason: EligibilityReason,
  evidence: { code?: string; bedState?: unknown } | undefined
): LaunchConfirmationKey | undefined {
  const confirmation = CONFIRMATION_FOR_CODE[reason.code];
  if (!confirmation) return undefined;
  if (reason.code !== "BED_NOT_CLEAR") return confirmation;
  if (evidence?.code === "bed_awaiting_clearance") return confirmation;
  const bedState = evidence?.bedState;
  return typeof bedState === "string" && CONFIRMABLE_BED_STATES.has(bedState)
    ? confirmation
    : undefined;
}

/**
 * A start command that left and was never confirmed. `startedAt === null` is the
 * load-bearing half: a run with a start time was observed printing, whatever it
 * is doing now.
 */
function isUnconfirmedRun(run: { state: string; startedAt: string | null }): boolean {
  return run.startedAt === null && (run.state === "PENDING" || run.state === "UNKNOWN");
}

/** The candidate closest to being startable — the most useful "why not". */
function leastBlocked(candidates: LaunchCandidateView[]): LaunchCandidateView | null {
  return [...candidates].sort((a, b) => a.blockers.length - b.blockers.length)[0] ?? null;
}

/** The blockers of the least-blocked candidate — the most useful "why not". */
function firstBlockers(candidates: LaunchCandidateView[]): LaunchReason[] {
  return leastBlocked(candidates)?.blockers ?? [];
}

/** `3U-default.3mf` → `3U-default`. The operator named the model, not the container. */
function stripExtension(title: string): string {
  return title.replace(/\.(gcode\.3mf|3mf|stl|gcode|gco|g)$/i, "");
}
