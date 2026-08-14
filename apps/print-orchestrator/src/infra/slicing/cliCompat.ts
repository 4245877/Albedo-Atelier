/**
 * Workarounds for defects in the OrcaSlicer **CLI** itself — kept in one place, and
 * applied to the machine config only for the duration of a slice, so nothing is
 * silently written back into the operator's stored profiles.
 *
 * ## The relative-E / `G92 E0` gate
 *
 * `Print::validate()` refuses relative extruder addressing unless the extruder is
 * reset each layer:
 *
 * ```
 * Relative extruder addressing requires resetting the extruder position at each
 * layer to prevent loss of floating point accuracy. Add "G92 E0" to layer_gcode.
 * ```
 *
 * Upstream skips that check entirely for Bambu printers (`if (!is_BBL_printer())`),
 * because their layer-change G-code is generated differently. In the GUI the flag is
 * set before validation; in the CLI it is not — `OrcaSlicer.cpp` calls
 * `print->validate()` at line 4901 but only assigns
 * `print->is_BBL_printer() = is_bbl_vendor_preset` at line 4988, so the flag is still
 * false while validation runs. Every Bambu preset therefore fails the gate through
 * the CLI, since `use_relative_e_distances` defaults to `1` and no BBL machine
 * profile overrides it. Verified against v2.3.0 with the *stock* `Bambu Lab A1 0.4
 * nozzle` chain: without this shim the slice dies with `return_code -51`; with it,
 * the same chain yields valid G-code.
 *
 * `G92 E0` is the fix upstream's own message asks for, and it is a no-op for the
 * printed geometry: in relative mode the extruder coordinate is not used as a
 * position, so zeroing it at each layer only bounds float drift — which is precisely
 * why the check exists.
 */

/** Matches a `G92 E0` reset in a custom G-code block, tolerating spacing/decimals. */
const G92_E0_RE = /G92\s+E0(?:\.0*)?\b/i;

/** The G-code flavours upstream applies the relative-E gate to. */
const GATED_FLAVORS = new Set(["marlin", "marlin2"]);

export interface CompatShim {
  /** Stable id, so logs/tests can assert *which* workaround fired. */
  id: string;
  /** One line an operator can act on. */
  reason: string;
}

export interface ShimResult {
  machine: Record<string, unknown>;
  applied: CompatShim[];
}

/**
 * Returns the machine config the CLI should actually be given, plus which shims
 * fired. The input object is never mutated.
 */
export function applyCliCompatShims(machine: Record<string, unknown>): ShimResult {
  const applied: CompatShim[] = [];
  let out = machine;

  if (needsRelativeEReset(machine)) {
    const before = asString(machine.before_layer_change_gcode);
    out = {
      ...out,
      // Prepend rather than replace: a profile may carry its own layer-change
      // preamble that must still run.
      before_layer_change_gcode: before ? `G92 E0\n${before}` : "G92 E0"
    };
    applied.push({
      id: "relative_e_g92_reset",
      reason:
        "OrcaSlicer CLI проверяет relative-E до того, как помечает принтер как Bambu " +
        "(is_BBL_printer выставляется после validate), поэтому в before_layer_change_gcode " +
        "добавлен «G92 E0» — без него слайсинг любого Bambu-профиля падает с кодом -51"
    });
  }

  return { machine: out, applied };
}

/** True when this config would trip upstream's relative-E gate in the CLI. */
export function needsRelativeEReset(machine: Record<string, unknown>): boolean {
  if (!usesRelativeE(machine)) return false;
  const flavor = asString(machine.gcode_flavor).trim().toLowerCase();
  // Upstream gates only the Marlin flavours; leave anything else untouched.
  if (flavor && !GATED_FLAVORS.has(flavor)) return false;
  const layer = asString(machine.layer_change_gcode);
  const before = asString(machine.before_layer_change_gcode);
  return !G92_E0_RE.test(layer) && !G92_E0_RE.test(before);
}

/**
 * Whether the slice will use relative extruder addressing.
 *
 * **Absent means on.** `use_relative_e_distances` defaults to `1` in OrcaSlicer's
 * built-in config (confirmed via `--export-settings` on 2.3.0), and no Bambu machine
 * profile overrides it — the stock `Bambu Lab A1 0.4 nozzle` chain simply omits the
 * key. Reading "absent" as "off" is why the shim first failed to fire for the stock
 * chain while the user's own export (which writes every key out explicitly, `"1"`
 * included) was handled correctly.
 */
export function usesRelativeE(machine: Record<string, unknown>): boolean {
  const raw = machine.use_relative_e_distances;
  if (raw === undefined || raw === null || raw === "") return true;
  if (Array.isArray(raw) && raw.length === 0) return true;
  return isTruthy(raw);
}

/** Orca writes booleans as `"1"`/`"0"` strings (and sometimes as real booleans). */
function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const s = Array.isArray(value) ? value[0] : value;
  if (typeof s === "number") return s !== 0;
  if (typeof s !== "string") return false;
  const t = s.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

function asString(value: unknown): string {
  const s = Array.isArray(value) ? value[0] : value;
  return typeof s === "string" ? s : "";
}
