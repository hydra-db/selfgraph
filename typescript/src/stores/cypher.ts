import neo4j, { type Config, type Driver, type Session, type Transaction } from "neo4j-driver";

import { errorMessage, type SelfGraphError, StoreError, TransientError } from "../errors.js";
import { sleep } from "../internal/time.js";
import type { CypherResult } from "../models.js";
import type { GraphPrimitives, GraphStore } from "../protocols.js";
import { LABELS } from "../schema.js";
import { type BoltStoreOptions, boltAuth, errorCode, recordsToResult, toBoltParams } from "./bolt.js";
import { CypherPrimitives } from "./cypherPrimitives.js";

const INIT_ATTEMPTS = 5;
const INIT_BASE_DELAY_MS = 50;

/**
 * Map a Bolt driver error to a library error; lost races and retryable conflicts, including a post-check uniqueness violation, become TransientError.
 *
 * @param exc (unknown): the driver error.
 * @return (SelfGraphError): the library error.
 */
function translateCypherError(exc: unknown): SelfGraphError {
  const message = errorMessage(exc);
  const lowered = `${errorCode(exc)} ${message}`.toLowerCase();
  const isConflict =
    lowered.includes("constraintvalidationfailed") ||
    (lowered.includes("constraint") && (lowered.includes("unique") || lowered.includes("already exists")));
  const transient = ["transient", "serializ", "conflicting transactions", "cannot get"].some((k) =>
    lowered.includes(k),
  );
  if (isConflict || transient) return new TransientError(`Cypher transaction conflict: ${message}`, { cause: exc });
  return new StoreError(`Cypher query failed: ${message}`, { cause: exc });
}

export type CypherStoreOptions = BoltStoreOptions;

class CypherWriter extends CypherPrimitives {
  constructor(private readonly tx: Transaction) {
    super();
  }

  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    try {
      return await recordsToResult(this.tx.run(query, toBoltParams(params)));
    } catch (exc) {
      throw translateCypherError(exc);
    }
  }
}

export class CypherStore extends CypherPrimitives implements GraphStore {
  protected readonly driver: Driver;
  protected readonly database: string | null;

  /**
   * A store for the Bolt and openCypher family (Neo4j, Memgraph, and compatible engines).
   *
   * @param uri (string): the Bolt URI, e.g. bolt://localhost:7687.
   * @param options (CypherStoreOptions): auth as [user, password] or a driver token, an optional database, and any neo4j-driver config.
   */
  constructor(uri: string, options: CypherStoreOptions = {}) {
    super();
    const { auth, database, ...config } = options;
    const withQuietNotifications: Config = {
      notificationFilter: { minimumSeverityLevel: "OFF" },
      ...config,
    };
    this.driver = neo4j.driver(uri, boltAuth(auth), withQuietNotifications);
    this.database = database ?? null;
  }

  protected session(): Session {
    return this.database ? this.driver.session({ database: this.database }) : this.driver.session();
  }

  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    const session = this.session();
    try {
      return await recordsToResult(session.run(query, toBoltParams(params)));
    } catch (exc) {
      throw translateCypherError(exc);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Create the id and namespace uniqueness constraints on every graph-schema label, retrying lost races. */
  async initialize(): Promise<void> {
    for (const label of LABELS) {
      const query =
        `CREATE CONSTRAINT selfgraph_${label.toLowerCase()}_id IF NOT EXISTS ` +
        `FOR (n:${label}) REQUIRE (n.id, n.ns) IS UNIQUE`;
      for (let attempt = 0; ; attempt++) {
        const session = this.session();
        try {
          await session.run(query);
          break;
        } catch (exc) {
          const err = translateCypherError(exc);
          if (err instanceof TransientError && attempt < INIT_ATTEMPTS - 1) {
            await sleep(INIT_BASE_DELAY_MS * 2 ** attempt);
            continue;
          }
          if (err instanceof TransientError) throw err;
          throw new StoreError(`failed creating constraint on ${label}: ${errorMessage(exc)}`, { cause: exc });
        } finally {
          await session.close().catch(() => undefined);
        }
      }
    }
  }

  async transaction<T>(fn: (tx: GraphPrimitives) => Promise<T>): Promise<T> {
    const session = this.session();
    try {
      const tx = session.beginTransaction();
      let result: T;
      try {
        result = await fn(new CypherWriter(tx));
      } catch (exc) {
        await tx.rollback().catch(() => undefined);
        throw exc;
      }
      try {
        await tx.commit();
      } catch (exc) {
        throw translateCypherError(exc);
      }
      return result;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

export class Neo4jStore extends CypherStore {}
