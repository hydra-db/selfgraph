import { describe, expect, it } from "vitest";

import { type SelfGraph, ValidationError } from "../src/index.js";
import { relevanceScore } from "../src/maintenance.js";
import { NO_DELETES } from "../src/ops.js";
import {
  ANN_AT_ACME,
  captureLog,
  captureWarnings,
  forEachStore,
  freshGraphs,
  SINGLE_EMPLOYER,
  type StoreSpec,
  worksAt,
} from "./helpers.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const days = (n: number, from = T0) => new Date(from.getTime() + n * 86_400_000);
const later = (n: number) => days(n, new Date());

describe("relevance formula", () => {
  it("decays by half-life and rises with frequency", () => {
    expect(relevanceScore([T0], days(10), 7, 2)).toBe(0.309582);
  });
});

async function cascading(g: SelfGraph): Promise<void> {
  await g.entities.create("Keep", "Person", { id: "person:keep" });
  for (const name of ["x", "y"]) await g.entities.create(name, "Temp", { id: `temp:${name}` });
  await g.relations.create("person:keep", "USES", "temp:x", { evidence: [{ source_id: "s", quote: "q" }] });
  const link = await g.relations.create("temp:x", "LINKS", "temp:y");
  await g.relations.update(link.id, { set_properties: { v: 2 } });
  await g.preferences.create("person:keep", "tool", "person:keep", { about_entity: "temp:x" });
  await g.preferences.create("temp:y", "tool", "person:keep");
  await g.decisions.create("Keep", {
    steps: [],
    id: "decision:keep",
    alternative_entities: ["temp:x", "temp:y", "person:keep"],
  });
  await g.decisions.create("Gone", { steps: [link.id], id: "decision:gone" });
}

async function cascadeState(g: SelfGraph): Promise<unknown[]> {
  const pref = (await g.preferences.list("person:keep")).items[0]!;
  return [
    (await g.entities.list()).items.map((e) => e.id),
    (await g.relations.list()).items.map((r) => [r.from_entity, r.type, r.to_entity]),
    (await g.decisions.list()).items.map((d) => d.id),
    (await g.decisions.get("decision:keep"))!.alternative_entities,
    [pref.about_entity, pref.revision],
  ];
}

async function prunable(g: SelfGraph) {
  await g.entities.create("Keep", "Person", { id: "person:keep" });
  await g.entities.create("Scratch", "Temp", { id: "temp:x" });
  await g.entities.create("Scratch2", "Temp", { id: "temp:y" });
  const rel = await g.relations.create("person:keep", "USES", "temp:x");
  const other = await g.relations.create("person:keep", "USES", "temp:y");
  await g.preferences.create("temp:x", "tool", "person:keep");
  const dec = await g.decisions.create("Pick", { steps: [rel.id], id: "decision:pick", actor_entity: "person:keep" });
  return { rel, other, dec };
}

const sorted = (ids: string[]) => [...ids].sort();

