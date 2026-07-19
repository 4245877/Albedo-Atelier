import { apiPost } from "./api.js";
import {
  initModals,
  openFilesModal,
  openInfoModal,
  openJobForm,
  openPrinterModal
} from "./render/modals.js";
import { setActiveNav } from "./nav.js";
import { esc, toast } from "./util.js";

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
  async function runAction(path, body, okMsg, okKind = "toast-ok", key, el) {
    if (key && inFlight.has(key)) return null;
    if (key) inFlight.add(key);
    if (el) el.disabled = true;
    try {
      const res = await apiPost(path, body);
      await refresh();
      if (okMsg) toast(okMsg, okKind);
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
      if (el && el.isConnected) el.disabled = false;
    }
  }

  const actions = {
    open(p) { openPrinterModal(p.id); },

    // Файлы принтера: для Moonraker — настоящий браузер каталога G-code,
    // для остальных протоколов openFilesModal честно объяснит, что не поддержано.
    files(p) { openFilesModal(p.id); },

    pause(p, el) { runAction(`/api/printers/${p.id}/pause`, null, `«${esc(p.name)}» замер по вашему велению, Владыка ⏸`, "toast-ok", `pause:${p.id}`, el); },

    resume(p, el) { runAction(`/api/printers/${p.id}/resume`, null, `«${esc(p.name)}» вновь трудится во славу Владыки ▶`, "toast-ok", `resume:${p.id}`, el); },

    cancel(p, el) {
      const jobLabel = p.job ? `«${p.job}»` : "текущего задания";
      // Снимок identity берём В МОМЕНТ подтверждения (не после confirm —
      // за время диалога состояние могло уехать): имя файла + канонический
      // runId. runId ловит даже повторную печать того же файла: backend
      // ответит 409 PRINT_IDENTITY_CONFLICT и ничего не отменит.
      const expectJob = p.job ?? null;
      const expectRunId = p.activeRunId ?? null;
      if (!window.confirm(`Владыка, вы повелеваете отменить печать ${jobLabel} на «${p.name}»? Ваше слово — закон.`)) return;
      runAction(
        `/api/printers/${p.id}/cancel`,
        { job: expectJob, runId: expectRunId },
        `«${esc(p.name)}»: печать отменена — как вы и повелели`,
        "toast-danger",
        `cancel:${p.id}`,
        el
      );
    },

    "light-on"(p, el) {
      // Целевое состояние уже достигнуто — не шлём команду и не засоряем ленту.
      if (p.light === true) return;
      runAction(`/api/printers/${p.id}/light`, { on: true }, `«${esc(p.name)}»: свет зажжён, дабы ничто не укрылось от вашего взора ☀`, "toast-ok", `light:${p.id}`, el);
    },

    "light-off"(p, el) {
      if (p.light === false) return;
      runAction(`/api/printers/${p.id}/light`, { on: false }, `«${esc(p.name)}»: свет погашен — тьма к лицу Назарику ☾`, "toast-ok", `light:${p.id}`, el);
    },

    snapshot(p, el) {
      // Вспышку и тост показываем только после успешного сохранения — при ошибке
      // (камера недоступна, go2rtc не отдал кадр) UI не должен «мигать» успехом.
      runAction(`/api/printers/${p.id}/snapshot`, null, null, "toast-ok", `snapshot:${p.id}`, el).then((res) => {
        if (!res) return;
        const flash = document.querySelector(`[data-flash="${p.id}"]`);
        if (flash) {
          flash.classList.remove("go");
          void flash.offsetWidth;
          flash.classList.add("go");
        }
        toast(`«${esc(p.name)}»: снимок запечатлён в архивах Назарика ◉`, "toast-ok");
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
      const target = document.getElementById(goto);
      if (target) {
        setActiveNav(goto); // мгновенная подсветка «вы здесь», далее ведёт scroll-spy
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const act = el.dataset.act;

    if (act === "add-job") { openJobForm(); return; }
    if (act === "add-printer") { openInfoModal("add-printer"); return; }
    if (act === "upload-file") { openInfoModal("upload-file"); return; }
    if (act === "settings") { openInfoModal("settings"); return; }
    if (act === "night-pick") {
      runAction("/api/queue/night/pick", null, "Владыка, я избрала достойнейшее задание для ночного бдения ☾", "toast-ok", "night-pick", el);
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
      runAction("/api/queue/night/start", preview, null, "toast-ok", "night-start", el).then((res) => {
        if (res?.candidate) {
          toast(`Ночная печать «${esc(res.candidate.title)}» назначена на ${esc(String(res.window).split(" ")[0])} — я буду бдить, Владыка ☾`, "toast-ok");
        }
      });
      return;
    }
    if (act === "start-next") {
      runAction("/api/queue/start-next", null, null, "toast-ok", "start-next", el).then((res) => {
        if (res?.job) toast(`Задание «${esc(res.job.title)}» вверено «${esc(res.job.printer)}» — всё будет исполнено безупречно, Владыка`, "toast-ok");
      });
      return;
    }
    if (act === "rule") {
      runAction(`/api/automations/${el.dataset.id}/toggle`, null, null, "toast-ok", `rule:${el.dataset.id}`, el).then((res) => {
        if (res?.automation) toast(`Правило «${esc(res.automation.name)}» ${res.automation.on ? "приведено в действие" : "остановлено"} по вашей воле`);
      });
      return;
    }

    const printer = findPrinter(el.dataset.id);
    if (printer && actions[act]) actions[act](printer, el);
  });
}
