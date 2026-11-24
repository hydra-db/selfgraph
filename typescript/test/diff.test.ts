import { expect, it, vi } from "vitest";
import { HydraDBStore, KuzuStore, StoreError, ValidationError } from "../src/index.js";
import { encodeRelationProps } from "../src/serde.js";
import { CypherPrimitives } from "../src/stores/cypherPrimitives.js";
import { forEachStore, freshGraphs, type StoreSpec } from "./helpers.js";

async function instant(): Promise<Date> {
  await new Promise((r) => setTimeout(r, 10));
  const stamp = new Date();
  await new Promise((r) => setTimeout(r, 10));
  return stamp;
}

function suite(spec: StoreSpec): void {
  const open = freshGraphs(spec, "diff");
  it("lists preference, decision, merge, unmerge, and source history", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Anvil", "Tool");
    await g.insert.facts({ entities: [{ type: "Person", name: "Mergia Robert", aliases: ["Mergia Bob"] }] });
    const start = await instant();
    const pref = await g.preferences.create("person:ann", "tool", "tool:anvil");
    await g.preferences.update(pref.id, { strength: 0.5 });
    const decision = await g.decisions.create("Pick a tool");
    const written = await instant();
    await g.decisions.update(decision.id, { summary: "the anvil" });
    const merged = await g.insert.facts(
      { entities: [{ type: "Person", name: "Mergia Bob" }] },
      { source_id: "doc", resolver: "default" },
    );
    const [record] = merged.merges;
    const middle = await instant();
    await g.entities.unmerge(record!.id);
    const end = await instant();
    const d = await g.diff(start, end);
    expect(d.preferences_added.map((p) => [p.id, p.revision])).toEqual([[pref.id, 1]]);
    expect(d.preferences_revised.map((p) => [p.id, p.revision, p.strength])).toEqual([[pref.id, 2, 0.5]]);
    expect(d.decisions_created.map((t) => t.id)).toEqual([decision.id]);
    expect(d.decisions_updated.map((t) => [t.id, t.summary])).toEqual([[decision.id, "the anvil"]]);
    expect(d.entities_merged.map((m) => [m.id, m.absorbed_id, m.survivor_id])).toEqual([
      [record!.id, record!.absorbed_id, record!.survivor_id],
    ]);
    expect(d.entities_unmerged.map((m) => [m.id, m.reverted_at !== null])).toEqual([[record!.id, true]]);
    expect(d.source_versions_added.map((v) => [v.source_id, v.id, v.media_type])).toEqual([
      ["doc", merged.source_version, "application/octet-stream"],
    ]);
    const early = await g.diff(start, written);
    expect(early.decisions_created.map((t) => t.id)).toEqual([decision.id]);
    expect([early.decisions_updated, early.entities_merged, early.source_versions_added]).toEqual([[], [], []]);
    const late = await g.diff(middle, end);
    expect([late.entities_merged, late.preferences_added, late.decisions_created]).toEqual([[], [], []]);
    expect(late.entities_unmerged.map((m) => m.id)).toEqual([record!.id]);
    const { since: _s, until: _u, limitations: _l, ...after } = await g.diff(end);
    expect(Object.values(after).every((list) => list.length === 0)).toBe(true);
  });

  it("lists certify and uncertify by their own times", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Bob", "Person");
    const rel = await g.relations.create("person:ann", "KNOWS", "person:bob");
    const start = await instant();
    await g.relations.certify(rel.id, { by: "alice" });
    const certified = await instant();
    await g.relations.certify(rel.id, { by: "bob" });
    const switched = await instant();
    await g.relations.uncertify(rel.id);
    const end = await instant();
    const first = await g.diff(start, certified);
    expect(first.relations_certified.map((r) => [r.id, r.revision])).toEqual([[rel.id, 1]]);
    expect([first.relations_uncertified, first.relations_added, first.relations_revised]).toEqual([[], [], []]);
    const second = await g.diff(certified, switched);
    expect(second.relations_certified.map((r) => r.id)).toEqual([rel.id]);
    expect(second.relations_uncertified.map((r) => r.id)).toEqual([rel.id]);
    const third = await g.diff(switched, end);
    expect(third.relations_certified).toEqual([]);
    expect(third.relations_uncertified.flatMap((r) => r.certifications.map((c) => [c.by, c.until !== null]))).toEqual([
      ["alice", true],
      ["bob", true],
    ]);
  });

  it("reads certifications from every version", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Bob", "Person");
    const rel = await g.relations.create("person:ann", "KNOWS", "person:bob");
    const start = await instant();
    await g.relations.certify(rel.id, { by: "alice" });
    await g.relations.update(rel.id, { set_properties: { n: 2 } });
    const d = await g.diff(start);
    expect(d.relations_certified.map((r) => [r.id, r.revision, r.is_current])).toEqual([[rel.id, 1, false]]);
    expect(d.relations_revised.map((r) => [r.id, r.revision])).toEqual([[rel.id, 2]]);
  });

  it("certify, update, uncertify ends the certification at the update", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Bob", "Person");
    const rel = await g.relations.create("person:ann", "KNOWS", "person:bob");
    const start = await instant();
    await g.relations.certify(rel.id, { by: "alice" });
    const revised = await g.relations.update(rel.id, { set_properties: { n: 2 } });
    await g.relations.uncertify(rel.id);
    const d = await g.diff(start);
    expect(d.relations_certified.map((r) => [r.id, r.revision])).toEqual([[rel.id, 1]]);
    expect(d.relations_uncertified.map((r) => [r.id, r.revision])).toEqual([[rel.id, 1]]);
    expect(d.relations_uncertified[0]!.certifications[0]!.until).toEqual(revised.created_at);
  });

  it("reports a certification once after a delete copies it to a new revision", async () => {
    const g = open({
      schema: {
        entities: [{ name: "Person" }, { name: "Company" }],
        relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 } }],
      },
      contradiction: "supersede",
    });
    for (const name of ["Acme", "Globex", "Initech"]) await g.entities.create(name, "Company");
    await g.entities.create("Ann", "Person");
    const start = await instant();
    const acme = await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: "2020-01-01" });
    await g.relations.certify(acme.id, { by: "alice" });
    const globex = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: "2021-01-01" });
    await g.relations.uncertify(acme.id);
    await g.relations.create("person:ann", "WORKS_AT", "company:initech", { event_time: "2022-01-01" });
    const deleting = await instant();
    await g.relations.delete(globex.id);
    const end = await instant();
    const d = await g.diff(start, end);
    expect(d.relations_certified.map((r) => [r.id, r.revision])).toEqual([[acme.id, 1]]);
    expect(d.relations_uncertified.map((r) => [r.id, r.revision])).toEqual([[acme.id, 1]]);
    const later = await g.diff(deleting, end);
    expect([later.relations_certified, later.relations_uncertified]).toEqual([[], []]);
  });

  it("reports known-time revisions and exact boundaries without writes", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Acme", "Company");
    const first = await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: "2000-01-01" });
    const second = await g.relations.update(first.id, { set_properties: { role: "cto" } });
    const diff = await g.diff("1999-01-01", second.created_at);
    expect(diff.relations_added.map((r) => [r.id, r.revision])).toEqual([[first.id, 1]]);
    expect(diff.relations_revised.map((r) => [r.id, r.revision])).toEqual([[first.id, 2]]);
    expect(diff.entities_created.map((e) => e.id)).toEqual(["company:acme", "person:ann"]);
    expect(diff.limitations).toEqual(["Deletes and entity edits are not visible."]);
    const boundary = await g.diff(first.created_at, second.created_at);
    expect(boundary.relations_added).toEqual([]);
    expect(boundary.relations_revised.map((r) => r.revision)).toEqual([2]);
    expect((await g.diff(second.created_at, second.created_at)).relations_revised).toEqual([]);
    expect(await open().diff("1999-01-01", "2100-01-01")).toMatchObject({ entities_created: [], relations_added: [] });
    await expect(g.diff("bad")).rejects.toThrow(ValidationError);
    await expect(g.diff("2026-01-02", "2026-01-01")).rejects.toThrow("until must be at or after since");
    await g.close();
    await expect(g.diff("1999-01-01")).rejects.toThrow(StoreError);
  });
  it("normalizes offsets, preserves microsecond boundaries, and counts updates as revisions", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Acme", "Company");
    const first = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    const again = await g.relations.update(first.id, { set_properties: { role: "cto" } });
    const result = await g.diff("1900-01-01T05:30:00+05:30", "2100-01-01");
    expect(result.since.toISOString()).toBe("1900-01-01T00:00:00.000Z");
    expect(result.relations_added.map((r) => r.revision)).toEqual([1]);
    expect(result.relations_revised.map((r) => r.revision)).toEqual([again.revision]);
    const empty = await g.diff("2100-01-01T00:00:00.000001Z", "2100-01-01T00:00:00.000002Z");
    expect(empty.relations_added).toEqual([]);
    await expect(g.diff("2100-01-01T00:00:00.000002Z", "2100-01-01T00:00:00.000001Z")).rejects.toThrow(
      "until must be at or after since",
    );
    expect((await g.diff(first.created_at)).relations_added).toEqual([]);
  });

  it("pages records and performs no writes after initialization", async () => {
    const g = open();
    const entities = Array.from({ length: 505 }, (_, i) => ({ type: "T", name: String(i) }));
    await g.insert.facts({
      entities,
      relations: entities.map((_, i) => ({
        id: `relation:page-${i}`,
        from_entity: "t:0",
        type: "KNOWS",
        to_entity: "t:1",
      })),
    });
    const edges = vi.spyOn(g.store, "matchEdges");
    const nodes = vi.spyOn(g.store, "matchNodes");
    const writes = vi.spyOn(g.store, "upsertNode").mockImplementation(async () => {
      throw new Error("diff wrote");
    });
    try {
      const result = await g.diff("1900-01-01", "2100-01-01");
      expect(result.entities_created).toHaveLength(505);
      expect(new Set(result.relations_added.map((r) => r.id)).size).toBe(505);
      expect(edges.mock.calls.every(([, o]) => Array.isArray(o?.from_in))).toBe(true);
      expect(nodes.mock.calls.some(([, , o]) => typeof o?.id_gt === "string")).toBe(true);
      expect(writes).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reads every decision of the diff and the decision list in one batch", async () => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Anvil", "Tool");
    const rel = await g.relations.create("person:ann", "USES", "tool:anvil");
    const start = await instant();
    const decisions = [];
    for (let i = 0; i < 20; i++) decisions.push(await g.decisions.create(`Pick ${i}`, { steps: [rel.id, rel.id] }));
    const reads = ["getNode", "childNodes", "matchNodes", "matchEdges"].map((name) =>
      vi.spyOn(g.store, name as "getNode"),
    );
    const count = (): number => reads.reduce((total, spy) => total + spy.mock.calls.length, 0);
    try {
      const d = await g.diff(start);
      expect(d.decisions_created.map((t) => t.id).sort()).toEqual(decisions.map((t) => t.id).sort());
      expect(d.decisions_created.every((t) => t.steps.map((s) => s.relation_id).join() === `${rel.id},${rel.id}`)).toBe(
        true,
      );
      expect([reads[0]!.mock.calls.length, reads[1]!.mock.calls.length]).toEqual([0, 0]);
      expect(count()).toBeLessThanOrEqual(12);
      for (const spy of reads) spy.mockClear();
      const listed = (await g.decisions.list()).items;
      expect(listed.map((t) => t.steps.length)).toEqual(Array(20).fill(2));
      expect(count()).toBeLessThanOrEqual(3);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([499, 500, 501, 505, 1005])("pages every revision of one relation with %i revisions", async (count) => {
    const g = open();
    await g.entities.create("A", "T");
    await g.entities.create("B", "T");
    const stamp = new Date();
    await g.store.createEdges(
      g.namespace,
      "Entity",
      "Entity",
      Array.from({ length: count }, (_, i) => [
        "KNOWS",
        "t:a",
        "t:b",
        encodeRelationProps({
          ns: g.namespace,
          id: "relation:many",
          revision: count - i,
          properties: {},
          event_time: null,
          created_at: stamp,
          is_current: i === 0,
          source_count: 0,
        }),
      ]),
    );
    const result = await g.diff("1900-01-01", "2100-01-01");
    expect(result.relations_added.map((r) => [r.id, r.revision])).toEqual([["relation:many", 1]]);
    expect(result.relations_revised.map((r) => [r.id, r.revision])).toEqual(
      Array.from({ length: count - 1 }, (_, i) => ["relation:many", i + 2]),
    );
    expect(result.relations_retired).toEqual([]);
  });

  it("reports delete restorations, late corrections, and quiet restatements", async () => {
    const g = open({
      schema: {
        entities: [{ name: "Person" }, { name: "Company" }],
        relations: [{ type: "WORKS_AT", from: { max_count: 1 } }],
      },
      contradiction: "supersede",
    });
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Ann" },
        ...["Acme", "Globex", "Initech"].map((name) => ({ type: "Company", name })),
      ],
    });
    const a = await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: "2000-01-01" });
    const c = await g.relations.create("person:ann", "WORKS_AT", "company:initech", { event_time: "2004-01-01" });
    const before = new Date();
    const b = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: "2002-01-01" });
    const d = await g.diff(before);
    expect(d.relations_added.map((r) => r.id)).toEqual([b.id]);
    expect(d.relations_revised.map((r) => [r.id, r.revision])).toEqual([[a.id, 2]]);
    expect(Object.fromEntries(d.relations_retired.map((r) => [r.id, r.invalidated_by]))).toEqual({
      [a.id]: b.id,
      [b.id]: c.id,
    });
    const quietStart = new Date();
    await g.insert.facts({
      relations: [{ from_entity: "person:ann", type: "WORKS_AT", to_entity: "company:initech" }],
    });
    const quiet = await g.diff(quietStart);
    expect([quiet.relations_added, quiet.relations_revised, quiet.relations_retired]).toEqual([[], [], []]);
    expect((await g.relations.get(c.id))?.event_time).toEqual(c.event_time);
    const deleteStart = new Date();
    await g.relations.delete(c.id);
    const deleted = await g.diff(deleteStart);
    expect(deleted.relations_added).toEqual([]);
    expect(deleted.relations_retired).toEqual([]);
    expect(deleted.relations_revised.map((r) => [r.id, r.revision])).toEqual([[b.id, 2]]);
    expect(await g.relations.get(c.id)).toBeNull();
  });

  it("reports supersede and source-replacement retirements", async () => {
    const g = open({
      schema: {
        entities: [{ name: "Person" }, { name: "Company" }],
        relations: [{ type: "WORKS_AT", from: { max_count: 1 } }],
      },
      contradiction: "supersede",
    });
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
        { type: "Company", name: "Globex" },
      ],
    });
    const a = await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: "2000-01-01" });
    const b = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: "2001-01-01" });
    const diff = await g.diff("1900-01-01", "2100-01-01");
    expect(diff.relations_retired.map((r) => [r.id, r.invalidated_by])).toEqual([[a.id, b.id]]);
    const ended = diff.relations_retired[0]!.invalidated_known_at!;
    expect((await g.diff(ended, ended)).relations_retired).toEqual([]);
    const revived = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    const later = await g.diff(ended, revived.created_at);
    expect(later.relations_revised.map((r) => [r.id, r.revision])).toEqual([[a.id, 2]]);
    expect(later.relations_retired.map((r) => r.id)).toEqual([b.id]);
    await g.insert.facts({
      relations: [
        {
          id: b.id,
          from_entity: "person:ann",
          type: "WORKS_AT",
          to_entity: "company:globex",
          properties: { note: "still retired" },
          event_time: "1900-01-01",
        },
      ],
    });
    const copied = await g.diff(revived.created_at, "2100-01-01");
    expect(copied.relations_retired).toEqual([]);
    expect(copied.relations_revised.map((r) => [r.id, r.revision])).toEqual([[b.id, 2]]);
    await g.insert.text("Ann works at Acme in Paris.", { source_id: "note" });
    await g.insert.text("Ann works at Globex in Berlin.", { source_id: "note", replace_source: true });
    expect((await g.diff("1900-01-01", "2100-01-01")).relations_retired.length).toBeGreaterThan(1);
    await g.relations.delete(b.id);
    expect((await g.diff("1900-01-01", "2100-01-01")).relations_added.some((r) => r.id === b.id)).toBe(false);
  });
}
await forEachStore("graph diff", suite);

