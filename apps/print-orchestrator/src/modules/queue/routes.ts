import type { FastifyInstance } from "fastify";

import { listQueue } from "./service";

export async function registerQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listQueue());
}
