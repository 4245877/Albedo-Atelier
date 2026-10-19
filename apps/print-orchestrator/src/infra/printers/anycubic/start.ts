import { isObject } from "../../../shared/isObject";
import { normalizePrinterPath } from "../files/path";
import { PrinterCommandError } from "../status/types";

export interface AnycubicStartIdentity { sizeBytes: number; md5: string }
export interface AnycubicPreparedStart {
  taskid: "-1";
  filename: string;
  url: "";
  md5: string;
  filepath: null;
  filetype: 1;
  project_type: 1;
  filesize: number;
  ams_settings: { use_ams: false; ams_box_mapping: never[] };
  task_settings: { auto_leveling: 1; vibration_compensation: 0; flow_calibration: 0 };
}

/** `.gcode.3mf` may start by an inner filename: refuse until that identity is proven. */
export function prepareAnycubicStart(path: string, identity: AnycubicStartIdentity | undefined, feed: Record<string, unknown> | null | undefined): AnycubicPreparedStart {
  const normalized = normalizePrinterPath(path);
  const filename = normalized.startsWith("local/") ? normalized.slice(6) : normalized;
  if (filename.includes("/") || !filename.toLowerCase().endsWith(".gcode")) {
    throw new PrinterCommandError("Anycubic LAN: запуск пока подготовлен только для .gcode в памяти принтера", true);
  }
  if (!identity || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes <= 0 || identity.sizeBytes > 512 * 1024 * 1024 || !/^[a-fA-F0-9]{32}$/.test(identity.md5)) {
    throw new PrinterCommandError("Anycubic LAN: для запуска нужны размер и MD5 доставленного артефакта", true);
  }
  if (feed?.kind !== "external") throw new PrinterCommandError("Anycubic LAN: требуется явно закреплённая внешняя катушка; ACE mapping ещё не проверен", true);
  return { taskid: "-1", filename, url: "", md5: identity.md5.toLowerCase(), filepath: null, filetype: 1, project_type: 1, filesize: identity.sizeBytes,
    ams_settings: { use_ams: false, ams_box_mapping: [] }, task_settings: { auto_leveling: 1, vibration_compensation: 0, flow_calibration: 0 } };
}

/** Only the exact constructed shape may reach the slicer print topic. */
export function isPreparedAnycubicStart(data: unknown): data is AnycubicPreparedStart {
  if (!isObject(data) || typeof data.filename !== "string" || typeof data.md5 !== "string" || typeof data.filesize !== "number") return false;
  try {
    const expected = prepareAnycubicStart(data.filename, { sizeBytes: data.filesize, md5: data.md5 }, { kind: "external" });
    return JSON.stringify(data) === JSON.stringify(expected);
  } catch { return false; }
}
