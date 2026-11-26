import type { Config, Driver, Session, Transaction } from "neo4j-driver";

import { errorMessage, SelfGraphError, StoreError, TransientError } from "../errors.js";
import { sleep } from "../internal/time.js";
import { LABELS } from "../labels.js";
import type { CypherResult } from "../models.js";
import type { GraphPrimitives, GraphStore, Props } from "../protocols.js";
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
  protected override readonly nodePageMaps = true;
  protected override readonly countedNodeDelete = true;
  constructor(
    private readonly tx: Transaction,
    private readonly uri: string,
    private readonly database: string | null,
  ) {
    super();
  }

  async lockAndGetNode(ns: string, label: string, id: string): Promise<Props | null> {
    const res = await this._run(`MATCH (n:${label} {id:$id, ns:$ns}) SET n._lock = coalesce(n._lock, 0) + 1 RETURN n`, {
      id,
      ns,
    });
    const row = res.rows[0];
    return row ? (row.n as Props) : null;
  }

  async lockNodes(ns: string, label: string, ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += 256) {
      const rows = ids.slice(start, start + 256).map((id, ordinal) => ({ id, ordinal }));
      await this._run(
        `UNWIND $rows AS row WITH row ORDER BY row.ordinal MATCH (n:${label} {id:row.id, ns:$ns}) SET n._lock = coalesce(n._lock, 0) + 1`,
        { ns, rows },
      );
    }
  }

  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    try {
      return await recordsToResult(this.tx.run(query, toBoltParams(params)));
    } catch (exc) {
      if (exc instanceof SelfGraphError) throw exc;
      throw translateCypherError(exc, this.uri, this.database);
    }
  }
}

export class CypherStore extends CypherPrimitives implements GraphStore {
  protected override readonly nodePageMaps = true;
  protected override readonly countedNodeDelete = true;
  protected readonly driver: Driver;
  protected readonly uri: string;
  protected readonly database: string | null;
  private memgraph = false;

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
      if (exc instanceof SelfGraphError) throw exc;
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
        const result = await this._run(query);
        this.memgraph =
          query === "SHOW CONSTRAINT INFO" ||
          result.columns.includes("constraint type") ||
          result.rows.some((row) => "constraint type" in row);
        return result.rows;
      } catch (exc) {
        if (exc instanceof TransientError || !(exc instanceof StoreError)) throw exc;
        const cause = exc.cause ?? exc;
        if (boltError(cause, this.uri, this.database) !== null) throw exc;
        if (syntaxDetail(cause) === null) throw exc;
      }
    }
    return [];
  }

  /**
   * Report whether the uniqueness constraints are already in place, so initialize can skip the DDL. Constraint DDL needs exclusive access on Memgraph, so a check that keeps conflicting with another client's work means the store is in use and is treated as set up.
   *
   * @return (boolean | null): whether every label has its constraint, or null when the store stays busy.
   */
  private async constraintsExist(): Promise<boolean | null> {
    for (let attempt = 0; attempt < INIT_ATTEMPTS; attempt++) {
      try {
        const present = uniqueLabels(await this.listConstraints());
        return LABELS.every((label) => present.has(label));
      } catch (exc) {
        if (!(exc instanceof TransientError)) throw exc;
        if (attempt < INIT_ATTEMPTS - 1) await sleep(INIT_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    return null;
  }

  /** Create the id and namespace uniqueness constraints on every graph-schema label unless they exist, retrying lost races. */
  async initialize(): Promise<void> {
    this.requireOpen();
    this.memgraph = false;
    const constraintsExist = await this.constraintsExist();
    if (constraintsExist === null) return;
    for (const label of constraintsExist ? [] : LABELS) {
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
    if (this.memgraph) await this.initializeIndexes();
    else {
      for (let attempt = 0; ; attempt++) {
        try {
          await this._run(
            "CREATE RANGE INDEX selfgraph_evidence_ns_target_id IF NOT EXISTS " +
              "FOR (n:Evidence) ON (n.ns, n.target_id)",
          );
          break;
        } catch (exc) {
          if (!(exc instanceof TransientError) || attempt === INIT_ATTEMPTS - 1) throw exc;
          await sleep(INIT_BASE_DELAY_MS * 2 ** attempt);
        }
      }
    }
  }

  /**
   * Create missing Memgraph node id indexes, retrying exclusive-access conflicts.
   * @return (Promise<void>): resolves after every fixed label has a lookup index.
   */
  private async initializeIndexes(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = (await this._run("SHOW INDEX INFO")).rows;
        const indexed = new Set(
          rows
            .filter(
              (row) =>
                typeof row.label === "string" &&
                LABELS.some((label) => label === row.label) &&
                row["index type"] === "label+property" &&
                (typeof row.property === "string" || (Array.isArray(row.property) && row.property.length === 1)),
            )
            .map((row) => `${row.label}:${Array.isArray(row.property) ? row.property[0] : row.property}`),
        );
        const labeled = new Set(
          rows
            .filter(
              (row) =>
                row["index type"] === "label" &&
                typeof row.label === "string" &&
                LABELS.some((label) => label === row.label),
            )
            .map((row) => row.label),
        );
        for (const label of LABELS) {
          if (!labeled.has(label)) await this._run(`CREATE INDEX ON :${label}`);
        }
        const indexes = [...LABELS.map((label) => [label, "id"]), ["Evidence", "target_id"]];
        for (const [label, prop] of indexes) {
          if (!indexed.has(`${label}:${prop}`)) await this._run(`CREATE INDEX ON :${label}(${prop})`);
        }
        const refreshed = (await this._run("SHOW INDEX INFO")).rows;
        const modern = refreshed.some(
          (row) =>
            row["index type"] === "label+property" &&
            typeof row.label === "string" &&
            LABELS.some((label) => label === row.label) &&
            Array.isArray(row.property) &&
            row.property.length === 1 &&
            row.property[0] === "id",
        );
        if (modern) {
          const versions = (await this._run("SHOW VERSION")).rows;
          const version = versions.length === 1 ? versions[0]?.version : null;
          if (
            version === "3.14.0" &&
            !refreshed.some(
              (row) => row["index type"] === "edge-property" && row.label === null && row.property === "id",
            )
          ) {
            await this._run("CREATE GLOBAL EDGE INDEX ON :(id)");
          }
        }
        return;
      } catch (exc) {
        if (!(exc instanceof TransientError) || attempt === INIT_ATTEMPTS - 1) throw exc;
        await sleep(INIT_BASE_DELAY_MS * 2 ** attempt);
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
