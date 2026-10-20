/** Run tests with an empty inventory and disposable state, including on the farm host. */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const mode = ["all", "unit", "integration"].includes(args[0]) ? args.shift() : "all";
const files = mode === "all"
  ? ["src/**/*.test.ts"]
  : execFileSync(process.execPath, ["scripts/select-tests.mjs", mode], { cwd: root, encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
if (!files.length) throw new Error(`No tests selected for ${mode}`);

const work = mkdtempSync(path.join(os.tmpdir(), "atelier-tests-"));
// Do not inherit application settings, device credentials, NODE_OPTIONS or a
// production DB/artifact path. Tests set their own mocks and per-file fixtures.
const env = {
  PATH: process.env.PATH,
  TZ: "UTC",
  PRINTERS_CONFIG_PATH: path.join(work, "no-printers.json"),
  PRINTERS_CONFIG_JSON: "[]",
  STATE_FILE_PATH: path.join(work, "state.json"),
  ORCA_SLICER_CMD: ""
};
for (const key of ["SystemRoot", "WINDIR", "NO_COLOR", "FORCE_COLOR", "UPDATE_CONTRACT", "NODE_V8_COVERAGE"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

let child;
const forward = (signal) => child?.kill(signal);
const interrupt = () => forward("SIGINT");
const terminate = () => forward("SIGTERM");
try {
  child = spawn(process.execPath, [
    "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "--import", "tsx",
    "--test", ...args, ...files
  ], { cwd: root, env, stdio: "inherit" });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (128 + (os.constants.signals[signal] ?? 1))));
  });
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  rmSync(work, { recursive: true, force: true });
}
