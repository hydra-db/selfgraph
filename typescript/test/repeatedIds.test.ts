import { expect, it } from "vitest";

import { entityId, ids, type SelfGraph } from "../src/index.js";
import { forEachStore, freshGraphs, type StoreSpec } from "./helpers.js";

const FOLD_ENTITIES = {
  entities: [
    { type: "Person", name: "Ann" },
    { type: "Food", name: "Pizza" },
    { type: "Food", name: "Pasta" },
  ],
};
const FOLD_RELATION = { from_entity: "person:ann", type: "LIKES", to_entity: "food:pasta" };
const FOLD_PREFERENCE = { subject_entity: "person:ann", key: "food", value_entity: "food:pizza" };
const EARLY = "2020-01-01T00:00:00.000Z";
const LATE = "2021-01-01T00:00:00.000Z";

type Item = { properties?: Record<string, number | null>; event_time?: string };
type RelationHistory = [revision: number, properties: object, eventTime: string | null][];
const REPEATED_RELATIONS: [string, Record<string, number> | null, Item[], RelationHistory][] = [
  ["last wins", null, [{ properties: { w: 1 } }, { properties: { w: 2 } }], [[1, { w: 2 }, null]]],
  ["keys merge", null, [{ properties: { a: 1, w: 1 } }, { properties: { w: 3 } }], [[1, { a: 1, w: 3 }, null]]],
  [
    "stored one new revision",
    { w: 1 },
    [{ properties: { w: 2 } }, { properties: { w: 3 } }],
    [
      [2, { w: 3 }, null],
      [1, { w: 1 }, null],
    ],
  ],
  [
    "later null removes",
    { w: 1 },
    [{ properties: { w: 2 } }, { properties: { w: null } }],
    [
      [2, {}, null],
      [1, { w: 1 }, null],
    ],
  ],
  [
    "later value restores",
    { w: 1 },
    [{ properties: { w: null } }, { properties: { w: 2 } }],
    [
      [2, { w: 2 }, null],
      [1, { w: 1 }, null],
    ],
  ],
  ["back to stored", { w: 1 }, [{ properties: { w: 2 } }, { properties: { w: 1 } }], [[1, { w: 1 }, null]]],
  ["newest event time", null, [{ event_time: EARLY }, { event_time: LATE }], [[1, {}, LATE]]],
];

type PrefItem = { strength?: number; about_entity?: string; properties?: Record<string, number> };
type PrefHistory = [revision: number, strength: number | null, about: string | null, properties: object][];
const REPEATED_PREFERENCES: [string, PrefItem | null, PrefItem[], PrefHistory][] = [
  ["last strength wins", null, [{ strength: 1.0 }, { strength: 0.1 }], [[1, 0.1, null, {}]]],
  [
    "unset about keeps earlier",
    null,
    [{ about_entity: "food:pasta", strength: 0.2 }, { strength: 0.3 }],
    [[1, 0.3, "food:pasta", {}]],
  ],
  [
    "properties merge",
    null,
    [{ properties: { a: 1, w: 1 } }, { properties: { w: 2 } }],
    [[1, null, null, { a: 1, w: 2 }]],
  ],
  [
    "stored one new revision",
    { strength: 0.5 },
    [{ strength: 0.9 }, { strength: 0.1 }],
    [
      [2, 0.1, null, {}],
      [1, 0.5, null, {}],
    ],
  ],
  ["back to stored", { strength: 0.5 }, [{ strength: 0.9 }, { strength: 0.5 }], [[1, 0.5, null, {}]]],
];

