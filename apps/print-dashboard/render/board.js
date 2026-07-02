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
  renderQueue(state);
  renderNight(state);
  renderPrinters(state);
  renderCritical(state);
  renderMaterials(state);
  renderToday(state);
  renderPerf(state);
  renderAutomations(state);
  renderCameras(state);
  renderMaintenance(state);
  renderQuick();
  renderSystem(state);
  renderFeed(state);
  renderWarnings(state);
  renderPlan(state);
}
