import type { DiscoveredFacts, LoadedMaterialFact } from "../../../domain/printers/discovery";
import { deriveBambuModelCode, lookupModelSpec } from "../../../domain/printers/modelSpecs";
import { isObject } from "../../../shared/isObject";
import type { PrinterConfig } from "../config";
import { getBambuDeviceInfo, getBambuRawPrint } from "../status/bambu";
import { parseAmsTrays, parseVtTray } from "../status/bambuUsage";
import { firstFiniteNumber, firstText } from "../status/mapper";
import {
  failedDiscovery,
  fromCatalog,
  fromPrinter,
  succeededDiscovery,
  type DiscoveryResult
} from "./types";

/**
 * Hardware discovery for Bambu Lab printers over local MQTT.
 *
 * **This adapter performs no I/O.** Both payloads it reads are already flowing:
 * the merged `print` report the status poll maintains, and the `info.get_version`
 * reply the client requests once per connect. So a probe is a cache read, which
 * is why the discovery interval can be short without costing anything.
 *
 * What the protocol does NOT carry, and this module therefore does not invent:
 *
 *  - **the build volume.** The printer knows its bed size; it never puts it on
 *    the wire. It comes from the model catalogue instead, tagged `catalog`;
 *  - **the AMS kind.** An AMS and an AMS Lite report through the identical `ams`
 *    structure. Telemetry gives presence, unit count and slot count; whether it
 *    is a Lite is a property of the model, so it too comes from the catalogue;
 *  - **the model.** Derived from the serial prefix (see `deriveBambuModelCode`);
 *    `null` when the prefix is unknown, never the nearest match.
 */

/** One named module from an `info.get_version` reply. */
function findModule(
  info: Record<string, unknown>,
  name: string
): Record<string, unknown> | null {
  const modules = info.module;
  if (!Array.isArray(modules)) return null;

  for (const module of modules) {
    if (!isObject(module)) continue;
    if (firstText(module.name).toLowerCase() === name) return module;
  }
  return null;
}

/**
 * Firmware version from the `ota` module — the string the printer's own screen
 * shows. Other modules report their board revisions, not the firmware.
 */
export function parseBambuFirmware(info: Record<string, unknown>): string | null {
  return firstText(findModule(info, "ota")?.sw_ver) || null;
}

/**
 * The serial number **as the device reports it**, from the `ota` module.
 *
 * Distinct on purpose from the serial stored in the printer's credentials: that
 * one was typed by an operator, so a model derived from it is only as good as
 * their typing. This one is the machine identifying itself, which is what makes
 * the resulting model a `printer` fact rather than a `catalog` guess.
 */
export function parseBambuSerial(info: Record<string, unknown>): string | null {
  return firstText(findModule(info, "ota")?.sn) || null;
}

/**
 * AMS presence and size from a merged `print` payload.
 *
 * Returns null when the device reports no `ams` block at all — that is "we do
 * not know", not "there is no AMS": a printer that has not yet sent a full
 * report says nothing about its hardware. A present-but-empty `ams.ams` array,
 * by contrast, is the device stating it has no units attached.
 */
export function parseBambuAms(print: Record<string, unknown>): {
  present: boolean;
  units: number | null;
  slots: number | null;
} | null {
  const ams = print.ams;
  if (!isObject(ams) || !Array.isArray(ams.ams)) return null;

  const units = ams.ams.filter(isObject);
  const slots = units.reduce(
    (total, unit) => total + (Array.isArray(unit.tray) ? unit.tray.length : 0),
    0
  );

  return {
    present: units.length > 0,
    units: units.length > 0 ? units.length : null,
    slots: slots > 0 ? slots : null
  };
}

/**
 * Loaded filament per slot, plus the external spool when one is in use.
 *
 * Reuses the AMS parsing the filament accounting already relies on, so the card
 * and the stock deduction can never disagree about which slot holds what.
 */
export function parseBambuMaterials(print: Record<string, unknown>): LoadedMaterialFact[] | null {
  const trays = parseAmsTrays(print);
  const materials: LoadedMaterialFact[] =
    trays?.map((tray) => ({
      slot: tray.tray,
      material: tray.material,
      color: tray.color,
      remainPct: tray.remainPct,
      active: tray.active
    })) ?? [];

  // The external spool has no slot index; it is only listed when nothing in the
  // AMS is feeding, which is precisely when it is the thing being printed from.
  const external = parseVtTray(print);
  if (external && !materials.some((entry) => entry.active)) {
    materials.push({
      slot: null,
      material: external.material,
      color: external.color,
      remainPct: external.remainPct,
      active: true
    });
  }

  return materials.length > 0 ? materials : null;
}

export function discoverBambuFacts(printer: PrinterConfig): DiscoveryResult {
  const print = getBambuRawPrint(printer.id);
  const info = getBambuDeviceInfo(printer.id);

  if (!print && !info) {
    return failedDiscovery(
      "Принтер ещё не прислал ни одного отчёта по Bambu MQTT — проверьте связь и учётные данные"
    );
  }

  const facts: DiscoveredFacts = {};

  if (info) {
    const firmware = parseBambuFirmware(info);
    if (firmware) facts.firmware = fromPrinter(firmware, "MQTT info.get_version → ota.sw_ver");
  }

  // Prefer the serial the DEVICE reported over the one an operator typed: both
  // identify the same machine, but only the first is a reading. Which one was
  // used decides whether the resulting model is a `printer` fact or a `catalog`
  // one — the difference the operator sees as «с принтера» vs «по модели».
  //
  // Either way the serial itself is a credential and never leaves the service;
  // only the model it identifies is published.
  const deviceSerial = info ? parseBambuSerial(info) : null;
  const modelSpec = lookupModelSpec(deriveBambuModelCode(deviceSerial ?? printer.serial));
  if (modelSpec) {
    const identify = deviceSerial
      ? <T,>(value: T) => fromPrinter(value, "MQTT info.get_version → ota.sn (серийный номер)")
      : <T,>(value: T) => fromCatalog(value, "серийный номер из настроек принтера");
    facts.modelCode = identify(modelSpec.code);
    facts.model = identify(modelSpec.name);
    facts.technology = fromCatalog(modelSpec.technology);
    if (modelSpec.buildVolume) facts.buildVolume = fromCatalog(modelSpec.buildVolume);
  }

  if (print) {
    const nozzleDiameter = firstFiniteNumber(print.nozzle_diameter);
    if (nozzleDiameter !== null && nozzleDiameter > 0) {
      facts.nozzleDiameterMm = fromPrinter(nozzleDiameter, "MQTT print.nozzle_diameter");
    }

    const nozzleType = firstText(print.nozzle_type);
    if (nozzleType) facts.nozzleType = fromPrinter(nozzleType, "MQTT print.nozzle_type");

    const ams = parseBambuAms(print);
    if (ams) {
      facts.ams = fromPrinter(
        { ...ams, kind: ams.present ? (modelSpec?.amsKind ?? null) : null },
        "MQTT print.ams"
      );
    }

    const materials = parseBambuMaterials(print);
    if (materials) facts.materials = fromPrinter(materials, "MQTT print.ams / vt_tray");

    // A chamber *reading* only proves a sensor exists. Whether the chamber is
    // actively heated is a different claim the protocol does not support, so it
    // is not made here.
    if (firstFiniteNumber(print.chamber_temper) !== null) {
      facts.chamberSensor = fromPrinter(true, "MQTT print.chamber_temper");
    }
  }

  return succeededDiscovery(facts);
}
