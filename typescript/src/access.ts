import { LLM_HINT, StoreError, TransientError, ValidationError } from "./errors.js";
import { Lazy } from "./internal/lazy.js";
import { sleep } from "./internal/time.js";
import type { RelationCap, SchemaCheck } from "./ops.js";
import type { Embedder, GraphPrimitives, GraphStore, LLMClient } from "./protocols.js";
import {
  type ContradictionMode,
  contradictionCaps,
  enforceSchema,
  type ParsedSchema,
  requireContradictionMode,
  type SchemaMode,
  warnSchema,
} from "./schema.js";
import { clamp, type Level, requireTier, type SeedTier } from "./tiers.js";

const MAX_TX_RETRIES = 12;
const TX_RETRY_BASE_DELAY_MS = 20;
const TX_RETRY_MAX_DELAY_MS = 1000;
const CLOSED_MESSAGE = "this SelfGraph is closed; create a new SelfGraph to keep using the store";

export interface TierSetup {
  llm: LLMClient | null;
  max_tier: Level;
  seeds: SeedTier;
  strategy: string;
  embedder: Embedder | null;
  embeddings: Map<string, readonly [string, number[]]>;
}

/**
 * Validate a contradiction mode and lower it to the cost cap.
 *
 * @param mode (unknown): "off", "warn", "supersede", or "llm".
 * @param llm (LLMClient | null): the graph's LLM, needed for "llm".
 * @param maxTier (Level): the cost cap.
 * @return (ContradictionMode): the mode to apply; throws ValidationError for llm without an LLM.
 */
export function contradictionTier(mode: unknown, llm: LLMClient | null, maxTier: Level): ContradictionMode {
  requireContradictionMode(mode);
  const tier = clamp("contradiction", mode as string, maxTier) as ContradictionMode;
  if (tier === "llm" && llm === null) throw new ValidationError(`contradiction 'llm' needs an LLM: ${LLM_HINT}`);
  return tier;
}

/**
 * Validate a seeding tier and lower it to the cost cap.
 *
 * @param seeds (unknown): "bm25", "synonyms", or "embeddings".
 * @param embedder (Embedder | null): the graph's embedder, needed for "embeddings".
 * @param maxTier (Level): the cost cap.
 * @return (SeedTier): the tier to seed with; throws ValidationError for embeddings without an embedder.
 */
export function seedTier(seeds: unknown, embedder: Embedder | null, maxTier: Level): SeedTier {
  requireTier("seeds", seeds);
  const tier = clamp("seeds", seeds, maxTier) as SeedTier;
  if (tier === "embeddings" && embedder === null) {
    throw new ValidationError("seeds 'embeddings' needs an embedder: pass embedder in the SelfGraph options");
  }
  return tier;
}

export type GraphOp<T> = (store: GraphPrimitives, ns: string) => Promise<T>;

export class GraphAccess {
  private readonly ready: Lazy<void>;
  private closed = false;

  /**
   * One namespace of a store, initialized on first use, with reads and retried transactional writes.
   *
   * @param store (GraphStore): the graph store.
   * @param namespace (string): the namespace every read and write is scoped to.
   * @param schema (ParsedSchema | null): the graph-level schema every write is checked against.
   * @param schemaMode (SchemaMode): how schema violations are handled: off, warn, or strict.
   * @param contradiction (ContradictionMode): how a contradicting relation is handled: off, warn, supersede, or llm.
   * @param tiers (TierSetup): the LLM, the cost cap, the default seeding tier and traversal, and the embedder with its vector cache.
   */
  constructor(
    readonly store: GraphStore,
    readonly namespace: string,
    readonly schema: ParsedSchema | null = null,
    readonly schemaMode: SchemaMode = "warn",
    readonly contradiction: ContradictionMode = "warn",
    readonly tiers: TierSetup = {
      llm: null,
      max_tier: "max",
      seeds: "bm25",
      strategy: "bfs",
      embedder: null,
      embeddings: new Map(),
    },
  ) {
    this.ready = new Lazy(() => store.initialize());
  }

  /**
   * Create the store's id constraints and indexes now instead of on first use.
   */
  async initialize(): Promise<void> {
    this.requireOpen();
    await this.store.initialize();
    this.ready.set(undefined);
  }

  /**
   * Close the store once; every later call fails with StoreError instead of reopening a connection.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.store.close?.();
  }

  /**
   * Check a single entity or relation write against the graph schema, warning on stderr in warn mode; for an update, the stored state before it is given so only new violations count.
   */
  readonly schemaCheck: SchemaCheck = async (runner, subject, before) => {
    warnSchema(
      await enforceSchema(runner, this.namespace, subject, this.schema, this.schemaMode, false, true, before ?? null),
    );
  };

  /**
   * Resolve a per-call contradiction mode against the graph's, lowered to the cost cap, and collect the schema's max_count limits.
   *
   * @param contradiction (ContradictionMode | null | undefined): the per-call mode, or null for the graph's.
   * @param schema (ParsedSchema | null): the schema the write is checked against.
   * @return ({ contradiction: ContradictionMode; caps: Map<string, RelationCap>; judged: boolean }): the mode the cardinality rules run at (supersede under llm), the limits by relation type, and whether the LLM then judges older rivals.
   */
  contradictionFor(
    contradiction: ContradictionMode | null | undefined,
    schema: ParsedSchema | null,
  ): { contradiction: ContradictionMode; caps: Map<string, RelationCap>; judged: boolean } {
    const mode =
      contradiction == null
        ? this.contradiction
        : contradictionTier(contradiction, this.tiers.llm, this.tiers.max_tier);
    const judged = mode === "llm";
    return { contradiction: judged ? "supersede" : mode, caps: contradictionCaps(schema), judged };
  }

  private requireOpen(): void {
    if (this.closed) throw new StoreError(CLOSED_MESSAGE);
  }

  /**
   * Run a read against the initialized store, scoped to the namespace.
   *
   * @param op (GraphOp<T>): the read.
   * @return (T): the read's result.
   */
  async read<T>(op: GraphOp<T>): Promise<T> {
    this.requireOpen();
    await this.ready.get();
    return op(this.store, this.namespace);
  }

  /**
   * Run a write in a transaction, retrying a TransientError with jittered exponential backoff.
   *
   * @param op (GraphOp<T>): the write, given the transaction and the namespace.
   * @return (T): the write's result.
   */
  async write<T>(op: GraphOp<T>): Promise<T> {
    this.requireOpen();
    await this.ready.get();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.store.transaction((tx) => op(tx, this.namespace));
      } catch (exc) {
        if (!(exc instanceof TransientError)) throw exc;
        if (attempt === MAX_TX_RETRIES - 1) {
          throw new TransientError(
            `write contention: could not commit after ${MAX_TX_RETRIES} retries; ` +
              "retry the write or serialize concurrent writers to this edge",
            { cause: exc },
          );
        }
        await sleep(Math.random() * Math.min(TX_RETRY_BASE_DELAY_MS * 2 ** attempt, TX_RETRY_MAX_DELAY_MS));
      }
    }
  }
}
