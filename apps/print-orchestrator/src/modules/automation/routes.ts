import type { FastifyInstance } from "fastify";

import type { FarmCommands } from "../../app/FarmCommands";
import type { DashboardReadModel } from "../../app/dashboardReadModel";

interface AutomationParams {
  id: string;
}

interface ToggleBody {
  on?: unknown;
}

/** The exact reads + commands the automation routes need, passed at registration. */
export interface AutomationRoutesOptions {
  reads: Pick<DashboardReadModel, "getAutomations">;
  commands: Pick<FarmCommands, "toggleAutomation">;
}

/**
 * Automation endpoints under `/api/automations`.
 *
 *   GET  /              rules + last run summary
 *   POST /:id/toggle    flip or set a rule    body: { "on"?: boolean }
 *                       (omit `on` to toggle the current value)
 */
export async function registerAutomationRoutes(
  app: FastifyInstance,
  opts: AutomationRoutesOptions
): Promise<void> {
  const { reads, commands } = opts;

  app.get("/", async () => reads.getAutomations());

  app.post<{ Params: AutomationParams; Body: ToggleBody }>("/:id/toggle", async (request) => {
    const on = typeof request.body?.on === "boolean" ? request.body.on : undefined;
    return { ok: true, automation: commands.toggleAutomation(request.params.id, on) };
  });
}
