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

/** The operator-facing form of one refusal reason. */
export function explainReason(reason: CompatibilityReason, kind: ProblemKind): LaunchProblem {
  const t = TRANSLATIONS[reason.code];
  return {
    code: reason.code,
    kind,
    title: t?.title ?? reason.message,
    action: t?.action ?? reason.message,
    technical: `${reason.code}: ${reason.message}`
  };
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
