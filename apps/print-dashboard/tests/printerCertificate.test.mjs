import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPrinterPayload } from "../features/printers/formModel.js";
import { addFormHtml, printersHtml } from "../features/printers/view.js";

/*
 * Сертификат Anycubic LAN в разделе «Оборудование фермы».
 *
 * Проверяем обещания интерфейса: у Anycubic нет пути «без проверки
 * сертификата»; чтение сертификата показывает, что предъявил принтер, но ничего
 * не подтверждает; кнопка подтверждения несёт ровно увиденный отпечаток;
 * несовпадение показано как блокировка, а не как мелочь. Другие протоколы
 * выглядят как прежде.
 */

const PIN = "0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0";
const OTHER = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

function printer(over = {}) {
  return {
    id: "kobra-x",
    name: "Anycubic Kobra X",
    protocol: "anycubic-lan",
    host: "192.0.2.10",
    port: null,
    enabled: true,
    model: "",
    material: "",
    nozzleType: "",
    nozzleDiameterMm: null,
    buildVolume: null,
    allowInsecureTls: false,
    tlsFingerprint: "",
    secrets: {},
    discovery: null,
    specs: {},
    ...over
  };
}

function render(p, certificates = {}, busy = {}) {
  return printersHtml({ printers: [p], options: null, tests: {}, certificates, busy });
}

const cert = (fingerprint256, extra = {}) => ({
  fingerprint256,
  subject: "O=AnyCubic",
  issuer: "O=AnyCubic",
  validFrom: "Sep 24 19:07:41 2026 GMT",
  validTo: "Sep 21 19:07:41 2036 GMT",
  selfSigned: true,
  ...extra
});

test("у Anycubic нет галочки «TLS без проверки» — есть поле подтверждённого отпечатка и кнопка «Сертификат»", () => {
  const html = render(printer());
  assert.ok(!html.includes('name="allowInsecureTls"'), "пути «без проверки» нет");
  assert.ok(html.includes('name="tlsFingerprint"'));
  assert.ok(html.includes('data-prn-action="tls-read"'));
  assert.match(html, /сертификат не подтверждён/);
});

test("подтверждённый сертификат виден в строке и в поле", () => {
  const html = render(printer({ tlsFingerprint: PIN }));
  assert.match(html, /сертификат подтверждён/);
  assert.ok(html.includes(`value="${PIN}"`));
});

test("прочитанный, но не подтверждённый сертификат предлагается подтвердить — ровно этим отпечатком", () => {
  const html = render(printer(), {
    "kobra-x": { certificate: cert(PIN), error: null, confirmed: null, matches: null, checkedAt: null }
  });
  assert.ok(html.includes(PIN));
  assert.match(html, /самоподписанный/);
  assert.ok(html.includes(`data-prn-action="tls-confirm"`));
  assert.ok(html.includes(`data-fingerprint="${PIN}"`));
  assert.match(html, /Подтвердить этот сертификат/);
});

test("совпадающий сертификат подтверждать нечего", () => {
  const html = render(printer({ tlsFingerprint: PIN }), {
    "kobra-x": { certificate: cert(PIN), error: null, confirmed: PIN, matches: true, checkedAt: null }
  });
  assert.match(html, /Совпадает с подтверждённым/);
  assert.ok(!html.includes('data-prn-action="tls-confirm"'));
});

test("несовпадение — это блокировка с обоими отпечатками, замена только явной кнопкой", () => {
  const html = render(printer({ tlsFingerprint: PIN }), {
    "kobra-x": { certificate: cert(OTHER), error: null, confirmed: PIN, matches: false, checkedAt: null }
  });
  assert.match(html, /Не совпадает с подтверждённым/);
  assert.match(html, /подключение заблокировано/);
  assert.ok(html.includes(PIN) && html.includes(OTHER));
  assert.ok(html.includes(`data-fingerprint="${OTHER}"`));
  assert.match(html, /Заменить на этот сертификат/);
});

test("вердикт — против подтверждённого сейчас: прочитанное до смены отпечатка не выдаёт себя за разрешение", () => {
  // Прочитали при подтверждённом PIN, потом подтверждение стёрли в настройках.
  const cleared = render(printer({ tlsFingerprint: "" }), {
    "kobra-x": { certificate: cert(PIN), error: null, confirmed: PIN, matches: true, checkedAt: null }
  });
  assert.doesNotMatch(cleared, /подключение разрешено/);
  assert.match(cleared, /Сертификат ещё не подтверждён/);
  assert.ok(cleared.includes(`data-fingerprint="${PIN}"`));

  // Прочитали при PIN, потом в настройки вставили OTHER: это несовпадение.
  const replaced = render(printer({ tlsFingerprint: OTHER }), {
    "kobra-x": { certificate: cert(PIN), error: null, confirmed: PIN, matches: true, checkedAt: null }
  });
  assert.match(replaced, /Не совпадает с подтверждённым/);
  assert.ok(replaced.includes(OTHER));
});

test("недоступный брокер назван причиной, а не пустотой", () => {
  const html = render(printer(), {
    "kobra-x": { certificate: null, error: "Соединение с 192.0.2.10 отклонено", confirmed: null, matches: null, checkedAt: null }
  });
  assert.match(html, /Сертификат прочитать не удалось: Соединение с 192\.0\.2\.10 отклонено/);
  assert.ok(!html.includes('data-prn-action="tls-confirm"'));
});

test("текст сертификата приходит от устройства и экранируется", () => {
  const html = render(printer(), {
    "kobra-x": {
      certificate: cert(PIN, { subject: '<img src=x onerror="alert(1)">', selfSigned: false, issuer: "<b>x</b>" }),
      error: null,
      confirmed: null,
      matches: null,
      checkedAt: null
    }
  });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>x</b>"));
});

test("у Bambu всё как прежде: галочка TLS-согласия, без отпечатка и без кнопки сертификата", () => {
  const html = render(printer({ id: "bambu-a1", protocol: "bambu", allowInsecureTls: true }));
  assert.ok(html.includes('name="allowInsecureTls"'));
  assert.match(html, /Разрешить TLS без проверки сертификата \(Bambu LAN/);
  assert.ok(!html.includes('name="tlsFingerprint"'));
  assert.ok(!html.includes('data-prn-action="tls-read"'));
  assert.doesNotMatch(html, /сертификат (не )?подтверждён/);
});

test("форма добавления Anycubic не предлагает TLS без проверки", () => {
  const html = addFormHtml({ options: null, busy: {}, draftProtocol: "anycubic-lan" });
  assert.ok(!html.includes('name="allowInsecureTls"'));
  assert.match(html, /подтвердите его отпечаток SHA-256/);
  const bambu = addFormHtml({ options: null, busy: {}, draftProtocol: "bambu" });
  assert.ok(bambu.includes('name="allowInsecureTls"'), "Bambu по-прежнему получает своё согласие");
});

test("поле отпечатка уходит в запрос как есть; пустое при правке снимает подтверждение", () => {
  assert.equal(buildPrinterPayload({ values: { tlsFingerprint: ` ${PIN} ` }, flags: {} }).tlsFingerprint, PIN);
  assert.equal(buildPrinterPayload({ values: { tlsFingerprint: "" }, flags: {} }).tlsFingerprint, "");
  const created = buildPrinterPayload({ values: { id: "k", name: "K", tlsFingerprint: "" }, flags: {} }, { create: true });
  assert.ok(!("tlsFingerprint" in created), "на создании пустое не отправляется");
});
