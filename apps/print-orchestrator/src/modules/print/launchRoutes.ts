import type { FastifyInstance } from "fastify";

import type { PrintServices } from "../../bootstrap/createRuntime";
import { ValidationError } from "../../core/errors";

/**
 * The launch surface under `/api/print/launch` — the endpoints the "Запустить
 * печать" button actually talks to.
 *
 * Exactly two, and the split is the point:
 *
 *   - `GET  /launch/:taskId` answers "what would happen?" and is **pure**. The
 *     UI polls it to render the card, the printer list and the confirmation
 *     checkboxes; it uploads nothing and starts nothing, so opening the page can
 *     never have a physical effect.
 *   - `POST /launch/:taskId` does the whole job in one call. The browser does not
 *     sequence assignment → upload → bed → dispatch; it sends one intent plus the
 *     operator's confirmations, and the server owns the order.
 *
 * Reads:
 *   GET  /launch                     launch readiness for every open queue row
 *   GET  /launch?task=…              launch readiness for one task, in or out of the queue
 *   GET  /launch/:taskId?printer=…   launch preview (candidates, ranking, checks)
 *
 * Actions (guarded by the shared CSRF/token middleware):
 *   POST /launch/:taskId             body: { printerId?, confirmations?[], override?, idempotencyKey?, operator? }
 */
export function registerLaunchRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "launch">
): void {
  // Per-row readiness for the whole open queue, from the SAME preflight the
  // launch runs. It exists so a queue row can say «Можно запустить на A1» or
  // «Стол занят» instead of restating that the task is QUEUED — a fact about two
  // columns that was being rendered as «готово к запуску».
  app.get<{ Querystring: { limit?: string; task?: string } }>("/launch", async (request) => {
    // `?task=` answers for exactly one job — the task panel's question. Without
    // it that panel fetched the whole page and filtered client-side, which cost
    // one full farm evaluation per row and returned nothing at all for a task
    // outside the page (or one that had already left the queue).
    const taskId = request.query.task?.trim();
    if (taskId) return { ok: true, rows: [services.launch.readinessForTaskId(taskId)] };

    const limit = Number.parseInt(request.query.limit ?? "", 10);
    return {
      ok: true,
      rows: services.launch.queueReadiness(Number.isFinite(limit) ? limit : undefined)
    };
  });

  app.get<{ Params: { taskId: string }; Querystring: { printer?: string } }>(
    "/launch/:taskId",
    async (request) => ({
      ok: true,
      preview: services.launch.preview(request.params.taskId, request.query.printer)
    })
  );

  app.post<{
    Params: { taskId: string };
    Body: {
      printerId?: unknown;
      confirmations?: unknown;
      override?: { codes?: unknown; reason?: unknown };
      idempotencyKey?: unknown;
      operator?: unknown;
    };
  }>("/launch/:taskId", async (request) => {
    const body = request.body ?? {};

    const confirmations = body.confirmations;
    if (confirmations !== undefined && !Array.isArray(confirmations)) {
      throw new ValidationError("Поле «confirmations» должно быть массивом строк");
    }

    // An explicit, audited acceptance of overridable warnings — the `review`
    // verdict's way out. Shape is validated here; WHICH codes may be waived is
    // the dispatch gate's decision, and a hard blocker is refused there whatever
    // this asks for.
    const override = readOverride(body.override);

    const outcome = await services.launch.launch(request.params.taskId, {
      ...(str(body.printerId) ? { printerId: str(body.printerId) as string } : {}),
      ...(confirmations
        ? { confirmations: confirmations.filter((c): c is string => typeof c === "string") }
        : {}),
      ...(override ? { override } : {}),
      // The client supplies the idempotency key, which is what makes a double
      // click or a refresh-and-retry return the first run instead of starting a
      // second print. Absent, the dispatch still guards physically (one active
      // run per printer), but the caller loses the safe-retry answer.
      ...(str(body.idempotencyKey) ? { idempotencyKey: str(body.idempotencyKey) as string } : {}),
      ...(str(body.operator) ? { actor: str(body.operator) as string } : {})
    });

    return { ok: true, ...outcome };
  });
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Validates an override's *shape*. Both fields are mandatory: an override with
 * no codes accepts nothing, and one with no reason is not a decision anybody can
 * be held to later.
 */
function readOverride(raw: unknown): { codes: string[]; reason: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("Поле «override» должно быть объектом { codes, reason }");
  }
  const record = raw as { codes?: unknown; reason?: unknown };
  const codes = Array.isArray(record.codes)
    ? record.codes.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (codes.length === 0) {
    throw new ValidationError("«override.codes» должен перечислять принимаемые предупреждения");
  }
  if (!reason) {
    throw new ValidationError("«override.reason» обязателен — подтверждение без причины не подтверждение");
  }
  return { codes, reason };
}
