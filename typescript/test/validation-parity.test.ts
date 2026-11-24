import { describe, expect, it } from "vitest";
import { HINTS } from "../src/errors.js";
import { KuzuStore, SelfGraph } from "../src/index.js";

const booleanCases = [
  [{ entities: [{ name: "T", certified: null }] }, "entities[0].certified"],
  [{ entities: [{ name: "T", properties: [{ name: "p", required: null }] }] }, "entities[0].properties[0].required"],
  [
    { entities: [{ name: "T", definitions: [{ name: "d", expression: "x", certified: null }] }] },
    "entities[0].definitions[0].certified",
  ],
  [{ relations: [{ type: "R", certified: null }] }, "relations[0].certified"],
] as const;

describe("validation parity", () => {
  it.each([
    [1e16, "1e+16"],
    [-1e-7, "-1e-07"],
    [-1e20, "-1e+20"],
  ] as const)("formats strength and confidence range errors for %s", async (value, rendered) => {
    const graph = new SelfGraph(new KuzuStore(":memory:", { buffer_pool_size: 128 << 20 }));
    try {
      await graph.initialize();
      const a = await graph.entities.create("a", "T");
      const b = await graph.entities.create("b", "T");
      const preference = await graph.preferences.create(a.id, "k", b.id);
      const relation = await graph.relations.create(a.id, "R", b.id);
      const evidence = [{ source_id: "s", confidence: value }];
      for (const call of [
        () => graph.preferences.create(a.id, "k", b.id, { strength: value }),
        () => graph.preferences.update(preference.id, { strength: value }),
        () =>
          graph.insert.facts({
            preferences: [{ subject_entity: a.id, key: "k", value_entity: b.id, strength: value }],
          }),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: "invalid_argument",
          hint: HINTS.invalid_argument,
          message: `preference strength must be between 0 and 1, got ${rendered}`,
        });
      }
      for (const call of [
        () => graph.relations.create(a.id, "R", b.id, { evidence }),
        () => graph.relations.update(relation.id, { evidence }),
        () => graph.insert.facts({ relations: [{ from_entity: a.id, type: "R", to_entity: b.id, evidence }] }),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: "invalid_argument",
          hint: HINTS.invalid_argument,
          message: `evidence confidence must be between 0 and 1, got ${rendered}`,
        });
      }
    } finally {
      await graph.close();
    }
  });

  for (const [schema, field] of booleanCases) {
    for (const value of ["false", 0, 1]) {
      it(`#376 rejects ${field}=${value}`, async () => {
        const input = JSON.parse(JSON.stringify(schema));
        let target = input.entities?.[0] ?? input.relations[0];
        target = target.properties?.[0] ?? target.definitions?.[0] ?? target;
        target[field.split(".").at(-1)!] = value;
        const store = new KuzuStore(":memory:", { buffer_pool_size: 128 << 20 });
        try {
          await store.initialize();
          expect(() => new SelfGraph(store, { schema: input })).toThrowError(
            expect.objectContaining({
              code: "invalid_argument",
              field,
              hint: HINTS.invalid_argument,
              message: `invalid schema: ${field}: expected boolean`,
            }),
          );
        } finally {
          await store.close();
        }
      });
    }
  }
  for (const offset of ["start_offset", "end_offset"]) {
    for (const value of ["2", true, false]) {
      it(`#376 rejects ${offset}=${value}`, async () => {
        const graph = new SelfGraph(new KuzuStore(":memory:", { buffer_pool_size: 128 << 20 }));
        try {
          await graph.initialize();
          const field = `relations[0].evidence[0].${offset}`;
          await expect(
            graph.insert.facts({
              entities: [
                { type: "T", name: "a" },
                { type: "T", name: "b" },
              ],
              relations: [
                { from_entity: "t:a", type: "R", to_entity: "t:b", evidence: [{ source_id: "s", [offset]: value }] },
              ],
            } as never),
          ).rejects.toMatchObject({
            code: "invalid_argument",
            field,
            hint: HINTS.invalid_argument,
            message: `invalid facts: ${field}: expected number`,
          });
        } finally {
          await graph.close();
        }
      });
    }
  }
});
