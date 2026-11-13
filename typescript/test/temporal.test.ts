import { expect, it } from "vitest";

import {
  ConflictError,
  ids,
  type LLMClient,
  NotFoundError,
  SelfGraph,
  StoreError,
  ValidationError,
} from "../src/index.js";
import type { ContradictionMode, Schema, SchemaMode } from "../src/schema.js";
import { captureWarnings, forEachStore, freshGraphs, type StoreSpec, worksAt } from "./helpers.js";

const SPEC: Schema = {
  entities: [{ name: "Person" }, { name: "Company" }],
  relations: [
    { type: "WORKS_AT", aliases: ["employed by"], from: { types: ["Person"], max_count: 1 } },
    { type: "CEO_OF", to: { max_count: 1 } },
  ],
};
const PEOPLE = [
  { type: "Person", name: "Ann" },
  { type: "Person", name: "Bob" },
  { type: "Company", name: "Acme" },
  { type: "Company", name: "Globex" },
  { type: "Company", name: "Initech" },
];
const ACME = ids.relationId("person:ann", "WORKS_AT", "company:acme");
const GLOBEX = ids.relationId("person:ann", "WORKS_AT", "company:globex");

const annAt = (company: string, year?: number, properties?: Record<string, unknown>) =>
  worksAt("person:ann", `company:${company}`, year, properties);

const at = (year: number): Date => new Date(Date.UTC(year, 0, 1));

async function instant(): Promise<Date> {
  await new Promise((r) => setTimeout(r, 10));
  const stamp = new Date();
  await new Promise((r) => setTimeout(r, 10));
  return stamp;
}

