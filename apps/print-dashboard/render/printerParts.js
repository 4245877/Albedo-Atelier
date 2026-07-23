/* ── Общие блоки принтера: материал, телеметрия, панель действий ──
   Одна точка правды для карточки (render/printers.js) и модального окна
   (render/modals.js): строка филамента, температурные пары и общий набор
   кнопок управления. Доступность действий решает printerView.actionAvailability
   — здесь только разметка. */

import { esc } from "../util.js";
import { fmtNozzle } from "../shared/format.js";
import { actionAvailability } from "./printerView.js";

/**
 * Строка филамента: живой материал с принтера (тег «с принтера») либо
 * материал из конфигурации (тег «из конфигурации»); плюс чип диаметра сопла,
 * когда принтер его сообщает. Цвет-плашка — из живого цвета, иначе из swatch.
 */
export function materialBlock(p) {
  const live = p.liveMaterialSource === "printer" && p.liveMaterial;
  const color = live && p.liveMaterialColor ? p.liveMaterialColor : p.swatch;
  const dot = color ? `<span class="swatch" style="background:${esc(color)}"></span>` : "";

  let text;
  let tag = "";
  if (live) {
    text = esc(p.liveMaterial);
    tag = `<span class="src-tag src-printer">с принтера</span>`;
  } else if (p.material) {
    text = esc(p.material);
    tag = `<span class="src-tag src-config">из конфигурации</span>`;
  } else {
    text = "материал не указан";
  }

  const nozzle = fmtNozzle(p.nozzleDiameter);
  // A config-sourced diameter must not look like live telemetry: mute it and
  // label it, mirroring the «из конфигурации» tag on the material itself.
  const nozzleFromConfig = p.nozzleDiameterSource === "config";
  const nozzleChip = nozzle
    ? `<span class="nozzle-chip${nozzleFromConfig ? " nozzle-chip-config" : ""}"${
        nozzleFromConfig ? ' title="из конфигурации"' : ""
      }>Сопло ${esc(nozzle)} мм</span>`
    : "";

  return `<div class="printer-material">${dot}<span>${text}</span>${tag}${nozzleChip}</div>`;
}

/**
 * Температурные пары телеметрии: [метка, текущая, цель|null]. Камера (chamber)
 * цели не имеет. Карточка и модальное окно форматируют каждая по-своему, но
 * состав строк общий.
 */
export function telemetryTempRows(p) {
  const rows = [];
  if (p.nozzle) rows.push(["Сопло", p.nozzle[0], p.nozzle[1] ?? null]);
  if (p.bed) rows.push(["Стол", p.bed[0], p.bed[1] ?? null]);
  if (p.chamber != null) rows.push(["Камера", p.chamber, null]);
  return rows;
}

/**
 * Общий набор кнопок управления принтером (пауза/продолжить/отмена/подсветка/
 * снимок) с одинаковой логикой доступности и подсказок. Карточка и модальное
 * окно оборачивают его своими дополнительными кнопками (открыть/файлы/ссылки).
 */
export function commonActionButtons(p, can = actionAvailability(p)) {
  const lightTitle = can.lightUnknown && can.lightSupported
    ? ' title="Состояние подсветки неизвестно — команда будет отправлена вручную"'
    : "";
  return `
    <button class="btn btn-sm" data-act="pause" data-id="${esc(p.id)}" ${can.canPause ? "" : "disabled"}>⏸ Пауза</button>
    <button class="btn btn-sm" data-act="resume" data-id="${esc(p.id)}" ${can.canResume ? "" : "disabled"}>▶ Продолжить</button>
    <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(p.id)}" ${can.canCancel ? "" : "disabled"}>✕ Отмена</button>
    <button class="btn btn-sm" data-act="light-on" data-id="${esc(p.id)}"${lightTitle} ${can.canLightOn ? "" : "disabled"}>☀ Подсветка</button>
    <button class="btn btn-sm" data-act="light-off" data-id="${esc(p.id)}"${lightTitle} ${can.canLightOff ? "" : "disabled"}>☾ Погасить</button>`;
}
