import { GraphAccess } from "./access.js";
import { ValidationError } from "./errors.js";
import { Insert } from "./insert.js";
import { pyStrip } from "./internal/py.js";
import { type LLMArg, resolveLlm } from "./llm/index.js";
import {
  asInput,
  type CypherResult,
  ExtractionInstructions,
  ExtractionPrompts,
  type JsonValue,
  type RetrievalResult,
} from "./models.js";
import type { Extractor, GraphStore } from "./protocols.js";
import { Decisions, Entities, Preferences, Relations } from "./resources/index.js";
import { type RetrieveOptions, retrieve } from "./retrieval.js";
import { buildLlm, buildStore, DEFAULT_SETTINGS, type GraphSettings, readJson, settingsFromEnv } from "./runtime.js";
import { asSchema, type ParsedSchema, requireSchemaMode, type Schema, type SchemaMode } from "./schema.js";
import { pyTypeName, requireJsonMapping, requireText } from "./validate.js";

export interface SelfGraphOptions {
  llm?: LLMArg;
  instructions?: ExtractionInstructions | null;
  prompts?: ExtractionPrompts | null;
  extractor?: Extractor | null;
  namespace?: string;
  schema?: Schema | ParsedSchema | null;
  schema_mode?: SchemaMode;
}

const asyncDispose: typeof Symbol.asyncDispose =
  (Symbol as { asyncDispose?: typeof Symbol.asyncDispose }).asyncDispose ??
  (Symbol.for("Symbol.asyncDispose") as typeof Symbol.asyncDispose);

export class SelfGraph {
  readonly store: GraphStore;
  readonly namespace: string;
  readonly entities: Entities;
  readonly relations: Relations;
  readonly preferences: Preferences;
  readonly decisions: Decisions;
  readonly insert: Insert;
  readonly schema: ParsedSchema | null;
  private readonly graph: GraphAccess;

  /**
   * A knowledge graph over any GraphStore, initialized lazily on first use.
   *
   * @param store (GraphStore): the graph store.
   * @param options (SelfGraphOptions): the LLM, extraction instructions and prompts, a custom extractor, the namespace, and an optional schema.
   */
  constructor(store: GraphStore, options: SelfGraphOptions = {}) {
    const namespace = options.namespace ?? DEFAULT_SETTINGS.namespace;
    requireText("namespace", namespace);
    const schemaMode = options.schema_mode ?? "warn";
    requireSchemaMode(schemaMode);
    this.store = store;
    this.namespace = namespace;
    this.schema = asSchema(options.schema);
    this.graph = new GraphAccess(store, namespace, this.schema, schemaMode);
    this.entities = new Entities(this.graph);
    this.relations = new Relations(this.graph);
    this.preferences = new Preferences(this.graph);
    this.decisions = new Decisions(this.graph);
    this.insert = new Insert(this.graph, {
      llm: resolveLlm(options.llm),
      instructions: asInput(ExtractionInstructions, options.instructions, "instructions"),
      prompts: asInput(ExtractionPrompts, options.prompts, "prompts"),
      extractor: options.extractor ?? null,
    });
  }

  /**
   * Build a graph from SELFGRAPH_* environment variables.
   *
   * @param overrides (Partial<GraphSettings>): settings that take precedence over the environment.
   * @return (SelfGraph): the constructed graph.
   */
  static fromEnv(overrides: Partial<GraphSettings> = {}): SelfGraph {
    return buildGraph(settingsFromEnv(overrides));
  }

  /**
   * Build a graph from store and LLM settings without importing a store class.
   *
   * @param settings (Partial<GraphSettings>): store, uri, auth, database, namespace, llm_*, schema, and schema_mode settings.
   * @return (SelfGraph): the constructed graph.
   */
  static connect(settings: Partial<GraphSettings> = {}): SelfGraph {
    return buildGraph({ ...DEFAULT_SETTINGS, ...settings });
  }

  /**
   * Create the store's id constraints and indexes; safe to call more than once.
   */
  async initialize(): Promise<void> {
    await this.graph.initialize();
  }

  /**
   * Close the store connection; later calls fail with StoreError rather than reopening it.
   */
  async close(): Promise<void> {
    await this.graph.close();
  }

  async [asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Run one raw Cypher statement verbatim as an unguarded escape hatch: it can write, ignores the namespace, and bypasses id derivation, versioning, and provenance.
   *
   * @param query (string): the Cypher statement.
   * @param params (Record<string, JsonValue> | null): the query parameters.
   * @return (CypherResult): the rows and counters.
   */
  async runCypher(query: string, params?: Record<string, JsonValue> | null): Promise<CypherResult> {
    if (typeof query !== "string") throw new ValidationError(`query must be a string, got ${pyTypeName(query)}`);
    if (!pyStrip(query)) throw new ValidationError("query cannot be empty");
    requireJsonMapping("params", params);
    return this.graph.read((store) => store.runCypher(query, params));
  }

  /**
   * Retrieve graph context for a query via keyword seeds and bounded traversal.
   *
   * @param query (string): the natural-language query to seed from.
   * @param options (RetrieveOptions): strategy ("bfs", "dfs", or "ppr"), depth, k, max_nodes, and budget_tokens.
   * @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
   */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    return retrieve(this.graph, query, options);
  }
}

/**
 * Construct a SelfGraph from settings; does not initialize the store.
 *
 * @param settings (GraphSettings): the resolved store, LLM, and schema configuration.
 * @return (SelfGraph): the constructed graph.
 */
export function buildGraph(settings: GraphSettings): SelfGraph {
  const namespace = settings.namespace ?? DEFAULT_SETTINGS.namespace;
  requireText("namespace", namespace);
  return new SelfGraph(buildStore(settings), {
    llm: buildLlm(settings),
    namespace,
    schema: typeof settings.schema === "string" ? (readJson(settings.schema) as Schema) : settings.schema,
    schema_mode: (settings.schema_mode || "warn") as SchemaMode,
  });
}
