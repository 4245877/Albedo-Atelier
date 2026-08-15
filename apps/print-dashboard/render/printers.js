import { API_BASE } from "../api.js";
import { $, esc, emptyState } from "../util.js";
import { badge } from "../shared/chips.js";
import { fmtLeft } from "../shared/format.js";
import { icon } from "../shared/icons.js";
import { actionBar, materialBlock, telemetryTempRows } from "./printerParts.js";
import {
  actionAvailability,
  jobLine,
  lightPolicyLine,
  normalizeProgress,
  progressBarHtml,
  progressPercentText
} from "./printerView.js";

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

/* Камеры нет вовсе — резервировать под это 16:9 нельзя: пустой прямоугольник
   в треть карточки не сообщает ничего, ради чего стоило бы отдать столько
   места. Остаётся одна тихая полоса, и она честно говорит, что делать. */
export function camBlock(p, ctx) {
  if (p.camera === "none") {
    return `<div class="cam-strip cam-strip-none">
      ${icon("camera")}<span>Камера не настроена</span>
      <button type="button" class="cam-strip-fix" data-goto="hardware">Настроить</button>
    </div>`;
  }

  /* Связи нет. Полезнее показать ПОСЛЕДНИЙ КАДР — затемнённым и со временем,
     когда он был снят, — чем перечёркнутую заглушку во весь блок: оператор
     хотя бы видит, чем всё закончилось. Кадра нет — остаётся узкая полоса. */
  if (p.camera === "offline") {
    if (p.latestSnapshotUrl) {
      return `
        <div class="cam cam-stale">
          ${PRINTER_SVG}
          <img class="cam-img" alt="Последний кадр камеры ${esc(p.name)}" loading="lazy"
            src="${API_BASE}${esc(p.latestSnapshotUrl)}" onerror="this.remove()">
          <span class="cam-tag cam-tag-stale">${icon("warn")}<span>Нет связи · кадр ${esc(p.snapshotAt || "—")}</span></span>
        </div>`;
    }
    return `<div class="cam-strip cam-strip-offline">
      ${icon("warn")}<span>Нет сигнала${p.snapshotAt ? ` · последний кадр ${esc(p.snapshotAt)}` : ""}</span>
    </div>`;
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
        <span class="cam-tag live"><i class="dot"></i><span>LIVE</span></span>
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
      <span class="cam-tag"><i class="dot"></i><span>снимок ${esc(p.snapshotAt || "—")}</span></span>
      <span class="cam-flash" data-flash="${p.id}"></span>
    </div>`;
}

/** Температура вида «тек/цель»; цель может быть неизвестна — тогда только текущая. */
function tempCell(current, target) {
  const tail = target != null ? `<span style="color:var(--ink-faint)">/${target}°</span>` : "";
  return `${current}°${tail}`;
}

function teleBlock(p) {
  const cells = telemetryTempRows(p).map(([label, current, target]) => [label, tempCell(current, target)]);
  cells.push(["Осталось", fmtLeft(p.minutesLeft)]);
  if (cells.length === 1 && p.minutesLeft == null) {
    return `<div class="telemetry"><div class="tele"><span class="t-lbl">Телеметрия</span><span class="t-val">недоступна</span></div></div>`;
  }
  return `<div class="telemetry">${cells
    .map(([l, v]) => `<div class="tele"><span class="t-lbl">${l}</span><span class="t-val">${v}</span></div>`)
    .join("")}</div>`;
}

function printerCard(p, lightEntry) {
  const can = actionAvailability(p);
  // Решение автоматики подсветки (state.lights) — отдельно от фактического
  // состояния лампы, которое показывает переключатель света и подсветка камеры.
  const lightLine = lightEntry ? `<div class="printer-light">${esc(lightPolicyLine(lightEntry))}</div>` : "";

  const progressBlock = !can.busy ? "" : normalizeProgress(p.progress) != null ? `
    <div class="printer-progress">
      ${progressBarHtml(p.progress, { paused: p.status === "paused" })}
      <div class="progress-caption"><b>${progressPercentText(p.progress)}</b><span>осталось ${fmtLeft(p.minutesLeft)}</span></div>
    </div>` : `
    <div class="printer-progress">
      <div class="progress-caption"><b>—%</b><span>прогресс не сообщается принтером</span></div>
    </div>`;

  return `
    <article class="printer-card ${p.status === "error" ? "is-error" : ""} ${can.offline ? "is-offline" : ""}">
      ${camBlock(p, "card")}
      <div class="printer-body">
        <div class="printer-top">
          <div>
            <h3 class="printer-name">${esc(p.name)}<span class="type-chip ${p.type === "FDM" ? "type-fdm" : "type-resin"}">${p.type}</span></h3>
            <div class="printer-model">${esc(p.model || "модель не указана")}</div>
          </div>
          ${badge(p.status)}
        </div>
        <div class="printer-job">${jobLine(p)}</div>
        ${progressBlock}
        ${teleBlock(p)}
        ${materialBlock(p)}
        ${lightLine}
        ${actionBar(p, { context: "card" })}
      </div>
    </article>`;
}

export function renderPrinters(state) {
  const p = state.printers;
  const lightsById = new Map((state.lights || []).map((l) => [l.id, l]));
  $("#printers-meta").textContent =
    `${p.filter((x) => x.status === "printing").length} печатают · ${p.filter((x) => x.status === "idle").length} свободны · ${p.length} всего`;
  $("#printer-grid").innerHTML = p.map((x) => printerCard(x, lightsById.get(x.id))).join("") ||
    emptyState(
      "В зале ещё нет ни одного принтера, Владыка. Примите первого — и я тотчас возьму его под надзор.",
      { glyph: "printer", action: `<button type="button" class="btn btn-sm btn-primary" data-goto="hardware">Принять принтер</button>` }
    );
}

export function renderCameras(state) {
  const cams = state.printers.filter((p) => p.camera !== "none");
  const online = cams.filter((p) => p.camera === "online");
  $("#cameras-meta").textContent = cams.length
    ? `${online.length} в эфире · ${cams.length - online.length} без связи`
    : "не настроены";

  if (!cams.length) {
    $("#cameras-body").innerHTML = emptyState(
      "Ни один принтер не открыт моему взору — камеры не настроены.",
      { glyph: "camera", action: `<button type="button" class="btn btn-sm" data-goto="hardware">Указать адрес камеры</button>` }
    );
    return;
  }

  // Превью — настоящая кнопка, а не кликабельный <div>: только так до неё
  // добирается Tab, срабатывает Enter/Space и скринридер называет действие.
  $("#cameras-body").innerHTML = `
    <div class="cam-grid">
      ${cams.map((p) => `
        <button type="button" class="cam-thumb" data-act="open" data-id="${esc(p.id)}"
          aria-label="Открыть ${esc(p.name)}">
          <span class="cam-thumb-name">${esc(p.name)}</span>
          ${camBlock(p, "thumb")}
        </button>`).join("")}
    </div>`;
}
