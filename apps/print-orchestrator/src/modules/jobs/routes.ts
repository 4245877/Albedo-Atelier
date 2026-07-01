import type { FastifyInstance } from "fastify";

import { listJobs } from "./service";

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listJobs());
}
