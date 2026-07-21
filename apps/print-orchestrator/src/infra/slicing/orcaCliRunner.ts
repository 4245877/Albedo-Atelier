import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { StoreLogger } from "../../shared/logger";
import {
  SliceProcessError,
  SliceRuntimeUnavailableError,
  SliceTimeoutError,
  type OrcaRuntimeStatus,
  type SliceRequest,
  type SliceRunner,
  type SliceRunOptions,
  type SliceRunOutput
} from "./sliceRunner";

/**
 * The real OrcaSlicer runner: it drives the pinned OrcaSlicer CLI as a child
 * process. Every safety property the brief asks for is enforced here:
 *
 *   - **pinned version** — {@link OrcaCliRunner.probe} runs `--version` and refuses
 *     (reports `available:false`) when the binary is missing or not the pinned one;
 *   - **no shell** — `spawn(bin, args, { shell: false })`, so a profile/model path
 *     can never be interpreted by a shell; arguments are passed as an array;
 *   - **timeout** — a wall-clock budget kills the process group (SIGKILL) if exceeded;
 *   - **isolated temp dir** — the slice runs in a caller-provided `workDir` (`cwd`),
 *     with a minimal environment (no inherited secrets);
 *   - **network isolation** — when configured for container mode (`command` = the
 *     container runtime, `baseArgs` carrying `--network none`), the slicer has no
 *     network; `networkIsolated` reflects that;
 *   - **honest diagnostics** — a missing runtime yields a clear message, never a
 *     fabricated slice.
 *
 * Concurrency, cleanup and caching are the {@link SliceService}'s job — this class
 * runs exactly one process per call and owns none of that state.
 */

export interface OrcaCliConfig {
  /**
   * The executable to spawn. Usually the OrcaSlicer binary; in container mode this
   * is the container runtime (e.g. `docker`/`podman`) and {@link OrcaCliConfig.baseArgs}
   * carries `run --rm --network none -v … <image> orca-slicer`.
   */
  command: string | null;
  /** Arguments prepended before the slice arguments (container run/flags). Default []. */
  baseArgs?: string[];
  /** Extra arguments appended before the model path (advanced tuning). Default []. */
  extraArgs?: string[];
  /** The OrcaSlicer version this deployment pins to; null = unpinned (any version). */
  pinnedVersion: string | null;
  /** The slicing worker's own version (part of the cache key). */
  workerVersion: string;
  /** True when the configuration disables the slicer's network (container mode). */
  networkIsolated?: boolean;
  logger?: StoreLogger;
}

const VERSION_RE = /(\d+\.\d+\.\d+(?:\.\d+)?)/;

export class OrcaCliRunner implements SliceRunner {
  readonly workerVersion: string;
  readonly pinnedVersion: string | null;
  private readonly logger: StoreLogger;

  constructor(private readonly config: OrcaCliConfig) {
    this.workerVersion = config.workerVersion;
    this.pinnedVersion = config.pinnedVersion;
    this.logger = config.logger ?? {};
  }

  async probe(): Promise<OrcaRuntimeStatus> {
    const base: OrcaRuntimeStatus = {
      available: false,
      binaryPath: this.config.command,
      detectedVersion: null,
      pinnedVersion: this.pinnedVersion,
      versionMatches: null,
      networkIsolated: this.config.networkIsolated ?? false,
      error: null,
      workerVersion: this.workerVersion
    };

    if (!this.config.command) {
      return { ...base, error: "OrcaSlicer не настроен (ORCA_SLICER_CMD не задан)" };
    }

    let out: { stdout: string; stderr: string; exitCode: number | null };
    try {
      out = await this.run([...(this.config.baseArgs ?? []), "--version"], {
        timeoutMs: 15000,
        cwd: process.cwd()
      });
    } catch (error) {
      return {
        ...base,
        error: `OrcaSlicer недоступен: ${(error as Error).message}`
      };
    }

    const detected = (out.stdout + out.stderr).match(VERSION_RE)?.[1] ?? null;
    if (!detected) {
      return { ...base, error: "Не удалось определить версию OrcaSlicer" };
    }

    const versionMatches = this.pinnedVersion ? matchesPinned(detected, this.pinnedVersion) : true;
    return {
      ...base,
      detectedVersion: detected,
      versionMatches,
      available: versionMatches,
      error: versionMatches
        ? null
        : `Версия OrcaSlicer ${detected} не совпадает с закреплённой ${this.pinnedVersion}`
    };
  }

