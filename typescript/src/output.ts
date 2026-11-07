import { isPlainObject, pyJsonDumps, pyStr } from "./internal/py.js";
import { jsonIso } from "./internal/time.js";

/**
 * Turn an SDK return value into JSON-ready data, with dates in "Z" ISO form.
 *
 * @param obj (unknown): the SDK return value.
 * @return (unknown): JSON-ready data.
 */
export function toJsonable(obj: unknown): unknown {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === "number" && !Number.isFinite(obj)) return null;
  if (obj instanceof Date) return jsonIso(obj);
  if (typeof obj === "bigint") return Number.isSafeInteger(Number(obj)) ? Number(obj) : obj.toString();
  if (Array.isArray(obj)) return obj.map(toJsonable);
  if (isPlainObject(obj)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toJsonable(v);
    return out;
  }
  return obj;
}

/**
 * Pretty JSON for any SDK return value, as the CLI prints it.
 *
 * @param obj (unknown): the SDK return value.
 * @return (string): the JSON text.
 */
export function dumps(obj: unknown): string {
  return pyJsonDumps(toJsonable(obj), { indent: 2, ensureAscii: false, default: pyStr });
}
