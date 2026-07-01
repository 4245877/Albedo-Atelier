import type { FastifyInstance } from "fastify";

import { listAutomationRules } from "./service";

export async function registerAutomationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listAutomationRules());
}
