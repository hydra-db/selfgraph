import { AsyncLocalStorage } from "node:async_hooks";

import { blake2b } from "@noble/hashes/blake2.js";
import type { Driver, Session } from "neo4j-driver";

import { errorMessage, OTHER_ENGINE_HINT, SelfGraphError, StoreError, TOKEN_HINT } from "../errors.js";
import { comparePy, pyJsonDumps, pyRepr, pyStr, utf8 } from "../internal/py.js";
import { L_ENTITY, L_EVIDENCE, L_MERGE } from "../labels.js";
import type { CypherResult } from "../models.js";
import { batches } from "../ops.js";
import {
  DEFAULT_MATCH_LIMIT,
  type EdgeRow,
  type EdgeWrite,
  type GraphPrimitives,
  type GraphStore,
  type MatchEdgesOptions,
  type MatchNodesOptions,
  type NodeRow,
  type Props,
  type UpsertNodeOptions,
} from "../protocols.js";
import { matchKeys } from "../resolution.js";
import { decodeEntity } from "../serde.js";
import { hasSurrogate } from "../validate.js";
import {
  type BoltStoreOptions,
  boltFailure,
  errorCode,
  openDriver,
  queryError,
  recordsToResult,
  toBoltParams,
} from "./bolt.js";
import {
  AutoCommitStore,
  quoteLabel,
  requireIdentifier,
  requireKeys,
  sortedEntries,
  toCount,
  whereAfter,
} from "./cypherPrimitives.js";
import { docs, edgeRow, firstDoc, mergedCurrentEdge } from "./docRows.js";

const EDGE = "RELATES";
const KEY = "_SgEntityKey";
const SEEK_BATCH = 256;
const PARALLEL = 32;
const queuing = new AsyncLocalStorage<object>();
const HANDSHAKE_RETRIES = 50;
const HANDSHAKE_JITTER_MS = 25;

const jitter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.random() * HANDSHAKE_JITTER_MS));
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = MAX_MESSAGE_BYTES - 64 * 1024;
const WRITE_BATCH = 1000;
const DELETE_BATCH = 1024;
const TRANSIENT_MARKERS = ["snapshot", "epoch", "transient", "serializ", "conflict", "lock"];
const OTHER_ENGINE_MARKERS = [
  "protocol version",
  "unsupported protocol",
  "neo.clienterror.database.databasenotfound",
  "memgraph",
];

/**
 * The bytes a row adds to a HydraDB write: its column names, its strings, and 9 for each other value.
 *
 * @param row (Props): the column names and values about to be written.
 * @return (number): the size in bytes.
 */
function writeSize(row: Props): number {
  let size = 0;
  for (const [key, value] of Object.entries(row)) {
    if (hasSurrogate(key) || (typeof value === "string" && hasSurrogate(value))) {
      throw new StoreError(`HydraDB write field ${pyRepr(key)} cannot contain unpaired surrogate characters`, {
        code: "invalid_argument",
        field: key,
      });
    }
    size += utf8(key).length + (typeof value === "string" ? utf8(value).length : 9);
  }
  return size;
}

/**
 * Reject a write that would not fit in one HydraDB Bolt message.
 *
 * @param row (Props): the column names and values about to be written.
 */
function guardSizes(row: Props): void {
  const size = writeSize(row);
  if (size <= MAX_WRITE_BYTES) return;
  throw new StoreError(
    `HydraDB rejects this write at ${size} bytes; a node or edge row goes in one Bolt message, which HydraDB ` +
      `caps at ${MAX_MESSAGE_BYTES} bytes, so a row may take at most ${MAX_WRITE_BYTES}`,
    { code: "write_too_large" },
  );
}

function isSplitHandshake(exc: unknown): boolean {
  return exc instanceof RangeError && errorCode(exc) === "ERR_OUT_OF_RANGE" && /handshake/i.test(exc.stack ?? "");
}

/**
 * Run an operation, retrying it with jitter while it fails on a split Bolt handshake reply.
 *
 * @param op (() => Promise<T>): the operation; it must open a fresh connection or session on each call.
 * @return (T): the operation's result.
 */
async function withHandshakeRetry<T>(op: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await op();
    } catch (exc) {
      if (!isSplitHandshake(exc) || retry >= HANDSHAKE_RETRIES) throw exc;
      await jitter();
    }
  }
}

/**
 * A stable non-negative 63-bit surrogate key for a string node id, as a bigint (it exceeds Number.MAX_SAFE_INTEGER).
 *
 * @param ns (string): the namespace.
 * @param sid (string): the string id.
 * @return (bigint): the surrogate key.
 */
export function surrogateKey(ns: string, sid: string): bigint {
  const digest = blake2b(utf8(`${ns}\x00${sid}`), { dkLen: 8 });
  let n = 0n;
  for (const byte of digest) n = (n << 8n) | BigInt(byte);
  return n >> 1n;
}

const LABEL_KEY = /^[A-Za-z0-9_.-]+$/;

/**
 * The label as HydraDB can store it, or null when the engine rejects it as a label key.
 *
 * @param label (string | null | undefined): the label to add or remove, such as an entity type.
 * @return (string | null): the label, or null when it is missing or not a valid HydraDB label key.
 */
function engineLabel(label: string | null | undefined): string | null {
  return label != null && LABEL_KEY.test(label) ? label : null;
}

/**
 * The string property holding a node's id for one label in one namespace, which id-ordered reads walk.
 *
 * The engine walks a property's index in value order and stops once the page is full, not at the end of a prefix,
 * so a property shared by every namespace would make a namespace's last page read the nodes of every namespace
 * sorting after it.
 *
 * @param ns (string): the namespace.
 * @param label (string): the node label.
 * @return (string): the property name.
 */
function sortKey(ns: string, label: string): string {
  return `k_${label}_${surrogateKey(ns, label)}`;
}

function scalars(props: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "id" || k === "ns" || k.endsWith("_json")) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * The properties set to null, whose stored columns must be removed since the engine cannot write a null.
 *
 * @param props (Props): the encoded properties about to be written.
 * @return (string[]): the cleared property names, sorted.
 */
function unset(props: Props): string[] {
  return Object.keys(props)
    .filter((k) => props[k] == null && k !== "id" && k !== "ns")
    .sort();
}

const removes = (alias: string, keys: readonly string[]): string =>
  keys.map((k) => `${alias}.\`${requireIdentifier(k)}\``).join(", ");

