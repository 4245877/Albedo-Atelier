import { apiPost } from "./api.js";
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
  /** Выполнить действие, обновить состояние и показать тост об успехе/ошибке. */
  async function runAction(path, body, okMsg, okKind = "toast-ok") {
    try {
      const res = await apiPost(path, body);
      await refresh();
      if (okMsg) toast(okMsg, okKind);
      return res;
    } catch (err) {
      toast(esc(err.message), "toast-danger");
      return null;
    }
  }

  const actions = {
    open(p) { toast(`Открываю страницу принтера «${esc(p.name)}» — раздел в разработке`); },

    pause(p) { runAction(`/api/printers/${p.id}/pause`, null, `«${esc(p.name)}»: печать поставлена на паузу`); },

    resume(p) { runAction(`/api/printers/${p.id}/resume`, null, `«${esc(p.name)}»: печать продолжена`); },

    cancel(p) {
      const jobLabel = p.job ? `«${p.job}»` : "текущего задания";
      if (!window.confirm(`Отменить печать ${jobLabel} на ${p.name}?`)) return;
      runAction(`/api/printers/${p.id}/cancel`, null, `«${esc(p.name)}»: печать отменена`, "toast-danger");
    },

    "light-on"(p) { runAction(`/api/printers/${p.id}/light`, { on: true }, `«${esc(p.name)}»: подсветка включена ☀`); },

    "light-off"(p) { runAction(`/api/printers/${p.id}/light`, { on: false }, `«${esc(p.name)}»: подсветка выключена ☾`); },

    snapshot(p) {
      const flash = document.querySelector(`[data-flash="${p.id}"]`);
      if (flash) {
        flash.classList.remove("go");
        void flash.offsetWidth;
        flash.classList.add("go");
      }
      runAction(`/api/printers/${p.id}/snapshot`, null, `«${esc(p.name)}»: снимок сохранён ◉`);
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

    if (act === "goto-page") {
      toast(`Раздел «${el.dataset.page}» ещё в разработке`);
      return;
    }
    if (act === "night-pick") {
      runAction("/api/queue/night/pick", null, "Подобрано следующее безопасное задание на ночь ☾");
      return;
    }
    if (act === "night-start") {
      runAction("/api/queue/night/start", null, null).then((res) => {
        if (res?.candidate) {
          toast(`Ночная печать «${esc(res.candidate.title)}» запланирована на ${esc(String(res.window).split(" ")[0])}`, "toast-ok");
        }
      });
      return;
    }
    if (act === "start-next") {
      runAction("/api/queue/start-next", null, null).then((res) => {
        if (res?.job) toast(`Задание «${esc(res.job.title)}» отправлено на ${esc(res.job.printer)}`, "toast-ok");
      });
      return;
    }
    if (act === "rule") {
      runAction(`/api/automations/${el.dataset.id}/toggle`, null, null).then((res) => {
        if (res?.automation) toast(`Правило «${esc(res.automation.name)}» ${res.automation.on ? "включено" : "выключено"}`);
      });
      return;
    }

    const printer = findPrinter(el.dataset.id);
    if (printer && actions[act]) actions[act](printer);
  });
}
