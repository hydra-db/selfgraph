import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe } from "vitest";

import { CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore, SelfGraph } from "../src/index.js";
import type { GraphStore } from "../src/protocols.js";

export interface StoreSpec {
  name: string;
  make(): GraphStore;
  transactional: boolean;
}

export const NEO4J_URI = process.env.SG_NEO4J_URI ?? "bolt://localhost:7687";
export const NEO4J_PASSWORD = process.env.SG_NEO4J_PASSWORD ?? "testpassword123";

const KUZU_DIR = mkdtempSync(join(tmpdir(), "selfgraph-ts-kuzu-"));
const KUZU_PATH = join(KUZU_DIR, "graph.kuzu");

afterAll(async () => {
  await KuzuStore.closeDatabase(KUZU_PATH);
  rmSync(KUZU_DIR, { recursive: true, force: true });
});

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
 * @return (() => SelfGraph): the factory.
 */
export function freshGraphs(spec: StoreSpec, prefix: string): () => SelfGraph {
  const graphs: SelfGraph[] = [];
  afterEach(async () => {
    for (const g of graphs.splice(0)) await g.close();
  });
  return () => {
    const g = new SelfGraph(spec.make(), { namespace: uniqueNs(`${prefix}_${spec.name}`) });
    graphs.push(g);
    return g;
  };
}

export function uniqueNs(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
 * @param options ({ input?: string; env?: Record<string, string> }): stdin and environment overrides.
 * @return ({ code: number; out: unknown; err: string }): the exit code, parsed stdout, and stderr.
 */
export function runCli(
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): { code: number; out: unknown; err: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  let out: unknown = res.stdout;
  try {
    out = JSON.parse(res.stdout);
  } catch {}
  return { code: res.status ?? -1, out, err: res.stderr };
}