const docOf = (value: unknown): string => pyJsonDumps(value, { default: pyStr });

/**
 * An equality the engine applies as a filter rather than an index seek, for broad keys such as the namespace.
 *
 * @param alias (string): the node or relationship variable.
 * @param key (string): the property.
 * @param param (string): the parameter name.
 * @return (string): the predicate.
 */
const same = (alias: string, key: string, param: string): string =>
  `NOT ${alias}.\`${requireIdentifier(key)}\` <> $${param}`;

const BY_SID = `MATCH ()-[r:${EDGE} {sid: $sid}]->() WHERE ${same("r", "ns", "ns")}`;
const DELETE_BY_ID = "UNWIND $rows AS row MATCH (n {id: row.id}) DETACH DELETE n";
const SET_BY_SID = `UNWIND $rows AS row MATCH ()-[r:${EDGE} {sid: row.sid}]->() WHERE ${same("r", "ns", "ns")}`;
const SEEK_BY_SID = `MATCH (a)-[r:${EDGE} {sid: $sid}]->() WHERE a.id IN $sources AND ${same("r", "ns", "ns")}`;

/**
 * A node pattern carrying the equality filters in its property map, so the engine seeks on them.
 *
 * @param alias (string): the node variable.
 * @param label (string): the node label.
 * @param equals (Props | null | undefined): property name to required value.
 * @param params (Props): the parameters to extend.
 * @return (string): the pattern body, for example "n:Entity {`type`: $eq0}".
 */
function keyed(alias: string, label: string, equals: Props | null | undefined, params: Props): string {
  const entries = sortedEntries(equals).map(([key, value], i) => {
    params[`eq${i}`] = value;
    return `\`${requireIdentifier(key)}\`: $eq${i}`;
  });
  return entries.length ? `${alias}:${label} {${entries.join(", ")}}` : `${alias}:${label}`;
}

/**
 * The row a node upsert writes.
 *
 * @param ns (string): the namespace.
 * @param label (string): the node label.
 * @param id (string): the node id.
 * @param props (Props): the encoded node properties.
 * @return (Props): the row, with its surrogate id, sort key, document, and scalar columns.
 */
function nodeWriteRow(ns: string, label: string, id: string, props: Props): Props {
  return {
    id: surrogateKey(ns, id),
    sid: id,
    ns,
    label,
    [sortKey(ns, label)]: id,
    doc: docOf(props),
    ...scalars(props),
  };
}

/**
 * The row an edge write creates.
 *
 * @param ns (string): the namespace.
 * @param type (string): the edge type.
 * @param fromLabel (string): the source node label.
 * @param fromId (string): the source node id.
 * @param toLabel (string): the destination node label.
 * @param toId (string): the destination node id.
 * @param props (Props): the encoded edge properties.
 * @return (Props): the row, with its endpoints, surrogate id, document, and scalar columns.
 */
function edgeWriteRow(
  ns: string,
  type: string,
  fromLabel: string,
  fromId: string,
  toLabel: string,
  toId: string,
  props: Props,
): Props {
  const sid = props.id;
  const row: Props = {
    f: surrogateKey(ns, fromId),
    t: surrogateKey(ns, toId),
    fa: fromId,
    tb: toId,
    fl: fromLabel,
    tl: toLabel,
    id: surrogateKey(ns, `${fromId}|${type}|${toId}|${pyStr(sid ?? null)}|${pyStr(props.revision ?? null)}`),
    ns,
    etype: type,
    doc: docOf(props),
  };
  if (sid != null) row.sid = sid;
  Object.assign(row, scalars(props));
  return row;
}

/**
 * Group write rows by column set into batches, since an UNWIND write needs every row to carry the same fields.
 *
 * @param rows (Props[]): the rows to group.
 * @return (Props[][]): batches sharing one column set, each at most WRITE_BATCH rows and MAX_WRITE_BYTES bytes, in first-seen order.
 */
