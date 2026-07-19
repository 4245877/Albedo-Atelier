import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actionAvailability,
  isBusy,
  jobLine,
  lightPolicyLine,
  normalizeProgress,
  progressBarHtml,
  progressPercentText
} from "../render/printerView.js";

/*
 * Чистые view-helpers дашборда (render/printerView.js) — единая логика
 * занятости, строки состояния, доступности действий и progress bar для
 * карточки и модального окна. Файлы дашборда — нативные ES-модули без DOM
 * на верхнем уровне, поэтому тесты выполняются обычным `node --test`
 * (см. package.json дашборда) без браузера и тестового фреймворка.
 */

function printer(overrides = {}) {
  return {
    id: "k2",
    name: "K2",
    status: "idle",
    job: null,
    progress: null,
    minutesLeft: null,
    error: undefined,
    light: null,
    lightSupported: false,
    snapshotAvailable: false,
    filesSupported: false,
    ...overrides
  };
}

test("isBusy: занят только printing и paused", () => {
  assert.equal(isBusy(printer({ status: "printing" })), true);
  assert.equal(isBusy(printer({ status: "paused" })), true);
  for (const status of ["idle", "offline", "error", "unknown"]) {
    assert.equal(isBusy(printer({ status })), false, status);
  }
});

test("jobLine: согласованные тексты всех реальных статусов", () => {
  assert.equal(jobLine(printer({ status: "printing", job: "Кубок" })), "Печатает: <b>Кубок</b>");
  assert.equal(jobLine(printer({ status: "paused", job: "Кубок" })), "Печатает: <b>Кубок</b>");
  assert.equal(
    jobLine(printer({ status: "printing" })),
    "Печатает — название задания не определено"
  );
  assert.equal(jobLine(printer({ status: "idle" })), "Свободен — смиренно ожидает вашего повеления");
  assert.equal(jobLine(printer({ status: "offline" })), "Нет связи с принтером");
  assert.equal(jobLine(printer({ status: "offline", error: "timeout" })), "Нет связи: timeout");
  assert.equal(jobLine(printer({ status: "error" })), '<b class="job-error">Ошибка</b>');
  assert.equal(
    jobLine(printer({ status: "error", error: "MCU shutdown" })),
    '<b class="job-error">MCU shutdown</b>'
  );
  assert.equal(
    jobLine(printer({ status: "unknown" })),
    "Состояние неизвестно — принтер ещё не ответил"
  );
});

test("jobLine: неизвестное значение статуса получает безопасный fallback, а не «Свободен»", () => {
  assert.equal(
    jobLine(printer({ status: "totally-new-status" })),
    "Состояние неизвестно — принтер ещё не ответил"
  );
});

test("jobLine: внешние строки экранируются (имя задания, текст ошибки)", () => {
  assert.equal(
    jobLine(printer({ status: "printing", job: '<img src=x onerror=alert(1)>' })),
    "Печатает: <b>&lt;img src=x onerror=alert(1)&gt;</b>"
  );
  const err = jobLine(printer({ status: "error", error: '<script>"&\'' }));
  assert.ok(!err.includes("<script>"), "HTML в ошибке не должен пройти сырым");
  assert.ok(err.includes("&lt;script&gt;&quot;&amp;&#39;"));
  assert.equal(
    jobLine(printer({ status: "offline", error: "<b>x</b>" })),
    "Нет связи: &lt;b&gt;x&lt;/b&gt;"
  );
});

test("actionAvailability: свободный принтер — только подсветка/снимок по флагам", () => {
  const can = actionAvailability(
    printer({ status: "idle", lightSupported: true, light: false, snapshotAvailable: true })
  );
  assert.equal(can.canPause, false);
  assert.equal(can.canResume, false);
  assert.equal(can.canCancel, false);
  assert.equal(can.canLightOn, true);
  assert.equal(can.canLightOff, false, "свет уже выключен — команда не нужна");
  assert.equal(can.canSnapshot, true);
});

test("actionAvailability: печать/пауза переключают pause↔resume, cancel доступен в обоих", () => {
  const printing = actionAvailability(printer({ status: "printing" }));
  assert.deepEqual(
    [printing.canPause, printing.canResume, printing.canCancel],
    [true, false, true]
  );
  const paused = actionAvailability(printer({ status: "paused" }));
  assert.deepEqual([paused.canPause, paused.canResume, paused.canCancel], [false, true, true]);
});

test("actionAvailability: offline блокирует команды даже при поддержке", () => {
  const can = actionAvailability(
    printer({
      status: "offline",
      lightSupported: true,
      light: null,
      snapshotAvailable: true,
      filesSupported: true
    })
  );
  assert.equal(can.canPause, false);
  assert.equal(can.canResume, false);
  assert.equal(can.canCancel, false);
  assert.equal(can.canLightOn, false);
  assert.equal(can.canLightOff, false);
  assert.equal(can.canSnapshot, false);
  assert.equal(can.canFiles, false, "просмотр поддержан, но принтер не в сети");
});

