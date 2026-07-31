import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPrinterPayload } from "../features/printers/formModel.js";

/*
 * Преобразование формы принтера в тело запроса. Проверяем прежде всего то
 * единственное правило, ошибка в котором стоила бы связи с принтером:
 * пустое поле учётных данных означает «не менять», а не «стереть».
 *
 * Backend секретов не отдаёт, поэтому поля кода доступа и серийного номера
 * ВСЕГДА приходят пустыми. Если бы отправка формы клала в них пустую строку,
 * любое сохранение настроек молча обнуляло бы код доступа.
 */

const form = (values = {}, flags = {}) => ({ values, flags });

test("пустое поле секрета не попадает в запрос — сохранённое значение остаётся", () => {
  const payload = buildPrinterPayload(
    form({ name: "Bambu A1", "secret:accessCode": "", "secret:serial": "" })
  );
  assert.equal(payload.name, "Bambu A1");
  assert.ok(!("accessCode" in payload), "код доступа не должен отправляться пустым");
  assert.ok(!("serial" in payload));
});

test("введённый код доступа отправляется как есть", () => {
  const payload = buildPrinterPayload(form({ "secret:accessCode": " 87654321 " }));
  assert.equal(payload.accessCode, "87654321");
});

test("галочка «стереть» — единственный способ обнулить секрет", () => {
  const payload = buildPrinterPayload(form({ "secret:apiKey": "" }, { "clear:apiKey": true }));
  assert.equal(payload.apiKey, null);
});

test("введённое значение выигрывает у галочки «стереть»", () => {
  const payload = buildPrinterPayload(form({ "secret:apiKey": "новый" }, { "clear:apiKey": true }));
  assert.equal(payload.apiKey, "новый");
});

test("снятая галочка доезжает как false, а не как отсутствие поля", () => {
  const payload = buildPrinterPayload(form({}, { allowInsecureTls: false, enabled: false }));
  assert.equal(payload.allowInsecureTls, false);
  assert.equal(payload.enabled, false);
});

test("числовые поля: пусто → null (очистить), значение → число", () => {
  const cleared = buildPrinterPayload(form({ port: "", nozzleDiameterMm: "" }));
  assert.equal(cleared.port, null);
  assert.equal(cleared.nozzleDiameterMm, null);

  const set = buildPrinterPayload(form({ port: "8883", nozzleDiameterMm: "0.4" }));
  assert.equal(set.port, 8883);
  assert.equal(set.nozzleDiameterMm, 0.4);
});

test("габариты стола отправляются целиком; все три пустые → null", () => {
  const full = buildPrinterPayload(
    form({ "buildVolume.x": "256", "buildVolume.y": "256", "buildVolume.z": "256" })
  );
  assert.deepEqual(full.buildVolume, { x: 256, y: 256, z: 256 });

  const cleared = buildPrinterPayload(
    form({ "buildVolume.x": "", "buildVolume.y": "", "buildVolume.z": "" })
  );
  assert.equal(cleared.buildVolume, null);
});

test("подсветка: «по умолчанию для протокола» отправляется как null, а не как false", () => {
  const auto = buildPrinterPayload(form({ "light.enabled": "" }, { "light.invert": false }));
  assert.equal(auto.light.enabled, null);
  assert.equal(auto.light.invert, false);

  const off = buildPrinterPayload(form({ "light.enabled": "false" }));
  assert.equal(off.light.enabled, false);

  const on = buildPrinterPayload(form({ "light.enabled": "true", "light.pin": " LED " }));
  assert.equal(on.light.enabled, true);
  assert.equal(on.light.pin, "LED");
});

test("форма без полей подсветки не отправляет light — настройка не сбрасывается", () => {
  const payload = buildPrinterPayload(form({ name: "K2" }));
  assert.ok(!("light" in payload));
  assert.ok(!("buildVolume" in payload));
});

test("создание: id обязателен, а пустые необязательные поля не отправляются", () => {
  const payload = buildPrinterPayload(
    form(
      { id: " k2 ", name: "Creality K2", host: "192.168.0.132", protocol: "moonraker", model: "", port: "" },
      { enabled: true }
    ),
    { create: true }
  );
  assert.equal(payload.id, "k2");
  assert.equal(payload.host, "192.168.0.132");
  assert.equal(payload.enabled, true);
  assert.ok(!("model" in payload), "пустая модель не отправляется — backend подставит своё");
  assert.ok(!("port" in payload));
});

test("редактирование: пустое текстовое поле отправляется как '' — это очистка", () => {
  const payload = buildPrinterPayload(form({ interfaceUrl: "" }));
  assert.equal(payload.interfaceUrl, "");
  assert.ok(!("id" in payload), "id при редактировании не отправляется — он неизменяем");
});
