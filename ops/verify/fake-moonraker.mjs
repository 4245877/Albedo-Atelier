#!/usr/bin/env node
/*
 * A simulated Klipper/Moonraker printer — the HTTP surface the orchestrator's
 * Moonraker adapter speaks (status query, file listing/metadata, multipart
 * upload, delete, print start/pause/resume/cancel), and nothing else.
 *
 * Used by ops/verify/run.sh to drive the real orchestrator image end to end
 * without any real printer: it runs inside an `--internal` docker network, so
 * neither it nor the orchestrator under test can reach the farm.
 *
 * Every command it receives is logged, so a scenario can assert "exactly one
 * start reached the printer". Control endpoints under /__sim/ let a scenario
 * break the device the way real ones break:
 *
 *   GET  /__sim/state            the simulated device + command log
 *   POST /__sim/set              { online?, printSeconds?, dropStartResponse?,
 *                                  dropStartAndIgnore?, rejectNextStart? }
 *   POST /__sim/finish           finish the current print now
 *   POST /__sim/reset            idle, empty SD card, empty log
 *
 * No dependencies; Node 22.
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 7125);
const HOSTNAME = process.env.SIM_NAME ?? "fake-moonraker";
const BUILD_MM = Number(process.env.BUILD_MM ?? 260);

const sim = {
  online: true,
  printSeconds: Number(process.env.PRINT_SECONDS ?? 20),
  /** The next start is executed, but the HTTP response is lost (socket destroyed). */
  dropStartResponse: false,
  /** The next start is NOT executed and the response is lost — a command that died on the wire. */
  dropStartAndIgnore: false,
  /** The next start is refused with 404, as for a missing file — a definitive refusal. */
  rejectNextStart: false,
  print: { state: "standby", filename: "", startedAt: 0, durationS: 0 },
  /** path (relative to the gcodes root) → { size, modified, filamentType } */
  files: new Map(),
  log: []
};

