import type { BuildVolumeFacts, DiscoveredFacts } from "../../../domain/printers/discovery";
import { fetchWithTimeout } from "../../../shared/fetchWithTimeout";
import { isObject } from "../../../shared/isObject";
import type { PrinterConfig } from "../config";
import { moonrakerBaseUrl, moonrakerHeaders, parseMoonrakerNozzleDiameter } from "../status/moonraker";
import { firstFiniteNumber, firstText } from "../status/mapper";
import {
  failedDiscovery,
  fromPrinter,
  succeededDiscovery,
  type DiscoveryResult
} from "./types";

/**
 * Hardware discovery for Klipper printers over Moonraker (the farm's K2 and
 * Ender run this path).
 *
 * Klipper is the richest of the three protocols here, because a Klipper machine
 * is *defined* by a config file and Moonraker publishes that config back. The
 * build volume in particular is a genuine device reading — the axis limits the
 * firmware actually enforces — which is what makes «размеры рабочей области»
 * auto-fill honestly on this protocol while Bambu has to fall back to the model
 * catalogue.
 *
 * Three requests, all cheap and LAN-local:
 *
 *  - `/printer/info` — firmware version and the device's own hostname;
 *  - `/printer/objects/list` — which objects exist, i.e. which hardware is
 *    configured (extruders, chamber heater, filament sensor, Creality's CFS);
 *  - `/printer/objects/query?configfile=settings` — the parsed config, holding
 *    the axis limits, the nozzle diameter and the kinematics.
 *
 * What is deliberately NOT read:
 *
 *  - **the model.** Klipper has no concept of one; a machine is its config file.
 *    It stays a manual field, and the card says so;
 *  - **the nozzle type.** Klipper has no standard field for it — same;
 *  - **the CFS slot contents.** Only the *presence* of the `box` object is
 *    recorded. The real K2-7F14 reports every slot as `-1`, so reading materials
 *    from it would be invention; this is the same line `status/moonraker.ts`
 *    already holds for active filament.
 */

const MOONRAKER_TIMEOUT_MS = 3500;

/**
 * The build volume from Klipper's own axis limits
 * (`stepper_{x,y,z}.position_min/position_max`) — the travel the firmware
 * enforces, not a catalogue figure.
 *
 * All three axes or nothing, matching the stored config's rule: a half-known
 * volume cannot be compared against a model's footprint, so it is not a volume.
 * `position_min` is subtracted because a bed whose origin sits at -5 has that
 * much less usable travel.
 */