function suite(spec: StoreSpec) {
  const open = freshGraphs(spec, "mt");

  it("scores in place, idempotently, and keeps relevance across updates", async () => {
    const g = open();
    await g.entities.create("A", "T", { id: "t:a", properties: { k: 1 } });
    await g.entities.create("B", "T", { id: "t:b" });
    await g.entities.create("C", "T", { id: "t:c" });
    const rel = await g.relations.create("t:a", "KNOWS", "t:b", { evidence: [{ source_id: "s1" }] });
    await g.relations.create("t:a", "LIKES", "t:c");
    const at = later(0);

    const dry = await g.maintenance.decay({ now: at, dry_run: true });
    expect([dry.updated_entities, dry.updated_relations]).toEqual([0, 0]);
    expect((await g.entities.get("t:a"))!.relevance).toBeNull();

    const before = (await g.entities.get("t:a"))!;
    const result = await g.maintenance.decay({ now: at, dry_run: false });
    expect(result.entities).toEqual(dry.entities);
    expect([result.updated_entities, result.updated_relations]).toEqual([3, 2]);
    const expected = relevanceScore([before.created_at, before.updated_at], at, 30, 2);
    expect(result.entities["t:a"]).toBe(expected);

    const a = (await g.entities.get("t:a"))!;
    expect(a.relevance).toBe(expected);
    expect(a.relevance_at!.getTime()).toBe(at.getTime());
    expect(a.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(a.properties).toEqual({ k: 1 });
    const stored = (await g.relations.get(rel.id))!;
    expect(stored.revision).toBe(1);
    expect(stored.relevance).toBe(relevanceScore([rel.created_at], at, 30, 1));
    expect(await g.relations.versions(rel.id)).toHaveLength(1);

    const again = await g.maintenance.decay({ now: at, dry_run: false });
    expect([again.updated_entities, again.updated_relations]).toEqual([0, 0]);

    await g.entities.update("t:a", { properties: { k: 2 } });
    expect((await g.entities.get("t:a"))!.relevance).toBe(expected);
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, true, "30"]) {
      await expect(g.maintenance.decay({ half_life_days: bad as number })).rejects.toThrow(ValidationError);
    }
  });

  it("breaks seed ties on relevance only after decay", async () => {
    const g = open();
    await g.entities.create("Acme Red", "Org", { id: "org:a" });
    await g.entities.create("Acme Tan", "Org", { id: "org:z" });
    for (const name of ["x", "y", "w"]) {
      await g.entities.create(name.toUpperCase(), "Thing", { id: `thing:${name}` });
      await g.relations.create("org:z", "OWNS", `thing:${name}`);
    }
    const plain = await g.retrieve("acme", { k: 2, depth: 0 });
    expect(plain.seeds.map((s) => s.id)).toEqual(["org:a", "org:z"]);
    expect(plain.seeds[0]!.score).toBe(plain.seeds[1]!.score);
    await g.maintenance.decay({ now: later(0), dry_run: false });
    const decayed = await g.retrieve("acme", { k: 2, depth: 0 });
    expect(decayed.seeds.map((s) => s.id)).toEqual(["org:z", "org:a"]);
  });

  it("prunes by relevance and never matches unscored items", async () => {
    const g = open();
    const { rel, other } = await prunable(g);
    expect((await g.maintenance.prune({ min_relevance: 1 })).entity_ids).toEqual([]);
    await g.maintenance.decay({ now: later(0), half_life_days: 1e-9, dry_run: false });
    await g.entities.create("Fresh", "Person", { id: "person:fresh" });
    const plan = await g.maintenance.prune({ min_relevance: 0.01, relation_types: ["USES"] });
    expect(plan.entity_ids).toEqual([]);
    expect(plan.relation_ids).toEqual(sorted([rel.id, other.id]));
    const { result: done } = await captureWarnings(() => g.maintenance.prune({ min_relevance: 0.01, dry_run: false }));
    expect(done.entity_ids).not.toContain("person:fresh");
    expect(await g.entities.get("person:fresh")).not.toBeNull();
    expect(await g.entities.get("person:keep")).toBeNull();
  });

  it("dedupes duplicate relations into the lowest id, unioning properties and reporting losses", async () => {
    const g = open();
    await g.entities.create("A", "T", { id: "t:a" });
    await g.entities.create("B", "T", { id: "t:b" });
    await g.relations.create("t:a", "knows", "t:b", {
      id: "relation:x1",
      properties: { w: 1, only1: true },
      evidence: [{ source_id: "s1", quote: "one" }],
    });
    await g.relations.create("t:a", "KNOWS", "t:b", {
      id: "relation:x2",
      properties: { w: 2, only2: "y" },
      event_time: "2021-01-01T00:00:00Z",
      evidence: [
        { source_id: "s2", quote: "two" },
        { source_id: "s1", quote: "one" },
      ],
    });
    await g.relations.update("relation:x2", { set_properties: { v: 2 } });
    await g.relations.create("t:a", "KNOWS", "t:b", {
      id: "relation:x3",
      properties: { only2: "q" },
      event_time: "2020-01-01T00:00:00Z",
    });
    await g.relations.create("t:b", "KNOWS", "t:a", { id: "relation:x4" });
    const dec = await g.decisions.create("D", { steps: ["relation:x2", "relation:x4"], id: "decision:d" });

    const plan = await g.maintenance.dedupeRelations();
    expect(plan.dry_run).toBe(true);
    expect(plan.groups.map((p) => [p.survivor, p.duplicates, p.type, p.conflicts, p.versions_lost])).toEqual([
      [
        "relation:x1",
        ["relation:x2", "relation:x3"],
        "KNOWS",
        { "relation:x2": ["w"], "relation:x3": ["only2"] },
        { "relation:x2": 2, "relation:x3": 1 },
      ],
    ]);
    expect(plan.note).toContain("lowest relation id");
    expect(plan.note).toContain("versions_lost");
    expect(await g.relations.get("relation:x2")).not.toBeNull();

    const { result: done, logged } = await captureLog(() => g.maintenance.dedupeRelations({ dry_run: false }));
    expect(logged).toEqual([expect.stringMatching(/^info: deduplicated 1 relation groups/)]);
    expect(done.groups[0]!.conflicts).toEqual(plan.groups[0]!.conflicts);
    expect([done.deleted?.deleted_relation_versions, done.deleted?.deleted_decisions]).toEqual([3, 0]);
    expect(await g.relations.get("relation:x2")).toBeNull();
    const survivor = (await g.relations.get("relation:x1"))!;
    expect(survivor.properties).toEqual({ w: 1, only1: true, only2: "y", v: 2 });
    expect([survivor.source_count, survivor.event_time]).toEqual([2, new Date("2020-01-01T00:00:00Z")]);
    const evidence = (await g.relations.evidence("relation:x1")).items.map((e) => [e.source_id, e.quote]);
    expect(evidence.sort()).toEqual([
      ["s1", "one"],
      ["s2", "two"],
    ]);
    expect((await g.decisions.get(dec.id))!.steps.map((s) => s.relation_id)).toEqual(["relation:x1", "relation:x4"]);
    const after = await g.maintenance.dedupeRelations();
    expect([after.groups, after.note]).toEqual([[], null]);
  });

  it("requires a prune criterion, notes an unscored prune, and rejects prune and decay times in the future", async () => {
    const g = open();
    for (const options of [{}, { types: ["Temp"] }, { dry_run: false }, { older_than: later(0.0005), dry_run: "no" }]) {
      await expect(g.maintenance.prune(options as never)).rejects.toThrow(ValidationError);
    }
    await g.entities.create("A", "T", { id: "t:a" });
    const plan = await g.maintenance.prune({ min_relevance: 0.5 });
    expect(plan.entity_ids).toEqual([]);
    expect(plan.note).toBe("no items have a relevance score yet; run maintenance.decay({ dry_run: false }) first");
    expect((await g.maintenance.prune({ older_than: later(0.0005) })).note).toBeNull();
    expect((await g.maintenance.decay({ now: later(0.0005) })).dry_run).toBe(true);
    await expect(g.maintenance.decay({ now: later(1) })).rejects.toThrow(
      /^now \d{4}-\d\d-\d\dT[\d:.]+Z is in the future/,
    );
    await expect(g.maintenance.prune({ older_than: later(1) })).rejects.toThrow(/older_than .* is in the future/);
    await g.maintenance.decay({ dry_run: false });
    expect((await g.maintenance.prune({ min_relevance: 0.5 })).note).toBeNull();
  });

  it("plans a prune, then applies it in batches with the same cascades as deleting one by one", async () => {
    const one = open();
    await cascading(one);
    const counts = { ...NO_DELETES };
    for (const eid of ["temp:x", "temp:y"]) {
      const removed = await one.entities.delete(eid);
      for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] += removed[key];
    }
    const batched = open();
    await cascading(batched);
    const cutoff = later(0.0005);
    const plan = await batched.maintenance.prune({ older_than: cutoff, types: ["Temp"] });
    expect([plan.dry_run, plan.entity_ids, plan.deleted]).toEqual([true, ["temp:x", "temp:y"], undefined]);
    expect(plan.relation_ids).toHaveLength(2);
    expect(await batched.entities.get("temp:x")).not.toBeNull();
    expect((await batched.maintenance.prune({ older_than: T0, types: ["Temp"] })).entity_ids).toEqual([]);
    const { result: done, logged } = await captureLog(() =>
      batched.maintenance.prune({ older_than: cutoff, types: ["Temp"], dry_run: false }),
    );
    expect(logged).toEqual([expect.stringMatching(/^info: pruned 2 entities and 2 relations/)]);
    expect(done.deleted).toEqual(counts);
    expect(counts).toEqual({
      deleted_entities: 2,
      deleted_relation_versions: 3,
      deleted_decisions: 1,
      deleted_preference_versions: 1,
    });
    const state = await cascadeState(one);
    expect(await cascadeState(batched)).toEqual(state);
    expect(state).toEqual([["person:keep"], [], ["decision:keep"], ["person:keep"], [null, 2]]);
  });

  it("skips relations a contradiction invalidated", async () => {
    const g = open({ contradiction: "supersede", schema: SINGLE_EMPLOYER });
    await g.insert.facts({ entities: ANN_AT_ACME.entities });
    const ids: string[] = [];
    for (const [company, year] of [
      ["acme", 2020],
      ["globex", 2021],
    ] as const) {
      const res = await g.insert.facts({ relations: [worksAt("person:ann", `company:${company}`, year)] });
      ids.push(res.relations[0]!.id);
    }
    const [acme, globex] = ids;
    const decay = await g.maintenance.decay({ now: later(0), dry_run: false });
    expect(Object.keys(decay.relations)).toEqual([globex]);
    expect(decay.updated_relations).toBe(1);
    expect((await g.maintenance.dedupeRelations()).groups).toEqual([]);
    const plan = await g.maintenance.prune({ older_than: later(0.0005), relation_types: ["WORKS_AT"] });
    expect(plan.relation_ids).toEqual([globex]);
    await g.maintenance.prune({ older_than: later(0.0005), relation_types: ["WORKS_AT"], dry_run: false });
    expect((await g.relations.list({ include_invalidated: true })).items.map((r) => r.id)).toEqual([acme]);
  });

  it("repoints every step on dedupeRelations and never deletes a decision", async () => {
    const g = open();
    for (const n of ["a", "b", "c"]) await g.entities.create(n.toUpperCase(), "T", { id: `t:${n}` });
    for (const id of ["relation:x1", "relation:x2", "relation:x3"])
      await g.relations.create("t:a", "KNOWS", "t:b", { id });
    for (const id of ["relation:y1", "relation:y2"]) await g.relations.create("t:b", "KNOWS", "t:c", { id });
    await g.relations.update("relation:x3", { set_properties: { v: 2 } });
    await g.relations.update("relation:x3", { set_properties: { v: 3 } });
    const steps: Record<string, string[]> = {
      "decision:both": ["relation:x1", "relation:x2"],
      "decision:versions": ["relation:x3"],
      "decision:groups": ["relation:x3", "relation:y2", "relation:x2"],
    };
    for (const [id, rels] of Object.entries(steps)) await g.decisions.create(id, { steps: rels, id });
    const done = await g.maintenance.dedupeRelations({ dry_run: false });
    expect([done.deleted?.deleted_decisions, done.deleted?.deleted_relation_versions]).toEqual([0, 5]);
    const got: Record<string, string[]> = {};
    for (const id of Object.keys(steps)) got[id] = (await g.decisions.get(id))!.steps.map((s) => s.relation_id);
    expect(got).toEqual({
      "decision:both": ["relation:x1", "relation:x1"],
      "decision:versions": ["relation:x1"],
      "decision:groups": ["relation:x1", "relation:y1", "relation:x1"],
    });
    const h = open({ contradiction: "supersede", schema: SINGLE_EMPLOYER });
    await h.insert.facts({ entities: ANN_AT_ACME.entities });
    const old = await h.relations.create("person:ann", "WORKS_AT", "company:acme");
    await h.relations.create("person:ann", "WORKS_AT", "company:globex", { id: "relation:g1" });
    await h.relations.create("person:ann", "WORKS_AT", "company:globex", { id: "relation:g2", contradiction: "off" });
    await h.decisions.create("Move", { steps: [old.id, "relation:g2"], id: "decision:move" });
    const merged = await h.maintenance.dedupeRelations({ dry_run: false });
    expect(merged.groups.map((p) => [p.survivor, p.duplicates])).toEqual([["relation:g1", ["relation:g2"]]]);
    expect(merged.deleted?.deleted_decisions).toBe(0);
    expect((await h.decisions.get("decision:move"))!.steps.map((s) => s.relation_id)).toEqual([old.id, "relation:g1"]);
  });

  it("matches types against entities and relation_types against relations", async () => {
    const g = open();
    await g.entities.create("X", "Thing", { id: "thing:x" });
    await g.entities.create("Y", "Thing", { id: "thing:y" });
    await g.entities.create("Z", "Gadget", { id: "gadget:z" });
    const gadget = await g.relations.create("thing:x", "GADGET", "thing:y");
    const cutoff = later(0.0005);
    const byType = await g.maintenance.prune({ older_than: cutoff, types: ["Gadget"] });
    expect([byType.entity_ids, byType.relation_ids]).toEqual([["gadget:z"], []]);
    const byRel = await g.maintenance.prune({ older_than: cutoff, relation_types: ["gadget"] });
    expect([byRel.entity_ids, byRel.relation_ids]).toEqual([[], [gadget.id]]);
  });
}

await forEachStore("maintenance", suite);
