/* ── Запуск печати: разметка ────────────────────────────────────
   Чистый рендер: получает preview с backend (GET /api/print/launch/:taskId) и
   локальное состояние окна, возвращает HTML. Никаких запросов и никакой логики
   допуска — что можно запустить, решает backend, здесь это только показывается.

   Порядок блоков задан сценарием оператора, а не структурой данных: сначала ЧТО
   печатаем, потом ГДЕ и почему именно там, потом что нужно проверить руками, и
   только в конце — одна главная кнопка. Технические подробности (коды отказов,
   пути к файлам, состояния артефактов) живут в <details> внизу: они нужны при
   разборе полёта и мешают при обычном запуске. */

import { esc } from "../../util.js";
import { icon } from "../../shared/icons.js";

/* Состояния задачи → человеческая подпись и цвет. Совпадает с LaunchState на
   backend; неизвестное состояние показываем как есть, а не прячем.

   Цвет несёт класс badge-*, а не эмодзи: цветные кружки 🟢🟡🔴 отсутствуют в
   шрифтах без emoji-набора и выводятся квадратом-заглушкой прямо перед текстом
   статуса — ровно в том месте, где нужна ясность. Классы уже дают зелёный,
   жёлтый и красный и работают в обеих темах. */
const STATE_LABEL = {
  preparing: { text: "Готовится", cls: "badge-plain" },
  ready: { text: "Готово к печати", cls: "badge-idle" },
  needs_confirmation: { text: "Нужно подтверждение", cls: "badge-paused" },
  blocked: { text: "Не готово", cls: "badge-error" },
  running: { text: "Печатается", cls: "badge-printing" },
  /* Не «печатается»: команда ушла, а принтер так и не подтвердил старт. Раньше
     это состояние показывалось как running — оператор видел «Печатается» рядом
     с неподвижным принтером и не имел ни причины, ни выхода. */
  unconfirmed: { text: "Запуск не подтверждён", cls: "badge-paused" }
};

export function stateLabel(state) {
  return STATE_LABEL[state] || { text: state, cls: "badge-plain" };
}

/** «PETG · 0.4 мм» — только то, что действительно известно. */
export function specLine(preview) {
  const parts = [];
  if (preview.material) parts.push(preview.material);
  if (preview.nozzleMm != null) parts.push(`${preview.nozzleMm} мм`);
  return parts.join(" · ");
}

/** «≈ 1 ч 29 мин · ≈ 31 г» — пропускаем то, чего не измерили. */
export function costLine(preview) {
  const parts = [];
  if (preview.etaText) parts.push(preview.etaText);
  if (preview.filamentG != null) parts.push(`≈ ${Math.round(preview.filamentG)} г`);
  return parts.join(" · ");
}

function materialNote(preview) {
  if (!preview.material) return "";
  if (preview.materialSource === "external") {
    return `<span class="launch-note">внешняя катушка</span>`;
  }
  if (preview.materialSource === "ams") return `<span class="launch-note">AMS</span>`;
  return "";
}

/* ── Карточка принтера в ручном режиме ─────────────────────── */

