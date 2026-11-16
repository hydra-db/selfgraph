import { expect, it } from "vitest";

import {
  ConflictError,
  type Extractor,
  ids,
  type LLMClient,
  NotFoundError,
  SelfGraph,
  StoreError,
  ValidationError,
} from "../src/index.js";
import { jsonIso } from "../src/internal/time.js";
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

  for (const side of ["from", "to"] as const) {
    for (const defaultTime of [false, true]) {
      it(`strict retired historical replay at ${side}, default time ${defaultTime}`, async () => {
        const schema: Schema = {
          entities: [{ name: "Person" }, { name: "Company" }],
          relations: [{ type: "WORKS_AT", [side]: { max_count: 1 } }],
        };
        const g = open({ schema, schema_mode: "strict" });
        const fact = (company: string, year: number) => {
          const rel = annAt(company, year);
          return side === "from" ? rel : { ...rel, from_entity: rel.to_entity, to_entity: rel.from_entity };
        };
        const old = fact("acme", 2020);
        await g.insert.facts({ entities: PEOPLE, relations: [old] });
        await g.insert.facts({ relations: [fact("globex", 2023)] }, { contradiction: "supersede" });
        const rid = ids.relationId(old.from_entity, old.type, old.to_entity);
        const before = await g.relations.versions(rid);
        const { event_time: _time, ...undated } = old;
        const replay = defaultTime ? undated : old;
        const result = await g.insert.facts(
          { relations: [replay, replay] },
          defaultTime ? { event_time: "2020-01-01" } : {},
        );
        expect(result.warnings).toEqual([]);
        expect(result.relations).toEqual(before);
        expect(await g.relations.versions(rid)).toEqual(before);
        expect(await g.relations.get(rid)).toBeNull();
        expect((await g.relations.list()).items).toHaveLength(1);
        for (const year of [2023, 2024]) {
          for (const batch of [[fact("acme", year)], [old, fact("acme", year)], [fact("acme", year), old]]) {
            await expect(g.insert.facts({ relations: batch })).rejects.toThrow(/would exceed max_count/);
            expect(await g.relations.versions(rid)).toEqual(before);
          }
        }
      });
    }
  }

  it.each([
    "0001-01-01T00:00:00+01:00",
    "9999-12-31T23:00:00-02:00",
    new Date("0000-01-01T00:00:00Z"),
    new Date("+010000-01-01T00:00:00Z"),
  ])("rejects %s before a relation is stored", async (value) => {
    const g = open();
    await g.entities.create("Ann", "Person");
    await g.entities.create("Acme", "Company");
    await expect(
      g.relations.create("person:ann", "WORKS_AT", "company:acme", {
        id: "relation:invalid",
        event_time: value,
      }),
    ).rejects.toThrow(new ValidationError("event_time is outside the representable datetime range"));
    expect((await g.relations.list()).items).toEqual([]);
  });

  async function graph(contradiction: ContradictionMode = "warn", schemaMode: SchemaMode = "warn") {
    const g = open({ schema: SPEC, schema_mode: schemaMode, contradiction });
    await g.insert.facts({ entities: PEOPLE });
    return g;
  }

  const insert = (g: SelfGraph, relations: object[], contradiction?: ContradictionMode) =>
    g.insert.facts({ relations } as never, { contradiction });

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
    const both = await fresh.insert.facts({ entities: PEOPLE, relations: [annAt("acme"), annAt("globex")] });
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
    const [dec] = (await g.insert.facts({ decisions: [decision] } as never, { contradiction: "off" })).decisions;
    expect(dec?.steps.map((s) => [s.relation_id, s.to_entity])).toEqual([[ACME, "company:acme"]]);
    const created = await g.decisions.create("Left Acme", { steps: [ACME, GLOBEX], actor_entity: "person:ann" });
    expect(created.steps.map((s) => s.relation_id)).toEqual([ACME, GLOBEX]);
    const ghost = "decision step references unknown relation 'relation:ghost'";
    await expect(g.insert.facts({ decisions: [{ ...decision, steps: ["relation:ghost"] }] } as never)).rejects.toThrow(
      ghost,
    );
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
      const result = await g.insert.facts({
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
    const result = await g.insert.facts({ entities: variants, relations: [annAt("acme"), annAt("acme")] });
    expect(result.warnings).toEqual([]);
    expect(new Set(result.relations.map((r) => r.id))).toEqual(new Set([ACME]));
    const schema: Schema = { ...SPEC, entities: [...SPEC.entities!, { name: "Manager", parent: "Person" }] };
    const rels = [annAt("acme"), { ...annAt("globex"), from_entity: "manager:ann" }];
    const exact = await open({ schema }).insert.facts({
      entities: [...PEOPLE, { type: "Manager", name: "Ann" }],
      relations: rels,
    });
    expect(exact.warnings).toEqual([]);
    const h = open({ schema, resolver: "default" });
    await h.insert.facts({ entities: PEOPLE, relations: [annAt("acme")] });
    const merged = await h.insert.facts({ entities: [{ type: "Manager", name: "Ann" }], relations: rels.slice(1) });
    expect(merged.warnings.map((w) => w.code)).toEqual(["entity_merged", "contradiction"]);
  });

  it("undated restatement keeps event_time and supersede order", async () => {
    const g = await graph("supersede");
    await g.insert.facts({ relations: [annAt("acme", 2020)] }, { source_id: "a" });
    await g.insert.facts({ relations: [annAt("acme")] }, { source_id: "b" });
    const current = (await g.relations.get(ACME))!;
    expect([current.event_time, current.revision, current.source_count]).toEqual([at(2020), 1, 2]);
    const res = await g.insert.facts({ relations: [annAt("globex", 2022)] }, { source_id: "c" });
    expect(res.warnings.map((w) => w.code)).toEqual(["relation_superseded"]);
    expect((await g.relations.list()).items.map((r) => r.id)).toEqual([GLOBEX]);
    const asOf = new Set((await g.retrieve("Ann", { as_of: at(2023) })).subgraph.relations.map((r) => r.id));
    expect(asOf).toEqual(new Set([GLOBEX]));
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
    expect((await g.retrieve("Ann", { as_of: first })).context).toContain("GRAPH | Ann -[WORKS_AT]-> Acme {role=dev}");
    expect((await g.retrieve("Ann", { as_of: await instant() })).context).toContain("{role=cto}");
    await g.relations.create("person:ann", "WORKS_AT", "company:globex");
    const between = await instant();
    await g.insert.facts({ entities: [{ type: "Person", name: "Zed" }] });
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
    await g.insert.facts({
      entities: PEOPLE,
      relations: [{ ...base, properties: { role: "dev" }, event_time: "2020-01-01T00:00:00Z" }],
    });
    await g.relations.update(ACME, { set_properties: { role: "cto" }, event_time: "2022-01-01T00:00:00Z" });
    const asOf = async (year: number) => g.retrieve("Ann Acme", { as_of: new Date(Date.UTC(year, 5, 1)) });
    expect((await asOf(2021)).context.split("\n")).toContain("GRAPH | Ann -[WORKS_AT]-> Acme {role=dev}");
    expect((await asOf(2021)).subgraph.entities.map((e) => e.id).sort()).toEqual(["company:acme", "person:ann"]);
    expect((await asOf(2023)).context.split("\n")).toContain("GRAPH | Ann -[WORKS_AT]-> Acme {role=cto}");
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
    expect(past.context.split("\n")).toContain("GRAPH | Jane Q Doe prefers Python (tool)");
    expect(past.context).not.toContain("tool:python");
    expect(past.subgraph.decisions).toEqual([]);
    expect((await h.retrieve("Jane")).subgraph.decisions.map((d) => d.title)).toEqual(["Pick Rust"]);

    const k = open();
    await k.insert.facts({ entities: PEOPLE });
    const titled = await k.relations.create("person:ann", "WORKS_AT", "company:acme");
    await k.relations.update(titled.id, { set_properties: { title: "Dev" }, event_time: at(2025) });
    for (const when of [await instant(), at(2099), new Date(Date.UTC(2025, 5, 1))]) {
      expect((await k.retrieve("Ann Acme", { as_of: when })).context.split("\n")).toContain(
        "GRAPH | Ann -[WORKS_AT]-> Acme {title=Dev}",
      );
    }
    expect((await k.retrieve("Ann", { as_of: at(2024) })).subgraph.relations).toEqual([]);

    const p = open();
    await p.insert.facts({ entities: PEOPLE });
    await p.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: at(2020) });
    await p.insert.text("Ann works at Acme.", { source_id: "note", event_time: at(2020) });
    expect((await p.retrieve("Ann Acme", { as_of: at(2021) })).context.split("\n")).toContain(
      "SOURCE | Ann works at Acme.",
    );
    expect((await p.retrieve("Ann Acme", { as_of: at(2019) })).context).not.toContain("Ann works at Acme.");
  });

  it("known_at reads what the graph held before a backdated correction", async () => {
    const g = await graph("supersede");
    const acme = await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: at(2024) });
    const learned = await instant();
    const globex = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: at(2025) });
    const held = async (options: object) => (await g.retrieve("Ann", options)).subgraph.relations;
    const mid2025 = new Date(Date.UTC(2025, 5, 1));
    expect((await held({ as_of: mid2025 })).map((r) => r.id)).toEqual([globex.id]);
    const [then] = await held({ as_of: mid2025, known_at: learned });
    expect([then!.id, then!.is_current, then!.invalidated_at, then!.invalidated_known_at]).toEqual([
      acme.id,
      true,
      null,
      null,
    ]);
    expect((await held({ known_at: learned })).map((r) => r.id)).toEqual([acme.id]);
    expect((await held({ known_at: await instant() })).map((r) => r.id)).toEqual([globex.id]);
    const [old] = await held({ as_of: new Date(Date.UTC(2024, 5, 1)) });
    expect([old!.id, old!.is_current, old!.invalidated_by]).toEqual([acme.id, false, globex.id]);
    expect(old!.invalidated_known_at!.getTime()).toBeGreaterThan(learned.getTime());
    const report = await g.checkAnswerable("Ann Globex", { as_of: mid2025, known_at: learned });
    expect([report.verdict, report.missing]).toEqual(["partial", ["globex"]]);
    await expect(g.retrieve("Ann", { known_at: "soon" })).rejects.toThrow(/invalid known_at/);
  });

  it("known_at leaves out entities, decisions, certifications, revisions, and passages written later", async () => {
    const g = open();
    await g.insert.facts({ entities: PEOPLE });
    const rel = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    await g.insert.text("Ann works at Acme in Berlin.", { source_id: "note" });
    const learned = await instant();
    await g.relations.certify(rel.id, { by: "ops" });
    await g.entities.create("Zed", "Person");
    await g.decisions.create("Join Acme", { steps: [rel.id], actor_entity: "person:ann", event_time: at(2020) });
    await g.relations.update(rel.id, { set_properties: { role: "cto" }, event_time: at(2020) });
    await g.insert.text("Ann works at Acme in Paris.", { source_id: "note", replace_source: true });
    const then = await g.retrieve("Ann Acme Zed Berlin Paris", { as_of: at(2099), known_at: learned });
    expect(then.subgraph.entities.map((e) => e.id)).not.toContain("person:zed");
    expect(then.subgraph.decisions).toEqual([]);
    const [held] = then.subgraph.relations.filter((r) => r.id === rel.id);
    expect([held!.revision, held!.is_current, held!.certified_at]).toEqual([1, true, null]);
    expect(then.context).not.toContain("[certified]");
    expect(then.context.split("\n")).toContain("SOURCE | Ann works at Acme in Berlin.");
    expect(then.context).not.toContain("Ann works at Acme in Paris.");
    const later = await g.retrieve("Ann Acme Zed Berlin Paris", { as_of: at(2099) });
    expect(later.subgraph.entities.map((e) => e.id)).toContain("person:zed");
    expect(later.subgraph.decisions.map((d) => d.title)).toEqual(["Join Acme"]);
    expect(later.context.split("\n")).toContain("SOURCE | Ann works at Acme in Paris.");
    expect(later.context).not.toContain("Ann works at Acme in Berlin.");
    expect((await g.checkAnswerable("Zed", { known_at: learned })).verdict).toBe("not_answerable");
    expect((await g.checkAnswerable("Zed", { known_at: await instant() })).verdict).toBe("answerable");
  });

  it("known_at keeps passages through reinserts and replacement history", async () => {
    const g = open();
    await g.insert.facts({ entities: PEOPLE });
    const berlin = "Ann works at Acme in Berlin.";
    const paris = "Ann works at Acme in Paris.";
    await g.insert.text(berlin, { source_id: "note" });
    const first = await instant();
    await g.insert.text(berlin, { source_id: "note" });
    await g.insert.text(paris, { source_id: "note", replace_source: true });
    const replaced = await instant();
    await g.insert.text(berlin, { source_id: "note", replace_source: true });
    const quoted = async (known: Date) => {
      const lines = (await g.retrieve("Ann Acme Berlin Paris", { as_of: at(2099), known_at: known })).context.split(
        "\n",
      );
      return [berlin, paris].filter((line) => lines.includes(`SOURCE | ${line}`));
    };
    expect(await quoted(first)).toEqual([berlin]);
    expect(await quoted(replaced)).toEqual([paris]);
    expect(await quoted(await instant())).toEqual([berlin]);
  });

  it("known_at shows the certification in force then", async () => {
    const g = open();
    await g.insert.facts({ entities: PEOPLE });
    const rel = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    const first = await g.relations.certify(rel.id, { by: "alice" });
    expect((await g.relations.certify(rel.id, { by: "alice" })).certified_at).toEqual(first.certified_at);
    const alice = await instant();
    await g.relations.certify(rel.id, { by: "bob" });
    const bob = await instant();
    await g.relations.uncertify(rel.id);
    const held = async (known: Date) => {
      const [r] = (await g.retrieve("Ann", { known_at: known })).subgraph.relations;
      return [r!.certified_by, r!.certifications.map((c) => [c.by, c.until === null])];
    };
    expect(await held(alice)).toEqual(["alice", [["alice", true]]]);
    expect(await held(bob)).toEqual([
      "bob",
      [
        ["alice", false],
        ["bob", true],
      ],
    ]);
    expect(await held(await instant())).toEqual([
      null,
      [
        ["alice", false],
        ["bob", false],
      ],
    ]);
  });

  it("known_at counts only the sources recorded by then", async () => {
    const g = open();
    await g.insert.facts({ entities: PEOPLE });
    await g.insert.facts({ relations: [annAt("acme")] } as never, { source_id: "one" });
    const [written] = (await g.relations.list()).items;
    expect(
      (await g.retrieve("Ann", { known_at: written!.created_at })).subgraph.relations.map((r) => r.source_count),
    ).toEqual([1]);
    const learned = await instant();
    await g.insert.facts({ relations: [annAt("acme")] } as never, { source_id: "two" });
    const counts = async (options: object) =>
      (await g.retrieve("Ann", options)).subgraph.relations.map((r) => r.source_count);
    expect(await counts({})).toEqual([2]);
    expect(await counts({ known_at: learned })).toEqual([1]);
  });

  it("known_at uses historical entity source counts for scoring and results", async () => {
    const g = open();
    const east = { type: "Project", name: "Orchid East" };
    const west = { type: "Project", name: "Orchid West" };
    await g.insert.facts({ entities: [east, west] }, { source_id: "initial" });
    await g.relations.create("project:orchid-east", "NEIGHBOR", "project:orchid-west");
    const cutoff = await instant();
    const before = await g.retrieve("Orchid", { known_at: cutoff, k: 1 });
    expect(before.seeds.map((seed) => seed.id)).toEqual(["project:orchid-east"]);
    await g.insert.facts({ entities: [east, west] }, { source_id: "second" });
    await g.insert.facts({ entities: [east] }, { source_id: "third" });

    expect((await g.retrieve("Orchid", { k: 1 })).seeds[0]!.id).toBe("project:orchid-west");
    const replay = await g.retrieve("Orchid", { known_at: cutoff, k: 1 });
    expect(replay.seeds).toEqual(before.seeds);
    expect(Object.fromEntries(replay.subgraph.entities.map((e) => [e.id, e.source_count]))).toEqual({
      "project:orchid-east": 1,
      "project:orchid-west": 1,
    });
  });

  it("reinserting the same text keeps the version as first stored", async () => {
    const g = open();
    await g.insert.facts({ entities: PEOPLE });
    await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: at(2020) });
    await g.insert.text("Ann joined Acme.", { source_id: "dated", event_time: at(2020) });
    await g.insert.text("Ann joined Acme.", { source_id: "dated", event_time: at(2024) });
    const lines = (await g.retrieve("Ann Acme", { as_of: at(2021) })).context.split("\n");
    expect(lines).toContain("SOURCE | Ann joined Acme.");
  });

  it("known_at quotes a passage only once its evidence was recorded", async () => {
    let names = ["Ann"];
    const extractor: Extractor = {
      extract: async () => ({ entities: names.map((name) => ({ type: "Person", name })) }),
    };
    const g = open({ extractor });
    await g.entities.create("Bob", "Person");
    await g.insert.text("Ann met Bob.", { source_id: "note" });
    const learned = await instant();
    names = ["Ann", "Bob"];
    await g.insert.text("Ann met Bob.", { source_id: "note" });
    expect((await g.retrieve("Bob")).context).toContain("Ann met Bob.");
    expect((await g.retrieve("Bob", { known_at: learned })).context).not.toContain("Ann met Bob.");
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

  it("known_at keeps the retirement a late middle fact corrected", async () => {
    const g = await graph("supersede");
    await g.insert.facts({ entities: [{ type: "Company", name: "Initech" }] });
    const acme = await g.relations.create("person:ann", "WORKS_AT", "company:acme", { event_time: at(2020) });
    const initech = await g.relations.create("person:ann", "WORKS_AT", "company:initech", { event_time: at(2024) });
    const learned = await instant();
    const globex = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: at(2022) });
    const held = async (year: number, options: object = {}) =>
      new Set(
        (await g.retrieve("Ann", { as_of: new Date(Date.UTC(year, 5, 1)), ...options })).subgraph.relations.map(
          (r) => r.id,
        ),
      );
    expect([await held(2021), await held(2023), await held(2025)]).toEqual([
      new Set([acme.id]),
      new Set([globex.id]),
      new Set([initech.id]),
    ]);
    const known = { known_at: learned };
    expect([await held(2021, known), await held(2023, known), await held(2025, known)]).toEqual([
      new Set([acme.id]),
      new Set([acme.id]),
      new Set([initech.id]),
    ]);
    const [fresh, old] = await g.relations.versions(acme.id);
    expect([old!.invalidated_by, fresh!.invalidated_by, fresh!.revision]).toEqual([
      initech.id,
      globex.id,
      old!.revision + 1,
    ]);
  });

  it("correcting an undated relation keeps its effective time", async () => {
    const g = await graph("supersede");
    const start = await instant();
    const acme = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    await g.relations.create("person:ann", "WORKS_AT", "company:initech", {
      event_time: new Date(start.getTime() + 86_400_000),
    });
    const point = await instant();
    const before = await instant();
    const globex = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: point });
    const after = await instant();

    const held = async (options: object = {}) =>
      new Set((await g.retrieve("Ann", { as_of: point, ...options })).subgraph.relations.map((r) => r.id));
    expect(await held()).toEqual(new Set([globex.id]));
    expect(await held({ known_at: after })).toEqual(new Set([globex.id]));
    expect(await held({ known_at: before })).toEqual(new Set([acme.id]));
    const [fresh, old] = await g.relations.versions(acme.id);
    expect(fresh!.event_time).toEqual(old!.created_at);
    expect(fresh!.created_at).toEqual(fresh!.invalidated_known_at);
    expect([fresh!.invalidated_by, fresh!.invalidated_at]).toEqual([globex.id, point]);
  });

  it("resettling a corrected undated relation keeps its effective time", async () => {
    const g = await graph("supersede");
    const start = await instant();
    const acme = await g.relations.create("person:ann", "WORKS_AT", "company:acme");
    const initech = await g.relations.create("person:ann", "WORKS_AT", "company:initech", {
      event_time: new Date(start.getTime() + 172_800_000),
    });
    const point = await instant();
    const globex = await g.relations.create("person:ann", "WORKS_AT", "company:globex", { event_time: point });
    const before = await instant();
    const prior = new Set(
      (await g.retrieve("Ann", { as_of: point, known_at: before })).subgraph.relations.map((r) => r.id),
    );
    expect(prior).toEqual(new Set([globex.id]));
    await g.relations.delete(globex.id);

    const held = new Set((await g.retrieve("Ann", { as_of: point })).subgraph.relations.map((r) => r.id));
    expect(held).toEqual(new Set([acme.id]));
    const versions = await g.relations.versions(acme.id);
    expect(versions[0]!.invalidated_by).toEqual(initech.id);
    expect(versions[0]!.event_time).toEqual(versions[versions.length - 1]!.created_at);
    expect(versions[0]!.created_at).toEqual(versions[0]!.invalidated_known_at);
  });

  it("a late middle fact corrects the retired history it lands in", async () => {
    const [acme, globex, initech] = [annAt("acme", 2020), annAt("globex", 2022), annAt("initech", 2024)];
    const initechId = ids.relationId("person:ann", "WORKS_AT", "company:initech");
    for (const order of [
      [acme, globex, initech],
      [acme, initech, globex],
      [initech, acme, globex],
    ]) {
      const g = await graph("supersede");
      for (const rel of order) await insert(g, [rel!]);
      const [first] = await g.relations.versions(ACME);
      const [mid] = await g.relations.versions(GLOBEX);
      expect([first!.invalidated_by, first!.invalidated_at]).toEqual([GLOBEX, at(2022)]);
      expect([mid!.invalidated_by, mid!.invalidated_at]).toEqual([initechId, at(2024)]);
      const valid = async (when: Date) =>
        new Set((await g.retrieve("Ann", { as_of: when })).subgraph.relations.map((r) => r.id));
      expect(await valid(new Date(Date.UTC(2021, 5, 1)))).toEqual(new Set([ACME]));
      expect(await valid(at(2023))).toEqual(new Set([GLOBEX]));
      expect(await valid(at(2025))).toEqual(new Set([initechId]));
    }
  });

  it("a relation ends at the earliest endpoint that displaces it in any order", async () => {
    const spec: Schema = {
      entities: [{ name: "Person" }, { name: "Company" }],
      relations: [
        { type: "WORKS_AT", from: { types: ["Person"], max_count: 1 }, to: { types: ["Company"], max_count: 1 } },
      ],
    };
    const entities = [
      { type: "Person", name: "Ann" },
      { type: "Person", name: "Bob" },
      ...["Acme", "Globex", "Initech"].map((name) => ({ type: "Company", name })),
    ];
    const link = (person: string, company: string, year: number) => ({
      from_entity: `person:${person}`,
      type: "WORKS_AT",
      to_entity: `company:${company}`,
      event_time: at(year),
    });
    const rels = [
      link("ann", "acme", 2020),
      link("ann", "globex", 2024),
      link("bob", "acme", 2022),
      link("ann", "initech", 2026),
    ];
    const annAcme = ids.relationId("person:ann", "WORKS_AT", "company:acme");
    const bobAcme = ids.relationId("person:bob", "WORKS_AT", "company:acme");
    for (const batches of [[[0], [1], [2]], [[2], [1], [0]], [[0], [3], [1, 2]], [[0, 1, 2, 3]]]) {
      const g = open({ schema: spec, contradiction: "supersede" });
      await g.insert.facts({ entities });
      for (const batch of batches) await g.insert.facts({ relations: batch.map((i) => rels[i]!) });
      const [ended] = await g.relations.versions(annAcme);
      expect([ended!.invalidated_by, ended!.invalidated_at], JSON.stringify(batches)).toEqual([bobAcme, at(2022)]);
      expect((await g.relations.get(bobAcme))?.is_current).toBe(true);
    }

    const subms = open({ schema: spec, contradiction: "supersede" });
    await subms.insert.facts({
      entities,
      relations: [
        {
          from_entity: "person:ann",
          type: "WORKS_AT",
          to_entity: "company:acme",
          event_time: "2024-01-01T00:00:00.000100Z",
        },
        {
          from_entity: "person:ann",
          type: "WORKS_AT",
          to_entity: "company:globex",
          event_time: "2024-01-01T00:00:00.000300Z",
        },
        {
          from_entity: "person:bob",
          type: "WORKS_AT",
          to_entity: "company:acme",
          event_time: "2024-01-01T00:00:00.000200Z",
        },
      ],
    });
    const [subEnded] = await subms.relations.versions(annAcme);
    expect([subEnded!.invalidated_by, jsonIso(subEnded!.invalidated_at!)]).toEqual([
      bobAcme,
      "2024-01-01T00:00:00.000200Z",
    ]);

    const lateSubms = open({ schema: spec, contradiction: "supersede" });
    await lateSubms.insert.facts({
      entities,
      relations: [
        {
          from_entity: "person:ann",
          type: "WORKS_AT",
          to_entity: "company:acme",
          event_time: "2024-01-01T00:00:00.000100Z",
        },
        {
          from_entity: "person:bob",
          type: "WORKS_AT",
          to_entity: "company:acme",
          event_time: "2024-01-01T00:00:00.000300Z",
        },
      ],
    });
    await lateSubms.insert.facts({
      relations: [
        {
          from_entity: "person:ann",
          type: "WORKS_AT",
          to_entity: "company:initech",
          event_time: "2024-01-01T00:00:00.000200Z",
        },
      ],
    });
    const annInitech = ids.relationId("person:ann", "WORKS_AT", "company:initech");
    const [corrected] = await lateSubms.relations.versions(annAcme);
    expect([corrected!.revision, corrected!.invalidated_by, jsonIso(corrected!.invalidated_at!)]).toEqual([
      2,
      annInitech,
      "2024-01-01T00:00:00.000200Z",
    ]);
  });

  it("source-withdrawn relations stay out of supersede history", async () => {
    let g = await graph("supersede");
    await g.insert.facts({ relations: [annAt("acme", 2020)] }, { source_id: "src-acme" });
    await g.insert.text("nothing happened.", { source_id: "src-acme", replace_source: true });
    const older = await g.insert.facts({ relations: [annAt("globex", 2019)] }, { source_id: "src-globex" });
    expect(older.warnings).toEqual([]);
    expect((await g.relations.list({ from_entity: "person:ann" })).items.map((r) => r.id)).toEqual([GLOBEX]);
    let [acme] = await g.relations.versions(ACME);
    expect([acme!.revision, acme!.is_current]).toEqual([1, false]);
    expect(acme!.invalidated_by?.startsWith("sv:")).toBe(true);

    g = open({ schema: SPEC, contradiction: "supersede", resolver: "default" });
    const annSmith = "person:ann-smith";
    const smithAcme = ids.relationId(annSmith, "WORKS_AT", "company:acme");
    await g.insert.facts(
      {
        entities: [...PEOPLE, { type: "Person", name: "Ann Smith", aliases: ["Annie"] }],
        relations: [{ from_entity: annSmith, type: "WORKS_AT", to_entity: "company:acme", event_time: at(2020) }],
      },
      { source_id: "src-withdrawn" },
    );
    await g.insert.text("nothing happened.", { source_id: "src-withdrawn", replace_source: true });
    await g.insert.facts(
      { relations: [{ from_entity: annSmith, type: "WORKS_AT", to_entity: "company:globex", event_time: at(2024) }] },
      { source_id: "src-globex" },
    );
    const merged = await g.insert.facts(
      {
        entities: [{ type: "Person", name: "Annie" }],
        relations: [
          { from_entity: "person:annie", type: "WORKS_AT", to_entity: "company:initech", event_time: at(2022) },
        ],
      },
      { source_id: "src-initech" },
    );
    [acme] = await g.relations.versions(smithAcme);
    expect([acme!.revision, acme!.is_current]).toEqual([1, false]);
    expect(acme!.invalidated_by?.startsWith("sv:")).toBe(true);
    await g.entities.unmerge(merged.merges[0]!.id);
    const [after] = await g.relations.versions(smithAcme);
    expect([after!.revision, after!.is_current, after!.invalidated_by]).toEqual([1, false, acme!.invalidated_by]);

    const judge: LLMClient = {
      generate: async ({ output }) => output.parse({ retired: [1] }),
    };
    const llmSpec: Schema = { ...SPEC, relations: [...(SPEC.relations ?? []), { type: "LEFT" }] };
    g = open({ schema: llmSpec, contradiction: "llm", llm: judge });
    await g.insert.facts({ entities: PEOPLE, relations: [annAt("acme", 2020)] });
    await g.relations.create("person:ann", "LEFT", "company:acme", { event_time: at(2022) });
    const late = await g.insert.facts({ relations: [annAt("globex", 2019)] });
    expect(late.warnings.map((w) => w.code)).toEqual(["contradiction_out_of_order"]);
    expect((await g.relations.list({ from_entity: "person:ann", type: "WORKS_AT" })).items).toEqual([]);
  });

  const current = async (g: SelfGraph) =>
    (await g.relations.list({ from_entity: "person:ann" })).items.map((r) => r.id);

  it("deleting the relation that superseded another restores it", async () => {
    const removals = [
      (g: SelfGraph) => g.relations.delete(GLOBEX),
      (g: SelfGraph) => g.entities.delete("company:globex"),
    ];
    for (const remove of removals) {
      const g = await graph("supersede");
      await insert(g, [annAt("acme", 2020)]);
      await insert(g, [annAt("globex", 2023)]);
      expect((await remove(g)).restored_relations).toBe(1);
      expect(await current(g)).toEqual([ACME]);
      const [newest, retired] = await g.relations.versions(ACME);
      expect([newest!.revision, newest!.is_current, newest!.invalidated_by]).toEqual([2, true, null]);
      expect([newest!.event_time, retired!.invalidated_by]).toEqual([at(2020), GLOBEX]);
      const valid = (await g.retrieve("Ann", { as_of: at(2024) })).subgraph.relations.map((r) => r.id);
      expect(valid).toEqual([ACME]);
      expect((await g.relations.delete(ACME)).restored_relations).toBe(0);
    }
  });

  it("a retired relation that still does not fit is re-pointed to what displaces it", async () => {
    const initech = ids.relationId("person:ann", "WORKS_AT", "company:initech");
    const jobs = async () => {
      const g = await graph("supersede");
      for (const [company, year] of [
        ["acme", 2019],
        ["globex", 2020],
        ["initech", 2022],
      ] as const) {
        await insert(g, [annAt(company, year)]);
      }
      return g;
    };
    let g = await jobs();
    expect((await g.relations.delete(GLOBEX)).restored_relations).toBe(0);
    expect(await current(g)).toEqual([initech]);
    let [acme] = await g.relations.versions(ACME);
    expect([acme!.is_current, acme!.invalidated_by, acme!.invalidated_at]).toEqual([false, initech, at(2022)]);
    const valid = await g.retrieve("Ann", { as_of: new Date(Date.UTC(2021, 0, 1)) });
    expect(valid.subgraph.relations.map((r) => r.id)).toEqual([ACME]);

    g = await jobs();
    expect((await g.relations.delete(initech)).restored_relations).toBe(1);
    expect(await current(g)).toEqual([GLOBEX]);
    [acme] = await g.relations.versions(ACME);
    expect([acme!.is_current, acme!.invalidated_by, acme!.invalidated_at]).toEqual([false, GLOBEX, at(2020)]);
  });

  it("dedupe re-points what a folded duplicate retired to the survivor", async () => {
    const g = await graph("supersede");
    const bob = await g.relations.create("person:bob", "CEO_OF", "company:acme", { event_time: at(2020) });
    await g.relations.create("person:ann", "CEO_OF", "company:acme", { id: "relation:c2", event_time: at(2022) });
    expect((await g.relations.versions(bob.id))[0]!.invalidated_by).toBe("relation:c2");
    await g.relations.create("person:ann", "CEO_OF", "company:acme", { id: "relation:c1", contradiction: "warn" });
    await g.maintenance.dedupeRelations({ dry_run: false });
    expect((await g.relations.versions(bob.id))[0]!.invalidated_by).toBe("relation:c1");
  });

  it("a delete settles the whole endpoint again, newest first", async () => {
    const usesSpec: Schema = {
      entities: [{ name: "Person" }, { name: "Tool" }],
      relations: [{ type: "USES", from: { types: ["Person"], max_count: 2 } }],
    };
    const uses = (tool: string) => ids.relationId("person:ann", "USES", `tool:${tool}`);
    const tools = async (...names: string[]) => {
      const g = open({ schema: usesSpec, contradiction: "supersede" });
      const entities = [
        { type: "Person", name: "Ann" },
        ...["a", "b", "c", "d"].map((name) => ({ type: "Tool", name })),
      ];
      await g.insert.facts({ entities });
      for (const [i, name] of names.entries()) {
        await g.relations.create("person:ann", "USES", `tool:${name}`, { event_time: at(2020 + i) });
      }
      return g;
    };
    let g = await tools("a", "b", "c", "d");
    expect((await g.relations.delete(uses("c"))).restored_relations).toBe(1);
    expect((await current(g)).sort()).toEqual([uses("b"), uses("d")].sort());
    const [a] = await g.relations.versions(uses("a"));
    expect([a!.is_current, a!.invalidated_by, a!.invalidated_at]).toEqual([false, uses("d"), at(2023)]);

    g = await tools("a", "b", "c");
    expect((await g.relations.delete(uses("b"))).restored_relations).toBe(1);
    expect((await current(g)).sort()).toEqual([uses("a"), uses("c")].sort());
  });

  it("a delete counts retired history at the other endpoint", async () => {
    const spec: Schema = {
      entities: [{ name: "Person" }, { name: "Company" }],
      relations: [
        { type: "WORKS_AT", from: { types: ["Person"], max_count: 1 }, to: { types: ["Company"], max_count: 1 } },
      ],
    };
    const g = open({ schema: spec, contradiction: "supersede" });
    await g.insert.facts({
      entities: [
        ...["Ann", "Bob"].map((name) => ({ type: "Person", name })),
        ...["Acme", "Globex", "Initech"].map((name) => ({ type: "Company", name })),
      ],
    });
    for (const [person, company, year] of [
      ["ann", "acme", 2020],
      ["ann", "globex", 2021],
      ["bob", "acme", 2022],
      ["bob", "initech", 2023],
    ] as const) {
      await insert(g, [
        { from_entity: `person:${person}`, type: "WORKS_AT", to_entity: `company:${company}`, event_time: at(year) },
      ]);
    }
    const bobAcme = ids.relationId("person:bob", "WORKS_AT", "company:acme");
    expect((await g.relations.delete(GLOBEX)).restored_relations).toBe(0);
    const [newest, first] = await g.relations.versions(ACME);
    expect([newest!.is_current, newest!.invalidated_by, newest!.invalidated_at]).toEqual([false, bobAcme, at(2022)]);
    expect([newest!.revision, first!.invalidated_by]).toEqual([first!.revision + 1, GLOBEX]);
    const valid = await g.retrieve("Ann", { as_of: new Date(Date.UTC(2021, 5, 1)) });
    expect(valid.subgraph.relations.map((r) => r.id)).toEqual([ACME]);
  });

  for (const how of ["insert", "update"] as const) {
    const backdate = (g: SelfGraph, rid: string, rel: { event_time?: string }) =>
      how === "insert" ? insert(g, [rel]) : g.relations.update(rid, { event_time: rel.event_time });

    it(`moving the superseding fact earlier by ${how} reinstates the relation it retired`, async () => {
      const g = await graph("supersede");
      await insert(g, [annAt("acme", 2020)]);
      await insert(g, [annAt("globex", 2022)]);
      const learned = await instant();
      const moved = await backdate(g, GLOBEX, annAt("globex", 2019));
      if (!("warnings" in moved))
        expect([moved.id, moved.is_current, moved.invalidated_by]).toEqual([GLOBEX, false, ACME]);
      const [acme, old] = await g.relations.versions(ACME);
      const [globex] = await g.relations.versions(GLOBEX);
      expect([acme!.is_current, acme!.revision, acme!.event_time, acme!.invalidated_by]).toEqual([
        true,
        2,
        at(2020),
        null,
      ]);
      expect([old!.is_current, old!.invalidated_by, old!.invalidated_at]).toEqual([false, GLOBEX, at(2022)]);
      expect([globex!.is_current, globex!.invalidated_by, globex!.invalidated_at]).toEqual([false, ACME, at(2020)]);
      expect((await g.relations.list()).items.map((r) => r.id)).toEqual([ACME]);
      const valid = async (when: Date, options: object = {}) =>
        (await g.retrieve("Ann", { as_of: when, ...options })).subgraph.relations.map((r) => r.id);
      expect(await valid(new Date(Date.UTC(2019, 5, 1)))).toEqual([GLOBEX]);
      expect([await valid(at(2021)), await valid(at(2023))]).toEqual([[ACME], [ACME]]);
      expect(await valid(at(2023), { known_at: learned })).toEqual([GLOBEX]);
    });

    for (const successor of [false, true]) {
      const name = successor
        ? "stays retired when the other end displaces it"
        : "is reinstated when no end displaces it";
      it(`a relation capped at both ends ${name}, moved by ${how}`, async () => {
        const spec: Schema = {
          entities: [{ name: "Person" }, { name: "Company" }],
          relations: [
            { type: "WORKS_AT", from: { types: ["Person"], max_count: 1 }, to: { types: ["Company"], max_count: 1 } },
          ],
        };
        const link = (person: string, company: string, year: number) =>
          worksAt(`person:${person}`, `company:${company}`, year);
        const [annAcme, bobAcme, annGlobex] = [
          ["ann", "acme"],
          ["bob", "acme"],
          ["ann", "globex"],
        ].map(([person, company]) => ids.relationId(`person:${person}`, "WORKS_AT", `company:${company}`));
        const g = open({ schema: spec, contradiction: "supersede" });
        await g.insert.facts({ entities: PEOPLE });
        await insert(g, [link("ann", "acme", 2020)]);
        await insert(g, [link("ann", "globex", 2022)]);
        if (successor) await insert(g, [link("bob", "acme", 2024)]);
        await backdate(g, annGlobex!, link("ann", "globex", 2018));
        const [held] = await g.relations.versions(annAcme!);
        const [moved] = await g.relations.versions(annGlobex!);
        expect([moved!.invalidated_by, moved!.invalidated_at]).toEqual([annAcme, at(2020)]);
        expect([held!.is_current, held!.invalidated_by, held!.invalidated_at]).toEqual(
          successor ? [false, bobAcme, at(2024)] : [true, null, null],
        );
        const valid = async (when: Date) =>
          (await g.retrieve("Ann", { as_of: when })).subgraph.relations.map((r) => r.id);
        expect([await valid(at(2019)), await valid(at(2023))]).toEqual([[annGlobex], [annAcme]]);
      });
    }
  }

  it("an insert that moves a fact reports what it stored", async () => {
    const g = await graph("supersede");
    await insert(g, [annAt("acme", 2020)]);
    await insert(g, [annAt("globex", 2022)]);
    const result = await insert(g, [annAt("acme", 2020), annAt("globex", 2019)]);
    const stored = [(await g.relations.versions(ACME))[0]!, (await g.relations.versions(GLOBEX))[0]!];
    expect(result.relations).toEqual(stored);
    expect(stored.map((r) => [r.is_current, r.invalidated_by])).toEqual([
      [true, null],
      [false, ACME],
    ]);
  });

  it("updating the superseding fact to a later time moves the retirement it caused", async () => {
    const g = await graph("supersede");
    await insert(g, [annAt("acme", 2020)]);
    await insert(g, [annAt("globex", 2022)]);
    expect((await g.relations.update(GLOBEX, { event_time: at(2025) })).is_current).toBe(true);
    const [acme] = await g.relations.versions(ACME);
    expect([acme!.is_current, acme!.invalidated_by, acme!.invalidated_at]).toEqual([false, GLOBEX, at(2025)]);
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
