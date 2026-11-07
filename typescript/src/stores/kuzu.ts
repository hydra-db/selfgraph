import { errorMessage, StoreError } from "../errors.js";
import { Lazy } from "../internal/lazy.js";
import { loadOptional } from "../internal/optional.js";
import { pyJsonDumps, pyStr } from "../internal/py.js";
import type { CypherResult, JsonValue } from "../models.js";
import {
  DEFAULT_MATCH_LIMIT,
  type EdgeRow,
  type GraphStore,
  type MatchEdgesOptions,
  type MatchNodesOptions,
  type Props,
  type UpsertNodeOptions,
} from "../protocols.js";
import { AutoCommitStore, bindList, quoteLabel, sortedEntries, toCount } from "./cypherPrimitives.js";
import {
  deleteBothWays,
  docs,
  edgeRow,
  endpointsExist,
  firstDoc,
  mergedCurrentEdge,
  relationIdsBothWays,
} from "./docRows.js";

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
  query(statement: string): Promise<KuzuQueryResult | KuzuQueryResult[]>;
  prepare(statement: string): Promise<KuzuPreparedStatement>;
  execute(
    prepared: KuzuPreparedStatement,
    params: Record<string, unknown>,
  ): Promise<KuzuQueryResult | KuzuQueryResult[]>;
  close?(): Promise<void> | void;
}

interface KuzuDatabase {
  close?(): Promise<void> | void;
}

interface KuzuModule {
  Database: new (path: string) => KuzuDatabase;
  Connection: new (db: KuzuDatabase) => KuzuConnection;
}

const DATABASES = new Map<string, KuzuDatabase>();
const MAX_SKIP = 10_000_000;

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

const pk = (ns: string, id: string): string => `${ns}\x00${id}`;
const jv = (value: unknown): string => pyJsonDumps(value, { ensureAscii: false, default: pyStr });

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
    where.push(`json_extract(${alias}.doc, $k${i}) = $v${i}`);
    params[`k${i}`] = key;
    params[`v${i}`] = jv(value);
  });
}

export class KuzuStore extends AutoCommitStore implements GraphStore {
  private readonly path: string;
  private readonly conn = new Lazy<KuzuConnection>(async () => {
    const mod = await loadOptional<KuzuModule & { default?: KuzuModule }>(
      "kuzu",
      "the 'kuzu' package is required for KuzuStore; npm install kuzu",
      StoreError,
    );
    const kuzu = mod.default ?? mod;
    let db = DATABASES.get(this.path);
    if (db === undefined) {
      db = new kuzu.Database(this.path);
      DATABASES.set(this.path, db);
    }
    return new kuzu.Connection(db);
  });
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * An embedded, in-process Kuzu graph over a generic single-table schema.
   *
   * @param path (string): the database directory or file.
   */
  constructor(path = "selfgraph_kuzu") {
    super();
    this.path = path;
  }