function candidateCard(c, selectedId) {
  const selected = c.printerId === selectedId;
  const facts = [];
  facts.push(c.online ? "онлайн" : "не в сети");
  if (c.online) facts.push(c.status === "idle" ? "свободен" : c.status);
  if (c.printerNozzleMm != null) facts.push(`сопло ${c.printerNozzleMm} мм`);
  if (c.loadedMaterial) facts.push(c.loadedMaterial);

  // Принтер, которому не хватает только человеческого подтверждения, — это не
  // отпавший вариант. Раньше радиокнопка была `disabled` для всего, что не
  // `eligible`, поэтому такого кандидата нельзя было даже ВЫБРАТЬ, а значит и
  // подтвердить: единственный путь к override был закрыт в самом начале списка.
  const reviewable = overridableProblems(c).length > 0;
  const selectable = c.eligible || reviewable;

  // У непригодного принтера показываем ПРИЧИНУ, а не пустую карточку: оператор
  // должен понимать, почему вариант отпал, иначе выбор выглядит произволом.
  const why = c.eligible
    ? `<div class="launch-cand-why">${esc(c.reason)}</div>`
    : `<div class="launch-cand-why is-blocked">${(c.problems || [])
        .filter((p) => p.kind === (reviewable ? "confirmable" : "blocker"))
        .map((p) => `<span>${esc(p.title)}</span>`)
        .join("")}</div>`;

  const badge = c.eligible
    ? { cls: "badge-idle", text: "совместим" }
    : reviewable
      ? { cls: "badge-paused", text: "нужно подтверждение" }
      : { cls: "badge-error", text: "несовместим" };

  return `
    <label class="launch-cand ${selected ? "is-selected" : ""} ${selectable ? "" : "is-blocked"}">
      <input type="radio" name="launch-printer" value="${esc(c.printerId)}"
        ${selected ? "checked" : ""} ${selectable ? "" : "disabled"} data-launch-pick />
      <span class="launch-cand-body">
        <span class="launch-cand-head">
          <span class="launch-cand-name">${esc(c.printerName)}</span>
          <span class="badge ${badge.cls}">${esc(badge.text)}</span>
        </span>
        <span class="launch-cand-facts">${esc(facts.join(" · "))}</span>
        ${why}
      </span>
    </label>`;
}

/* ── Подтверждения оператора ───────────────────────────────── */

/* Галочка обязана отвечать на четыре вопроса: что подтверждают, как это
   проверить, что произойдёт после подтверждения и кто за это отвечает. Раньше
   были только первые два — «Стол свободен» и пояснение, — и оператор ставил
   галочку, не зная, что сервер запишет от его имени очистку стола. `effect`
   приходит с backend вместе с самой галочкой. */
function confirmationsBlock(confirmations, confirmed) {
  if (!confirmations.length) return "";
  return `
    <div class="launch-confirms">
      <div class="launch-reason-title">Подтвердите перед запуском</div>
      ${confirmations
        .map(
          (c) => `
        <label class="launch-confirm">
          <input type="checkbox" value="${esc(c.code)}" ${confirmed.has(c.code) ? "checked" : ""} data-launch-confirm />
          <span>
            <span class="launch-confirm-lbl">${esc(c.label)}${c.required ? "" : " (необязательно)"}</span>
            <span class="launch-confirm-hint">${esc(c.detail)}</span>
            ${c.effect ? `<span class="launch-confirm-effect">${esc(c.effect)}</span>` : ""}
          </span>
        </label>`
        )
        .join("")}
    </div>`;
}

/* ── Проблемы: подтверждаемое и просто информация ───────────── */

function problemsBlock(candidate, confirmations) {
  if (!candidate) return "";
  // Блокеры уже сказаны крупно (кнопка выключена, причина в шапке) — здесь
  // только то, что оператору полезно знать, но что не мешает запуску.
  const infos = candidate.problems.filter((p) => p.kind === "info");
  if (!infos.length) return "";
  return `
    <ul class="launch-notes">
      ${infos.map((p) => `<li>${esc(p.title)}</li>`).join("")}
    </ul>`;
}

/* Открытые вопросы, у которых НЕТ своей галочки и которые не попали в блок
   «под ответственность»: профиль не утверждён, габариты не подтверждены,
   раскладка филаментов не задана.

   Раньше они были видны только в «Технических подробностях» — то есть за
   свёрнутым блоком с кодами отказов. Оператор читал «Нужно подтверждение» в
   шапке и не имел способа узнать, ЧТО именно подтвердить. Теперь каждый такой
   пункт стоит в основной части окна вместе с действием, которое его снимает. */
