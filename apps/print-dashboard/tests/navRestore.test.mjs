/* ── Регресс: ленивый старт поднимал лишний раздел ─────────────
   Найденный дефект: возврат на панель в режиме «Работы» с сохранённым разделом
   («Оборудование») сначала открывал раздел ПО УМОЛЧАНИЮ («Загрузка») и только
   потом — сохранённый. Виновата была строка `if (work) currentWork = null;`:
   showMode(«works») видел пустой currentWork и успевал поднять первый раздел
   списка. Следствие в живой панели (замерено на реальном backend): лишние
   модули features/uploads/*, лишний запрос GET /api/print/artifacts и ВЕЧНЫЙ
   фоновый опрос раздела, который оператор не открывал.

   Правило, которое эти тесты защищают: ленивый старт означает «ровно то, что
   открыли», а не «то, что открыли, плюс первый по списку». */

import assert from "node:assert/strict";
import test from "node:test";

/* ── Минимальный DOM, которого хватает навигации ───────────────
   Нарочно крошечный: чем меньше подделка, тем яснее, что проверяется
   поведение модуля, а не подпорки теста. */
function fakeElement(id = "") {
  return {
    id,
    hidden: false,
    tabIndex: 0,
    scrollWidth: 0,
    clientWidth: 0,
    scrollLeft: 0,
    style: { setProperty() {} },
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    focus() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    scrollIntoView() {},
    scrollTo() {}
  };
}

function installDom({ mode, work }) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, fakeElement(id));
    return els.get(id);
  };
  // Панели режимов, панели разделов и их вкладки.
  for (const id of ["mode-hall", "mode-works"]) el(id);
  for (const id of ["uploads", "slicing", "scheduler", "operations", "hardware", "automations"]) el(id);

  const bySelector = (sel) => {
    const mode = /\.mode-tab\[data-mode="(\w+)"\]/.exec(sel);
    if (mode) return el(`tab-${mode[1]}`);
    const workTab = /\[data-work-tab="([\w-]+)"\]/.exec(sel);
    if (workTab) return el(`worktab-${workTab[1]}`);
    if (sel === "#section-nav" || sel === "#worknav" || sel === "#modebar") return el(sel);
    if (sel === ".topbar") return null; // липких смещений в тесте нет
    if (sel.startsWith("#")) return el(sel.slice(1));
    return null;
  };

  const store = new Map();
  if (mode) store.set("albedo-mode", mode);
  if (work) store.set("albedo-work", work);

  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    raf: globalThis.requestAnimationFrame
  };

  globalThis.document = {
    documentElement: { ...fakeElement("html"), style: { setProperty() {} } },
    getElementById: (id) => (els.has(id) ? els.get(id) : null),
    querySelector: bySelector,
    querySelectorAll: () => [],
    addEventListener() {},
    fonts: null
  };
  globalThis.window = {
    scrollY: 0,
    innerHeight: 900,
    scrollTo() {},
    addEventListener() {},
    ResizeObserver: undefined
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k)
  };
  globalThis.requestAnimationFrame = (fn) => fn();

  return () => Object.assign(globalThis, prev);
}

/** Свежий экземпляр модуля на каждый сценарий (у nav.js есть своё состояние). */
let seq = 0;
async function freshNav() {
  return import(`../nav.js?case=${++seq}`);
}

test("сохранённый раздел «Оборудование» поднимается ОДИН и без «Загрузки»", async () => {
  const restore = installDom({ mode: "works", work: "hardware" });
  try {
    const nav = await freshNav();
    const started = [];
    nav.setupNav({ onWorkOpen: (id) => started.push(id) });
    nav.restoreMode();
    assert.deepEqual(started, ["hardware"], "поднят ровно сохранённый раздел");
  } finally {
    restore();
  }
});

test("любой сохранённый раздел поднимается сам по себе", async () => {
  for (const work of ["slicing", "scheduler", "operations", "automations"]) {
    const restore = installDom({ mode: "works", work });
    try {
      const nav = await freshNav();
      const started = [];
      nav.setupNav({ onWorkOpen: (id) => started.push(id) });
      nav.restoreMode();
      assert.deepEqual(started, [work], `${work}: лишних контроллеров нет`);
    } finally {
      restore();
    }
  }
});

test("без сохранённого раздела «Работы» открывают первый — и только его", async () => {
  const restore = installDom({ mode: "works", work: null });
  try {
    const nav = await freshNav();
    const started = [];
    nav.setupNav({ onWorkOpen: (id) => started.push(id) });
    nav.restoreMode();
    assert.deepEqual(started, ["uploads"], "раздел по умолчанию — и ровно один");
  } finally {
    restore();
  }
});

test("возврат в Зал не поднимает ни одного раздела Работ", async () => {
  const restore = installDom({ mode: "hall", work: "hardware" });
  try {
    const nav = await freshNav();
    const started = [];
    nav.setupNav({ onWorkOpen: (id) => started.push(id) });
    nav.restoreMode();
    assert.deepEqual(started, [], "Зал не тянет за собой контроллеры Работ");
  } finally {
    restore();
  }
});

test("неизвестный сохранённый раздел не роняет восстановление", async () => {
  const restore = installDom({ mode: "works", work: "разделкоторогонет" });
  try {
    const nav = await freshNav();
    const started = [];
    nav.setupNav({ onWorkOpen: (id) => started.push(id) });
    nav.restoreMode();
    assert.deepEqual(started, ["uploads"], "падаем на раздел по умолчанию, а не на ошибку");
  } finally {
    restore();
  }
});

test("повторное открытие раздела не поднимает его контроллер второй раз", async () => {
  const restore = installDom({ mode: "works", work: "scheduler" });
  try {
    const nav = await freshNav();
    const started = [];
    nav.setupNav({ onWorkOpen: (id) => started.push(id) });
    nav.restoreMode();
    nav.showWork("hardware");
    nav.showWork("scheduler");
    nav.showWork("hardware");
    nav.showWork("scheduler");
    assert.deepEqual(started, ["scheduler", "hardware"], "каждый контроллер поднят ровно один раз");
  } finally {
    restore();
  }
});

test("режим переключается туда и обратно, запоминая место каждого", async () => {
  const restore = installDom({ mode: "hall", work: null });
  try {
    const nav = await freshNav();
    const scrolls = [];
    globalThis.window.scrollTo = (o) => { scrolls.push(o.top); globalThis.window.scrollY = o.top; };
    nav.setupNav({ onWorkOpen: () => {} });
    nav.restoreMode();

    globalThis.window.scrollY = 1200;      // оператор ушёл вниз по Залу
    nav.showMode("works");                  // место Зала запомнено, Работы с нуля
    assert.deepEqual(scrolls, [0]);

    globalThis.window.scrollY = 300;        // полистал Работы
    nav.showMode("hall");                   // возвращаемся ровно туда, где были
    assert.deepEqual(scrolls, [0, 1200]);

    nav.showMode("works");
    assert.deepEqual(scrolls, [0, 1200, 300], "у каждого режима своё место");
  } finally {
    restore();
  }
});
