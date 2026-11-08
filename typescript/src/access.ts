import { StoreError, TransientError } from "./errors.js";
import { Lazy } from "./internal/lazy.js";
import { sleep } from "./internal/time.js";
import type { SchemaCheck } from "./ops.js";
import type { GraphPrimitives, GraphStore } from "./protocols.js";
import { enforceSchema, type ParsedSchema, type SchemaMode, warnSchema } from "./schema.js";

const MAX_TX_RETRIES = 12;
const TX_RETRY_BASE_DELAY_MS = 20;
const TX_RETRY_MAX_DELAY_MS = 1000;
const CLOSED_MESSAGE = "this SelfGraph is closed; create a new SelfGraph to keep using the store";

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
   */
  constructor(
    readonly store: GraphStore,
    readonly namespace: string,
    readonly schema: ParsedSchema | null = null,
    readonly schemaMode: SchemaMode = "warn",
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
   * Check a single entity or relation write against the graph schema, warning on stderr in warn mode.
   */
  readonly schemaCheck: SchemaCheck = async (runner, subject) => {
    warnSchema(await enforceSchema(runner, this.namespace, subject, this.schema, this.schemaMode, false));
  };

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
