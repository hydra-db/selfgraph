import { storedDataError } from "../errors.js";
import type { CypherRow } from "../models.js";
import type { EdgeRow, GraphPrimitives, Props } from "../protocols.js";

/** Read a stored JSON object or raise a coded error identifying its row. */
export function parseDoc(row: CypherRow): Props {
  try {
    const props = JSON.parse(row.doc as string);
    if (
      props === null ||
      typeof props !== "object" ||
      Array.isArray(props) ||
      (row.stored_id != null && props.id !== row.stored_id)
    )
      throw new Error();
    return props;
  } catch {
    throw storedDataError({ id: row.stored_id, ns: row.stored_ns });
  }
}

/**
 * The parsed document of the first row, or null when there is no row or its document is null.
 *
 * @param rows (CypherRow[]): the rows, each with a doc column.
 * @return (Props | null): the document.
 */
export function firstDoc(rows: CypherRow[]): Props | null {
  const doc = rows[0]?.doc;
  return doc == null ? null : parseDoc(rows[0]!);
}

/**
 * The parsed documents of the rows, skipping rows whose document is null.
 *
 * @param rows (CypherRow[]): the rows, each with a doc column.
 * @return (Props[]): the documents.
 */
export function docs(rows: CypherRow[]): Props[] {
  return rows.filter((r) => r.doc != null).map((r) => parseDoc(r));
}

/**
 * An edge row from a doc, fa (from id), tb (to id) and et (edge type) row.
 *
 * @param row (CypherRow): the row.
 * @return (EdgeRow): the edge.
 */
export function edgeRow(row: CypherRow): EdgeRow {
  return {
    props: row.doc != null ? parseDoc(row) : {},
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