export function parseKlipperBuildVolume(
  settings: Record<string, unknown>
): BuildVolumeFacts | null {
  const axis = (name: string): number | null => {
    const stepper = settings[`stepper_${name}`];
    if (!isObject(stepper)) return null;

    const max = firstFiniteNumber(stepper.position_max);
    if (max === null) return null;
    // A missing minimum means the axis starts at zero, which is the norm.
    const min = firstFiniteNumber(stepper.position_min) ?? 0;

    const span = max - min;
    return span > 0 ? Math.round(span * 100) / 100 : null;
  };

  const x = axis("x");
  const y = axis("y");
  const z = axis("z");
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

/** Which hardware a Klipper config declares, from the parsed settings + object list. */
export function parseKlipperFeatures(
  settings: Record<string, unknown>,
  objects: readonly string[]
): {
  extruderCount: number | null;
  heatedChamber: boolean;
  chamberSensor: boolean;
  filamentSensor: boolean;
  cfs: boolean;
  kinematics: string | null;
} {
  const names = objects.map((name) => name.toLowerCase());
  const has = (predicate: (name: string) => boolean): boolean => names.some(predicate);

  // Klipper names extruders `extruder`, `extruder1`, `extruder2`… — counting the
  // sections is how many hotends the machine is configured with.
  const extruders = Object.keys(settings).filter((key) => /^extruder\d*$/.test(key)).length;

  const printer = isObject(settings.printer) ? settings.printer : null;

  return {
    extruderCount: extruders > 0 ? extruders : null,
    heatedChamber: has((name) => name === "heater_chamber" || name === "heater_generic chamber"),
    chamberSensor: has((name) => name.startsWith("temperature_sensor") && name.includes("chamber")),
    filamentSensor: has(
      (name) => name.startsWith("filament_switch_sensor") || name.startsWith("filament_motion_sensor")
    ),
    // Creality's CFS. Presence only — see the module note above.
    cfs: has((name) => name === "box"),
    kinematics: printer ? firstText(printer.kinematics) || null : null
  };
}

async function getJson(
  printer: PrinterConfig,
  path: string
): Promise<Record<string, unknown> | null> {
  const res = await fetchWithTimeout(`${moonrakerBaseUrl(printer)}${path}`, {
    timeoutMs: MOONRAKER_TIMEOUT_MS,
    headers: moonrakerHeaders(printer)
  });
  if (!res.ok) throw new Error(`Moonraker HTTP ${res.status}`);

  const json = (await res.json()) as { result?: unknown };
  return isObject(json?.result) ? json.result : null;
}

export async function discoverMoonrakerFacts(printer: PrinterConfig): Promise<DiscoveryResult> {
  try {
    // The config query is the one that must succeed — it carries the build
    // volume and the nozzle. The other two are enriching, so a Moonraker build
    // that lacks them still yields a useful result rather than nothing.
    const status = await getJson(printer, "/printer/objects/query?configfile=settings");
    const [info, objectList] = await Promise.all([
      getJson(printer, "/printer/info").catch(() => null),
      getJson(printer, "/printer/objects/list").catch(() => null)
    ]);

    const facts: DiscoveredFacts = {};

    if (info) {
      const firmware = firstText(info.software_version);
      if (firmware) facts.firmware = fromPrinter(firmware, "/printer/info → software_version");

      const hostname = firstText(info.hostname);
      if (hostname) facts.deviceName = fromPrinter(hostname, "/printer/info → hostname");
    }

    const configStatus = isObject(status?.status) ? status.status : {};
    const configfile = isObject(configStatus.configfile) ? configStatus.configfile : null;
    const settings = configfile && isObject(configfile.settings) ? configfile.settings : null;

    const nozzleDiameter = parseMoonrakerNozzleDiameter(configStatus);
    if (nozzleDiameter !== null) {
      facts.nozzleDiameterMm = fromPrinter(
        nozzleDiameter,
        "configfile.settings.extruder.nozzle_diameter"
      );
    }

    if (settings) {
      const buildVolume = parseKlipperBuildVolume(settings);
      if (buildVolume) {
        facts.buildVolume = fromPrinter(
          buildVolume,
          "configfile.settings.stepper_{x,y,z}.position_max"
        );
      }

      const objects = Array.isArray(objectList?.objects)
        ? objectList.objects.filter((name): name is string => typeof name === "string")
        : Object.keys(settings);

      const features = parseKlipperFeatures(settings, objects);
      if (features.extruderCount !== null) {
        facts.extruderCount = fromPrinter(features.extruderCount, "configfile.settings.extruder*");
      }
      if (features.kinematics) {
        facts.kinematics = fromPrinter(features.kinematics, "configfile.settings.printer.kinematics");
      }
      if (features.heatedChamber) {
        facts.heatedChamber = fromPrinter(true, "объект heater_chamber");
      }
      if (features.chamberSensor) {
        facts.chamberSensor = fromPrinter(true, "объект temperature_sensor chamber");
      }
      if (features.filamentSensor) {
        facts.filamentSensor = fromPrinter(true, "объект filament_switch_sensor");
      }
      if (features.cfs) {
        // Presence without contents: the device offers no readable slot data.
        facts.ams = fromPrinter(
          { present: true, kind: "CFS", units: null, slots: null },
          "объект box (CFS) — состав слотов принтер не сообщает"
        );
      }
    }

    return succeededDiscovery(facts);
  } catch (error) {
    return failedDiscovery(
      error instanceof Error ? error.message : "Неизвестная ошибка Moonraker"
    );
  }
}
