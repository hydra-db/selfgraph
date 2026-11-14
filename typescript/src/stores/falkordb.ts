import type { FalkorDB, FalkorDBOptions, Graph, GraphReply, QueryParams } from "falkordb";

import { errorMessage, errorReason, StoreError, TransientError } from "../errors.js";
import { Lazy } from "../internal/lazy.js";
import { loadOptional } from "../internal/optional.js";
import type { CypherResult, JsonValue } from "../models.js";
import type { GraphStore } from "../protocols.js";
import { checkOptions, keysOf } from "../validate.js";
import { autoCommit, CypherPrimitives, graphProperties, WRITE_COUNTER_NAMES } from "./cypherPrimitives.js";

const TRANSIENT_MARKERS = [
  "max pending queries",
  "too many connections",
  "timeout",
  "timed out",
  "busy",
  "deadlock",
  "try again",
];

interface FalkorConnection {
  client: FalkorDB;
  graph: Graph;
}

export interface FalkorDBSocketOptions {
  host?: string;
  port?: number;
  tls?: boolean;
  connectTimeout?: number;
  [option: string]: unknown;
}

export interface FalkorDBStoreOptions {
  graph?: string;
  username?: string;
  password?: string;
  socket?: FalkorDBSocketOptions;
  name?: string;
  pingInterval?: number;
  disableClientInfo?: boolean;
  clientInfoTag?: string;
  retryWritesOnConnectionLoss?: boolean;
}

const OPTION_KEYS = keysOf<FalkorDBStoreOptions>({
  graph: true,
  username: true,
  password: true,
  socket: true,
  name: true,
  pingInterval: true,
  disableClientInfo: true,
  clientInfoTag: true,
  retryWritesOnConnectionLoss: true,
});

function isGraphEntity(value: Record<string, unknown>): boolean {
  return (
    "properties" in value &&
    typeof value.properties === "object" &&
    ("labels" in value || "relationshipType" in value || "sourceId" in value)
  );
}

/**
 * Convert a FalkorDB reply value to plain JSON, keeping an integer beyond Number.MAX_SAFE_INTEGER as a bigint.
 *
 * @param value (unknown): the reply value; integers arrive as bigint.
 * @return (unknown): the plain value.
 */
function toJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint")
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (isGraphEntity(obj)) return toJson(graphProperties(obj.properties as Record<string, unknown>));
    if ("nodes" in obj && ("edges" in obj || "relationships" in obj) && Array.isArray(obj.nodes)) {
      return {
        nodes: (obj.nodes as unknown[]).map(toJson),
        relationships: ((obj.edges ?? obj.relationships) as unknown[]).map(toJson),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = toJson(v);
    return out;
  }
  return value;
}

export class FalkorDBStore extends autoCommit(CypherPrimitives) implements GraphStore {
  private readonly host: string;
  private readonly port: number;
  private readonly graphName: string;
  private readonly clientOptions: Record<string, unknown>;
  private readonly connection = new Lazy<FalkorConnection>(async () => {
    const mod = await loadOptional<{ FalkorDB?: typeof FalkorDB; default?: { FalkorDB?: typeof FalkorDB } }>(
      "falkordb",
      "the 'falkordb' package is required for FalkorDBStore; npm install falkordb",
      StoreError,
    );
    const Client = (mod.FalkorDB ?? mod.default?.FalkorDB ?? mod.default) as typeof FalkorDB;
    const socket = { host: this.host, port: this.port, ...((this.clientOptions.socket as object) ?? {}) };
    const client = await Client.connect({ integers: "bigint", ...this.clientOptions, socket } as FalkorDBOptions);
    return { client, graph: client.selectGraph(this.graphName) };
  });

  /**
   * A store for FalkorDB over its Redis protocol, auto-committing with no multi-statement transactions.
   *
   * @param host (string): the FalkorDB host.
   * @param port (number): the FalkorDB port.
   * @param options (FalkorDBStoreOptions): the graph name and any extra FalkorDB.connect options.
   */
  constructor(host = "localhost", port = 6379, options: FalkorDBStoreOptions = {}) {
    super();
    checkOptions("FalkorDBStore", options, OPTION_KEYS);
    const { graph = "selfgraph", ...clientOptions } = options;
    this.host = host;
    this.port = port;
    this.graphName = graph;
    this.clientOptions = clientOptions;
  }

  protected async _run(query: string, params?: Record<string, unknown> | null): Promise<CypherResult> {
    this.requireOpen();
    let graph: Graph;
    try {
      graph = (await this.connection.get()).graph;
    } catch (exc) {
      if (exc instanceof StoreError) throw exc;
      const reason = errorReason(exc).replace(/^Failed to connect to FalkorDB: /, "");
      throw new StoreError(`failed connecting to FalkorDB at ${this.host}:${this.port}: ${reason}`, { cause: exc });
    }
    let res: GraphReply<Record<string, unknown>>;
    try {
      res = await graph.query<Record<string, unknown>>(query, { params: (params ?? {}) as QueryParams });
    } catch (exc) {
      const message = errorMessage(exc);
      if (TRANSIENT_MARKERS.some((k) => message.toLowerCase().includes(k))) {
        throw new TransientError(`FalkorDB transient error: ${message}`, { cause: exc });
      }
      throw new StoreError(`FalkorDB query failed: ${message}`, { cause: exc });
    }
    const columns = res.headers ?? [];
    const rows = (res.data ?? []).map((row) => {
      const out: Record<string, JsonValue> = {};
      for (const col of columns) out[col] = toJson(row[col]) as JsonValue;
      return out;
    });
    const counters: Record<string, number> = {};
    for (const [js, py] of WRITE_COUNTER_NAMES) {
      const v = Math.trunc(Number(res.stats?.[js] ?? 0));
      if (v) counters[py] = v;
    }
    return { columns, rows, counters, warnings: [] };
  }

  /** Create the graph key up front so concurrent first writes do not race on its creation. */
  async initialize(): Promise<void> {
    await this._run("CREATE (n:_SgInit) DELETE n");
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.connection.release((connection) => connection.client.close());
  }
}
