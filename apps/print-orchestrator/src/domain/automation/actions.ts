export type AutomationActionType = "pause_job" | "cancel_job" | "notify" | "start_job";

export interface AutomationAction {
  type: AutomationActionType;
  payload?: Record<string, unknown>;
}
