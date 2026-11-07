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
  skip?: number;
  limit?: number;
}

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
}

export interface LLMClient {
  generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T>;
}

export interface Extractor {
  extract(document: ParsedDocument): Promise<Ontology>;
  /**
   * Return and clear warnings from the last extract call.
   *
   * @return (InsertWarning[]): the warnings.
   */
  popWarnings?(): InsertWarning[];
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
  removeNodeLabel(ns: string, label: string, id: string, dropLabel: string): Promise<void>;
  matchNodes(ns: string, label: string, options?: MatchNodesOptions): Promise<Props[]>;
  deleteNode(ns: string, label: string, id: string): Promise<void>;
  createEdge(
    ns: string,
    type: string,
    fromLabel: string,
    fromId: string,
    toLabel: string,
    toId: string,
    props: Props,
  ): Promise<boolean>;
  getCurrentEdge(ns: string, id: string): Promise<EdgeRow | null>;
  listEdgeVersions(ns: string, id: string): Promise<EdgeRow[]>;
  updateCurrentEdge(ns: string, id: string, props: Props): Promise<void>;
  deleteEdges(ns: string, id: string): Promise<number>;
  matchEdges(ns: string, options: MatchEdgesOptions): Promise<EdgeRow[]>;
  versionedRelationIds(
    ns: string,
    label: string,
    id: string,
    options: { exclude_types: readonly string[] },
  ): Promise<string[]>;
  childNodes(ns: string, parentLabel: string, parentId: string, edgeType: string, childLabel: string): Promise<Props[]>;
  countOutEdges(ns: string, label: string, id: string): Promise<number>;
  countInEdgesTyped(ns: string, label: string, id: string, types: readonly string[]): Promise<number>;
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
