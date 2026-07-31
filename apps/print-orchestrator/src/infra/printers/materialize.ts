import type {
  PrinterLightSettings,
  PrinterProtocol,
  PrinterRecord
} from "../../domain/printers/config";
import type { PrinterConfig, PrinterLightConfig } from "./config";

/**
 * Turning a stored {@link PrinterRecord} into the runtime {@link PrinterConfig}
 * the drivers, the poller and the read models consume.
 *
 * Two things happen here and nowhere else:
 *
 *  1. **`${ENV_VAR}` expansion.** A record keeps the operator's text verbatim, so
 *     a config imported from the old `printers.json` still resolves its secrets
 *     from `.env`. An unset variable expands to `""` — the driver then reports
 *     the printer as "не настроен" instead of trying to authenticate with the
 *     literal placeholder.
 *  2. **Light defaults.** A record may leave `light.enabled` unstated (`null`);
 *     that resolves to the protocol's default here, so the stored row keeps
 *     saying "operator never chose" while the runtime always has a boolean.
 */

/** Expands `${ENV_VAR}` references; an unset variable becomes "". */
export function expandEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? "");
}

/**
 * Derives the executable light configuration. An active-low pin lights the
 * fixture at VALUE=0, so the pin-derived G-code swaps its VALUEs; explicit
 * on/off G-code always wins (it already encodes the operator's intent).
 */
export function deriveLightConfig(
  settings: PrinterLightSettings,
  protocol: PrinterProtocol,
  expand: (value: string) => string = expandEnvRefs
): PrinterLightConfig {
  const pin = expand(settings.pin);
  const invert = settings.invert === true;
  const onValue = invert ? 0 : 1;
  const offValue = invert ? 1 : 0;
  const onGcode = expand(settings.onGcode) || (pin ? `SET_PIN PIN=${pin} VALUE=${onValue}` : "");
  const offGcode = expand(settings.offGcode) || (pin ? `SET_PIN PIN=${pin} VALUE=${offValue}` : "");
  const statusObject = expand(settings.statusObject) || (pin ? `output_pin ${pin}` : "");
  const statusField = expand(settings.statusField) || "value";
  const bambuNode = expand(settings.bambuNode) || "chamber_light";

  const enabled =
    typeof settings.enabled === "boolean"
      ? settings.enabled
      : protocol === "bambu" || (protocol === "moonraker" && Boolean(onGcode && offGcode));

  return { enabled, pin, invert, onGcode, offGcode, statusObject, statusField, bambuNode };
}

/** The stored record as the runtime config the drivers consume. */
export function materializePrinter(record: PrinterRecord): PrinterConfig {
  const expand = expandEnvRefs;
  return {
    id: record.id,
    name: expand(record.name),
    model: expand(record.model),
    type: record.type,
    printerClass: expand(record.printerClass),

    protocol: record.protocol,
    host: expand(record.host),
    port: record.port ?? undefined,

    material: expand(record.material),
    nozzleDiameterMm: record.nozzleDiameterMm,
    nozzleType: expand(record.nozzleType),
    buildVolume: record.buildVolume,
    swatch: expand(record.swatch),
    snapshotUrl: expand(record.snapshotUrl),
    streamUrl: expand(record.streamUrl),
    interfaceUrl: expand(record.interfaceUrl),

    enabled: record.enabled,
    apiKey: expand(record.apiKey),
    serial: expand(record.serial),
    accessCode: expand(record.accessCode),
    allowInsecureTls: record.allowInsecureTls,
    automaticContinuation: record.automaticContinuation,
    light: deriveLightConfig(record.light, record.protocol, expand)
  };
}
