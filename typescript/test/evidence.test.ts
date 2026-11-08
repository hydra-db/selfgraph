import { expect, it } from "vitest";

import { type Evidence, ids, NotFoundError, type Page, type SelfGraph } from "../src/index.js";
import { forEachStore, freshGraphs, type StoreSpec } from "./helpers.js";

const ONTOLOGY = {
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

  it("counts each source once and pages through evidence", async () => {
    const g = open();
    let res = await g.insert.ontology(ONTOLOGY, { source_id: "doc-0" });
    for (let i = 1; i < 5; i++) res = await g.insert.ontology(ONTOLOGY, { source_id: `doc-${i}` });
    const again = await g.insert.ontology(ONTOLOGY, { source_id: "doc-0" });
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
    const res = await g.insert.ontology(
      {
        entities: [
          { type: "Person", name: "Ada" },
          { type: "Person", name: "Ada", aliases: ["A"] },
        ],
      },
      { source_id: "s" },
    );
    expect(res.entities.map((e) => e.source_count)).toEqual([1, 1]);
    expect(res.entities[1]!.aliases).toEqual(["A"]);
    expect(await all((id, o) => g.entities.evidence(id, o), "person:ada")).toHaveLength(1);
  });

  it("adds relation evidence on update and never clears it", async () => {
    const g = open();
    await g.insert.ontology(ONTOLOGY, { source_id: "s1" });
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

  it("records the evidence of a created relation", async () => {
    const g = open();
    await g.entities.create("Ada", "Person");
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
  });

  it("deletes evidence with its entity or relation", async () => {
    const g = open();
    await g.insert.ontology(ONTOLOGY, { source_id: "s1" });
    await g.insert.ontology({ entities: [{ type: "Person", name: "Bob" }] }, { source_id: "s1" });
    await g.relations.delete(REL);
    expect(await records(g)).toHaveLength(3);
    await g.insert.ontology(ONTOLOGY, { source_id: "s2" });
    await g.entities.delete("person:ada");
    const remaining = (await records(g)).map((r) => `${r.target_id}|${r.source_id}`).sort();
    expect(remaining).toEqual(["company:acme|s1", "company:acme|s2", "person:bob|s1"]);
  });

  it("raises NotFoundError for the evidence of an unknown object", async () => {
    const g = open();
    await expect(g.entities.evidence("person:nobody")).rejects.toBeInstanceOf(NotFoundError);
    await expect(g.relations.evidence("relation:nothing")).rejects.toBeInstanceOf(NotFoundError);
    await g.entities.create("Ada", "Person");
    expect((await g.entities.evidence("person:ada")).items).toEqual([]);
  });

  it("keeps evidence for another source on its own manual version", async () => {
    const g = open();
    const ontology = {
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
    const res = await g.insert.ontology(ontology, { source_id: "src1" });
    const rid = res.relations[0]!.id;
    const byQuote = new Map((await g.relations.evidence(rid)).items.map((e) => [e.quote, e]));
    expect(byQuote.get("other")!.source_version).toBe("doc1:manual");
    expect(byQuote.get("own")!.source_version).toBe(res.source_version);
    const plain = await g.insert.ontology(ontology);
    expect(plain.relations[0]!.source_count).toBe(2);
    const items = (await g.relations.evidence(rid)).items;
    expect(items.filter((e) => e.source_id === "doc1").map((e) => e.source_version)).toEqual(["doc1:manual"]);
  });

  it.runIf(spec.name === "hydradb")(
    "still writes an entity mentioned by 300 sources on HydraDB",
    async () => {
      const g = open();
      let res = await g.insert.ontology({ entities: [{ type: "Person", name: "Ada" }] }, { source_id: "src-0" });
      for (let i = 1; i < 300; i++) {
        res = await g.insert.ontology({ entities: [{ type: "Person", name: "Ada" }] }, { source_id: `src-${i}` });
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
