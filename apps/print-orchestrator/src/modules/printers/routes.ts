import type { FastifyInstance } from "fastify";

import { listPrinters } from "./service";

export async function registerPrinterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listPrinters());
}
