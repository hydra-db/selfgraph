import type { CypherResult, CypherRow } from "../models.js";
import type { EdgeRow, GraphPrimitives, Props } from "../protocols.js";

type Row = CypherRow;
type Run = (query: string, params: Props) => Promise<CypherResult>;

const parseDoc = (doc: unknown): Props => JSON.parse(doc as string) as Props;

/**
 * The parsed document of the first row, or null when there is no row or its document is null.
 *
 * @param rows (Row[]): the rows, each with a doc column.
 * @return (Props | null): the document.
 */
export function firstDoc(rows: Row[]): Props | null {
  const doc = rows[0]?.doc;
  return doc == null ? null : parseDoc(doc);
}

/**
 * The parsed documents of the rows, skipping rows whose document is null.
 *
 * @param rows (Row[]): the rows, each with a doc column.
 * @return (Props[]): the documents.
 */
export function docs(rows: Row[]): Props[] {
  return rows.filter((r) => r.doc != null).map((r) => parseDoc(r.doc));
}

/**
 * An edge row from a doc, fa (from id), tb (to id) and et (edge type) row.
 *
 * @param row (Row): the row.
 * @return (EdgeRow): the edge.
 */
export function edgeRow(row: Row): EdgeRow {
  return {
    props: row.doc != null ? parseDoc(row.doc) : {},
    from_id: row.fa as string,
    to_id: row.tb as string,
    type: row.et as string,
  };
}

/**
 * The outgoing and incoming relationship patterns between a node and its neighbour, in that order.
 *
 * @param node (string): the anchored node pattern body.
 * @param rel (string): the relationship pattern body.
 * @param other (string): the neighbour pattern body.
 * @return ([string, string]): the two patterns.
 */
function bothWays(node: string, rel: string, other: string): [string, string] {
  return [`(${node})-[${rel}]->(${other})`, `(${other})-[${rel}]->(${node})`];
}

/**
 * The distinct r.sid values of the relationships matching in either direction, in first-seen order.
 *
 * @param run (Run): runs one statement.
 * @param node (string): the anchored node pattern body.
 * @param rel (string): the relationship pattern body, binding r.
 * @param other (string): the neighbour pattern body.
 * @param where (string[]): the WHERE clauses.
 * @param params (Props): the query parameters.
 * @return (string[]): the relationship ids.
 */
export async function relationIdsBothWays(
  run: Run,
  node: string,
  rel: string,
  other: string,
  where: string[],
  params: Props,
): Promise<string[]> {
  const out = new Set<string>();
  for (const pattern of bothWays(node, rel, other)) {
    const res = await run(`MATCH ${pattern} WHERE ${where.join(" AND ")} RETURN DISTINCT r.sid AS rid`, params);
    for (const r of res.rows) out.add(r.rid as string);
  }
  return [...out];
}

/**
 * Delete the relationships with r.ns = $ns and r.etype = $et in either direction.
 *
 * @param run (Run): runs one statement.
 * @param node (string): the anchored node pattern body.
 * @param rel (string): the relationship pattern body, binding r.
 * @param other (string): the neighbour pattern body.
 * @param params (Props): the query parameters, with ns and et.
 */
export async function deleteBothWays(run: Run, node: string, rel: string, other: string, params: Props): Promise<void> {
  for (const pattern of bothWays(node, rel, other)) {
    await run(`MATCH ${pattern} WHERE r.ns = $ns AND r.etype = $et DELETE r`, params);
  }
}

/**
 * Whether both edge endpoints exist, checking the source first.
 *
 * @param store (GraphPrimitives): the store.
 * @param ns (string): the namespace.
 * @param fromLabel (string): the source label.
 * @param fromId (string): the source id.
 * @param toLabel (string): the target label.
 * @param toId (string): the target id.
 * @return (boolean): true when both exist.
 */
export async function endpointsExist(
  store: GraphPrimitives,
  ns: string,
  fromLabel: string,
  fromId: string,
  toLabel: string,
  toId: string,
): Promise<boolean> {
  return (await store.nodeExists(ns, fromLabel, fromId)) && (await store.nodeExists(ns, toLabel, toId));
}

/**
 * The current edge's properties with the update applied, or null when there is no current edge.
 *
 * @param store (GraphPrimitives): the store.
 * @param ns (string): the namespace.
 * @param id (string): the edge id.
 * @param props (Props): the properties to apply.
 * @return (Props | null): the merged properties.
 */
export async function mergedCurrentEdge(
  store: GraphPrimitives,
  ns: string,
  id: string,
  props: Props,
): Promise<Props | null> {
  const current = await store.getCurrentEdge(ns, id);
  return current === null ? null : { ...current.props, ...props };
}
