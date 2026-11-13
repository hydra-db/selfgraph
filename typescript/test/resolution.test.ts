import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  DefaultResolver,
  decisionId,
  EntityInput,
  type Extraction,
  entityId,
  type LLMClient,
  LLMResolver,
  NotFoundError,
  preferenceId,
  type ResolutionDecision,
  relationId,
  SelfGraph,
  settingsFromEnv,
  ValidationError,
} from "../src/index.js";
import { nameSimilarity } from "../src/resolution.js";
import { forEachStore, freshGraphs, SINGLE_EMPLOYER, type StoreSpec, storedEntity, worksAt } from "./helpers.js";

const IBM = entityId("Company", "International Business Machines");
const BIG_BLUE = entityId("Company", "Big Blue");
const ADA = entityId("Person", "Ada");

const input = (value: EntityInput) => EntityInput.parse(value);

class FakeLLM implements LLMClient {
  readonly calls: Array<{ system: string; user: string }> = [];
  constructor(private readonly same: boolean) {}

  async generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T> {
    this.calls.push({ system: args.system, user: args.user });
    return args.output.parse({ same: this.same });
  }
}

describe("DefaultResolver", () => {
  it("type-gates similarity, matches a candidate alias against target aliases, and breaks the tie by id", () => {
    const stored = [
      storedEntity({ id: "company:jonathan-smith", type: "Company", name: "Jonathan Smith" }),
      storedEntity({ id: "person:jane3", type: "Person", name: "Jane" }),
      storedEntity({ id: "person:jane", type: "Person", name: "Jane Doe", aliases: ["Jane"] }),
      storedEntity({ id: "person:jd", type: "Person", name: "J D", aliases: ["JD"] }),
    ];
    const decide = (name: string, aliases: string[], fuzzy = false) =>
      new DefaultResolver({ fuzzy }).decide(input({ type: "Person", name, aliases }), stored).target_id;
    expect(decide("Jonathon Smith", [], true)).toBeNull();
    expect(decide("Janie", ["Jane"])).toBe("person:jane");
    expect(decide("Jay", ["jd"])).toBe("person:jd");
  });

  it("validates its arguments, reads the env setting, and merges lexical matches without asking the LLM", async () => {
    expect(() => new DefaultResolver({ threshold: 0 })).toThrow(ValidationError);
    expect(() => new DefaultResolver({ threshold: 1.5 })).toThrow(ValidationError);
    expect(() => new LLMResolver(new FakeLLM(true), { band: [0.9, 0.8] })).toThrow(ValidationError);
    const store = {} as never;
    expect(() => new SelfGraph(store, { resolver: "fuzzier" as never })).toThrow(/one of exact, default, fuzzy, llm/);
    expect(() => new SelfGraph(store, { resolver: {} as never })).toThrow(ValidationError);
    expect(() => new SelfGraph(store, { resolver: "llm" })).toThrow(/needs an LLM/);
    expect(settingsFromEnv({}, { SELFGRAPH_RESOLVER: "fuzzy" }).resolver).toBe("fuzzy");
    expect(settingsFromEnv({ resolver: "exact" }, { SELFGRAPH_RESOLVER: "default" }).resolver).toBe("exact");
    const fake = new FakeLLM(false);
    const stored = [storedEntity({ id: "person:robert", type: "Person", name: "Robert", aliases: ["Bob"] })];
    const decision = await new LLMResolver(fake).resolve(input({ type: "Person", name: "Bob" }), stored);
    expect([decision.reason, fake.calls]).toEqual(["alias", []]);
  });
});

const BOB = entityId("Person", "Bob");
const ROBERT = entityId("Person", "Robert");
const TOOL = entityId("Tool", "Hammer");

