import type { FastifyInstance } from "fastify";

import { UnauthorizedError, ValidationError } from "../../core/errors";
import { isRequestAuthorized } from "../../http/security";
import type { FarmCommands } from "../../app/FarmCommands";
import type { DashboardReadModel } from "../../app/dashboardReadModel";

/** The printer reads the routes serve. */
export type PrinterQueries = Pick<
  DashboardReadModel,
  "listPrinters" | "listActivePrinters" | "getPrinter"
>;

/** The printer commands the routes dispatch (cameras, snapshots, files, device control). */
export type PrinterCommands = Pick<
  FarmCommands,
  | "getCameraFrame"
  | "getCameraStream"
  | "listSnapshots"
  | "latestSnapshot"
  | "readSnapshot"
  | "listPrinterFiles"
  | "startPrinterFile"
  | "pausePrinter"
  | "resumePrinter"
  | "cancelPrinter"
  | "clearStartGuard"
  | "clearBed"
  | "snapshotPrinter"
  | "setLight"
>;

const BED_CLEARANCE_CONFIRMATIONS = ["part_removed", "plate_swapped", "auto_cleared"] as const;

/** Reads + commands passed to the printer routes explicitly at registration. */
export interface PrinterRoutesOptions {
  reads: PrinterQueries;
  commands: PrinterCommands;
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

interface PrintBody {
  file?: unknown;
  /** Who is adopting this on-device file; recorded on the device-file record. */
  operator?: unknown;
}

interface FilesQuery {
  /** Directory to list, relative to the printer's G-code root; empty = root. */
  path?: string;
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
 *   GET  /:id/files?path=…  on-device files/directories (Moonraker only)
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
 *   POST /:id/print       body: { "file": "folder/model.gcode" } — start an on-device file
 */
export async function registerPrinterRoutes(
  app: FastifyInstance,
  opts: PrinterRoutesOptions
): Promise<void> {
  const { reads, commands } = opts;

  app.get("/", async () => reads.listPrinters());

  // Declared before "/:id" so the literal path wins unambiguously.
  app.get("/active", async () => reads.listActivePrinters());

  app.get<{ Params: PrinterParams }>("/:id", async (request) =>
    reads.getPrinter(request.params.id)
  );

  app.get<{ Params: PrinterParams; Querystring: CameraQuery }>(
    "/:id/camera.jpg",
    async (request, reply) => {
      const ensureLight =
        request.query.ensureLight === "1" || request.query.ensureLight === "true";
      // ensureLight switches the chamber light on — a side effect, so this GET
      // is the one read that requires the API token (when one is configured).
      // Plain frame reads stay open, like every other read.
      if (ensureLight && !isRequestAuthorized(request)) {
        throw new UnauthorizedError("Параметр ensureLight требует API-токен (Authorization: Bearer)");
      }
      const frame = await commands.getCameraFrame(request.params.id, { ensureLight });
      reply
        .header("Cache-Control", "no-store")
        .type(frame.mime)
        .send(frame.data);
    }
  );

  app.get<{ Params: PrinterParams }>("/:id/camera.mp4", async (request, reply) => {
    const stream = await commands.getCameraStream(request.params.id);

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
    commands.listSnapshots(request.params.id)
  );

  app.get<{ Params: PrinterParams }>("/:id/snapshots/latest", async (request) =>
    commands.latestSnapshot(request.params.id)
  );

  app.get<{ Params: SnapshotParams }>("/:id/snapshots/:snapshotId", async (request, reply) => {
    const { meta, data } = await commands.readSnapshot(
      request.params.id,
      request.params.snapshotId
    );
    // Saved snapshots are immutable, so they can be cached hard by id.
    reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .type(meta.mime)
      .send(data);
  });

  app.get<{ Params: PrinterParams; Querystring: FilesQuery }>("/:id/files", async (request) => {
    const listing = await commands.listPrinterFiles(request.params.id, request.query.path ?? "");
    return { ok: true, ...listing };
  });

  app.post<{ Params: PrinterParams; Body: PrintBody }>("/:id/print", async (request) => {
    const { file, operator } = request.body ?? {};
    if (typeof file !== "string" || !file.trim()) {
      throw new ValidationError('Поле «file» обязательно и должно быть непустой строкой');
    }
    // The adoption of an on-device file is attributed to whoever pressed the
    // button when the client names them; the audit trail keeps it either way.
    const actor = typeof operator === "string" && operator.trim() ? operator.trim() : "operator";
    return {
      ok: true,
      printer: await commands.startPrinterFile(request.params.id, file, actor)
    };
  });

  /**
   * Operator confirmation that the bed is physically free — the only transition
   * out of `AWAITING_CLEARANCE`, and therefore the gate the next print waits on.
   * `confirmation` is mandatory and explicit: the server never infers a clearance
   * from idle telemetry, a successful previous print or an unattended permission.
   */
  app.post<{ Params: PrinterParams; Body: { confirmation?: unknown; note?: unknown } }>(
    "/:id/bed/clear",
    async (request) => {
      const confirmation = request.body?.confirmation;
      if (
        typeof confirmation !== "string" ||
        !BED_CLEARANCE_CONFIRMATIONS.includes(confirmation as (typeof BED_CLEARANCE_CONFIRMATIONS)[number])
      ) {
        throw new ValidationError(
          `Поле «confirmation» обязательно и должно быть одним из: ${BED_CLEARANCE_CONFIRMATIONS.join(", ")}`
        );
      }
      const note = typeof request.body?.note === "string" ? request.body.note : undefined;
      return {
        ok: true,
        bed: commands.clearBed(
          request.params.id,
          confirmation as (typeof BED_CLEARANCE_CONFIRMATIONS)[number],
          { note }
        )
      };
    }
  );

  app.post<{ Params: PrinterParams }>("/:id/pause", async (request) => ({
    ok: true,
    printer: await commands.pausePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/resume", async (request) => ({
    ok: true,
    printer: await commands.resumePrinter(request.params.id)
  }));

  app.post<{ Params: PrinterParams; Body: { job?: unknown; runId?: unknown } }>(
    "/:id/cancel",
    async (request) => {
      // Optional expected identity: the canonical runId (strong — survives a
      // re-print of the same file name) and/or the on-device job name. Either
      // mismatch refuses with 409; a bodyless cancel (server-to-server) keeps
      // working unchanged.
      const rawJob = request.body?.job;
      const rawRun = request.body?.runId;
      const expect: { job?: string | null; runId?: string | null } = {};
      if (typeof rawJob === "string") expect.job = rawJob;
      else if (rawJob === null) expect.job = null;
      if (typeof rawRun === "string") expect.runId = rawRun;
      else if (rawRun === null) expect.runId = null;
      return {
        ok: true,
        printer: await commands.cancelPrinter(
          request.params.id,
          expect.job !== undefined || expect.runId !== undefined ? expect : undefined
        )
      };
    }
  );

  // Operator override: lift a held start guard (an unconfirmed remote start whose
  // response was lost) after physically checking the printer. Refused while the
  // device is actually printing, so it can never mask a running job.
  app.post<{ Params: PrinterParams }>("/:id/clear-start-guard", async (request) => ({
    ok: true,
    printer: await commands.clearStartGuard(request.params.id)
  }));

  app.post<{ Params: PrinterParams }>("/:id/snapshot", async (request) => {
    const { printer, snapshot } = await commands.snapshotPrinter(request.params.id);
    return { ok: true, printer, snapshot };
  });

  app.post<{ Params: PrinterParams; Body: LightBody }>("/:id/light", async (request) => {
    const { on } = request.body ?? {};
    if (typeof on !== "boolean") {
      throw new ValidationError('Поле «on» обязательно и должно быть boolean');
    }
    return { ok: true, printer: await commands.setLight(request.params.id, on) };
  });
}
