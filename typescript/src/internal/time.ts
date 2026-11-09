const MICROS = new WeakMap<Date, { time: number; micro: number }>();

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?)?(?:\s*(Z|z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?))?$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * The microsecond-of-second for a Date, preserving digits parsed from ISO text beyond milliseconds.
 *
 * @param d (Date): the date.
 * @return (number): the microseconds within the second, 0 to 999999.
 */
function microOf(d: Date): number {
  const rec = MICROS.get(d);
  if (rec && rec.time === d.getTime()) return rec.micro;
  return d.getUTCMilliseconds() * 1000;
}

/**
 * Microseconds since the Unix epoch, keeping sub-millisecond digits parsed from ISO text.
 *
 * @param d (Date): the date.
 * @return (number): the epoch microseconds.
 */
export function epochMicros(d: Date): number {
  return d.getTime() * 1000 + (microOf(d) % 1000);
}

function assertValid(d: Date): void {
  if (Number.isNaN(d.getTime())) throw new RangeError("invalid date");
}

function datePart(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function timePart(d: Date): string {
  const micro = microOf(d);
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return micro ? `${base}.${pad(micro, 6)}` : base;
}

/**
 * Format a date as UTC ISO 8601 with "+00:00", microseconds, and no fraction when zero.
 *
 * @param d (Date | null | undefined): the date, or null.
 * @return (string | null): the ISO text, or null.
 */
export function toIso(d: Date | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  assertValid(d);
  return `${datePart(d)}T${timePart(d)}+00:00`;
}

/**
 * Format a UTC date for display: a space separator and "+00:00".
 *
 * @param d (Date): the date.
 * @return (string): the text.
 */
export function pyStrDate(d: Date): string {
  assertValid(d);
  return `${datePart(d)} ${timePart(d)}+00:00`;
}

/**
 * Format a UTC date for JSON output: "T", microseconds when present, and "Z".
 *
 * @param d (Date): the date.
 * @return (string): the text.
 */
export function jsonIso(d: Date): string {
  assertValid(d);
  return `${datePart(d)}T${timePart(d)}Z`;
}

/**
 * Parse the ISO 8601 forms SelfGraph reads and writes; offset-less text is UTC.
 *
 * @param text (string): the ISO text.
 * @return (Date): the date, keeping microseconds beyond milliseconds for exact re-encoding.
 */
export function parseIso(text: string): Date {
  const m = ISO_RE.exec(text);
  if (!m) throw new RangeError(`Invalid ISO 8601 string: ${JSON.stringify(text)}`);
  const [, ys, mos, ds, hs, mis, ss, frac, tz] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = hs ? Number(hs) : 0;
  const minute = mis ? Number(mis) : 0;
  const second = ss ? Number(ss) : 0;
  const micro = frac ? Number(frac.slice(0, 6).padEnd(6, "0")) : 0;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`Invalid ISO 8601 string: ${JSON.stringify(text)}`);
  }
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, Math.floor(micro / 1000));
  if (d.getUTCDate() !== day) throw new RangeError(`day is out of range for month: ${JSON.stringify(text)}`);
  let offsetSeconds = 0;
  if (tz && tz !== "Z" && tz !== "z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(/:/g, "");
    offsetSeconds =
      sign *
      (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || 0) * 60 + Number(digits.slice(4, 6) || 0));
  }
  const out = new Date(d.getTime() - offsetSeconds * 1000);
  MICROS.set(out, { time: out.getTime(), micro });
  return out;
}

/**
 * Coerce a stored time: null stays null, dates pass through, text is parsed.
 *
 * @param value (unknown): the stored value.
 * @return (Date | null): the date, or null.
 */
export function fromIso(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") return parseIso(value);
  throw new TypeError(`fromIso: argument must be a string, not ${typeof value}`);
}

/**
 * Wait for a number of milliseconds.
 *
 * @param ms (number): the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
