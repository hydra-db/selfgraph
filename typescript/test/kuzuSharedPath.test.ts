import { afterEach, describe, expect, it } from "vitest";
import type { Schema } from "../src/index.js";
import { KuzuStore, SelfGraph } from "../src/index.js";
import { tempKuzu, uniqueNs } from "./helpers.js";

const MAX_ONE: Schema = {
  entities: [{ name: "Person" }, { name: "Company" }],
  relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 } }],
};

const opened: KuzuStore[] = [];

function store(path: string): KuzuStore {
  const made = new KuzuStore(path);
  opened.push(made);
  return made;
}

async function twoClients(path: string): Promise<number> {
  const ns = uniqueNs("shared");
  const options = { namespace: ns, schema: MAX_ONE, contradiction: "supersede" as const };
  const first = new SelfGraph(store(path), options);
  const second = new SelfGraph(store(path), options);
  await first.initialize();
  await second.initialize();
  await first.insert.facts({
    entities: [
      { type: "Person", name: "Ann" },
      { type: "Company", name: "Acme" },
      { type: "Company", name: "Globex" },
    ],
  });
  await Promise.all([
    first.relations.create("person:ann", "WORKS_AT", "company:acme"),
    second.relations.create("person:ann", "WORKS_AT", "company:globex"),
  ]);
  const current = (await first.relations.list()).items;
  await first.close();
  await second.close();
  return current.length;
}

it("keeps relation update history within the Kuzu buffer pool", async () => {
  const graph = new SelfGraph(new KuzuStore(tempKuzu("selfgraph-update-"), { buffer_pool_size: 64 * 1024 ** 2 }));
  try {
    await graph.insert.facts({
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
      ],
    });
    const relation = await graph.relations.create("person:ann", "WORKS_AT", "company:acme");
    for (let step = 1; step <= 512; step++) {
      await graph.relations.update(relation.id, { set_properties: { step } });
    }
    const history = await graph.relations.versions(relation.id, { newest_first: false });
    expect(history.map((version) => version.properties.step ?? 0)).toEqual(
      Array.from({ length: 513 }, (_, step) => step),
    );
    expect(history.filter((version) => version.is_current).map((version) => version.revision)).toEqual([513]);
  } finally {
    await graph.close();
  }
});

it("names the store that matches the scheme", () => {
  const messageFor = (uri: string) => {
    try {
      new KuzuStore(uri);
    } catch (error) {
      return String(error);
    }
    throw new Error(`${uri} was accepted`);
  };
  expect(messageFor("bolt://u:hunter2@h:1")).toContain("Neo4jStore");
  expect(messageFor("memgraph://h:1")).toContain("Neo4jStore");
  expect(messageFor("redis://h:1")).toContain("FalkorDBStore");
  expect(messageFor("falkors://h:1")).toContain("FalkorDBStore");
  expect(messageFor("hydradb://h:1")).toContain("HydraDBStore");
  expect(messageFor("https://u:hunter2@h:1")).toContain("a server store");
});

describe("two KuzuStore instances over one database", () => {
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((s) => s.close().catch(() => undefined)));
  });

  it("reject a multi-statement run_cypher before running, so no write commits", async () => {
    const path = tempKuzu("selfgraph-multi-");
    const s = store(path);
    const g = new SelfGraph(s, { namespace: uniqueNs("multi") });
    await g.initialize();
    await g.entities.create("A", "T", { id: "t:a" });
    await g.entities.create("B", "T", { id: "t:b" });
    const ids = async () => (await s.runCypher("MATCH (n:N) RETURN n.id AS id ORDER BY id")).rows.map((r) => r.id);
    expect(await ids()).toEqual(["t:a", "t:b"]);
    for (const query of ["RETURN 1 AS a; MATCH (n:N) DETACH DELETE n", "CREATE (:N {pk:'x'}); CREATE (:N {pk:'y'})"]) {
      await expect(s.runCypher(query)).rejects.toThrow(/one statement/);
      await expect(s.runCypher(query)).rejects.toMatchObject({ code: "query_failed" });
    }
    expect(await ids()).toEqual(["t:a", "t:b"]);
    expect((await s.runCypher("RETURN 'a; b' AS s")).rows).toEqual([{ s: "a; b" }]);
    expect((await s.runCypher("MATCH (n:N) RETURN count(*) AS c ; // trailing")).rows).toEqual([{ c: 2 }]);
    await g.close();
  });

  it("serialize their writes, so max_count holds", async () => {
    expect(await twoClients(tempKuzu("selfgraph-shared-"))).toBe(1);
  });

  it("share one write queue, and drop it with the database", async () => {
    const path = tempKuzu("selfgraph-shared-");
    const options = { namespace: uniqueNs("shared"), schema: MAX_ONE };
    const first = new SelfGraph(store(path), options);
    const second = new SelfGraph(store(path), options);
    await first.initialize();
    await second.initialize();
    const shared = (first.store as KuzuStore).writeQueueKey();
    expect((second.store as KuzuStore).writeQueueKey()).toBe(shared);
    await first.close();
    await second.close();
    expect(store(path).writeQueueKey()).not.toBe(shared);
  });

  it("initialize the same fresh path from two stores at once", async () => {
    const path = tempKuzu("selfgraph-shared-");
    const options = { namespace: uniqueNs("shared"), schema: MAX_ONE };
    const first = new SelfGraph(store(path), options);
    const second = new SelfGraph(store(path), options);
    await Promise.all([first.initialize(), second.initialize()]);
    await first.insert.facts({ entities: [{ type: "Person", name: "Ann" }] });
    expect((await first.entities.list()).items.length).toBe(1);
    await first.close();
    await second.close();
  });
});
