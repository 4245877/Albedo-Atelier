import type { PrinterConfig } from "../config";

/** Empty by default. Populate a category only AFTER its separate hardware acceptance. */
export function anycubicControlAllowed(printer: PrinterConfig, category: "light" | "print"): boolean {
  if (printer.protocol !== "anycubic-lan") return false;
  const key = category === "light" ? "ANYCUBIC_LIGHT_CONTROL_PRINTERS" : "ANYCUBIC_PRINT_CONTROL_PRINTERS";
  return (process.env[key] ?? "").split(",").map(x => x.trim()).filter(Boolean).includes(printer.id);
}
