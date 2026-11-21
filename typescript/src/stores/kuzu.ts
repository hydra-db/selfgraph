import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage, SelfGraphError, StoreError, ValidationError } from "../errors.js";
import { Lazy } from "../internal/lazy.js";
import { loadOptional } from "../internal/optional.js";
import { pyJsonDumps, pyRepr, pyStr } from "../internal/py.js";
import type { CypherResult, JsonValue } from "../models.js";
import {
  DEFAULT_MATCH_LIMIT,
  type EdgeRow,
  type EdgeWrite,
  type GraphStore,
  type MatchEdgesOptions,
  type MatchNodesOptions,
  type NodeRow,
  type Props,
  type UpsertNodeOptions,
} from "../protocols.js";
import { checkOptions, keysOf } from "../validate.js";
import {
  AutoCommitStore,
  quoteLabel,
  requireIdentifier,
  requireKeys,
  sortedEntries,
  toCount,
  whereAfter,
  writeBatches,
} from "./cypherPrimitives.js";
import { docs, edgeRow, firstDoc, mergedCurrentEdge } from "./docRows.js";

const SCHEMA = [
  "CREATE NODE TABLE IF NOT EXISTS N(pk STRING, id STRING, ns STRING, label STRING, doc STRING, PRIMARY KEY(pk))",
  "CREATE REL TABLE IF NOT EXISTS R(FROM N TO N, sid STRING, ns STRING, etype STRING, " +
    "is_current BOOLEAN, revision INT64, doc STRING)",
];

interface KuzuQueryResult {
  getAll(): Promise<Array<Record<string, unknown>>>;
  getColumnNames(): Promise<string[]> | string[];
  close?(): void;
}

interface KuzuPreparedStatement {
  isSuccess(): boolean;
}

interface KuzuConnection {
  init(): Promise<void>;
  query(statement: string): Promise<KuzuQueryResult | KuzuQueryResult[]>;
  prepare(statement: string): Promise<KuzuPreparedStatement>;
  execute(
    prepared: KuzuPreparedStatement,
    params: Record<string, unknown>,
  ): Promise<KuzuQueryResult | KuzuQueryResult[]>;
  close?(): Promise<void> | void;
}

export interface KuzuStoreOptions {
  /** Buffer pool size in bytes; 0 lets Kuzu pick. */
  buffer_pool_size?: number;
  /** Largest size the database may grow to in bytes; set it to open many databases at once, since each reserves this much virtual memory (8 TB by default). */
  max_db_size?: number;
  compression?: boolean;
  read_only?: boolean;
}

const OPTION_KEYS = keysOf<KuzuStoreOptions>({
  buffer_pool_size: true,
  max_db_size: true,
  compression: true,
  read_only: true,
});

interface KuzuDatabase {
  close?(): Promise<void> | void;
}

interface KuzuModule {
  Database: new (
    path: string,
    bufferManagerSize?: number,
    enableCompression?: boolean,
    readOnly?: boolean,
    maxDBSize?: number,
    autoCheckpoint?: boolean,
    checkpointThreshold?: number,
  ) => KuzuDatabase;
  Connection: new (db: KuzuDatabase) => KuzuConnection;
}

interface KuzuDatabaseOptions {
  buffer_pool_size: number;
  compression: boolean;
  read_only: boolean;
  max_db_size: number;
}

const DATABASES = new Map<string | symbol, KuzuDatabase>();
const DATABASE_OPTIONS = new Map<string | symbol, KuzuDatabaseOptions>();
const OPEN_STORES = new Map<string | symbol, number>();
const WRITE_QUEUES = new Map<string | symbol, object>();
const PATH_QUEUES = new Map<string | symbol, Promise<unknown>>();
const MAX_SKIP = 10_000_000;
const RECONNECT_EVERY = 500;
const DEFAULT_CHECKPOINT_THRESHOLD = 16 * 1024 ** 2;
const CHECKPOINT_POOL_DIVISOR = 1024;
const MAX_DB_SIZE_DEFAULT = 8_796_093_022_208;
const NOW = "RETURN current_timestamp() AS now";
const CLOCK_TICK_MS = 20;

