import { contradictionTier, GraphAccess, seedTier } from "./access.js";
import { LLM_HINT, ValidationError } from "./errors.js";
import { checkPrompts } from "./extraction/prompts.js";
import { Insert } from "./insert.js";
import { pyStrip } from "./internal/py.js";
import { type LLMArg, resolveLlm } from "./llm/index.js";
import {
  asInput,
  type Coverage,
  type CypherResult,
  ExtractionInstructions,
  ExtractionPrompts,
  type JsonValue,
  type RetrievalResult,
} from "./models.js";
import type { Embedder, Extractor, GraphStore } from "./protocols.js";
import { type EntityResolver, type ResolverMode, resolverFor } from "./resolution.js";
import { Decisions, Entities, Maintenance, Preferences, Relations } from "./resources/index.js";
import { coverage, type RetrieveOptions, retrieve } from "./retrieval.js";
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
  requireSchemaForMode,
  requireSchemaMode,
  type Schema,
  type SchemaMode,
} from "./schema.js";
import { clamp, type ExtractionTier, type Level, PRESETS, requireLevel, requireTier, type SeedTier } from "./tiers.js";
import { checkOptions, keysOf, requireJsonMapping, requireNamespace, typeName } from "./validate.js";

export interface SelfGraphOptions {
  llm?: LLMArg;
  instructions?: ExtractionInstructions | null;
  prompts?: ExtractionPrompts | null;
  extractor?: Extractor | null;
  namespace?: string;
  schema?: Schema | ParsedSchema | null;
  schema_mode?: SchemaMode;
  resolver?: EntityResolver | ResolverMode | null;
  contradiction?: ContradictionMode | null;
  level?: Level;
  max_tier?: Level;
  extraction?: ExtractionTier | null;
  seeds?: SeedTier | null;
  embedder?: Embedder | null;
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
  level: true,
  max_tier: true,
  extraction: true,
  seeds: true,
  embedder: true,
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
  private readonly level: Level;
  private readonly extraction: string | null;
  private readonly resolution: string;

  /**
   * A knowledge graph over any GraphStore, initialized lazily on first use.
   *
   * @param store (GraphStore): the graph store.
   * @param options (SelfGraphOptions): the LLM, extraction instructions and prompts, a custom extractor, the namespace, an optional schema, the schema mode, the level that sets every capability's default tier, the max_tier cost cap, per-capability overrides (resolver, contradiction, extraction, seeds), and an embedder for embedding seeds.
   */
  constructor(store: GraphStore, options: SelfGraphOptions = {}) {
    checkOptions("SelfGraph", options, OPTION_KEYS);
    const namespace = options.namespace ?? DEFAULT_SETTINGS.namespace;
    requireNamespace(namespace);
    const schemaMode = options.schema_mode ?? "warn";
    requireSchemaMode(schemaMode);
    const level = options.level ?? "balanced";
    const maxTier = options.max_tier ?? "max";
    requireLevel("level", level);
    requireLevel("max_tier", maxTier);
    const llm = resolveLlm(options.llm);
    if (level === "max" && maxTier === "max" && llm === null)
      throw new ValidationError(`level 'max' needs an LLM: ${LLM_HINT}`);
    const embedder = options.embedder ?? null;
    if (embedder !== null && typeof (embedder as { embed?: unknown }).embed !== "function") {
      throw new ValidationError(`embedder must have an embed method, got ${typeName(embedder)}`);
    }
    const preset = PRESETS[level];
    const extractor = options.extractor ?? null;
    let extraction: string | null = options.extraction ?? null;
    if (extraction !== null) requireTier("extraction", extraction);
    else if (extractor === null) extraction = llm !== null ? "llm" : preset.extraction;
    if (extraction !== null) extraction = clamp("extraction", extraction, maxTier);
    if (extraction === "llm" && llm === null) throw new ValidationError(`extraction 'llm' needs an LLM: ${LLM_HINT}`);
    this.extraction = extraction === "spacy" ? "regex" : extraction;
    const seeds = options.seeds ?? (embedder !== null || preset.seeds !== "embeddings" ? preset.seeds : "synonyms");
    const seeding = seedTier(seeds, embedder, maxTier);
    const [resolution, resolver] = resolverFor(options.resolver ?? (preset.resolution as ResolverMode), llm, maxTier);
    const contradiction = contradictionTier(options.contradiction ?? preset.contradiction, llm, maxTier);
    const instructions = asInput(ExtractionInstructions, options.instructions, "instructions");
    const prompts = asInput(ExtractionPrompts, options.prompts, "prompts");
    checkPrompts(prompts);
    this.level = level;
    this.resolution = resolution;
    this.store = store;
    this.namespace = namespace;
    this.schema = asSchema(options.schema);
    requireSchemaForMode(schemaMode, this.schema);
    this.graph = new GraphAccess(store, namespace, this.schema, schemaMode, contradiction, {
      llm,
      max_tier: maxTier,
      seeds: seeding,
      strategy: preset.traversal,
      embedder,
      embeddings: new Map(),
    });
    this.entities = new Entities(this.graph);
    this.relations = new Relations(this.graph);
    this.preferences = new Preferences(this.graph);
    this.decisions = new Decisions(this.graph);
    this.maintenance = new Maintenance(this.graph);
    this.insert = new Insert(this.graph, {
      llm,
      resolver,
      resolver_tier: resolution,
      extraction: this.extraction,
      instructions,
      prompts,
      extractor,
    });
  }

  /**
   * The level and the tier each capability runs at by default, after the max_tier cap.
   *
   * @return (Record<string, string>): the level, the cap, and each capability's default tier.
   */
  get tiers(): Record<string, string> {
    return {
      level: this.level,
      max_tier: this.graph.tiers.max_tier,
      extraction: this.extraction ?? "custom",
      resolution: this.resolution,
      contradiction: this.graph.contradiction,
      seeds: this.graph.tiers.seeds,
      traversal: this.graph.tiers.strategy,
    };
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
   * @param options (RetrieveOptions): strategy ("bfs", "dfs", or "ppr"; the level's by default), seeds ("bm25", "synonyms" to also expand schema synonyms, or "embeddings" to fuse embedder similarity with BM25; the graph's tier by default), depth, k, max_nodes, budget_tokens, and as_of (read on the valid-time axis: relations and preferences valid then, with their entities).
   * @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
   */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
    return retrieve(this.graph, query, options);
  }

  /**
   * Report which words of a question the graph can ground, without an LLM.
   *
   * A content word is covered when a schema term names it (an entity type, relation type, or definition, by name, alias, or synonym) or when a stored entity's text holds it. Uncovered words mark what the graph cannot answer about.
   *
   * @param question (string): the natural-language question.
   * @return (Coverage): the matched terms, the covered and uncovered words, and the covered share.
   */
  async coverage(question: string): Promise<Coverage> {
    return coverage(this.graph, question);
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
    resolver: (settings.resolver || null) as ResolverMode | null,
    contradiction: (settings.contradiction || null) as ContradictionMode | null,
    level: (settings.level || "balanced") as Level,
    max_tier: (settings.max_tier || "max") as Level,
  });
}
