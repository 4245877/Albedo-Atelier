import { isObject } from "../../../shared/isObject";
import { normalizePrinterPath } from "../files/path";

export type AnycubicStorage = "local" | "usb";
export interface AnycubicRequest {
  type: string;
  action: string;
  data: unknown;
  timestamp: number;
  msgid: string;
}

/** File reads have their own allowlist; they never widen the telemetry guard. */
export function isFileReadRequest(m: AnycubicRequest): boolean {
  if (m.type !== "file" || !isObject(m.data)) return false;
  const d = m.data;
  if (m.action === "listLocal" || m.action === "listUdisk") {
    return Object.keys(d).length === 3 && safeDevicePath(d.path) &&
      Number.isInteger(d.page_num) && Number(d.page_num) >= 1 && Number(d.page_num) <= 100 &&
      Number.isInteger(d.page_size) && Number(d.page_size) >= 1 && Number(d.page_size) <= 200;
  }
  if (m.action === "fileDetails") {
    return Object.keys(d).length === 2 && (d.root === "local" || d.root === "udisk") &&
      typeof d.filename === "string" && safeRelativePath(d.filename);
  }
  return false;
}

export function isLightCommand(m: AnycubicRequest): boolean {
  return m.type === "light" && m.action === "control" && isObject(m.data) &&
    Object.keys(m.data).length === 3 && m.data.type === 3 &&
    (m.data.status === 1 && m.data.brightness === 100 || m.data.status === 0 && m.data.brightness === 0);
}

export function isPrintControlCommand(m: AnycubicRequest): boolean {
  return m.type === "print" && ["pause", "resume", "stop"].includes(m.action) && isObject(m.data) &&
    Object.keys(m.data).length === 1 && typeof m.data.taskid === "string" && /^(?:-1|[1-9]\d{0,39})$/.test(m.data.taskid);
}

export function isCameraCommand(m: AnycubicRequest): boolean {
  return m.type === "video" && ["startCapture", "stopCapture"].includes(m.action) && m.data === null;
}

function safeRelativePath(path: string): boolean {
  try { return normalizePrinterPath(path) === path; } catch { return false; }
}

function safeDevicePath(path: unknown): boolean {
  return path === "/" || typeof path === "string" && path.startsWith("/") && safeRelativePath(path.slice(1));
}
