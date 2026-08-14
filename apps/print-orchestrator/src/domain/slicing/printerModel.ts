/**
 * Printer-model identity — the single rule for "is this machine profile actually
 * for this printer?".
 *
 * It used to be a substring test (`a.includes(b) || b.includes(a)`), which is wrong
 * in both directions for real farm hardware:
 *
 *   - `"Bambu Lab A1"` ⊂ `"Bambu Lab A1 mini"` and `"Creality K2"` ⊂ `"Creality K2
 *     Plus"`, so a profile for the *other* machine (different bed, different nozzle
 *     limits) passed the hard model check and could be sliced for the wrong printer;
 *   - a genuine match could still be missed when the two names spell the vendor
 *     differently (`"Ender-3 V3 KE"` vs `"Creality Ender 3 V3 KE"`).
 *
 * So models are compared as *normalised token sequences* instead:
 *
 *   - punctuation/case/spacing are irrelevant (`Ender-3 V3 KE` = `ender3v3ke`);
 *   - vendor words are dropped, so a profile's `printer_model` ("Bambu Lab A1") and
 *     a farm printer's configured model ("A1") agree;
 *   - **kit/bundle words are dropped** — `"Bambu Lab A1 Combo"` IS a `Bambu Lab A1`:
 *     the Combo is that same printer sold together with an AMS Lite, and OrcaSlicer
 *     has no separate machine for it. The multi-material unit is a property of the
 *     printer (see `PrinterConfig`), never a second printer model;
 *   - every other token is significant, so `A1` ≠ `A1 mini` and `K2` ≠ `K2 Plus`.
 */

/** Manufacturer words that carry no model information. */
const VENDOR_TOKENS = new Set(["bambu", "bambulab", "lab", "creality", "orca", "orcaslicer"]);

/**
 * Words describing what a machine was *bundled with*, not which machine it is.
 * `Combo` = printer + AMS Lite (Bambu), `CFS`/`AMS` = the multi-material unit itself.
 */
const KIT_TOKENS = new Set(["combo", "ams", "amslite", "cfs", "kit", "bundle", "set"]);

/**
 * Splits a model string into significant tokens: lowercased, punctuation-free,
 * vendor and kit words removed. Digit/letter runs are kept as written so `a1` stays
 * one token and `mini` stays separate.
 */
export function modelTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !VENDOR_TOKENS.has(t) && !KIT_TOKENS.has(t));
}

/** The comparable identity of a printer model ("Bambu Lab A1 Combo" → "a1"). */
export function normalizePrinterModel(value: string | null | undefined): string {
  return modelTokens(value).join("");
}

/**
 * True when two model strings name the same machine. Either side being unknown
 * (empty after normalisation) yields `true`: an absent value is "not stated", and
 * hard-blocking on a comparison we cannot make would refuse work for a printer
 * whose model simply is not configured.
 */
export function printerModelsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePrinterModel(a);
  const nb = normalizePrinterModel(b);
  if (!na || !nb) return true;
  return na === nb;
}

/**
 * The same comparison for *discovery* ("which profiles cover this printer?"), where
 * an unknown model must NOT match everything — a nameless profile is not coverage.
 */
export function printerModelsMatchStrict(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const na = normalizePrinterModel(a);
  const nb = normalizePrinterModel(b);
  return Boolean(na) && na === nb;
}
