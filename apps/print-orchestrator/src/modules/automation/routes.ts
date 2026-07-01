import type { FastifyInstance } from "fastify";

import { listAutomations, toggleAutomation } from "./service";

interface AutomationParams {
  id: string;
}

interface ToggleBody {
  on?: unknown;
}

/**
 * Automation endpoints under `/api/automations`.
 *
 *   GET  /              rules + last run summary
 *   POST /:id/toggle    flip or set a rule    body: { "on"?: boolean }
 *                       (omit `on` to toggle the current value)
 */
export async function registerAutomationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listAutomations());

  app.post<{ Params: AutomationParams; Body: ToggleBody }>("/:id/toggle", async (request) => {
    const on = typeof request.body?.on === "boolean" ? request.body.on : undefined;
    return { ok: true, automation: toggleAutomation(request.params.id, on) };
  });
}
