import { TransientError } from "./errors.js";
import { Lazy } from "./internal/lazy.js";
import { sleep } from "./internal/time.js";
import type { GraphPrimitives, GraphStore } from "./protocols.js";

const MAX_TX_RETRIES = 12;
const TX_RETRY_BASE_DELAY_MS = 20;
const TX_RETRY_MAX_DELAY_MS = 1000;

export type GraphOp<T> = (store: GraphPrimitives, ns: string) => Promise<T>;

export class GraphAccess {
  private readonly ready: Lazy<void>;

  /**
   * One namespace of a store, initialized on first use, with reads and retried transactional writes.
   *
   * @param store (GraphStore): the graph store.
   * @param namespace (string): the namespace every read and write is scoped to.
   */
  constructor(
    readonly store: GraphStore,
    readonly namespace: string,
  ) {
    this.ready = new Lazy(() => store.initialize());
  }

  /**
   * Create the store's id constraints and indexes now instead of on first use.
   */
  async initialize(): Promise<void> {
    await this.store.initialize();
    this.ready.set(undefined);
  }

  /**
   * Run a read against the initialized store, scoped to the namespace.
   *
   * @param op (GraphOp<T>): the read.
   * @return (T): the read's result.
   */
  async read<T>(op: GraphOp<T>): Promise<T> {
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
