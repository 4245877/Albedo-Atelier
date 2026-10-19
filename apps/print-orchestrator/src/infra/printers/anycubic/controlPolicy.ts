import type { PrinterConfig } from "../config";

/**
 * This release admits passive camera viewing and file browsing only. Environment
 * allowlists cannot enable unaccepted hardware commands or the light scheduler.
 * Keep the isolated session-control tests; opening a category requires a later
 * reviewed change after its separate hardware acceptance.
 */
export function anycubicControlAllowed(_printer: PrinterConfig, _category: "light" | "print"): boolean {
  return false;
}
