import { API_BASE } from "../api.js";
import { $, badge, esc, emptyRow, fmtLeft, materialBlock } from "../util.js";

/* ── Принтеры и камеры ─────────────────────────────────────── */

const PRINTER_SVG = `
  <svg viewBox="0 0 100 60" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M14 54 L14 10 L86 10 L86 54" opacity=".7"/>
    <path d="M6 54 L94 54" />
    <path d="M22 22 L78 22" opacity=".5"/>
    <rect x="42" y="22" width="16" height="10" rx="2"/>
    <path d="M50 32 L50 38" />
    <path d="M30 46 L70 46" stroke-dasharray="3 4" opacity=".8"/>
  </svg>`;

export function camBlock(p, ctx) {
  if (p.camera === "none") {
    return `<div class="cam"><div class="cam-offline">камера не настроена</div></div>`;
  }

  if (p.camera === "offline") {
    return `<div class="cam"><div class="cam-offline">нет сигнала</div>
      ${p.snapshotAt ? `<span class="cam-tag"><i class="dot"></i>снимок ${p.snapshotAt}</span>` : ""}</div>`;
  }

  // Live-трансляция (WebRTC через go2rtc): в разметку кладём только стабильную
  // точку крепления. Сам <camera-stream> живёт в постоянном реестре (см.
  // reconcileCameras), переживает перерисовку доски — обновление телеметрии
  // больше не рвёт поток — и сам переподключается при обрыве. Состояние связи
  // показывает сам плеер, поэтому статус снапшот-пробы здесь не решает.
  if (p.cameraSrc) {
    const slot = `${p.id}::${ctx}`;
    return `
      <div class="cam ${p.light ? "cam-lit" : ""}">
        ${PRINTER_SVG}
        <div class="cam-mount" data-cam-slot="${esc(slot)}" data-cam-src="${esc(p.cameraSrc)}"></div>
        <span class="cam-flash" data-flash="${p.id}"></span>
      </div>`;
  }

  // Live-трансляция через backend MJPEG-прокси (Bambu A1): держим постоянный
  // <img> в реестре, чтобы обновление доски не разрывало долгий HTTP-ответ.
  if (p.cameraStream) {
    const slot = `${p.id}::${ctx}`;
    const src = `${API_BASE}/api/printers/${encodeURIComponent(p.id)}/camera.mp4`;
    return `
      <div class="cam cam-stream ${p.light ? "cam-lit" : ""}">
        ${PRINTER_SVG}
        <div class="cam-mount" data-cam-mjpeg-slot="${esc(slot)}" data-cam-mjpeg-src="${esc(src)}" data-cam-alt="Камера ${esc(p.name)}"></div>
        <div class="cam-state">подключение…</div>
        <span class="cam-tag live"><i class="dot"></i>LIVE</span>
        <span class="cam-flash" data-flash="${p.id}"></span>
      </div>`;
  }

  // Камера только со снимками: реальный JPEG-кадр. При ошибке загрузки
  // остаётся svg-заглушка.
  return `
    <div class="cam ${p.light ? "cam-lit" : ""}">
      ${PRINTER_SVG}
      <img class="cam-img" alt="Камера ${esc(p.name)}" loading="lazy"
        src="${API_BASE}/api/printers/${encodeURIComponent(p.id)}/camera.jpg?t=${encodeURIComponent(p.snapshotAt || Date.now())}"
        onerror="this.remove()">
      <span class="cam-tag"><i class="dot"></i>снимок ${p.snapshotAt || "—"}</span>
      <span class="cam-flash" data-flash="${p.id}"></span>
    </div>`;
}

/** Температура вида «тек/цель»; цель может быть неизвестна — тогда только текущая. */
function tempCell(pair) {
  const target = pair[1] != null ? `<span style="color:var(--ink-faint)">/${pair[1]}°</span>` : "";
  return `${pair[0]}°${target}`;
}

function teleBlock(p) {
  const cells = [];
  if (p.nozzle) cells.push(["Сопло", tempCell(p.nozzle)]);
  if (p.bed) cells.push(["Стол", tempCell(p.bed)]);
  if (p.chamber != null) cells.push(["Камера", `${p.chamber}°`]);
  cells.push(["Осталось", fmtLeft(p.minutesLeft)]);
  if (cells.length === 1 && p.minutesLeft == null) {
    return `<div class="telemetry"><div class="tele"><span class="t-lbl">Телеметрия</span><span class="t-val">недоступна</span></div></div>`;
  }
  return `<div class="telemetry">${cells
    .map(([l, v]) => `<div class="tele"><span class="t-lbl">${l}</span><span class="t-val">${v}</span></div>`)
    .join("")}</div>`;
}

