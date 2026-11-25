import { afterAll, describe, expect, it, vi } from "vitest";
import { KuzuStore, SelfGraph, StoreError } from "../src/index.js";
import { callTool, close, configure } from "../src/mcp.js";
import { DEFAULT_SETTINGS } from "../src/runtime.js";
import { tempKuzu } from "./helpers.js";

const FACTS = {
  entities: [
    { id: "person:ann", type: "Person", name: "Ann" },
    { id: "company:acme", type: "Company", name: "Acme" },
  ],
  relations: [{ from_entity: "person:ann", type: "WORKS_AT", to_entity: "company:acme" }],
};

async function built(prefix: string): Promise<string> {
  const path = tempKuzu(prefix);
  const g = new SelfGraph(new KuzuStore(path));
  await g.initialize();
  await g.insert.facts(FACTS);
  await g.close();
  return path;
}

async function dropKeyTable(path: string): Promise<void> {
  const mod = await import("kuzu");
  const kuzu = (mod.default ?? mod) as {
    Database: new (path: string) => { close(): Promise<void> };
    Connection: new (
      db: unknown,
    ) => { init(): Promise<void>; query(q: string): Promise<unknown>; close(): Promise<void> };
  };
  const db = new kuzu.Database(path);
  const conn = new kuzu.Connection(db);
  await conn.init();
  await conn.query("DROP TABLE K");
  await conn.close();
  await db.close();
}

async function readOnly(path: string): Promise<{ ids: string[]; context: string }> {
  const g = new SelfGraph(new KuzuStore(path, { read_only: true }));
  try {
    await g.initialize();
    const ids = (await g.entities.list()).items.map((e) => e.id).sort();
    const context = (await g.retrieve("who works at Acme")).context;
    return { ids, context };
  } finally {
    await g.close();
  }
}

describe("kuzu read-only open", () => {
  it("reads back a graph built read-write", async () => {
    const { ids, context } = await readOnly(await built("selfgraph-ts-ro-"));
    expect(ids).toEqual(["company:acme", "person:ann"]);
    expect(context).toContain("Ann -[WORKS_AT]-> Acme");
  });

  it("reads back a graph stored before the key table", async () => {
    const path = await built("selfgraph-ts-ro-old-");
    await dropKeyTable(path);
    const { ids, context } = await readOnly(path);
    expect(ids).toEqual(["company:acme", "person:ann"]);
    expect(context).toContain("Ann -[WORKS_AT]-> Acme");
  });
});

describe("kuzu store that fails to initialize", () => {
  afterAll(close);

  it("is closed by the MCP server, so a retry does not leak another", async () => {
    const uri = await built("selfgraph-ts-ro-mcp-");
    await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri });
    const closed = vi.spyOn(KuzuStore.prototype, "close");
    vi.spyOn(KuzuStore.prototype, "initialize").mockRejectedValueOnce(new StoreError("setup failed"));
    expect((await callTool("list_entities")).isError).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    const ok = await callTool("list_entities");
    expect(ok.isError).toBe(false);
    expect(JSON.stringify(ok.result)).toContain("person:ann");
  });
});
