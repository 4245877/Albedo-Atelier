import path from "node:path";
import { Worker } from "node:worker_threads";

import type { AnalyzerInput, AnalyzerLimits, AnalyzerResult } from "./index";

/** Reply shape the {@link analyzeWorker} posts back. */
interface WorkerReply {
  ok: boolean;
  result?: AnalyzerResult;
  error?: string;
}

export interface WorkerHostOptions {
  /** Override the worker script (tests point this at a controllable hang worker). */
  workerPath?: string;
  /** Override the worker's node args (tests pass the tsx loader for a .ts worker). */
  execArgv?: string[];
}

/**
 * Resolves the worker script + node args for the current runtime. Under tsx
 * (`__filename` ends in `.ts`) it loads the `.ts` worker with the tsx loader;
 * from the compiled build it loads the sibling `.js` with plain node. The module
 * is CommonJS, so `__dirname`/`__filename` (not `import.meta`) are used.
 */
function defaultWorker(): { workerPath: string; execArgv: string[] } {
  const isTs = __filename.endsWith(".ts");
  return {
    workerPath: path.join(__dirname, isTs ? "analyzeWorker.ts" : "analyzeWorker.js"),
    execArgv: isTs ? ["--import", "tsx"] : []
  };
}

/**
 * Builds an analyzer that runs {@link analyzeFile} in a dedicated worker thread
 * with a hard wall-clock budget. On timeout the worker is TERMINATED — killing
 * even a synchronous XML/3MF parse — so the deadline is real, the analysis slot
 * is genuinely freed, and no background parse lingers after the promise settles.
 * One worker per call, so a `concurrency` of N means at most N live workers.
 */
export function analyzeInWorker(
  timeoutMs: number,
  options: WorkerHostOptions = {}
): (input: AnalyzerInput, limits: AnalyzerLimits) => Promise<AnalyzerResult> {
  const base = defaultWorker();
  const workerPath = options.workerPath ?? base.workerPath;
  const execArgv = options.execArgv ?? base.execArgv;

  return (input, limits) =>
    new Promise<AnalyzerResult>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { input, limits }, execArgv });
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Terminate unconditionally — a normal reply still leaves the thread to
        // reap, and a timeout must kill an in-progress (possibly blocking) parse.
        void worker.terminate();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error("Анализ превысил лимит времени")));
      }, timeoutMs);

      worker.once("message", (reply: WorkerReply) => {
        finish(() => {
          if (reply.ok && reply.result) resolve(reply.result);
          else reject(new Error(reply.error ?? "Ошибка анализа"));
        });
      });
      worker.once("error", (err) => finish(() => reject(err)));
      worker.once("exit", (code) => {
        // Only meaningful if the worker died before replying and before the
        // timeout — otherwise `finish` has already run and this is a no-op.
        finish(() => reject(new Error(`Анализатор завершился с кодом ${code}`)));
      });
    });
}
