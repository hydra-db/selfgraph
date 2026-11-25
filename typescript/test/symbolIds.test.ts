import { expect, it } from "vitest";
import { entityId, type LLMClient } from "../src/index.js";
import { freshGraphs, KUZU_SPEC } from "./helpers.js";

const graph = freshGraphs(KUZU_SPEC, "symbol_ids");
const languages = ["C++", "C#", "C", "F#"];

it("484 keeps C++, C#, C, F# and Disney+ apart", () => {
  expect([...languages, "F", "Disney+", "Disney", "Notepad++", "Notepad"].map((n) => entityId("Language", n))).toEqual([
    "language:c-plus-plus",
    "language:c-sharp",
    "language:c",
    "language:f-sharp",
    "language:f",
    "language:disney-plus",
    "language:disney",
    "language:notepad-plus-plus",
    "language:notepad",
  ]);
});

it("484 ignores spacing, case and format characters around + and #", () => {
  expect(new Set(["C++", "c ++", "C + +", "C plus plus", "c  PLUS  Plus"].map((n) => entityId("Language", n)))).toEqual(
    new Set(["language:c-plus-plus"]),
  );
  expect(new Set(["C#", "c #", "C Sharp", "C\u200b#"].map((n) => entityId("Language", n)))).toEqual(
    new Set(["language:c-sharp"]),
  );
  expect(entityId("Service", "Disney+")).toBe(entityId("Service", "Disney Plus"));
});

it("484 spells + and # inside and around names", () => {
  expect(["A+B", "a#b", "#1", "+1", "+", "#", "++"].map((n) => entityId("Thing", n))).toEqual([
    "thing:a-plus-b",
    "thing:a-sharp-b",
    "thing:sharp-1",
    "thing:plus-1",
    "thing:plus",
    "thing:sharp",
    "thing:plus-plus",
  ]);
  expect(entityId("Company", "Google+ Inc.")).toBe("company:google-plus");
  expect(entityId("Company", "The Disney+ Co")).toBe("company:disney-plus");
  expect(entityId("Company", "AT&T")).toBe("company:at-t");
  expect(entityId("Person", "Bob \u{1f600}")).toBe("person:bob");
  expect(entityId("Thing", "\u{1f600}")).toBe("thing:\u{1f600}");
  expect(entityId("Thing", "\uff0b")).toBe("thing:\uff0b");
});

it("484 keeps each relation on its own language through insert.facts", async () => {
  const g = graph();
  await g.insert.facts({
    entities: [
      { type: "Person", name: "Ann" },
      { type: "Person", name: "Bob" },
      ...languages.map((name) => ({ type: "Language", name })),
    ],
    relations: [
      { from_entity: "person:ann", type: "USES", to_entity: entityId("Language", "C++") },
      { from_entity: "person:bob", type: "USES", to_entity: entityId("Language", "C#") },
    ],
  });
  const found = Object.fromEntries(
    (await g.entities.list({ type: "Language" })).items.map((e) => [e.id, [e.name, e.aliases]]),
  );
  expect(found).toEqual({
    "language:c-plus-plus": ["C++", []],
    "language:c-sharp": ["C#", []],
    "language:c": ["C", []],
    "language:f-sharp": ["F#", []],
  });
  const used = Object.fromEntries(
    (await g.relations.list({ type: "USES" })).items.map((r) => [r.from_entity, r.to_entity]),
  );
  expect(used).toEqual({ "person:ann": "language:c-plus-plus", "person:bob": "language:c-sharp" });
});

it("484 keeps extracted + and # names as separate entities", async () => {
  const llm: LLMClient = {
    async generate({ output }) {
      const fields = (output as unknown as { shape: Record<string, unknown> }).shape;
      const result =
        "retired" in fields
          ? { retired: [] }
          : "entities" in fields
            ? {
                entities: [
                  ...["C++", "C#", "C"].map((name) => ({ type: "Language", name, aliases: [] })),
                  ...["Ann", "Bob"].map((name) => ({ type: "Person", name, aliases: [] })),
                ],
              }
            : "relations" in fields
              ? {
                  relations: [
                    { from_name: "Ann", type: "USES", to_name: "C++", properties: {}, event_time: null },
                    { from_name: "Bob", type: "USES", to_name: "C#", properties: {}, event_time: null },
                  ],
                }
              : "preferences" in fields
                ? { preferences: [] }
                : { decisions: [] };
      return result as never;
    },
  };
  const g = graph({ llm, extraction: "llm" });
  const result = await g.insert.text("Ann uses C++ and Bob uses C#.");
  const found = Object.fromEntries(
    (await g.entities.list({ type: "Language" })).items.map((e) => [e.id, [e.name, e.aliases]]),
  );
  expect(found).toEqual({
    "language:c-plus-plus": ["C++", []],
    "language:c-sharp": ["C#", []],
    "language:c": ["C", []],
  });
  expect(Object.fromEntries(result.relations.map((r) => [r.from_entity, r.to_entity]))).toEqual({
    "person:ann": "language:c-plus-plus",
    "person:bob": "language:c-sharp",
  });
});
