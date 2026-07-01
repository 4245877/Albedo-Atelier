import type { AutomationAction } from "./actions";
import type { AutomationRule } from "./rules";

export class AutomationService {
  evaluate(_rule: AutomationRule): AutomationAction[] {
    return [];
  }
}

export const automationService = new AutomationService();
