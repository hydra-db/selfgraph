import { AsyncLocalStorage } from "node:async_hooks";
import { STORE_CLOSED_MESSAGE, StoreError, ValidationError } from "../errors.js";
import { comparePy, pyStrip } from "../internal/py.js";
import type { CypherResult, CypherRow, JsonValue } from "../models.js";
import {
  DEFAULT_MATCH_LIMIT,
  type EdgeRow,
  type EdgeWrite,
  type GraphPrimitives,
  type MatchEdgesOptions,
  type MatchNodesOptions,
  type NodeRow,
  type Props,
  type UpsertNodeOptions,
} from "../protocols.js";

export type CounterName =
  | "nodesCreated"
  | "nodesDeleted"
  | "relationshipsCreated"
  | "relationshipsDeleted"
  | "propertiesSet"
  | "labelsAdded"
  | "labelsRemoved";

export const WRITE_COUNTER_NAMES: ReadonlyArray<readonly [CounterName, string]> = [
  ["nodesCreated", "nodes_created"],
  ["nodesDeleted", "nodes_deleted"],
  ["relationshipsCreated", "relationships_created"],
  ["relationshipsDeleted", "relationships_deleted"],
  ["propertiesSet", "properties_set"],
];

const WRITE_BATCH = 500;
const INTERNAL_PROPERTIES: ReadonlySet<string> = new Set(["_lock"]);

/**
 * The properties of a returned node or relationship, without SelfGraph's internal ones such as _lock.
 *
 * @param properties (Record<string, unknown>): the stored properties.
 * @return (Record<string, unknown>): the properties to return.
 */
export function graphProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !INTERNAL_PROPERTIES.has(key)));
}
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Render a name as a Cypher label, backtick-quoting it when it is not a plain identifier.
 *
 * @param name (string): the label or type name.
 * @return (string): the rendered Cypher label.
 */
export function quoteLabel(name: string): string {
  if (!name || !pyStrip(name)) throw new ValidationError("label / type names cannot be empty");
  if (IDENT.test(name)) return name;
  return `\`${name.replace(/`/g, "``")}\``;
}

/**
 * Sorted (key, value) pairs of an equality filter, sorted by key code point.
 *
 * @param equals (Props | null | undefined): the property filter.
 * @return (Array<[string, unknown]>): the sorted entries.
 */
export function sortedEntries(equals: Props | null | undefined): Array<[string, unknown]> {
  return Object.entries(equals ?? {}).sort(([a], [b]) => comparePy(a, b));
}

/**
 * Split keyed write rows into runs of at most WRITE_BATCH that share a key, in write order.
 *
 * @param rows (Iterable<readonly [K, Props]>): [key, row] pairs; a key change (compared as JSON) starts a new batch.
 * @return (Array<[K, Props[]]>): [key, rows] batches, one UNWIND statement each.
 */
export function writeBatches<K>(rows: Iterable<readonly [K, Props]>): Array<[K, Props[]]> {
  const batches: Array<[K, Props[]]> = [];
  let lastKey: string | undefined;
  for (const [key, row] of rows) {
    const json = JSON.stringify(key);
    const last = batches.at(-1);
    if (last === undefined || json !== lastKey || last[1].length >= WRITE_BATCH) batches.push([key, [row]]);
    else last[1].push(row);
    lastKey = json;
  }
  return batches;
}

/**
 * The n column of the first row as an integer, or 0 when there is no row.
 *
 * @param rows (CypherResult["rows"]): the rows of a count query.
 * @return (number): the count.
 */
export function toCount(rows: CypherResult["rows"]): number {
  const row = rows[0];
  return row ? Math.trunc(Number(row.n)) : 0;
}

/**
 * Add one `alias.key = $eqN` clause per equality-filter entry, in sorted key order, and bind its parameter.
 *
 * @param alias (string): the node or relationship variable.
 * @param equals (Props | null | undefined): the property filter.
 * @param where (string[]): the clauses to extend.
 * @param params (Props): the parameters to extend.
 */
function whereEquals(alias: string, equals: Props | null | undefined, where: string[], params: Props): void {
  sortedEntries(equals).forEach(([key, value], i) => {
    where.push(`${alias}.${key} = $eq${i}`);
    params[`eq${i}`] = value;
  });
}

