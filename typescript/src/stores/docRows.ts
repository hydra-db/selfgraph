import type { CypherRow } from "../models.js";
import type { EdgeRow, GraphPrimitives, Props } from "../protocols.js";

const parseDoc = (doc: unknown): Props => JSON.parse(doc as string) as Props;

/**
 * The parsed document of the first row, or null when there is no row or its document is null.
 *
 * @param rows (CypherRow[]): the rows, each with a doc column.
 * @return (Props | null): the document.
 */
export function firstDoc(rows: CypherRow[]): Props | null {
  const doc = rows[0]?.doc;
  return doc == null ? null : parseDoc(doc);
}

/**
 * The parsed documents of the rows, skipping rows whose document is null.
 *
 * @param rows (CypherRow[]): the rows, each with a doc column.
 * @return (Props[]): the documents.
 */
export function docs(rows: CypherRow[]): Props[] {
  return rows.filter((r) => r.doc != null).map((r) => parseDoc(r.doc));
}

/**
 * An edge row from a doc, fa (from id), tb (to id) and et (edge type) row.
 *
 * @param row (CypherRow): the row.
 * @return (EdgeRow): the edge.
 */
export function edgeRow(row: CypherRow): EdgeRow {
  return {
    props: row.doc != null ? parseDoc(row.doc) : {},
    from_id: row.fa as string,
    to_id: row.tb as string,
    type: row.et as string,
  };
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
