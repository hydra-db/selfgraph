import { blake2b } from "@noble/hashes/blake2.js";
import type { Driver, Session } from "neo4j-driver";

import { errorMessage, StoreError, TransientError } from "../errors.js";
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
import { type BoltStoreOptions, errorCode, openDriver, recordsToResult, toBoltParams } from "./bolt.js";
import { AutoCommitStore, bindList, quoteLabel, sortedEntries, toCount } from "./cypherPrimitives.js";
import { docs, edgeRow, firstDoc, mergedCurrentEdge } from "./docRows.js";

const EDGE = "RELATES";
const HANDSHAKE_RETRIES = 50;
const HANDSHAKE_JITTER_MS = 25;

const jitter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.random() * HANDSHAKE_JITTER_MS));
const MAX_STRING_BYTES = 32000;
const WRITE_BATCH = 1000;
const DELETE_BATCH = 1024;
const TRANSIENT_MARKERS = ["snapshot", "epoch", "transient", "serializ", "conflict", "lock"];

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

function scalars(props: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "id" || k === "ns") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

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

const BY_SID = `MATCH (a)-[r:${EDGE} {sid: $sid}]->(b) WHERE ${same("r", "ns", "ns")}`;

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
  private readonly database: string;

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
    this.database = database || "default";
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
      const message = errorMessage(exc);
      const lowered = `${errorCode(exc)} ${message}`.toLowerCase();
      if (TRANSIENT_MARKERS.some((k) => lowered.includes(k))) {
        throw new TransientError(`HydraDB transaction conflict: ${message}`, { cause: exc });
      }
      throw new StoreError(`HydraDB query failed: ${message}`, { cause: exc });
    }
  }

  /**
   * Open a first pooled connection, retrying the split handshake with jitter; later queries reuse it.
   */
  async initialize(): Promise<void> {
    try {
      await withHandshakeRetry(() => this.driver.verifyConnectivity({ database: this.database }));
    } catch (exc) {
      throw new StoreError(`HydraDB connection failed: ${errorMessage(exc)}`, { cause: exc });
    }
  }

  async close(): Promise<void> {
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
    const out = rows.map(([id, props]) => {
      const row: Props = { id: surrogateKey(ns, id), sid: id, ns, label, doc: docOf(props), ...scalars(props) };
      guardSizes(row);
      return row;
    });
    for (const batch of byColumns(out)) {
      await this._run(`UNWIND $rows AS row MERGE (n {id: row.id}) SET n:${label}, ${sets("n", batch[0]!, ["id"])}`, {
        rows: batch,
      });
    }
  }

  async removeNodeLabel(ns: string, label: string, id: string, dropLabel: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id: $iid}) REMOVE n:${quoteLabel(dropLabel)}`, { iid: surrogateKey(ns, id) });
  }

  async matchNodes(ns: string, label: string, options: MatchNodesOptions = {}): Promise<Props[]> {
    const { equals, any_of, skip = 0, limit = DEFAULT_MATCH_LIMIT } = options;
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
      where = [equals && Object.keys(equals).length ? same("n", "ns", "ns") : "n.ns = $ns"];
    }
    sortedEntries(any_of).forEach(([key, values], i) => {
      if (key === "id") return;
      where.push(`n.\`${key}\` IN $in${i}`);
      params[`in${i}`] = [...(values as unknown[])];
    });
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

  async deleteNodesBy(ns: string, label: string, equals: Props): Promise<number> {
    const params: Props = { ns, batch: DELETE_BATCH };
    const pattern = keyed("n", label, equals, params);
    const where = Object.keys(equals).length ? same("n", "ns", "ns") : "n.ns = $ns";
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
      `${BY_SID} AND r.is_current = true RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et`,
      { ns, sid: id },
    );
    const row = res.rows[0];
    return row ? edgeRow(row) : null;
  }

  async listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]> {
    const res = await this._run(
      `${BY_SID} RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et, r.revision AS rev ORDER BY rev`,
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
    const anchored = where.length > 0 || from_id != null || to_id != null;
    const filters: Array<[string, unknown]> = [
      ["ns", ns],
      ...(type != null ? ([["etype", type]] as Array<[string, unknown]>) : []),
      ...sortedEntries(equals),
    ];
    filters.forEach(([key, value], i) => {
      where.push(anchored ? same("r", key, `eq${i}`) : `r.\`${key}\` = $eq${i}`);
      params[`eq${i}`] = value;
    });
    if (current_only) where.push("r.is_current = true");
    const res = await this._run(
      `MATCH (${apat})-[r:${EDGE}]->(${bpat}) WHERE ${where.join(" AND ")} ` +
        "RETURN r.doc AS doc, a.sid AS fa, b.sid AS tb, r.etype AS et, r.`sid` AS __ob " +
        "ORDER BY __ob SKIP $skip LIMIT $limit",
      params,
    );
    return res.rows.map(edgeRow);
  }

  async versionedRelationIds(
    ns: string,
    label: string,
    id: string,
    options: { exclude_types: readonly string[] },
  ): Promise<string[]> {
    const params: Props = { iid: surrogateKey(ns, id), ns };
    const where = [
      same("r", "ns", "ns"),
      "r.revision IS NOT NULL",
      ...bindList(options.exclude_types, "ex", params, (p) => `r.etype <> ${p}`),
    ];
    const res = await this._run(
      `MATCH (x:${label} {id: $iid})-[r:${EDGE}]-(o) WHERE ${where.join(" AND ")} RETURN DISTINCT r.sid AS rid`,
      params,
    );
    return [...new Set(res.rows.map((r) => r.rid as string))];
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
        `WHERE ${same("r", "ns", "ns")} AND r.etype = $et RETURN c.doc AS doc`,
      { iid: surrogateKey(ns, parentId), ns, et: edgeType },
    );
    return docs(res.rows);
  }

  async countOutEdges(ns: string, label: string, id: string): Promise<number> {
    const res = await this._run(
      `MATCH (p:${label} {id: $iid})-[r:${EDGE}]->(o) WHERE ${same("r", "ns", "ns")} RETURN count(*) AS n`,
      { iid: surrogateKey(ns, id), ns },
    );
    return toCount(res.rows);
  }

  async countInEdgesTyped(ns: string, label: string, id: string, types: readonly string[]): Promise<number> {
    const params: Props = { iid: surrogateKey(ns, id), ns };
    const ors = bindList(types, "t", params, (p) => `r.etype = ${p}`);
    const res = await this._run(
      `MATCH (p)-[r:${EDGE}]->(x:${label} {id: $iid}) WHERE ${same("r", "ns", "ns")} AND (${ors.join(" OR ")}) ` +
        "RETURN count(*) AS n",
      params,
    );
    return toCount(res.rows);
  }

  async deleteEdgesTouchingByType(ns: string, label: string, id: string, type: string): Promise<void> {
    await this._run(
      `MATCH (t:${label} {id: $iid})-[r:${EDGE}]-(o) WHERE ${same("r", "ns", "ns")} AND r.etype = $et DELETE r`,
      { iid: surrogateKey(ns, id), ns, et: type },
    );
  }
}
