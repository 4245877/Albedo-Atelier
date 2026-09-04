/* ── Browser smoke: меню «⋯» в карточке принтера ────────────────
   Проверяет в НАСТОЯЩЕМ браузере то, что нельзя проверить чистой функцией:
   панель открытого меню видна целиком и её не режет карточка.

   Исходный дефект: панель была `position: absolute` внутри `.printer-card`, а
   карточка объявлена `overflow: hidden` — меню, раскрывающееся вниз от кнопки
   в её правом нижнем углу, обрезалось по границе карточки. Поэтому здесь
   мало сравнить координаты: проверяется ПОПАДАНИЕ КУРСОРА в углы панели
   (elementFromPoint) — обрезанная или перекрытая панель этой проверки не
   проходит, как бы ни выглядели её getBoundingClientRect.

   Как и dashboard.smoke.mjs, работает через CDP без Playwright/Puppeteer и
   SKIP-ается, когда браузера нет (CHROME_CDP_URL, по умолчанию :9222). */
import assert from "node:assert/strict";
import test from "node:test";

import { startMockServer } from "./mockServer.mjs";

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";

async function probeCdp() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const exceptions = [];
  let seq = 0;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || "uncaught exception");
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { send, exceptions, close: () => ws.close() };
}

/* ── Пробы, исполняемые в странице ─────────────────────────────
   Открывает меню последней карточки, предварительно поставив её кнопку на
   заданном расстоянии от нижнего края экрана. Возвращает всё, что нужно для
   суждения: рамки, попадание курсора в углы, направление раскрытия. */
const PROBE = `
(function () {
  window.__menuProbe = {
    at(i) {
      const cards = [...document.querySelectorAll(".printer-card")];
      const card = i < 0 ? cards[cards.length + i] : cards[i];
      return { card, toggle: card && card.querySelector("[data-menu-toggle]") };
    },
    /** Прокрутить страницу так, чтобы кнопка встала в fromBottom px от низа. */
    park(fromBottom, i = -1) {
      const { toggle } = this.at(i);
      const r = toggle.getBoundingClientRect();
      window.scrollBy(0, Math.round(r.bottom - (innerHeight - fromBottom)));
      return Math.round(toggle.getBoundingClientRect().bottom - (innerHeight - fromBottom));
    },
    open(i = -1) {
      this.at(i).toggle.click();
      return true;
    },
    /** Ткнуть в первый безобидный пункт открытого меню. */
    pick() {
      const items = [...document.querySelectorAll(".menu[data-side] .menu-item:not([disabled])")];
      const item = items.find((el) => !el.classList.contains("menu-item-danger"));
      if (!item) return false;
      item.click();
      return true;
    },
    /** Закрыть окно, если пункт меню его открыл: оно перекрыло бы дальнейшие пробы. */
    dismiss() {
      document.querySelector(".modal-backdrop:not([hidden]) [data-modal-close]")?.click();
      return !document.querySelector(".modal-backdrop:not([hidden])");
    },
    /** Всё о показанной панели: рамка, экран, обрезающая карточка, hit-test. */
    state(i = -1) {
      const { card, toggle } = this.at(i);
      const panel = document.querySelector(".menu-host[data-open]")
        ? document.getElementById(toggle.getAttribute("aria-controls"))
        : null;
      if (!panel || panel.hidden) return { open: false };
      const r = panel.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const inset = 4;
      const corners = [
        [r.left + inset, r.top + inset], [r.right - inset, r.top + inset],
        [r.left + inset, r.bottom - inset], [r.right - inset, r.bottom - inset]
      ];
      // Панель обязана быть верхним элементом в каждом своём углу: обрезанная
      // (overflow предка) или перекрытая соседом — не будет.
      const hits = corners.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return Boolean(el && (el === panel || panel.contains(el)));
      });
      return {
        open: true,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height, width: r.width },
        card: { top: cardBox.top, bottom: cardBox.bottom, right: cardBox.right, overflow: getComputedStyle(card).overflow },
        toggle: toggle.getBoundingClientRect().toJSON(),
        view: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        side: panel.dataset.side,
        position: getComputedStyle(panel).position,
        inBody: panel.parentElement === document.body,
        maxHeight: getComputedStyle(panel).maxHeight,
        scrollable: panel.scrollHeight > panel.clientHeight + 1,
        hits,
        expanded: toggle.getAttribute("aria-expanded")
      };
    },
    /** Панель вернулась в свою карточку и не осталась сиротой в <body>. */
    restored(i = -1) {
      const { card } = this.at(i);
      return {
        inCard: Boolean(card.querySelector(".menu[hidden]")),
        orphans: [...document.body.children].filter((el) => el.classList.contains("menu")).length,
        open: Boolean(document.querySelector(".menu-host[data-open]"))
      };
    }
  };
  return true;
})()`;

const version = await probeCdp();

