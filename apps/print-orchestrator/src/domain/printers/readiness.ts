/**
 * **Can this printer take the next job — and if not, what stands in the way?**
 *
 * The card used to answer with the device's own `idle`, rendered as «Свободен».
 * `idle` is the state of the printer's *program*; it reads exactly the same with
 * a finished part on the plate, with a start command still unconfirmed, with a
 * nozzle change owed, or with a plate nobody has ever confirmed empty. The
 * operator saw «Свободен», pressed start, and the gate (correctly) refused.
 *
 * This is the same set of facts the admission policy reads, reduced to one
 * sentence in priority order — the first thing that would stop a start is the
 * thing shown. It decides nothing: the dispatch gate still re-checks everything.
 */
export type PrinterReadinessState =
  | "setup"
  | "offline"
  | "error"
  | "starting"
  | "held"
  | "printing"
  | "paused"
  /** The printer's adapter only reads telemetry: no job is ever taken. */
  | "monitoring"
  | "needs_clearance"
  | "bed_unknown"
  | "maintenance"
  | "stale"
  | "unknown"
  | "ready";

export interface PrinterReadinessView {
  state: PrinterReadinessState;
  /** One phrase for the badge. */
  label: string;
  /** What is going on / what to do, when there is something to say. */
  detail: string | null;
  /** True only when nothing known stands in the way of a new start. */
  canAcceptJob: boolean;
}

export interface PrinterReadinessInput {
  setupRequired: boolean;
  /**
   * False when the printer's adapter takes no jobs (capability `supportsJobs`).
   * Absent = takes jobs, the answer for every adapter but a monitoring-only one.
   */
  jobsSupported?: boolean;
  online: boolean;
  status: string;
  error: string | null;
  /** The current bed occupancy (`resolveBedOccupancy`), or null when no store is wired. */
  bedState: string | null;
  bedExternal: boolean;
  /** The canonical run holding the printer, if any. */
  activeRun: { state: string; startedAt: string | null; dispatchPhase: string | null; cancelRequested: boolean } | null;
  /** Labels of open blocking manual operations (part removal excluded — the bed covers it). */
  blockingOperations: string[];
  /** ms since the last telemetry update; null when none. */
  telemetryAgeMs: number | null;
  telemetryStaleMs: number;
}

export function describePrinterReadiness(input: PrinterReadinessInput): PrinterReadinessView {
  const no = (state: PrinterReadinessState, label: string, detail: string | null): PrinterReadinessView => ({
    state,
    label,
    detail,
    canAcceptJob: false
  });

  if (input.setupRequired) return no("setup", "Требуется настройка", "заполните параметры подключения принтера");
  if (!input.online) return no("offline", "Нет связи", "принтер не отвечает — его состояние неизвестно");
  if (input.status === "error") return no("error", "Ошибка", input.error);

  const run = input.activeRun;
  if (run && run.startedAt === null && (run.state === "PENDING" || run.state === "UNKNOWN")) {
    if (run.state === "UNKNOWN") {
      return no(
        "held",
        "Запуск не подтверждён",
        "исход последней команды запуска неизвестен — проверьте принтер и отметьте, что произошло"
      );
    }
    return no(
      "starting",
      run.dispatchPhase === "accepted" ? "Запуск принят" : "Запускается",
      run.cancelRequested
        ? "отмена запрошена — ждём, что сообщит принтер"
        : run.dispatchPhase === "accepted"
          ? "принтер принял команду, ждём подтверждения начала печати"
          : "команда запуска отправляется"
    );
  }
  if (input.status === "printing") {
    return no("printing", "Печатает", input.bedExternal ? "печать запущена не через Albedo" : null);
  }
  if (input.status === "paused") return no("paused", "Пауза", null);

  // Ahead of the bed: the plate of a printer that never takes a job is not what
  // stands between it and the next one. The integration is.
  if (input.jobsSupported === false) {
    return no(
      "monitoring",
      "Только наблюдение",
      "принтер подключён для мониторинга — задания на него не назначаются и не запускаются"
    );
  }

  if (input.bedState === "AWAITING_CLEARANCE") {
    return no(
      "needs_clearance",
      "Ждёт снятия детали",
      input.bedExternal
        ? "на столе результат печати, запущенной не через Albedo — снимите модель и подтвердите"
        : "снимите готовую модель и подтвердите, что стол свободен"
    );
  }
  if (input.bedState === "UNKNOWN") {
    return no("bed_unknown", "Стол не подтверждён", "проверьте, что на столе ничего нет, и подтвердите");
  }
  if (input.bedState === "RESERVED" || input.bedState === "RUNNING") {
    return no("held", "Занят", "стол удерживается запуском, исход которого ещё не записан");
  }
  if (input.blockingOperations.length > 0) {
    return no("maintenance", "Требуется операция", input.blockingOperations.join("; "));
  }
  if (input.telemetryAgeMs === null || input.telemetryAgeMs > input.telemetryStaleMs) {
    return no("stale", "Данные устарели", "телеметрия не обновлялась — готовность не подтверждена");
  }
  if (input.status !== "idle") return no("unknown", "Состояние неизвестно", null);
  if (input.bedState === null) {
    // No store wired: the program is idle, and nothing is known about the plate.
    return no("bed_unknown", "Стол не отслеживается", null);
  }
  return { state: "ready", label: "Готов к печати", detail: null, canAcceptJob: true };
}
