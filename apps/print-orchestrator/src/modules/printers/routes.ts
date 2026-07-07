import type { FastifyInstance } from "fastify";

import { ValidationError } from "../../core/errors";
import { farmStore as defaultFarmStore } from "../../infra/store/farmStore";

/** The farm facade the routes call; injectable so the HTTP layer is testable. */
export type PrinterRoutesStore = typeof defaultFarmStore;

export interface PrinterRoutesOptions {
  store?: PrinterRoutesStore;
}

interface PrinterParams {
  id: string;
}

interface SnapshotParams {
  id: string;
  snapshotId: string;
}

interface LightBody {
  on?: unknown;
}

interface CameraQuery {
  /** `1`/`true` → ensure the chamber light is on before capturing (night snapshots). */
  ensureLight?: string;
}

/**
 * Printer endpoints under `/api/printers`.
 *
 * Reads:
 *   GET  /                list printers
 *   GET  /active          printers currently printing/paused
 *   GET  /:id             one printer
 *   GET  /:id/camera.jpg            live camera frame (real snapshot from the device)
 *   GET  /:id/camera.mp4            backend-proxied live stream for non-WebRTC cameras
 *   GET  /:id/snapshots            metadata for every saved snapshot (newest first)
 *   GET  /:id/snapshots/latest     metadata for the most recent saved snapshot
 *   GET  /:id/snapshots/:snapshotId  the saved JPEG/PNG image
 *
 * WebRTC cameras (Creality K2) are exposed in the printer view as `cameraSrc`
 * and streamed by the dashboard through `/go2rtc/`, not through this MP4 route.
 *
 * Actions (dispatched to real printer drivers):
 *   POST /:id/pause
 *   POST /:id/resume
 *   POST /:id/cancel
 *   POST /:id/snapshot    captures + durably saves a still frame
 *   POST /:id/light       body: { "on": boolean }
 */
export async function registerPrinterRoutes(
  app: FastifyInstance,
  opts: PrinterRoutesOptions = {}
): Promise<void> {
  const farmStore = opts.store ?? defaultFarmStore;

  app.get("/", async () => farmStore.listPrinters());

  // Declared before "/:id" so the literal path wins unambiguously.
  app.get("/active", async () => farmStore.listActivePrinters());

  app.get<{ Params: PrinterParams }>("/:id", async (request) =>
    farmStore.getPrinter(request.params.id)
  );

  app.get<{ Params: PrinterParams; Querystring: CameraQuery }>(
    "/:id/camera.jpg",
    async (request, reply) => {
      const ensureLight =
        request.query.ensureLight === "1" || request.query.ensureLight === "true";
      const frame = await farmStore.getCameraFrame(request.params.id, { ensureLight });
      reply
        .header("Cache-Control", "no-store")
        .type(frame.mime)
        .send(frame.data);
    }
  );

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

  // Saved-snapshot metadata. Declared before the parametric image route so the
  // literal "latest" path wins unambiguously.
  app.get<{ Params: PrinterParams }>("/:id/snapshots", async (request) =>
    farmStore.listSnapshots(request.params.id)
  );

  app.get<{ Params: PrinterParams }>("/:id/snapshots/latest", async (request) =>
    farmStore.latestSnapshot(request.params.id)
  );

  app.get<{ Params: SnapshotParams }>("/:id/snapshots/:snapshotId", async (request, reply) => {
    const { meta, data } = await farmStore.readSnapshot(
      request.params.id,
      request.params.snapshotId
    );
    // Saved snapshots are immutable, so they can be cached hard by id.
    reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .type(meta.mime)
      .send(data);
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

  app.post<{ Params: PrinterParams }>("/:id/snapshot", async (request) => {
    const { printer, snapshot } = await farmStore.snapshotPrinter(request.params.id);
    return { ok: true, printer, snapshot };
  });

  app.post<{ Params: PrinterParams; Body: LightBody }>("/:id/light", async (request) => {
    const { on } = request.body ?? {};
    if (typeof on !== "boolean") {
      throw new ValidationError('Поле «on» обязательно и должно быть boolean');
    }
    return { ok: true, printer: await farmStore.setLight(request.params.id, on) };
  });
}
