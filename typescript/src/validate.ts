import { ValidationError } from "./errors.js";
import { dumps } from "./internal/json.js";
import { comparePy, cpLen, isPlainObject, pyRepr, pyStrip } from "./internal/py.js";
import { parseIso, toIso } from "./internal/time.js";

const MAX_JSON_DEPTH = 64;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const KEY_SYNONYMS: Readonly<Record<string, string>> = {
  entity_types: "entities",
  node_types: "entities",
  nodes: "entities",
  relation_types: "relations",
  relationship_types: "relations",
  edge_types: "relations",
  edges: "relations",
  graph_name: "graph",
  graphName: "graph",
};

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
 * Validate a stored JSON value: bounded nesting, clean string keys, UTF-8-emittable strings, safe integers, no Dates.
 *
 * @param name (string): the field name for error messages.
 * @param value (unknown): the JSON-shaped value.
 * @param depth (number): the current nesting depth.
 * @param safeInts (boolean): reject a bigint outside +/-(2^53 - 1), which JSON.parse would round.
 */
export function requireCleanJson(name: string, value: unknown, depth = 0, safeInts = true): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new ValidationError(`${name} is nested too deeply; keep it under ${MAX_JSON_DEPTH} levels`);
  }
  if (typeof value === "string") {
    if (isUnstorable(value)) {
      throw new ValidationError(`${name} values cannot contain NUL or unpaired surrogate characters`);
    }
  } else if (typeof value === "bigint") {
    if (safeInts && (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT)) {
      throw new ValidationError(`${name} integer ${value} is outside the safe range; store it as a string`);
    }
  } else if (value instanceof Date) {
    throw new ValidationError(`${name} cannot hold Date values; use an ISO 8601 string`);
  } else if (Array.isArray(value)) {
    for (const item of value) requireCleanJson(name, item, depth + 1, safeInts);
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (hasControl(key)) throw new ValidationError(`${name} keys cannot contain control or surrogate characters`);
      requireCleanJson(name, item, depth + 1, safeInts);
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
  if (typeof value !== "string") throw new ValidationError(`${label} must be a string, got ${typeName(value)}`);
  if (!pyStrip(value)) throw new ValidationError(`${label} cannot be empty`);
  requireNoControl(label, value);
}

/**
 * Validate a namespace: a non-empty string with no control characters and no leading or trailing whitespace.
 *
 * @param value (unknown): the namespace.
 */
export function requireNamespace(value: unknown): asserts value is string {
  requireStr("namespace", value);
  if (value !== pyStrip(value)) throw new ValidationError("namespace cannot start or end with whitespace");
}

/**
 * Reject text holding a control or surrogate character.
 *
 * @param label (string): the field name for the error message.
 * @param value (string): the text to check.
 */
export function requireNoControl(label: string, value: string): void {
  if (hasControl(value)) throw new ValidationError(`${label} cannot contain control or surrogate characters`);
}

/**
 * The type name error messages use for a value: string, number, boolean, array, object, Date, null, undefined, or a class name.
 *
 * @param value (unknown): the value.
 * @return (string): the type name.
 */
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (typeof value === "object") return isPlainObject(value) ? "object" : (value.constructor?.name ?? "object");
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
 * Count the single-character insertions, deletions, and substitutions that turn one string into another.
 *
 * @param a (string): the first string.
 * @param b (string): the second string.
 * @return (number): the Levenshtein distance.
 */
function editDistance(a: string, b: string): number {
  const bs = Array.from(b);
  let prev = Array.from({ length: bs.length + 1 }, (_, j) => j);
  let i = 0;
  for (const ca of a) {
    i += 1;
    const cur = [i];
    bs.forEach((cb, j) => {
      cur.push(Math.min(prev[j + 1]! + 1, cur[j]! + 1, prev[j]! + (ca === cb ? 0 : 1)));
    });
    prev = cur;
  }
  return prev[bs.length]!;
}

/**
 * Pick the valid key closest to an unknown one: a synonym, else the nearest within maxEdits, else one ending in _<key>.
 *
 * @param key (string): the unknown key.
 * @param valid (readonly string[]): the accepted keys in declared order.
 * @param maxEdits (number): the most edits a suggestion may be away.
 * @return (string | null): the suggestion, or null when nothing is close.
 */
export function suggestKey(key: string, valid: readonly string[], maxEdits = 2): string | null {
  const synonym = KEY_SYNONYMS[key];
  if (synonym !== undefined && valid.includes(synonym)) return synonym;
  let best: string | null = null;
  let limit = Math.min(maxEdits, cpLen(key) - 1);
  for (const candidate of valid) {
    const distance = editDistance(key, candidate);
    if (distance <= limit) {
      best = candidate;
      limit = distance - 1;
    }
  }
  return best ?? valid.find((candidate) => candidate.endsWith(`_${key}`)) ?? null;
}

const LISTED_KEYS = 8;

/**
 * The suffix that offers a suggested name, or "" without one.
 *
 * @param suggestion (string | null): the suggested name.
 * @return (string): the suffix, such as "; did you mean 'name'?".
 */
export function didYouMean(suggestion: string | null): string {
  return suggestion === null ? "" : `; did you mean ${pyRepr(suggestion)}?`;
}