function byColumns(rows: Props[]): Props[][] {
  const groups = new Map<string, Props[]>();
  for (const row of rows) {
    const key = Object.keys(row).sort().join("\x00");
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const out: Props[][] = [];
  for (const group of groups.values()) {
    let batch: Props[] = [];
    let size = 0;
    for (const row of group) {
      const rowSize = writeSize(row);
      if (batch.length && (batch.length === WRITE_BATCH || size + rowSize > MAX_WRITE_BYTES)) {
        out.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(row);
      size += rowSize;
    }
    out.push(batch);
  }
  return out;
}

const sets = (alias: string, row: Props, skip: readonly string[]): string =>
  Object.keys(row)
    .sort()
    .filter((k) => !skip.includes(k))
    .map((k) => {
      const c = requireIdentifier(k);
      return `${alias}.\`${c}\` = row.\`${c}\``;
    })
    .join(", ");

/**
 * The match keys a stored entity is indexed under.
 *
 * @param props (Props): the entity's encoded properties.
 * @return (Set<string>): the keys.
 */
function keysOf(props: Props): Set<string> {
  const ent = decodeEntity(props);
  return matchKeys(ent.name, ent.aliases, ent.external_ids);
}

/**
 * The key index rows of some entities, one per entity and match key, keyed so a rewrite merges in place.
 *
 * @param ns (string): the namespace.
 * @param rows (Iterable<NodeRow>): (entity id, encoded entity properties) pairs.
 * @return (Props[]): the key rows, each with its own id, the hashed key, the entity's surrogate id, and ns.
 */
function keyRows(ns: string, rows: Iterable<NodeRow>): Props[] {
  const out: Props[] = [];
  for (const [id, props] of rows) {
    for (const key of [...keysOf(props)].sort(comparePy)) {
      out.push({
        id: surrogateKey(ns, `\x00key\x00${key}\x00${id}`),
        key: surrogateKey(ns, key),
        eid: surrogateKey(ns, id),
        ns,
      });
    }
  }
  return out;
}

/**
 * The key an edge id's versions are tracked under, so they are written in order and reads by edge id wait.
 *
 * @param ns (string): the namespace.
 * @param sid (string): the edge id.
 * @return (bigint): the key.
 */
const sidKey = (ns: string, sid: string): bigint => surrogateKey(ns, `\x00sid\x00${sid}`);

/**
 * The key a queued node write is tracked under for reads of every node of its label.
 *
 * @param label (string): the node label.
 * @return (bigint): the key.
 */
const labelKey = (label: string): bigint => surrogateKey("", `\x00label\x00${label}`);

const compareKeys = (a: unknown, b: unknown): number => {
  const [x, y] = [BigInt(a as bigint), BigInt(b as bigint)];
  return x < y ? -1 : x > y ? 1 : 0;
};

interface QueuedWrite {
  query: string;
  params: Record<string, unknown>;
  writes: ReadonlySet<bigint>;
  needs: ReadonlySet<bigint>;
}

const overlap = (a: ReadonlySet<bigint>, b: ReadonlySet<bigint>): boolean => [...a].some((x) => b.has(x));

export type HydraDBStoreOptions = BoltStoreOptions;

export class HydraDBStore extends AutoCommitStore implements GraphStore {
  private readonly driver: Driver;
  private readonly uri: string;
  private readonly database: string;
  private readonly hasAuth: boolean;
  private queued: QueuedWrite[] = [];
  private readonly dirty = new Set<bigint>();
  private readonly pendingNodes = new Set<string>();
  private failure: unknown = null;
  private draining: Promise<void> | null = null;

  /**
   * A store for HydraDB over Bolt, using integer surrogate keys and auto-commit writes.
   *
   * @param uri (string): the Bolt URI, e.g. bolt://127.0.0.1:17687.
   * @param options (HydraDBStoreOptions): auth as [user, token] or a driver token, the database (default "default"), and driver config.
   */
  constructor(uri: string, options: HydraDBStoreOptions = {}) {
    super();
    const { auth, database, ...config } = options;
    this.driver = openDriver(uri, auth, config);
    this.uri = uri;
    this.database = database || "default";
    this.hasAuth = Boolean(auth);
  }

  private session(): Session {
    return this.driver.session({ database: this.database });
  }

  /**
   * Run one auto-commit statement, retrying the split-handshake ERR_OUT_OF_RANGE that fails before any RUN is sent, so a fresh-connection retry cannot double-apply.
   *
   * @param query (string): the Cypher statement.
   * @param params (Record<string, unknown> | null): the query parameters.
   * @return (CypherResult): the rows.
   */
  /**
   * Run one statement, inside the write transaction once the queued writes it can see have run. Only the transaction that queued the writes runs them, so another task reads what is committed.
   *
   * @param query (string): the Cypher statement.
   * @param params (Record<string, unknown> | null): the query parameters.
   * @param reads (Iterable<bigint> | null): the only ids the statement reads, so it waits only for queued writes to them, or null to wait for every queued write.
   * @return (CypherResult): the rows.
   */
  protected async _run(
    query: string,
    params?: Record<string, unknown> | null,
    reads: Iterable<bigint> | null = null,
  ): Promise<CypherResult> {
    const visible = reads === null || [...reads].some((id) => this.dirty.has(id));
    if (queuing.getStore() === this && (this.draining || (this.queued.length && visible))) await this.drain();
    return this.exec(query, params);
  }

  /**
   * Run one write, or queue it inside a write transaction so it runs concurrently with the writes around it. Every write waits for a WAL flush, and writes in flight together share one, so queued writes run in waves: a write runs in the wave after the last one that writes an id it writes or needs, or needs an id it writes.
   *
   * @param query (string): the statement.
   * @param params (Record<string, unknown>): the parameters.
   * @param writes (Iterable<bigint>): the surrogate ids of the nodes or edges it writes.
   * @param needs (Iterable<bigint>): the surrogate ids of the nodes it reads, such as an edge's endpoints.
   * @param marks (Iterable<bigint>): further keys reads wait on, such as its label.
   * @param afterAll (boolean): run after every write queued before it, for a write that records that they are done (evidence, a merge record, a retirement), so a failure never leaves it without them.
   */
  private async write(
    query: string,
    params: Record<string, unknown>,
    writes: Iterable<bigint>,
    needs: Iterable<bigint> = [],
    marks: Iterable<bigint> = [],
    afterAll = false,
  ): Promise<void> {
    if (queuing.getStore() !== this) {
      await this.exec(query, params);
      return;
    }
    const item = { query, params, writes: new Set(writes), needs: new Set(needs) };
    if (afterAll) for (const queued of this.queued) for (const id of queued.writes) item.needs.add(id);
    this.queued.push(item);
    for (const id of [...item.writes, ...marks]) this.dirty.add(id);
  }

  /**
   * Run the queued writes in waves, up to PARALLEL writes at a time, one wave after another.
   *
   * A failure is also kept for the transaction to throw, so it is never lost to a caller that drops it.
   *
   * @return (void): nothing; throws the first error of the first wave that fails, skipping later waves.
   */
  private async drain(): Promise<void> {
    while (this.draining) await this.draining;
    if (!this.queued.length) return;
    const queued = this.queued;
    this.queued = [];
    this.dirty.clear();
    this.pendingNodes.clear();
    const run = this.runWaves(queued);
    this.draining = run
      .catch(() => undefined)
      .finally(() => {
        this.draining = null;
      });
    await run;
  }

  /**
   * Group queued writes into waves, each after every wave it conflicts with, and run them.
   *
   * @param queued (readonly QueuedWrite[]): the writes, in the order queued.
   * @return (void): nothing; throws the first failure.
   */
  private async runWaves(queued: readonly QueuedWrite[]): Promise<void> {
    const waves: { statements: QueuedWrite[]; writes: Set<bigint>; needs: Set<bigint> }[] = [];
    for (const item of queued) {
      let after = -1;
      waves.forEach((wave, i) => {
        if (overlap(item.writes, wave.writes) || overlap(item.writes, wave.needs) || overlap(item.needs, wave.writes))
          after = i;
      });
      if (after + 1 === waves.length) waves.push({ statements: [], writes: new Set(), needs: new Set() });
      const wave = waves[after + 1]!;
      wave.statements.push(item);
      for (const id of item.writes) wave.writes.add(id);
      for (const id of item.needs) wave.needs.add(id);
    }
    for (const { statements } of waves) {
      for (const batch of batches(statements, PARALLEL)) {
        const results = await Promise.allSettled(batch.map((s) => this.exec(s.query, s.params)));
        for (const res of results) {
          if (res.status !== "rejected") continue;
          this.failure ??= res.reason;
          throw res.reason;
        }
      }
    }
  }

  /**
   * Run one write at a time on this store, running its queued writes before it ends, even when it fails.
   *
   * @param fn ((tx: GraphPrimitives) => Promise<T>): the writes to run.
   * @return (T): the result of fn.
   */
  override async transaction<T>(fn: (tx: GraphPrimitives) => Promise<T>): Promise<T> {
    if (queuing.getStore() === this) return fn(this);
    return super.transaction((tx) =>
      queuing.run(this, async () => {
        let failure: unknown = null;
        let result: T;
        try {
          result = await fn(tx);
        } finally {
          try {
            await this.drain();
          } finally {
            failure = this.failure;
            this.failure = null;
          }
        }
        if (failure !== null) throw failure;
        return result;
      }),
    );
  }

  /**
   * Run one statement now, bypassing the write queue.
   *
   * @param query (string): the Cypher statement.
   * @param params (Record<string, unknown> | null): its parameters.
   * @return (CypherResult): the rows.
   */
  private async exec(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    this.requireOpen();
    const boltParams = toBoltParams(params);
    try {
      return await withHandshakeRetry(async () => {
        const session = this.session();
        try {
          return await recordsToResult(session.run(query, boltParams));
        } finally {
          await session.close().catch(() => undefined);
        }
      });
    } catch (exc) {
      if (exc instanceof SelfGraphError) throw exc;
      throw this.error(exc);
    }
  }

  /**
   * Map a driver error to a library error, saying when a token is missing or the server is another engine.
   *
   * A missing database on HydraDB itself gets no engine hint; only a protocol mismatch or a Neo4j or Memgraph error code does.
   *
   * @param exc (unknown): the driver error.
   * @return (StoreError): the error to throw.
   */
  private error(exc: unknown): StoreError {
    const failure = boltFailure(exc);
    if (failure === "auth" && !this.hasAuth)
      return new StoreError(`HydraDB needs a token: ${TOKEN_HINT}`, { cause: exc, code: "store_auth_failed" });
    const err = queryError(exc, this.uri, this.database, "HydraDB", (lowered) =>
      TRANSIENT_MARKERS.some((k) => lowered.includes(k)),
    );
    const lowered = `${errorCode(exc)} ${errorMessage(exc)}`.toLowerCase();
    if (OTHER_ENGINE_MARKERS.some((k) => lowered.includes(k))) {
      return new StoreError(`${err.message}; if this is Neo4j or Memgraph, ${OTHER_ENGINE_HINT}`, {
        cause: exc,
        code: "wrong_engine",
      });
    }
    return err;
  }

  /**
   * Open a first pooled connection, retrying the split handshake with jitter, then check the server accepts the credentials with one cheap read; nothing is created.
   */
  async initialize(): Promise<void> {
    this.requireOpen();
    try {
      await withHandshakeRetry(() => this.driver.verifyConnectivity({ database: this.database }));
    } catch (exc) {
      throw this.error(exc);
    }
    await this._run("MATCH (n:_SgInit) RETURN count(*) AS n");
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.driver.close();
  }

  async getNode(ns: string, label: string, id: string): Promise<Props | null> {
    const iid = surrogateKey(ns, id);
    const res = await this._run(
      `MATCH (n:${label} {id: $iid}) RETURN n.doc AS doc, n.sid AS stored_id, n.ns AS stored_ns`,
      { iid },
      [iid],
    );
    return firstDoc(res.rows);
  }

  async nodeExists(ns: string, label: string, id: string): Promise<boolean> {
    const iid = surrogateKey(ns, id);
    const res = await this._run(`MATCH (n:${label} {id: $iid}) RETURN n.sid AS sid`, { iid }, [iid]);
    return res.rows.length > 0;
  }

  /**
   * Report which of some node ids exist under one label, seeking their keys in bounded batches.
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param ids (readonly string[]): the node ids.
   * @return (Set<string>): the ids nodeExists would report present.
   */
  async nodesExist(ns: string, label: string, ids: readonly string[]): Promise<Set<string>> {
    const byKey = new Map<string, string[]>();
    const keys: bigint[] = [];
    for (const id of ids) {
      const iid = surrogateKey(ns, id);
      const same = byKey.get(String(iid));
      if (same) same.push(id);
      else {
        byKey.set(String(iid), [id]);
        keys.push(iid);
      }
    }
    const found = new Set<string>();
    for (const batch of batches(keys.sort(compareKeys), SEEK_BATCH)) {
      const res = await this._run(`MATCH (n:${label}) WHERE n.id IN $iids RETURN n.id AS id`, { iids: batch }, batch);
      for (const row of res.rows) for (const id of byKey.get(String(row.id)) ?? []) found.add(id);
    }
    return found;
  }

  /**
   * Reject node upserts that would not fit in one HydraDB Bolt message, before any write.
   *
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param rows (readonly NodeRow[]): (id, encoded properties) pairs, as upsertNodes takes them.
   */
  checkNodeWrites(ns: string, label: string, rows: readonly NodeRow[]): void {
    for (const [id, props] of rows) guardSizes(nodeWriteRow(ns, label, id, props));
  }

  /**
   * Reject edge writes that would not fit in one HydraDB Bolt message, before any write.
   *
   * @param ns (string): the namespace.
   * @param fromLabel (string): the source node label.
   * @param toLabel (string): the destination node label.
   * @param rows (readonly EdgeWrite[]): (type, from id, to id, encoded properties), as createEdges takes them.
   */
  checkEdgeWrites(ns: string, fromLabel: string, toLabel: string, rows: readonly EdgeWrite[]): void {
    for (const [type, fromId, toId, props] of rows) {
      guardSizes(edgeWriteRow(ns, type, fromLabel, fromId, toLabel, toId, props));
    }
  }

  async upsertNode(
    ns: string,
    label: string,
    id: string,
    props: Props,
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    await this.upsertNodes(ns, label, [[id, props]], options);
  }

  override async upsertNodes(
    ns: string,
    label: string,
    rows: readonly NodeRow[],
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    await this.upsertRows(ns, label, rows, options, true);
  }

  /**
   * Upsert nodes with an idempotent extra-label write instead of a label probe.
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param rows (readonly NodeRow[]): (id, encoded properties) pairs, as upsertNodes takes them.
   * @param options (UpsertNodeOptions): an additional label for every node.
   * @return (void): nothing.
   */
  async upsertNewNodes(
    ns: string,
    label: string,
    rows: readonly NodeRow[],
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    await this.upsertRows(ns, label, rows, options, false);
  }

  /**
   * Upsert nodes with their key rows first, then clear the columns their properties unset.
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param rows (readonly NodeRow[]): (id, encoded properties) pairs.
   * @param options (UpsertNodeOptions): an additional label for every node.
   * @param probeLabels (boolean): read which nodes lack the extra label and write it only to those, else write it to every node.
   * @return (void): nothing.
   */
  private async upsertRows(
    ns: string,
    label: string,
    rows: readonly NodeRow[],
    options: UpsertNodeOptions,
    probeLabels: boolean,
  ): Promise<void> {
    if (options.extra_label != null) quoteLabel(options.extra_label);
    for (const [, props] of rows) requireKeys(props);
    const cleared = new Map<string, [string[], bigint[]]>();
    const out = rows.map(([id, props]) => {
      const row = nodeWriteRow(ns, label, id, props);
      guardSizes(row);
      const keys = unset(props);
      if (keys.length) {
        const group = JSON.stringify(keys);
        const entry = cleared.get(group) ?? [keys, []];
        entry[1].push(row.id as bigint);
        cleared.set(group, entry);
      }
      return row;
    });
    const held: [string[], { iids: bigint[] }][] = [];
    for (const [keys, iids] of cleared.values()) {
      for (const batch of batches(iids, DELETE_BATCH)) {
        const params = { iids: batch };
        const found = await this._run(
          `MATCH (n:${label}) WHERE n.id IN $iids AND (${keys.map((k) => `n.\`${requireIdentifier(k)}\` IS NOT NULL`).join(" OR ")}) RETURN n.sid AS sid`,
          params,
          batch,
        );
        const members = new Set(batch);
        if (found.rows.length || out.some((r) => members.has(r.id as bigint) && keys.some((k) => Object.hasOwn(r, k))))
          held.push([keys, params]);
      }
    }
    const indexRows = label === L_ENTITY ? keyRows(ns, rows) : [];
    await this.mergeRows(KEY, indexRows);
    await this.mergeRows(
      label,
      out,
      indexRows.map((r) => r.id as bigint),
      options.extra_label,
      probeLabels,
    );
    for (const [keys, params] of held) {
      await this._run(`MATCH (n:${label}) WHERE n.id IN $iids REMOVE ${removes("n", keys)}`, params);
    }
  }

  /**
   * Upsert node rows by surrogate id with one UNWIND statement per batch of rows sharing a column set.
   * @param label (string): the node label.
   * @param rows (Props[]): the rows, each with its surrogate id and the columns to set.
   * @param needs (readonly bigint[]): ids that must be written first, such as the entities' key rows, so a failed write never leaves an entity stored without them.
   * @param extraLabel (string | null | undefined): an optional secondary label.
   * @param probeLabels (boolean): read which nodes lack the extra label and write it only to those, else write it to every node.
   * @return (void): nothing.
   */
  private async mergeRows(
    label: string,
    rows: Props[],
    needs: readonly bigint[] = [],
    extraLabel?: string | null,
    probeLabels = true,
  ): Promise<void> {
    extraLabel = engineLabel(extraLabel);
    const labels = extraLabel === null ? [label] : [label, extraLabel];
    const marks = labels.map(labelKey);
    const afterAll = label === L_EVIDENCE || label === L_MERGE;
    for (const batch of byColumns(rows)) {
      const ids = batch.map((r) => r.id as bigint);
      let missingLabels: bigint[] = [];
      if (extraLabel !== null && !probeLabels) {
        missingLabels = ids;
      } else if (extraLabel !== null) {
        const found = await this._run(
          `MATCH (n:${quoteLabel(extraLabel)}) WHERE n.id IN $iids RETURN n.id AS id`,
          { iids: ids },
          ids,
        );
        const labelled = new Set(found.rows.map((row) => String(row.id)));
        missingLabels = ids.filter((id) => !labelled.has(String(id)));
      }
      await this.write(
        `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:${label}, ${sets("n", batch[0]!, ["id"])}`,
        { rows: batch },
        ids,
        needs,
        marks,
        afterAll,
      );
      if (missingLabels.length) {
        await this.write(
          `UNWIND $rows AS row MATCH (n:${label} {id: row.id}) SET n:${quoteLabel(extraLabel!)}`,
          { rows: missingLabels.map((id) => ({ id })) },
          missingLabels,
          missingLabels,
          marks,
          afterAll,
        );
      }
      if (queuing.getStore() === this) {
        for (const name of labels) for (const id of ids) this.pendingNodes.add(`${name}\x00${id}`);
      }
    }
  }

  /**
   * Read the entities sharing a match key with some keys, through the key index instead of a scan. A key row whose entity is gone or no longer has that key, after an alias or external id was removed, is deleted on the way, so the index never grows stale.
   *
   * @param ns (string): the namespace.
   * @param keys (Iterable<string>): the match keys, as matchKeys derives them.
   * @return (Props[]): the matching entities' properties.
   */
  async entitiesMatching(ns: string, keys: Iterable<string>): Promise<Props[]> {
    const wanted = new Map([...keys].map((k) => [String(surrogateKey(ns, k)), k]));
    const hits: [bigint, string, string][] = [];
    const iids = new Map<string, unknown>();
    for (const batch of batches([...wanted.keys()].map(BigInt).sort(compareKeys), SEEK_BATCH)) {
      const res = await this._run(
        `MATCH (k:${KEY}) WHERE k.key IN $keys RETURN k.id AS id, k.key AS key, k.eid AS eid`,
        {
          keys: batch,
        },
      );
      for (const r of res.rows) {
        hits.push([BigInt(r.id as bigint), wanted.get(String(r.key))!, String(r.eid)]);
        iids.set(String(r.eid), r.eid);
      }
    }
    const found = new Map<string, Props>();
    for (const batch of batches([...iids.values()].sort(compareKeys), SEEK_BATCH)) {
      const res = await this._run(
        `MATCH (n:${L_ENTITY}) WHERE n.id IN $iids AND ${same("n", "ns", "ns")} RETURN n.id AS iid, n.doc AS doc, n.sid AS stored_id, n.ns AS stored_ns`,
        { iids: batch, ns },
      );
      for (const r of res.rows) {
        const [doc] = docs([r]);
        if (doc !== undefined) found.set(String(r.iid), doc);
      }
    }
    const stale = hits
      .filter(([, key, eid]) => !found.has(eid) || !keysOf(found.get(eid)!).has(key))
      .map(([id]) => id)
      .sort(compareKeys);
    for (const batch of batches(stale, SEEK_BATCH)) {
      await this.write(`MATCH (k:${KEY}) WHERE k.id IN $ids DETACH DELETE k`, { ids: batch }, batch);
    }
    return [...found.values()];
  }

  /**
   * Delete the key index rows of deleted entities, so the index only holds stored entities' keys.
   *
   * @param label (string): the label of the deleted nodes; only entities have key rows.
   * @param iids (readonly bigint[]): the deleted nodes' surrogate ids.
   * @return (void): nothing.
   */
  private async dropKeys(label: string, iids: readonly bigint[]): Promise<void> {
    if (label !== L_ENTITY) return;
    for (const batch of batches(iids, SEEK_BATCH)) {
      await this._run(`MATCH (k:${KEY}) WHERE k.eid IN $iids DETACH DELETE k`, { iids: batch });
    }
  }

  async removeNodeLabel(ns: string, label: string, id: string, dropLabel: string): Promise<void> {
    const quoted = quoteLabel(dropLabel);
    if (engineLabel(dropLabel) === null) return;
    await this._run(`MATCH (n:${label} {id: $iid}) REMOVE n:${quoted}`, { iid: surrogateKey(ns, id) });
  }

  async matchNodes(ns: string, label: string, options: MatchNodesOptions = {}): Promise<Props[]> {
    const { equals, any_of, skip = 0, limit = DEFAULT_MATCH_LIMIT, id_gt } = options;
    if (!sortedEntries(equals).length && !sortedEntries(any_of).length) {
      const key = sortKey(ns, label);
      const params: Props = { skip, limit };
      const where = [`n.\`${key}\` STARTS WITH ''`];
      whereAfter(`n.\`${key}\``, id_gt, where, params);
      const res = await this._run(
        `MATCH (n:${label}) WHERE ${where.join(" AND ")} ` +
          `RETURN n.doc AS doc, n.sid AS stored_id, n.ns AS stored_ns ORDER BY n.\`${key}\` SKIP $skip LIMIT $limit`,
        params,
        [labelKey(label)],
      );
      return docs(res.rows);
    }
    const params: Props = { ns, label, skip, limit };
    const ids = any_of?.id;
    let pattern: string;
    let where: string[];
    if (ids != null) {
      pattern = "n";
      where = ["n.id IN $iids", same("n", "label", "label"), same("n", "ns", "ns")];
      params.iids = ids.map((i) => surrogateKey(ns, i as string));
      sortedEntries(equals).forEach(([key, value], i) => {
        where.push(same("n", key, `eq${i}`));
        params[`eq${i}`] = value;
      });
    } else {
      pattern = keyed("n", label, equals, params);
      where = [same("n", "ns", "ns")];
    }
    sortedEntries(any_of).forEach(([key, values], i) => {
      if (key === "id") return;
      where.push(`n.\`${requireIdentifier(key)}\` IN $in${i}`);
      params[`in${i}`] = [...(values as unknown[])];
    });
    whereAfter("n.sid", id_gt, where, params);
    const res = await this._run(
      `MATCH (${pattern}) WHERE ${where.join(" AND ")} ` +
        "RETURN n.doc AS doc, n.sid AS stored_id, n.ns AS stored_ns, n.`sid` AS __ob ORDER BY __ob SKIP $skip LIMIT $limit",
      params,
      (params.iids as bigint[] | undefined) ?? [labelKey(label)],
    );
    return docs(res.rows);
  }

  async deleteNode(ns: string, label: string, id: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id: $iid}) DETACH DELETE n`, { iid: surrogateKey(ns, id) });
    await this.dropKeys(label, [surrogateKey(ns, id)]);
  }

  async deleteNodes(ns: string, label: string, ids: readonly string[]): Promise<void> {
    for (const batch of batches(ids, DELETE_BATCH)) {
      const iids = batch.map((id) => surrogateKey(ns, id));
      let keys: bigint[] = [];
      if (label === L_ENTITY) {
        const found = await this._run(
          `MATCH (k:${KEY}) WHERE k.eid IN $iids AND ${same("k", "ns", "ns")} RETURN k.id AS id LIMIT $limit`,
          { iids, ns, limit: DELETE_BATCH },
        );
        keys = found.rows.map((row) => BigInt(row.id as bigint));
      }
      for (const doomed of batches([...iids, ...keys], DELETE_BATCH)) {
        await this._run(DELETE_BY_ID, { rows: doomed.map((id) => ({ id })) });
      }
      if (keys.length === DELETE_BATCH) {
        await this._run(`MATCH (k:${KEY}) WHERE k.eid IN $iids AND ${same("k", "ns", "ns")} DETACH DELETE k`, {
          iids,
          ns,
        });
      }
    }
  }

  async deleteNodesBy(ns: string, label: string, equals: Props): Promise<number> {
    const params: Props = { ns, batch: DELETE_BATCH };
    const pattern = keyed("n", label, equals, params);
    const where = same("n", "ns", "ns");
    let deleted = 0;
    for (;;) {
      const res = await this._run(`MATCH (${pattern}) WHERE ${where} RETURN n.id AS iid LIMIT $batch`, params);
      const ids = res.rows.map((r) => r.iid);
      if (ids.length) {
        await this._run("MATCH (n) WHERE n.id IN $iids DETACH DELETE n", { iids: ids });
        await this.dropKeys(
          label,
          ids.map((id) => BigInt(id as bigint)),
        );
      }
      deleted += ids.length;
      if (ids.length < DELETE_BATCH) return deleted;
    }
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
    const ends: Record<string, bigint> = {};
    const nodes: Record<string, string> = { f: `(a:${fromLabel} {id: $f})`, t: `(b:${toLabel} {id: $t})` };
    for (const [k, label, iid] of [
      ["f", fromLabel, surrogateKey(ns, fromId)],
      ["t", toLabel, surrogateKey(ns, toId)],
    ] as const) {
      if (!this.pendingNodes.has(`${label}\x00${iid}`)) ends[k] = iid;
    }
    if (Object.keys(ends).length) {
      const pattern = Object.keys(ends).map((k) => nodes[k]);
      const found = await this._run(
        `MATCH ${pattern.join(", ")} RETURN ${"f" in ends ? "a" : "b"}.sid AS sid`,
        ends,
        Object.values(ends),
      );
      if (!found.rows.length) return false;
    }
    await this.createEdges(ns, fromLabel, toLabel, [[type, fromId, toId, props]]);
    return true;
  }

  override async createEdges(
    ns: string,
    fromLabel: string,
    toLabel: string,
    rows: readonly EdgeWrite[],
  ): Promise<void> {
    for (const [, , , props] of rows) requireKeys(props);
    const out = rows.map(([type, fromId, toId, props]) => {
      const row = edgeWriteRow(ns, type, fromLabel, fromId, toLabel, toId, props);
      guardSizes(row);
      return row;
    });
    const cleared = new Map<string, Props[]>();
    rows.forEach(([, , , props], i) => {
      const keys = unset(props);
      if (!keys.length) return;
      const row = out[i]!;
      const group = cleared.get(keys.join("\u0000")) ?? [];
      group.push({ f: row.f, t: row.t, id: row.id });
      cleared.set(keys.join("\u0000"), group);
    });
    for (const [joined, ends] of cleared) {
      const ids = ends.map((row) => row.id as bigint);
      const have = joined
        .split("\u0000")
        .map((key) => `r.\`${requireIdentifier(key)}\` IS NOT NULL`)
        .join(" OR ");
      const found = await this._run(
        `MATCH (a:${fromLabel})-[r:${EDGE}]->() WHERE a.id IN $sources ` + `AND (${have}) RETURN r.sid AS sid LIMIT 1`,
        { ids, sources: [...new Set(ends.map((row) => row.f as bigint))] },
        [...ids, ...ends.map((row) => row.f as bigint)],
      );
      if (!found.rows.length) continue;
      await this._run(
        `UNWIND $rows AS row MATCH (a:${fromLabel} {id: row.f})-[r:${EDGE} {id: row.id}]->` +
          `(b:${toLabel} {id: row.t}) REMOVE ${removes("r", joined.split("\u0000"))}`,
        { rows: ends },
      );
    }
    for (const batch of byColumns(out)) {
      await this.write(
        `UNWIND $rows AS row MATCH (a:${fromLabel} {id: row.f}), (b:${toLabel} {id: row.t}) ` +
          `MERGE (a)-[r:${EDGE} {id: row.id}]->(b) SET ${sets("r", batch[0]!, ["f", "t", "id"])}`,
        { rows: batch },
        [
          ...batch.map((r) => r.id as bigint),
          ...batch.filter((r) => r.sid != null).map((r) => sidKey(ns, r.sid as string)),
        ],
        batch.flatMap((r) => [r.f as bigint, r.t as bigint]),
        [],
        batch.some((r) => r.is_current === false && Boolean(r.invalidated_by)),
      );
    }
  }

  private async sidSources(ns: string, id: string): Promise<Props> {
    const result = await this._run(
      `MATCH (a)-[r:${EDGE} {sid: $sid}]->() WHERE ${same("r", "ns", "ns")} RETURN a.id AS source`,
      { ns, sid: id },
      [sidKey(ns, id)],
    );
    return { ns, sid: id, sources: [...new Set(result.rows.map((row) => row.source))] };
  }

  async getCurrentEdge(ns: string, id: string): Promise<EdgeRow | null> {
    const res = await this._run(
      `${BY_SID} AND NOT r.is_current <> true RETURN r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, r.fa AS fa, r.tb AS tb, r.etype AS et`,
      { ns, sid: id },
      [sidKey(ns, id)],
    );
    const row = res.rows[0];
    return row ? edgeRow(row) : null;
  }

  async listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]> {
    const res = await this._run(
      `${SEEK_BY_SID} RETURN r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, r.fa AS fa, r.tb AS tb, r.etype AS et, r.revision AS rev ORDER BY rev`,
      await this.sidSources(ns, id),
      [sidKey(ns, id)],
    );
    return res.rows.map(edgeRow);
  }

  /**
   * Read every version after seeking source vertices by a bounded set of edge ids.
   * @param ns (string): the namespace.
   * @param fromLabel (string | null): the source node label the edges must have, or null for any.
   * @param toLabel (string | null): the destination node label the edges must have, or null for any.
   * @param ids (readonly string[]): the edge ids.
   * @return (EdgeRow[] | null): the edge rows, grouped by id in the order given, or null for too many ids.
   */
  async edgeVersions(
    ns: string,
    fromLabel: string | null,
    toLabel: string | null,
    ids: readonly string[],
  ): Promise<EdgeRow[] | null> {
    if (ids.length > SEEK_BATCH) return null;
    if (ids.length === 0) return [];
    const seeds = await this._run(
      `MATCH (a)-[r:${EDGE}]->() WHERE r.sid IN $sids AND ${same("r", "ns", "ns")} RETURN a.id AS source`,
      { ns, sids: ids },
      ids.map((sid) => sidKey(ns, sid)),
    );
    const sources = [...new Set(seeds.rows.map((row) => row.source))];
    if (!sources.length) return [];
    const labels: Props = {};
    if (fromLabel !== null) labels.fl = fromLabel;
    if (toLabel !== null) labels.tl = toLabel;
    const where = Object.keys(labels)
      .map((k) => ` AND ${same("r", k, k)}`)
      .join("");
    const res = await this._run(
      `MATCH (a)-[r:${EDGE}]->() WHERE a.id IN $sources AND ${same("r", "ns", "ns")} ` +
        `AND NOT (NOT r.sid IN $sids)${where} ` +
        "RETURN r.sid AS sid, r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, r.fa AS fa, r.tb AS tb, r.etype AS et",
      { ns, sids: ids, sources, ...labels },
      ids.map((sid) => sidKey(ns, sid)),
    );
    const byId = new Map<string, EdgeRow[]>();
    for (const row of res.rows) {
      const sid = row.sid as string;
      const versions = byId.get(sid);
      if (versions) versions.push(edgeRow(row));
      else byId.set(sid, [edgeRow(row)]);
    }
    return ids.flatMap((sid) => byId.get(sid) ?? []);
  }

  async updateCurrentEdge(ns: string, id: string, props: Props): Promise<void> {
    requireKeys(props);
    const merged = await mergedCurrentEdge(this, ns, id, props);
    if (merged === null) return;
    const assignments = ["r.doc = $doc"];
    const params: Props = { ns, sid: id, doc: docOf(merged) };
    for (const [k, v] of Object.entries(scalars(merged))) {
      assignments.push(`r.\`${requireIdentifier(k)}\` = $s_${k}`);
      params[`s_${k}`] = v;
    }
    guardSizes(params);
    params.rows = [{ sid: id }];
    delete params.sid;
    const keys = unset(merged);
    const remove = keys.length ? ` REMOVE ${removes("r", keys)}` : "";
    await this._run(`${SET_BY_SID} AND r.is_current = true${remove} SET ${assignments.join(", ")}`, params);
  }

  async deleteEdges(ns: string, id: string): Promise<number> {
    const res = await this._run(
      `MATCH (a)-[r:${EDGE} {sid: $sid}]->() WHERE a.id IN $sources AND ${same("r", "ns", "ns")} DELETE r RETURN count(r) AS n`,
      await this.sidSources(ns, id),
    );
    return toCount(res.rows);
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
    const params: Props = { ns, skip, limit };
    let apat = `a:${from_label}`;
    let bpat = to_label ? `b:${to_label}` : "b";
    const where: string[] = [];
    if (from_id != null) {
      apat += " {id: $fiid}";
      params.fiid = surrogateKey(ns, from_id);
    }
    if (to_id != null) {
      bpat += " {id: $tiid}";
      params.tiid = surrogateKey(ns, to_id);
    }
    if (from_in != null) {
      where.push("a.id IN $fiids_in");
      params.fiids_in = from_in.map((i) => surrogateKey(ns, i));
    }
    if (to_in != null) {
      where.push("b.id IN $tiids_in");
      params.tiids_in = to_in.map((i) => surrogateKey(ns, i));
    }
    const fromAnchored = from_id != null || from_in != null;
    const toAnchored = to_id != null || to_in != null;
    const filters: Array<[string, unknown]> = [
      ["ns", ns],
      ...(type != null ? ([["etype", type]] as Array<[string, unknown]>) : []),
      ...sortedEntries(equals),
    ];
    if (fromAnchored && !toAnchored) {
      bpat = "";
      if (to_label) filters.push(["tl", to_label]);
    } else if (toAnchored && !fromAnchored) {
      apat = "";
      filters.push(["fl", from_label]);
    } else if (!fromAnchored && !toAnchored) {
      apat += " {ns: $ns}";
    }
    filters.forEach(([key, value], i) => {
      where.push(same("r", key, `eq${i}`));
      params[`eq${i}`] = value;
    });
    if (current_only) where.push("NOT r.is_current <> true");
    if (id_gt != null) {
      where.push("NOT r.sid <= $id_gt");
      params.id_gt = id_gt;
    }
    if (!fromAnchored && !toAnchored) {
      const seek = sortedEntries(equals).find(
        ([key, value]) => key !== "ns" && ["string", "number", "boolean"].includes(typeof value),
      );
      if (seek) {
        const [key, value] = seek;
        const seeds = await this._run(
          `MATCH (a)-[r:${EDGE} {\`${requireIdentifier(key)}\`: $seek}]->() WHERE ${same("r", "ns", "ns")} RETURN a.id AS source LIMIT $seek_limit`,
          { ns, seek: value, seek_limit: SEEK_BATCH + 1 },
        );
        if (seeds.rows.length <= SEEK_BATCH) {
          const sources = [...new Set(seeds.rows.map((row) => row.source))];
          if (!sources.length) return [];
          apat = `a:${from_label}`;
          where.unshift("a.id IN $sources");
          params.sources = sources;
        }
      }
    }
    const res = await this._run(
      `MATCH (${apat})-[r:${EDGE}]->(${bpat}) WHERE ${where.join(" AND ")} ` +
        "RETURN r.doc AS doc, r.sid AS stored_id, r.ns AS stored_ns, r.fa AS fa, r.tb AS tb, r.etype AS et, r.`sid` AS __ob, r.revision AS __rev " +
        "ORDER BY __ob, __rev, fa, tb, et SKIP $skip LIMIT $limit",
      params,
    );
    return res.rows.map(edgeRow);
  }

  async childNodes(
    ns: string,
    parentLabel: string,
    parentId: string,
    edgeType: string,
    childLabel: string,
  ): Promise<Props[]> {
    const res = await this._run(
      `MATCH (p:${parentLabel} {id: $iid})-[r:${EDGE}]->(c:${childLabel}) ` +
        `WHERE ${same("r", "ns", "ns")} AND ${same("r", "etype", "et")} RETURN c.doc AS doc, c.sid AS stored_id, c.ns AS stored_ns`,
      { iid: surrogateKey(ns, parentId), ns, et: edgeType },
    );
    return docs(res.rows);
  }

  /**
   * Read the child nodes of many parents along one edge type, a batch of parents per read.
   *
   * @param ns (string): the namespace.
   * @param parentLabel (string): the parents' label.
   * @param parentIds (readonly string[]): the parent ids.
   * @param edgeType (string): the edge type from parent to child.
   * @param childLabel (string): the children's label.
   * @return (Map<string, Props[]>): each parent's children's properties, by parent id, for parents with any.
   */
  async childrenOf(
    ns: string,
    parentLabel: string,
    parentIds: readonly string[],
    edgeType: string,
    childLabel: string,
  ): Promise<Map<string, Props[]>> {
    const out = new Map<string, Props[]>();
    for (const batch of batches(parentIds, SEEK_BATCH)) {
      const res = await this._run(
        `MATCH (p:${parentLabel})-[r:${EDGE}]->(c:${childLabel}) WHERE p.id IN $iids ` +
          `AND ${same("r", "ns", "ns")} AND ${same("r", "etype", "et")} RETURN p.sid AS parent, c.doc AS doc, c.sid AS stored_id, c.ns AS stored_ns`,
        { iids: batch.map((i) => surrogateKey(ns, i)), ns, et: edgeType },
      );
      for (const row of res.rows) {
        const [doc] = docs([row]);
        if (doc === undefined) continue;
        const children = out.get(row.parent as string);
        if (children) children.push(doc);
        else out.set(row.parent as string, [doc]);
      }
    }
    return out;
  }

  async deleteEdgesTouchingByType(ns: string, label: string, id: string, type: string): Promise<void> {
    await this._run(
      `MATCH (t:${label} {id: $iid})-[r:${EDGE}]-(o) WHERE ${same("r", "ns", "ns")} AND ${same("r", "etype", "et")} DELETE r`,
      { iid: surrogateKey(ns, id), ns, et: type },
    );
  }
}
