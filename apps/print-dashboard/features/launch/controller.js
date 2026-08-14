/* ── Запуск печати: поведение окна ──────────────────────────────
   Одно окно на весь сценарий: открылось — показало, что и куда поедет,
   собрало физические подтверждения, отправило ОДИН запрос.

   Порядок шагов (назначение → загрузка файла → подтверждение стола → старт)
   принадлежит backend: POST /api/print/launch/:taskId делает всё сам. Раньше
   этот порядок пытался воспроизводить браузер — и не воспроизводил, из-за чего
   кнопка «Запустить» дергала dispatch до того, как файл вообще оказывался на
   принтере. Здесь сознательно НЕТ последовательности вызовов: есть намерение и
   набор галочек. */

import { apiGet, apiPost } from "../../api.js";
import { esc, toast } from "../../util.js";
import { launchModalHtml } from "./view.js";

/* Ключ идемпотентности живёт столько же, сколько попытка запуска ОДНОЙ задачи.
   Он создаётся при открытии окна, а не при клике: повторный клик, двойной клик и
   повтор после потерянного ответа шлют один и тот же ключ, и backend возвращает
   тот же самый run вместо второй печати. */
function newIdempotencyKey(taskId) {
  const rand =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `launch:${taskId}:${rand}`;
}

export function createLaunchController({ getContent, refresh, close }) {
  let session = null;

  function render() {
    if (!session) return;
    getContent().innerHTML = launchModalHtml(session.preview, session.ui);
  }

  async function load(taskId, printerId) {
    const q = printerId ? `?printer=${encodeURIComponent(printerId)}` : "";
    const res = await apiGet(`/api/print/launch/${encodeURIComponent(taskId)}${q}`);
    return res.preview;
  }

  async function open(taskId) {
    session = {
      taskId,
      idempotencyKey: newIdempotencyKey(taskId),
      preview: null,
      ui: {
        mode: "auto",
        selectedPrinterId: null,
        confirmed: new Set(),
        busy: false,
        error: null,
        done: null
      }
    };
    getContent().innerHTML = `
      <div class="modal-head"><h2 id="modal-title">Запуск печати</h2></div>
      <div class="launch-loading">Проверяю принтеры…</div>`;
    try {
      const preview = await load(taskId);
      if (!session || session.taskId !== taskId) return; // окно уже сменили
      session.preview = preview;
      session.ui.selectedPrinterId = preview.recommendedPrinterId;
      render();
    } catch (err) {
      getContent().innerHTML = `
        <div class="modal-head"><h2 id="modal-title">Запуск печати</h2></div>
        <div class="form-error">${esc(err.message || "Не удалось получить состояние задания")}</div>
        <div class="modal-actions"><button type="button" class="btn btn-sm" data-modal-close>Закрыть</button></div>`;
    }
  }

  /** Перечитывает preview под выбранный принтер (у него свои подтверждения). */
  async function reselect(printerId) {
    if (!session) return;
    session.ui.selectedPrinterId = printerId;
    // Подтверждения относятся к КОНКРЕТНОМУ принтеру: у нового может не быть
    // вопроса про стол, а у старого — быть. Ранее поставленные галочки не
    // переносим, иначе оператор подтвердит одно, а запустит на другом.
    session.ui.confirmed = new Set();
    render();
    try {
      const preview = await load(session.taskId, printerId);
      if (!session) return;
      session.preview = preview;
      render();
    } catch {
      /* Показываем прежний preview: список принтеров всё ещё верен. */
    }
  }

  async function launch() {
    if (!session || session.ui.busy) return;
    const { preview, ui } = session;
    const candidate = preview.candidates.find((c) => c.printerId === ui.selectedPrinterId);
    if (!candidate) return;

    // Блокируем НЕМЕДЛЕННО и перерисовываем до await: между кликом и ответом
    // сервера кнопка не должна принимать второй клик.
    ui.busy = true;
    ui.error = null;
    render();

    try {
      const res = await apiPost(`/api/print/launch/${encodeURIComponent(session.taskId)}`, {
        printerId: candidate.printerId,
        confirmations: [...ui.confirmed],
        idempotencyKey: session.idempotencyKey
      });
      if (!session) return;
      ui.busy = false;
      ui.done = { printerName: res.printerName || candidate.printerName };
      render();
      toast(
        `Печать «${esc(preview.displayTitle)}» запущена на «${esc(ui.done.printerName)}» ▶`,
        "toast-ok"
      );
      await refresh();
    } catch (err) {
      if (!session) return;
      ui.busy = false;
      ui.error = err.message || "Запуск не удался";
      // Состояние могло измениться именно из-за отказа (стол, занятость) —
      // перечитываем, чтобы окно показывало актуальные причины, а не прежние.
      try {
        session.preview = await load(session.taskId, ui.selectedPrinterId);
      } catch {
        /* оставляем прежний preview */
      }
      render();
    }
  }

  /** Делегированные клики внутри окна запуска. */
  function handleClick(e) {
    if (!session) return false;

    const modeBtn = e.target.closest("[data-launch-mode]");
    if (modeBtn) {
      session.ui.mode = modeBtn.dataset.launchMode;
      render();
      return true;
    }

    const go = e.target.closest("[data-launch-go]");
    if (go && !go.disabled) {
      launch();
      return true;
    }

    return false;
  }

  /** Изменения радиокнопок принтера и галочек подтверждения. */
  function handleChange(e) {
    if (!session) return false;

    const pick = e.target.closest("[data-launch-pick]");
    if (pick) {
      reselect(pick.value);
      return true;
    }

    const confirm = e.target.closest("[data-launch-confirm]");
    if (confirm) {
      if (confirm.checked) session.ui.confirmed.add(confirm.value);
      else session.ui.confirmed.delete(confirm.value);
      render();
      return true;
    }

    return false;
  }

  function reset() {
    session = null;
  }

  return { open, handleClick, handleChange, reset, isOpen: () => session !== null, close };
}
