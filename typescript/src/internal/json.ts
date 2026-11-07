import { ValidationError } from "../errors.js";
import { pyJsonDumps } from "./py.js";

/**
 * Encode a value as sorted-key JSON, rejecting values JSON cannot hold.
 *
 * @param value (unknown): the value to encode.
 * @return (string): the JSON text.
 */
export function dumps(value: unknown): string {
  try {
    return pyJsonDumps(value, { sortKeys: true });
  } catch (exc) {
    throw new ValidationError(`value is not JSON-serializable: ${(exc as Error).message}`, { cause: exc });
  }
}

/**
 * Decode JSON text, passing through already-decoded containers and falling back on bad input.
 *
 * @param value (unknown): the stored value.
 * @param fallback (T): the value to use when absent or undecodable.
 * @return (T): the decoded value.
 */
export function loads<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
