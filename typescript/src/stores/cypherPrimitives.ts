import { AsyncLocalStorage } from "node:async_hooks";
import { ValidationError } from "../errors.js";
import { comparePy, pyStrip } from "../internal/py.js";
import type { CypherResult, CypherRow, JsonValue } from "../models.js";
import {
  DEFAULT_MATCH_LIMIT,
  type EdgeRow,
  type GraphPrimitives,
  type MatchEdgesOptions,
  type MatchNodesOptions,
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
 * The count column of the first row as an integer, or 0 when there is no row.
 *
 * @param rows (CypherResult["rows"]): the rows of a count query.
 * @param column (string): the count column.
 * @return (number): the count.
 */
export function toCount(rows: CypherResult["rows"], column = "n"): number {
  const row = rows[0];
  return row ? Math.trunc(Number(row[column])) : 0;
}

/**
 * Add one `alias.key = $eqN` clause per equality-filter entry, in sorted key order, and bind its parameter.
 *
 * @param alias (string): the node or relationship variable.
 * @param equals (Props | null | undefined): the property filter.
 * @param where (string[]): the clauses to extend.
 * @param params (Props): the parameters to extend.
 */
export function whereEquals(alias: string, equals: Props | null | undefined, where: string[], params: Props): void {
  sortedEntries(equals).forEach(([key, value], i) => {
    where.push(`${alias}.${key} = $eq${i}`);
    params[`eq${i}`] = value;
  });
}

/**
 * Bind each value as `$<prefix><i>` and build one clause per value.
 *
 * @param values (readonly string[]): the values to bind.
 * @param prefix (string): the parameter name prefix.
 * @param params (Props): the parameters to extend.
 * @param clause ((param: string) => string): builds the clause for one parameter reference.
 * @return (string[]): the clauses, in value order.
 */
export function bindList(
  values: readonly string[],
  prefix: string,
  params: Props,
  clause: (param: string) => string,
): string[] {
  return values.map((value, i) => {
    params[`${prefix}${i}`] = value;
    return clause(`$${prefix}${i}`);
  });
}

abstract class CypherRunner {
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

  async removeNodeLabel(ns: string, label: string, id: string, dropLabel: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) REMOVE n:${quoteLabel(dropLabel)}`, { id, ns });
  }

  async matchNodes(ns: string, label: string, options: MatchNodesOptions = {}): Promise<Props[]> {
    const { equals, skip = 0, limit = DEFAULT_MATCH_LIMIT } = options;
    const where = ["n.ns = $ns"];
    const params: Props = { ns, skip, limit };
    whereEquals("n", equals, where, params);
    const query = `MATCH (n:${label}) WHERE ${where.join(" AND ")} RETURN n ORDER BY n.id SKIP $skip LIMIT $limit`;
    const res = await this._run(query, params);
    return res.rows.map((r) => r.n as Props);
  }

  async deleteNode(ns: string, label: string, id: string): Promise<void> {
    await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) DETACH DELETE n`, { id, ns });
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
    const query =
      `MATCH (a:${from_label})-[r]->(b${blabel}) WHERE ${where.join(" AND ")} ` +
      `RETURN r, a.id AS from_e, b.id AS to_e, type(r) AS t ` +
      "ORDER BY r.id SKIP $skip LIMIT $limit";
    const res = await this._run(query, params);
    return res.rows.map(edgeRow);
  }

  async versionedRelationIds(
    ns: string,
    label: string,
    id: string,
    options: { exclude_types: readonly string[] },
  ): Promise<string[]> {
    const params: Props = { id, ns };
    const clauses = [
      "r.id IS NOT NULL",
      "r.revision IS NOT NULL",
      ...bindList(options.exclude_types, "ex", params, (p) => `type(r) <> ${p}`),
    ];
    const res = await this._run(
      `MATCH (x:${label} {id:$id, ns:$ns})-[r]-(o) WHERE ${clauses.join(" AND ")} RETURN DISTINCT r.id AS rid`,
      params,
    );
    return res.rows.map((r) => r.rid as string);
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

  async countOutEdges(ns: string, label: string, id: string): Promise<number> {
    const res = await this._run(`MATCH (p:${label} {id:$id, ns:$ns})-[r]->() RETURN count(r) AS n`, { id, ns });
    return toCount(res.rows);
  }

  async countInEdgesTyped(ns: string, label: string, id: string, types: readonly string[]): Promise<number> {
    const params: Props = { id, ns };
    const ors = bindList(types, "t", params, (p) => `type(r) = ${p}`);
    const res = await this._run(
      `MATCH (p)-[r]->(x:${label} {id:$id, ns:$ns}) WHERE ${ors.join(" OR ")} RETURN count(r) AS n`,
      params,
    );
    return toCount(res.rows);
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
