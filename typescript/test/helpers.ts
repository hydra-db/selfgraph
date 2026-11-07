import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

import { CypherStore, FalkorDBStore, HydraDBStore, KuzuStore, Neo4jStore } from "../src/index.js";
import type { GraphStore } from "../src/protocols.js";

export interface StoreSpec {
  name: string;
  make(): GraphStore;
  transactional: boolean;
}

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
    make: () =>
      new Neo4jStore(process.env.SG_NEO4J_URI ?? "bolt://localhost:7687", {
        auth: ["neo4j", process.env.SG_NEO4J_PASSWORD ?? "testpassword123"],
      }),
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

export function uniqueNs(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