function openQuestionsBlock(candidate, confirmations, ui) {
  if (!candidate) return "";
  // Пока стоит жёсткий отказ, открытые вопросы не показываем: их всё равно
  // нельзя закрыть в обход блокера, и рядом с одной настоящей причиной они
  // становятся тремя равноправными строками — ровно тот шум, из-за которого
  // главную причину и перестают находить. Как только блокер снят, они
  // возвращаются: тогда они и есть то, что мешает запуску.
  if (candidate.problems.some((p) => p.kind === "blocker")) return "";
  const covered = new Set(confirmations.map((c) => c.code));
  const inOverride = new Set(overridableProblems(candidate).map((p) => p.code));
  const open = candidate.problems.filter(
    (p) =>
      p.kind === "confirmable" &&
      !(p.confirmation && covered.has(p.confirmation)) &&
      !inOverride.has(p.code)
  );
  if (!open.length) return "";
  return `
    <div class="launch-open">
      <div class="launch-reason-title">Требует внимания</div>
      <ul class="launch-open-list">
        ${open
          .map(
            (p) => `<li><span class="launch-open-what">${esc(p.title)}</span>
                    <span class="launch-open-how">${esc(p.action)}</span></li>`
          )
          .join("")}
      </ul>
    </div>`;
}

/* ── Принятие ответственности за «review» ───────────────────────

   Отказ бывает двух совершенно разных видов, и раньше окно показывало их
   одинаково. Есть жёсткий отказ — стол занят, сопло не то, принтер в ошибке, —
   и его не снимает никто. А есть `review`: проверка, которую машина провести не
   может, но человек, стоящий у принтера, может. Раньше оператор видел список
   вроде «неизвестно, какой материал заряжен», кнопка «Запустить» была
   выключена, и НИКАКОГО пути дальше не существовало — при том, что сервер
   умеет принимать такое решение с самого начала (DispatchService, override).

   Что решает оператор здесь, а что — сервер: здесь только собирается намерение
   (какие коды принимаются и почему). Допускать или нет — по-прежнему решает
   dispatch gate, внутри своей транзакции, по своему списку NON_OVERRIDABLE, и
   он же пишет запись в журнал. Поэтому блок появляется, только когда КАЖДАЯ
   непройденная проверка помечена сервером как overridable: предлагать снятие
   того, что сервер всё равно не снимет, — это отправить оператора в отказ. */

export function overridableProblems(candidate) {
  if (!candidate || candidate.eligible) return [];
  const problems = candidate.problems || [];
  // Хоть один жёсткий блокер — и обсуждать нечего.
  if (problems.some((p) => p.kind === "blocker")) return [];
  // Пункты со своей галочкой (стол, материал) сюда не относятся: их не «снимают
  // под ответственность», их ЗАКРЫВАЮТ — сервер по галочке выполняет реальное
  // действие. Складывать их в один список с override значило бы предлагать
  // оператору принять на себя то, что он и так собирается сделать.
  const confirmable = problems.filter((p) => p.kind === "confirmable" && !p.confirmation);
  if (!confirmable.length) return [];
  // Либо снимается всё, либо ничего: одна неснимаемая проверка отклонит запуск
  // целиком, и предложение её принять было бы ложным обещанием.
  return confirmable.every((p) => p.overridable) ? confirmable : [];
}

/** Готов ли собранный оператором override к отправке. */
export function overrideReady(candidate, ui) {
  return (
    overridableProblems(candidate).length > 0 &&
    Boolean(ui.overrideAccepted) &&
    String(ui.overrideReason || "").trim().length > 0
  );
}

