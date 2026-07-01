import type { FastifyInstance } from "fastify";

import { ValidationError } from "../../core/errors";
import {
  cancelPrinter,
  capturePrinterSnapshot,
  getPrinter,
  listActivePrinters,
  listPrinters,
  pausePrinter,
  resumePrinter,
  setPrinterLight
} from "./service";

interface PrinterParams {
  id: string;
}

interface LightBody {
  on?: unknown;
}

/**
 * Printer endpoints under `/api/printers`.
 *
 * Reads:
 *   GET  /                list printers
 *   GET  /active          printers currently printing/paused
 *   GET  /:id             one printer
 *
 * Actions (mutate the store now; wired to real drivers later):
 *   POST /:id/pause
 *   POST /:id/resume
 *   POST /:id/cancel
 *   POST /:id/snapshot
 *   POST /:id/light       body: { "on": boolean }
 */
export async function registerPrinterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => listPrinters());

  // Declared before "/:id" so the literal path wins unambiguously.
  app.get("/active", async () => listActivePrinters());

  app.get<{ Params: PrinterParams }>("/:id", async (request) =>
    getPrinter(request.params.id)
  );

  app.post<{ Params: PrinterParams }>("/:id/pause", async (request) => ({
    ok: true,
    printer: pausePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/resume", async (request) => ({
    ok: true,
    printer: resumePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/cancel", async (request) => ({
    ok: true,
    printer: cancelPrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/snapshot", async (request) => ({
    ok: true,
    printer: capturePrinterSnapshot(request.params.id)
  }));

  app.post<{ Params: PrinterParams; Body: LightBody }>("/:id/light", async (request) => {
    const { on } = request.body ?? {};
    if (typeof on !== "boolean") {
      throw new ValidationError('Поле «on» обязательно и должно быть boolean');
    }
    return { ok: true, printer: setPrinterLight(request.params.id, on) };
  });
}
