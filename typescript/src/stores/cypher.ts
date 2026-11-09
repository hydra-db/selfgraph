import type { Config, Driver, Session, Transaction } from "neo4j-driver";

import { errorMessage, StoreError, TransientError } from "../errors.js";
import { sleep } from "../internal/time.js";
import { LABELS } from "../labels.js";
import type { CypherResult } from "../models.js";
import type { GraphPrimitives, GraphStore } from "../protocols.js";
import {
  type BoltStoreOptions,
  boltError,
  errorCode,
  openDriver,
  queryError,
  recordsToResult,
  syntaxDetail,
  toBoltParams,
} from "./bolt.js";
import { CypherPrimitives } from "./cypherPrimitives.js";

const INIT_ATTEMPTS = 5;
const INIT_BASE_DELAY_MS = 50;
const SHOW_CONSTRAINTS = ["SHOW CONSTRAINTS", "SHOW CONSTRAINT INFO"];

const SYNTAX_MARKERS = ["syntaxerror", "parsing error"];
const HYDRADB_HINT = "; if this is a HydraDB server use store 'hydradb'";
const CONFLICT_MARKERS = ["constraintvalidationfailed", "unique constraint violation"];

/**
 * Report whether a lowercased Cypher error is a retryable race. A uniqueness violation surfaces only after a managed write has passed its pre-existence check, so it is a lost race; a syntax error is never retried, even when Memgraph's message lists CONSTRAINT and UNIQUE among the keywords it expected.
 *
 * @param lowered (string): the lowercased error code and message.
 * @return (boolean): true when the error is a lost race or a transient conflict.
 */
function cypherTransient(lowered: string): boolean {
  if (SYNTAX_MARKERS.some((k) => lowered.includes(k))) return false;
  return (
    CONFLICT_MARKERS.some((k) => lowered.includes(k)) ||
    (lowered.includes("constraint") && lowered.includes("already exists")) ||
    ["transient", "serializ", "conflicting transactions", "cannot get"].some((k) => lowered.includes(k))
  );
}

const translateCypherError = (exc: unknown, uri: string, database: string | null): StoreError =>
  queryError(exc, uri, database, "Cypher", cypherTransient);

/**
 * The labels carrying an (id, ns) uniqueness constraint, from Neo4j or Memgraph constraint listing rows.
 *
 * @param rows (Record<string, unknown>[]): the constraint rows.
 * @return (Set<string>): the constrained labels.
 */
export function uniqueLabels(rows: Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const kind = String(row.type ?? row["constraint type"] ?? "").toLowerCase();
    const props = Array.isArray(row.properties) ? row.properties.map(String).sort() : [];
    if (!kind.includes("unique") || props.join(",") !== "id,ns") continue;
    const labels = Array.isArray(row.labelsOrTypes) ? row.labelsOrTypes : [row.label];
    for (const label of labels) if (typeof label === "string") out.add(label);
  }
  return out;
}

export type CypherStoreOptions = BoltStoreOptions;

class CypherWriter extends CypherPrimitives {
  constructor(
    private readonly tx: Transaction,
    private readonly uri: string,
    private readonly database: string | null,
  ) {
    super();
  }

  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    try {
      return await recordsToResult(this.tx.run(query, toBoltParams(params)));
    } catch (exc) {
      throw translateCypherError(exc, this.uri, this.database);
    }
  }
}

export class CypherStore extends CypherPrimitives implements GraphStore {
  protected readonly driver: Driver;
  protected readonly uri: string;
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
    this.driver = openDriver(uri, auth, withQuietNotifications);
    this.uri = uri;
    this.database = database ?? null;
  }

  protected session(): Session {
    this.requireOpen();
    return this.database ? this.driver.session({ database: this.database }) : this.driver.session();
  }

  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    const session = this.session();
    try {
      return await recordsToResult(session.run(query, toBoltParams(params)));
    } catch (exc) {
      throw translateCypherError(exc, this.uri, this.database);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /**
   * List the existing constraints in the engine's own dialect, trying each SHOW form the engines accept.
   *
   * @return (Record<string, unknown>[]): the constraint rows, or [] when the engine cannot list them.
   */
  private async listConstraints(): Promise<Record<string, unknown>[]> {
    for (const query of SHOW_CONSTRAINTS) {
      try {
        return (await this._run(query)).rows;
      } catch (exc) {
        if (exc instanceof TransientError || !(exc instanceof StoreError)) throw exc;
        const cause = exc.cause ?? exc;
        if (boltError(cause, this.uri, this.database) !== null) throw exc;
        if (syntaxDetail(cause) === null) return [];
      }
    }
    return [];
  }

  /**
   * Report whether the uniqueness constraints are already in place, so initialize can skip the DDL. Constraint DDL needs exclusive access on Memgraph, so a check that keeps conflicting with another client's work means the store is in use and is treated as set up.
   *
   * @return (boolean): true when every label has its constraint or the check kept conflicting.
   */
  private async constraintsExist(): Promise<boolean> {
    for (let attempt = 0; attempt < INIT_ATTEMPTS; attempt++) {
      try {
        const present = uniqueLabels(await this.listConstraints());
        return LABELS.every((label) => present.has(label));
      } catch (exc) {
        if (!(exc instanceof TransientError)) throw exc;
        if (attempt < INIT_ATTEMPTS - 1) await sleep(INIT_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    return true;
  }

  /** Create the id and namespace uniqueness constraints on every graph-schema label unless they exist, retrying lost races. */
  async initialize(): Promise<void> {
    this.requireOpen();
    if (await this.constraintsExist()) return;
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
          const err = translateCypherError(exc, this.uri, this.database);
          if (err instanceof TransientError && attempt < INIT_ATTEMPTS - 1) {
            await sleep(INIT_BASE_DELAY_MS * 2 ** attempt);
            continue;
          }
          if (err instanceof TransientError || boltError(exc, this.uri, this.database)) throw err;
          const lowered = `${errorCode(exc)} ${errorMessage(exc)}`.toLowerCase();
          const hint = lowered.includes("syntax") || lowered.includes("parse error") ? HYDRADB_HINT : "";
          throw new StoreError(`failed creating constraint on ${label}: ${errorMessage(exc)}${hint}`, { cause: exc });
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
        result = await fn(new CypherWriter(tx, this.uri, this.database));
      } catch (exc) {
        await tx.rollback().catch(() => undefined);
        throw exc;
      }
      try {
        await tx.commit();
      } catch (exc) {
        throw translateCypherError(exc, this.uri, this.database);
      }
      return result;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.driver.close();
  }
}

export class Neo4jStore extends CypherStore {}
