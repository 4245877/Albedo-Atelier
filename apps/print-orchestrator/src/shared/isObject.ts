/**
 * Contract: **any non-null value of type `object` that is not an array.** Arrays
 * are excluded on purpose — every consumer (device payload mappers, the printers
 * config loader, the persisted-state normalizers) handles them separately with
 * `Array.isArray`. The check is deliberately NOT tightened to "plain object":
 * every input here is `JSON.parse` output (Moonraker/Bambu telemetry, the JSON
 * config, the persisted JSON state), which never yields a `Date`/`Map`/`RegExp`
 * or a class instance, so a narrower guard would add cost and complexity for a
 * case that cannot occur. It then treats the value as a keyed record to read
 * fields off — safe because unknown keys simply read back `undefined`.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
