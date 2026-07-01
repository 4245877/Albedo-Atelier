import type { FastifyInstance } from "fastify";

import { listEvents } from "./service";

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listEvents());
}
