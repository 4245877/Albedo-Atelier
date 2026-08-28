import { mapPreflightCode } from "../../domain/dispatch/eligibility";
import { NON_OVERRIDABLE } from "../../domain/dispatch/reasons";
import type { CompatibilityReason } from "../../domain/scheduling/compatibility";
import type { LaunchCandidate } from "../../domain/launch/selection";

/**
 * Turning internal refusal codes into something an operator can act on.
 *
 * The dispatch gate speaks in codes (`PRINTER_NOT_CONFIGURED`, `bed_unknown`,
 * `slice_missing`) and messages written for whoever is reading the ledger. Shown
 * verbatim in the UI they name concepts — device artifacts, dispatch bindings,
 * project files — that the person standing at the printer has no reason to know,
 * and none of them says what to *do*.
 *
 * Each entry below is that translation, and deliberately carries three separate
 * things: a short `title` (what is wrong), an `action` (what would fix it, in
 * the imperative), and the untouched original as `technical` for the diagnostics
 * panel. Unmapped codes fall through with their original message rather than a
 * generic apology — an honest unknown beats a friendly lie.
 */

/** How much freedom the operator has about this problem. */
export type ProblemKind =
  /** Hard refusal. Cannot be confirmed or overridden from the launch screen. */
  | "blocker"
  /** A physical fact a human can assert (bed clear, filament loaded). */
  | "confirmable"
  /** Worth knowing; does not stop the launch. */
  | "info";

export interface LaunchProblem {
  code: string;
  kind: ProblemKind;
  title: string;
  action: string;
  /** The original engine message, for the expandable diagnostics view. */
  technical: string;
  /**
   * Whether a named operator may accept this one and proceed.
   *
   * Read from the dispatch layer's own `NON_OVERRIDABLE` set rather than
   * re-decided here, so the UI can never offer a checkbox for something the
   * gate will refuse anyway — and never hide one for something a human could
   * legitimately vouch for. A `blocker` kind is never overridable whatever the
   * code says; the distinction is only meaningful for the `confirmable` ones.
   */
  overridable: boolean;
}

interface Translation {
  title: string;
  action: string;
}

/**
 * Code → operator language. Keyed by the compatibility/eligibility codes the
 * domain already emits, so adding a rule there surfaces here by its code rather
 * than by string matching on a message.
 */
