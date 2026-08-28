/**
 * How long one file's analysis may take — **as a function of its size**.
 *
 * A single flat budget cannot be right for both ends of the range this service
 * accepts. `ANALYSIS_TIMEOUT_MS` was 30 s for every file, from a 40 KB test cube
 * to the 200 MB the upload limit allows, so a large *healthy* G-code came back
 * `analysis: failed` — and, because the slice output gate reads that same
 * analysis, its own slice then went `blocked` for a reason that said nothing
 * about the file. The file was fine; the clock was wrong.
 *
 * Raising the flat number would have been the wrong fix twice over: it does not
 * scale (there is always a bigger file), and it slows down the failure of a file
 * that really is pathological. So the budget is *earned per megabyte*, from a
 * floor that keeps small-file failures fast:
 *
 *     budget = max(base, base + sizeMb × MS_PER_MB), capped at MAX
 *
 * `MS_PER_MB` is set from measurement with a wide margin. On this farm's own
 * hardware the G-code analyzer — the slowest of them, because it simulates the
 * coordinate model — runs at ~110 ms/MB, so 600 ms/MB leaves roughly 5× headroom
 * for slower hardware, a busy host, and the heavier 3MF path. It is a safety
 * net, not a target: a file that needs anywhere near its budget is a file worth
 * looking at.
 */

const MB = 1024 * 1024;

/** Milliseconds granted per megabyte of input, on top of the base budget. */
export const ANALYSIS_MS_PER_MB = 600;

/**
 * Ceiling, whatever the size. Ten minutes is far beyond any healthy file at the
 * 200 MB upload limit (~2 min of budget) and bounds what one pathological input
 * can hold a worker slot for.
 */
export const ANALYSIS_MAX_TIMEOUT_MS = 10 * 60_000;

/**
 * The wall-clock budget for analysing `sizeBytes`, given the configured base.
 *
 * Total, and never below `baseMs`: an unknown or nonsensical size (0, negative,
 * NaN — an artifact row whose length was never recorded) yields exactly the base
 * budget rather than an unbounded one. Fail-closed in the direction that matters:
 * not knowing how big a file is never buys it more time.
 */
export function analysisBudgetMs(sizeBytes: number | null | undefined, baseMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 30_000;
  const size = typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
  const budget = base + (size / MB) * ANALYSIS_MS_PER_MB;
  return Math.min(Math.round(budget), Math.max(base, ANALYSIS_MAX_TIMEOUT_MS));
}

/**
 * An analysis that ran out of its budget — **distinct** from an analysis that
 * found something wrong with the file.
 *
 * The two used to arrive at the operator as the same sentence, and they call for
 * opposite responses: a timeout says "this file is bigger or slower than the
 * budget allowed, retry or raise the budget", while a blocker says "this file
 * must not be printed". Collapsing them is how a healthy 50 MB print looked like
 * a rejected one.
 */
export class AnalysisTimeoutError extends Error {
  readonly code = "ANALYSIS_TIMEOUT";

  constructor(
    readonly budgetMs: number,
    readonly sizeBytes: number
  ) {
    const mb = sizeBytes > 0 ? `${(sizeBytes / MB).toFixed(1)} МБ` : "неизвестного размера";
    super(
      `Анализ файла ${mb} не уложился в отведённые ${Math.round(budgetMs / 1000)} с — ` +
        "файл не отклонён, но и не проверен: повторите анализ или увеличьте ANALYSIS_TIMEOUT_MS"
    );
    this.name = "AnalysisTimeoutError";
  }
}
