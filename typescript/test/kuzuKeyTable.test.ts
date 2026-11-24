import { afterEach, describe, expect, it } from "vitest";
import { entityId, KuzuStore, SelfGraph } from "../src/index.js";
import { tempKuzu, uniqueNs } from "./helpers.js";

const IBM = entityId("Company", "International Business Machines");
const IBM_SEED = { type: "Company", name: "International Business Machines", external_ids: { ticker: "IBM" } };
const opened: KuzuStore[] = [];

async function open(): Promise<{ store: KuzuStore; g: SelfGraph }> {
  const store = new KuzuStore(tempKuzu("selfgraph-ts-keys-"), { max_db_size: 1 << 30 });
  opened.push(store);
  const g = new SelfGraph(store, { namespace: uniqueNs("keys"), resolver: "default" });
  await g.initialize();
  return { store, g };
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
});

describe("kuzu entity key table", () => {
  it("indexes entities stored before the key table when it opens", async () => {
    const { store, g } = await open();
    await g.insert.facts({ entities: [IBM_SEED] });
    await g.runCypher("MATCH (k:K) DELETE k");
    expect((await g.runCypher("MATCH (k:K) RETURN count(*) AS n")).rows).toEqual([{ n: 0 }]);
    await store.initialize();
    expect((await g.runCypher("MATCH (k:K) RETURN count(*) AS n")).rows[0]?.n).toBeGreaterThan(0);
    const { merges } = await g.insert.facts({
      entities: [{ type: "Company", name: "IBM Corp", external_ids: { ticker: "IBM" } }],
    });
    expect(merges.map((m) => [m.survivor_id, m.reason])).toEqual([[IBM, "external_id"]]);
  });

  it("skips a corrupt entity document while indexing", async () => {
    const { store, g } = await open();
    await g.insert.facts({ entities: [IBM_SEED, { type: "Person", name: "Ada" }] });
    await g.runCypher("MATCH (k:K) DELETE k");
    const ada = { id: entityId("Person", "Ada") } as never;
    await g.runCypher("MATCH (n:N) WHERE n.id = $id SET n.doc = 'x'", ada);
    await store.initialize();
    const held = (await g.runCypher("MATCH (k:K) RETURN k.eid AS eid")).rows.map((r) => r.eid);
    expect(held).toContain(IBM);
    expect(held).not.toContain(entityId("Person", "Ada"));
  });
});