test("меню «⋯» карточки принтера видно целиком — на десктопе и на телефоне", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  const mock = await startMockServer();
  // Пустая вкладка, а размеры экрана подменяем уже ПОСЛЕ загрузки доски:
  // подмена до навигации иногда оставляла страницу фоновой, и опрос доски
  // растягивался на десятки секунд.
  const target = await (await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  const evalValue = async (expression) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // Вкладка без фокуса — фоновая: браузер душит её таймеры (до одного раза в
    // минуту), и опрос доски растягивается на десятки секунд. Тесту нужна
    // живая страница, а не фоновая.
    await cdp.send("Page.bringToFront").catch(() => {});
    await cdp.send("Page.navigate", { url: mock.url });

    // Доску грузим ОДИН раз, а размеры экрана дальше меняем без перезагрузки:
    // так проверяется ещё и то, что открытое меню переживает смену размера.
    let cards = 0;
    for (let i = 0; i < 160 && cards < 2; i++) {
      cards = await evalValue("document.querySelectorAll('.printer-card:not(.is-skeleton)').length");
      if (cards < 2) await wait(250);
    }
    if (cards !== 2) {
      const why = await evalValue("JSON.stringify({ ready: document.readyState, url: location.href, grid: (document.querySelector('#printer-grid')?.innerHTML || '').length })");
      assert.fail(`карточки принтеров должны отрисоваться (${cards}); ${why}; ${cdp.exceptions.join(" | ")}`);
    }

    for (const screen of [
      { name: "десктоп", width: 1440, height: 900, mobile: false },
      { name: "телефон", width: 390, height: 844, mobile: true }
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.mobile
      });
      await evalValue("window.scrollTo(0, 0)");
      await wait(300);
      await evalValue(PROBE);

      // ── Худший случай: кнопка у самого низа экрана ──────────────
      await evalValue("__menuProbe.park(56)");
      await evalValue("__menuProbe.open()");
      await wait(300);
      const low = await evalValue("__menuProbe.state()");
      assert.equal(low.open, true, `${screen.name}: меню должно открыться`);
      assert.equal(low.card.overflow, "hidden", `${screen.name}: карточка по-прежнему обрезает своё содержимое — значит проверка осмысленна`);
      assert.equal(low.position, "fixed", `${screen.name}: панель позиционируется от вьюпорта`);
      assert.equal(low.inBody, true, `${screen.name}: панель вынесена из карточки`);
      assert.equal(low.side, "up", `${screen.name}: у нижнего края меню обязано раскрыться вверх`);
      assert.deepEqual(low.hits, [true, true, true, true], `${screen.name}: все углы панели должны быть видимы (не обрезаны и не перекрыты)`);
      assert.ok(low.rect.top >= 7 && low.rect.bottom <= low.view.height - 7,
        `${screen.name}: панель ${low.rect.top}…${low.rect.bottom} вышла за экран ${low.view.height}`);
      assert.ok(low.rect.left >= 7 && low.rect.right <= low.view.width - 7,
        `${screen.name}: панель ${low.rect.left}…${low.rect.right} вышла за ширину ${low.view.width}`);

      // ── Прокрутка: панель следует за кнопкой, а не отрывается ───
      const before = await evalValue("__menuProbe.state()");
      await evalValue("window.scrollBy(0, 40)");
      await wait(400);
      const after = await evalValue("__menuProbe.state()");
      assert.equal(after.open, true, `${screen.name}: кнопка осталась на экране — меню не должно закрываться`);
      assert.ok(Math.abs((after.rect.top - after.toggle.top) - (before.rect.top - before.toggle.top)) < 2,
        `${screen.name}: панель должна держаться кнопки при прокрутке`);
      assert.ok(after.rect.top >= 7 && after.rect.bottom <= after.view.height - 7,
        `${screen.name}: после прокрутки панель вышла за экран`);

      // Кнопку увезло за нижний край — меню закрывается, а не висит само по себе.
      await evalValue("window.scrollBy(0, -600)");
      await wait(400);
      const gone = await evalValue("__menuProbe.state()");
      assert.equal(gone.open, false, `${screen.name}: меню обязано закрыться, когда кнопка ушла с экрана`);
      const swept = await evalValue("__menuProbe.restored()");
      assert.equal(swept.orphans, 0, `${screen.name}: закрытая панель не остаётся сиротой в <body>`);

      // ── Кнопка у верхнего края: меню раскрывается вниз ──────────
      await evalValue(`__menuProbe.park(${screen.height - 120})`);
      await evalValue("__menuProbe.open()");
      await wait(300);
      const high = await evalValue("__menuProbe.state()");
      assert.equal(high.side, "down", `${screen.name}: у верхнего края меню раскрывается вниз`);
      assert.deepEqual(high.hits, [true, true, true, true], `${screen.name}: панель, раскрытая вниз, видна целиком`);
      assert.ok(high.rect.left >= 7 && high.rect.right <= high.view.width - 7,
        `${screen.name}: панель ${high.rect.left}…${high.rect.right} вышла за ширину ${high.view.width}`);
      await evalValue("document.body.click()");
      await wait(150);

      // ── Клик по пункту закрывает меню и возвращает панель в карточку ──
      // Берём печатающий принтер: у простаивающего все пункты недоступны.
      await evalValue("__menuProbe.park(260, 0)");
      await evalValue("__menuProbe.open(0)");
      await wait(200);
      assert.equal(await evalValue("__menuProbe.pick()"), true, `${screen.name}: в меню печатающего принтера есть доступный пункт`);
      await wait(300);
      const restored = await evalValue("__menuProbe.restored(0)");
      assert.equal(restored.open, false, `${screen.name}: меню должно закрыться по выбору пункта`);
      assert.equal(restored.inCard, true, `${screen.name}: панель обязана вернуться в свою карточку`);
      assert.equal(restored.orphans, 0, `${screen.name}: в <body> не должно остаться панели-сироты`);
      // Пункт мог открыть окно (файлы принтера) — убираем его за собой.
      await evalValue("__menuProbe.dismiss()");
      await wait(150);
      await evalValue("document.body.click()");
    }

    // ── Низкий вьюпорт: список не помещается никуда и прокручивается сам ──
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 740, height: 380, deviceScaleFactor: 1, mobile: true });
    await wait(200);
    await evalValue("__menuProbe.park(200)");
    await evalValue("__menuProbe.open()");
    await wait(400);
    const tight = await evalValue("__menuProbe.state()");
    assert.equal(tight.open, true, "низкий вьюпорт: меню должно открыться");
    assert.ok(tight.rect.top >= 7 && tight.rect.bottom <= tight.view.height - 7,
      `низкий вьюпорт: панель ${tight.rect.top}…${tight.rect.bottom} вышла за экран ${tight.view.height}`);
    assert.deepEqual(tight.hits, [true, true, true, true], "низкий вьюпорт: панель видна целиком");

    // ── Смена размера окна при открытом меню ───────────────────
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
    await wait(500);
    const resized = await evalValue("__menuProbe.state()");
    if (resized.open) {
      assert.ok(resized.rect.left >= 7 && resized.rect.right <= resized.view.width - 7,
        `после смены размера панель ${resized.rect.left}…${resized.rect.right} вне экрана ${resized.view.width}`);
      assert.ok(resized.rect.top >= 7 && resized.rect.bottom <= resized.view.height - 7,
        "после смены размера панель вышла за экран по высоте");
    }

    // ── Раздел «Оборудование»: пункт меню обязан ДОЙТИ до обработчика ──
    // Его делегат принимает клики только внутри #hardware-body, а пункт
    // открытого меню лежит в <body>. Проверяем, что действие всё-таки уходит
    // на backend (иначе «Отключить от фермы» молча ничего бы не делало).
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalValue("document.querySelector('[data-goto=\"hardware\"]').click()");
    let rows = 0;
    for (let i = 0; i < 80 && rows < 1; i++) {
      rows = await evalValue("document.querySelectorAll('#hardware-body .prn-row').length");
      if (rows < 1) await wait(250);
    }
    assert.ok(rows >= 1, "раздел «Оборудование» должен показать строки принтеров");

    await evalValue("document.querySelector('#hardware-body .prn-row [data-menu-toggle]').scrollIntoView({ block: 'center' })");
    await evalValue("document.querySelector('#hardware-body .prn-row [data-menu-toggle]').click()");
    await wait(250);
    const hw = await evalValue(`(() => {
      const panel = document.querySelector("body > .menu[data-side]");
      if (!panel) return { open: false };
      const r = panel.getBoundingClientRect();
      const inset = 4;
      const hits = [[r.left + inset, r.top + inset], [r.right - inset, r.bottom - inset]]
        .map(([x, y]) => { const el = document.elementFromPoint(x, y); return Boolean(el && (el === panel || panel.contains(el))); });
      return { open: true, hits, view: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
    })()`);
    assert.equal(hw.open, true, "меню строки принтера должно открыться");
    assert.deepEqual(hw.hits, [true, true], "меню в «Оборудовании» видно целиком");
    assert.ok(hw.rect.top >= 7 && hw.rect.bottom <= hw.view.height - 7 && hw.rect.left >= 7 && hw.rect.right <= hw.view.width - 7,
      "меню в «Оборудовании» не выходит за экран");

    const before = mock.requests.length;
    await evalValue(`document.querySelector('body > .menu[data-side] [data-prn-action="toggle"]').click()`);
    await wait(400);
    const sent = mock.requests.slice(before).filter((r) => r.method === "POST" && /\/api\/printers\/config\/.+\/enabled$/.test(r.path));
    assert.equal(sent.length, 1, `пункт «Отключить от фермы» должен дойти до backend, а не потеряться в портале (${JSON.stringify(mock.requests.slice(before))})`);

    assert.deepEqual(cdp.exceptions, [], "страница не должна ронять исключений");
  } finally {
    // Снимаем подмену размеров экрана за собой: браузер в этой сессии могут
    // переиспользовать другие smoke-тесты.
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});
