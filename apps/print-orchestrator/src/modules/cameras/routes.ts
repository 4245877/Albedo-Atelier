import type { FastifyInstance } from "fastify";

import { listCameraStreams } from "./service";

export async function registerCameraRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listCameraStreams());
}
