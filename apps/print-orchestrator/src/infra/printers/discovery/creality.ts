import WebSocket from "ws";

import type { DiscoveredFacts } from "../../../domain/printers/discovery";
import type { PrinterConfig } from "../config";
import { firstFiniteNumber, firstText } from "../status/mapper";
import {
  failedDiscovery,
  fromPrinter,
  succeededDiscovery,
  type DiscoveryResult
} from "./types";

/**
 * Hardware discovery for the Creality WebSocket protocol (the Ender 3 V3 KE).
 *
 * This protocol is the thinnest of the three: it is a status heartbeat, not a
 * device-description API. There is no version endpoint, no config dump, no
 * capability list — so this adapter reads the few identity fields that some
 * firmwares happen to include in the heartbeat frame and reports **nothing
 * else**, leaving every other characteristic to manual entry.
 *
 * That is deliberately not padded out. The temptation is to infer a model from a
 * bed temperature range or a build volume from a firmware string; either would
 * put a fabricated number in a field the operator would then trust for
 * scheduling. An empty result here is the correct answer, and the card says
 * «принтер эту характеристику не передаёт».
 *
 * Note that the farm's K2 does *not* use this adapter — it is driven over
 * Moonraker (port 4408), which reports far more.
 */

const CREALITY_TIMEOUT_MS = 2500;

/** Identity fields out of a heartbeat frame; empty when the firmware sends none. */
export function parseCrealityIdentity(frame: Record<string, unknown>): DiscoveredFacts {
  const facts: DiscoveredFacts = {};

  const model = firstText(frame.model, frame.modelVersion, frame.machine_type);
  if (model) facts.model = fromPrinter(model, "WebSocket heart_beat → model");

  const deviceName = firstText(frame.DeviceName, frame.hostname, frame.deviceName);
  if (deviceName) facts.deviceName = fromPrinter(deviceName, "WebSocket heart_beat → DeviceName");

  const firmware = firstText(frame.softVersion, frame.firmwareVersion, frame.version);
  if (firmware) facts.firmware = fromPrinter(firmware, "WebSocket heart_beat → softVersion");

  const nozzleDiameter = firstFiniteNumber(frame.nozzleDiameter);
  if (nozzleDiameter !== null && nozzleDiameter > 0) {
    facts.nozzleDiameterMm = fromPrinter(nozzleDiameter, "WebSocket heart_beat → nozzleDiameter");
  }

  return facts;
}

export function discoverCrealityFacts(printer: PrinterConfig): Promise<DiscoveryResult> {
  const url = `ws://${printer.host}:${printer.port ?? 9999}`;

  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let settled = false;

    const finish = (result: DiscoveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws?.close();
      } catch {
        // ignore — the socket is being discarded either way
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(failedDiscovery("Creality WebSocket: таймаут"));
    }, CREALITY_TIMEOUT_MS);

    try {
      ws = new WebSocket(url);
    } catch (error) {
      finish(failedDiscovery(error instanceof Error ? error.message : String(error)));
      return;
    }

    ws.on("open", () => {
      try {
        ws?.send(JSON.stringify({ ModeCode: "heart_beat", msg: new Date().toISOString() }));
      } catch {
        // ignore — the timeout below is the backstop
      }
    });

    ws.on("message", (data) => {
      try {
        const raw = data.toString();
        if (!raw || raw === "ok") return;
        // Reaching a frame at all is a successful probe; an empty fact set then
        // means "this firmware states nothing about itself", not "unreachable".
        finish(succeededDiscovery(parseCrealityIdentity(JSON.parse(raw) as Record<string, unknown>)));
      } catch (error) {
        finish(failedDiscovery(error instanceof Error ? error.message : String(error)));
      }
    });

    ws.on("error", () => {
      finish(failedDiscovery("Creality WebSocket: ошибка соединения"));
    });

    ws.on("close", () => {
      finish(failedDiscovery("Creality WebSocket: соединение закрыто"));
    });
  });
}
