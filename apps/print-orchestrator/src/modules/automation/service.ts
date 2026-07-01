import { farmStore } from "../../infra/store/farmStore";
import type { Automation, AutomationsSection } from "../../domain/dashboard/types";

export function listAutomations(): AutomationsSection {
  return farmStore.getAutomations();
}

export function toggleAutomation(id: string, on?: boolean): Automation {
  return farmStore.toggleAutomation(id, on);
}
