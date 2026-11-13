import { expect, it } from "vitest";

import { type Evidence, ids, NotFoundError, type Page, type SelfGraph } from "../src/index.js";
import { forEachStore, freshGraphs, type StoreSpec } from "./helpers.js";

const FACTS = {
  entities: [
    { type: "Person", name: "Ada" },
    { type: "Company", name: "Acme" },
  ],
  relations: [{ from_entity: "person:ada", type: "WORKS_AT", to_entity: "company:acme" }],
};
const REL = ids.relationId("person:ada", "WORKS_AT", "company:acme");

/**
 * Read every page of an evidence listing, two items at a time.
 *
 * @param list ((id: string, options: { cursor?: string | null; limit?: number }) => Promise<Page<Evidence>>): the listing.
 * @param id (string): the entity or relation id.
 * @return (Evidence[]): all the evidence.
 */
async function all(
  list: (id: string, options: { cursor?: string | null; limit?: number }) => Promise<Page<Evidence>>,
  id: string,
): Promise<Evidence[]> {
  const items: Evidence[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Evidence> = await list(id, { cursor, limit: 2 });
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return items;
}

function suite(spec: StoreSpec) {
  const open = freshGraphs(spec, "ev");
  const records = (g: SelfGraph) => g.store.matchNodes(g.namespace, "Evidence");

  it("records the evidence of a created relation, rejects bad offsets, and needs a known object", async () => {
    const g = open();
    await expect(g.entities.evidence("person:nobody")).rejects.toBeInstanceOf(NotFoundError);
    await expect(g.relations.evidence("relation:nothing")).rejects.toBeInstanceOf(NotFoundError);
    await g.entities.create("Ada", "Person");
    expect((await g.entities.evidence("person:ada")).items).toEqual([]);
    await g.entities.create("Acme", "Company");
    const rel = await g.relations.create("person:ada", "WORKS_AT", "company:acme", {
      evidence: [{ source_id: "m", quote: "a", start_offset: 1, end_offset: 2, confidence: 0.5 }],
    });
    expect(rel.source_count).toBe(1);
    expect(await all((id, o) => g.relations.evidence(id, o), rel.id)).toEqual([
      {
        source_id: "m",
        source_version: "m:manual",
        chunk_id: null,
        quote: "a",
        start_offset: 1,
        end_offset: 2,
        confidence: 0.5,
      },
    ]);
    for (const [bad, message] of [
      [{ start_offset: -1 }, "evidence start_offset cannot be negative, got -1"],
      [{ end_offset: -2 }, "evidence end_offset cannot be negative, got -2"],
      [{ start_offset: 5, end_offset: 2 }, "evidence start_offset 5 is greater than end_offset 2"],
      [{ confidence: 1.5 }, "evidence confidence must be between 0 and 1, got 1.5"],
      [{ confidence: -0.5 }, "evidence confidence must be between 0 and 1, got -0.5"],
    ] as const) {
      await expect(
        g.relations.create("person:ada", "KNOWS", "company:acme", { evidence: [{ source_id: "m", ...bad }] }),
      ).rejects.toThrow(message);
      await expect(g.relations.update(REL, { evidence: [{ source_id: "m", ...bad }] })).rejects.toThrow(message);
    }
  });

  it("records one evidence per source version, and other sources on their own manual version", async () => {
    const g = open();
    const rel = { ...FACTS.relations[0]!, evidence: [{ source_id: "doc", quote: "Ada works at Acme" }] };
    const res = await g.insert.facts({ ...FACTS, relations: [rel] }, { source_id: "doc" });
    const [ev, ...rest] = (await g.relations.evidence(REL)).items;
    expect(rest).toEqual([]);
    expect([ev!.source_id, ev!.source_version, ev!.quote]).toEqual(["doc", res.source_version, "Ada works at Acme"]);
    expect((await g.entities.evidence("person:ada")).items).toHaveLength(1);
    const other = { ...rel, evidence: [{ source_id: "elsewhere", quote: "q" }] };
    await g.insert.facts({ ...FACTS, relations: [other] }, { source_id: "doc2" });
    const sources = (await g.relations.evidence(REL)).items.map((e) => e.source_id).sort();
    expect(sources).toEqual(["doc", "doc2", "elsewhere"]);
    const twoSources = {
      entities: [
        { type: "Person", name: "A" },
        { type: "Person", name: "B" },
      ],
      relations: [
        {
          from_entity: "person:a",
          type: "KNOWS",
          to_entity: "person:b",
          evidence: [
            { source_id: "doc1", quote: "other" },
            { source_id: "src1", quote: "own" },
          ],
        },
      ],
    };
    const own = await g.insert.facts(twoSources, { source_id: "src1" });
    const rid = own.relations[0]!.id;
    const byQuote = new Map((await g.relations.evidence(rid)).items.map((e) => [e.quote, e]));
    expect(byQuote.get("other")!.source_version).toBe("doc1:manual");
    expect(byQuote.get("own")!.source_version).toBe(own.source_version);
    const plain = await g.insert.facts(twoSources);
    expect(plain.relations[0]!.source_count).toBe(2);
    const items = (await g.relations.evidence(rid)).items;
    expect(items.filter((e) => e.source_id === "doc1").map((e) => e.source_version)).toEqual(["doc1:manual"]);
  });

  it("counts each source once and pages through evidence", async () => {
    const g = open();
    let res = await g.insert.facts(FACTS, { source_id: "doc-0" });
    for (let i = 1; i < 5; i++) res = await g.insert.facts(FACTS, { source_id: `doc-${i}` });
    const again = await g.insert.facts(FACTS, { source_id: "doc-0" });
    expect(res.entities.map((e) => e.source_count)).toEqual([5, 5]);
    expect(again.entities.map((e) => e.source_count)).toEqual([5, 5]);
    expect(again.relations[0]!.source_count).toBe(5);
    expect((await g.entities.get("person:ada"))!.source_count).toBe(5);
    const evidence = await all((id, o) => g.entities.evidence(id, o), "person:ada");
    expect(evidence.map((e) => e.source_id).sort()).toEqual(["doc-0", "doc-1", "doc-2", "doc-3", "doc-4"]);
    expect(await all((id, o) => g.relations.evidence(id, o), REL)).toHaveLength(5);
    expect(await records(g)).toHaveLength(15);
  });

  it("counts a source once for an entity repeated in one insert", async () => {
    const g = open();
    const res = await g.insert.facts(
      {
        entities: [
          { type: "Person", name: "Ada" },
          { type: "Person", name: "Ada", aliases: ["A"] },
        ],
      },
      { source_id: "s" },
    );
    expect(res.entities.map((e) => e.source_count)).toEqual([1]);
    expect(res.entities[0]!.aliases).toEqual(["A"]);
    expect(await all((id, o) => g.entities.evidence(id, o), "person:ada")).toHaveLength(1);
  });

  it("adds relation evidence on update and never clears it", async () => {
    const g = open();
    await g.insert.facts(FACTS, { source_id: "s1" });
    const same = await g.relations.update(REL, { evidence: [{ source_id: "s2", quote: "works there" }] });
    expect([same.revision, same.source_count]).toEqual([1, 2]);
    const moved = await g.relations.update(REL, { set_properties: { role: "CTO" } });
    expect([moved.revision, moved.source_count]).toEqual([2, 2]);
    const again = await g.relations.update(REL, { evidence: [{ source_id: "s2", quote: "works there" }] });
    expect(again.source_count).toBe(2);
    const quotes = (await all((id, o) => g.relations.evidence(id, o), REL)).map((e) => [e.source_id, e.quote]).sort();
    expect(quotes).toEqual([
      ["s1", null],
      ["s2", "works there"],
    ]);
  });

  it.runIf(spec.name === "hydradb")(
    "still writes an entity mentioned by 300 sources on HydraDB",
    async () => {
      const g = open();
      let res = await g.insert.facts({ entities: [{ type: "Person", name: "Ada" }] }, { source_id: "src-0" });
      for (let i = 1; i < 300; i++) {
        res = await g.insert.facts({ entities: [{ type: "Person", name: "Ada" }] }, { source_id: `src-${i}` });
      }
      expect(res.entities[0]!.source_count).toBe(300);
      expect((await g.entities.get("person:ada"))!.source_count).toBe(300);
      const page = await g.entities.evidence("person:ada", { limit: 1000 });
      expect(page.items).toHaveLength(300);
      expect(page.next_cursor).toBeNull();
    },
    300_000,
  );
}

await forEachStore("evidence records", suite);
