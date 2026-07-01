import type { AutomationRule } from "../../domain/automation/rules";

const rules: AutomationRule[] = [];

export async function listAutomationRules(): Promise<AutomationRule[]> {
  return [...rules];
}