  private async exec(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    const conn = await this.conn.get();
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
      return { columns, rows, counters: {} };
    } finally {
      res.close?.();
    }
  }

  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    const run = this.queue.then(() => this.exec(query, params));
    this.queue = run.catch(() => undefined);
    try {
      return await run;
    } catch (exc) {
      if (exc instanceof StoreError) throw exc;
      throw new StoreError(`Kuzu query failed: ${errorMessage(exc)}`, { cause: exc });
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
    const db = DATABASES.get(path);
    DATABASES.delete(path);
    await db?.close?.();
  }

  /** Close the connection; the database stays cached for other stores on the same path. */
  async close(): Promise<void> {
    await this.conn.release(async (conn) => {
      await this.queue;
      await conn.close?.();
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
    await this._run("MERGE (n:N {pk:$pk}) SET n.id = $id, n.ns = $ns, n.label = $label, n.doc = $doc", {
      pk: pk(ns, id),
      id,
      ns,
      label,
      doc: jv(props),
    });
  }

  async removeNodeLabel(): Promise<void> {}

  async matchNodes(ns: string, label: string, options: MatchNodesOptions = {}): Promise<Props[]> {
    const { equals, skip = 0, limit = DEFAULT_MATCH_LIMIT } = options;
    if (skip > MAX_SKIP) return [];
    const where = ["n.ns = $ns", "n.label = $label"];
    const params: Props = { ns, label };
    whereDocEquals("n", equals, where, params);
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

  async createEdge(
    ns: string,
    type: string,
    fromLabel: string,
    fromId: string,
    toLabel: string,
    toId: string,
    props: Props,
  ): Promise<boolean> {
    if (!(await endpointsExist(this, ns, fromLabel, fromId, toLabel, toId))) return false;
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
    const query =
      sid !== null && rev !== null
        ? "MATCH (a:N {pk:$f}), (b:N {pk:$t}) " +
          "MERGE (a)-[r:R {sid:$sid, ns:$ns, revision:$rev}]->(b) " +
          "SET r.etype=$et, r.is_current=$isc, r.doc=$doc"
        : "MATCH (a:N {pk:$f}), (b:N {pk:$t}) " +
          "CREATE (a)-[r:R {sid:$sid, ns:$ns, etype:$et, is_current:$isc, revision:$rev, doc:$doc}]->(b)";
    await this._run(query, params);
    return true;
  }

  async getCurrentEdge(ns: string, id: string): Promise<EdgeRow | null> {
    const res = await this._run(
      "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid AND r.is_current = true " +
        "RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et",
      { ns, sid: id },
    );
    const row = res.rows[0];
    return row ? edgeRow(row) : null;
  }

  async listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]> {
    const res = await this._run(
      "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid " +
        "RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et, r.revision AS rev ORDER BY rev",
      { ns, sid: id },
    );
    return res.rows.map(edgeRow);
  }

  async updateCurrentEdge(ns: string, id: string, props: Props): Promise<void> {
    const merged = await mergedCurrentEdge(this, ns, id, props);
    if (merged === null) return;
    await this._run(
      "MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid AND r.is_current = true " +
        "SET r.doc = $doc, r.is_current = $isc, r.revision = $rev",
      { ns, sid: id, doc: jv(merged), isc: merged.is_current ?? null, rev: merged.revision ?? null },
    );
  }

  private async countEdges(ns: string, id: string): Promise<number> {
    const res = await this._run("MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid RETURN count(*) AS n", {
      ns,
      sid: id,
    });
    return toCount(res.rows);
  }

  async deleteEdges(ns: string, id: string): Promise<number> {
    const n = await this.countEdges(ns, id);
    if (n) await this._run("MATCH (a:N)-[r:R]->(b:N) WHERE r.ns = $ns AND r.sid = $sid DELETE r", { ns, sid: id });
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
    const res = await this._run(
      `MATCH (a:N)-[r:R]->(b:N) WHERE ${where.join(" AND ")} ` +
        `RETURN r.doc AS doc, a.id AS fa, b.id AS tb, r.etype AS et ` +
        `ORDER BY r.sid SKIP ${intLiteral(skip)} LIMIT ${intLiteral(limit)}`,
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
    const params: Props = { pk: pk(ns, id), ns, label };
    const where = [
      "r.ns = $ns",
      "x.label = $label",
      "r.revision IS NOT NULL",
      ...bindList(options.exclude_types, "ex", params, (p) => `r.etype <> ${p}`),
    ];
    return relationIdsBothWays((q, p) => this._run(q, p), "x:N {pk:$pk}", "r:R", "o:N", where, params);
  }

  async childNodes(
    ns: string,
    _parentLabel: string,
    parentId: string,
    edgeType: string,
    childLabel: string,
  ): Promise<Props[]> {
    const res = await this._run(
      "MATCH (p:N {pk:$pk})-[r:R]->(c:N) " + "WHERE r.ns = $ns AND r.etype = $et AND c.label = $cl RETURN c.doc AS doc",
      { pk: pk(ns, parentId), ns, et: edgeType, cl: childLabel },
    );
    return docs(res.rows);
  }

  async countOutEdges(ns: string, _label: string, id: string): Promise<number> {
    const res = await this._run("MATCH (p:N {pk:$pk})-[r:R]->(o:N) WHERE r.ns = $ns RETURN count(*) AS n", {
      pk: pk(ns, id),
      ns,
    });
    return toCount(res.rows);
  }

  async countInEdgesTyped(ns: string, _label: string, id: string, types: readonly string[]): Promise<number> {
    const params: Props = { pk: pk(ns, id), ns };
    const ors = bindList(types, "t", params, (p) => `r.etype = ${p}`);
    const res = await this._run(
      `MATCH (p:N)-[r:R]->(x:N {pk:$pk}) WHERE r.ns = $ns AND (${ors.join(" OR ")}) RETURN count(*) AS n`,
      params,
    );
    return toCount(res.rows);
  }

  async deleteEdgesTouchingByType(ns: string, _label: string, id: string, type: string): Promise<void> {
    await deleteBothWays((q, p) => this._run(q, p), "t:N {pk:$pk}", "r:R", "o:N", { pk: pk(ns, id), ns, et: type });
  }
}
