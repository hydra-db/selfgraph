import { ValidationError } from "./errors.js";
import { dumps } from "./internal/json.js";
import { isPlainObject, pyRepr, pyStrip } from "./internal/py.js";
import { toIso } from "./internal/time.js";

const MAX_JSON_DEPTH = 64;

/**
 * Report whether text holds an unpaired surrogate, which cannot be UTF-8 encoded.
 *
 * @param text (string): the text to inspect.
 * @return (boolean): true when a lone surrogate is present.
 */
export function hasSurrogate(text: string): boolean {
  return !text.isWellFormed();
}

/**
 * Report whether text holds a NUL or an unpaired surrogate, which some backends cannot store or encode.
 *
 * @param text (string): the text to inspect.
 * @return (boolean): true when a NUL or surrogate character is present.
 */
export function isUnstorable(text: string): boolean {
  return text.includes("\x00") || hasSurrogate(text);
}

/**
 * Report whether text holds a C0/C1 control character, DEL, or an unpaired surrogate.
 *
 * @param text (string): the text to inspect.
 * @return (boolean): true when a control or surrogate character is present.
 */
export function hasControl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) return true;
  }
  return false;
}

/**
 * Validate a stored JSON value: bounded nesting, clean string keys, and UTF-8-emittable strings.
 *
 * @param name (string): the field name for error messages.
 * @param value (unknown): the JSON-shaped value.
 * @param depth (number): the current nesting depth.
 */
export function requireCleanJson(name: string, value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new ValidationError(`${name} is nested too deeply; keep it under ${MAX_JSON_DEPTH} levels`);
  }
  if (typeof value === "string") {
    if (isUnstorable(value)) {
      throw new ValidationError(`${name} values cannot contain NUL or unpaired surrogate characters`);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) requireCleanJson(name, item, depth + 1);
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (hasControl(key)) throw new ValidationError(`${name} keys cannot contain control or surrogate characters`);
      requireCleanJson(name, item, depth + 1);
    }
  }
}

/**
 * Validate a value is a non-empty string with no control or surrogate characters.
 *
 * @param label (string): the field name for the error message.
 * @param value (unknown): the value to check.
 */
export function requireStr(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string") throw new ValidationError(`${label} must be a string, got ${pyTypeName(value)}`);
  if (!pyStrip(value)) throw new ValidationError(`${label} cannot be empty`);
  if (hasControl(value)) throw new ValidationError(`${label} cannot contain control or surrogate characters`);
}

/**
 * The type name error messages use for a JSON-like value: str, int, float, bool, list, dict, datetime, or NoneType.
 *
 * @param value (unknown): the value.
 * @return (string): the type name.
 */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (Array.isArray(value)) return "list";
  if (value instanceof Date) return "datetime";
  if (typeof value === "object") return isPlainObject(value) ? "dict" : (value.constructor?.name ?? "object");
  return typeof value;
}

/**
 * Every key of an options type, as a runtime list; the record literal must name each key exactly once.
 *
 * @param keys (Record<keyof T, true>): one entry per key of T.
 * @return (string[]): the key names.
 */
export function keysOf<T>(keys: Record<keyof T, true>): string[] {
  return Object.keys(keys);
}

/**
 * Reject option keys a caller passed that the method does not accept (plain-JS callers bypass the types).
 *
 * @param what (string): the object kind, for the message.
 * @param options (object): the options object.
 * @param allowed (readonly string[]): the accepted keys.
 */
export function rejectUnknown(what: string, options: object, allowed: readonly string[]): void {
  const extra = Object.entries(options)
    .filter(([k, v]) => v !== undefined && !allowed.includes(k))
    .map(([k]) => k)
    .sort();
  if (extra.length) throw new ValidationError(`unknown ${what} update field(s): ${pyRepr(extra)}`);
}

/**
 * Validate a value is a non-empty string with no control or surrogate characters.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireText(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !pyStrip(value)) {
    throw new ValidationError(`${field} must be a non-empty string, got ${pyTypeName(value)}`);
  }
  if (hasControl(value)) throw new ValidationError(`${field} cannot contain control or surrogate characters`);
}

/**
 * Validate a value is an integer.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireInt(field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer, got ${pyTypeName(value)}`);
  }
}

/**
 * Validate a value is a string or absent.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireOptionalText(field: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string")
    throw new ValidationError(`${field} must be a string or None, got ${pyTypeName(value)}`);
  if (hasControl(value)) throw new ValidationError(`${field} cannot contain control or surrogate characters`);
}

/**
 * Validate a value is a Date that ISO formatting can represent, or absent.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireDatetime(field: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (!(value instanceof Date)) throw new ValidationError(`${field} must be a datetime, got ${pyTypeName(value)}`);
  try {
    toIso(value);
  } catch (exc) {
    throw new ValidationError(`${field} is outside the representable datetime range`, { cause: exc });
  }
}

/**
 * Validate a value is a list of strings with no control or surrogate characters.
 *
 * @param name (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireList(name: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list of strings, got ${pyTypeName(value)}`);
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError(`${name} must be a list of strings, got a ${pyTypeName(item)} element`);
    }
    if (hasControl(item)) throw new ValidationError(`${name} elements cannot contain control or surrogate characters`);
  }
}

/**
 * Validate a value is a plain object with clean keys and values.
 *
 * @param name (string): the field name for the error message.
 * @param value (unknown): the value.
 */
function requireMapping(name: string, value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValidationError(`${name} must be a mapping, got ${pyTypeName(value)}`);
  requireCleanJson(name, value);
}

/**
 * Validate an optional mapping has string keys and JSON-serializable values, before any write.
 *
 * @param name (string): the field name for the error message.
 * @param value (unknown): the value, or null.
 */
export function requireJsonMapping(name: string, value: unknown): void {
  if (value === null || value === undefined) return;
  requireMapping(name, value);
  dumps(value);
}

/**
 * Validate a value is a mapping from strings to strings.
 *
 * @param name (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireStrMapping(name: string, value: unknown): asserts value is Record<string, string> {
  requireMapping(name, value);
  for (const item of Object.values(value)) {
    if (typeof item !== "string") throw new ValidationError(`${name} must map strings to strings`);
  }
}