function overrideBlock(candidate, ui) {
  const problems = overridableProblems(candidate);
  if (!problems.length) return "";
  return `
    <div class="launch-override">
      <div class="launch-reason-title">Запустить под ответственность оператора</div>
      <p class="launch-override-lead">
        Эти проверки система провести не может — их может подтвердить только человек
        у принтера. Решение и его причина попадут в журнал вместе с вашим именем.
      </p>
      <ul class="launch-override-list">
        ${problems
          .map(
            (p) => `<li><span class="launch-override-what">${esc(p.title)}</span>
                    <span class="launch-override-hint">${esc(p.action)}</span></li>`
          )
          .join("")}
      </ul>
      <label class="launch-confirm">
        <input type="checkbox" ${ui.overrideAccepted ? "checked" : ""} data-launch-override-accept />
        <span><span class="launch-confirm-lbl">Я проверил принтер и беру перечисленное на себя</span></span>
      </label>
      <label class="launch-override-why">
        <span class="launch-confirm-hint">Причина — обязательно</span>
        <textarea rows="2" data-launch-override-reason
          placeholder="Например: катушка PETG заряжена вручную, проверено визуально"
          >${esc(ui.overrideReason || "")}</textarea>
      </label>
    </div>`;
}

/* Почему именно этот принтер — и что ещё было доступно.

   Раньше здесь стояла строка `candidate.reason` и только в автоматическом
   режиме. Отсюда две неприятности. Во-первых, при нескольких подходящих машинах
   оператор не узнавал, что выбор вообще был: «Выбран A1» читается как «другого
   нет». Во-вторых, после ручного выбора объяснение исчезало не полностью —
   оставалось описание ПРЕДЫДУЩЕГО, автоматического решения, то есть текст про
   другую машину.

   Теперь фразу целиком составляет backend (`preview.selectionNote`), включая
   «Принтер выбран вручную», и здесь только отрисовка. */
function selectionNoteHtml(preview, candidate, ui) {
  if (!preview.selectionNote) return "";
  const manual = preview.selectionSource === "manual";
  // При отказе причину показывает blockedBlock — дублировать её пояснением
  // выбора значит сказать одно и то же дважды разными словами.
  if (!manual && !preview.recommendedPrinterId) return "";
  const more =
    !manual && preview.alternativeCount > 0 && ui.mode === "auto"
      ? `<button type="button" class="btn btn-sm btn-ghost" data-launch-mode="manual">${icon(
          "chevronRight"
        )}<span>Посмотреть остальные</span></button>`
      : "";
  return `
    <p class="launch-reason ${manual ? "is-manual" : ""}">
      ${manual ? icon("check") : ""}<span>${esc(preview.selectionNote)}</span>${more}
    </p>`;
}

/* Ровно ОДНА причина отказа, и её выбирает backend (preview.primaryProblem).

   Раньше здесь брался «первый блокер по порядку», и один физический сбой —
   принтер не смог прочитать карту MicroSD — выводился как четыре равноправные
   строки: занят, в ошибке, недоступен, неизвестно сопло. Три из них были
   следствиями первой, а настоящая причина не показывалась вовсе. Порядок в
   массиве не является приоритетом, поэтому выбор перенесён на сервер, а сюда —
   только отрисовка. Остальные строки никуда не делись: они в «Технических
   подробностях». */
function blockedBlock(preview, candidate) {
  if (!candidate) {
    return `<p class="launch-reason is-blocked">Нет принтера, готового принять это задание.</p>`;
  }
  if (candidate.eligible) return "";
  // Запасной вариант — на случай ответа без primaryProblem (старый backend или
  // кандидат, для которого сервер его не считал): показываем действие первого
  // блокера, как было раньше. Причина по-прежнему одна, просто выбрана хуже.
  const primary =
    preview.primaryProblem || candidate.problems.find((p) => p.kind === "blocker") || null;
  if (!primary) {
    return `<p class="launch-reason is-blocked">${esc(candidate.reason)}</p>`;
  }
  return `
    <div class="launch-reason is-blocked">
      <div class="launch-reason-title">${esc(primary.title)}</div>
      <div class="launch-reason-action">${esc(primary.action)}</div>
    </div>`;
}

