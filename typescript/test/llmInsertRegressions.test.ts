import { expect, it } from "vitest";
import { HINTS } from "../src/errors.js";
import { ExtractionError, type LLMClient } from "../src/index.js";
import { freshGraphs, KUZU_SPEC } from "./helpers.js";

const graph = freshGraphs(KUZU_SPEC, "llm_regression");
const entities = ["A", "B", "C"].map((name) => ({ type: "T", name }));
const relation = { from_entity: "t:a", type: "KNOWS", to_entity: "t:c" };

function client(
  reply: unknown,
  properties: Record<string, unknown> = {},
  extracted: unknown[] = entities.map((e) => ({ ...e, aliases: [] })),
  relations: unknown[] = [{ from_name: "A", type: "KNOWS", to_name: "C", properties, event_time: null }],
): LLMClient {
  return {
    async generate({ output }) {
      const fields = (output as unknown as { shape: Record<string, unknown> }).shape;
      const result =
        "retired" in fields
          ? reply
          : "entities" in fields
            ? { entities: extracted }
            : "relations" in fields
              ? { relations }
              : "preferences" in fields
                ? { preferences: [] }
                : { decisions: [] };
      return result as never;
    },
  };
}

it.each(["", "   "])("339 drops empty extracted property %j", async (key) => {
  const g = graph({ llm: client({}, { [key]: "bad", since: 2020 }), extraction: "llm" });
  const result = await g.insert.text("A knows C.");
  expect(result.entities).toHaveLength(3);
  expect(result.relations.map((r) => r.properties)).toEqual([{ since: 2020 }]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toMatchObject({
    code: "extraction_partial_failure",
    message: "dropped an extracted relation property: properties keys cannot be empty or whitespace",
  });
});

for (const operation of ["facts", "text", "create"]) {
  it.each([{ retired: "bad" }, { retired: [null] }])(
    `336 ${operation} rejects verdict %j before writes`,
    async (reply) => {
      const g = graph({ llm: client(reply), extraction: "llm", contradiction: "llm" });
      await g.insert.facts({ entities, relations: [{ ...relation, to_entity: "t:b" }] });
      const before = (await g.relations.list()).items;
      const write =
        operation === "text"
          ? () => g.insert.text("A knows C.", { source_id: "new-source" })
          : operation === "create"
            ? () => g.relations.create("t:a", "KNOWS", "t:c")
            : () =>
                g.insert.facts(
                  { entities: [{ type: "T", name: "D" }], relations: [relation] },
                  { source_id: "new-source" },
                );
      const error = await write().catch((error: unknown) => error);
      expect((await g.relations.list()).items).toEqual(before);
      expect(await g.entities.get("t:d")).toBeNull();
      expect(await g.store.getNode(g.namespace, "Source", "new-source")).toBeNull();
      expect(error).toMatchObject({
        name: new ExtractionError("").name,
        code: "invalid_llm_output",
        field: "retired",
        hint: HINTS.invalid_llm_output,
        message: "LLM client returned an invalid contradiction verdict",
      });
    },
  );
}

const BLANK_NAME = "dropped an extracted entity: entity name cannot be empty";
const BLANK_TYPE = "dropped an extracted entity: entity type cannot be empty";
const CONTROL_NAME = "dropped an extracted entity: entity name cannot contain control or surrogate characters";

const ann = { type: "Person", name: "Ann" };
const acme = { type: "Company", name: "Acme" };
const worksAt = { from_name: "Ann", type: "WORKS_AT", to_name: "Acme" };

it.each([
  [{ type: "Person", name: "" }, BLANK_NAME],
  [{ type: "Person", name: "   " }, BLANK_NAME],
  [{ type: "Company", name: "\t" }, BLANK_NAME],
])("333 invalid entity %j keeps the rest of the chunk typed", async (bad, message) => {
  const g = graph({ llm: client({}, {}, [ann, acme, bad], [worksAt]), extraction: "llm" });
  const result = await g.insert.text("Ann works at Acme.");
  const stored = Object.fromEntries((await g.entities.list()).items.map((e) => [e.id, e.type]));
  expect(stored).toEqual({ "person:ann": "Person", "company:acme": "Company" });
  expect(result.relations.map((r) => [r.from_entity, r.type, r.to_entity])).toEqual([
    ["person:ann", "WORKS_AT", "company:acme"],
  ]);
  expect(result.warnings.map((w) => [w.code, w.message])).toEqual([["extraction_partial_failure", message]]);
});

it.each([
  [{ type: " ", name: "Bob" }, { "thing:bob": "Thing" }, [BLANK_NAME, BLANK_TYPE]],
  [{ type: "Person", name: "Bob\u0007" }, {}, [BLANK_NAME, CONTROL_NAME, CONTROL_NAME]],
])("333 relation naming dropped entity %j follows the unknown name rule", async (bad, extra, messages) => {
  const relation = { from_name: "Ann", type: "KNOWS", to_name: bad.name };
  const g = graph({ llm: client({}, {}, [ann, { type: "Person", name: "" }, bad], [relation]), extraction: "llm" });
  const result = await g.insert.text("Ann knows Bob.");
  const stored = Object.fromEntries((await g.entities.list()).items.map((e) => [e.id, e.type]));
  expect(stored).toEqual({ "person:ann": "Person", ...extra });
  expect(result.relations.map((r) => r.to_entity)).toEqual(Object.keys(extra));
  expect(result.warnings.map((w) => w.message)).toEqual(messages);
});

it("333 chunk with only invalid entities still inserts", async () => {
  const bad = [
    { type: "Person", name: "" },
    { type: " ", name: "Ann" },
    { type: "Company", name: "  " },
    { type: "", name: "Cy" },
  ];
  const g = graph({ llm: client({}, {}, bad, [worksAt]), extraction: "llm" });
  const result = await g.insert.text("Ann works at Acme.");
  const stored = Object.fromEntries((await g.entities.list()).items.map((e) => [e.id, e.type]));
  expect(stored).toEqual({ "thing:ann": "Thing", "thing:acme": "Thing" });
  expect(result.warnings.map((w) => w.message)).toEqual([BLANK_NAME, BLANK_TYPE, BLANK_NAME, BLANK_TYPE]);
});
