import { GraphAccess } from "./access.js";
import { ValidationError } from "./errors.js";
import { checkPrompts } from "./extraction/prompts.js";
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
import { asResolver, type EntityResolver, type ResolverMode } from "./resolution.js";
import { Decisions, Entities, Maintenance, Preferences, Relations } from "./resources/index.js";
import { type RetrieveOptions, retrieve } from "./retrieval.js";
import {
  buildLlm,
  buildStore,
  checkSettings,
  DEFAULT_SETTINGS,
  type GraphSettings,
  SETTING_KEYS,
  settingsFromEnv,
} from "./runtime.js";
import {
  asSchema,
  type ContradictionMode,
  type ParsedSchema,
  requireContradictionMode,
  requireSchemaForMode,
  requireSchemaMode,
  type Schema,
  type SchemaMode,
} from "./schema.js";
import { checkOptions, keysOf, requireJsonMapping, requireNamespace, typeName } from "./validate.js";

export interface SelfGraphOptions {
  llm?: LLMArg;
  instructions?: ExtractionInstructions | null;
  prompts?: ExtractionPrompts | null;
  extractor?: Extractor | null;
  namespace?: string;
  schema?: Schema | ParsedSchema | null;
  schema_mode?: SchemaMode;
  resolver?: EntityResolver | ResolverMode;
  contradiction?: ContradictionMode;
}

const OPTION_KEYS = keysOf<SelfGraphOptions>({
  llm: true,
  instructions: true,
  prompts: true,
  extractor: true,
  namespace: true,
  schema: true,
  schema_mode: true,
  resolver: true,
  contradiction: true,
});

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
  readonly maintenance: Maintenance;
  readonly insert: Insert;
  readonly schema: ParsedSchema | null;
  private readonly graph: GraphAccess;

  /**
   * A knowledge graph over any GraphStore, initialized lazily on first use.
   *
   * @param store (GraphStore): the graph store.
   * @param options (SelfGraphOptions): the LLM, extraction instructions and prompts, a custom extractor, the namespace, an optional schema, the schema mode, the entity resolver, and the contradiction mode.
   */
  constructor(store: GraphStore, options: SelfGraphOptions = {}) {
    checkOptions("SelfGraph", options, OPTION_KEYS);
    const namespace = options.namespace ?? DEFAULT_SETTINGS.namespace;
    requireNamespace(namespace);
    const schemaMode = options.schema_mode ?? "warn";
    requireSchemaMode(schemaMode);
    const contradiction = options.contradiction ?? "warn";
    requireContradictionMode(contradiction);
    this.store = store;
    this.namespace = namespace;
    this.schema = asSchema(options.schema);
    requireSchemaForMode(schemaMode, this.schema);
    this.graph = new GraphAccess(store, namespace, this.schema, schemaMode, contradiction);
    this.entities = new Entities(this.graph);
    this.relations = new Relations(this.graph);
    this.preferences = new Preferences(this.graph);
    this.decisions = new Decisions(this.graph);
    this.maintenance = new Maintenance(this.graph);
    const llm = resolveLlm(options.llm);
    const prompts = asInput(ExtractionPrompts, options.prompts, "prompts");
    checkPrompts(prompts);
    this.insert = new Insert(this.graph, {
      llm,
      resolver: asResolver(options.resolver ?? "exact", llm),
      instructions: asInput(ExtractionInstructions, options.instructions, "instructions"),
      prompts,
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
    checkOptions("connect", settings, SETTING_KEYS);
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
    if (typeof query !== "string") throw new ValidationError(`query must be a string, got ${typeName(query)}`);
    if (!pyStrip(query)) throw new ValidationError("query cannot be empty");
    requireJsonMapping("params", params, false);
    return this.graph.read((store) => store.runCypher(query, params));
  }

  /**
   * Retrieve graph context for a query via keyword seeds and bounded traversal.
   *
   * @param query (string): the natural-language query to seed from.
   * @param options (RetrieveOptions): strategy ("bfs", "dfs", or "ppr"), depth, k, max_nodes, budget_tokens, and as_of (read on the valid-time axis: relations and preferences valid then, with their entities).
   * @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
   */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    return retrieve(this.graph, query, options);
  }
}

/**
 * Construct a SelfGraph from settings; does not initialize the store.
 *
 * @param value (GraphSettings): the resolved store, LLM, and schema configuration.
 * @return (SelfGraph): the constructed graph.
 */
export function buildGraph(value: GraphSettings): SelfGraph {
  const settings = checkSettings(value);
  const namespace = settings.namespace ?? DEFAULT_SETTINGS.namespace;
  return new SelfGraph(buildStore(settings), {
    llm: buildLlm(settings),
    instructions: settings.instructions as ExtractionInstructions | null,
    prompts: settings.prompts as ExtractionPrompts | null,
    namespace,
    schema: settings.schema as ParsedSchema | null,
    schema_mode: (settings.schema_mode || "warn") as SchemaMode,
    resolver: (settings.resolver || "exact") as ResolverMode,
    contradiction: (settings.contradiction || "warn") as ContradictionMode,
  });
}
