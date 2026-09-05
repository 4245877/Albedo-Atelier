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
  /**
   * The confirmation code whose tick makes the server *do* something that
   * resolves this (write a bed-clear cycle, record a material assertion), rather
   * than waive it. Present exactly when the launch screen must show a checkbox
   * instead of the "under my responsibility" block.
   */
  confirmation?: string;
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
  },

  // ── Codes with no preflight ancestor ──────────────────────────────────────
  // These only ever came from the dispatch gate, which the preview did not run.
  // Every one of them was therefore invisible until the operator had already
  // confirmed a launch — several of them after the file had been uploaded.
  TARGET_PRINTER_MISMATCH: {
    title: "Файл собран для другого принтера",
    action:
      "G-code сам называет машину, под которую он нарезан, и это не выбранный принтер. " +
      "Выберите тот принтер, для которого файл нарезан, или нарежьте модель заново."
  },
  TARGET_PRINTER_UNKNOWN: {
    title: "Не с чем сверить целевой принтер",
    action: "Файл называет целевую машину, а у принтера не заполнена модель. Укажите модель в настройках принтера."
  },
  REMOTE_START_UNSUPPORTED: {
    title: "Удалённый запуск не поддерживается",
    action:
      "Адаптер этого принтера умеет только читать состояние — он не может ни передать файл, " +
      "ни начать печать. Запустите файл с экрана принтера, либо выберите другой принтер."
  },
  ANALYSIS_VERDICT: {
    title: "Файл не подтверждён к запуску",
    action:
      "Анализ отметил файл как требующий проверки. Откройте его в списке загрузок, " +
      "прочитайте причину и подтвердите её — после этого запуск станет возможен."
  },
  ANALYSIS_BLOCKERS: {
    title: "Анализ нашёл критические проблемы",
    action: "Файл нельзя печатать в текущем виде — причины перечислены в разделе загрузок."
  },
  ANALYSIS_IN_PROGRESS: {
    title: "Анализ ещё идёт",
    action: "Дождитесь окончания анализа файла — до него запуск невозможен."
  },
  ANALYSIS_FAILED: {
    title: "Анализ не удался",
    action: "Перезапустите анализ файла в разделе загрузок."
  },
  ANALYSIS_STALE: {
    title: "Файл изменился после анализа",
    action: "Перезапустите анализ — запускать можно только проанализированное содержимое."
  },
  ANALYZER_OUTDATED: {
    title: "Анализ выполнен старой версией",
    action: "Перезапустите анализ файла — правила проверки с тех пор изменились."
  },
  FORMAT_MISMATCH: {
    title: "Содержимое не совпадает с расширением",
    action: "Файл называется одним, а внутри другое. Загрузите правильный файл."
  },
  FORMAT_UNKNOWN: {
    title: "Формат файла не распознан",
    action: "Содержимое не похоже ни на один поддерживаемый формат. Проверьте, что файл не повреждён."
  },
  NO_FILE: {
    title: "У задания нет файла",
    action: "Задание ни на что не ссылается. Загрузите файл и поставьте его в очередь."
  },
  BAD_FILE_PATH: {
    title: "Недопустимый путь файла",
    action: "Имя файла на устройстве не проходит проверку. Подготовьте файл заново."
  },
  TASK_STATE: {
    title: "Задание не в очереди",
    action: "Запускать можно только задание, стоящее в очереди. Поставьте его в очередь."
  },
  ENTRY_STATE: {
    title: "Запись очереди не ожидает запуска",
    action: "Задание отложено или уже покинуло очередь. Верните его в очередь."
  },
  NO_QUEUE_ENTRY: {
    title: "Задания нет в очереди",
    action: "Поставьте файл в очередь — из черновика печать не запускается."
  },
  PRINTER_NOT_IDLE: {
    title: "Состояние принтера не подтверждено",
    action: "Принтер не сообщает, что он свободен. Дождитесь подтверждённого простоя."
  },
  ACTIVE_RUN_EXISTS: {
    title: "На принтере уже есть печать",
    action: "Дождитесь завершения текущей печати или разберитесь с ней."
  },
  UNRESOLVED_DISPATCH: {
    title: "Есть неподтверждённый запуск",
    action: "Посмотрите на принтер и отметьте, что произошло с прошлым запуском."
  },
  MANUAL_OPERATION_REQUIRED: {
    title: "Нужна ручная операция",
    action: "На принтере есть незакрытая обязательная работа. Выполните её и отметьте выполненной."
  },
  OPERATOR_INTERVENTION_REQUIRED: {
    title: "Нужно вмешательство оператора",
    action: "Снимите модель со стола или замените пластину, затем подтвердите, что стол свободен."
  },
  OPERATOR_UNAVAILABLE: {
    title: "Оператор недоступен",
    action: "Обязательную операцию сейчас некому выполнить — автоматическое продолжение очереди запрещено."
  },
  OPERATOR_SCHEDULE_UNKNOWN: {
    title: "Расписание оператора не разобрано",
    action: "Заполните расписание смен — без него автоматическое продолжение очереди запрещено."
  },
  DEVICE_FILE_STALE: {
    title: "Подготовленный файл устарел",
    action: "На принтере лежит файл от другой сборки задания. Подготовьте файл заново."
  },
  DEVICE_FILE_INVALID: {
    title: "Передача файла не удалась",
    action: "Повторите подготовку файла — то, что лежит на принтере, не прошло проверку."
  },
  DEVICE_TRANSFER_NOT_CONFIRMED: {
    title: "Файл не передан на принтер",
    action: "Файл ещё не доставлен. Повторите запуск — доставка выполняется сервером."
  },
  DEVICE_FILE_MISSING: {
    title: "Файла нет на принтере",
    action: "Повторите запуск: сервер передаст файл заново."
  },
  ASSIGNMENT_STALE: {
    title: "Назначение устарело",
    action: "Задание изменилось после назначения. Снимите назначение и запустите заново."
  },
  ASSIGNMENT_NOT_CONFIRMED: {
    title: "Назначение не подтверждено",
    action: "Подтвердите план или назначьте принтер вручную."
  },
  ASSIGNMENT_PRINTER_MISMATCH: {
    title: "Принтер расходится с планом",
    action: "Подтверждённый план называет другой принтер. Перепланируйте или снимите назначение."
  },
  PROFILE_REVISION_MISMATCH: {
    title: "Профили изменились после подтверждения",
    action: "Набор профилей задания больше не тот, с которым оно подтверждалось. Пересоберите нарезку."
  },
  SLICE_VARIANT_MISMATCH: {
    title: "Слайс не тот, что подтверждали",
    action: "Задание пересобрано другим вариантом нарезки. Перепланируйте."
  },
  ARTIFACT_HASH_MISMATCH: {
    title: "Содержимое файла изменилось",
    action: "Файл не тот, что подтверждали. Загрузите и подготовьте его заново."
  },
  ARTIFACT_MISSING: {
    title: "У задания нет файла",
    action: "Загрузите файл и поставьте его в очередь."
  },
  ARTIFACT_HASH_MISSING: {
    title: "У файла нет контрольной суммы",
    action: "Идентичность файла недоказуема — загрузите его заново."
  },
  MAINTENANCE_BLOCKED: {
    title: "Принтер на обслуживании",
    action: "Завершите обслуживание, чтобы вернуть принтер в работу."
  },
  NOT_NIGHT_FLAGGED: {
    title: "Задание не помечено для ночного запуска",
    action: "Выберите «ночью» в параметрах планирования задания."
  },
  UNATTENDED_NOT_ALLOWED: {
    title: "Печать без присмотра не разрешена",
    action: "Разрешите unattended-печать в параметрах задания, если готовы оставить её без оператора."
  },
  PREFLIGHT_REASON_UNMAPPED: {
    title: "Непонятная причина отказа",
    action: "Система получила код отказа, который не умеет объяснять. Сообщите об этом — запуск заблокирован намеренно."
  },

  // ── Dispatch twins of preflight reasons ───────────────────────────────────
  // Most dispatch codes reach the operator carrying their preflight ancestor,
  // and are worded through it. These are the ones the dispatch layer *also*
  // raises on its own — the bed rules, the device-state re-check, the delivery
  // and the night arithmetic have no preflight counterpart at all — so without
  // an entry of their own they would fall through to the engine's message.
  BED_NOT_CLEAR: {
    title: "Стол не свободен",
    action: "Снимите готовую деталь с площадки и подтвердите, что стол пуст."
  },
  BED_STATE_UNKNOWN: {
    title: "Состояние стола неизвестно",
    action: "Система не знает, что на столе. Проверьте площадку и подтвердите, что она пуста."
  },
  AUTOMATIC_CONTINUATION_NOT_SUPPORTED: {
    title: "Автопродолжение очереди не поддержано",
    action: "У принтера нет подтверждённой автоматической очистки стола — очередь продолжит человек."
  },
  PRINTER_OFFLINE: {
    title: "Принтер не в сети",
    action: "Принтер не отвечает. Проверьте питание и подключение."
  },
  PRINTER_BUSY: {
    title: "Принтер занят",
    action: "Сейчас идёт другая печать — запуск станет возможен после её завершения."
  },
  PRINTER_ERROR: {
    title: "Принтер сообщает об ошибке",
    action: "Посмотрите экран принтера и устраните ошибку."
  },
  PRINTER_FAULT: { title: "Принтер сообщает об ошибке", action: "" },
  PRINTER_MEDIA_MISSING: {
    title: "Принтер не видит карту памяти",
    action: "Переустановите или замените карту памяти, затем повторите запуск."
  },
  LAUNCH_UNCONFIRMED: {
    title: "Прошлый запуск не подтверждён",
    action: "Посмотрите на принтер и отметьте, что произошло, — после этого запуск снова возможен."
  },
  TELEMETRY_STALE: {
    title: "Нет свежих данных от принтера",
    action: "Последний ответ пришёл давно. Проверьте связь с принтером."
  },
  TELEMETRY_MISSING: {
    title: "Принтер ещё не отвечал",
    action: "Данных о состоянии нет. Дождитесь первого ответа или проверьте подключение."
  },
  BUILD_VOLUME_EXCEEDED: {
    title: "Модель не помещается",
    action: "Габариты детали больше рабочей области принтера. Выберите принтер побольше."
  },
  MODEL_OFF_BED: {
    title: "Модель стоит за пределами стола",
    action: "Файл размещает деталь вне рабочей области — нарежьте модель заново для этого принтера."
  },
  BUILD_VOLUME_UNKNOWN: {
    title: "Рабочая область неизвестна",
    action: "Укажите размеры стола в настройках принтера."
  },
  DIMENSIONS_UNKNOWN: {
    title: "Габариты модели неизвестны",
    action: "Анализ не определил размеры детали. Перезапустите анализ."
  },
  MODEL_SCALE_UNKNOWN: {
    title: "Масштаб модели не подтверждён",
    action: "STL не содержит единиц измерения — подтвердите масштаб в разделе загрузок."
  },
  NOZZLE_MISMATCH: {
    title: "Не то сопло",
    action: "Диаметр сопла не совпадает с тем, под который нарезана модель. Смените сопло или принтер."
  },
  NOZZLE_UNKNOWN: {
    title: "Диаметр сопла неизвестен",
    action: "Укажите диаметр сопла в настройках принтера."
  },
  MATERIAL_MISMATCH: {
    title: "Не тот материал",
    action: "Заправленный пруток не совпадает с материалом задания. Замените катушку или выберите другой принтер."
  },
  MATERIAL_UNKNOWN: {
    title: "Материал неизвестен",
    action: "Не задан материал задания или принтер не сообщает загруженный пруток. Подтвердите материал."
  },
  AMS_UNSUPPORTED: {
    title: "Нужен AMS",
    action: "Заданию нужна многоматериальная подача, которой у принтера нет."
  },
  AMS_UNKNOWN: {
    title: "Поддержка AMS неизвестна",
    action: "Укажите в настройках принтера, есть ли у него многоматериальная подача."
  },
  AMS_MAPPING_AMBIGUOUS: {
    title: "Не определено, какой филамент в какой слот",
    action: "Нарежьте под один материал или подтвердите запуск вручную."
  },
  GCODE_FLAVOR_MISMATCH: {
    title: "Файл собран под другую прошивку",
    action: "Этот G-code нельзя запустить здесь. Нарежьте модель заново для этого принтера."
  },
  PROFILE_SET_NOT_APPROVED: {
    title: "Профиль печати не утверждён",
    action: "Утвердите набор профилей для этого принтера перед запуском."
  },
  PROFILE_SET_QUARANTINED: {
    title: "Профиль печати заблокирован",
    action: "Набор профилей помечен как непроверенный. Проверьте его в разделе профилей."
  },
  SLICE_VARIANT_MISSING: {
    title: "Модель ещё не нарезана",
    action: "Для этого принтера нет готового G-code. Запустите нарезку."
  },
  SLICING_UNAVAILABLE: {
    title: "Нарезка недоступна",
    action: "Слайсер сейчас не запущен — нарезать модель не получится."
  },
  DEVICE_FILE_NOT_VERIFIED: {
    title: "Файл на принтере не проверен",
    action: "Не удалось убедиться, что файл долетел целиком. Повторите запуск — это безопасно."
  },
  ANALYSIS_MISSING: {
    title: "Нет завершённого анализа",
    action: "Запустите анализ файла — без него печать без присмотра запрещена."
  },
  PINNED_ELSEWHERE: {
    title: "Задание закреплено за другим принтером",
    action: "Открепите задание или выберите принтер, за которым оно закреплено."
  },
  NIGHT_WINDOW_TOO_SHORT: {
    title: "Печать не помещается в ночное окно",
    action: "До конца ночного окна времени меньше, чем нужно на печать. Запустите её днём или сократите задание."
  },
  NIGHT_WINDOW_UNKNOWN: {
    title: "Ночное окно не разобрано",
    action: "Проверьте настройку ночного окна и таймзоны фермы."
  },
  UNKNOWN_ETA: {
    title: "Длительность печати неизвестна",
    action: "Без оценки времени ночное окно проверить нельзя. Перезапустите анализ файла."
  }
};