/* Выход из неподтверждённой попытки — там же, где оператор в неё упёрся.

   Пока такой попытки не видно, задача выглядит вечно «running», а принтер
   отказывает собственной очереди как «занят». Сама кнопка ничего не решает за
   оператора: он смотрит на принтер и говорит, что там на самом деле. */
function unresolvedBlock(preview, ui) {
  if (!preview.unresolvedRunId) return "";
  // «Печать не началась» — primary: это ожидаемый ответ (команда ушла, принтер
  // остался IDLE), и именно он возвращает задание в очередь. Второй вариант
  // существует, но означает совсем другое — что печать всё-таки идёт, — и не
  // должен выглядеть равновероятным.
  return `
    <div class="launch-unresolved">
      <div class="launch-reason-title">Запуск не подтверждён</div>
      <p>
        Команда ушла на принтер, но он не сообщил, начал ли печать. Пока это не
        разрешено, задание нельзя ни запустить, ни считать печатающимся.
        Посмотрите на принтер и отметьте, что произошло.
      </p>
      <div class="launch-unresolved-actions">
        <button type="button" class="btn btn-sm btn-primary" data-launch-resolve="FAILED" ${ui.busy ? "disabled" : ""}>
          Печать не началась
        </button>
        <button type="button" class="btn btn-sm" data-launch-resolve="SUCCEEDED" ${ui.busy ? "disabled" : ""}>
          Печать идёт / прошла
        </button>
      </div>
    </div>`;
}

function diagnosticsBlock(preview, candidate) {
  const rows = [
    ["Задание", preview.taskId],
    ["Состояние", preview.state],
    ["Принтер", candidate ? candidate.printerId : "—"],
    ["Файл на устройстве", candidate ? candidate.deviceFile : "—"],
    ["Оценка", candidate ? String(candidate.score) : "—"]
  ];
  const breakdown = candidate?.scoreBreakdown?.length
    ? `<div class="launch-diag-list">${candidate.scoreBreakdown
        .map((s) => `<span>${esc(s.label)} <b>${s.points > 0 ? "+" : ""}${s.points}</b></span>`)
        .join("")}</div>`
    : "";
  const technical = candidate?.problems?.length
    ? `<div class="launch-diag-list">${candidate.problems
        .map((p) => `<span>${esc(p.technical)}</span>`)
        .join("")}</div>`
    : "";
  return `
    <details class="launch-diag">
      <summary>Технические подробности</summary>
      <div class="launch-diag-body">
        ${rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join("")}
        ${breakdown}
        ${technical}
      </div>
    </details>`;
}

/* ── Окно целиком ──────────────────────────────────────────── */

/**
 * @param preview ответ GET /api/print/launch/:taskId
 * @param ui  { mode, selectedPrinterId, confirmed:Set, busy, error, done }
 */
