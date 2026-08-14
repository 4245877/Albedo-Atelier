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
 *   GET  /launch/:taskId?printer=…   launch preview (candidates, ranking, checks)
 *
 * Actions (guarded by the shared CSRF/token middleware):
 *   POST /launch/:taskId             body: { printerId?, confirmations?[], idempotencyKey?, operator? }
 */
export function registerLaunchRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "launch">
): void {
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
      idempotencyKey?: unknown;
      operator?: unknown;
    };
  }>("/launch/:taskId", async (request) => {
    const body = request.body ?? {};

    const confirmations = body.confirmations;
    if (confirmations !== undefined && !Array.isArray(confirmations)) {
      throw new ValidationError("Поле «confirmations» должно быть массивом строк");
    }

    const outcome = await services.launch.launch(request.params.taskId, {
      ...(str(body.printerId) ? { printerId: str(body.printerId) as string } : {}),
      ...(confirmations
        ? { confirmations: confirmations.filter((c): c is string => typeof c === "string") }
        : {}),
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