/**
 * The suffix of an unknown-key error: the closest valid key, and every valid key when there are few.
 *
 * @param key (string): the unknown key.
 * @param valid (readonly string[]): the accepted keys in declared order.
 * @param noun (string): what the keys are called in the list, such as "keys" or "options".
 * @return (string): the suffix, such as "; did you mean 'name'? (valid keys: id, type, name)", or "".
 */
export function keyHint(key: string, valid: readonly string[], noun = "keys"): string {
  let hint = didYouMean(suggestKey(key, valid));
  if (valid.length > 0 && valid.length <= LISTED_KEYS) hint += ` (valid ${noun}: ${valid.join(", ")})`;
  return hint;
}

/**
 * Reject option keys a method does not accept, naming the first unknown key and the closest accepted one.
 *
 * @param method (string): the method the options belong to, for the message.
 * @param options (unknown): the options object; anything that is not a plain object is left to the method.
 * @param allowed (readonly string[]): the accepted keys in declared order.
 */
export function checkOptions(method: string, options: unknown, allowed: readonly string[]): void {
  if (!isPlainObject(options)) return;
  const unknown = Object.entries(options)
    .filter(([k, v]) => v !== undefined && !allowed.includes(k))
    .map(([k]) => k)
    .sort(comparePy);
  if (!unknown.length) return;
  throw new ValidationError(
    `unknown option ${pyRepr(unknown[0])} for ${method}${keyHint(unknown[0]!, allowed, "options")}`,
  );
}

/**
 * Validate a flag is a real boolean, so a truthy string never flips an option.
 *
 * @param name (string): the argument name for the error message.
 * @param value (unknown): the value to check.
 */
export function requireBool(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${name} must be a boolean, got ${typeName(value)}`);
}

/**
 * Validate a value is an integer.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireInt(field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer, got ${typeName(value)}`);
  }
}

/**
 * Validate a value is a real number in the unit interval.
 *
 * @param label (string): the field name for the error message.
 * @param value (unknown): the value.
 * @param finite (boolean): reject NaN and infinity with their own message before the range check.
 */
export function requireUnit(label: string, value: unknown, finite = false): void {
  if (typeof value !== "number") throw new ValidationError(`${label} must be a number, got ${typeName(value)}`);
  if (finite && !Number.isFinite(value)) throw new ValidationError(`${label} must be a finite number`);
  if (!(value >= 0 && value <= 1)) throw new ValidationError(`${label} must be between 0 and 1, got ${value}`);
}

/**
 * Validate a value is a string or absent.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireOptionalText(field: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string or null, got ${typeName(value)}`);
  requireNoControl(field, value);
}

/**
 * Validate a value is a Date that ISO formatting can represent, or absent.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireDatetime(field: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (!(value instanceof Date)) throw new ValidationError(`${field} must be a datetime, got ${typeName(value)}`);
  try {
    toIso(value);
  } catch (exc) {
    throw new ValidationError(`${field} is outside the representable datetime range`, { cause: exc });
  }
}

/**
 * Parse a time option: a Date passes through validated, ISO 8601 text honors a trailing Z or an offset and none means UTC.
 *
 * @param value (unknown): a Date, ISO text, or null or undefined.
 * @param field (string): the parameter name, for the error.
 * @return (Date | null): the time, or null when absent.
 */
export function parseTime(value: string, field: string): Date;
export function parseTime(value: unknown, field: string): Date | null;
export function parseTime(value: unknown, field: string): Date | null {
  if (typeof value !== "string") {
    requireDatetime(field, value);
    return (value as Date | undefined) ?? null;
  }
  try {
    return parseIso(value);
  } catch {
    throw new ValidationError(
      `invalid ${field}: ${pyRepr(value)} is not an ISO 8601 date or time (e.g. 2024-01-02T03:04:05Z)`,
    );
  }
}

/**
 * Validate a value is a list of strings with no control or surrogate characters.
 *
 * @param name (string): the field name for the error message.
 * @param value (unknown): the value.
 */
export function requireList(name: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be a list of strings, got ${typeName(value)}`);
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError(`${name} must be a list of strings, got a ${typeName(item)} element`);
    }
    if (hasControl(item)) throw new ValidationError(`${name} elements cannot contain control or surrogate characters`);
  }
}

/**
 * Validate a value is a plain object with clean keys and values.
 *
 * @param name (string): the field name for the error message.
 * @param value (unknown): the value.
 * @param safeInts (boolean): reject a bigint outside +/-(2^53 - 1).
 */
function requireMapping(name: string, value: unknown, safeInts = true): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValidationError(`${name} must be a mapping, got ${typeName(value)}`);
  requireCleanJson(name, value, 0, safeInts);
}

/**
 * Validate an optional mapping has string keys and JSON-serializable values, before any write.
 *
 * @param name (string): the field name for the error message.
 * @param value (unknown): the value, or null.
 * @param safeInts (boolean): reject a bigint outside +/-(2^53 - 1); stored values must round-trip through JSON.
 */
export function requireJsonMapping(name: string, value: unknown, safeInts = true): void {
  if (value === null || value === undefined) return;
  requireMapping(name, value, safeInts);
  if (Object.keys(value).some((key) => !pyStrip(key))) {
    throw new ValidationError(`${name} keys cannot be empty or whitespace`);
  }
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