/** The codes this layer has operator language for — iterated by the exhaustive test. */
export const TRANSLATED_CODES: ReadonlySet<string> = new Set(Object.keys(TRANSLATIONS));

/**
 * The operator-facing form of one refusal reason.
 *
 * Takes a bare `{code, message}` rather than a compatibility reason: this
 * layer also translates codes the launch flow raises itself (`UPLOAD_FAILED`,
 * `START_REJECTED`, `device_file_unverified`), which are not part of the
 * preflight vocabulary. It must stay total for any code — an unmapped one falls
 * through with its own message rather than a generic apology.
 */
export function explainReason(
  reason: {
    code: string;
    message: string;
    /** The lower-case preflight code this was lifted from, when it was. */
    preflightCode?: string;
    /** Decided by the domain; never re-derived here. */
    overridable?: boolean;
    /** The confirmation whose tick causes the server action that resolves it. */
    confirmation?: string;
  },
  kind: ProblemKind
): LaunchProblem {
  // Two vocabularies reach here. The dispatch contract's SCREAMING_SNAKE codes
  // are what the UI, the audit trail and the tests key off, so `code` stays one
  // of those; but the *wording* an operator needs was written against the
  // preflight codes, and a reason lifted from preflight carries its original.
  // Preferring it keeps every existing translation live and lets one dispatch
  // code (`MATERIAL_UNKNOWN`) still say the two different things its two sources
  // mean — "материал задания не задан" vs "принтер не сообщает пруток".
  const t = TRANSLATIONS[reason.preflightCode ?? ""] ?? TRANSLATIONS[reason.code];
  return {
    code: reason.code,
    kind,
    // Whether a human may accept this was decided by `NON_OVERRIDABLE` in the
    // domain and travels with the reason. Re-deriving it here (by mapping the
    // code a second time) is how the screen used to offer a checkbox the gate
    // would then refuse — and, once the codes became SCREAMING_SNAKE, how every
    // one of them would have silently become non-overridable.
    overridable: kind === "confirmable" && reason.overridable === true,
    ...(reason.confirmation ? { confirmation: reason.confirmation } : {}),
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
  build_volume_unknown: 7,

  // ── Dispatch-contract codes ────────────────────────────────────────────────
  // The preview now runs the whole eligibility, so reasons that have no
  // preflight ancestor arrive here under their own names. Ranked by the same
  // rule: a fact about the FILE or the ADAPTER explains the device state that
  // follows from it, never the other way round.
  TARGET_PRINTER_MISMATCH: 2,
  TARGET_PRINTER_UNKNOWN: 2,
  GCODE_FLAVOR_MISMATCH: 2,
  REMOTE_START_UNSUPPORTED: 2,
  ANALYSIS_VERDICT: 2,
  ANALYSIS_BLOCKERS: 2,
  ANALYSIS_FAILED: 2,
  ANALYSIS_IN_PROGRESS: 2,
  FORMAT_MISMATCH: 2,
  FORMAT_UNKNOWN: 2,
  NO_FILE: 2,
  NO_QUEUE_ENTRY: 2,
  TASK_STATE: 2,
  ENTRY_STATE: 2,
  ASSIGNMENT_STALE: 2,
  ASSIGNMENT_PRINTER_MISMATCH: 2,
  PROFILE_REVISION_MISMATCH: 2,
  ACTIVE_RUN_EXISTS: 1,
  UNRESOLVED_DISPATCH: 1,
  PRINTER_FAULT: 0,
  PRINTER_MEDIA_MISSING: 0,
  LAUNCH_UNCONFIRMED: 1,
  PRINTER_OFFLINE: 4,
  PRINTER_ERROR: 5,
  PRINTER_BUSY: 6,
  PRINTER_NOT_IDLE: 6,
  TELEMETRY_STALE: 6,
  TELEMETRY_MISSING: 6,
  NOZZLE_UNKNOWN: 7,
  MATERIAL_UNKNOWN: 7,
  BUILD_VOLUME_UNKNOWN: 7,
  BED_STATE_UNKNOWN: 7,
  BED_NOT_CLEAR: 3,
  OPERATOR_INTERVENTION_REQUIRED: 8
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