function suite(spec: StoreSpec) {
  const open = freshGraphs(spec, "fold");
  const seeded = async (): Promise<SelfGraph> => {
    const g = open();
    await g.insert.facts(FOLD_ENTITIES);
    return g;
  };

  for (const explicit of [undefined, "relation:fold"]) {
    for (const [name, stored, given, history] of REPEATED_RELATIONS) {
      it(`writes one revision for a repeated relation id and replays clean: ${name}, id ${explicit ?? "derived"}`, async () => {
        const g = await seeded();
        const named = { ...FOLD_RELATION, ...(explicit === undefined ? {} : { id: explicit }) };
        const rid = explicit ?? ids.relationId("person:ann", "LIKES", "food:pasta");
        if (stored !== null) await g.insert.facts({ relations: [{ ...named, properties: stored }] });
        for (let i = 0; i < 3; i++) {
          const res = await g.insert.facts({ relations: given.map((item) => ({ ...named, ...item })) });
          expect(res.relations.map((r) => r.id)).toEqual([rid]);
          const versions = await g.relations.versions(rid);
          expect(versions.map((v) => [v.revision, v.properties, v.event_time?.toISOString() ?? null])).toEqual(history);
        }
      });
    }
  }

  it("joins the evidence of every input of a repeated relation id", async () => {
    const g = await seeded();
    const rid = ids.relationId("person:ann", "LIKES", "food:pasta");
    const given = [1, 2].map((n) => ({
      ...FOLD_RELATION,
      properties: { w: n },
      evidence: [{ source_id: `doc-${n}`, quote: `quote ${n}` }],
    }));
    for (let i = 0; i < 3; i++) {
      await g.insert.facts({ relations: given });
      const versions = await g.relations.versions(rid);
      expect(versions.map((v) => [v.revision, v.source_count])).toEqual([[1, 2]]);
      const evidence = (await g.relations.evidence(rid)).items;
      expect(evidence.map((e) => [e.source_id, e.quote]).sort()).toEqual([
        ["doc-1", "quote 1"],
        ["doc-2", "quote 2"],
      ]);
    }
  });

  for (const explicit of [undefined, "preference:fold"]) {
    for (const [name, stored, given, history] of REPEATED_PREFERENCES) {
      it(`writes one revision for a repeated preference id and replays clean: ${name}, id ${explicit ?? "derived"}`, async () => {
        const g = await seeded();
        const named = { ...FOLD_PREFERENCE, ...(explicit === undefined ? {} : { id: explicit }) };
        const pid = explicit ?? ids.preferenceId("person:ann", "preference", "food", "food:pizza");
        if (stored !== null) await g.insert.facts({ preferences: [{ ...named, ...stored }] });
        for (let i = 0; i < 3; i++) {
          const res = await g.insert.facts({ preferences: given.map((item) => ({ ...named, ...item })) });
          expect(res.preferences.map((p) => p.id)).toEqual([pid]);
          const versions = await g.preferences.versions(pid);
          expect(versions.map((v) => [v.revision, v.strength, v.about_entity, v.properties])).toEqual(history);
        }
      });
    }
  }

  it("replays inputs that entity resolution makes one relation or preference without new revisions", async () => {
    const g = open({ resolver: "default" });
    const ada = entityId("Person", "Ada");
    const bob = entityId("Person", "Bob");
    const robert = entityId("Person", "Robert");
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Robert", aliases: ["Bob"] },
        { type: "Person", name: "Ada" },
      ],
    });
    const facts = {
      entities: [{ type: "Person", name: "Bob" }],
      relations: [
        { from_entity: ada, type: "KNOWS", to_entity: bob, properties: { w: 1 } },
        { from_entity: ada, type: "KNOWS", to_entity: robert, properties: { w: 2 } },
      ],
      preferences: [
        { subject_entity: ada, key: "contact", value_entity: bob, strength: 0.9 },
        { subject_entity: ada, key: "contact", value_entity: robert, strength: 0.2 },
      ],
    };
    const rid = ids.relationId(ada, "KNOWS", robert);
    const pid = ids.preferenceId(ada, "preference", "contact", robert);
    for (let i = 0; i < 3; i++) {
      const res = await g.insert.facts(facts);
      expect(res.relations.map((r) => r.id)).toEqual([rid]);
      expect(res.preferences.map((p) => p.id)).toEqual([pid]);
      expect((await g.relations.versions(rid)).map((v) => [v.revision, v.properties])).toEqual([[1, { w: 2 }]]);
      expect((await g.preferences.versions(pid)).map((v) => [v.revision, v.strength])).toEqual([[1, 0.2]]);
    }
  });
}

await forEachStore("repeated ids in one insert", suite);
