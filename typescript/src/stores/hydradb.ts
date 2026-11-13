import { blake2b } from "@noble/hashes/blake2.js";
import type { Driver, Session } from "neo4j-driver";

import { errorMessage, OTHER_ENGINE_HINT, StoreError, TOKEN_HINT } from "../errors.js";
import { pyJsonDumps, pyRepr, pyStr, utf8 } from "../internal/py.js";
import type { CypherResult } from "../models.js";
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
import {
  type BoltStoreOptions,
  boltFailure,
  errorCode,
  openDriver,
  queryError,
  recordsToResult,
  toBoltParams,
} from "./bolt.js";
import { AutoCommitStore, quoteLabel, sortedEntries, toCount, whereAfter } from "./cypherPrimitives.js";
import { docs, edgeRow, firstDoc, mergedCurrentEdge } from "./docRows.js";

const EDGE = "RELATES";
const HANDSHAKE_RETRIES = 50;
const HANDSHAKE_JITTER_MS = 25;

const jitter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.random() * HANDSHAKE_JITTER_MS));
const MAX_STRING_BYTES = 32000;
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
 * Reject a write whose stored strings exceed the engine's per-string size limit.
 *
 * @param row (Props): the column names and values about to be written.
 */
function guardSizes(row: Props): void {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") continue;
    const size = utf8(value).length;
    if (size <= MAX_STRING_BYTES) continue;
    const field =
      key === "doc"
        ? "the serialized node or edge document (HydraDB stores each node or edge as one JSON document, " +
          "so its properties share this budget)"
        : `the string column ${pyRepr(key)}`;
    throw new StoreError(
      `HydraDB rejects ${field} at ${size} bytes; the engine limit is ${MAX_STRING_BYTES} bytes per stored string`,
    );
  }
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
    if (k === "id" || k === "ns") continue;
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

const removes = (alias: string, keys: readonly string[]): string => keys.map((k) => `${alias}.\`${k}\``).join(", ");

const docOf = (value: unknown): string => pyJsonDumps(value, { default: pyStr });

/**
 * An equality the engine applies as a filter rather than an index seek, for broad keys such as the namespace.
 *
 * @param alias (string): the node or relationship variable.
 * @param key (string): the property.
 * @param param (string): the parameter name.
 * @return (string): the predicate.
 */
const same = (alias: string, key: string, param: string): string => `NOT ${alias}.\`${key}\` <> $${param}`;

const BY_SID = `MATCH ()-[r:${EDGE} {sid: $sid}]->() WHERE ${same("r", "ns", "ns")}`;

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
    return `\`${key}\`: $eq${i}`;
  });
  return entries.length ? `${alias}:${label} {${entries.join(", ")}}` : `${alias}:${label}`;
}

