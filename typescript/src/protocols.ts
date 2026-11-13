import type { z } from "zod";

import type { CypherResult, InsertWarning, JsonValue, Ontology, ParsedDocument } from "./models.js";

export type Props = Record<string, unknown>;

export interface EdgeRow {
  props: Props;
  from_id: string;
  to_id: string;
  type: string;
}

export const DEFAULT_MATCH_LIMIT = 1000;

export interface MatchNodesOptions {
  equals?: Props | null;
  any_of?: Record<string, readonly unknown[]> | null;
  skip?: number;
  limit?: number;
  id_gt?: string | null;
}

export type NodeRow = readonly [id: string, props: Props];

export type EdgeWrite = readonly [type: string, fromId: string, toId: string, props: Props];

export interface UpsertNodeOptions {
  extra_label?: string | null;
}

export interface MatchEdgesOptions {
  from_label: string;
  to_label?: string | null;
  type?: string | null;
  from_id?: string | null;
  to_id?: string | null;
  from_in?: readonly string[] | null;
  to_in?: readonly string[] | null;
  current_only?: boolean;
  equals?: Props | null;
  skip?: number;
  limit?: number;
  id_gt?: string | null;
}

export interface LLMClient {
  /**
   * Return structured output for one prompt. Extraction calls this once per pass for each chunk (entities, relations, preferences, decisions), each with a different output schema, so the reply must match the schema it is given; a mismatch throws ExtractionError naming the pass.
   *
   * @param args ({ system: string; user: string; output: z.ZodType<T> }): the system prompt, the user prompt, and the zod schema the reply must parse with, such as one with a "relations" array.
   * @return (T): a value the output schema accepts.
   */
  generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T>;
}

export interface Extractor {
  extract(document: ParsedDocument): Promise<Ontology>;
  tier?: string;
  /**
   * Return and clear warnings from the last extract call.
   *
   * @return (InsertWarning[]): the warnings.
   */
  popWarnings?(): InsertWarning[];
}

export interface Embedder {
  /**
   * Return one vector per text, in order, all of one length.
   *
   * @param texts (string[]): the texts to embed.
   * @return (number[][]): the vectors.
   */
  embed(texts: string[]): Promise<number[][]>;
}

export interface GraphPrimitives {
  runCypher(query: string, params?: Record<string, JsonValue> | null): Promise<CypherResult>;
  getNode(ns: string, label: string, id: string): Promise<Props | null>;
  nodeExists(ns: string, label: string, id: string): Promise<boolean>;
  /**
   * Take a write lock on a node so concurrent read-modify-write updates serialize; a no-op on auto-commit stores.
   *
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param id (string): the node id.
   */
  lockNode(ns: string, label: string, id: string): Promise<void>;
  upsertNode(ns: string, label: string, id: string, props: Props, options?: UpsertNodeOptions): Promise<void>;
  /**
   * Merge many nodes of one label by id and set their properties, optionally adding a second label to each.
   *
   * @param ns (string): the namespace.
   * @param label (string): the primary label matched on.
   * @param rows (readonly NodeRow[]): (node id, properties) pairs.
   * @param options (UpsertNodeOptions): an additional label for every node.
   */
  upsertNodes(ns: string, label: string, rows: readonly NodeRow[], options?: UpsertNodeOptions): Promise<void>;
  removeNodeLabel(ns: string, label: string, id: string, dropLabel: string): Promise<void>;
  matchNodes(ns: string, label: string, options?: MatchNodesOptions): Promise<Props[]>;
  deleteNode(ns: string, label: string, id: string): Promise<void>;
  /**
   * Detach-delete many nodes of a label by id; unknown ids are skipped.
   *
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param ids (readonly string[]): the node ids.
   */
  deleteNodes(ns: string, label: string, ids: readonly string[]): Promise<void>;
  /**
   * Detach-delete the nodes of a label matching exact property values.
   *
   * @param ns (string): the namespace.
   * @param label (string): the node label.
   * @param equals (Props): property name to required value.
   * @return (number): the number of nodes deleted.
   */
  deleteNodesBy(ns: string, label: string, equals: Props): Promise<number>;
  createEdge(
    ns: string,
    type: string,
    fromLabel: string,
    fromId: string,
    toLabel: string,
    toId: string,
    props: Props,
  ): Promise<boolean>;
  /**
   * Create or update many directed typed edges between existing nodes, skipping rows with a missing endpoint.
   *
   * @param ns (string): the namespace.
   * @param fromLabel (string): the source node label.
   * @param toLabel (string): the destination node label.
   * @param rows (readonly EdgeWrite[]): (edge type, source id, destination id, properties) rows.
   */
  createEdges(ns: string, fromLabel: string, toLabel: string, rows: readonly EdgeWrite[]): Promise<void>;
  getCurrentEdge(ns: string, id: string): Promise<EdgeRow | null>;
  listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]>;
  updateCurrentEdge(ns: string, id: string, props: Props): Promise<void>;
  deleteEdges(ns: string, id: string): Promise<number>;
  matchEdges(ns: string, options: MatchEdgesOptions): Promise<EdgeRow[]>;
  childNodes(ns: string, parentLabel: string, parentId: string, edgeType: string, childLabel: string): Promise<Props[]>;
  deleteEdgesTouchingByType(ns: string, label: string, id: string, type: string): Promise<void>;
  /**
   * Reject an encoded write that exceeds a store size limit, before any prior state is mutated.
   *
   * @param props (Props): the encoded properties to write.
   */
  checkDocSize?(props: Props): void;
}

export interface GraphStore extends GraphPrimitives {
  /** Create the id constraints and any indexes the store needs. */
  initialize(): Promise<void>;
  /**
   * Group writes all-or-nothing, committing on success and rolling back on throw; auto-commit stores apply each write as it runs.
   *
   * @param fn ((tx: GraphPrimitives) => Promise<T>): the writes to run.
   * @return (T): the result of fn.
   */
  transaction<T>(fn: (tx: GraphPrimitives) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
