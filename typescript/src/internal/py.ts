import { epochMicros, pyStrDate } from "./time.js";

export const PY_WS_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export const PY_WORD_CLASS = "\\p{L}\\p{N}_";

export const NON_ASCII = /[\u0080-\uffff]/;

const WS_RUN = new RegExp(`[${PY_WS_CLASS}]+`, "gu");
const WS_LEAD = new RegExp(`^[${PY_WS_CLASS}]+`, "u");
const WS_TRAIL = new RegExp(`[${PY_WS_CLASS}]+$`, "u");
const NON_PRINTABLE = /[\p{C}\p{Z}]/u;

/**
 * Drop leading and trailing whitespace, or the given characters.
 *
 * @param s (string): the text to strip.
 * @param chars (string): characters to strip instead of whitespace.
 * @return (string): the stripped text.
 */
export function pyStrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(WS_LEAD, "").replace(WS_TRAIL, "");
  const set = new Set(Array.from(chars));
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (start < end && set.has(cps[start]!)) start++;
  while (end > start && set.has(cps[end - 1]!)) end--;
  return cps.slice(start, end).join("");
}

/**
 * Split on whitespace runs and drop empty pieces.
 *
 * @param s (string): the text to split.
 * @return (string[]): the non-empty pieces.
 */
export function pySplit(s: string): string[] {
  return s.split(WS_RUN).filter((part) => part.length > 0);
}

/**
 * Replace every whitespace run (Unicode whitespace plus \x1c-\x1f) with a replacement string.
 *
 * @param s (string): the text.
 * @param replacement (string): the replacement for each whitespace run.
 * @return (string): the rewritten text.
 */
export function pyCollapseWs(s: string, replacement: string): string {
  return s.replace(WS_RUN, replacement);
}

/**
 * Count code points, not UTF-16 units.
 *
 * @param s (string): the text to measure.
 * @return (number): the code point count.
 */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Compare two strings by code point rather than by UTF-16 unit.
 *
 * @param a (string): the first string.
 * @param b (string): the second string.
 * @return (number): a negative, zero, or positive number.
 */
export function comparePy(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

const ENCODER = new TextEncoder();

/**
 * Encode text as UTF-8 bytes.
 *
 * @param s (string): the text to encode.
 * @return (Uint8Array): the UTF-8 bytes.
 */
export function utf8(s: string): Uint8Array {
  return ENCODER.encode(s);
}

/**
 * Render a float with the shortest round-trip digits: fixed notation for exponents in [-4, 16), "1e+16" style otherwise, and always a fractional part or exponent.
 *
 * @param x (number): the number to render.
 * @return (string): the float text.
 */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, expPart] = x.toExponential().split("e") as [string, string];
  const exp = Number(expPart);
  const neg = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = neg ? "-" : "";
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (exp >= 0) {
    if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
    return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  }
  return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
}

/**
 * Render a number: safe integers without a fraction, everything else in float form.
 *
 * @param x (number): the number to render.
 * @return (string): the number text.
 */
function pyNumber(x: number): string {
  if (Number.isSafeInteger(x) && !Object.is(x, -0)) return String(x);
  return pyFloatRepr(x);
}

function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      if (cp < 0x100) out += `\\x${cp.toString(16).padStart(2, "0")}`;
      else if (cp < 0x10000) out += `\\u${cp.toString(16).padStart(4, "0")}`;
      else out += `\\U${cp.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

/**
 * Debug-render a JSON-like value: single-quoted strings, True/False/None, and bracketed lists and maps.
 *
 * @param value (unknown): the value to render.
 * @return (string): the rendered text.
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return reprString(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return pyNumber(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return `datetime(${pyStrDate(value)})`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

/**
 * Display-render a value: strings and dates as-is, everything else as pyRepr.
 *
 * @param value (unknown): the value to render.
 * @return (string): the rendered text.
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return pyStrDate(value);
  return pyRepr(value);
}

export interface PyDumpsOptions {
  sortKeys?: boolean;
  indent?: number | null;
  ensureAscii?: boolean;
  default?: (value: unknown) => unknown;
}

const NAMED_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function jsonString(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    const named = NAMED_ESCAPES[ch];
    if (named !== undefined) out += named;
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * Serialize to the canonical JSON SelfGraph stores and prints: ", "/": " separators, \uXXXX non-ASCII by default, optional code-point key sorting, no NaN or Infinity, pyNumber floats.
 *
 * @param value (unknown): the value to encode.
 * @param options (PyDumpsOptions): key sorting, indent, ASCII escaping, and a fallback encoder.
 * @return (string): the JSON text.
 */
export function pyJsonDumps(value: unknown, options: PyDumpsOptions = {}): string {
  const { sortKeys = false, indent = null, ensureAscii = true } = options;

  const enc = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "string") return jsonString(v, ensureAscii);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new TypeError(`Out of range float values are not JSON compliant: ${v}`);
      return pyNumber(v);
    }
    if (typeof v === "bigint") return v.toString();
    const nl = indent === null ? "" : `\n${" ".repeat(indent * (level + 1))}`;
    const close = indent === null ? "" : `\n${" ".repeat(indent * level)}`;
    const sep = indent === null ? ", " : ",";
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[${nl}${v.map((x) => enc(x, level + 1)).join(sep + nl)}${close}]`;
    }
    if (isPlainObject(v)) {
      let entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return "{}";
      if (sortKeys) entries = entries.sort(([a], [b]) => comparePy(a, b));
      const body = entries.map(([k, x]) => `${jsonString(k, ensureAscii)}: ${enc(x, level + 1)}`);
      return `{${nl}${body.join(sep + nl)}${close}}`;
    }
    if (options.default) return enc(options.default(v), level);
    const type = typeof v === "object" ? (v.constructor?.name ?? typeof v) : typeof v;
    throw new TypeError(`Object of type ${type} is not JSON serializable`);
  };

  return enc(value, 0);
}

/**
 * Report whether a value is a plain object literal.
 *
 * @param v (unknown): the value to test.
 * @return (v is Record<string, unknown>): true for plain objects.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality for JSON-like values: maps, arrays, dates, and scalars.
 *
 * @param a (unknown): the first value.
 * @param b (unknown): the second value.
 * @return (boolean): true when equal.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && epochMicros(a) === epochMicros(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