function printerCard(p) {
  const busy = p.status === "printing" || p.status === "paused";
  const dead = p.status === "offline";
  const jobLine =
    busy && p.job ? `Печатает: <b>${esc(p.job)}</b>` :
    busy ? "Печатает — название задания не определено" :
    p.status === "error" ? `<span style="color:var(--danger);font-weight:700">${esc(p.error || "Ошибка")}</span>` :
    p.status === "maintenance" ? esc(p.note || "На обслуживании") :
    p.status === "unknown" ? esc(p.error || "Состояние неизвестно — принтер ещё не ответил") :
    dead ? esc(p.error ? `Нет связи: ${p.error}` : "Нет связи с принтером") :
    "Свободен — ожидает распоряжений";

  // light === null: состояние подсветки неизвестно. Управляемость определяет
  // ТОЛЬКО backend-флаг lightSupported — читаемость состояния не означает, что
  // подсветкой можно управлять (иначе кнопка «включится», а backend вернёт ошибку).
  const lightUnknown = p.light == null;
  const lightSupported = Boolean(p.lightSupported);
  const lightTitle = lightUnknown && lightSupported ? ' title="Состояние подсветки неизвестно — команда будет отправлена вручную"' : "";
  const lightOnDisabled = !lightSupported || p.light === true || dead;
  const lightOffDisabled = !lightSupported || p.light === false || dead;
  const actions = `
    <button class="btn btn-sm" data-act="open" data-id="${p.id}">Открыть</button>
    <button class="btn btn-sm" data-act="pause" data-id="${p.id}" ${p.status !== "printing" ? "disabled" : ""}>⏸ Пауза</button>
    <button class="btn btn-sm" data-act="resume" data-id="${p.id}" ${p.status !== "paused" ? "disabled" : ""}>▶ Продолжить</button>
    <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${p.id}" ${!busy ? "disabled" : ""}>✕ Отмена</button>
    <button class="btn btn-sm" data-act="light-on" data-id="${p.id}"${lightTitle} ${lightOnDisabled ? "disabled" : ""}>☀ Подсветка</button>
    <button class="btn btn-sm" data-act="light-off" data-id="${p.id}"${lightTitle} ${lightOffDisabled ? "disabled" : ""}>☾ Погасить</button>
    <button class="btn btn-sm" data-act="snapshot" data-id="${p.id}" ${p.camera !== "online" || dead || p.cameraSrc ? "disabled" : ""}>◉ Снимок</button>`;

  const progressBlock = !busy ? "" : p.progress != null ? `
    <div class="printer-progress">
      <div class="progress ${p.status === "paused" ? "is-paused" : ""}"><i style="width:${p.progress}%"></i></div>
      <div class="progress-caption"><b>${Math.round(p.progress)}%</b><span>осталось ${fmtLeft(p.minutesLeft)}</span></div>
    </div>` : `
    <div class="printer-progress">
      <div class="progress-caption"><b>—%</b><span>прогресс не сообщается принтером</span></div>
    </div>`;

  return `
    <article class="printer-card ${p.status === "error" ? "is-error" : ""} ${dead ? "is-offline" : ""}">
      ${camBlock(p, "card")}
      <div class="printer-body">
        <div class="printer-top">
          <div>
            <h3 class="printer-name">${esc(p.name)}<span class="type-chip ${p.type === "FDM" ? "type-fdm" : "type-resin"}">${p.type}</span></h3>
            <div class="printer-model">${esc(p.model || "модель не указана")}</div>
          </div>
          ${badge(p.status)}
        </div>
        <div class="printer-job">${jobLine}</div>
        ${progressBlock}
        ${teleBlock(p)}
        ${materialBlock(p)}
        <div class="printer-actions">${actions}</div>
      </div>
    </article>`;
}

export function renderPrinters(state) {
  const p = state.printers;
  $("#printers-meta").textContent =
    `${p.filter((x) => x.status === "printing").length} печатают · ${p.filter((x) => x.status === "idle").length} свободны · ${p.length} всего`;
  $("#printer-grid").innerHTML = p.map(printerCard).join("") ||
    `<div class="row"><div class="grow row-sub">Принтеры не настроены — добавьте их в config/printers.json на backend</div></div>`;
}

export function renderCameras(state) {
  const cams = state.printers.filter((p) => p.camera !== "none");
  const online = cams.filter((p) => p.camera === "online");
  $("#cameras-meta").textContent = cams.length
    ? `${online.length} online · ${cams.length - online.length} offline`
    : "не настроены";
  $("#cameras-body").innerHTML = `
    <div class="cam-grid">
      ${cams.map((p) => `
        <div class="cam-thumb" data-act="open" data-id="${p.id}" title="Открыть ${esc(p.name)}">
          <span class="cam-thumb-name">${esc(p.name)}</span>
          ${camBlock(p, "thumb")}
        </div>`).join("") || `<ul class="row-list" style="grid-column:1/-1">${emptyRow("Ни у одного принтера не настроена камера (snapshotUrl в конфигурации)")}</ul>`}
    </div>`;
}
