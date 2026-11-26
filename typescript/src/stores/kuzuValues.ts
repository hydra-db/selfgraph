import { StoreError } from "../errors.js";
import { jsonIso } from "../internal/time.js";

const UNREADABLE_DECIMAL = "Kuzu cannot return a negative DECIMAL between -0.1 and 0";
const DECIMAL_SCALE = /^DECIMAL\(\d+, (\d+)\)$/;
const DECIMAL_UNSCALED_LIMIT = 1e15;
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
const EXACT = new Set([
  "BOOL",
  "STRING",
  "JSON",
  "UUID",
  "INT8",
  "INT16",
  "INT32",
  "UINT8",
  "UINT16",
  "UINT32",
  "FLOAT",
  "DOUBLE",
]);
const INTEGERS = new Set(["INT64", "UINT64", "SERIAL"]);
const TIMESTAMPS = new Set(["TIMESTAMP", "TIMESTAMP_TZ", "TIMESTAMP_NS", "TIMESTAMP_MS", "TIMESTAMP_SEC"]);
const GRAPH = new Set(["NODE", "REL", "RECURSIVE_REL"]);
const OBJECTS = new Set(["STRUCT", "MAP", "UNION", "BLOB", "INTERNAL_ID", ...GRAPH]);

type Tables = Map<string, Map<string, string>>;
type Context = { column: string; tables: Tables };
type RunRows = (statement: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Render bytes as lowercase hex.
 *
 * @param value (Uint8Array): the bytes.
 * @return (string): the hex text.
 */
function hex(value: Uint8Array): string {
  return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Keep a bigint a number inside the safe range and render it as a string beyond it, as toJsonable does.
 *
 * @param value (bigint): the integer.
 * @return (number | string): the number, or its decimal text.
 */
function wide(value: bigint): number | string {
  return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
}

/**
 * Name the base of a Kuzu type, such as DECIMAL for DECIMAL(5, 2).
 *
 * @param type (string): the column type.
 * @return (string): the upper-case base name.
 */
function baseOf(type: string): string {
  return (type.split("(", 1)[0] as string).toUpperCase();
}

/**
 * Convert a value its column type does not describe, such as an internal id or a property of an unknown table.
 *
 * @param value (unknown): the driver value.
 * @return (unknown): the JSON-ready value.
 */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Uint8Array) return hex(value);
  if (value instanceof Date) return jsonIso(value);
  if (typeof value === "bigint") return wide(value);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

/**
 * Format an interval as an ISO 8601 duration of days and a clock, with months counted as 30 days.
 *
 * @param ms (number): the interval in milliseconds, which is all the driver returns.
 * @return (string): the duration, such as P1DT2H3M4.5S, or PT0S when it is empty.
 */
function duration(ms: number): string {
  if (ms < 0) return `-${duration(-ms)}`;
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  const fraction = ms % MS_PER_SECOND;
  const second = fraction ? `${seconds}.${String(fraction).padStart(3, "0")}`.replace(/0+$/, "") : `${seconds}`;
  const clock = (hours ? `${hours}H` : "") + (minutes ? `${minutes}M` : "") + (seconds || fraction ? `${second}S` : "");
  const text = `P${days ? `${days}D` : ""}${clock ? `T${clock}` : ""}`;
  return text === "P" ? "PT0S" : text;
}

/**
 * Build the error for a value the driver rounded or a type the SDK cannot read.
 *
 * @param ctx (Context): the result column and table types.
 * @param type (string): the type at fault.
 * @param reason (string): why the value cannot be returned exactly.
 * @return (StoreError): the error to throw.
 */
function inexact(ctx: Context, type: string, reason: string): StoreError {
  return new StoreError(`run_cypher column '${ctx.column}' (${type}) ${reason}`, { code: "inexact_value" });
}

/**
 * Build the error for a negative DECIMAL Kuzu cannot return.
 *
 * @return (StoreError): the error to throw.
 */
function unreadableDecimal(): StoreError {
  return new StoreError(UNREADABLE_DECIMAL, { code: "inexact_value" });
}

/**
 * Check that a DECIMAL the driver turned into a double still holds every digit of the stored value.
 *
 * @param value (number): the driver's double.
 * @param type (string): the column type, such as DECIMAL(18, 2).
 * @param ctx (Context): the result column and table types.
 * @return (number): the same number when its unscaled digits fit a double; throws otherwise.
 */
function exactDecimal(value: number, type: string, ctx: Context): number {
  if (Number.isNaN(value)) throw unreadableDecimal();
  const scale = Number(DECIMAL_SCALE.exec(type)![1]);
  const fits = scale ? Math.abs(Math.round(value * 10 ** scale)) < DECIMAL_UNSCALED_LIMIT : Number.isSafeInteger(value);
  if (!fits) throw inexact(ctx, type, "holds a value wider than a double holds, which the Kuzu Node driver rounds");
  return value;
}

/**
 * Split a type's parameter list at its top-level commas.
 *
 * @param text (string): the text between the type's parentheses.
 * @return (string[]): one entry per parameter.
 */
function splitTypes(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (depth === 0 && text.startsWith(", ", i)) {
      parts.push(text.slice(start, i));
      start = i + 2;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Name the JS shape the driver gives a value of a column type.
 *
 * @param type (string): the column type.
 * @return (string): the shape, as shapeOf names it.
 */
function shapeOfType(type: string): string {
  const base = baseOf(type);
  if (type.endsWith("]") || OBJECTS.has(base)) return "object";
  if (base === "BOOL") return "boolean";
  if (base === "STRING" || base === "JSON" || base === "UUID") return "string";
  if (base === "INT128") return "bigint";
  return base === "DATE" || TIMESTAMPS.has(base) ? "date" : "number";
}

/**
 * Name the JS shape of a driver value.
 *
 * @param value (unknown): the driver value.
 * @return (string): date, or the typeof name.
 */
function shapeOf(value: unknown): string {
  return value instanceof Date ? "date" : typeof value;
}

/**
 * Pair each field of a STRUCT type with its type text, locating every name from the value's keys since a name may
 * hold commas or parentheses.
 *
 * @param type (string): the STRUCT type.
 * @param names (string[]): the field names, from the driver object.
 * @param ctx (Context): the result column and table types.
 * @return (Array<[string, string]>): each field name with its type.
 */
function structFields(type: string, names: string[], ctx: Context): Array<[string, string]> {
  const inner = type.slice("STRUCT(".length, -1);
  const remaining = new Set(names);
  const fields: Array<[string, string]> = [];
  let pos = 0;
  while (pos < inner.length) {
    const name = [...remaining].filter((n) => inner.startsWith(`${n} `, pos)).sort((a, b) => b.length - a.length)[0];
    if (name === undefined) throw inexact(ctx, type, "has a field the SDK cannot match to its type");
    remaining.delete(name);
    const start = pos + name.length + 1;
    let end = start;
    let depth = 0;
    for (; end < inner.length; end++) {
      if (inner[end] === "(") depth++;
      else if (inner[end] === ")") depth--;
      else if (
        depth === 0 &&
        inner.startsWith(", ", end) &&
        [...remaining].some((n) => inner.startsWith(`${n} `, end + 2))
      )
        break;
    }
    fields.push([name, inner.slice(start, end)]);
    pos = end + 2;
  }
  return fields;
}

/**
 * Convert a UNION value, which the driver wraps in a one-key object, to the value of the member it holds.
 *
 * @param value (unknown): the driver object.
 * @param type (string): the UNION type.
 * @param ctx (Context): the result column and table types.
 * @return (unknown): the converted member value.
 */
function convertUnion(value: unknown, type: string, ctx: Context): unknown {
  const inside = (value as { tag: unknown }).tag;
  if (inside === null) return null;
  const members = splitTypes(type.slice("UNION(".length, -1))
    .map((part) => part.slice(part.indexOf(" ") + 1))
    .filter((candidate) => shapeOfType(candidate) === shapeOf(inside));
  if (members.length !== 1) throw inexact(ctx, type, "has a member the SDK cannot tell from its value");
  return convert(inside, members[0] as string, ctx);
}

/**
 * Convert a node, a relationship, or a path, reading each property with the type its table declares.
 *
 * @param value (unknown): the driver value.
 * @param ctx (Context): the result column and table types.
 * @return (unknown): the JSON-ready value.
 */
function convertGraph(value: unknown, ctx: Context): unknown {
  if (Array.isArray(value)) return value.map((item) => convertGraph(item, ctx));
  const entity = value as Record<string, unknown>;
  if (entity._nodes !== undefined) {
    return { _nodes: convertGraph(entity._nodes, ctx), _rels: convertGraph(entity._rels, ctx) };
  }
  const columns = ctx.tables.get(entity._label as string);
  return Object.fromEntries(
    Object.entries(entity).map(([k, v]) => [k, columns?.has(k) ? convert(v, columns.get(k) as string, ctx) : plain(v)]),
  );
}

/**
 * Convert one driver value to the JSON-ready value of its column type, throwing when the driver already rounded it.
 *
 * @param value (unknown): the driver value.
 * @param type (string): its Kuzu type, as getColumnDataTypes prints it.
 * @param ctx (Context): the result column and table types.
 * @return (unknown): the JSON-ready value.
 */
function convert(value: unknown, type: string, ctx: Context): unknown {
  if (value === null || value === undefined) return null;
  if (type.endsWith("]")) {
    const element = type.slice(0, type.lastIndexOf("["));
    return (value as unknown[]).map((item) => convert(item, element, ctx));
  }
  const base = baseOf(type);
  if (base === "MAP") {
    const [keyType, valueType] = splitTypes(type.slice("MAP(".length, -1)) as [string, string];
    const entries = Object.entries(value as Record<string, unknown>);
    if (baseOf(keyType) === "DECIMAL" && entries.some(([k]) => Number.isNaN(Number(k)))) throw unreadableDecimal();
    return Object.fromEntries(entries.map(([k, v]) => [k, convert(v, valueType, ctx)]));
  }
  if (base === "STRUCT") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      structFields(type, Object.keys(object), ctx).map(([name, fieldType]) => [
        name,
        convert(object[name], fieldType, ctx),
      ]),
    );
  }
  if (base === "UNION") return convertUnion(value, type, ctx);
  if (base === "INT128") return wide(value as bigint);
  if (base === "DECIMAL") return exactDecimal(value as number, type, ctx);
  if (base === "DATE") return jsonIso(value as Date).slice(0, 10);
  if (base === "INTERVAL") return duration(value as number);
  if (base === "BLOB") return hex(value as Uint8Array);
  if (TIMESTAMPS.has(base)) return jsonIso(value as Date);
  if (base === "INTERNAL_ID") return plain(value);
  if (GRAPH.has(base)) return convertGraph(value, ctx);
  if (INTEGERS.has(base)) {
    if (!Number.isSafeInteger(value)) {
      throw inexact(ctx, type, "holds a value beyond 2^53, which the Kuzu Node driver rounds");
    }
    return value;
  }
  if (EXACT.has(base)) return value;
  throw inexact(ctx, type, "has a type the SDK cannot read");
}

/**
 * Collect the table labels of the nodes and relationships inside a driver value.
 *
 * @param value (unknown): the driver value.
 * @param labels (Set<string>): the set to add to.
 * @return (void): nothing.
 */
function collectLabels(value: unknown, labels: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  const label = (value as { _label?: unknown })._label;
  if (typeof label === "string") labels.add(label);
  for (const item of Object.values(value)) collectLabels(item, labels);
}

/**
 * Read the property types of every table whose nodes or relationships a result holds.
 *
 * @param rows (Array<Record<string, unknown>>): the driver rows.
 * @param columns (string[]): the column names.
 * @param types (string[]): the column types.
 * @param run ((statement: string) => Promise<Array<Record<string, unknown>>>): runs one statement and returns its rows.
 * @return (Promise<Tables>): the property types by table label.
 */
export async function readTables(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  types: string[],
  run: RunRows,
): Promise<Tables> {
  const labels = new Set<string>();
  for (const row of rows) {
    columns.forEach((name, i) => {
      if (/NODE|REL/.test(types[i] as string)) collectLabels(row[name], labels);
    });
  }
  const tables: Tables = new Map();
  for (const label of labels) {
    if (/['\\]/.test(label)) {
      throw new StoreError(`run_cypher result holds a table name the SDK cannot look up: ${label}`, {
        code: "inexact_value",
      });
    }
    const properties = await run(`CALL table_info('${label}') RETURN name, type`);
    tables.set(label, new Map(properties.map((p) => [p.name as string, p.type as string])));
  }
  return tables;
}

/**
 * Convert a result row to JSON-ready values, driven by the column types.
 *
 * @param row (Record<string, unknown>): the driver row.
 * @param columns (string[]): the column names.
 * @param types (string[]): the column types, from getColumnDataTypes.
 * @param tables (Tables): the property types of the tables the result holds, from readTables.
 * @return (Record<string, unknown>): the row with every value converted.
 */
export function normalizeRow(
  row: Record<string, unknown>,
  columns: string[],
  types: string[],
  tables: Tables,
): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((name, i) => [name, convert(row[name], types[i] as string, { column: name, tables })]),
  );
}
