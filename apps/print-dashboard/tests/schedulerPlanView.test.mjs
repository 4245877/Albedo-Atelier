import assert from "node:assert/strict";
import { test } from "node:test";

import { planHtml } from "../features/scheduler/view.js";

/*
 * Разметка раздела рекомендаций (features/scheduler/view.js).
 *
 * Проверяем ровно то, что оператор обязан увидеть и не имеет права спутать:
 * ручные паузы показаны отдельными отрезками, а не молчаливым пробелом;
 * замороженная часть отличима от перестраиваемой; непоставленные задания
 * несут стабильный код; приблизительная оценка помечена как оценка; и на
 * панели есть обе кнопки — «Пересчитать рекомендации» и ручное подтверждение.
 */

const T0 = Date.parse("2026-07-28T00:00:00.000Z"); // 03:00 MSK — печать закончилась
const T8 = Date.parse("2026-07-28T05:00:00.000Z"); // 08:00 MSK — оператор проснулся
const MIN = 60_000;

function state(over = {}) {
  return {
    queue: [],
    matrix: { printers: [{ id: "p1", name: "P1" }], rows: [] },
    plans: [],
    night: null,
    loaded: true,
    error: null,
    plan: {
      plan: {
        id: "plan_1",
        state: "DRAFT",
        revision: 2,
        confirmedAt: null
      },
      generatedAt: "2026-07-28T00:00:00.000Z",
      frozenUntil: null,
      staleness: { stale: false, reason: null, supersededByPlanId: null },
      assignments: [],
      frozen: [],
      unplaced: [],
      timeline: [
        {
          printerId: "p1",
          name: "P1",
          releaseCode: "AWAITING_OPERATOR",
          releaseReason: "принтер занят до выполнения операции «снятие готовой модели» оператором",
          releaseAtMs: T8 + 5 * MIN,
          waitingForOperator: true,
          segments: [
            { kind: "operator_wait", startMs: T0, endMs: T8, label: "ожидание оператора" },
            {
              kind: "operation",
              startMs: T8,
              endMs: T8 + 5 * MIN,
              label: "снятие готовой модели",
              operationId: "op1"
            },
            { kind: "planned_print", startMs: T8 + 5 * MIN, endMs: T8 + 65 * MIN, label: "Кронштейн", taskId: "t1" }
          ]
        }
      ],
      ...over
    }
  };
}

test("ручная пауза показана отдельным отрезком, а не молчаливым пробелом", () => {
  const html = planHtml(state());
  assert.match(html, /ожидание оператора/);
  assert.match(html, /снятие готовой модели/);
  assert.match(html, /sch-seg-wait/, "простой имеет собственный класс на линии принтера");
  assert.match(html, /sch-seg-op/, "как и ручная операция");
  assert.match(html, /вынужденный простой/, "легенда называет его вынужденным простоем");
});

test("неизвестное время освобождения показывается как неизвестное, а не как «сейчас»", () => {
  const html = planHtml(
    state({
      timeline: [
        {
          printerId: "p1",
          name: "P1",
          releaseCode: "RELEASE_UNKNOWN_DURATION",
          releaseReason: "не задана длительность операции",
          releaseAtMs: null,
          waitingForOperator: true,
          segments: [{ kind: "unknown", startMs: T0, endMs: null, label: "снятие — срок неизвестен" }]
        }
      ]
    })
  );
  assert.match(html, /время освобождения неизвестно/);
  assert.match(html, /конец неизвестен/);
  assert.doesNotMatch(html, /свободен с/, "ничего не обещаем");
});

test("замороженная и перестраиваемая части плана различимы", () => {
  const html = planHtml(
    state({
      frozenUntil: "2026-07-28T07:00:00.000Z",
      assignments: [
        {
          assignment: { taskId: "t2", printerId: "p1", binding: {} },
          task: { title: "Новое" },
          explanation: {
            printerId: "p1",
            reason: "свободен сейчас",
            startMs: T8,
            endMs: T8 + 60 * MIN,
            etaSeconds: 3600,
            etaConfidence: "exact",
            etaSource: "gcode_analysis",
            warnings: [],
            blockers: [],
            manualOperations: [],
            scoreBreakdown: [],
            alternatives: [],
            bedReleaseMs: null,
            bedReleaseEstimated: true,
            frozen: false
          }
        }
      ],
      frozen: [
        {
          assignment: { taskId: "t1", printerId: "p1", binding: {} },
          task: { title: "Подтверждённое" },
          explanation: { printerId: "p1", reason: "", frozen: true, warnings: [], blockers: [], manualOperations: [], scoreBreakdown: [], alternatives: [] }
        }
      ]
    })
  );
  assert.match(html, /заморожено до/);
  assert.match(html, /рекомендация/);
  assert.match(html, /sch-assign(?!-frozen)/);
});

test("непоставленные задания несут стабильный код и явно помеченную оценку", () => {
  const html = planHtml(
    state({
      unplaced: [
        {
          taskId: "t9",
          title: "Без ETA",
          code: "ETA_UNKNOWN",
          reason: "Длительность печати неизвестна",
          hint: {
            approximate: true,
            printerId: "p1",
            startMs: T8,
            endMs: T8 + 4 * 60 * MIN,
            note: "приблизительная оценка (4 ч, допущение планировщика) — не план"
          }
        }
      ]
    })
  );
  assert.match(html, /ETA_UNKNOWN/, "код показан как есть — по нему ищут и группируют");
  assert.match(html, /неизвестна длительность печати/);
  assert.match(html, /не план/, "оценка честно названа оценкой");
});

test("панель предлагает пересчёт и ручное подтверждение — и ничего, что запускает печать", () => {
  const html = planHtml(state());
  assert.match(html, /Пересчитать рекомендации/);
  assert.match(html, /Подтвердить план вручную/);
  assert.doesNotMatch(html, /data-sch-action="(start|dispatch|upload)"/, "никаких команд запуска");
  // Пять понятий разделены явно, чтобы «подтверждено» не читалось как «печатает».
  assert.match(html, /Рекомендация ≠ подтверждённый план ≠ подготовленный файл ≠ разрешение DispatchEligibility ≠ фактический запуск/);
});

test("устаревший план помечен и до пересчёта подтверждать его не предлагается молча", () => {
  const html = planHtml(
    state({ staleness: { stale: true, reason: "есть более новая рекомендация (ревизия 3)", supersededByPlanId: "plan_2" } })
  );
  assert.match(html, /План устарел/);
  assert.match(html, /более новая рекомендация/);
});
