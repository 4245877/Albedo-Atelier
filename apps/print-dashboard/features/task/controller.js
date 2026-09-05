/* ── Карточка задания: поведение ────────────────────────────────
   Два чтения и одно действие.

   Читает `GET /api/print/tasks/:id` (вся durable-цепочка: файл, анализы,
   варианты слайсинга, запись очереди, назначения, доставка, попытки запуска,
   прогоны, журнал) и `GET /api/print/launch?task=…` (готовность к запуску из
   того же preflight, что и сам запуск). Ничего не вычисляет само: решение о
   готовности принимает сервер, здесь оно только показывается.

   Единственное действие — открыть окно запуска. Диагностика не должна уметь
   больше, чем показать состояние и передать оператора туда, где действие
   действительно совершается. */

import { apiGet } from "../../api.js";
import { esc, toast } from "../../util.js";
import { taskModalHtml } from "./view.js";

export function createTaskController({ mount, onLaunch }) {
  let taskId = null;
  let detail = null;
  let readiness = null;
  let error = null;
  let busy = false;
  /* Порядковый номер открытия: применяем только ответ последнего. Оператор
     успевает открыть второе задание, пока грузится первое. */
  let seq = 0;

  function render() {
    if (!detail) {
      mount(
        error
          ? `<div class="modal-head"><h2 id="modal-title">Задание</h2></div>
             <div class="form-error">${esc(error)}</div>
             <div class="modal-actions"><button type="button" class="btn btn-sm" data-modal-close>Закрыть</button></div>`
          : `<div class="modal-head"><h2 id="modal-title">Задание</h2></div>
             <p class="launch-reason">Читаю цепочку задания…</p>`
      );
      return;
    }
    mount(taskModalHtml(detail, readiness, { busy, error }));
  }

  async function open(id) {
    const mine = ++seq;
    taskId = id;
    detail = null;
    readiness = null;
    error = null;
    render();
    try {
      // Параллельно: цепочка и готовность отвечают на разные вопросы и не
      // зависят друг от друга. Готовность может законно отсутствовать (задание
      // уже вышло из очереди) — это не ошибка окна.
      const [chain, launch] = await Promise.all([
        apiGet(`/api/print/tasks/${encodeURIComponent(id)}`),
        // Готовность ИМЕННО этого задания (`?task=`), а не первая страница
        // очереди с фильтром на клиенте: страница обсчитывает ферму по разу на
        // строку ради одного ответа и для задания за её пределами — или уже
        // ушедшего из очереди — молча возвращает пусто.
        apiGet(`/api/print/launch?task=${encodeURIComponent(id)}`).catch(() => null)
      ]);
      if (mine !== seq) return;
      detail = chain;
      readiness = (launch?.rows || []).find((r) => r.taskId === id) ?? null;
    } catch (err) {
      if (mine !== seq) return;
      error = err?.message || "не удалось прочитать задание";
    }
    render();
  }

  function handleClick(e) {
    if (e.target.closest("[data-task-launch]")) {
      e.preventDefault();
      if (!taskId || busy) return;
      onLaunch(taskId);
      return;
    }
  }

  function reset() {
    seq++;
    taskId = null;
    detail = null;
    readiness = null;
    error = null;
    busy = false;
  }

  return { open, handleClick, reset, taskId: () => taskId };
}
