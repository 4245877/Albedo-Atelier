import { readAnalysisReview } from "../../domain/print/analysisReview";
import { evaluateExecutableArtifact, executableKindOf } from "../../domain/print/executable";
import { readModelScale } from "../../domain/print/modelScale";
import type { Artifact, ArtifactAnalysis, PrintTask } from "../../domain/print/types";

/**
 * **The one obvious next step for a file that was accepted.**
 *
 * The acceptance criterion for the whole intake is that no file may sit in a
 * green, finished-looking state with nothing the operator can do to it. Before
 * this, an uploaded G-code reached exactly that: analysed, `schedulable`, a
 * cheerful chip saying «готово к планированию», a `DRAFT` task — and no control
 * anywhere in the interface that could move it towards a printer.
 *
 * So the *server* decides what comes next and says it in words, and the card
 * renders that decision. Deliberately server-side: which step is available
 * depends on the analysis verdict, the review acknowledgement, the scale
 * confirmation and the task's state, and a browser reimplementing that rule set
 * is a second source of truth that will drift.
 */

export type ArtifactActionKind =
  /** Work is in progress; the card waits and polls. */
  | "wait"
  /** The analysis failed — re-run it. */
  | "reanalyze"
  /** An STL whose units nobody has stated yet. */
  | "confirm_scale"
  /** A `review` verdict a named operator must read and accept. */
  | "confirm_review"
  /** Executable and admitted: put it in the queue. */
  | "enqueue"
  /** Source geometry: it needs slicing before anything else. */
  | "slice"
  /** Already in the queue — the next action lives on the queue row. */
  | "queued"
  /** A run is under way or finished; the file's own journey is over. */
  | "in_progress"
  /** Nothing can be done with this file, and the reason says why. */
  | "blocked";

export interface ArtifactNextAction {
  kind: ArtifactActionKind;
  /** Imperative label for the primary control, or "" when there is no control. */
  label: string;
  /** One sentence: what this step is, or why no step exists. */
  explanation: string;
  /** True when the operator can act right now (the control is live). */
  actionable: boolean;
  /** The draft/queued task the action applies to, when there is one. */
  taskId: string | null;
}

export interface ArtifactStatusView {
  next: ArtifactNextAction;
  /** Whether this file could be handed to a printer as-is (content, not name). */
  executable: boolean;
  /** Scale confirmation state, for the STL units control. */
  scale: {
    /** True when the size is unproven and an unattended start would be refused. */
    required: boolean;
    units: string | null;
    scaleFactor: number | null;
    confirmedBy: string | null;
    confirmedAt: string | null;
    stale: boolean;
  };
  /** Review acknowledgement state, for the "прочитал и принимаю" control. */
  review: {
    required: boolean;
    codes: string[];
    confirmedBy: string | null;
    confirmedAt: string | null;
    note: string | null;
    stale: boolean;
    staleReason: string | null;
  };
}

/** Task states that mean "this file's journey has left the upload card". */
const IN_FLIGHT: ReadonlySet<string> = new Set([
  "PLANNED",
  "ASSIGNED",
  "DISPATCHING",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "CANCELLED"
]);

export function resolveArtifactStatus(
  artifact: Artifact,
  analysis: ArtifactAnalysis | null,
  task: PrintTask | null
): ArtifactStatusView {
  const scale = readModelScale(artifact);
  const review = readAnalysisReview(artifact, analysis);
  const executable = analysis !== null && executableKindOf(analysis) !== null;

  // An STL states no unit, so its bounding box is numbers without a scale. This
  // is not a nicety: a 25.4×-wrong model passes every fit check, and the
  // scheduler refuses an unattended start on it (`model_scale_unknown`).
  const scaleRequired =
    analysis?.state === "ready" &&
    analysis.detectedFormat === "stl" &&
    (scale === null || scale.stale);

  const reviewRequired =
    analysis?.state === "ready" &&
    analysis.verdict !== null &&
    analysis.verdict !== "schedulable" &&
    analysis.blockers.length === 0 &&
    (review === null || review.stale);

  return {
    next: resolveNextAction({ artifact, analysis, task, executable, scaleRequired, reviewRequired }),
    executable,
    scale: {
      required: scaleRequired === true,
      units: scale?.confirmation.units ?? null,
      scaleFactor: scale?.confirmation.scaleFactor ?? null,
      confirmedBy: scale?.confirmation.confirmedBy ?? null,
      confirmedAt: scale?.confirmation.confirmedAt ?? null,
      stale: scale?.stale ?? false
    },
    review: {
      required: reviewRequired === true,
      codes: [...analysis?.warnings ?? []].map((w) => w.code),
      confirmedBy: review?.acknowledgement.confirmedBy ?? null,
      confirmedAt: review?.acknowledgement.confirmedAt ?? null,
      note: review?.acknowledgement.note ?? null,
      stale: review?.stale ?? false,
      staleReason: review?.staleReason ?? null
    }
  };
}