/**
 * Find the first empty list or map in a parameter value, depth first.
 *
 * @param value (unknown): the parameter value or a nested value.
 * @param path (string): where the value sits in the parameter.
 * @return ([string, string] | null): the kind, "list" or "map", and its path, or null when every container has a value.
 */
function emptyContainer(value: unknown, path: string): [string, string] | null {
  if (Array.isArray(value)) {
    if (!value.length) return ["list", path];
    for (const [i, item] of value.entries()) {
      const found = emptyContainer(item, `${path}[${i}]`);
      if (found) return found;
    }
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return ["map", path];
    for (const [key, item] of entries) {
      const found = emptyContainer(item, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Reject empty lists and maps in Kuzu parameters, which it cannot give a type.
 *
 * @param params (Record<string, unknown> | null | undefined): the query parameters.
 */
function requireTypedParams(params: Record<string, unknown> | null | undefined): void {
  for (const [name, value] of Object.entries(params ?? {})) {
    const found = emptyContainer(value, name);
    if (found) {
      const [kind, path] = found;
      throw new ValidationError(
        `parameter ${pyRepr(path)} is an empty ${kind}, which Kuzu cannot type; pass a non-empty ${kind}`,
        { field: name },
      );
    }
  }
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Uint8Array) return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalize(v);
    return out;
  }
  return value;
}

/**
 * Resolve a file path against the current directory and keep Kuzu's in-memory paths.
 *
 * @param path (string): the path.
 * @return (string): the database path used to open and cache the store.
 */
function databasePath(path: string): string {
  if (path === "" || path === ":memory:") return path;
  return resolve(
    path === "~" || path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))
      ? join(homedir(), path.slice(1))
      : path,
  );
}

/**
 * Map a Kuzu error to a StoreError, adding what to do for the lock and mmap failures.
 *
 * @param exc (unknown): the Kuzu error.
 * @param prefix (string): what failed, for the message.
 * @return (StoreError): the error to throw.
 */
export function kuzuError(exc: unknown, prefix: string): StoreError {
  const detail = errorMessage(exc).split(/\s+/).join(" ").trim();
  if (detail.includes("Could not set lock on file")) {
    return new StoreError(
      `${prefix}: another process (an MCP server or script) has this Kuzu database open; Kuzu allows one process at a time`,
      { cause: exc, code: "store_locked" },
    );
  }
  let message = `${prefix}: ${detail}`;
  if (detail.includes("Buffer manager exception: Mmap for size")) {
    message += "; too many Kuzu databases open in this process or max_db_size too large; pass a smaller max_db_size";
  }
  return new StoreError(message, { cause: exc });
}

const pk = (ns: string, id: string): string => `${ns}\x00${id}`;
const jv = (value: unknown): string => pyJsonDumps(value, { ensureAscii: false, default: pyStr });

const BY_SID = "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid";
const UPSERT_NODES =
  "UNWIND $rows AS row WITH row, row.pk AS k MERGE (n:N {pk: k}) " +
  "SET n.id = row.id, n.ns = $ns, n.label = $label, n.doc = row.doc";
const EDGE_ROWS =
  "UNWIND $rows AS row WITH row, row.f AS f MATCH (a:N {pk: f}) WITH a, row, row.t AS t MATCH (b:N {pk: t}) " +
  "WHERE a.label = $fl AND b.label = $tl ";
const MERGE_EDGES =
  "MERGE (a)-[r:R {sid: row.sid, ns: $ns, revision: CAST(row.rev AS INT64)}]->(b) " +
  "SET r.etype = row.et, r.is_current = CAST(row.isc AS BOOL), r.doc = row.doc";
const CREATE_EDGES =
  "CREATE (a)-[r:R {sid: CAST(row.sid AS STRING), ns: $ns, etype: row.et, is_current: CAST(row.isc AS BOOL), " +
  "revision: CAST(row.rev AS INT64), doc: row.doc}]->(b)";
const BOTH_WAYS = ["(x:N {pk:$pk})-[r:R]->(o:N)", "(o:N)-[r:R]->(x:N {pk:$pk})"];

function intLiteral(n: number): number {
  if (!Number.isFinite(n)) throw new StoreError(`expected an integer, got ${n}`);
  return Math.trunc(n);
}

/**
 * Add one json_extract equality clause per filter entry, in sorted key order, binding the key and JSON value.
 *
 * @param alias (string): the node or relationship variable.
 * @param equals (Props | null | undefined): the property filter.
 * @param where (string[]): the clauses to extend.
 * @param params (Props): the parameters to extend.
 */