/**
 * Group write rows by column set into batches, since an UNWIND write needs every row to carry the same fields.
 *
 * @param rows (Props[]): the rows to group.
 * @return (Props[][]): batches of at most WRITE_BATCH rows sharing one column set, in first-seen order.
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
    for (let i = 0; i < group.length; i += WRITE_BATCH) out.push(group.slice(i, i + WRITE_BATCH));
  }
  return out;
}

const sets = (alias: string, row: Props, skip: readonly string[]): string =>
  Object.keys(row)
    .sort()
    .filter((k) => !skip.includes(k))
    .map((k) => `${alias}.\`${k}\` = row.\`${k}\``)
    .join(", ");

export type HydraDBStoreOptions = BoltStoreOptions;

export class HydraDBStore extends AutoCommitStore implements GraphStore {
  private readonly driver: Driver;
  private readonly uri: string;
  private readonly database: string;
  private readonly hasAuth: boolean;

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
  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
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
      return new StoreError(`HydraDB needs a token: ${TOKEN_HINT}`, { cause: exc });
    const err = queryError(exc, this.uri, this.database, "HydraDB", (lowered) =>
      TRANSIENT_MARKERS.some((k) => lowered.includes(k)),
    );
    const lowered = `${errorCode(exc)} ${errorMessage(exc)}`.toLowerCase();
    if (OTHER_ENGINE_MARKERS.some((k) => lowered.includes(k))) {
      return new StoreError(`${err.message}; if this is Neo4j or Memgraph, ${OTHER_ENGINE_HINT}`, { cause: exc });
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
    const res = await this._run(`MATCH (n:${label} {id: $iid}) RETURN n.doc AS doc`, { iid: surrogateKey(ns, id) });
    return firstDoc(res.rows);
  }

  async nodeExists(ns: string, label: string, id: string): Promise<boolean> {
    const res = await this._run(`MATCH (n:${label} {id: $iid}) RETURN n.sid AS sid`, { iid: surrogateKey(ns, id) });
    return res.rows.length > 0;
  }

  /**
   * Reject an encoded write whose serialized document exceeds the engine's per-string limit, before any write.
   *
   * @param props (Props): the encoded node or edge properties about to be written.
   */
  checkDocSize(props: Props): void {
    guardSizes({ doc: docOf(props), ...scalars(props) });
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
    if (options.extra_label != null) quoteLabel(options.extra_label);
    const cleared = new Map<string, [string[], bigint[]]>();
    const key = sortKey(ns, label);
    const out = rows.map(([id, props]) => {
      const row: Props = {
        id: surrogateKey(ns, id),
        sid: id,
        ns,
        label,
        [key]: id,
        doc: docOf(props),
        ...scalars(props),
      };
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
    for (const batch of byColumns(out)) {
      await this._run(`UNWIND $rows AS row MERGE (n {id: row.id}) SET n:${label}, ${sets("n", batch[0]!, ["id"])}`, {
        rows: batch,
      });
    }
    for (const [keys, iids] of cleared.values()) {
      for (let i = 0; i < iids.length; i += DELETE_BATCH) {
        const params = { iids: iids.slice(i, i + DELETE_BATCH) };
        const held = await this._run(
          `MATCH (n:${label}) WHERE n.id IN $iids AND (${keys.map((k) => `n.\`${k}\` IS NOT NULL`).join(" OR ")}) RETURN n.sid AS sid`,
          params,
        );
        if (held.rows.length)
          await this._run(`MATCH (n:${label}) WHERE n.id IN $iids REMOVE ${removes("n", keys)}`, params);
      }
    }
  }

  async removeNodeLabel(ns: string, label: string, id: string, dropLabel: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id: $iid}) REMOVE n:${quoteLabel(dropLabel)}`, { iid: surrogateKey(ns, id) });
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
          `RETURN n.doc AS doc ORDER BY n.\`${key}\` SKIP $skip LIMIT $limit`,
        params,
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
      where.push(`n.\`${key}\` IN $in${i}`);
      params[`in${i}`] = [...(values as unknown[])];
    });
    whereAfter("n.sid", id_gt, where, params);
    const res = await this._run(
      `MATCH (${pattern}) WHERE ${where.join(" AND ")} ` +
        "RETURN n.doc AS doc, n.`sid` AS __ob ORDER BY __ob SKIP $skip LIMIT $limit",
      params,
    );
    return docs(res.rows);
  }

  async deleteNode(ns: string, label: string, id: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id: $iid}) DETACH DELETE n`, { iid: surrogateKey(ns, id) });
  }

  async deleteNodes(ns: string, _label: string, ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const iids = ids.slice(i, i + DELETE_BATCH).map((id) => surrogateKey(ns, id));
      await this._run("MATCH (n) WHERE n.id IN $iids DETACH DELETE n", { iids });
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
      if (ids.length) await this._run("MATCH (n) WHERE n.id IN $iids DETACH DELETE n", { iids: ids });
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
    const both = await this._run(`MATCH (a:${fromLabel} {id: $f}), (b:${toLabel} {id: $t}) RETURN a.sid AS sid`, {
      f: surrogateKey(ns, fromId),
      t: surrogateKey(ns, toId),
    });
    if (!both.rows.length) return false;
    await this.createEdges(ns, fromLabel, toLabel, [[type, fromId, toId, props]]);
    return true;
  }

  override async createEdges(
    ns: string,
    fromLabel: string,
    toLabel: string,
    rows: readonly EdgeWrite[],
  ): Promise<void> {
    const out = rows.map(([type, fromId, toId, props]) => {
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
      guardSizes(row);
      return row;
    });
    for (const batch of byColumns(out)) {
      await this._run(
        `UNWIND $rows AS row MATCH (a:${fromLabel} {id: row.f}), (b:${toLabel} {id: row.t}) ` +
          `MERGE (a)-[r:${EDGE} {id: row.id}]->(b) SET ${sets("r", batch[0]!, ["f", "t", "id"])}`,
        { rows: batch },
      );
    }
  }

  async getCurrentEdge(ns: string, id: string): Promise<EdgeRow | null> {
    const res = await this._run(
      `${BY_SID} AND r.is_current = true RETURN r.doc AS doc, r.fa AS fa, r.tb AS tb, r.etype AS et`,
      { ns, sid: id },
    );
    const row = res.rows[0];
    return row ? edgeRow(row) : null;
  }

  async listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]> {
    const res = await this._run(
      `${BY_SID} RETURN r.doc AS doc, r.fa AS fa, r.tb AS tb, r.etype AS et, r.revision AS rev ORDER BY rev`,
      { ns, sid: id },
    );
    return res.rows.map(edgeRow);
  }

  async updateCurrentEdge(ns: string, id: string, props: Props): Promise<void> {
    const merged = await mergedCurrentEdge(this, ns, id, props);
    if (merged === null) return;
    const assignments = ["r.doc = $doc"];
    const params: Props = { ns, sid: id, doc: docOf(merged) };
    for (const [k, v] of Object.entries(scalars(merged))) {
      assignments.push(`r.\`${k}\` = $s_${k}`);
      params[`s_${k}`] = v;
    }
    guardSizes(params);
    await this._run(`${BY_SID} AND r.is_current = true SET ${assignments.join(", ")}`, params);
    const keys = unset(merged);
    if (keys.length) await this._run(`${BY_SID} AND r.is_current = true REMOVE ${removes("r", keys)}`, { ns, sid: id });
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
    const anchored = fromAnchored || toAnchored;
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
    }
    filters.forEach(([key, value], i) => {
      where.push(anchored ? same("r", key, `eq${i}`) : `r.\`${key}\` = $eq${i}`);
      params[`eq${i}`] = value;
    });
    if (current_only) where.push(anchored ? "NOT r.is_current <> true" : "r.is_current = true");
    whereAfter("r.sid", id_gt, where, params);
    const res = await this._run(
      `MATCH (${apat})-[r:${EDGE}]->(${bpat}) WHERE ${where.join(" AND ")} ` +
        "RETURN r.doc AS doc, r.fa AS fa, r.tb AS tb, r.etype AS et, r.`sid` AS __ob " +
        "ORDER BY __ob SKIP $skip LIMIT $limit",
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
        `WHERE ${same("r", "ns", "ns")} AND ${same("r", "etype", "et")} RETURN c.doc AS doc`,
      { iid: surrogateKey(ns, parentId), ns, et: edgeType },
    );
    return docs(res.rows);
  }

  async deleteEdgesTouchingByType(ns: string, label: string, id: string, type: string): Promise<void> {
    await this._run(
      `MATCH (t:${label} {id: $iid})-[r:${EDGE}]-(o) WHERE ${same("r", "ns", "ns")} AND ${same("r", "etype", "et")} DELETE r`,
      { iid: surrogateKey(ns, id), ns, et: type },
    );
  }
}
