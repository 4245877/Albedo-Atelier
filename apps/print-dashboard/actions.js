import { apiPost } from "./api.js";
import {
  initModals,
  openFilesModal,
  openInfoModal,
  openJobForm,
  openLaunchModal,
  openPrinterModal
} from "./render/modals.js";
import { gotoSection } from "./nav.js";
import { confirmAction } from "./shared/dialog.js";
import { esc, setBusy, toast } from "./util.js";

/* ── Действия (реальные вызовы backend) ────────────────────── */

/**
 * Навешивает делегированный обработчик кликов на всю доску: кнопки несут
 * `data-act`/`data-id`, действие выполняется реальным POST-запросом, затем
 * состояние перезагружается через переданный `refresh`. `getState` даёт доступ
 * к текущему снимку фермы для поиска принтера по id.
 */
export function installActions({ getState, refresh }) {
  // Модальные окна (детали принтера, форма задания, справка) используют то же
  // состояние и refresh, что и доска.
  initModals({ getState, refresh });

  // Ключи действий, запросы по которым сейчас выполняются. Защищает от повторных
  // быстрых кликов: пока запрос в полёте, тот же action по тому же принтеру не
  // отправляется второй раз (иначе несколько SET_PIN, спам в ленте и постоянный
  // сброс 5-минутного override).
  const inFlight = new Set();

  /**
   * Выполнить действие, обновить состояние и показать тост об успехе/ошибке.
   * `key` защищает от повторной отправки того же действия, `el` блокирует кнопку
   * на время запроса.
   */
  async function runAction(path, body, okMsg, okKind = "toast-ok", key, el, busyLabel = "Исполняю…") {
    if (key && inFlight.has(key)) return null;
    if (key) inFlight.add(key);
    // Кнопка не просто гаснет, а называет происходящее: немая погашенная
    // кнопка неотличима от недоступной, и оператор жмёт её второй раз.
    const restore = el ? setBusy(el, busyLabel) : () => {};
    try {
      const res = await apiPost(path, body);
      // Тост показываем сразу по ответу backend — ждать полной перерисовки
      // доски незачем: приказ уже принят.
      if (okMsg) toast(okMsg, okKind);
      await refresh();
      return res;
    } catch (err) {
      // Ошибка исполнения — непростительная оплошность; Надзирательница честно
      // докладывает причину, не пряча её за церемониалом.
      toast(`Простите, Владыка — приказ не исполнен: ${esc(err.message)}`, "toast-danger");
      return null;
    } finally {
      if (key) inFlight.delete(key);
      // refresh() перерисовывает доску и заменяет кнопку; снимаем блокировку
      // только если элемент ещё в DOM — иначе состояние задаёт перерисовка.
      restore();
    }
  }

  const actions = {
    open(p) { openPrinterModal(p.id); },

    // Файлы принтера: для Moonraker — настоящий браузер каталога G-code,
    // для остальных протоколов openFilesModal честно объяснит, что не поддержано.
    files(p) { openFilesModal(p.id); },

    pause(p, el) { runAction(`/api/printers/${p.id}/pause`, null, `«${esc(p.name)}» замер по вашему велению, Владыка`, "toast-ok", `pause:${p.id}`, el, "Останавливаю…"); },

    resume(p, el) { runAction(`/api/printers/${p.id}/resume`, null, `«${esc(p.name)}» вновь трудится во славу Владыки`, "toast-ok", `resume:${p.id}`, el, "Возобновляю…"); },

    async cancel(p, el) {
      // Снимок identity берём В МОМЕНТ подтверждения (не после диалога —
      // за это время состояние могло уехать): имя файла + канонический
      // runId. runId ловит даже повторную печать того же файла: backend
      // ответит 409 PRINT_IDENTITY_CONFLICT и ничего не отменит.
      const expectJob = p.job ?? null;
      const expectRunId = p.activeRunId ?? null;
      const ok = await confirmAction({
        title: "Отменить печать",
        object: p.job ? `${p.job} — на «${p.name}»` : `Текущее задание на «${p.name}»`,
        body: "Принтер прекратит работу немедленно, стол и сопло начнут остывать.",
        points: [
          "Начатая деталь будет испорчена — допечатать её с этого места нельзя",
          "Израсходованный материал не вернётся",
          "Задание останется в очереди и его можно будет запустить заново"
        ],
        cta: "Отменить печать",
        tone: "danger",
        irreversible: true
      });
      if (!ok) return;
      runAction(
        `/api/printers/${p.id}/cancel`,
        { job: expectJob, runId: expectRunId },
        `«${esc(p.name)}»: печать отменена — как вы и повелели`,
        "toast-danger",
        `cancel:${p.id}`,
        el,
        "Отменяю…"
      );
    },

    /* Один орган управления вместо пары «Подсветить / Погасить»: состояние
       лампы читается по самому переключателю, а не по тому, какая из двух
       одинаковых кнопок сейчас погашена. */
    light(p, el) {
      const on = p.light !== true; // неизвестное состояние трактуем как «зажечь»
      if (p.light === on) return;
      runAction(
        `/api/printers/${p.id}/light`,
        { on },
        on
          ? `«${esc(p.name)}»: свет зажжён, дабы ничто не укрылось от вашего взора`
          : `«${esc(p.name)}»: свет погашен — тьма к лицу Назарику`,
        "toast-ok",
        `light:${p.id}`,
        el,
        on ? "Зажигаю…" : "Гашу…"
      );
    },

    snapshot(p, el) {
      // Вспышку и тост показываем только после успешного сохранения — при ошибке
      // (камера недоступна, go2rtc не отдал кадр) UI не должен «мигать» успехом.
      runAction(`/api/printers/${p.id}/snapshot`, null, null, "toast-ok", `snapshot:${p.id}`, el, "Снимаю…").then((res) => {
        if (!res) return;
        const flash = document.querySelector(`[data-flash="${p.id}"]`);
        if (flash) {
          flash.classList.remove("go");
          void flash.offsetWidth;
          flash.classList.add("go");
        }
        toast(`«${esc(p.name)}»: снимок запечатлён в архивах Назарика`, "toast-ok");
      });
    },
  };

  function findPrinter(id) {
    const state = getState();
    return state?.printers.find((p) => p.id === id);
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act], [data-goto]");
    if (!el) return;

    const goto = el.dataset.goto;
    if (goto) {
      // Переход сам переключает режим: ссылка в «Оборудование» из Зала обязана
      // открыть «Работы», а не проскроллить к скрытой секции.
      gotoSection(goto);
      return;
    }

    const act = el.dataset.act;

    if (act === "add-job") { openJobForm(); return; }
    if (act === "add-printer") { openInfoModal("add-printer"); return; }
    if (act === "upload-file") { openInfoModal("upload-file"); return; }
    if (act === "settings") { openInfoModal("settings"); return; }
    if (act === "night-pick") {
      runAction("/api/queue/night/pick", null, "Владыка, я избрала достойнейшее задание для ночного бдения", "toast-ok", "night-pick", el, "Подбираю…");
      return;
    }
    if (act === "night-start") {
      // Немутабельный предпросмотр: отправляем ИМЕННО тот кандидат (taskId +
      // версия задания + hash артефакта), который оператор видел в панели.
      // Любой дрейф между предпросмотром и запуском сервер отвергает 409
      // PREVIEW_CONFLICT вместо запуска чего-то невиденного.
      const night = getState()?.night;
      const pick = night?.candidates?.[night?.pick ?? 0];
      const preview = pick?.taskId
        ? {
            taskId: pick.taskId,
            ...(typeof pick.taskVersion === "number" ? { expectedTaskVersion: pick.taskVersion } : {}),
            artifactSha256: pick.artifactSha256 ?? null
          }
        : null;
      runAction("/api/queue/night/start", preview, null, "toast-ok", "night-start", el, "Запускаю…").then((res) => {
        if (res?.candidate) {
          toast(`Ночная печать «${esc(res.candidate.title)}» назначена на ${esc(String(res.window).split(" ")[0])} — я буду бдить, Владыка`, "toast-ok");
        }
      });
      return;
    }
    // Запуск печати из очереди: открывает окно запуска, которое само сходит за
    // готовностью, покажет выбранный принтер и соберёт подтверждения. Ничего не
    // отправляем отсюда — прежняя прямая отправка в /api/queue/start-next
    // стартовала dispatch, ничего не зная ни про подготовку файла, ни про стол.
    if (act === "launch") {
      const taskId = el.dataset.task;
      if (taskId) openLaunchModal(taskId);
      return;
    }
    if (act === "start-next") {
      runAction("/api/queue/start-next", null, null, "toast-ok", "start-next", el, "Запускаю…").then((res) => {
        if (res?.job) toast(`Задание «${esc(res.job.title)}» вверено «${esc(res.job.printer)}» — всё будет исполнено безупречно, Владыка`, "toast-ok");
      });
      return;
    }
    if (act === "rule") {
      // Переключатель — не кнопка с подписью: setBusy подменил бы его разметку,
      // поэтому здесь занятость показывает только атрибут (см. .toggle[aria-busy]).
      runAction(`/api/automations/${el.dataset.id}/toggle`, null, null, "toast-ok", `rule:${el.dataset.id}`, null).then((res) => {
        if (res?.automation) toast(`Правило «${esc(res.automation.name)}» ${res.automation.on ? "приведено в действие" : "остановлено"} по вашей воле`);
      });
      return;
    }

    const printer = findPrinter(el.dataset.id);
    if (printer && actions[act]) actions[act](printer, el);
  });
}
