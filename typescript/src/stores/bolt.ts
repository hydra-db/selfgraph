import neo4j, {
  type AuthToken,
  type Config,
  type Driver,
  isDate,
  isDateTime,
  isDuration,
  isInt,
  isLocalDateTime,
  isLocalTime,
  isNode,
  isPath,
  isPoint,
  isRelationship,
  isTime,
  type QueryResult,
  type Result,
} from "neo4j-driver";

import { errorMessage, StoreError } from "../errors.js";
import { isPlainObject, pyRepr } from "../internal/py.js";
import type { CypherResult, JsonValue } from "../models.js";
import { type CounterName, WRITE_COUNTER_NAMES } from "./cypherPrimitives.js";

const COUNTER_NAMES: ReadonlyArray<readonly [CounterName, string]> = [
  ...WRITE_COUNTER_NAMES,
  ["labelsAdded", "labels_added"],
  ["labelsRemoved", "labels_removed"],
];

export type BoltAuth = [string, string] | AuthToken | null | undefined;

export interface BoltStoreOptions extends Config {
  auth?: BoltAuth;
  database?: string | null;
}

/**
 * The code of a thrown value, or "" when it has none.
 *
 * @param exc (unknown): the thrown value.
 * @return (string): the error code.
 */
export function errorCode(exc: unknown): string {
  return typeof exc === "object" && exc !== null && "code" in exc ? String(exc.code ?? "") : "";
}

/**
 * Open a Bolt driver, turning a malformed URI or driver config into a StoreError.
 *
 * @param uri (string): the Bolt URI.
 * @param auth (BoltAuth): a (user, password) pair or a driver token.
 * @param config (Config): extra driver config.
 * @return (Driver): the driver.
 */
export function openDriver(uri: string, auth: BoltAuth, config: Config): Driver {
  const token = !auth ? undefined : Array.isArray(auth) ? neo4j.auth.basic(auth[0], auth[1]) : auth;
  try {
    return neo4j.driver(uri, token, config);
  } catch (exc) {
    throw new StoreError(`cannot open a Bolt driver for ${pyRepr(uri)}: ${errorMessage(exc)}`, { cause: exc });
  }
}

/**
 * Convert JS parameters to Bolt values, sending integral numbers as Bolt integers so the driver does not coerce them to floats.
 *
 * @param value (unknown): the parameter value.
 * @return (unknown): the Bolt-ready value.
 */
function toBolt(value: unknown): unknown {
  if (typeof value === "number") return Number.isSafeInteger(value) ? neo4j.int(value) : value;
  if (typeof value === "bigint") return neo4j.int(value.toString());
  if (Array.isArray(value)) return value.map(toBolt);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toBolt(v);
    return out;
  }
  return value;
}

export const toBoltParams = (params: Record<string, unknown> | null | undefined): Record<string, unknown> =>
  toBolt(params ?? {}) as Record<string, unknown>;

/**
 * Convert Bolt graph values to plain JSON, keeping out-of-range integers as bigint so 64-bit ids round-trip exactly.
 *
 * @param value (unknown): the driver value.
 * @return (unknown): the plain value.
 */
function fromBolt(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toBigInt();
  if (isNode(value) || isRelationship(value)) return fromBolt(value.properties);
  if (isPath(value)) {
    return {
      nodes: value.segments.length
        ? [value.start, ...value.segments.map((s) => s.end)].map((n) => fromBolt(n.properties))
        : [fromBolt(value.start.properties)],
      relationships: value.segments.map((s) => fromBolt(s.relationship.properties)),
    };
  }
  if (
    isDate(value) ||
    isDateTime(value) ||
    isLocalDateTime(value) ||
    isTime(value) ||
    isLocalTime(value) ||
    isDuration(value) ||
    isPoint(value)
  ) {
    return value.toString();
  }
  if (value instanceof Uint8Array || value instanceof Int8Array) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  if (Array.isArray(value)) return value.map(fromBolt);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fromBolt(v);
    return out;
  }
  return value;
}

/**
 * Drain a Bolt result into a CypherResult, with columns even when there are no rows, and the non-zero write counters.
 *
 * @param pending (Result): the lazy driver result.
 * @return (CypherResult): the rows and counters.
 */
export async function recordsToResult(pending: Result): Promise<CypherResult> {
  const columns = await pending.keys();
  const result: QueryResult = await pending;
  const rows = result.records.map((record) => {
    const row: Record<string, JsonValue> = {};
    for (const key of record.keys) row[String(key)] = fromBolt(record.get(key)) as JsonValue;
    return row;
  });
  const updates = result.summary.counters.updates();
  const counters: Record<string, number> = {};
  for (const [js, py] of COUNTER_NAMES) if (updates[js]) counters[py] = updates[js];
  return { columns, rows, counters };
}