/**
 * Add one `alias.key IN $inN` clause per membership-filter entry, in sorted key order, and bind its parameter.
 *
 * @param alias (string): the node or relationship variable.
 * @param anyOf (Record<string, readonly unknown[]> | null | undefined): property name to the accepted values.
 * @param where (string[]): the clauses to extend.
 * @param params (Props): the parameters to extend.
 */
function whereAnyOf(
  alias: string,
  anyOf: Record<string, readonly unknown[]> | null | undefined,
  where: string[],
  params: Props,
): void {
  sortedEntries(anyOf).forEach(([key, values], i) => {
    where.push(`${alias}.${key} IN $in${i}`);
    params[`in${i}`] = [...(values as unknown[])];
  });
}

/**
 * Add a `column > $id_gt` clause for keyset paging when idGt is given, and bind its parameter.
 *
 * @param column (string): the id column, qualified with its variable.
 * @param idGt (string | null | undefined): the id to resume after, or null for no clause.
 * @param where (string[]): the clauses to extend.
 * @param params (Props): the parameters to extend.
 */
export function whereAfter(column: string, idGt: string | null | undefined, where: string[], params: Props): void {
  if (idGt == null) return;
  where.push(`${column} > $id_gt`);
  params.id_gt = idGt;
}

abstract class CypherRunner {
  protected closed = false;

  /** Fail with a plain StoreError once the store is closed, instead of a driver error. */
  protected requireOpen(): void {
    if (this.closed) throw new StoreError(STORE_CLOSED_MESSAGE);
  }

  /**
   * Run one statement against the engine; subclasses implement it and every primitive goes through it.
   *
   * @param query (string): the Cypher statement.
   * @param params (Record<string, unknown> | null): the query parameters.
   * @return (CypherResult): the rows.
   */
  protected abstract _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult>;

  async runCypher(query: string, params?: Record<string, JsonValue> | null): Promise<CypherResult> {
    return this._run(query, params);
  }

  abstract upsertNode(ns: string, label: string, id: string, props: Props, options?: UpsertNodeOptions): Promise<void>;

  abstract createEdge(
    ns: string,
    type: string,
    fromLabel: string,
    fromId: string,
    toLabel: string,
    toId: string,
    props: Props,
  ): Promise<boolean>;

  async upsertNodes(
    ns: string,
    label: string,
    rows: readonly NodeRow[],
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    for (const [id, props] of rows) await this.upsertNode(ns, label, id, props, options);
  }

  async createEdges(ns: string, fromLabel: string, toLabel: string, rows: readonly EdgeWrite[]): Promise<void> {
    for (const [type, fromId, toId, props] of rows)
      await this.createEdge(ns, type, fromLabel, fromId, toLabel, toId, props);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: TypeScript requires an any[] rest parameter on mixin bases.
type AbstractConstructor<T> = abstract new (...args: any[]) => T;

export interface AutoCommit {
  lockNode(ns: string, label: string, id: string): Promise<void>;
  transaction<T>(this: GraphPrimitives, fn: (tx: GraphPrimitives) => Promise<T>): Promise<T>;
}

const inWrite = new AsyncLocalStorage<boolean>();
const writeQueues = new WeakMap<object, Promise<unknown>>();

/**
 * Make a store auto-commit: a transaction runs its writes directly on the store, one transaction at a time per store,
 * since an auto-commit backend cannot isolate a read-modify-write; lockNode is a no-op.
 *
 * @param Base (B): the class to extend.
 * @return (B & AbstractConstructor<AutoCommit>): the auto-commit subclass.
 */
export function autoCommit<B extends AbstractConstructor<object>>(Base: B): B & AbstractConstructor<AutoCommit> {
  abstract class AutoCommitted extends Base implements AutoCommit {
    async lockNode(_ns: string, _label: string, _id: string): Promise<void> {}

    async transaction<T>(this: GraphPrimitives, fn: (tx: GraphPrimitives) => Promise<T>): Promise<T> {
      if (inWrite.getStore()) return fn(this);
      const run = (writeQueues.get(this) ?? Promise.resolve()).then(() => inWrite.run(true, () => fn(this)));
      writeQueues.set(
        this,
        run.catch(() => undefined),
      );
      return run;
    }
  }
  return AutoCommitted;
}

export abstract class AutoCommitStore extends autoCommit(CypherRunner) {}

export abstract class CypherPrimitives extends CypherRunner implements GraphPrimitives {
  async getNode(ns: string, label: string, id: string): Promise<Props | null> {
    const res = await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) RETURN n`, { id, ns });
    const row = res.rows[0];
    return row ? (row.n as Props) : null;
  }

  async nodeExists(ns: string, label: string, id: string): Promise<boolean> {
    const res = await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) RETURN n.id AS id`, { id, ns });
    return res.rows.length > 0;
  }