function suite(spec: StoreSpec): void {
  const open = freshGraphs(spec, "temporal");

  async function graph(contradiction: ContradictionMode = "warn", schemaMode: SchemaMode = "warn") {
    const g = open({ schema: SPEC, schema_mode: schemaMode, contradiction });
    await g.insert.ontology({ entities: PEOPLE });
    return g;
  }

  const insert = (g: SelfGraph, relations: object[], contradiction?: ContradictionMode) =>
    g.insert.ontology({ relations } as never, { contradiction });

  it("warn keeps both and replaces the in-batch cardinality warning, off skips it, schema_mode off keeps it", async () => {
    const g = await graph();
    await insert(g, [annAt("acme", 2020)]);
    const result = await insert(g, [annAt("globex", 2023)]);
    expect(result.warnings.map((w) => [w.code, w.message])).toEqual([
      [
        "contradiction",
        `relation ${GLOBEX} contradicts current WORKS_AT relation(s) ${ACME} at from entity person:ann (max_count 1)`,
      ],
    ]);
    expect((await g.relations.list()).items).toHaveLength(2);
    const fresh = open({ schema: SPEC });
    const both = await fresh.insert.ontology({ entities: PEOPLE, relations: [annAt("acme"), annAt("globex")] });
    expect(both.warnings.map((w) => w.code)).toEqual(["contradiction"]);
    expect((await fresh.relations.list()).items).toHaveLength(2);
    const quiet = await graph("off");
    await insert(quiet, [annAt("acme", 2020)]);
    expect((await insert(quiet, [annAt("globex", 2023)])).warnings).toEqual([]);
    expect((await insert(quiet, [annAt("acme"), annAt("globex", 2024)])).warnings).toEqual([]);
    const off = await graph("warn", "off");
    expect((await insert(off, [annAt("acme"), annAt("globex")])).warnings.map((w) => w.code)).toEqual([
      "contradiction",
    ]);
  });

  it("supersede retires the older relation in place through aliases and the to side, and lists it on request", async () => {
    const g = await graph("supersede");
    await insert(g, [annAt("acme", 2020)]);
    const employed = { ...annAt("globex", 2023), type: "employed by" };
    expect((await insert(g, [employed])).warnings.map((w) => [w.code, w.message])).toEqual([
      [
        "relation_superseded",
        `relation ${ACME} was superseded by ${GLOBEX}, a newer WORKS_AT relation at from entity person:ann (max_count 1)`,
      ],
    ]);
    expect(await g.relations.get(ACME)).toBeNull();
    const [old] = await g.relations.versions(ACME);
    expect([old?.revision, old?.is_current, old?.invalidated_at, old?.invalidated_by]).toEqual([
      1,
      false,
      at(2023),
      GLOBEX,
    ]);
    expect((await g.relations.list()).items.map((r) => r.id)).toEqual([GLOBEX]);
    const listed = (await g.relations.list({ include_invalidated: true })).items;
    expect(listed.map((r) => [r.id, r.is_current]).sort()).toEqual(
      [
        [ACME, false],
        [GLOBEX, true],
      ].sort(),
    );
    await insert(g, [{ from_entity: "person:ann", type: "CEO_OF", to_entity: "company:acme" }]);
    await insert(g, [{ from_entity: "person:bob", type: "CEO_OF", to_entity: "company:acme" }]);
    expect(await g.relations.get(ids.relationId("person:ann", "CEO_OF", "company:acme"))).toBeNull();
  });

  it("supersede resolves a batch in input order and writes an older fact as already invalidated", async () => {
    const g = await graph("supersede");
    const result = await insert(g, [annAt("acme", 2020), annAt("globex", 2023)]);
    expect(result.relations.map((r) => [r.id, r.is_current, r.invalidated_by])).toEqual([
      [ACME, false, GLOBEX],
      [GLOBEX, true, null],
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual(["relation_superseded"]);
    const h = await graph("supersede");
    await insert(h, [annAt("globex", 2023)]);
    const late = await insert(h, [annAt("acme", 2020)]);
    expect(late.warnings.map((w) => [w.code, w.message])).toEqual([
      [
        "contradiction_out_of_order",
        `relation ${ACME} is older than current WORKS_AT relation ${GLOBEX} at from entity person:ann, so ${GLOBEX} stays current`,
      ],
    ]);
    expect(late.relations.map((r) => [r.is_current, r.invalidated_at, r.invalidated_by])).toEqual([
      [false, at(2023), GLOBEX],
    ]);
    expect((await h.relations.list()).items.map((r) => r.id)).toEqual([GLOBEX]);
    expect((await h.relations.list({ include_invalidated: true })).items.map((r) => r.id)).toEqual(
      [ACME, GLOBEX].sort(),
    );
    expect((await insert(h, [annAt("acme", 2020)])).relations.map((r) => [r.id, r.is_current])).toEqual([
      [ACME, false],
    ]);
    const valid = async (year: number) =>
      new Set((await h.retrieve("Ann", { as_of: at(year) })).subgraph.relations.map((r) => r.id));
    expect([await valid(2019), await valid(2021), await valid(2024)]).toEqual([
      new Set(),
      new Set([ACME]),
      new Set([GLOBEX]),
    ]);
    const older = await h.relations.create("person:ann", "WORKS_AT", "company:initech", { event_time: at(2022) });
    expect([older.is_current, older.invalidated_by]).toEqual([false, GLOBEX]);
  });

  it("decision steps may name a retired relation and versions of an unknown id throw", async () => {
    const g = await graph("supersede");
    await insert(g, [annAt("acme", 2020), annAt("globex", 2023)]);
    const decision = { title: "Joined Acme", actor_entity: "person:ann", steps: [ACME] };
    const [dec] = (await g.insert.ontology({ decisions: [decision] } as never, { contradiction: "off" })).decisions;
    expect(dec?.steps.map((s) => [s.relation_id, s.to_entity])).toEqual([[ACME, "company:acme"]]);
    const created = await g.decisions.create("Left Acme", { steps: [ACME, GLOBEX], actor_entity: "person:ann" });
    expect(created.steps.map((s) => s.relation_id)).toEqual([ACME, GLOBEX]);
    const ghost = "decision step references unknown relation 'relation:ghost'";
    await expect(
      g.insert.ontology({ decisions: [{ ...decision, steps: ["relation:ghost"] }] } as never),
    ).rejects.toThrow(ghost);
    await expect(
      g.decisions.create("Joined Acme", { steps: ["relation:ghost"], actor_entity: "person:ann" }),
    ).rejects.toThrow(ghost);
    await expect(g.relations.versions("relation:ghost")).rejects.toThrow(NotFoundError);
    await expect(g.preferences.versions("preference:ghost")).rejects.toThrow("'preference:ghost' does not exist");
  });

  it("reasserts as the next revision, restates history idempotently, and conflicts on a current create", async () => {
    const g = await graph("supersede");
    await insert(g, [annAt("acme", 2020)]);
    await insert(g, [annAt("globex", 2023)]);
    for (let i = 0; i < 2; i++) {
      const [same] = (await insert(g, [annAt("acme", 2020)])).relations;
      expect([same?.revision, same?.is_current]).toEqual([1, false]);
    }
    const [back] = (await insert(g, [annAt("acme", 2024, { role: "cto" })])).relations;
    expect([back?.revision, back?.is_current, back?.invalidated_at]).toEqual([2, true, null]);
    expect((await g.relations.versions(ACME)).map((v) => v.revision)).toEqual([2, 1]);
    expect((await g.relations.versions(GLOBEX))[0]?.invalidated_by).toBe(ACME);
    await expect(g.relations.create("person:ann", "WORKS_AT", "company:acme")).rejects.toThrow(ConflictError);
    const again = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: at(2025) });
    expect([again.revision, again.is_current]).toEqual([2, true]);
    expect((await g.relations.versions(ACME))[0]?.invalidated_at).toEqual(at(2025));
    const { result, warnings } = await captureWarnings(() =>
      g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: "2026-01-01" }),
    );
    expect([result.revision, result.properties, result.event_time]).toEqual([3, {}, at(2026)]);
    expect(warnings).toContain(
      `selfgraph: schema warning [relation_reasserted]: relation ${ACME} was invalidated by ${GLOBEX} at 2025-01-01T00:00:00Z (revision 2); reasserted as revision 3 with exactly the given properties`,
    );
  });

  it("create warns on stderr and update of an invalidated relation explains how to reassert", async () => {
    const g = await graph();
    await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: at(2020) });
    const { warnings } = await captureWarnings(() =>
      g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: at(2023) }),
    );
    expect(warnings).toEqual([
      `selfgraph: schema warning [contradiction]: relation ${GLOBEX} contradicts current WORKS_AT relation(s) ${ACME} at from entity person:ann (max_count 1)`,
    ]);
    await g.relations.delete(GLOBEX);
    await g.relations.create("person:ann", "WORKS_AT", "company:globex", {
      event_time: at(2023),
      contradiction: "supersede",
    });
    await expect(g.relations.update(ACME, { set_properties: { x: 1 } })).rejects.toThrow(
      `relation ${ACME} was invalidated by ${GLOBEX} at 2023-01-01T00:00:00Z; create it again to reassert it`,
    );
    expect((await g.relations.delete(ACME)).deleted_relation_versions).toBe(1);
  });

  it("strict schema rejects an over-max batch, and a stored conflict unless superseding or off, and validates modes", async () => {
    const batch = await graph("supersede", "strict");
    await expect(insert(batch, [annAt("acme"), annAt("globex")])).rejects.toThrow(/above max 1/);
    expect((await batch.relations.list()).items).toEqual([]);
    await expect(insert(batch, [annAt("acme")], "yes" as never)).rejects.toThrow(/contradiction must be one of/);
    expect(() => new SelfGraph(spec.make(), { contradiction: "newest" as never })).toThrow(
      "contradiction must be one of off, warn, supersede, llm, got 'newest'",
    );
    const strict = await graph("warn", "strict");
    await strict.relations.create("person:ann", "WORKS_AT", "company:acme");
    await expect(strict.relations.create("person:ann", "WORKS_AT", "company:globex")).rejects.toThrow(
      "would exceed max_count 1 for WORKS_AT at from entity person:ann",
    );
    await expect(insert(strict, [annAt("globex")])).rejects.toThrow(`relation ${GLOBEX} would exceed max_count 1`);
    expect((await strict.relations.list()).items.map((r) => r.id)).toEqual([ACME]);
    const off = await graph("off", "strict");
    await off.relations.create("person:ann", "WORKS_AT", "company:acme");
    await off.relations.create("person:ann", "WORKS_AT", "company:globex");
    expect((await insert(off, [annAt("acme"), annAt("initech")])).warnings).toEqual([]);
    expect((await off.relations.list()).items).toHaveLength(3);
    const g = await graph("supersede", "strict");
    await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    expect((await g.relations.create("person:ann", "WORKS_AT", "company:globex")).is_current).toBe(true);
    await insert(g, [annAt("initech")]);
    expect((await g.relations.list()).items.map((r) => r.to_entity)).toEqual(["company:initech"]);
  });

  it("flags a within-batch conflict through aliases, letter case, and extraction", async () => {
    const schema: Schema = { ...SPEC, entities: [{ name: "Person", aliases: ["Human"] }, { name: "Company" }] };
    const variants: Array<[[string, string], [string, string]]> = [
      [
        ["Person", "WORKS_AT"],
        ["Person", "employed by"],
      ],
      [
        ["Human", "WORKS_AT"],
        ["Person", "WORKS_AT"],
      ],
      [
        ["person", "works at"],
        ["PERSON", "WORKS_AT"],
      ],
    ];
    const companies = [
      { type: "Company", name: "Acme" },
      { type: "Company", name: "Globex" },
    ];
    for (const [[t1, r1], [t2, r2]] of variants) {
      const g = open({ schema });
      const result = await g.insert.ontology({
        entities: [{ type: t1, name: "Ann" }, { type: t2, name: "Ann" }, ...companies],
        relations: [
          { from_entity: ids.entityId(t1, "Ann"), type: r1, to_entity: "company:acme" },
          { from_entity: ids.entityId(t2, "Ann"), type: r2, to_entity: "company:globex" },
        ],
      });
      expect(
        result.warnings.map((w) => w.code),
        `${t1} / ${t2}`,
      ).toEqual(["contradiction"]);
    }
    const extracted = {
      entities: [
        { type: "person", name: "Ann", aliases: null },
        { type: "company", name: "Acme", aliases: null },
        { type: "company", name: "Globex", aliases: null },
      ],
      relations: [
        { from_name: "Ann", type: "works at", to_name: "Acme", event_time: null },
        { from_name: "Ann", type: "WORKS_AT", to_name: "Globex", event_time: null },
      ],
      preferences: [],
      decisions: [],
    };
    const llm: LLMClient = { generate: async ({ output }) => output.parse(extracted) };
    const result = await open({ schema, llm }).insert.text("Ann works at Acme and at Globex.");
    expect(result.warnings.map((w) => w.code)).toEqual(["contradiction"]);
  });

  it("keeps surface variants that share an id as one relation and a same-named child type apart", async () => {
    const g = open({ schema: SPEC });
    const variants = [
      { type: "Person", name: "Ann" },
      { type: "Company", name: "Acme Corp" },
      { type: "Company", name: "Acme Inc" },
    ];
    const result = await g.insert.ontology({ entities: variants, relations: [annAt("acme"), annAt("acme")] });
    expect(result.warnings).toEqual([]);
    expect(new Set(result.relations.map((r) => r.id))).toEqual(new Set([ACME]));
    const schema: Schema = { ...SPEC, entities: [...SPEC.entities!, { name: "Manager", parent: "Person" }] };
    const rels = [annAt("acme"), { ...annAt("globex"), from_entity: "manager:ann" }];
    const exact = await open({ schema }).insert.ontology({
      entities: [...PEOPLE, { type: "Manager", name: "Ann" }],
      relations: rels,
    });
    expect(exact.warnings).toEqual([]);
    const h = open({ schema, resolver: "default" });
    await h.insert.ontology({ entities: PEOPLE, relations: [annAt("acme")] });
    const merged = await h.insert.ontology({ entities: [{ type: "Manager", name: "Ann" }], relations: rels.slice(1) });
    expect(merged.warnings.map((w) => w.code)).toEqual(["entity_merged", "contradiction"]);
  });

  it("does not treat equal effective times as out of order, and a create without event_time supersedes from now", async () => {
    const g = await graph("supersede");
    await insert(g, [annAt("acme", 2024)]);
    const result = await insert(g, [annAt("globex", 2024)]);
    expect(result.warnings.map((w) => w.code)).toEqual(["relation_superseded"]);
    expect(result.relations[0]!.is_current).toBe(true);
    const h = await graph("supersede");
    await h.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: at(2024) });
    expect(
      (await h.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: at(2024) })).is_current,
    ).toBe(true);
    const k = await graph("supersede");
    const first = await k.relations.create("person:ann", "WORKS_AT", "company:acme");
    const later = await k.relations.create("person:ann", "WORKS_AT", "company:globex", {
      event_time: first.created_at,
    });
    expect(later.is_current).toBe(true);
    expect(await k.relations.get(ACME)).toBeNull();
    const now = await graph("supersede");
    await insert(now, [annAt("acme", 2020)]);
    const rel = await now.relations.create("person:ann", "WORKS_AT", "company:globex");
    expect([rel.event_time, rel.is_current]).toEqual([null, true]);
    expect((await now.relations.versions(ACME))[0]?.invalidated_at).toEqual(rel.created_at);
  });

  it("retrieve as_of reads revisions, invalidation, and entity existence", async () => {
    const g = await graph("supersede");
    const unchanged = await g.retrieve("Ann");
    expect(await g.retrieve("Ann", { as_of: null })).toEqual(unchanged);
    const rel = await g.relations.create("person:ann", "WORKS_AT", "company:acme", { properties: { role: "dev" } });
    const first = await instant();
    await g.relations.update(rel.id, { set_properties: { role: "cto" } });
    expect((await g.retrieve("Ann", { as_of: first })).context).toContain("Ann -[WORKS_AT]-> Acme {role=dev}");
    expect((await g.retrieve("Ann", { as_of: await instant() })).context).toContain("{role=cto}");
    await g.relations.create("person:ann", "WORKS_AT", "company:globex");
    const between = await instant();
    await g.insert.ontology({ entities: [{ type: "Person", name: "Zed" }] });
    const ids = async (asOf: Date | string) =>
      (await g.retrieve("Ann Zed", { as_of: asOf })).subgraph.relations.map((r) => r.id);
    expect(await ids(first)).toEqual([ACME]);
    expect(await ids(between)).toEqual([GLOBEX]);
    expect((await g.retrieve("Zed", { as_of: between })).seeds).toEqual([]);
    expect((await g.retrieve("Zed", { as_of: between.toISOString() })).seeds).toEqual([]);
  });

  it("retrieve as_of reads backdated facts and passages on the valid-time axis, picking the highest revision in effect", async () => {
    const g = open();
    const base = { from_entity: "person:ann", type: "WORKS_AT", to_entity: "company:acme" };
    await g.insert.ontology({
      entities: PEOPLE,
      relations: [{ ...base, properties: { role: "dev" }, event_time: "2020-01-01T00:00:00Z" }],
    });
    await g.relations.update(ACME, { set_properties: { role: "cto" }, event_time: "2022-01-01T00:00:00Z" });
    const asOf = async (year: number) => g.retrieve("Ann Acme", { as_of: new Date(Date.UTC(year, 5, 1)) });
    expect((await asOf(2021)).context.split("\n")).toContain("Ann -[WORKS_AT]-> Acme {role=dev}");
    expect((await asOf(2021)).subgraph.entities.map((e) => e.id).sort()).toEqual(["company:acme", "person:ann"]);
    expect((await asOf(2023)).context.split("\n")).toContain("Ann -[WORKS_AT]-> Acme {role=cto}");
    const early = await asOf(2019);
    expect([early.seeds, early.subgraph.entities, early.subgraph.relations, early.context]).toEqual([[], [], [], ""]);

    const h = open();
    const t2020 = "2020-01-01T00:00:00Z";
    await h.entities.create("Jane Q Doe", "Person");
    await h.entities.create("Acme", "Company");
    const rel = await h.relations.create("person:jane-q-doe", "WORKS_AT", "company:acme", { event_time: t2020 });
    await h.entities.create("Python", "Tool");
    await h.entities.create("Rust", "Tool");
    await h.preferences.create("person:jane-q-doe", "tool", "tool:python", { event_time: t2020 });
    await h.decisions.create("Pick Rust", { steps: [rel.id], outcome_entity: "tool:rust", event_time: t2020 });
    const past = await h.retrieve("Jane", { as_of: "2021-01-01T00:00:00Z" });
    expect(past.context.split("\n")).toContain("Jane Q Doe prefers Python (tool)");
    expect(past.context).not.toContain("tool:python");
    expect(past.subgraph.decisions).toEqual([]);
    expect((await h.retrieve("Jane")).subgraph.decisions.map((d) => d.title)).toEqual(["Pick Rust"]);

    const k = open();
    await k.insert.ontology({ entities: PEOPLE });
    const titled = await k.relations.create("person:ann", "WORKS_AT", "company:acme");
    await k.relations.update(titled.id, { set_properties: { title: "Dev" }, event_time: at(2025) });
    for (const when of [await instant(), at(2099), new Date(Date.UTC(2025, 5, 1))]) {
      expect((await k.retrieve("Ann Acme", { as_of: when })).context.split("\n")).toContain(
        "Ann -[WORKS_AT]-> Acme {title=Dev}",
      );
    }
    expect((await k.retrieve("Ann", { as_of: at(2024) })).subgraph.relations).toEqual([]);

    const p = open();
    await p.insert.ontology({ entities: PEOPLE });
    await p.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: at(2020) });
    await p.insert.text("Ann works at Acme.", { source_id: "note", event_time: at(2020) });
    expect((await p.retrieve("Ann Acme", { as_of: at(2021) })).context.split("\n")).toContain("Ann works at Acme.");
    expect((await p.retrieve("Ann Acme", { as_of: at(2019) })).context).not.toContain("Ann works at Acme.");
  });

  it("a supersede rerun enforces the cap, keeps the newest fact, and warns once per retired relation", async () => {
    for (const order of [1, -1]) {
      const g = await graph();
      const rels = [annAt("acme", 2020), annAt("globex", 2021)];
      if (order < 0) rels.reverse();
      await insert(g, rels);
      const res = await insert(g, rels, "supersede");
      expect(res.warnings.map((w) => w.code)).toEqual([
        order > 0 ? "relation_superseded" : "contradiction_out_of_order",
      ]);
      expect((await g.relations.list()).items.map((r) => r.id)).toEqual([GLOBEX]);
      const [old] = await g.relations.versions(ACME);
      expect([old!.is_current, old!.invalidated_by, old!.invalidated_at]).toEqual([false, GLOBEX, at(2021)]);
    }
    const h = await graph();
    await insert(h, [annAt("acme")]);
    await insert(h, [annAt("globex")]);
    const changed = await insert(h, [annAt("acme", undefined, { r: 1 })], "supersede");
    expect(changed.warnings.map((w) => w.code)).toEqual(["relation_superseded"]);
    expect((await h.relations.list()).items.map((r) => r.id)).toEqual([ACME]);
  });

  it("a retired fact is invalidated by the next newer one", async () => {
    const rels = [annAt("acme", 2019), annAt("initech", 2020), annAt("globex", 2022)];
    const initech = ids.relationId("person:ann", "WORKS_AT", "company:initech");
    const warned = await graph();
    await insert(warned, rels);
    await insert(warned, rels, "supersede");
    const late = await graph("supersede");
    for (const rel of [rels[1]!, rels[2]!, rels[0]!]) await insert(late, [rel]);
    for (const g of [warned, late]) {
      const [acme] = await g.relations.versions(ACME);
      const [mid] = await g.relations.versions(initech);
      expect([acme!.invalidated_by, acme!.invalidated_at]).toEqual([initech, at(2020)]);
      expect([mid!.invalidated_by, mid!.invalidated_at]).toEqual([GLOBEX, at(2022)]);
      const valid = async (when: Date) =>
        new Set((await g.retrieve("Ann", { as_of: when })).subgraph.relations.map((r) => r.id));
      expect(await valid(new Date(Date.UTC(2019, 5, 1)))).toEqual(new Set([ACME]));
      expect(await valid(new Date(Date.UTC(2020, 5, 1)))).toEqual(new Set([initech]));
      expect(await valid(at(2023))).toEqual(new Set([GLOBEX]));
    }
  });

  it("rejects an invalid as_of and a closed graph", async () => {
    const g = await graph();
    await expect(g.retrieve("Ann", { as_of: 5 as never })).rejects.toThrow("as_of must be a datetime, got number");
    await expect(g.retrieve("Ann", { as_of: "2024-01-01T00:00:00" })).resolves.toBeTruthy();
    await expect(g.retrieve("Ann", { as_of: "yesterday" })).rejects.toThrow(/invalid as_of/);
    await expect(g.retrieve("Ann", { as_of: "2024-01-01T00:00:00Z" })).resolves.toBeTruthy();
    await g.close();
    await expect(g.retrieve("Ann", { as_of: new Date() })).rejects.toThrow(StoreError);
    await expect(g.retrieve("Ann", { as_of: "nope" })).rejects.toThrow(ValidationError);
  });
}

await forEachStore("contradiction and as_of", suite);
