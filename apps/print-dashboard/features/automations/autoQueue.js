/* ── Автоочередь: контроллер ─────────────────────────────────────
   Показывает, что сервер решил бы сейчас, и последние решения. Включение —
   обычный переключатель правила «auto-queue» в списке автоматизаций (сервер
   откажет, если автоочередь выключена при развёртывании); здесь — только
   чтение и «сделать проход сейчас», когда она и разрешена, и включена. */

import { apiGet, apiPost } from "../../api.js";
import { $, esc, toast } from "../../util.js";
import { autoQueueHtml } from "./autoQueueView.js";

const POLL_MS = 15000;

let wired = false;
let timer = null;
let seq = 0;
const vm = { status: null, plan: [], loading: true, error: null, busy: false };

export function setupAutoQueue() {
  const body = $("#auto-queue-body");
  if (!body) return;
  if (!wired) {
    body.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-aq-action]");
      if (!btn || btn.disabled) return;
      if (btn.dataset.aqAction === "refresh") void load();
      if (btn.dataset.aqAction === "tick") void tick();
    });
    // Переключатель правила живёт в общем списке автоматизаций — после него
    // состояние автоочереди меняется; перечитываем, не дожидаясь опроса.
    document.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="rule"][data-id="auto-queue"]')) setTimeout(() => void load(), 600);
    });
    wired = true;
  }
  render();
  void load();
}

async function load() {
  const mine = ++seq;
  try {
    const res = await apiGet("/api/automations/auto-queue");
    if (mine !== seq) return;
    vm.status = res.status || null;
    vm.plan = res.plan || [];
    vm.error = null;
  } catch (err) {
    if (mine !== seq) return;
    vm.error = `Автоочередь не ответила: ${err.message || "причина неизвестна"}`;
  } finally {
    if (mine === seq) {
      vm.loading = false;
      render();
      schedule();
    }
  }
}

async function tick() {
  if (vm.busy) return;
  vm.busy = true;
  render();
  try {
    const res = await apiPost("/api/automations/auto-queue/tick", {}, { timeoutMs: 120000 });
    const r = res.result || {};
    toast(
      r.skipped ? `Проход не выполнен: ${esc(r.skipped)}` : r.started ? `Запущено: ${r.started}` : "Проход выполнен — запускать нечего",
      r.started ? "toast-ok" : ""
    );
  } catch (err) {
    toast(`Проход не выполнен: ${esc(err.message || "причина неизвестна")}`, "toast-danger");
  } finally {
    vm.busy = false;
    await load();
  }
}

function schedule() {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (document.getElementById("automations")?.hidden) schedule();
    else void load();
  }, POLL_MS);
}

function render() {
  const body = $("#auto-queue-body");
  if (body) body.innerHTML = autoQueueHtml(vm);
}