const TRANSLATIONS: Record<string, Translation> = {
  printer_offline: {
    title: "Принтер недоступен",
    action: "Принтер не отвечает по сети. Проверьте питание и подключение."
  },
  printer_busy: {
    title: "Принтер занят",
    action: "Сейчас идёт другая печать — запуск станет возможен после её завершения."
  },
  printer_error: {
    title: "Принтер сообщает об ошибке",
    action: "Посмотрите экран принтера и устраните ошибку."
  },
  printer_fault: {
    // Deliberately has no fixed `action`: the message carries the device's own
    // code and remedy, which is more specific than anything written here could
    // be. `explainReason` keeps the original message when a translation omits it.
    title: "Принтер сообщает об ошибке",
    action: ""
  },
  printer_media_missing: {
    title: "Принтер не видит карту памяти",
    action:
      "Файл печати лежит на карте памяти принтера, а принтер её не читает. " +
      "Переустановите или замените карту, затем повторите запуск."
  },
  launch_unconfirmed: {
    title: "Прошлый запуск не подтверждён",
    action:
      "Команда ушла, но принтер не сообщил, начал ли он печать. " +
      "Посмотрите на принтер и отметьте, что произошло, — после этого запуск снова возможен."
  },
  telemetry_stale: {
    title: "Нет свежих данных от принтера",
    action: "Последний ответ пришёл давно. Проверьте связь с принтером."
  },
  telemetry_missing: {
    title: "Принтер ещё не отвечал",
    action: "Данных о состоянии нет. Дождитесь первого ответа или проверьте подключение."
  },
  bed_unknown: {
    title: "Нужно проверить стол",
    action: "Система не знает, что на столе. Убедитесь, что он свободен, и подтвердите это."
  },
  bed_awaiting_clearance: {
    title: "На столе осталась модель",
    action: "Снимите готовую деталь с площадки и подтвердите, что стол свободен."
  },
  material_mismatch: {
    title: "Не тот материал",
    action: "Заправленный пруток не совпадает с материалом задания. Замените катушку или выберите другой принтер."
  },
  task_material_unknown: {
    title: "Материал задания неизвестен",
    action: "Укажите материал в задании — иначе совпадение с катушкой не проверить."
  },
  printer_material_unknown: {
    title: "Материал в принтере неизвестен",
    action: "Принтер не сообщает загруженный пруток. Подтвердите материал вручную."
  },
  nozzle_mismatch: {
    title: "Не то сопло",
    action: "Диаметр сопла не совпадает с тем, под который нарезана модель. Смените сопло или принтер."
  },
  printer_nozzle_unknown: {
    title: "Диаметр сопла неизвестен",
    action: "Укажите диаметр сопла в настройках принтера."
  },
  model_off_bed: {
    title: "Модель стоит за пределами стола",
    action:
      "Файл размещает деталь вне рабочей области этого принтера — скорее всего он нарезан " +
      "для машины с бо́льшим столом. Нарежьте модель заново для этого принтера."
  },
  too_large: {
    title: "Модель не помещается",
    action: "Габариты детали больше рабочей области принтера. Выберите принтер побольше."
  },
  build_volume_unknown: {
    title: "Рабочая область неизвестна",
    action: "Укажите размеры стола в настройках принтера, чтобы проверить, поместится ли деталь."
  },
  gcode_flavor_mismatch: {
    title: "Файл собран для другого принтера",
    action: "Этот G-code сделан под другую прошивку — его нельзя запустить здесь. Нарежьте модель заново для этого принтера."
  },
  slice_missing: {
    title: "Модель ещё не нарезана",
    action: "Для этого принтера нет готового G-code. Запустите нарезку."
  },
  slicing_unavailable: {
    title: "Нарезка недоступна",
    action: "Слайсер сейчас не запущен — нарезать модель не получится."
  },
  profileset_quarantined: {
    title: "Профиль печати заблокирован",
    action: "Набор профилей помечен как непроверенный. Проверьте его в разделе профилей."
  },
  profileset_unapproved: {
    title: "Профиль печати не утверждён",
    action: "Утвердите набор профилей для этого принтера перед запуском."
  },
  pinned_elsewhere: {
    title: "Задание закреплено за другим принтером",
    action: "Открепите задание или выберите принтер, за которым оно закреплено."
  },
  manual_start_only: {
    title: "Удалённый запуск не поддержан",
    action: "Этот принтер запускается только с его собственного экрана."
  },
  maintenance: {
    title: "Принтер на обслуживании",
    action: "Завершите обслуживание, чтобы вернуть принтер в работу."
  },
  ams_unsupported: {
    title: "Нужен AMS",
    action: "Заданию нужна многоматериальная подача, которой у принтера нет."
  },
  ams_unknown: {
    title: "Поддержка AMS неизвестна",
    action: "Не записано, есть ли у принтера многоматериальная подача. Укажите это в настройках принтера."
  },
  ams_mapping_ambiguous: {
    title: "Не определено, какой филамент в какой слот",
    action:
      "Задание печатается несколькими инструментами, но раскладка по слотам не задана — " +
      "печать пошла бы одним материалом. Нарежьте под один материал или подтвердите запуск вручную."
  },
  profileset_unknown: {
    title: "Профиль печати неизвестен",
    action: "У нарезки нет привязанного набора профилей. Пересоберите нарезку."
  },
  task_nozzle_unknown: {
    title: "Сопло задания неизвестно",
    action: "Не удалось определить, под какое сопло нарезана модель. Пересоберите нарезку или укажите сопло."
  },
  build_volume_conflict: {
    title: "Размеры стола расходятся",
    action: "Настройки принтера и его профиль печати называют разные размеры стола. Сверьте их."
  },
  dimensions_unknown: {
    title: "Габариты модели неизвестны",
    action: "Анализ не определил размеры детали — проверить, поместится ли она, нельзя. Перезапустите анализ."
  },
  model_scale_unknown: {
    title: "Масштаб модели не подтверждён",
    action:
      "STL не содержит единиц измерения, поэтому размеры недоказуемы. " +
      "Подтвердите масштаб модели (мм или дюймы) перед запуском."
  },
  PRINTER_NOT_CONFIGURED: {
    title: "Принтер не настроен",
    action: "Не хватает данных для связи с принтером — заполните их в настройках принтера."
  },
  device_file_unverified: {
    title: "Файл не подтверждён на принтере",
    action: "Не удалось убедиться, что файл долетел целиком. Повторите запуск — это безопасно."
  },
  UPLOAD_FAILED: {
    title: "Не удалось загрузить файл",
    action: "Соединение с принтером прервалось при передаче. Повторить запуск безопасно."
  },
  START_REJECTED: {
    title: "Принтер отказался запускать печать",
    action: "Команда дошла, но принтер её не принял. Посмотрите его экран."
  },
  START_UNCONFIRMED: {
    title: "Запуск не подтверждён",
    action: "Команда ушла, но принтер не подтвердил старт. Проверьте принтер, прежде чем запускать снова."
  }
};

