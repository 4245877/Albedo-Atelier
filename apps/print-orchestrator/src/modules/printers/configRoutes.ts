import type { FastifyInstance } from "fastify";

import { ValidationError } from "../../core/errors";
import { PRINTER_PROTOCOLS } from "../../domain/printers/config";
import { autoDiscoveredFields } from "../../infra/printers/discovery";
import type { PrinterConfigService } from "../../app/printers/printerConfigService";

/** The one capability these routes need, passed explicitly at registration. */
export interface PrinterConfigRoutesOptions {
  printerConfig: () => PrinterConfigService;
}

interface IdParams {
  id: string;
}

/**
 * The printer inventory API under `/api/printers/config` — the endpoints that
 * replaced editing `config/printers.json` and redeploying:
 *
 *   GET    /                 every configured printer (credentials masked)
 *   GET    /options          the vocabulary the add/edit form is built from
 *   GET    /:id              one printer
 *   POST   /                 add a printer
 *   PATCH  /:id              change settings and/or credentials (partial)
 *   POST   /:id/enabled      body: { enabled: boolean }
 *   POST   /:id/test         probe the real device with the current settings
 *   POST   /:id/discover     re-ask the device what hardware it is
 *   POST   /reorder          body: { ids: string[] }
 *   DELETE /:id              remove it from the farm
 *
 * **Credentials only ever travel inbound.** Every read returns a
 * `secrets: { accessCode: { set, source, envVar, resolved }, … }` summary
 * instead of the value, and a PATCH that omits a credential keeps the stored
 * one. So the edit form can be submitted whole without the browser ever having
 * received an access code, and rotating one is a PATCH carrying just that field.
 *
 * **Hardware characteristics come back resolved.** Alongside the stored columns
 * (which are what the edit form writes back), every read carries `specs`: per
 * characteristic, the value in force plus who supplied it — the device, the
 * operator, or the model catalogue. That is what lets the card fill itself in
 * from the printer while still showing the operator which fields are their own.
 *
 * All of these are state-changing except the GETs, so the shared mutation guard
 * (`http/security.ts`) already requires the API token on them.
 */
export async function registerPrinterConfigRoutes(
  app: FastifyInstance,
  opts: PrinterConfigRoutesOptions
): Promise<void> {
  const service = opts.printerConfig;

  app.get("/", async () => ({ printers: service().list() }));

  /**
   * The closed vocabularies the form needs, served by the backend so the UI can
   * never offer a protocol the drivers do not implement.
   */
  app.get("/options", async () => ({
    protocols: PRINTER_PROTOCOLS.map((id) => ({
      id,
      label: PROTOCOL_LABELS[id],
      hint: PROTOCOL_HINTS[id],
      /** Credential fields that actually matter for this protocol (UI hint only). */
      credentials: PROTOCOL_CREDENTIALS[id],
      /**
       * Characteristics this protocol can determine on its own, so the form can
       * mark a field «заполняется автоматически» — or say plainly that the
       * printer does not report it — without the browser hard-coding protocol
       * knowledge. A listed field can still resolve to unknown; what it promises
       * is that leaving it blank is reasonable.
       */
      autoFields: autoDiscoveredFields(id)
    })),
    types: [
      { id: "FDM", label: "FDM" },
      { id: "Resin", label: "Фотополимер" }
    ]
  }));

  app.get<{ Params: IdParams }>("/:id", async (request) => service().get(request.params.id));

  app.post<{ Body: unknown }>("/", async (request, reply) => {
    const printer = service().create(asInput(request.body), actorOf(request.body));
    reply.code(201);
    return { ok: true, printer };
  });

  app.patch<{ Params: IdParams; Body: unknown }>("/:id", async (request) => ({
    ok: true,
    printer: service().update(request.params.id, asInput(request.body), actorOf(request.body))
  }));

  app.post<{ Params: IdParams; Body: { enabled?: unknown; operator?: unknown } }>(
    "/:id/enabled",
    async (request) => {
      const enabled = request.body?.enabled;
      if (typeof enabled !== "boolean") {
        throw new ValidationError("Поле «enabled» обязательно и должно быть boolean", {
          field: "enabled"
        });
      }
      return {
        ok: true,
        printer: service().setEnabled(request.params.id, enabled, actorOf(request.body))
      };
    }
  );

  /**
   * Probes the device with the settings as they are stored. Deliberately a POST:
   * it drops the printer's live connection before probing, so a client
   * authenticated with superseded credentials cannot answer for the new ones.
   */
  app.post<{ Params: IdParams; Body: unknown }>("/:id/test", async (request) => ({
    ok: true,
    result: await service().testConnection(request.params.id, actorOf(request.body))
  }));

  /**
   * Re-asks the device what hardware it is, now, instead of waiting for the
   * background interval. A POST because it talks to the device and records an
   * audit event — though the conversation itself is read-only, so this is safe
   * on a printer that is mid-print.
   */
  app.post<{ Params: IdParams; Body: unknown }>("/:id/discover", async (request) => ({
    ok: true,
    printer: await service().discoverNow(request.params.id, actorOf(request.body))
  }));

  app.post<{ Body: { ids?: unknown; operator?: unknown } }>("/reorder", async (request) => {
    const ids = request.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new ValidationError("Поле «ids» должно быть массивом идентификаторов принтеров", {
        field: "ids"
      });
    }
    return { ok: true, printers: service().reorder(ids as string[], actorOf(request.body)) };
  });

  app.delete<{ Params: IdParams }>("/:id", async (request) => {
    service().remove(request.params.id);
    return { ok: true };
  });
}

const PROTOCOL_LABELS: Record<string, string> = {
  moonraker: "Moonraker (Klipper: K2, Fluidd, Mainsail)",
  bambu: "Bambu Lab (локальный MQTT, режим LAN)",
  creality: "Creality (WebSocket, Ender 3 V3 KE)"
};

const PROTOCOL_HINTS: Record<string, string> = {
  moonraker: "Адрес и порт веб-интерфейса Klipper (обычно 7125 или 4408). Управление печатью и загрузка файлов поддерживаются полностью.",
  bambu: "Нужны серийный номер и код доступа с экрана принтера: настройки → сеть → LAN. Код меняется при сбросе — обновите его здесь, без пересборки.",
  creality: "Только чтение телеметрии по WebSocket: удалённый запуск и пауза этим протоколом не поддерживаются."
};

const PROTOCOL_CREDENTIALS: Record<string, string[]> = {
  moonraker: ["apiKey"],
  bambu: ["serial", "accessCode"],
  creality: []
};

/** The body as validation input; the actor field is not a printer setting. */
function asInput(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Тело запроса должно быть объектом с настройками принтера");
  }
  const { operator: _operator, ...input } = body as Record<string, unknown>;
  return input;
}

/** Who is making the change, when the client names them; for the audit trail. */
function actorOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const operator = (body as Record<string, unknown>).operator;
  return typeof operator === "string" && operator.trim() ? operator.trim() : undefined;
}
