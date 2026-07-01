import type { StateTransition } from "../../core/stateMachine";
import { canTransition } from "../../core/stateMachine";
import type { PrinterState } from "./types";

export const printerTransitions: StateTransition<PrinterState>[] = [
  { from: "offline", to: "idle" },
  { from: "idle", to: "printing" },
  { from: "printing", to: "paused" },
  { from: "paused", to: "printing" },
  { from: "printing", to: "idle" },
  { from: "paused", to: "idle" },
  { from: "idle", to: "maintenance" },
  { from: "maintenance", to: "idle" },
  { from: "idle", to: "error" },
  { from: "printing", to: "error" },
  { from: "paused", to: "error" },
  { from: "error", to: "idle" },
  { from: "idle", to: "offline" }
];

export function canChangePrinterState(current: PrinterState, next: PrinterState): boolean {
  return current === next || canTransition(current, next, printerTransitions);
}
