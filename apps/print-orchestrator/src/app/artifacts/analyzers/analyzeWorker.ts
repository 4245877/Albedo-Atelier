import { parentPort, workerData } from "node:worker_threads";

import { analyzeFile, type AnalyzerInput, type AnalyzerLimits } from "./index";

/**
 * Worker-thread entry for artifact analysis. It runs the full {@link analyzeFile}
 * pipeline (format detection + STL/3MF/G-code parsing) OFF the main event loop,
 * so a heavy or hostile file cannot block the server — and so a wall-clock
 * timeout can genuinely {@link Worker.terminate} it (killing even a synchronous
 * XML/3MF parse), which a `Promise.race` on the main thread never could.
 *
 * The result is a plain, structured-clone-able object; any failure is reported
 * as a message (not a thrown error) so the host always gets one reply.
 */
async function run(): Promise<void> {
  const { input, limits } = workerData as { input: AnalyzerInput; limits: AnalyzerLimits };
  try {
    const result = await analyzeFile(input, limits);
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error && error.message ? error.message : "Ошибка анализа"
    });
  }
}

void run();
