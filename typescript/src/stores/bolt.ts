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

import { errorMessage, errorReason, StoreError, TransientError, ValidationError } from "../errors.js";
import { isPlainObject, pyRepr } from "../internal/py.js";
import type { CypherResult, JsonValue } from "../models.js";
import { type CounterName, graphProperties, WRITE_COUNTER_NAMES } from "./cypherPrimitives.js";

const COUNTER_NAMES: ReadonlyArray<readonly [CounterName, string]> = [
  ...WRITE_COUNTER_NAMES,
  ["labelsAdded", "labels_added"],
  ["labelsRemoved", "labels_removed"],
];

export type BoltAuth = string | readonly [string, string] | AuthToken | null | undefined;

const BOLT_CONNECT_TIMEOUT_MS = 10_000;
const AUTH_MARKERS = ["security.unauthorized", "security.unauthenticated", "autherror", "authentication failure"];
const MISSING_DB_MARKERS = [
  "databasenotfound",
  "unknown graph database",
  "unknown database",
  "database does not exist",
  "graph not found",
];
const UNREACHABLE_MARKERS = [
  "serviceunavailable",
  "couldn't connect",
  "failed to establish",
  "connection refused",
  "connection acquisition timed out",
];
const SYNTAX_MARKERS = ["syntax", "parsing error", "parse error"];
const BOLT_SCHEMES = ["bolt", "bolt+s", "bolt+ssc", "neo4j", "neo4j+s", "neo4j+ssc"];
const DETAIL_CHARS = 120;

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
 * Classify a Bolt driver error as a login failure, a missing database, or an unreachable server.
 *
 * @param exc (unknown): the driver error.
 * @return ("auth" | "database" | "unreachable" | null): the failure, or null when the error is something else.
 */
export function boltFailure(exc: unknown): "auth" | "database" | "unreachable" | null {
  const name = exc instanceof Error ? exc.name : "";
  const lowered = `${errorCode(exc)} ${name} ${errorMessage(exc)}`.toLowerCase();
  if (AUTH_MARKERS.some((k) => lowered.includes(k))) return "auth";
  if (MISSING_DB_MARKERS.some((k) => lowered.includes(k))) return "database";
  if (UNREACHABLE_MARKERS.some((k) => lowered.includes(k))) return "unreachable";
  return null;
}

/**
 * Map a Bolt login failure, missing database, or unreachable server to a plain StoreError.
 *
 * @param exc (unknown): the driver error.
 * @param uri (string): the Bolt URI, for the message.
 * @param database (string | null): the database name, for the message.
 * @return (StoreError | null): the error to throw, or null when the error is something else.
 */
export function boltError(exc: unknown, uri: string, database: string | null): StoreError | null {
  const failure = boltFailure(exc);
  if (failure === "auth") {
    return new StoreError(`authentication failed for ${uri}: check the token/password`, { cause: exc });
  }
  if (failure === "database") {
    return new StoreError(database ? `database ${pyRepr(database)} not found` : "database not found", { cause: exc });
  }
  if (failure === "unreachable") {
    return new StoreError(`could not connect to ${uri}: ${errorReason(exc)}`, { cause: exc });
  }
  return null;
}

/**
 * The first line of a syntax error's message, cut to a readable length, without the engine's expected-token list.
 *
 * @param exc (unknown): the driver error.
 * @return (string | null): the trimmed message, or null when the error is not a syntax error.
 */
export function syntaxDetail(exc: unknown): string | null {
  const message = errorMessage(exc);
  const lowered = `${errorCode(exc)} ${message}`.toLowerCase();
  if (!SYNTAX_MARKERS.some((k) => lowered.includes(k))) return null;
  const head = message.trim().split(/\r?\n/)[0] ?? "";
  return head.length <= DETAIL_CHARS ? head : `${head.slice(0, DETAIL_CHARS - 3)}...`;
}

/**
 * Map a Bolt query error to a connection StoreError, a TransientError for a retryable race, or a StoreError.
 *
 * @param exc (unknown): the driver error.
 * @param uri (string): the Bolt URI, for connection errors.
 * @param database (string | null): the database name, for a missing-database error.
 * @param engine (string): the engine name for the message.
 * @param transient ((lowered: string) => boolean): whether the lowercased error code and message is a retryable race.
 * @return (StoreError): the library error.
 */
export function queryError(
  exc: unknown,
  uri: string,
  database: string | null,
  engine: string,
  transient: (lowered: string) => boolean,
): StoreError {
  const connection = boltError(exc, uri, database);
  if (connection !== null) return connection;
  const message = errorMessage(exc);
  if (transient(`${errorCode(exc)} ${message}`.toLowerCase())) {
    return new TransientError(`${engine} transaction conflict: ${message}`, { cause: exc });
  }
  return new StoreError(`${engine} query failed: ${syntaxDetail(exc) ?? message}`, { cause: exc });
}

/**
 * Split "user:password" auth; a bare token is the password for defaultUser, and a pair passes through.
 *
 * @param auth (unknown): the auth setting: a string, a [user, password] pair, or null.
 * @param defaultUser (string): the user for a bare token.
 * @return ([string, string] | null): the user and password, or null without auth.
 */
export function parseAuth(auth: unknown, defaultUser = "neo4j"): [string, string] | null {
  if (auth == null || auth === "") return null;
  if (Array.isArray(auth) && auth.length === 2 && auth.every((part) => typeof part === "string")) {
    return [auth[0], auth[1]];
  }
  if (typeof auth !== "string") {
    throw new ValidationError("auth must be 'user:password', a bare token, or a [user, password] pair");
  }
  const i = auth.indexOf(":");
  return i < 0 ? [defaultUser, auth] : [auth.slice(0, i), auth.slice(i + 1)];
}

/**
 * Open a Bolt driver with bounded connect timeouts, turning a malformed URI or driver config into a StoreError.
 *
 * @param uri (string): the Bolt URI.
 * @param auth (BoltAuth): "user:password", a bare token (user neo4j), a [user, password] pair, a driver token, or null.
 * @param config (Config): extra driver config; connectionTimeout and connectionAcquisitionTimeout default to 10 s.
 * @return (Driver): the driver.
 */
export function openDriver(uri: string, auth: BoltAuth, config: Config): Driver {
  const scheme = uri.includes("://") ? uri.slice(0, uri.indexOf("://")).toLowerCase() : null;
  if (scheme !== null && !BOLT_SCHEMES.includes(scheme)) {
    throw new StoreError(`${pyRepr(uri)} is not a Bolt URI; use bolt://host:port`);
  }
  const pair = isPlainObject(auth) && typeof auth.scheme === "string" ? null : parseAuth(auth);
  const token = pair === null ? (auth as AuthToken | undefined) || undefined : neo4j.auth.basic(pair[0], pair[1]);
  try {
    return neo4j.driver(uri, token, {
      connectionTimeout: BOLT_CONNECT_TIMEOUT_MS,
      connectionAcquisitionTimeout: BOLT_CONNECT_TIMEOUT_MS,
      ...config,
    });
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
  if (isNode(value) || isRelationship(value)) return fromBolt(graphProperties(value.properties));
  if (isPath(value)) {
    return {
      nodes: (value.segments.length ? [value.start, ...value.segments.map((s) => s.end)] : [value.start]).map(fromBolt),
      relationships: value.segments.map((s) => fromBolt(s.relationship)),
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