  /**
   * Take a write lock by bumping a counter outside the entity's properties, forcing concurrent updates on the node to serialize or retry.
   *
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param id (string): the node id.
   */
  async lockNode(ns: string, label: string, id: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) SET n._lock = coalesce(n._lock, 0) + 1`, { id, ns });
  }

  async upsertNode(
    ns: string,
    label: string,
    id: string,
    props: Props,
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    const extra = options.extra_label != null ? `, n:${quoteLabel(options.extra_label)}` : "";
    await this._run(`MERGE (n:${label} {id:$id, ns:$ns}) SET n += $props${extra}`, { id, ns, props });
  }

  /**
   * Merge many nodes of one label by id, a batch per statement, and set their properties.
   *
   * @param ns (string): namespace.
   * @param label (string): the primary label matched on.
   * @param rows (readonly NodeRow[]): [node id, properties] pairs.
   * @param options (UpsertNodeOptions): an additional label to add to every node.
   */
  override async upsertNodes(
    ns: string,
    label: string,
    rows: readonly NodeRow[],
    options: UpsertNodeOptions = {},
  ): Promise<void> {
    const extra = options.extra_label != null ? `, n:${quoteLabel(options.extra_label)}` : "";
    for (const [, batch] of writeBatches(rows.map(([id, props]) => [null, { id, props }] as const))) {
      await this._run(`UNWIND $rows AS row MERGE (n:${label} {id: row.id, ns: $ns}) SET n += row.props${extra}`, {
        rows: batch,
        ns,
      });
    }
  }

  /**
   * Create or update many edges, a batch per statement and edge type, skipping rows with a missing endpoint.
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
    const keyed = rows.map(([type, fromId, toId, props]) => {
      const row = { f: fromId, t: toId, rid: props.id ?? null, rev: props.revision ?? null, props };
      return [[type, "id" in props && "revision" in props], row] as const;
    });
    const match = `UNWIND $rows AS row MATCH (a:${fromLabel} {id: row.f, ns: $ns}), (b:${toLabel} {id: row.t, ns: $ns}) `;
    for (const [[type, versioned], batch] of writeBatches(keyed)) {
      const rel = quoteLabel(type);
      const write = versioned
        ? `MERGE (a)-[r:${rel} {id: row.rid, ns: $ns, revision: row.rev}]->(b)`
        : `CREATE (a)-[r:${rel}]->(b)`;
      await this._run(`${match}${write} SET r += row.props`, { rows: batch, ns });
    }
  }

  async removeNodeLabel(ns: string, label: string, id: string, dropLabel: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) REMOVE n:${quoteLabel(dropLabel)}`, { id, ns });
  }

  async matchNodes(ns: string, label: string, options: MatchNodesOptions = {}): Promise<Props[]> {
    const { equals, any_of, skip = 0, limit = DEFAULT_MATCH_LIMIT, id_gt } = options;
    const where = ["n.ns = $ns"];
    const params: Props = { ns, skip, limit };
    whereEquals("n", equals, where, params);
    whereAnyOf("n", any_of, where, params);
    whereAfter("n.id", id_gt, where, params);
    const query = `MATCH (n:${label}) WHERE ${where.join(" AND ")} RETURN n ORDER BY n.id SKIP $skip LIMIT $limit`;
    const res = await this._run(query, params);
    return res.rows.map((r) => r.n as Props);
  }

  async deleteNode(ns: string, label: string, id: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) DETACH DELETE n`, { id, ns });
  }

  async deleteNodes(ns: string, label: string, ids: readonly string[]): Promise<void> {
    if (ids.length)
      await this._run(`MATCH (n:${label}) WHERE n.ns = $ns AND n.id IN $ids DETACH DELETE n`, { ns, ids });
  }

  async deleteNodesBy(ns: string, label: string, equals: Props): Promise<number> {
    const where = ["n.ns = $ns"];
    const params: Props = { ns };
    whereEquals("n", equals, where, params);
    const count = await this._run(`MATCH (n:${label}) WHERE ${where.join(" AND ")} RETURN count(n) AS n`, params);
    const n = toCount(count.rows);
    if (n) await this._run(`MATCH (n:${label}) WHERE ${where.join(" AND ")} DETACH DELETE n`, params);
    return n;
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
    const match = `MATCH (a:${fromLabel} {id:$from, ns:$ns}), (b:${toLabel} {id:$to, ns:$ns}) `;
    const params: Record<string, unknown> = { from: fromId, to: toId, ns, props };
    let write: string;
    if ("id" in props && "revision" in props) {
      write =
        `MERGE (a)-[r:${quoteLabel(type)} {id:$rid, ns:$ns, revision:$rev}]->(b) ` +
        "SET r += $props RETURN r.id AS id";
      params.rid = props.id;
      params.rev = props.revision;
    } else {
      write = `CREATE (a)-[r:${quoteLabel(type)}]->(b) SET r += $props RETURN r.id AS id`;
    }
    const res = await this._run(match + write, params);
    return res.rows.length > 0;
  }

  async getCurrentEdge(ns: string, id: string): Promise<EdgeRow | null> {
    const res = await this._run(
      "MATCH (a)-[r {id:$id, ns:$ns}]->(b) WHERE r.is_current = true " +
        "RETURN r, a.id AS from_e, b.id AS to_e, type(r) AS t",
      { id, ns },
    );
    const row = res.rows[0];
    return row ? edgeRow(row) : null;
  }

  async listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]> {
    const res = await this._run(
      "MATCH (a)-[r {id:$id, ns:$ns}]->(b) RETURN r, a.id AS from_e, b.id AS to_e, type(r) AS t ORDER BY r.revision",
      { id, ns },
    );
    return res.rows.map(edgeRow);
  }

  async updateCurrentEdge(ns: string, id: string, props: Props): Promise<void> {
    await this._run("MATCH ()-[r {id:$id, ns:$ns}]->() WHERE r.is_current = true SET r += $props", { id, ns, props });
  }

  private async countEdges(ns: string, id: string): Promise<number> {
    const res = await this._run("MATCH ()-[r {id:$id, ns:$ns}]->() RETURN count(r) AS n", { id, ns });
    return toCount(res.rows);
  }

  async deleteEdges(ns: string, id: string): Promise<number> {
    const n = await this.countEdges(ns, id);
    if (n) await this._run("MATCH ()-[r {id:$id, ns:$ns}]->() DELETE r", { id, ns });
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
    const blabel = to_label ? `:${to_label}` : "";
    const where = ["r.ns = $ns"];
    const params: Props = { ns, skip, limit };
    if (current_only) where.push("r.is_current = true");
    if (from_id != null) {
      where.push("a.id = $from_e");
      params.from_e = from_id;
    }
    if (to_id != null) {
      where.push("b.id = $to_e");
      params.to_e = to_id;
    }
    if (from_in != null) {
      where.push("a.id IN $from_in");
      params.from_in = [...from_in];
    }
    if (to_in != null) {
      where.push("b.id IN $to_in");
      params.to_in = [...to_in];
    }
    if (type != null) {
      where.push("type(r) = $etype");
      params.etype = type;
    }
    whereEquals("r", equals, where, params);
    whereAfter("r.id", id_gt, where, params);
    const query =
      `MATCH (a:${from_label})-[r]->(b${blabel}) WHERE ${where.join(" AND ")} ` +
      `RETURN r, a.id AS from_e, b.id AS to_e, type(r) AS t ` +
      "ORDER BY r.id SKIP $skip LIMIT $limit";
    const res = await this._run(query, params);
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
      `MATCH (p:${parentLabel} {id:$id, ns:$ns})-[:${edgeType}]->(c:${childLabel}) RETURN c`,
      { id: parentId, ns },
    );
    return res.rows.map((r) => r.c as Props);
  }

  async deleteEdgesTouchingByType(ns: string, label: string, id: string, type: string): Promise<void> {
    await this._run(`MATCH (t:${label} {id:$id, ns:$ns}) MATCH (x)-[e:${type}]-(t) DELETE e`, { id, ns });
  }
}

/**
 * An edge from an r, from_e (from id), to_e (to id) and t (edge type) row.
 *
 * @param row (CypherRow): the row.
 * @return (EdgeRow): the edge.
 */
function edgeRow(row: CypherRow): EdgeRow {
  return {
    props: row.r as Props,
    from_id: row.from_e as string,
    to_id: row.to_e as string,
    type: row.t as string,
  };
}
