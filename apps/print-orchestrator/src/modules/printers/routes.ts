import type { FastifyInstance } from "fastify";

import { ValidationError } from "../../core/errors";
import { farmStore } from "../../infra/store/farmStore";

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
 *   GET  /:id/camera.mp4  live camera stream (fMP4/MJPEG, depending on source)
 *
 * Actions (dispatched to real printer drivers):
 *   POST /:id/pause
 *   POST /:id/resume
 *   POST /:id/cancel
 *   POST /:id/snapshot
 *   POST /:id/light       body: { "on": boolean }
 */
export async function registerPrinterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => farmStore.listPrinters());

  // Declared before "/:id" so the literal path wins unambiguously.
  app.get("/active", async () => farmStore.listActivePrinters());

  app.get<{ Params: PrinterParams }>("/:id", async (request) =>
    farmStore.getPrinter(request.params.id)
  );

  app.get<{ Params: PrinterParams }>("/:id/camera.jpg", async (request, reply) => {
    const frame = await farmStore.getCameraFrame(request.params.id);
    reply
      .header("Cache-Control", "no-store")
      .type(frame.mime)
      .send(frame.data);
  });

  app.get<{ Params: PrinterParams }>("/:id/camera.mp4", async (request, reply) => {
    const stream = await farmStore.getCameraStream(request.params.id);

    // Tear the upstream fetch down as soon as the client goes away (tab closed,
    // player reconnect) so we do not leak sockets to go2rtc. `close` is
    // idempotent, so wiring it to both the response and request is safe.
    reply.raw.on("close", stream.close);
    request.raw.on("close", stream.close);

    // Live video should reach the browser frame-by-frame: disable Nagle so small
    // fMP4/MJPEG chunks are flushed immediately instead of being coalesced into
    // fewer, larger, laggier packets.
    reply.raw.socket?.setNoDelay(true);

    return reply
      .header("Cache-Control", "no-store")
      .header("X-Accel-Buffering", "no")
      .type(stream.mime)
      .send(stream.body);
  });

  app.post<{ Params: PrinterParams }>("/:id/pause", async (request) => ({
    ok: true,
    printer: await farmStore.pausePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/resume", async (request) => ({
    ok: true,
    printer: await farmStore.resumePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/cancel", async (request) => ({
    ok: true,
    printer: await farmStore.cancelPrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/snapshot", async (request) => ({
    ok: true,
    printer: await farmStore.snapshotPrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams; Body: LightBody }>("/:id/light", async (request) => {
    const { on } = request.body ?? {};
    if (typeof on !== "boolean") {
      throw new ValidationError('Поле «on» обязательно и должно быть boolean');
    }
    return { ok: true, printer: await farmStore.setLight(request.params.id, on) };
  });
}
