import { isSectionVisible } from "../nav.js";
import { renderCameras, renderPrinters } from "./printers.js";
import {
  renderAutomations,
  renderCritical,
  renderFeed,
  renderHero,
  renderMaintenance,
  renderMaterials,
  renderNight,
  renderPerf,
  renderPlan,
  renderQuick,
  renderQueue,
  renderSystem,
  renderToday,
  renderWarnings
} from "./sections.js";

/** Перерисовывает все секции доски из состояния (порядок как в исходной вёрстке). */
export function renderBoard(state) {
  renderHero(state);
  renderPrinters(state);
  renderQueue(state);
  renderNight(state);
  renderCritical(state);
  renderMaterials(state);
  renderToday(state);
  renderPerf(state);
  renderAutomations(state);
  renderCameras(state);
  // «Обслуживание» и «План» скрыты, пока backend отдаёт только пустые
  // заглушки (см. HIDDEN_SECTIONS в nav.js) — их рендер тогда пропускается.
  if (isSectionVisible("maintenance")) renderMaintenance(state);
  renderQuick();
  renderSystem(state);
  renderFeed(state);
  renderWarnings(state);
  if (isSectionVisible("plan")) renderPlan(state);
}
