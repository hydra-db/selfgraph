import { expect, it, vi } from "vitest";
import { HydraDBStore, KuzuStore, StoreError, ValidationError } from "../src/index.js";
import { encodeRelationProps } from "../src/serde.js";
import { CypherPrimitives } from "../src/stores/cypherPrimitives.js";
import { forEachStore, freshGraphs, type StoreSpec } from "./helpers.js";

const EARLY = new Date("1900-01-01T00:00:00Z");
const LATE = new Date("2100-01-01T00:00:00Z");

const AB_FACTS = {
  entities: [
    { type: "T", name: "A", id: "t:a" },
    { type: "T", name: "B", id: "t:b" },
  ],
  relations: [{ id: "relation:ab", from_entity: "t:a", type: "KNOWS", to_entity: "t:b" }],
};

async function instant(): Promise<Date> {
  await new Promise((r) => setTimeout(r, 10));
  const stamp = new Date();
  await new Promise((r) => setTimeout(r, 10));
  return stamp;
}

function suite(spec: StoreSpec): void {
  const open = freshGraphs(spec, "diff");

  async function factsGraph() {
    const g = open();
    await g.insert.facts(AB_FACTS, { source_id: "doc-1" });
    return g;
  }

  it("lists every write oldest first, with counts", async () => {
    const g = await factsGraph();
    const out = await g.diff(EARLY, LATE);
    expect(out.changes.map((c) => [c.kind, c.action])).toEqual([
      ["entity", "created"],
      ["entity", "created"],
      ["relation", "created"],
      ["source", "created"],
    ]);
    expect(out.changes.map((c) => c.id)).toEqual(["t:a", "t:b", "relation:ab", "doc-1"]);
    expect(out.changes[0]!.summary).toBe("T A");
    expect(out.changes[2]!.summary).toBe("KNOWS t:a -> t:b");
    expect(out.changes[3]!.summary).toMatch(/^version /);
    expect(out.total).toBe(4);
    expect(out.counts).toEqual({ entity: 2, relation: 1, source: 1 });
  });

  it("reads the half open window between two times", async () => {
    const g = await factsGraph();
    const mid = await instant();
    await g.entities.create("C", "T");
    const all = await g.diff(EARLY, LATE);
    expect(all.total).toBe(5);
    const since = await g.diff(mid, LATE);
    expect(since.total).toBe(1);
    expect(since.changes.map((c) => c.id)).toEqual(["t:c"]);
    const until = await g.diff(EARLY, mid);
    expect(until.total).toBe(4);
    const last = all.changes[all.changes.length - 1]!.at;
    expect((await g.diff(last, LATE)).total).toBe(0);
    const empty = await g.diff(await instant(), LATE);
    expect(empty.total).toBe(0);
    expect(empty.counts).toEqual({});
    expect(empty.changes).toEqual([]);
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
    expect(diff.limitations).toContain("Deletes are not visible.");
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
      expect(edges.mock.calls.every(([, o]) => o?.limit === 500)).toBe(true);
      expect(edges.mock.calls.some(([, o]) => o?.skip === 500)).toBe(true);
      expect(nodes.mock.calls.some(([, , o]) => o?.skip === 500)).toBe(true);
      expect(writes).not.toHaveBeenCalled();
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

  it("records updates, retirements, certifications, preferences, merges, and unmerges", async () => {
    const g = open({
      schema: {
        entities: [{ name: "Person" }, { name: "Company" }],
        relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 } }],
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
    const acme = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    const globex = await g.relations.create("person:ann", "WORKS_AT", "company:globex");
    await g.relations.certify(globex.id, { by: "qa" });
    await g.relations.uncertify(globex.id);
    const pref = await g.preferences.create("person:ann", "tool", "company:acme", { strength: 0.5 });
    await g.preferences.update(pref.id, { strength: 0.9 });
    const res = await g.insert.facts({ entities: [{ type: "Person", name: "Robert Smith", aliases: ["Bob Smith"] }] });
    const robert = res.entities[0]!.id;
    const merge = (await g.insert.facts({ entities: [{ type: "Person", name: "bob smith" }] })).merges[0];
    await g.entities.unmerge(merge!.id);
    const out = await g.diff(EARLY, LATE);
    const kind = (k: string) => out.changes.filter((c) => c.kind === k).map((c) => [c.action, c.id, c.summary]);
    expect(kind("relation")).toEqual([
      ["created", acme.id, "WORKS_AT person:ann -> company:acme"],
      ["created", globex.id, "WORKS_AT person:ann -> company:globex"],
      ["retired", acme.id, `WORKS_AT person:ann -> company:acme (by ${globex.id})`],
      ["certified", globex.id, `WORKS_AT person:ann -> company:globex (by qa)`],
      ["uncertified", globex.id, `WORKS_AT person:ann -> company:globex (by qa)`],
    ]);
    expect(kind("preference")).toEqual([
      ["created", pref.id, "preference tool: person:ann -> company:acme"],
      ["updated", pref.id, "preference tool: person:ann -> company:acme"],
    ]);
    expect(kind("merge")).toEqual([
      ["merged", merge!.id, `${merge!.absorbed_id} into ${merge!.survivor_id}: alias`],
      ["unmerged", merge!.id, `${merge!.absorbed_id} back out of ${merge!.survivor_id}`],
    ]);
    expect(kind("entity")).toContainEqual(["created", robert, "Person Robert Smith"]);
  });

  it("keeps certification events from older versions after a relation update", async () => {
    const g = await factsGraph();
    const rel = await g.relations.get(AB_FACTS.relations[0]!.id);
    await g.relations.certify(rel!.id, { by: "qa" });
    await g.relations.update(rel!.id, { set_properties: { weight: 2 } });
    const out = await g.diff(EARLY, LATE);
    const certified = out.changes.filter((c) => c.kind === "relation").map((c) => [c.action, c.id]);
    expect(certified).toEqual([
      ["created", rel!.id],
      ["certified", rel!.id],
      ["updated", rel!.id],
    ]);
  });

  it("filters by kind and keeps counts over the whole window when limited", async () => {
    const g = await factsGraph();
    await g.preferences.create("t:a", "tool", "t:b");
    const whole = await g.diff(EARLY, LATE);
    const out = await g.diff(EARLY, LATE, { kinds: ["entity"] });
    expect(out.total).toBe(whole.total);
    expect(out.counts).toEqual(whole.counts);
    expect(out.changes.every((c) => c.kind === "entity")).toBe(true);
    const limited = await g.diff(EARLY, LATE, { limit: 2 });
    expect(limited.total).toBe(whole.total);
    expect(limited.counts).toEqual(whole.counts);
    expect(limited.changes).toEqual(whole.changes.slice(-2));
    const entityLimited = await g.diff(EARLY, LATE, { kinds: ["entity"], limit: 1 });
    expect(entityLimited.total).toBe(whole.total);
    expect(entityLimited.changes).toEqual(out.changes.slice(-1));
  });

  it("rejects bad arguments", async () => {
    const g = await factsGraph();
    await expect(g.diff(EARLY, LATE, { kinds: ["nope"] })).rejects.toThrow(ValidationError);
    await expect(g.diff(EARLY, LATE, { limit: 0 })).rejects.toThrow(ValidationError);
    await expect(g.diff("yesterday")).rejects.toThrow(ValidationError);
  });
}
await forEachStore("diff reads", suite);

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
  expect(store.query).toContain("ORDER BY r.id, r.revision SKIP $skip LIMIT $limit");
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
        expect(query).toContain("ORDER BY r.sid, r.revision SKIP 500 LIMIT 500");
      } else {
        expect(query).toContain("r.revision AS __rev");
        expect(query).toContain("ORDER BY __ob, __rev SKIP $skip LIMIT $limit");
      }
    } finally {
      capture.mockRestore();
      await store.close();
    }
  }
});