it("orders Bolt edge pages by relation id and revision", async () => {
  class Capture extends CypherPrimitives {
    query = "";
    protected async _run(query: string) {
      this.query = query;
      return { columns: [], rows: [], counters: {}, warnings: [] };
    }
  }
  const store = new Capture();
  await store.matchEdges("test", { from_label: "Entity", current_only: false, skip: 500, limit: 500 });
  expect(store.query).toContain("ORDER BY r.id, r.revision, from_e, to_e, t SKIP $skip LIMIT $limit");
});

it("orders document-backed edge pages by id and revision", async () => {
  const stores = [new KuzuStore(":memory:"), new HydraDBStore("bolt://localhost:17687", { auth: ["neo4j", "test"] })];
  for (const store of stores) {
    const capture = vi.spyOn(store as unknown as { _run: (query: string) => Promise<unknown> }, "_run");
    capture.mockResolvedValue({ columns: [], rows: [], counters: {}, warnings: [] });
    try {
      await store.matchEdges("test", { from_label: "Entity", skip: 500, limit: 500 });
      const query = capture.mock.calls[0]![0];
      if (store instanceof KuzuStore) {
        expect(query).toContain("ORDER BY r.sid, r.revision, a.id, b.id, r.etype SKIP 500 LIMIT 500");
      } else {
        expect(query).toContain("r.revision AS __rev");
        expect(query).toContain("ORDER BY __ob, __rev, fa, tb, et SKIP $skip LIMIT $limit");
      }
    } finally {
      capture.mockRestore();
      await store.close();
    }
  }
});