const RICH: Extraction = {
  entities: [
    { type: "Person", name: "Bob" },
    { type: "Tool", name: "Hammer" },
  ],
  relations: [
    {
      from_entity: BOB,
      type: "USES",
      to_entity: TOOL,
      properties: { since: 2020 },
      event_time: "2024-02-01T00:00:00+00:00",
    },
    { from_entity: ADA, type: "KNOWS", to_entity: BOB },
  ],
  preferences: [
    { subject_entity: BOB, key: "tool", value_entity: TOOL, strength: 0.5 },
    { subject_entity: ADA, key: "friend", value_entity: BOB, about_entity: BOB },
  ],
  decisions: [
    {
      title: "Pick a hammer",
      actor_entity: BOB,
      outcome_entity: TOOL,
      alternative_entities: [BOB, ADA],
      steps: [relationId(BOB, "USES", TOOL)],
    },
  ],
};

function suite(spec: StoreSpec) {
  const open = freshGraphs(spec, "res");
  const ids = async (g: SelfGraph) => (await g.entities.list({ limit: 1000 })).items.map((e) => e.id).sort();
  const seed = (g: SelfGraph, ...entities: Extraction["entities"] & object[]) => g.insert.facts({ entities });

  it("leaves exact mode unchanged", async () => {
    const g = open();
    await seed(g, { type: "Company", name: "International Business Machines", external_ids: { ticker: "IBM" } });
    const res = await g.insert.facts({
      entities: [{ type: "Company", name: "Big Blue", external_ids: { ticker: "IBM" } }],
    });
    expect(res.merges).toEqual([]);
    expect(res.warnings.filter((w) => w.code === "entity_merged")).toEqual([]);
    expect(await ids(g)).toEqual([BIG_BLUE, IBM]);
  });

  it("merges on an external id, rewrites relations, and records the merge", async () => {
    const g = open({ resolver: "default" });
    await seed(
      g,
      { type: "Company", name: "International Business Machines", external_ids: { ticker: "IBM" } },
      { type: "Person", name: "Ada" },
    );
    const res = await g.insert.facts(
      {
        entities: [{ type: "Company", name: "Big Blue", aliases: ["IBM"], external_ids: { ticker: "IBM" } }],
        relations: [{ from_entity: ADA, type: "WORKS_AT", to_entity: BIG_BLUE }],
      },
      { source_id: "doc-1" },
    );
    expect(await ids(g)).toEqual([IBM, ADA]);
    expect(res.entities.map((e) => e.id)).toEqual([IBM]);
    expect(res.relations[0]!.id).toBe(relationId(ADA, "WORKS_AT", IBM));
    const [merge] = res.merges;
    expect([merge!.survivor_id, merge!.absorbed_id, merge!.reason, merge!.confidence]).toEqual([
      IBM,
      BIG_BLUE,
      "external_id",
      1,
    ]);
    expect(merge!.source_id).toBe("doc-1");
    expect(merge!.added_aliases).toEqual(["Big Blue", "IBM"]);
    expect(merge!.absorbed.name).toBe("Big Blue");
    expect(merge!.rewrites.map((r) => [r.kind, r.id, r.existed])).toEqual([["relation", res.relations[0]!.id, false]]);
    expect(res.warnings.map((w) => w.code)).toEqual(["entity_merged"]);
    const survivor = (await g.entities.get(IBM))!;
    expect([survivor.name, survivor.aliases]).toEqual(["International Business Machines", ["IBM", "Big Blue"]]);
    expect((await g.entities.merges(IBM)).items.map((m) => m.id)).toEqual([merge!.id]);
    const explicit = await g.insert.facts({
      entities: [{ id: "company:ibm", type: "Company", name: "IBM", external_ids: { ticker: "IBM" } }],
    });
    expect(explicit.merges).toEqual([]);
    expect(await ids(g)).toContain("company:ibm");
  });

  it("gates merges by type, with schema parent closure, and merges a Thing into a typed entity only", async () => {
    let g = open({ resolver: "default" });
    await seed(g, { type: "Company", name: "Apple Inc", aliases: ["Apple"] });
    expect((await g.insert.facts({ entities: [{ type: "Fruit", name: "Apple" }] })).merges).toEqual([]);

    const schema = {
      entities: [{ name: "Person" }, { name: "Manager", parent: "Person" }, { name: "Engineer", parent: "Person" }],
    };
    g = open({ resolver: "default", schema });
    await seed(g, { type: "Person", name: "Grace Hopper", aliases: ["Amazing Grace"] });
    await seed(g, { type: "Manager", name: "Linus Torvalds", aliases: ["Linus"] });
    await seed(g, { type: "Engineer", name: "Ken Thompson", aliases: ["Ken"] });
    const down = await g.insert.facts({ entities: [{ type: "Manager", name: "Amazing Grace" }] });
    expect(down.merges.map((m) => m.survivor_id)).toEqual([entityId("Person", "Grace Hopper")]);
    const up = await g.insert.facts({ entities: [{ type: "Person", name: "Linus" }] });
    expect(up.merges.map((m) => m.survivor_id)).toEqual([entityId("Manager", "Linus Torvalds")]);
    expect((await g.insert.facts({ entities: [{ type: "Manager", name: "Ken" }] })).merges).toEqual([]);

    g = open({ resolver: "default" });
    const res = await g.insert.facts({
      entities: [
        { type: "Thing", name: "Robert Johnson" },
        { type: "Person", name: "Robert Johnson" },
      ],
    });
    expect(res.merges.map((m) => [m.absorbed_id, m.survivor_id, m.reason])).toEqual([
      ["thing:robert-johnson", "person:robert-johnson", "alias"],
    ]);
    expect(await ids(g)).toEqual(["person:robert-johnson"]);
    await g.insert.facts({ entities: [{ type: "Thing", name: "Bob J" }] });
    expect((await g.insert.facts({ entities: [{ type: "Company", name: "Bob J" }] })).merges).toEqual([]);
    expect(await ids(g)).toEqual(["company:bob-j", "person:robert-johnson", "thing:bob-j"]);
  });

  it("merges within one batch only when fuzzy", async () => {
    const batch: Extraction = {
      entities: [
        { type: "Company", name: "International Business Machines", external_ids: { ticker: "IBM" } },
        { type: "Company", name: "Big Blue", external_ids: { ticker: "IBM" } },
      ],
      relations: [{ from_entity: BIG_BLUE, type: "OWNS", to_entity: IBM }],
    };
    let g = open({ resolver: "default" });
    expect((await g.insert.facts(batch)).merges).toEqual([]);
    expect(await ids(g)).toEqual([BIG_BLUE, IBM]);
    g = open({ resolver: "fuzzy" });
    const res = await g.insert.facts(batch);
    expect(res.merges.map((m) => [m.absorbed_id, m.survivor_id])).toEqual([[BIG_BLUE, IBM]]);
    expect(await ids(g)).toEqual([IBM]);
    expect(res.relations).toEqual([]);
    const rid = relationId(BIG_BLUE, "OWNS", IBM);
    expect(res.warnings.filter((w) => w.code === "merge_self_loop").map((w) => w.message)).toEqual([
      `relation ${rid} (${BIG_BLUE} -OWNS-> ${IBM}) would join ${IBM} to itself after a merge and was dropped; ` +
        "unmerging restores it",
    ]);
    expect((await g.relations.list()).items).toEqual([]);
    const restored = await g.entities.unmerge(res.merges[0]!.id);
    expect(restored.relations.map((r) => [r.id, r.from_entity, r.to_entity])).toEqual([[rid, BIG_BLUE, IBM]]);
  });

  const JANE = entityId("Person", "Jane Doe");
  const JD = entityId("Person", "JD");
  const JANE_DOES = entityId("Person", "Jane Does");
  const relationSet = async (g: SelfGraph) =>
    (await g.relations.list({ limit: 100 })).items.map((r) => [r.from_entity, r.type, r.to_entity]).sort();

  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    it(`restores the exact relations when chained merges are unmerged in order ${order}`, async () => {
      const g = open({ resolver: "fuzzy" });
      await seed(g, { type: "Person", name: "Jane Doe", aliases: ["JD"] });
      const res = await g.insert.facts({
        entities: [
          { type: "Person", name: "JD" },
          { type: "Person", name: "Jane Does" },
        ],
        relations: [{ from_entity: JD, type: "KNOWS", to_entity: JANE_DOES }],
      });
      expect(res.merges.map((m) => [m.absorbed_id, m.survivor_id])).toEqual([
        [JD, JANE],
        [JANE_DOES, JANE],
      ]);
      expect(await relationSet(g)).toEqual([]);
      for (const merge of (await g.entities.merges(JANE)).items) {
        expect(
          merge.rewrites.map((rw) => [rw.kind, rw.dropped, rw.original.from_entity, rw.original.to_entity]),
        ).toEqual([["relation", true, JD, JANE_DOES]]);
      }
      for (const i of order) {
        const out = await g.entities.unmerge(res.merges[i]!.id);
        expect(out.entity.created_at).toEqual(res.created_at);
        expect(out.entity.updated_at).toEqual(res.created_at);
      }
      expect(await relationSet(g)).toEqual([[JD, "KNOWS", JANE_DOES]]);
      expect(await ids(g)).toEqual([JANE, JANE_DOES, JD]);
    });
  }

  it("lists each inserted entity and relation once and keeps the merge", async () => {
    const g = open({ resolver: "fuzzy" });
    const res = await g.insert.facts({
      entities: [
        { type: "Person", name: "Jane Doe" },
        { type: "Person", name: "Jane Does" },
        { type: "Person", name: "jane doe", aliases: ["Janie"] },
      ],
    });
    expect(res.entities.map((e) => e.id)).toEqual([JANE]);
    expect(res.entities[0]!.aliases).toEqual(["Jane Does", "Janie"]);
    expect(res.merges.map((m) => [m.absorbed_id, m.survivor_id])).toEqual([[JANE_DOES, JANE]]);
    const merge = res.merges[0]!;
    expect(res.warnings.filter((w) => w.code === "entity_merged")).toEqual([
      {
        code: "entity_merged",
        message:
          `entity ${JANE_DOES} merged into ${JANE} (similarity, confidence ${merge.confidence}, merge id ${merge.id}); ` +
          "undo with unmerge",
        source_id: null,
        chunk_id: null,
        merge_id: merge.id,
      },
    ]);
    const both = open({ resolver: "fuzzy" });
    const batch = await both.insert.facts({
      entities: [
        { type: "Company", name: "International Business Machines", external_ids: { ticker: "IBM" } },
        { type: "Company", name: "Big Blue", external_ids: { ticker: "IBM" } },
        { type: "Person", name: "Ada" },
      ],
      relations: [
        { from_entity: ADA, type: "WORKS_AT", to_entity: IBM },
        { from_entity: ADA, type: "WORKS_AT", to_entity: BIG_BLUE },
      ],
    });
    expect(batch.relations.map((r) => r.id)).toEqual([relationId(ADA, "WORKS_AT", IBM)]);
    expect(new Set(batch.entities.map((e) => e.id)).size).toBe(batch.entities.length);
  });

  it("fuzzy mode keeps numbered, lettered, suffixed, and different-word names apart", async () => {
    const g = open({ resolver: "fuzzy" });
    const names = [...[1, 2, 3, 4, 5].map((i) => `Employee${i}`), ...[0, 1, 2, 3, 4].map((i) => `Server0${i}`)];
    names.push("Project 12", "Project 13", "Model A", "Model B", "Jonathan Smith", "Jonathon Smith");
    names.push("Katherine Zorkdefault", "Katherine Zorkfuzzy");
    const res = await g.insert.facts({ entities: names.map((name) => ({ type: "Asset", name })) });
    expect(res.merges.map((m) => [m.absorbed_id, m.survivor_id])).toEqual([
      [entityId("Asset", "Jonathon Smith"), entityId("Asset", "Jonathan Smith")],
    ]);
    expect(await ids(g)).toHaveLength(names.length - 1);
    await seed(g, { type: "Person", name: "Bobby Tables" });
    const suffixed = await g.insert.facts({ entities: [{ type: "Person", name: "Bobby Tables Jr" }] });
    expect(suffixed.merges).toEqual([]);
    expect(suffixed.entities.map((e) => e.id)).toEqual(["person:bobby-tables-jr"]);
    const yes = new FakeLLM(true);
    const h = open({ llm: yes, resolver: "llm" });
    await seed(h, { type: "Person", name: "Employee1" });
    expect((await h.insert.facts({ entities: [{ type: "Person", name: "Employee2" }] })).merges).toEqual([]);
    expect(yes.calls).toEqual([]);
  });

  it("derives one id for Acme Inc, Acme Corp, and ACME and never repeats the name as an alias", async () => {
    const g = open();
    await g.insert.facts({
      entities: [
        { type: "Company", name: "Acme Inc" },
        { type: "Company", name: "Acme Corp" },
        { type: "Company", name: "ACME" },
        { type: "Company", name: "Acme", aliases: ["acme inc", "Acme Inc ", "Acme Corp"] },
      ],
    });
    const [acme] = (await g.entities.list()).items;
    expect([acme!.id, acme!.name, acme!.aliases]).toEqual(["company:acme", "Acme Inc", ["Acme Corp", "ACME", "Acme"]]);
    const updated = await g.entities.update(acme!.id, { name: "Acme Corp", aliases: ["ACME INC"] });
    expect(updated.aliases).toEqual(["ACME", "Acme", "ACME INC"]);
    expect((await g.entities.create("Globex", "Company", { aliases: ["globex", "Globex Ltd"] })).aliases).toEqual([
      "Globex Ltd",
    ]);
  });

  it("merges on an alias keeping the survivor's type, and lets a per-call resolver override the graph", async () => {
    let g = open({ resolver: "default" });
    await seed(g, { type: "Person", name: "Robert Smith", aliases: ["Bob Smith", "Bob"] });
    const res = await g.insert.facts({ entities: [{ type: "Person", name: "bob smith", properties: { age: 40 } }] });
    expect(res.merges.map((m) => [m.reason, m.confidence])).toEqual([["alias", 0.95]]);
    const survivor = (await g.entities.get(entityId("Person", "Robert Smith")))!;
    expect([survivor.type, survivor.properties]).toEqual(["Person", { age: 40 }]);
    const one = { entities: [{ type: "Person", name: "Bob" }] };
    expect((await g.insert.facts(one, { resolver: "exact" })).merges).toEqual([]);
    g = open();
    await seed(g, { type: "Person", name: "Robert Smith", aliases: ["Bob"] });
    expect((await g.insert.facts(one, { resolver: "default" })).merges).toHaveLength(1);
    await expect(g.insert.facts(one, { resolver: "nope" as never })).rejects.toThrow(ValidationError);
    await expect(g.insert.text("Ada met Bob.", { resolver: "llm" })).rejects.toThrow(/needs an LLM/);
  });

  it("rewrites references in relations, preferences, and decisions, and round-trips the merge through unmerge", async () => {
    const g = open({ resolver: "default" });
    await seed(g, { type: "Person", name: "Robert", aliases: ["Bob"] }, { type: "Person", name: "Ada" });
    await g.insert.facts({ relations: [{ from_entity: ADA, type: "KNOWS", to_entity: ROBERT }] });
    const res = await g.insert.facts(RICH, { source_id: "doc-1" });
    expect(await ids(g)).not.toContain(BOB);
    expect(res.relations.map((r) => [r.from_entity, r.to_entity])).toEqual([
      [ROBERT, TOOL],
      [ADA, ROBERT],
    ]);
    expect(res.relations[0]!.properties).toEqual({ since: 2020 });
    expect(res.preferences.map((p) => [p.subject_entity, p.value_entity, p.about_entity])).toEqual([
      [ROBERT, TOOL, null],
      [ADA, ROBERT, ROBERT],
    ]);
    expect(res.preferences[0]!.id).toBe(preferenceId(ROBERT, "preference", "tool", TOOL));
    const [dec] = res.decisions;
    expect(dec!.id).toBe(decisionId(ROBERT, "Pick a hammer"));
    expect([dec!.actor_entity, dec!.outcome_entity, dec!.alternative_entities]).toEqual([ROBERT, TOOL, [ROBERT, ADA]]);
    expect(dec!.steps.map((s) => s.relation_id)).toEqual([relationId(ROBERT, "USES", TOOL)]);
    expect(res.merges[0]!.rewrites.map((r) => r.kind).sort()).toEqual([
      "decision",
      "preference",
      "preference",
      "relation",
      "relation",
    ]);
    const [merge] = res.merges;
    expect(merge!.added_aliases).toEqual([]);
    const knows = relationId(ADA, "KNOWS", ROBERT);
    expect(merge!.rewrites.filter((r) => r.id === knows).map((r) => r.existed)).toEqual([true]);

    const out = await g.entities.unmerge(merge!.id);
    expect([out.entity.id, out.entity.name]).toEqual([BOB, "Bob"]);
    expect(out.merge.reverted_at).not.toBeNull();
    expect(out.survivor!.aliases).toEqual(["Bob"]);
    expect((await g.entities.evidence(BOB)).items).toHaveLength(1);

    const usesBack = relationId(BOB, "USES", TOOL);
    const rel = (await g.relations.get(usesBack))!;
    expect(rel.properties).toEqual({ since: 2020 });
    expect(rel.event_time).toEqual(new Date("2024-02-01T00:00:00Z"));
    expect(await g.relations.get(relationId(ROBERT, "USES", TOOL))).toBeNull();
    expect((await g.relations.evidence(usesBack)).items).toHaveLength(1);
    expect(await g.relations.get(knows)).not.toBeNull();
    expect(await g.relations.get(relationId(ADA, "KNOWS", BOB))).not.toBeNull();

    const prefs = new Map((await g.preferences.list(null, { limit: 100 })).items.map((p) => [p.id, p]));
    expect(prefs.get(preferenceId(BOB, "preference", "tool", TOOL))?.strength).toBe(0.5);
    expect(prefs.has(preferenceId(ROBERT, "preference", "tool", TOOL))).toBe(false);
    expect(prefs.get(preferenceId(ADA, "preference", "friend", BOB))?.about_entity).toBe(BOB);

    expect(await g.decisions.get(decisionId(ROBERT, "Pick a hammer"))).toBeNull();
    const restoredDec = (await g.decisions.get(decisionId(BOB, "Pick a hammer")))!;
    expect([restoredDec.actor_entity, restoredDec.alternative_entities]).toEqual([BOB, [BOB, ADA]]);
    expect(restoredDec.steps.map((s) => s.relation_id)).toEqual([usesBack]);

    const [record] = (await g.entities.merges(ROBERT)).items;
    expect(record!.reverted_at).not.toBeNull();
    await expect(g.entities.unmerge(merge!.id)).rejects.toThrow(/already reverted at \S+Z$/);
    await expect(g.entities.unmerge("entitymerge:missing")).rejects.toThrow(NotFoundError);
  });

  it("restores a retired merge relation on unmerge without superseding", async () => {
    const g = open({ resolver: "default", contradiction: "supersede", schema: SINGLE_EMPLOYER });
    const [acme, globex, initech] = ["Acme", "Globex", "Initech"].map((n) => entityId("Company", n));
    await seed(
      g,
      { type: "Person", name: "Robert", aliases: ["Bob"] },
      ...["Acme", "Globex", "Initech"].map((name) => ({ type: "Company", name })),
    );
    await g.insert.facts({ relations: [worksAt(ROBERT, acme!, 2020)] });
    const res = await g.insert.facts({
      entities: [{ type: "Person", name: "Bob" }],
      relations: [worksAt(BOB, globex!, 2021)],
    });
    const [merge] = res.merges;
    await g.insert.facts({ relations: [worksAt(ROBERT, initech!, 2022)] });

    await g.entities.unmerge(merge!.id);
    const current = (await g.relations.list()).items.map((r) => r.id).sort();
    expect(current).toEqual([relationId(BOB, "WORKS_AT", globex!), relationId(ROBERT, "WORKS_AT", initech!)].sort());
    const listed = (await g.relations.list({ include_invalidated: true })).items.map((r) => r.id).sort();
    expect(listed).toEqual([...current, relationId(ROBERT, "WORKS_AT", acme!)].sort());
    await expect(g.relations.versions(relationId(ROBERT, "WORKS_AT", globex!))).rejects.toThrow("does not exist");
  });

  it("keeps the survivor's values on merge and restores it exactly on unmerge", async () => {
    const g = open({ resolver: "default" });
    const keeper = entityId("Person", "Keeper");
    await seed(g, {
      type: "Person",
      name: "Keeper",
      aliases: ["Absorbed"],
      external_ids: { hr: "A1" },
      properties: { team: "red" },
    });
    const before = (await g.entities.get(keeper))!;
    const res = await g.insert.facts({
      entities: [
        {
          type: "Person",
          name: "Absorbed",
          aliases: ["Abby"],
          external_ids: { hr: "B2", crm: "C3" },
          properties: { team: "blue", level: 2 },
        },
      ],
    });
    const merge = res.merges[0]!;
    expect([merge.added_aliases, merge.added_external_ids, merge.added_properties]).toEqual([
      ["Abby"],
      ["crm"],
      ["level"],
    ]);
    const merged = (await g.entities.get(keeper))!;
    expect(merged.external_ids).toEqual({ hr: "A1", crm: "C3" });
    expect(merged.properties).toEqual({ team: "red", level: 2 });
    const out = await g.entities.unmerge(merge.id);
    expect([out.survivor!.aliases, out.survivor!.external_ids, out.survivor!.properties]).toEqual([
      before.aliases,
      before.external_ids,
      before.properties,
    ]);
    expect([out.entity.aliases, out.entity.external_ids]).toEqual([["Abby"], { hr: "B2", crm: "C3" }]);
  });

  it("keeps one record across repeated inserts of the same merge and restores every merged source", async () => {
    const g = open({ resolver: "default" });
    await seed(g, { type: "Person", name: "Robert", aliases: ["Bob"] }, { type: "Person", name: "Ada" });
    const facts: Extraction = {
      entities: [{ type: "Person", name: "Bob", aliases: ["Bobby"] }],
      relations: [{ from_entity: ADA, type: "KNOWS", to_entity: BOB }],
    };
    const merges = [];
    for (const source of ["s1", "s2", "s1"])
      merges.push((await g.insert.facts(facts, { source_id: source })).merges[0]!);
    const last = merges[2]!;
    expect(new Set(merges.map((m) => m.id)).size).toBe(1);
    expect([last.added_aliases, last.rewrites.map((r) => r.existed)]).toEqual([["Bobby"], [false]]);
    expect([last.source_id, last.source_ids]).toEqual(["s1", ["s1", "s2"]]);
    expect((await g.entities.merges(ROBERT)).items).toHaveLength(1);
    const restored = (await g.entities.unmerge(last.id)).entity;
    expect([restored.id, restored.source_count]).toEqual([BOB, 2]);
    expect((await g.entities.get(ROBERT))!.aliases).toEqual(["Bob"]);
  });

  it("drops merge records with a deleted survivor, or a deleted absorbed id so a later merge starts fresh", async () => {
    const gone = open({ resolver: "default" });
    await seed(gone, { type: "Person", name: "Robert", aliases: ["Bob"] });
    await gone.insert.facts({ entities: [{ type: "Person", name: "Bob" }] });
    await gone.entities.delete(ROBERT);
    expect(await gone.store.matchNodes(gone.namespace, "EntityMerge")).toEqual([]);
    await expect(gone.entities.merges(ROBERT)).rejects.toThrow(NotFoundError);
    const g = open({ resolver: "default" });
    await seed(g, { type: "Person", name: "Robert", aliases: ["Bob"] });
    const bob = { entities: [{ type: "Person", name: "Bob" }] };
    const first = (await g.insert.facts(bob, { source_id: "s1" })).merges[0]!;
    await g.entities.create("Bob", "Person");
    await g.entities.delete(BOB);
    expect((await g.entities.merges(ROBERT)).items).toEqual([]);
    const again = (await g.insert.facts(bob, { source_id: "s2" })).merges[0]!;
    expect([again.id, again.source_ids]).toEqual([first.id, ["s2"]]);
    expect(again.created_at.getTime()).toBeGreaterThan(first.created_at.getTime());
  });

  it("offers a custom resolver only type-compatible candidates and checks its decision", async () => {
    const seen: Record<string, string[]> = {};
    const recorder = {
      resolve: async (candidate: EntityInput, existing: readonly { id: string }[]): Promise<ResolutionDecision> => {
        seen[candidate.name] = existing.map((e) => e.id);
        return { target_id: null, confidence: 0, reason: "no_match" };
      },
    };
    const g = open();
    await seed(
      g,
      { type: "Person", name: "Ann" },
      { type: "Person", name: "Zed" },
      { type: "Company", name: "Acme" },
      { type: "Company", name: "Ray" },
      { type: "Thing", name: "Box" },
    );
    const two = [
      { type: "Person", name: "Ray" },
      { type: "Thing", name: "ann" },
    ];
    await g.insert.facts({ entities: two }, { resolver: recorder });
    expect(seen).toEqual({ Ray: ["person:ann", "person:zed"], ann: ["person:ann", "thing:box"] });
    const picky = (decision: ResolutionDecision) => ({ resolve: async () => decision });
    const decide = (name: string, decision: ResolutionDecision) =>
      g.insert.facts({ entities: [{ type: "Person", name }] }, { resolver: picky(decision) });
    await decide("Bob", { target_id: null });
    expect(await g.entities.get("person:bob")).not.toBeNull();
    for (const [field, decision] of [
      ["confidence", { target_id: "person:ann", reason: "x" }],
      ["reason", { target_id: "person:ann", confidence: 1 }],
    ] as const) {
      await expect(decide("Cy", decision)).rejects.toThrow(`is missing ${field}`);
    }
    await expect(decide("Ada", { target_id: "person:nobody", confidence: 1, reason: "w" })).rejects.toThrow(
      /not one of the compatible entities/,
    );
  });

  it("asks the LLM only inside the band", async () => {
    const yes = new FakeLLM(true);
    let g = open({ llm: yes, resolver: "llm" });
    await seed(g, { type: "Person", name: "John Smith" }, { type: "Person", name: "Alice Wong" });
    const res = await g.insert.facts({ entities: [{ type: "Person", name: "Jon Smyth" }] });
    const [merge] = res.merges;
    expect([merge!.survivor_id, merge!.reason]).toEqual([entityId("Person", "John Smith"), "llm"]);
    expect(merge!.confidence).toBe(nameSimilarity("Jon Smyth", "John Smith"));
    expect(yes.calls).toHaveLength(1);
    expect(yes.calls[0]!.user).toContain("Jon Smyth");
    expect(yes.calls[0]!.user).toContain("John Smith");
    expect((await g.insert.facts({ entities: [{ type: "Person", name: "Zed Quincy" }] })).merges).toEqual([]);
    expect(yes.calls).toHaveLength(1);

    const no = new FakeLLM(false);
    g = open({ llm: no, resolver: "llm" });
    await seed(g, { type: "Person", name: "John Smith" });
    expect((await g.insert.facts({ entities: [{ type: "Person", name: "Jon Smyth" }] })).merges).toEqual([]);
    expect(no.calls).toHaveLength(1);
  });
}

await forEachStore("entity resolution", suite);
