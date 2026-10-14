import assert from "node:assert/strict";
import { test } from "node:test";

import { autoQueueHtml } from "../features/automations/autoQueueView.js";
import { renderAutomations } from "../render/sections.js";

/*
 * «Автоочередь» в разделе «Автоматизации»: сервер решает, настроена ли она при
 * развёртывании, включено ли правило и что она запустила бы сейчас. Экран
 * обязан честно сказать «выключено», показать dry-run и не предлагать
 * «проход» там, где сервер его не сделает.
 */

const STATUS = {
  configured: false,
  armed: false,
  running: false,
  intervalMs: 60000,
  startupDelayMs: 120000,
  maxStartsPerTick: 1,
  retryCooldownMs: 900000,
  startedAt: null,
  lastTickAt: null,
  lastResult: null,
  recent: [],
  cooldowns: [],
  haltedReason: null
};

const PLAN = [
  { taskId: "t1", title: "bracket", outcome: "would_start", printerId: "k2", printerName: "Creality K2", message: "запустилось бы на «Creality K2»", code: null },
  { taskId: "t2", title: "lid", outcome: "waiting", printerId: "a1", printerName: "Bambu A1", message: "Состояние стола неизвестно", code: "BED_STATE_UNKNOWN" },
  { taskId: "t3", title: "toy", outcome: "not_allowed", printerId: null, printerName: null, message: "нет разрешения печатать без оператора", code: "UNATTENDED_NOT_ALLOWED" }
];

test("off at deployment: says so plainly, still shows the dry run, offers no pass", () => {
  const html = autoQueueHtml({ status: STATUS, plan: PLAN, loading: false, error: null, busy: false });
  assert.match(html, /выключена на сервере/);
  assert.match(html, /AUTO_QUEUE_ENABLED=false/);
  assert.match(html, /bracket[\s\S]*запустилось бы/);
  assert.match(html, /lid[\s\S]*ждёт[\s\S]*Состояние стола неизвестно/);
  assert.match(html, /не для автоочереди/);
  assert.doesNotMatch(html, /data-aq-action="tick"/);
});

test("configured and armed: the interval and the per-pass limit are stated; a pass can be run now", () => {
  const html = autoQueueHtml({ status: { ...STATUS, configured: true, armed: true }, plan: [], loading: false, error: null, busy: false });
  assert.match(html, /правило включено/);
  assert.match(html, /Каждые 60 с/);
  assert.match(html, /не больше 1 за проход/);
  assert.match(html, /data-aq-action="tick"/);
  assert.match(html, /нет заданий, ожидающих запуска/);
});

test("a halt is shown with its reason, and recent decisions are listed", () => {
  const html = autoQueueHtml({
    status: {
      ...STATUS,
      configured: true,
      haltedReason: "исход автоматического запуска «bracket» неизвестен",
      recent: [{ ...PLAN[0], outcome: "halted", message: "исход неизвестен" }]
    },
    plan: [],
    loading: false,
    error: null,
    busy: false
  });
  assert.match(html, /останавливала себя: исход автоматического запуска/);
  assert.match(html, /Последние решения[\s\S]*аварийная остановка/);
});

test("a rule the server will not switch on is drawn disabled, with the reason", () => {
  const els = {};
  const fake = (id) => (els[id] ??= { textContent: "", innerHTML: "" });
  const saved = globalThis.document;
  globalThis.document = { querySelector: (sel) => fake(sel.replace(/^#/, "")) };
  try {
    renderAutomations({
      automations: [
        { id: "night-lights", name: "Подсветка", desc: "…", on: true },
        { id: "auto-queue", name: "Автоочередь", desc: "…", on: false, locked: "выключена при развёртывании (AUTO_QUEUE_ENABLED=false)" }
      ],
      automationLastRun: null
    });
  } finally {
    globalThis.document = saved;
  }
  const html = els["auto-body"].innerHTML;
  assert.match(html, /data-id="auto-queue"[\s\S]*?disabled/);
  assert.match(html, /AUTO_QUEUE_ENABLED=false/);
  assert.doesNotMatch(html, /data-id="night-lights"[^>]*disabled/);
});
