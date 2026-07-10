import type { FastifyInstance } from "fastify";

import { farmStore } from "../../app/farmStore";

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
  app.get("/", async () => farmStore.reads.getAutomations());

  app.post<{ Params: AutomationParams; Body: ToggleBody }>("/:id/toggle", async (request) => {
    const on = typeof request.body?.on === "boolean" ? request.body.on : undefined;
    return { ok: true, automation: farmStore.toggleAutomation(request.params.id, on) };
  });
}
