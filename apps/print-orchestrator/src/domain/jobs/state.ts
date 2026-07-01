import type { StateTransition } from "../../core/stateMachine";
import { canTransition } from "../../core/stateMachine";
import type { PrintJobState } from "./types";

export const jobTransitions: StateTransition<PrintJobState>[] = [
  { from: "draft", to: "queued" },
  { from: "queued", to: "printing" },
  { from: "printing", to: "paused" },
  { from: "paused", to: "printing" },
  { from: "printing", to: "completed" },
  { from: "printing", to: "failed" },
  { from: "queued", to: "canceled" },
  { from: "paused", to: "canceled" }
];

export function canChangeJobState(current: PrintJobState, next: PrintJobState): boolean {
  return current === next || canTransition(current, next, jobTransitions);
}