  async slice(req: SliceRequest, options: SliceRunOptions = {}): Promise<SliceRunOutput> {
    // The availability + version-pin gate runs ONCE per slice operation. The caller
    // (SliceService) probes before every slice and hands the result in via `probed`,
    // so we don't spawn a redundant second `--version`; a direct caller that omits it
    // still gets probed here, so the "never slice against a missing/mismatched
    // runtime" guarantee is never weakened.
    const status = options.probed ?? (await this.probe());
    if (!status.available) {
      throw new SliceRuntimeUnavailableError(status.error ?? "OrcaSlicer недоступен");
    }

    const args = [
      ...(this.config.baseArgs ?? []),
      "--load-settings",
      `${req.machineJsonPath};${req.processJsonPath}`,
      "--load-filaments",
      req.filamentJsonPath,
      "--slice",
      "0",
      "--outputdir",
      req.workDir,
      ...(this.config.extraArgs ?? []),
      req.modelPath
    ];

    const started = Date.now();
    const result = await this.run(args, {
      timeoutMs: options.timeoutMs ?? 300000,
      cwd: req.workDir,
      signal: options.signal
    });
    const durationMs = Date.now() - started;

    if (result.exitCode !== 0) {
      throw new SliceProcessError(
        `OrcaSlicer завершился с кодом ${result.exitCode}: ${tail(result.stderr || result.stdout)}`
      );
    }

    const produced = await this.locateOutput(req);
    if (!produced) {
      throw new SliceProcessError("OrcaSlicer не создал выходной файл");
    }
    if (produced !== req.outputPath) {
      await fsp.rename(produced, req.outputPath);
    }

    return {
      outputPath: req.outputPath,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs
    };
  }

  /** Finds the sliced artifact the CLI produced in the work dir (newest .gcode/.3mf). */
  private async locateOutput(req: SliceRequest): Promise<string | null> {
    if (fs.existsSync(req.outputPath)) return req.outputPath;
    let entries: string[];
    try {
      entries = await fsp.readdir(req.workDir);
    } catch {
      return null;
    }
    const inputs = new Set(
      [req.machineJsonPath, req.processJsonPath, req.filamentJsonPath, req.modelPath].map((p) =>
        path.basename(p)
      )
    );
    const candidates = entries
      .filter((name) => /\.(gcode|gcode\.3mf|3mf)$/i.test(name) && !inputs.has(name))
      .map((name) => path.join(req.workDir, name));
    if (candidates.length === 0) return null;
    // Newest by mtime — the just-written slice.
    let best: { path: string; mtime: number } | null = null;
    for (const p of candidates) {
      try {
        const stat = await fsp.stat(p);
        if (!best || stat.mtimeMs > best.mtime) best = { path: p, mtime: stat.mtimeMs };
      } catch {
        /* skip */
      }
    }
    return best?.path ?? null;
  }

  /**
   * Spawns the configured command with no shell, a minimal environment, and a hard
   * timeout that kills the child if it overruns. Rejects with {@link SliceTimeoutError}
   * on timeout/abort; resolves with captured output otherwise.
   */
  private run(
    args: string[],
    opts: { timeoutMs: number; cwd: string; signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const command = this.config.command as string;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: opts.cwd,
        shell: false, // never a shell — paths cannot be interpreted/injected
        windowsHide: true,
        env: {
          // A minimal environment: no inherited secrets, just enough to run a GUI-less CLI.
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: opts.cwd,
          TMPDIR: opts.cwd,
          ...(process.env.DISPLAY ? {} : { QT_QPA_PLATFORM: "offscreen" })
        }
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new SliceTimeoutError(`Превышен лимит времени слайсинга (${opts.timeoutMs} мс)`)));
      }, opts.timeoutMs);

      const onAbort = (): void => {
        child.kill("SIGKILL");
        finish(() => reject(new SliceTimeoutError("Слайсинг отменён")));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          child.kill("SIGKILL");
          finish(() => reject(new SliceTimeoutError("Слайсинг отменён")));
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        finish(() => reject(error));
      });
      child.on("close", (code) => {
        finish(() => resolve({ stdout, stderr, exitCode: code }));
      });
    });
  }
}

/** Detected version satisfies the pin when they are equal or the pin is a prefix. */
function matchesPinned(detected: string, pinned: string): boolean {
  const d = normalizeVersion(detected);
  const p = normalizeVersion(pinned);
  return d === p || d.startsWith(`${p}.`) || p.startsWith(`${d}.`);
}

/** Normalises OrcaSlicer's `02.03.00.62` and `2.3.0` forms to a comparable string. */
function normalizeVersion(v: string): string {
  return v
    .split(".")
    .map((part) => String(Number.parseInt(part, 10)))
    .join(".");
}

function tail(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}