/** The codes this layer has operator language for — iterated by the exhaustive test. */
export const TRANSLATED_CODES: ReadonlySet<string> = new Set(Object.keys(TRANSLATIONS));

/**
 * The operator-facing form of one refusal reason.
 *
 * Takes a bare `{code, message}` rather than a {@link CompatibilityReason}: this
 * layer also translates codes the launch flow raises itself (`UPLOAD_FAILED`,
 * `START_REJECTED`, `device_file_unverified`), which are not part of the
 * preflight vocabulary. It must stay total for any code — an unmapped one falls
 * through with its own message rather than a generic apology.
 */
export function explainReason(reason: { code: string; message: string }, kind: ProblemKind): LaunchProblem {
  const t = TRANSLATIONS[reason.code];
  return {
    code: reason.code,
    kind,
    // Only a review may be waived, and only when the dispatch vocabulary says the
    // code is waivable. A preflight code is translated into that vocabulary first,
    // exactly as the gate translates it.
    overridable: kind === "confirmable" && !NON_OVERRIDABLE.has(mapPreflightCode(reason.code)),
    title: t?.title ?? reason.message,
    // An empty translated action means "the message itself is the instruction" —
    // used by codes whose message is generated per-device (a fault carries the
    // printer's own code and remedy).
    action: t?.action || reason.message,
    technical: `${reason.code}: ${reason.message}`
  };
}

/**
 * How close a code is to being the *cause* rather than a consequence of it.
 *
 * The incident this ranking exists for showed an operator four simultaneous
 * reasons — «Принтер занят», «Принтер в ошибке», «Принтер недоступен»,
 * «Неизвестно сопло» — for one physical problem: a MicroSD card the printer
 * could not read. Three of the four were downstream of the first, and the true
 * cause was in none of them, because the code that named it was never read off
 * the device. Listing consequences beside a cause does not make the list more
 * complete, it makes the cause unfindable.
 *
 * So the launch screen headlines exactly one problem, chosen here. Lower rank
 * wins. Codes not listed fall in with the ordinary blockers — the ranking only
 * needs to know which few reasons are *derived* from others, not to enumerate
 * every reason in the system.
 */
const CAUSE_RANK: Record<string, number> = {
  // The device naming its own failure — nothing outranks the printer's screen.
  printer_fault: 0,
  printer_media_missing: 0,
  // An unresolved prior attempt: it explains the busy/hold that follows from it.
  launch_unconfirmed: 1,
  // Structural facts about the job, independent of device state.
  pinned_elsewhere: 2,
  slice_missing: 2,
  slicing_unavailable: 2,
  profileset_quarantined: 2,
  too_large: 2,
  nozzle_mismatch: 2,
  material_mismatch: 2,
  gcode_flavor_mismatch: 2,
  // Device state without an attributed cause — true, but rarely actionable.
  printer_offline: 4,
  printer_error: 5,
  // Consequences: these follow from something above and must never headline.
  printer_busy: 6,
  telemetry_stale: 6,
  telemetry_missing: 6,
  printer_nozzle_unknown: 7,
  printer_material_unknown: 7,
  build_volume_unknown: 7
};

const DEFAULT_CAUSE_RANK = 3;

function causeRank(problem: LaunchProblem): number {
  const base = CAUSE_RANK[problem.code] ?? DEFAULT_CAUSE_RANK;
  // A blocker always outranks something the operator could merely confirm, so a
  // confirmable never headlines over a hard refusal that is present.
  return problem.kind === "blocker" ? base : base + 10;
}

/**
 * The single problem to show as *the* reason, or null when there is none.
 *
 * Never invents a summary: it returns one of the problems already produced, so
 * the headline and the diagnostics list can never disagree.
 */
export function primaryProblem(problems: readonly LaunchProblem[]): LaunchProblem | null {
  let best: LaunchProblem | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const problem of problems) {
    if (problem.kind === "info") continue; // informational, never a cause
    const rank = causeRank(problem);
    if (rank < bestRank) {
      best = problem;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Every problem on a candidate, classified the way §11 of the brief requires:
 * blockers cannot be waved through, reviews are the operator's to confirm, and
 * warnings are informational. The classification comes from which list the
 * domain put the reason in — never from the code's wording.
 */
export function explainLaunchFailure(candidate: {
  blockers: LaunchCandidate["blockers"];
  reviews: LaunchCandidate["reviews"];
  warnings: LaunchCandidate["warnings"];
}): LaunchProblem[] {
  return [
    ...candidate.blockers.map((r) => explainReason(r, "blocker")),
    ...candidate.reviews.map((r) => explainReason(r, "confirmable")),
    ...candidate.warnings.map((r) => explainReason(r, "info"))
  ];
}