function resolveNextAction(input: {
  artifact: Artifact;
  analysis: ArtifactAnalysis | null;
  task: PrintTask | null;
  executable: boolean;
  scaleRequired: boolean | undefined;
  reviewRequired: boolean | undefined;
}): ArtifactNextAction {
  const { artifact, analysis, task, executable } = input;
  const taskId = task?.id ?? null;

  if (!analysis || analysis.state === "pending" || analysis.state === "running") {
    return {
      kind: "wait",
      label: "",
      explanation: "Файл анализируется — следующий шаг появится, когда анализ закончится.",
      actionable: false,
      taskId
    };
  }
  if (analysis.state === "failed") {
    return {
      kind: "reanalyze",
      label: "Повторить анализ",
      explanation: `Анализ не удался${analysis.error ? `: ${analysis.error}` : ""}. Без него файл нельзя ни нарезать, ни запустить.`,
      actionable: true,
      taskId
    };
  }

  if (task && IN_FLIGHT.has(task.state)) {
    return {
      kind: "in_progress",
      label: "",
      explanation: `Задание уже в работе (${task.state}) — следите за ним в очереди и на карточке принтера.`,
      actionable: false,
      taskId
    };
  }
  if (task && task.state === "QUEUED") {
    return {
      kind: "queued",
      label: "",
      explanation: "Задание стоит в очереди — запуск и его готовность видны там.",
      actionable: false,
      taskId
    };
  }

  if (analysis.blockers.length > 0 || analysis.verdict === "blocked") {
    return {
      kind: "blocked",
      label: "",
      explanation:
        analysis.blockers.length > 0
          ? `Печать этого файла невозможна: ${analysis.blockers.map((b) => b.message).join("; ")}`
          : "Анализ признал файл непригодным к печати — причины перечислены выше.",
      actionable: false,
      taskId
    };
  }

  // ── Source geometry ───────────────────────────────────────────────────────
  if (!executable) {
    if (input.scaleRequired) {
      return {
        kind: "confirm_scale",
        label: "Подтвердить единицы",
        explanation:
          "STL не хранит единицы измерения, поэтому габариты пока недоказуемы. " +
          "Укажите, в чём заданы координаты, — иначе модель нельзя проверить на размер и нельзя печатать без присмотра.",
        actionable: true,
        taskId
      };
    }
    return {
      kind: "slice",
      label: "Нарезать",
      explanation:
        "Это модель — перед печатью её нужно нарезать под конкретный принтер (раздел «Слайсинг»).",
      actionable: true,
      taskId
    };
  }

  // ── Already printable ─────────────────────────────────────────────────────
  const admission = evaluateExecutableArtifact(artifact, analysis);
  if (!admission.ok) {
    if (admission.needsReview) {
      return {
        kind: "confirm_review",
        label: "Прочитать и подтвердить",
        explanation:
          "Файл уже нарезан, но его параметры заданы чужим профилем печати — система их не проверяла. " +
          "Прочитайте замечания и подтвердите, что берёте их на себя; после этого файл можно поставить в очередь.",
        actionable: true,
        taskId
      };
    }
    return {
      kind: "blocked",
      label: "",
      explanation: admission.reason,
      actionable: false,
      taskId
    };
  }

  if (!taskId) {
    return {
      kind: "blocked",
      label: "",
      explanation:
        "У этого файла нет черновика задания — он был загружен в обход обычного пути. Загрузите файл заново.",
      actionable: false,
      taskId
    };
  }

  return {
    kind: "enqueue",
    label: "Поставить в очередь",
    explanation:
      admission.kind === "sliced_3mf"
        ? `Нарезанный файл принят${admission.acknowledgedBy ? ` (проверку подтвердил ${admission.acknowledgedBy})` : ""}. Поставьте его в очередь — принтер выберется при запуске.`
        : "Файл готов к печати. Поставьте его в очередь — принтер выберется при запуске.",
    actionable: true,
    taskId
  };
}
