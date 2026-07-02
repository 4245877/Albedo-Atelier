import type { FastifyInstance } from "fastify";

import { ValidationError } from "../../core/errors";
import {
  cancelPrinter,
  capturePrinterSnapshot,
  getPrinter,
  getPrinterCameraFrame,
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
 *   GET  /:id/camera.jpg  live camera frame (real snapshot from the device)
 *
 * Actions (dispatched to real printer drivers):
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

  app.get<{ Params: PrinterParams }>("/:id/camera.jpg", async (request, reply) => {
    const frame = await getPrinterCameraFrame(request.params.id);
    reply
      .header("Cache-Control", "no-store")
      .type(frame.mime)
      .send(frame.data);
  });

  app.post<{ Params: PrinterParams }>("/:id/pause", async (request) => ({
    ok: true,
    printer: await pausePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/resume", async (request) => ({
    ok: true,
    printer: await resumePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/cancel", async (request) => ({
    ok: true,
    printer: await cancelPrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/snapshot", async (request) => ({
    ok: true,
    printer: await capturePrinterSnapshot(request.params.id)
  }));

  app.post<{ Params: PrinterParams; Body: LightBody }>("/:id/light", async (request) => {
    const { on } = request.body ?? {};
    if (typeof on !== "boolean") {
      throw new ValidationError('Поле «on» обязательно и должно быть boolean');
    }
    return { ok: true, printer: await setPrinterLight(request.params.id, on) };
  });
}
