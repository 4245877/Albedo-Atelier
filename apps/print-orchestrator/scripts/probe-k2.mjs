#!/usr/bin/env node
/**
 * One-shot diagnostic probe for a Creality K2 (or any Moonraker printer) that
 * dumps the RAW payloads relevant to nozzle diameter and active filament, so the
 * live shape can be verified against real hardware before wiring more of it into
 * the poll loop. This is intentionally OUTSIDE the orchestrator's poll path — it
 * is never imported by the service and leaves no debug logging behind.
 *
 * The coding sandbox has no LAN route to the printer, but the orchestrator
 * container does. Run it there:
 *
 *   docker cp apps/print-orchestrator/scripts/probe-k2.mjs \
 *     atelier-print-orchestrator:/tmp/probe-k2.mjs
 *   docker exec atelier-print-orchestrator node /tmp/probe-k2.mjs 192.168.0.132 4408
 *
 * (The K2 must be powered ON — when it sleeps, every port is closed.)
 *
 * What it reports:
 *   - /printer/info                         reachability + Klipper state
 *   - /printer/objects/list                 which objects exist (box? filament_rack?)
 *   - configfile.settings.extruder          -> nozzle_diameter (the live setting)
 *   - box / filament_rack (raw)             CFS slots / external spool, if present
 *   - print_stats.filename + its metadata   -> filament_type of the current job
 */

const host = process.argv[2] || "192.168.0.132";
const port = process.argv[3] || "4408";
const base = `http://${host}:${port}`;

async function get(path, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(base + path, { signal: ctrl.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(t);
  }
}

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

console.log(`\n=== Creality K2 / Moonraker probe: ${base} ===\n`);

const info = await get("/printer/info");
if (!info.ok) {
  console.log(`UNREACHABLE: ${info.error || `HTTP ${info.status}`}`);
  console.log("(Is the K2 powered on and on the LAN? Is the port right — 4408 proxy / 7125 direct?)");
  process.exit(1);
}
line("klippy_state", info.json?.result?.state ?? "?");
line("hostname", info.json?.result?.hostname ?? "?");

// 1) Which printer objects does this device actually expose?
const list = await get("/printer/objects/list");
const objects = list.json?.result?.objects ?? [];
const interesting = objects.filter((o) =>
  /^(box|filament_rack|extruder|configfile|print_stats|motor_control|load_ai|fan_feedback)/.test(o)
);
console.log("\n--- objects/list (filament/nozzle related) ---");
console.log("  " + (interesting.join(", ") || "(none matched)"));
line("has box (CFS)", objects.includes("box") ? "YES" : "no");
line("has filament_rack", objects.includes("filament_rack") ? "YES" : "no");

// 2) Nozzle diameter from the parsed Klipper config.
const cfg = await get("/printer/objects/query?configfile=settings");
const extruder = cfg.json?.result?.status?.configfile?.settings?.extruder ?? null;
console.log("\n--- configfile.settings.extruder ---");
line("nozzle_diameter", extruder?.nozzle_diameter ?? "(absent)");
line("filament_diameter", extruder?.filament_diameter ?? "(absent)");

// 3) Active filament: CFS box + external filament_rack (raw, verbatim).
const fil = await get(
  "/printer/objects/query?box&filament_rack&print_stats&extruder=temperature,target"
);
const st = fil.json?.result?.status ?? {};
console.log("\n--- box (CFS), raw ---");
console.log(st.box ? JSON.stringify(st.box, null, 2) : "  (no box object — no CFS on this unit)");
console.log("\n--- filament_rack (external spool), raw ---");
console.log(st.filament_rack ? JSON.stringify(st.filament_rack, null, 2) : "  (absent)");

// 4) Current job's sliced filament type, via file metadata.
const filename = st.print_stats?.filename || "";
console.log("\n--- print_stats ---");
line("filename", filename || "(idle / none)");
line("state", st.print_stats?.state ?? "?");
if (filename) {
  const meta = await get(`/server/files/metadata?filename=${encodeURIComponent(filename)}`);
  const m = meta.json?.result ?? {};
  console.log("\n--- gcode metadata (sliced job) ---");
  line("filament_type", m.filament_type ?? "(absent)");
  line("filament_name", m.filament_name ?? "(absent)");
  line("filament_total(mm)", m.filament_total ?? "(absent)");
  line("filament_weight_total(g)", m.filament_weight_total ?? "(absent)");
} else {
  console.log("\n(no active file — start/queue a print to see sliced filament metadata)");
}

console.log("\n=== done ===\n");
