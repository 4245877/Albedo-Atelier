/**
 * True for a plain non-null object — the shape JSON validation walks into.
 * Arrays are excluded on purpose: every consumer (device payload mappers, the
 * printers config loader, the persisted-state normalizers) treats arrays as a
 * distinct case and handles them with `Array.isArray` explicitly.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