test("actionAvailability: подсветка управляема только по lightSupported", () => {
  // Состояние света известно, но управление не поддержано — кнопки заблокированы.
  const readOnly = actionAvailability(printer({ status: "idle", lightSupported: false, light: true }));
  assert.equal(readOnly.canLightOn, false);
  assert.equal(readOnly.canLightOff, false);
  // Неизвестное состояние при поддержке: обе команды доступны, флаг lightUnknown поднят.
  const unknown = actionAvailability(printer({ status: "idle", lightSupported: true, light: null }));
  assert.equal(unknown.canLightOn, true);
  assert.equal(unknown.canLightOff, true);
  assert.equal(unknown.lightUnknown, true);
});

test("actionAvailability: «Файлы» кликабельны для неподдерживаемых протоколов (честное объяснение)", () => {
  const can = actionAvailability(printer({ status: "offline", filesSupported: false }));
  assert.equal(can.canFiles, true);
});

test("normalizeProgress: null/undefined/пустая строка/NaN → null; диапазон 0–100", () => {
  assert.equal(normalizeProgress(null), null);
  assert.equal(normalizeProgress(undefined), null);
  assert.equal(normalizeProgress(""), null);
  assert.equal(normalizeProgress("  "), null);
  assert.equal(normalizeProgress("abc"), null);
  assert.equal(normalizeProgress(NaN), null);
  assert.equal(normalizeProgress(Infinity), null);
  assert.equal(normalizeProgress(-5), 0);
  assert.equal(normalizeProgress(146), 100);
  assert.equal(normalizeProgress(42.4), 42.4);
  assert.equal(normalizeProgress("73"), 73, "числовая строка принимается");
});

test("progressBarHtml: одинаковая разметка, ARIA и обрезание диапазона", () => {
  assert.equal(progressBarHtml(null), "", "неизвестный прогресс — без пустой полосы");
  const bar = progressBarHtml(46.55);
  assert.ok(bar.startsWith('<div class="progress "'));
  assert.ok(bar.includes('role="progressbar"'));
  assert.ok(bar.includes('aria-valuenow="47"'));
  assert.ok(bar.includes("scaleX(0.4655)"));
  const over = progressBarHtml(250, { paused: true, style: "margin-top:7px" });
  assert.ok(over.includes("is-paused"));
  assert.ok(over.includes('aria-valuenow="100"'));
  assert.ok(over.includes("scaleX(1.0000)"));
  assert.ok(over.includes('style="margin-top:7px"'));
});

test("progressPercentText: округление и «—» для неизвестного", () => {
  assert.equal(progressPercentText(46.5), "47%");
  assert.equal(progressPercentText(0), "0%");
  assert.equal(progressPercentText(null), "—");
  assert.equal(progressPercentText(""), "—");
});

test("lightPolicyLine: желаемое состояние, причина, время смены и признак резерва", () => {
  assert.equal(lightPolicyLine(null), "", "нет записи (старый payload) — нет строки");
  assert.equal(
    lightPolicyLine({ supported: false, reason: "unsupported" }),
    "Подсветка: не поддерживается"
  );
  assert.equal(
    lightPolicyLine({ supported: true, reason: "unsupported" }),
    "Подсветка: не поддерживается"
  );

  // Время следующего переключения показывается в локальных часах браузера —
  // ожидание строится той же арифметикой, чтобы тест не зависел от TZ.
  const next = new Date(2026, 6, 2, 21, 5, 0);
  const hhmm = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  assert.equal(
    lightPolicyLine({
      supported: true,
      desired: true,
      reason: "solar_dark_active_print",
      nextTransitionAt: next.toISOString(),
      usingFallback: false,
    }),
    `Подсветка: включить · темно, принтер печатает · смена в ${hhmm}`
  );

  assert.equal(
    lightPolicyLine({
      supported: true,
      desired: false,
      reason: "printer_inactive",
      nextTransitionAt: null,
      usingFallback: true,
    }),
    "Подсветка: выключить · принтер неактивен · резервное расписание"
  );

  // Причина fallback_window сама говорит о резерве — суффикс не дублируется.
  assert.equal(
    lightPolicyLine({
      supported: true,
      desired: true,
      reason: "fallback_window",
      nextTransitionAt: null,
      usingFallback: true,
    }),
    "Подсветка: включить · используется резервное расписание"
  );

  // desired == null (автоматика выключена) — без «включить/выключить».
  assert.equal(
    lightPolicyLine({
      supported: true,
      desired: null,
      reason: "automation_disabled",
      nextTransitionAt: null,
      usingFallback: false,
    }),
    "Подсветка: автоматика выключена"
  );

  // Неизвестная причина от нового backend показывается как есть, не ломаясь.
  assert.equal(
    lightPolicyLine({ supported: true, desired: true, reason: "brand_new_reason" }),
    "Подсветка: включить · brand_new_reason"
  );

  // Непарсибельное время просто опускается.
  assert.equal(
    lightPolicyLine({
      supported: true,
      desired: true,
      reason: "monitoring_lease",
      nextTransitionAt: "not-a-date",
      usingFallback: false,
    }),
    "Подсветка: включить · открыта панель мониторинга"
  );
});