function whereDocEquals(alias: string, equals: Props | null | undefined, where: string[], params: Props): void {
  sortedEntries(equals).forEach(([key, value], i) => {
    where.push(`json_extract(${alias}.doc, $k${i}) = json($v${i})`);
    params[`k${i}`] = requireIdentifier(key);
    params[`v${i}`] = jv(value);
  });
}

/**
 * Add one membership clause per any_of entry, matching the id on the primary key and other keys inside the document.
 *
 * @param ns (string): the namespace the primary keys are scoped to.
 * @param anyOf (Record<string, readonly unknown[]> | null | undefined): property name to the accepted values.
 * @param where (string[]): the clauses to extend.
 * @param params (Props): the parameters to extend.
 */
function whereDocAnyOf(
  ns: string,
  anyOf: Record<string, readonly unknown[]> | null | undefined,
  where: string[],
  params: Props,
): void {
  sortedEntries(anyOf).forEach(([key, values], i) => {
    requireIdentifier(key);
    const list = values as unknown[];
    if (list.length === 0) {
      where.push("false");
    } else if (key === "id") {
      where.push(`n.pk IN $in${i}`);
      params[`in${i}`] = list.map((v) => pk(ns, v as string));
    } else {
      where.push(`CAST(json_extract(n.doc, $ik${i}) AS STRING) IN list_transform($in${i}, x -> json(x))`);
      params[`ik${i}`] = key;
      params[`in${i}`] = list.map(jv);
    }
  });
}

export class KuzuStore extends AutoCommitStore implements GraphStore {
  readonly queryLabels: readonly string[] = ["N", "R"];
  private readonly path: string;
  private readonly cacheKey: string | symbol;
  private readonly conn = new Lazy<KuzuConnection>(async () => {
    const mod = await loadOptional<KuzuModule & { default?: KuzuModule }>(
      "kuzu",
      "the 'kuzu' package is required for KuzuStore; npm install kuzu",
      StoreError,
    );
    const kuzu = mod.default ?? mod;
    const o = this.options;
    const options: KuzuDatabaseOptions = {
      buffer_pool_size: o.buffer_pool_size ?? 0,
      compression: o.compression ?? true,
      read_only: o.read_only ?? false,
      max_db_size: o.max_db_size ?? MAX_DB_SIZE_DEFAULT,
    };
    let db = DATABASES.get(this.cacheKey);
    if (db === undefined) {
      mkdirSync(dirname(this.path), { recursive: true });
      const checkpointThreshold =
        typeof this.cacheKey === "string" && options.buffer_pool_size > 0
          ? Math.min(
              DEFAULT_CHECKPOINT_THRESHOLD,
              Math.max(1, Math.floor(options.buffer_pool_size / CHECKPOINT_POOL_DIVISOR)),
            )
          : -1;
      try {
        db = new kuzu.Database(
          this.path,
          options.buffer_pool_size,
          options.compression,
          options.read_only,
          options.max_db_size,
          true,
          checkpointThreshold,
        );
      } catch (exc) {
        throw kuzuError(exc, `could not open Kuzu database ${pyRepr(this.path)}`);
      }
      DATABASES.set(this.cacheKey, db);
      DATABASE_OPTIONS.set(this.cacheKey, options);
    } else {
      const open = DATABASE_OPTIONS.get(this.cacheKey);
      const diffs = (Object.keys(options) as (keyof KuzuDatabaseOptions)[])
        .filter((k) => o[k] !== undefined && o[k] !== open?.[k])
        .sort()
        .map((k) => `${k} ${pyRepr(open?.[k])} vs ${pyRepr(o[k])}`)
        .join(", ");
      if (diffs) {
        throw new ValidationError(`KuzuStore(${pyRepr(this.path)}) is already open with different options: ${diffs}`);
      }
    }
    OPEN_STORES.set(this.cacheKey, (OPEN_STORES.get(this.cacheKey) ?? 0) + 1);
    this.connect = () => new kuzu.Connection(db);
    try {
      const conn = this.connect();
      await conn.init();
      return conn;
    } catch (exc) {
      await KuzuStore.releaseStore(this.cacheKey);
      throw exc;
    }
  });
  private connect!: () => KuzuConnection;
  private statements = 0;
  private raw = false;

