import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, vi } from "vitest";

import {
  CypherStore,
  type Entity,
  FalkorDBStore,
  HydraDBStore,
  KuzuStore,
  Neo4jStore,
  SelfGraph,
  type SelfGraphOptions,
  setLogger,
} from "../src/index.js";
import type { GraphStore } from "../src/protocols.js";
import type { Schema } from "../src/schema.js";

export interface StoreSpec {
  name: string;
  make(): GraphStore;
  transactional: boolean;
}

export const NEO4J_URI = process.env.SG_NEO4J_URI ?? "bolt://localhost:7687";
export const NEO4J_PASSWORD = process.env.SG_NEO4J_PASSWORD ?? "testpassword123";

/**
 * Make a temp directory that is removed after the suite.
 *
 * @param prefix (string): the directory name prefix.
 * @return (string): the directory path.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Make a Kuzu database path in a temp directory, closed and removed after the suite.
 *
 * @param prefix (string): the directory name prefix.
 * @return (string): the database path.
 */
export function tempKuzu(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "graph.kuzu");
  afterAll(async () => {
    await KuzuStore.closeDatabase(path);
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

const KUZU_PATH = tempKuzu("selfgraph-ts-kuzu-");

export const STORE_SPECS: StoreSpec[] = [
  {
    name: "neo4j",
    transactional: true,
    make: () => new Neo4jStore(NEO4J_URI, { auth: ["neo4j", NEO4J_PASSWORD] }),
  },
  {
    name: "memgraph",
    transactional: true,
    make: () => new CypherStore(process.env.SG_MEMGRAPH_URI ?? "bolt://localhost:7688"),
  },
  {
    name: "falkordb",
    transactional: false,
    make: () =>
      new FalkorDBStore("localhost", Number(process.env.SG_FALKOR_PORT ?? 6380), { graph: "selfgraph_ts_test" }),
  },
  {
    name: "kuzu",
    transactional: false,
    make: () => new KuzuStore(KUZU_PATH),
  },
  {
    name: "hydradb",
    transactional: false,
    make: () =>
      new HydraDBStore(process.env.SG_HYDRADB_URI ?? "bolt://127.0.0.1:17688", {
        auth: ["neo4j", process.env.SG_HYDRADB_TOKEN ?? "local-dev-auth-token-32-characters-long"],
      }),
  },
];

export const KUZU_SPEC = STORE_SPECS.find((s) => s.name === "kuzu")!;

/**
 * The store specs selected by SELFGRAPH_TEST_STORES (comma-separated), or all of them.
 *
 * @return (StoreSpec[]): the selected specs.
 */
export function selectedStores(): StoreSpec[] {
  const wanted = process.env.SELFGRAPH_TEST_STORES?.split(",").map((s) => s.trim());
  return wanted ? STORE_SPECS.filter((s) => wanted.includes(s.name)) : STORE_SPECS;
}

/**
 * Report whether a store answers a trivial query, so suites for absent backends are skipped.
 *
 * @param spec (StoreSpec): the store spec.
 * @return (boolean): true when reachable.
 */
export async function reachable(spec: StoreSpec): Promise<boolean> {
  const store = spec.make();
  try {
    await store.initialize();
    await store.matchNodes("__probe__", "Entity", { limit: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await store.close?.().catch(() => undefined);
  }
}

/**
 * Register one describe block per selected store, skipped when the store is unreachable.
 *
 * @param title (string): the describe title prefix.
 * @param suite ((spec: StoreSpec) => void): the suite body.
 * @return (Promise<void>): resolves once every block is registered.
 */
export async function forEachStore(title: string, suite: (spec: StoreSpec) => void): Promise<void> {
  for (const spec of selectedStores()) {
    const run = (await reachable(spec)) ? describe : describe.skip;
    run(`${title}: ${spec.name}`, () => suite(spec));
  }
}

/**
 * Return a factory for graphs in fresh namespaces, each closed after the test that opened it.
 *
 * @param spec (StoreSpec): the store spec.
 * @param prefix (string): the namespace prefix.
 * @return ((options?: SelfGraphOptions) => SelfGraph): the factory, taking extra graph options.
 */
export function freshGraphs(spec: StoreSpec, prefix: string): (options?: SelfGraphOptions) => SelfGraph {
  const graphs: SelfGraph[] = [];
  afterEach(async () => {
    for (const g of graphs.splice(0)) await g.close();
  });
  return (options = {}) => {
    const g = new SelfGraph(spec.make(), { namespace: uniqueNs(`${prefix}_${spec.name}`), ...options });
    graphs.push(g);
    return g;
  };
}

export function uniqueNs(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a stored entity with empty optional fields, for resolver tests that need no backend.
 *
 * @param fields (Pick<Entity, "id" | "type" | "name"> & Partial<Entity>): the fields to set.
 * @return (Entity): the entity, stamped at 2024-01-01.
 */
export function storedEntity(fields: Pick<Entity, "id" | "type" | "name"> & Partial<Entity>): Entity {
  const at = new Date("2024-01-01T00:00:00Z");
  return {
    aliases: [],
    external_ids: {},
    properties: {},
    source_count: 0,
    created_at: at,
    updated_at: at,
    relevance: null,
    relevance_at: null,
    ...fields,
  };
}

export const SINGLE_EMPLOYER: Schema = {
  entities: [{ name: "Person" }, { name: "Company" }],
  relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 } }],
};

export const A_KNOWS_B = {
  entities: [
    { name: "A", type: "T", id: "t:a" },
    { name: "B", type: "T", id: "t:b" },
  ],
  relations: [{ id: "relation:ab", from_entity: "t:a", type: "KNOWS", to_entity: "t:b" }],
};

export const ANN_AT_ACME = {
  entities: [
    { type: "Person", name: "Ann" },
    { type: "Company", name: "Acme" },
    { type: "Company", name: "Globex" },
  ],
  relations: [
    { from_entity: "person:ann", type: "WORKS_AT", to_entity: "company:acme", event_time: "2020-01-01T00:00:00Z" },
  ],
};

/**
 * Build a WORKS_AT relation input, dated to January 1 of a year when one is given.
 *
 * @param from (string): the person id.
 * @param to (string): the company id.
 * @param year (number | undefined): the event year.
 * @param properties (Record<string, unknown> | undefined): the relation properties.
 * @return ({ from_entity: string; type: string; to_entity: string; event_time?: string; properties?: Record<string, unknown> }): the relation input.
 */
export function worksAt(
  from: string,
  to: string,
  year?: number,
  properties?: Record<string, unknown>,
): { from_entity: string; type: string; to_entity: string; event_time?: string; properties?: Record<string, unknown> } {
  return {
    from_entity: from,
    type: "WORKS_AT",
    to_entity: to,
    ...(year === undefined ? {} : { event_time: `${year}-01-01T00:00:00+00:00` }),
    ...(properties ? { properties } : {}),
  };
}

/**
 * Run a function with console.warn silenced and return what it warned.
 *
 * @param fn (() => T | Promise<T>): the function to run.
 * @return (Promise<{ result: T; warnings: string[] }>): its result and one line per warn call.
 */
export async function captureWarnings<T>(fn: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const result = await fn();
    return { result, warnings: warn.mock.calls.map((c) => c.map(String).join(" ")) };
  } finally {
    warn.mockRestore();
  }
}

/**
 * Run a function with the library logger captured and return what it logged.
 *
 * @param fn (() => T | Promise<T>): the function to run.
 * @return (Promise<{ result: T; logged: string[] }>): its result and one "level: message" line per log call.
 */
export async function captureLog<T>(fn: () => T | Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const previous = setLogger((message, level) => logged.push(`${level}: ${message}`));
  try {
    return { result: await fn(), logged };
  } finally {
    setLogger(previous);
  }
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/**
 * Build dist/ so the CLI tests run the shipped entry point.
 */
export function buildCli(): void {
  const build = spawnSync("npx", ["tsup"], { cwd: ROOT, stdio: "inherit" });
  if (build.status !== 0) throw new Error(`tsup build failed with status ${build.status}`);
}

/**
 * Run the built CLI and parse its stdout as JSON when it is JSON.
 *
 * @param args (string[]): the CLI arguments.
 * @param options ({ input?: string; env?: Record<string, string | undefined> }): stdin and environment overrides; undefined unsets a variable.
 * @return ({ code: number; out: unknown; err: string }): the exit code, parsed stdout, and stderr.
 */
export function runCli(
  args: string[],
  options: { input?: string; env?: Record<string, string | undefined> } = {},
): { code: number; out: unknown; err: string } {
  const env = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input: options.input, env });
  let out: unknown = res.stdout;
  try {
    out = JSON.parse(res.stdout);
  } catch {}
  return { code: res.status ?? -1, out, err: res.stderr };
}