function record(kind, detail = {}) {
  sim.log.push({ at: new Date().toISOString(), kind, ...detail });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Advances a running print by wall-clock time; a print past its duration is complete. */
function tickPrint() {
  const p = sim.print;
  if (p.state !== "printing") return;
  const elapsed = (Date.now() - p.startedAt) / 1000;
  if (elapsed >= sim.printSeconds) {
    p.state = "complete";
    p.durationS = sim.printSeconds;
    record("print_complete", { filename: p.filename });
  }
}

function statusPayload() {
  tickPrint();
  const p = sim.print;
  const printing = p.state === "printing";
  const elapsed = printing ? (Date.now() - p.startedAt) / 1000 : p.durationS;
  const progress = printing ? Math.min(0.99, elapsed / sim.printSeconds) : p.state === "complete" ? 1 : 0;
  const axis = { position_min: 0, position_max: BUILD_MM };
  return {
    result: {
      eventtime: Date.now() / 1000,
      status: {
        print_stats: {
          state: p.state,
          filename: p.filename,
          print_duration: elapsed,
          total_duration: elapsed,
          filament_used: Math.round(progress * 1200),
          message: ""
        },
        virtual_sdcard: { progress, is_active: printing, file_position: 0 },
        display_status: { progress, message: null },
        webhooks: { state: "ready", state_message: "Printer is ready" },
        extruder: { temperature: printing ? 240 : 26, target: printing ? 240 : 0 },
        heater_bed: { temperature: printing ? 70 : 25, target: printing ? 70 : 0 },
        configfile: {
          settings: {
            printer: { kinematics: "corexy" },
            extruder: { nozzle_diameter: 0.4 },
            stepper_x: axis,
            stepper_y: axis,
            stepper_z: axis
          }
        }
      }
    }
  };
}

function filamentTypeOf(bytes) {
  const head = bytes.subarray(0, 64 * 1024).toString("utf8");
  const tail = bytes.subarray(Math.max(0, bytes.length - 64 * 1024)).toString("utf8");
  const match = /;\s*filament_type\s*=\s*([^\r\n;]+)/i.exec(head + "\n" + tail);
  return match ? match[1].trim() : "PETG";
}

/** `gcodes`, `gcodes/a/b.gcode`, `/a/b.gcode` → a path relative to the gcodes root ("" for the root). */
function relativeGcodePath(raw) {
  return decodeURIComponent(raw).replace(/^\/+/, "").replace(/^gcodes(\/|$)/, "");
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const route = `${req.method} ${url.pathname}`;

  // ── Simulation control ────────────────────────────────────────────────────
  if (url.pathname.startsWith("/__sim/")) {
    if (route === "GET /__sim/state") {
      tickPrint();
      return send(res, 200, {
        name: HOSTNAME,
        online: sim.online,
        printSeconds: sim.printSeconds,
        print: sim.print,
        files: [...sim.files.entries()].map(([path, f]) => ({ path, ...f })),
        log: sim.log
      });
    }
    if (route === "POST /__sim/set") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      for (const key of ["online", "printSeconds", "dropStartResponse", "dropStartAndIgnore", "rejectNextStart"]) {
        if (key in body) sim[key] = body[key];
      }
      record("sim_set", body);
      return send(res, 200, { ok: true });
    }
    if (route === "POST /__sim/finish") {
      if (sim.print.state === "printing") sim.print.startedAt = Date.now() - sim.printSeconds * 1000;
      tickPrint();
      return send(res, 200, { ok: true, print: sim.print });
    }
    if (route === "POST /__sim/reset") {
      sim.print = { state: "standby", filename: "", startedAt: 0, durationS: 0 };
      sim.files.clear();
      sim.log = [];
      Object.assign(sim, { online: true, dropStartResponse: false, dropStartAndIgnore: false, rejectNextStart: false });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "unknown sim route" });
  }

  // An unplugged printer: the connection is refused mid-handshake.
  if (!sim.online) {
    req.socket.destroy();
    return;
  }

  // ── Moonraker ─────────────────────────────────────────────────────────────
  if (route === "GET /printer/objects/query") return send(res, 200, statusPayload());
  if (route === "GET /printer/info") {
    return send(res, 200, { result: { state: "ready", hostname: HOSTNAME, software_version: "v0.12.0-sim" } });
  }
  if (route === "GET /printer/objects/list") {
    return send(res, 200, {
      result: { objects: ["print_stats", "virtual_sdcard", "display_status", "webhooks", "extruder", "heater_bed", "configfile"] }
    });
  }
  if (route === "GET /server/files/directory") {
    const dir = relativeGcodePath(url.searchParams.get("path") ?? "gcodes");
    const files = [...sim.files.entries()]
      .filter(([path]) => (dir ? path.startsWith(`${dir}/`) : !path.includes("/")))
      .map(([path, f]) => ({ filename: path.split("/").pop(), size: f.size, modified: f.modified, permissions: "rw" }));
    return send(res, 200, { result: { dirs: [], files, disk_usage: { total: 8e9, used: 1e8, free: 7.9e9 } } });
  }
  if (route === "GET /server/files/metadata") {
    const name = relativeGcodePath(url.searchParams.get("filename") ?? "");
    const file = sim.files.get(name);
    if (!file) return send(res, 404, { error: { code: 404, message: `Metadata not available for <${name}>` } });
    return send(res, 200, {
      result: {
        filename: name,
        size: file.size,
        modified: file.modified,
        slicer: "OrcaSlicer",
        estimated_time: sim.printSeconds,
        filament_type: file.filamentType,
        filament_weight_total: 12.5
      }
    });
  }
  if (route === "POST /server/files/upload") {
    const body = await readBody(req);
    const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return send(res, 400, { error: { code: 400, message: "no file" } });
    const dir = typeof form.get("path") === "string" ? String(form.get("path")).replace(/^\/+|\/+$/g, "") : "";
    const path = dir ? `${dir}/${file.name}` : file.name;
    const bytes = Buffer.from(await file.arrayBuffer());
    sim.files.set(path, { size: bytes.byteLength, modified: Date.now() / 1000, filamentType: filamentTypeOf(bytes) });
    record("upload", { path, size: bytes.byteLength, print: form.get("print") });
    return send(res, 201, { result: { item: { path, root: "gcodes" }, action: "create_file" } });
  }
  if (req.method === "DELETE" && url.pathname.startsWith("/server/files/gcodes/")) {
    const path = relativeGcodePath(url.pathname.slice("/server/files/".length));
    const existed = sim.files.delete(path);
    record("delete", { path, existed });
    return existed
      ? send(res, 200, { result: { item: { path, root: "gcodes" }, action: "delete_file" } })
      : send(res, 404, { error: { code: 404, message: "File does not exist" } });
  }
  if (route === "POST /printer/print/start") {
    const filename = relativeGcodePath(url.searchParams.get("filename") ?? "");
    record("start", { filename });
    if (sim.dropStartAndIgnore) {
      sim.dropStartAndIgnore = false;
      record("start_lost", { filename, executed: false });
      req.socket.destroy();
      return;
    }
    if (sim.rejectNextStart) {
      sim.rejectNextStart = false;
      return send(res, 404, { error: { code: 404, message: `File ${filename} does not exist` } });
    }
    if (!sim.files.has(filename)) return send(res, 404, { error: { code: 404, message: `File ${filename} does not exist` } });
    tickPrint();
    if (sim.print.state === "printing" || sim.print.state === "paused") {
      return send(res, 400, { error: { code: 400, message: "Print already in progress" } });
    }
    sim.print = { state: "printing", filename, startedAt: Date.now(), durationS: 0 };
    if (sim.dropStartResponse) {
      sim.dropStartResponse = false;
      record("start_lost", { filename, executed: true });
      req.socket.destroy();
      return;
    }
    return send(res, 200, { result: "ok" });
  }
  const command = /^POST \/printer\/print\/(pause|resume|cancel)$/.exec(route)?.[1];
  if (command) {
    record(command, {});
    tickPrint();
    if (command === "pause" && sim.print.state === "printing") sim.print.state = "paused";
    if (command === "resume" && sim.print.state === "paused") sim.print.state = "printing";
    if (command === "cancel" && (sim.print.state === "printing" || sim.print.state === "paused")) {
      sim.print.state = "cancelled";
      sim.print.durationS = (Date.now() - sim.print.startedAt) / 1000;
    }
    return send(res, 200, { result: "ok" });
  }
  if (route === "POST /printer/gcode/script") return send(res, 200, { result: "ok" });
  return send(res, 404, { error: { code: 404, message: `not simulated: ${route}` } });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((error) => {
      record("sim_error", { message: String(error?.message ?? error) });
      if (!res.headersSent) send(res, 500, { error: { code: 500, message: String(error?.message ?? error) } });
    });
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`fake moonraker «${HOSTNAME}» on :${PORT}, print ${sim.printSeconds}s, bed ${BUILD_MM} mm`);
  });