  /**
   * Share one write queue with every store holding this cache key, since they share one database.
   *
   * @return (object): the key this store holds in the shared write-queue map, one per open database.
   */
  override writeQueueKey(): object {
    let key = WRITE_QUEUES.get(this.cacheKey);
    if (key === undefined) {
      key = {};
      WRITE_QUEUES.set(this.cacheKey, key);
    }
    return key;
  }

  /**
   * An embedded, in-process Kuzu graph over a generic single-table schema.
   *
   * @param path (string): the database directory or file.
   * @param options (KuzuStoreOptions): Kuzu database settings, applied when this process first opens the path;
   *     a second store on the path must not pass different values.
   */
  constructor(
    path = "selfgraph_kuzu",
    private readonly options: KuzuStoreOptions = {},
  ) {
    super();
    checkOptions("KuzuStore", options, OPTION_KEYS);
    const size = options.max_db_size;
    if (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1)) {
      throw new ValidationError(`max_db_size must be a positive integer of bytes, got ${pyRepr(size)}`);
    }
    this.path = databasePath(path);
    this.cacheKey = this.path === "" || this.path === ":memory:" ? Symbol() : this.path;
  }

  private async exec(query: string, params?: Record<string, unknown> | null, raw = false): Promise<CypherResult> {
    let conn = await this.conn.get();
    if (++this.statements > RECONNECT_EVERY && !this.closed) {
      this.statements = 1;
      if (!(this.raw && (await this.inTransaction(conn))) && !this.closed) {
        const stale = conn;
        conn = this.connect();
        this.conn.set(conn);
        this.raw = false;
        await stale.close?.();
      }
    }
    this.raw ||= raw;
    const res =
      params && Object.keys(params).length
        ? await conn.execute(await conn.prepare(query), params)
        : await conn.query(query);
    if (Array.isArray(res)) {
      for (const r of res) r.close?.();
      throw new StoreError("Kuzu runs one statement per query; pass one statement, not several joined by ';'");
    }
    try {
      const columns = await res.getColumnNames();
      const rows = (await res.getAll()).map((row) => normalize(row) as Record<string, JsonValue>);
      return { columns, rows, counters: {}, warnings: [] };
    } finally {
      res.close?.();
    }
  }

  /**
   * Report whether a raw statement left a transaction open, as two current_timestamp() reads a tick apart match.
   *
   * @param conn (KuzuConnection): the connection.
   * @return (boolean): true when a transaction is open.
   */
  private async inTransaction(conn: KuzuConnection): Promise<boolean> {
    const now = async () => {
      const res = (await conn.query(NOW)) as KuzuQueryResult;
      try {
        return JSON.stringify(await res.getAll());
      } finally {
        res.close?.();
      }
    };
    const first = await now();
    await new Promise((resolve) => setTimeout(resolve, CLOCK_TICK_MS));
    return (await now()) === first;
  }

  override async runCypher(query: string, params?: Record<string, JsonValue> | null): Promise<CypherResult> {
    requireTypedParams(params);
    return this._run(query, params, true);
  }

  /**
   * Run a body in the per-database statement queue shared by every store on the database.
   *
   * @param fn (() => Promise<T>): the body.
   * @return (Promise<T>): the body's result, once every statement ahead of it on the database has run.
   */
  private async onPath<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.cacheKey;
    const run = (PATH_QUEUES.get(key) ?? Promise.resolve()).then(fn);
    PATH_QUEUES.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  protected async _run(query: string, params?: Record<string, unknown> | null, raw = false): Promise<CypherResult> {
    this.requireOpen();
    try {
      return await this.onPath(() => this.exec(query, params, raw));
    } catch (exc) {
      if (exc instanceof SelfGraphError) throw exc;
      throw kuzuError(exc, "Kuzu query failed");
    }
  }

  /** Create the node and relationship tables if they do not exist. */
  async initialize(): Promise<void> {
    for (const stmt of SCHEMA) await this._run(stmt);
  }

  /**
   * Close the cached database for a path, after closing every store on the path, so another process can open it.
   *
   * @param path (string): the database path.
   */
  static async closeDatabase(path: string): Promise<void> {
    await KuzuStore.closeCachedDatabase(databasePath(path));
  }

  private static async closeCachedDatabase(key: string | symbol): Promise<void> {
    const db = DATABASES.get(key);
    DATABASES.delete(key);
    DATABASE_OPTIONS.delete(key);
    WRITE_QUEUES.delete(key);
    PATH_QUEUES.delete(key);
    await db?.close?.();
  }

  private static async releaseStore(key: string | symbol): Promise<void> {
    const open = (OPEN_STORES.get(key) ?? 1) - 1;
    if (open > 0) OPEN_STORES.set(key, open);
    else {
      OPEN_STORES.delete(key);
      await KuzuStore.closeCachedDatabase(key);
    }
  }

  /** Close the connection, and the database once no other store in this process holds it. */
  async close(): Promise<void> {
    this.closed = true;
    await this.conn.release(async (conn) => {
      await this.onPath(async () => {
        await conn.close?.();
      });
      await KuzuStore.releaseStore(this.cacheKey);
    });
  }

  async getNode(ns: string, label: string, id: string): Promise<Props | null> {
    const res = await this._run("MATCH (n:N {pk:$pk}) WHERE n.label = $label RETURN n.doc AS doc", {
      pk: pk(ns, id),
      label,
    });
    return firstDoc(res.rows);
  }

  async nodeExists(ns: string, label: string, id: string): Promise<boolean> {
    const res = await this._run("MATCH (n:N {pk:$pk}) WHERE n.label = $label RETURN n.pk AS pk", {
      pk: pk(ns, id),
      label,
    });
    return res.rows.length > 0;
  }

  async upsertNode(
    ns: string,
    label: string,
    id: string,
    props: Props,
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    if (options.extra_label != null) quoteLabel(options.extra_label);
    requireKeys(props);
    await this._run("MERGE (n:N {pk:$pk}) SET n.id = $id, n.ns = $ns, n.label = $label, n.doc = $doc", {
      pk: pk(ns, id),
      id,
      ns,
      label,
      doc: jv(props),
    });
  }

  /**
   * Merge many nodes by id, a batch per statement, since each Kuzu statement commits on its own.
   *
   * @param ns (string): namespace.
   * @param label (string): the node label.
   * @param rows (readonly NodeRow[]): [node id, properties] pairs.
   * @param options (UpsertNodeOptions): the extra label, validated only; the generic node table has no second label.
   */
  override async upsertNodes(
    ns: string,
    label: string,
    rows: readonly NodeRow[],
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    if (options.extra_label != null) quoteLabel(options.extra_label);
    for (const [, props] of rows) requireKeys(props);
    for (const [, batch] of writeBatches(
      rows.map(([id, props]) => [null, { pk: pk(ns, id), id, doc: jv(props) }] as const),
    )) {
      await this._run(UPSERT_NODES, { rows: batch, ns, label });
    }
  }

  /**
   * Create or update many edges, a batch per statement, skipping rows with a missing endpoint.
   *
   * Rows are batched in order by which of id, revision, and is_current are null, so every batch binds one type per column; rows with an id and a revision merge on them, the rest are created.
   *
   * @param ns (string): namespace.
   * @param fromLabel (string): source node label.
   * @param toLabel (string): destination node label.
   * @param rows (readonly EdgeWrite[]): [edge type, source id, destination id, properties] rows.
   */
  override async createEdges(
    ns: string,
    fromLabel: string,
    toLabel: string,
    rows: readonly EdgeWrite[],
  ): Promise<void> {
    for (const [, , , props] of rows) requireKeys(props);
    const keyed = rows.map(([type, fromId, toId, props]) => {
      const row = {
        f: pk(ns, fromId),
        t: pk(ns, toId),
        sid: props.id ?? null,
        et: type,
        isc: props.is_current ?? null,
        rev: props.revision ?? null,
        doc: jv(props),
      };
      return [[row.sid === null, row.rev === null, row.isc === null], row] as const;
    });
    for (const [[noSid, noRev], batch] of writeBatches(keyed)) {
      const write = noSid || noRev ? CREATE_EDGES : MERGE_EDGES;
      await this._run(EDGE_ROWS + write, { rows: batch, ns, fl: fromLabel, tl: toLabel });
    }
  }

  async removeNodeLabel(): Promise<void> {}

  async matchNodes(ns: string, label: string, options: MatchNodesOptions = {}): Promise<Props[]> {
    const { equals, any_of, skip = 0, limit = DEFAULT_MATCH_LIMIT, id_gt } = options;
    if (skip > MAX_SKIP) return [];
    const where = ["n.ns = $ns", "n.label = $label"];
    const params: Props = { ns, label };
    whereDocEquals("n", equals, where, params);
    whereDocAnyOf(ns, any_of, where, params);
    whereAfter("n.id", id_gt, where, params);
    const res = await this._run(
      `MATCH (n:N) WHERE ${where.join(" AND ")} ` +
        `RETURN n.doc AS doc ORDER BY n.id SKIP ${intLiteral(skip)} LIMIT ${intLiteral(limit)}`,
      params,
    );
    return docs(res.rows);
  }

  async deleteNode(ns: string, _label: string, id: string): Promise<void> {
    await this._run("MATCH (n:N {pk:$pk}) DETACH DELETE n", { pk: pk(ns, id) });
  }

  async deleteNodes(ns: string, _label: string, ids: readonly string[]): Promise<void> {
    if (ids.length)
      await this._run("MATCH (n:N) WHERE n.pk IN $pks DETACH DELETE n", { pks: ids.map((id) => pk(ns, id)) });
  }

  async deleteNodesBy(ns: string, label: string, equals: Props): Promise<number> {
    const where = ["n.ns = $ns", "n.label = $label"];
    const params: Props = { ns, label };
    whereDocEquals("n", equals, where, params);
    const res = await this._run(`MATCH (n:N) WHERE ${where.join(" AND ")} RETURN n.id AS id`, params);
    await this.deleteNodes(
      ns,
      label,
      res.rows.map((r) => r.id as string),
    );
    return res.rows.length;
  }

  async createEdge(
    ns: string,
    type: string,
    fromLabel: string,
    fromId: string,
    toLabel: string,
    toId: string,
    props: Props,
  ): Promise<boolean> {
    if (!(await this.nodeExists(ns, fromLabel, fromId))) return false;
    if (!(await this.nodeExists(ns, toLabel, toId))) return false;
    requireKeys(props);
    const sid = props.id ?? null;
    const rev = props.revision ?? null;
    const params = {
      f: pk(ns, fromId),
      t: pk(ns, toId),
      sid,
      ns,
      et: type,
      isc: props.is_current ?? null,
      rev,
      doc: jv(props),
    };
    const write =
      sid !== null && rev !== null
        ? "MERGE (a)-[r:R {sid:$sid, ns:$ns, revision:$rev}]->(b) SET r.etype=$et, r.is_current=$isc, r.doc=$doc"
        : "CREATE (a)-[r:R {sid:$sid, ns:$ns, etype:$et, is_current:$isc, revision:$rev, doc:$doc}]->(b)";
    await this._run(`MATCH (a:N {pk:$f}), (b:N {pk:$t}) ${write}`, params);
    return true;
  }

  async getCurrentEdge(ns: string, id: string): Promise<EdgeRow | null> {
    const res = await this._run(
      `${BY_SID} AND r.is_current = true RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et`,
      { ns, sid: id },
    );
    const row = res.rows[0];
    return row ? edgeRow(row) : null;
  }

  async listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]> {
    const res = await this._run(
      `${BY_SID} RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et, r.revision AS rev ORDER BY rev`,
      { ns, sid: id },
    );
    return res.rows.map(edgeRow);
  }

  /**
   * Read edge versions for a bounded list of ids in one query.
   *
   * @param ns (string): namespace.
   * @param fromLabel (string | null): source label, or null for any.
   * @param toLabel (string | null): target label, or null for any.
   * @param ids (readonly string[]): edge ids.
   * @return (Promise<EdgeRow[] | null>): rows grouped by requested id, or null for more than 256 ids.
   */
  async edgeVersions(
    ns: string,
    fromLabel: string | null,
    toLabel: string | null,
    ids: readonly string[],
  ): Promise<EdgeRow[] | null> {
    if (ids.length > 256) return null;
    if (!ids.length) return [];
    const where = ["r.ns = $ns", "r.sid IN $ids"];
    const params: Props = { ns, ids };
    for (const [alias, label] of [
      ["a", fromLabel],
      ["b", toLabel],
    ] as const) {
      if (label !== null) {
        where.push(`${alias}.label = $${alias}_label`);
        params[`${alias}_label`] = label;
      }
    }
    const result = await this._run(
      `MATCH (a:N)-[r:R]->(b:N) WHERE ${where.join(" AND ")} ` +
        "RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et",
      params,
    );
    const order = new Map(ids.map((id, i) => [id, i]));
    return result.rows.map(edgeRow).sort((a, b) => order.get(a.props.id as string)! - order.get(b.props.id as string)!);
  }

  async updateCurrentEdge(ns: string, id: string, props: Props): Promise<void> {
    requireKeys(props);
    const merged = await mergedCurrentEdge(this, ns, id, props);
    if (merged === null) return;
    const assignments = ["r.doc = $doc"];
    const params: Props = { ns, sid: id, doc: jv(merged) };
    for (const field of ["is_current", "revision"]) {
      if (Object.hasOwn(props, field)) {
        assignments.push(`r.${field} = $${field}`);
        params[field] = merged[field] ?? null;
      }
    }
    await this._run(`${BY_SID} AND r.is_current = true SET ${assignments.join(", ")}`, params);
  }

  private async countEdges(ns: string, id: string): Promise<number> {
    const res = await this._run(`${BY_SID} RETURN count(*) AS n`, { ns, sid: id });
    return toCount(res.rows);
  }

  async deleteEdges(ns: string, id: string): Promise<number> {
    const n = await this.countEdges(ns, id);
    if (n) await this._run(`${BY_SID} DELETE r`, { ns, sid: id });
    return n;
  }

  async matchEdges(ns: string, options: MatchEdgesOptions): Promise<EdgeRow[]> {
    const {
      from_label,
      to_label,
      type,
      from_id,
      to_id,
      from_in,
      to_in,
      current_only = false,
      equals,
      skip = 0,
      limit = DEFAULT_MATCH_LIMIT,
      id_gt,
    } = options;
    if (skip > MAX_SKIP) return [];
    const where = ["r.ns = $ns", "a.label = $fl"];
    const params: Props = { ns, fl: from_label };
    if (to_label != null) {
      where.push("b.label = $tl");
      params.tl = to_label;
    }
    if (current_only) where.push("r.is_current = true");
    if (type != null) {
      where.push("r.etype = $etype");
      params.etype = type;
    }
    if (from_id != null) {
      where.push("a.pk = $fpk");
      params.fpk = pk(ns, from_id);
    }
    if (to_id != null) {
      where.push("b.pk = $tpk");
      params.tpk = pk(ns, to_id);
    }
    if (from_in != null) {
      where.push("a.pk IN $fpks");
      params.fpks = from_in.map((i) => pk(ns, i));
    }
    if (to_in != null) {
      where.push("b.pk IN $tpks");
      params.tpks = to_in.map((i) => pk(ns, i));
    }
    whereDocEquals("r", equals, where, params);
    whereAfter("r.sid", id_gt, where, params);
    const res = await this._run(
      `MATCH (a:N)-[r:R]->(b:N) WHERE ${where.join(" AND ")} ` +
        `RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et ` +
        `ORDER BY r.sid, r.revision, a.id, b.id, r.etype SKIP ${intLiteral(skip)} LIMIT ${intLiteral(limit)}`,
      params,
    );
    return res.rows.map(edgeRow);
  }

  async childNodes(
    ns: string,
    _parentLabel: string,
    parentId: string,
    edgeType: string,
    childLabel: string,
  ): Promise<Props[]> {
    const res = await this._run(
      "MATCH (p:N {pk:$pk})-[r:R]->(c:N) WHERE r.ns = $ns AND r.etype = $et AND c.label = $cl RETURN c.doc AS doc",
      { pk: pk(ns, parentId), ns, et: edgeType, cl: childLabel },
    );
    return docs(res.rows);
  }

  async deleteEdgesTouchingByType(ns: string, _label: string, id: string, type: string): Promise<void> {
    for (const pattern of BOTH_WAYS) {
      await this._run(`MATCH ${pattern} WHERE r.ns = $ns AND r.etype = $et DELETE r`, { pk: pk(ns, id), ns, et: type });
    }
  }
}