export function launchModalHtml(preview, ui) {
  const st = stateLabel(preview.state);
  const candidate =
    preview.candidates.find((c) => c.printerId === ui.selectedPrinterId) || null;
  const spec = specLine(preview);
  const cost = costLine(preview);

  if (ui.done) {
    return `
      <div class="modal-head"><h2 id="modal-title">Печать запущена</h2></div>
      <div class="launch-done">
        <div class="launch-done-mark">${icon("check", { cls: "ico-xl" })}</div>
        <div class="launch-sum-title">${esc(preview.displayTitle)}</div>
        <div class="launch-sum-sub">${esc(ui.done.printerName)}</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-sm btn-primary" data-modal-close>Закрыть</button>
      </div>`;
  }

  const confirmations = preview.confirmations || [];
  const allConfirmed = confirmations
    .filter((c) => c.required)
    .every((c) => ui.confirmed.has(c.code));
  // Неразрешённая попытка снимает запуск с повестки целиком. Сервер и так его
  // не допустит (launch_unconfirmed — блокер), но показывать кнопку «Запустить»
  // рядом с вопросом «а что вообще произошло?» значит предлагать оператору шаг,
  // который заведомо кончится отказом. Сначала ответ, потом запуск.
  const unresolved = Boolean(preview.unresolvedRunId);
  // Пригоден сам по себе — или оператор явно принял на себя то, что помешало.
  const admitted = Boolean(candidate?.eligible) || overrideReady(candidate, ui);
  const canLaunch = !unresolved && admitted && allConfirmed && !ui.busy;

  const cta = !candidate
    ? "Запустить печать"
    : overridableProblems(candidate).length > 0
      ? `Запустить на «${candidate.printerName}» под ответственность`
      : `Запустить на «${candidate.printerName}»`;

  return `
    <div class="modal-head"><h2 id="modal-title">Запуск печати</h2></div>

    <div class="launch-sum">
      <div class="launch-sum-title">${esc(preview.displayTitle)}</div>
      <div class="launch-sum-grid">
        ${candidate ? `<div class="kv"><span class="k">Принтер</span><span class="v">${esc(candidate.printerName)}</span></div>` : ""}
        ${spec ? `<div class="kv"><span class="k">Материал</span><span class="v">${esc(spec)} ${materialNote(preview)}</span></div>` : ""}
        ${cost ? `<div class="kv"><span class="k">Печать</span><span class="v">${esc(cost)}</span></div>` : ""}
      </div>
      <span class="badge ${st.cls}">${esc(st.text)}</span>
    </div>

    ${selectionNoteHtml(preview, candidate, ui)}

    ${unresolved ? unresolvedBlock(preview, ui) : blockedBlock(preview, candidate)}

    ${unresolved ? "" : confirmationsBlock(confirmations, ui.confirmed)}
    ${unresolved ? "" : openQuestionsBlock(candidate, confirmations, ui)}
    ${unresolved ? "" : overrideBlock(candidate, ui)}
    ${unresolved ? "" : problemsBlock(candidate, confirmations)}

    ${
      // Список машин раскрывается сам, когда запускать не на чем. «Нет готового
      // принтера» без списка — это отказ без разбора: оператор не знает, у кого
      // занят стол, кому файл не подходит и кого просто нет в сети, и не может
      // выбрать, что чинить. Показать причины по каждой машине дешевле, чем
      // заставить их выяснять.
      !unresolved && (ui.mode === "manual" || !preview.recommendedPrinterId)
        ? `<div class="launch-cands">
             <p class="sub-head">${
               preview.recommendedPrinterId ? "Выберите принтер" : "Почему ни один принтер не подходит"
             }</p>
             ${preview.candidates.map((c) => candidateCard(c, ui.selectedPrinterId)).join("")}
           </div>`
        : ""
    }

    ${ui.error ? `<div class="form-error">${esc(ui.error)}</div>` : ""}

    ${diagnosticsBlock(preview, candidate)}

    <div class="modal-actions launch-actions">
      ${
        unresolved
          ? ""
          : `<button type="button" class="btn btn-sm btn-ghost" data-launch-mode="${ui.mode === "auto" ? "manual" : "auto"}">
               ${ui.mode === "auto" ? "" : icon("arrowLeft")}<span>${ui.mode === "auto" ? "Выбрать принтер вручную" : "Автоматический выбор"}</span>
             </button>`
      }
      <span class="grow"></span>
      <button type="button" class="btn btn-sm" data-modal-close ${ui.busy ? "disabled" : ""}>Отмена</button>
      ${
        // Кнопки запуска здесь нет вовсе, пока не разрешена прошлая попытка:
        // единственное действие — ответить, что показал принтер (выше).
        unresolved
          ? ""
          : `<button type="button" class="btn btn-sm btn-primary" data-launch-go ${canLaunch ? "" : "disabled"}>
               ${ui.busy ? "Запускаю…" : esc(cta)}
             </button>`
      }
    </div>`;
}
