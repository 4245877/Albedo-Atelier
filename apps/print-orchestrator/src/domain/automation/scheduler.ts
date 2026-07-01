import type { AutomationRule } from "./rules";

export function getEnabledRules(rules: AutomationRule[]): AutomationRule[] {
  return rules.filter((rule) => rule.enabled);
}
