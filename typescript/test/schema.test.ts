import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildGraph } from "../src/client.js";
import { toOssie } from "../src/export.js";
import { FalkorDBStore, KuzuStore, type LLMClient, SelfGraph, toNeo4jOntology, ValidationError } from "../src/index.js";
import { runStdio } from "../src/mcp.js";
import { EntityInput, Extraction, parseOrThrow } from "../src/models.js";
import { DEFAULT_SETTINGS } from "../src/runtime.js";
import { asSchema, renderSchemaCatalog, Schema, validateAgainstSchema } from "../src/schema.js";
import { suggestKey } from "../src/validate.js";
import { captureWarnings, freshGraphs, KUZU_SPEC, SINGLE_EMPLOYER, tempDir } from "./helpers.js";

const SPEC = {
  name: "test",
  entities: [
    {
      name: "Person",
      description: "a human",
      aliases: ["user"],
      properties: [
        { name: "age", type: "integer" as const, required: true },
        { name: "score", type: "float" as const },
      ],
    },
    { name: "Manager", parent: "Person" },
    { name: "Company", aliases: ["org"], properties: [{ name: "founded", type: "datetime" as const }] },
  ],
  relations: [
    { type: "WORKS_AT", from: { types: ["Person"], max_count: 1 }, to: { types: ["Company"], min_count: 1 } },
    { type: "KNOWS", aliases: ["is friends with"], from: { types: ["Person"] }, to: { types: ["Person"] } },
  ],
};

const TYPES_SPEC = {
  entities: [
    {
      name: "Thing",
      properties: [
        { name: "b", type: "boolean" as const },
        { name: "j", type: "json" as const },
        { name: "f", type: "float" as const },
        { name: "i", type: "integer" as const },
        { name: "s", type: "string" as const },
      ],
    },
  ],
};

const WRITE_SPEC = {
  entities: [
    { name: "Person", properties: [{ name: "age", type: "integer" as const, required: true }] },
    { name: "Manager", parent: "Person" },
    { name: "Company" },
  ],
  relations: [
    {
      type: "WORKS_AT",
      aliases: ["employed by"],
      from: { types: ["Person"], max_count: 1 },
      to: { types: ["Company"] },
      properties: [{ name: "since", type: "integer" as const }],
    },
  ],
};

const PERSON = { id: "person:p", type: "Person", name: "P", properties: { age: 1 } };
const COMPANY = { id: "company:c", type: "Company", name: "C" };

const check = (schema: unknown, facts: unknown) => validateAgainstSchema(Extraction.parse(facts), Schema.parse(schema));

describe("endpoint types", () => {
  it("resolve like entity types and are only checked when the schema has entities", () => {
    const schema = {
      entities: [{ name: "Person" }, { name: "Company", aliases: ["Org"] }],
      relations: [{ type: "WORKS_AT", from: { types: ["person"] }, to: { types: ["Org"] } }],
    };
    const facts = {
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
      ],
      relations: [{ from_entity: "person:ann", type: "WORKS_AT", to_entity: "company:acme" }],
    };
    expect(check(schema, facts)).toEqual([]);
    const swapped = { ...facts, relations: [{ ...facts.relations[0]!, from_entity: "company:acme" }] };
    expect(check(schema, swapped).map((w) => w.code)).toEqual(["endpoint_type_violation"]);
    const parsed = asSchema({
      entities: [
        { name: "Person", aliases: ["Human"] },
        { name: "Company", aliases: ["Org"] },
      ],
      relations: [
        { type: "WORKS_AT", from: { types: ["person"] }, to: { types: ["Company", "Org"] } },
        { type: "KNOWS", from: { types: ["Person"] }, to: { types: ["Human"] } },
      ],
    })!;
    expect(parsed.relations.map((r) => [r.from.types, r.to.types])).toEqual([
      [["Person"], ["Company"]],
      [["Person"], ["Person"]],
    ]);
    expect((toOssie(parsed).ontology as Array<{ concept: string }>).map((c) => c.concept)).toEqual([
      "Person",
      "Company",
    ]);
    expect(
      (toOssie(parsed).ontology as Array<{ relationships: Array<{ roles: unknown }> }>)[0]!.relationships[1]!.roles,
    ).toEqual([{ concept: "Person", name: "other" }]);
    expect(toNeo4jOntology(parsed).patterns).toEqual([
      ["Person", "WORKS_AT", "Company"],
      ["Person", "KNOWS", "Person"],
    ]);
    expect(Schema.parse({ relations: [{ type: "R", to: { types: ["Anything"] } }] }).entities).toEqual([]);
    expect(() => asSchema({ ...schema, entities: [...schema.entities, { name: "Team", aliases: ["org"] }] })).toThrow(
      "entities[2].aliases[0]",
    );
  });
});

describe("Schema.parse and asSchema", () => {
  it("fills defaults, keeps endpoints and aliases, and passes a parsed schema or null through", () => {
    const schema = Schema.parse(SPEC);
    expect(schema.entities[0]?.properties[0]).toEqual({
      name: "age",
      type: "integer",
      required: true,
      description: null,
    });
    expect(schema.entities[0]?.aliases).toEqual(["user"]);
    expect(schema.entities[1]?.parent).toBe("Person");
    expect(schema.relations[0]?.from).toEqual({ types: ["Person"], min_count: null, max_count: 1 });
    expect(schema.relations[1]?.to).toEqual({ types: ["Person"], min_count: null, max_count: null });
    expect(asSchema(schema)).toEqual(schema);
    expect(asSchema(SPEC)).toEqual(schema);
    expect(asSchema(null)).toBeNull();
    expect(asSchema(undefined)).toBeNull();
    const aliased = asSchema({
      entities: [
        { name: "Person", aliases: ["human"] },
        { name: "Manager", parent: "human" },
      ],
    });
    expect(aliased?.entities[1]?.parent).toBe("Person");
  });

  it.each([
    [{ entities: [{ description: "no name" }] }, "entities[0].name: field required"],
    [{ entities: [{ name: "Person" }, { name: "person" }] }, "entities[1].name: duplicate entity type 'person'"],
    [
      { entities: [{ name: "Person" }, { name: "Company", aliases: ["Person"] }] },
      "entities[1].aliases[0]: 'Person' is already a name or alias of entity type 'Person'",
    ],
    [
      { entities: [{ name: "Company", aliases: ["person"] }, { name: "Person" }] },
      "entities[0].aliases[0]: 'person' is already a name or alias of entity type 'Person'",
    ],
    [
      {
        entities: [
          { name: "Company", aliases: ["org"] },
          { name: "Team", aliases: ["Org"] },
        ],
      },
      "entities[1].aliases[0]: 'Org' is already a name or alias of entity type 'Company'",
    ],
    [
      { entities: [{ name: "Straße" }, { name: "Company", aliases: ["STRASSE"] }] },
      "entities[1].aliases[0]: 'STRASSE' is already a name or alias of entity type 'Straße'",
    ],
    [
      { relations: [{ type: "WORKS_AT" }, { type: "OWNS", aliases: ["works at"] }] },
      "relations[1].aliases[0]: 'works at' is already a name or alias of relation type 'WORKS_AT'",
    ],
    [
      { relations: [{ type: "OWNS", aliases: ["works-at"] }, { type: "WORKS_AT" }] },
      "relations[0].aliases[0]: 'works-at' is already a name or alias of relation type 'WORKS_AT'",
    ],
    [
      {
        relations: [
          { type: "OWNS", aliases: ["employed by"] },
          { type: "WORKS_AT", aliases: ["employed-by"] },
        ],
      },
      "relations[1].aliases[0]: 'employed-by' is already a name or alias of relation type 'OWNS'",
    ],
    [{ entities: [{ name: "A" }, { name: "B", parent: "X" }] }, "entities[1].parent: unknown type 'X'"],
    [
      { entities: [{ name: "A" }], relations: [{ type: "R", to: { types: ["A", "B"] } }] },
      "relations[0].to.types[1]: unknown type 'B'",
    ],
    [
      {
        entities: [
          { name: "A", parent: "B" },
          { name: "B", parent: "A" },
        ],
      },
      "entities[0].parent: parent cycle 'A' -> 'B' -> 'A'",
    ],
    [{ entities: [{ name: "A", parent: "A" }] }, "entities[0].parent: parent cycle 'A' -> 'A'"],
    [
      { relations: [{ type: "WORKS_AT" }, { type: "works at" }] },
      "relations[1].type: duplicate relation type 'works at'",
    ],
    [{ relations: [{ type: "R", from: { max_count: 0 } }] }, "relations[0].from.max_count: must be >= 1"],
    [{ relations: [{ type: "R", to: { min_count: -1 } }] }, "relations[0].to.min_count: must be >= 0"],
    [{ relations: [{ type: "R", from: { max_count: 1.5 } }] }, "relations[0].from.max_count: expected integer"],
    [
      { relations: [{ type: "R", from: { max_count: 2 ** 53 } }] },
      "relations[0].from.max_count: must be <= 9007199254740991",
    ],
    [{ relations: [{ type: "R", to: { min_count: 1e20 } }] }, "relations[0].to.min_count: must be <= 9007199254740991"],
    [
      { relations: [{ type: "R", from: { min_count: 2, max_count: 1 } }] },
      "relations[0].from.min_count: min_count 2 is greater than max_count 1",
    ],
  ])("rejects %j", (spec, message) => {
    expect(() => asSchema(spec as Schema)).toThrow(new ValidationError(`invalid schema: ${message}`));
  });

  it.each([
    [
      { relations: [{ type: "R", from: { max_count: -(2 ** 53) } }] },
      ["relations[0].from.max_count: must be >= -9007199254740991", "relations[0].from.max_count: must be >= 1"],
    ],
    [
      { relations: [{ type: "R", to: { min_count: -1e20 } }] },
      ["relations[0].to.min_count: must be >= -9007199254740991", "relations[0].to.min_count: must be >= 0"],
    ],
    [
      { relations: [{ type: "R", from: { min_count: 2 ** 53, max_count: 5 } }] },
      [
        "relations[0].from.min_count: must be <= 9007199254740991",
        "relations[0].from.min_count: min_count 9007199254740992 is greater than max_count 5",
      ],
    ],
    [
      { relations: [{ type: "R", from: { min_count: 1e21, max_count: 5 } }] },
      [
        "relations[0].from.min_count: must be <= 9007199254740991",
        "relations[0].from.min_count: min_count 1e+21 is greater than max_count 5",
      ],
    ],
    [
      { relations: [{ type: "R", from: { min_count: 1e20 + 16384, max_count: 5 } }] },
      [
        "relations[0].from.min_count: must be <= 9007199254740991",
        "relations[0].from.min_count: min_count 100000000000000020000 is greater than max_count 5",
      ],
    ],
  ])("reports an unsafe count and then the first consistency problem for %j", (spec, lines) => {
    const message = `invalid schema:${lines.map((line) => `\n  ${line}`).join("")}`;
    expect(() => asSchema(spec as Schema)).toThrow(new ValidationError(message));
  });

  it("lets an alias repeat its own type name", () => {
    const schema = asSchema({
      entities: [
        { name: "Person", aliases: ["person", "Human", "human"] },
        { name: "Company", aliases: ["org"] },
      ],
    });
    expect(schema?.entities.map((e) => e.aliases)).toEqual([["person", "Human", "human"], ["org"]]);
    const relation = asSchema({ relations: [{ type: "WORKS_AT", aliases: ["works at", "works-at"] }] });
    expect(relation?.relations[0]?.aliases).toEqual(["works at", "works-at"]);
  });

  it("stores a parent as the schema type name", () => {
    const parents = (spec: Schema) => asSchema(spec)?.entities.map((entity) => entity.parent);
    const stored = [null, "Person"];
    expect(parents({ entities: [{ name: "Person" }, { name: "Manager", parent: "person" }] })).toEqual(stored);
    expect(
      parents({
        entities: [
          { name: "Person", aliases: ["Human"] },
          { name: "Manager", parent: "human" },
        ],
      }),
    ).toEqual(stored);
    expect(
      parents({
        entities: [
          { name: "Person", aliases: ["Human"] },
          { name: "Manager", parent: "HUMAN" },
        ],
      }),
    ).toEqual(stored);
    expect(parents({ entities: [{ name: "Person" }, { name: "Manager", parent: "Person" }] })).toEqual(stored);
    expect(
      parents({
        entities: [
          { name: "Person", aliases: ["Human"] },
          { name: "Manager", parent: "Human" },
        ],
      }),
    ).toEqual(stored);
    expect(() => asSchema({ entities: [{ name: "Person" }, { name: "Manager", parent: "X" }] })).toThrow(
      "entities[1].parent: unknown type 'X'",
    );
    expect(() =>
      asSchema({
        entities: [
          { name: "A", parent: "b" },
          { name: "B", parent: "a" },
        ],
      }),
    ).toThrow("entities[0].parent: parent cycle 'A' -> 'B' -> 'A'");
    expect(() => asSchema({ entities: [{ name: "A", parent: "a" }] })).toThrow(
      "entities[0].parent: parent cycle 'A' -> 'A'",
    );
    const spec = {
      entities: [
        { name: "Person", properties: [{ name: "age", type: "integer" as const, required: true }] },
        { name: "Manager", parent: "person" },
      ],
    };
    const schema = asSchema(spec);
    expect((toOssie(schema!).ontology as { extends?: string[] }[])[1]).toMatchObject({ extends: ["Person"] });
    expect(check(spec, { entities: [{ type: "Manager", name: "M" }] }).map((w) => w.message)).toEqual([
      "entity manager:m is missing required property 'age'",
    ]);
  });
});

describe("validateAgainstSchema", () => {
  it.each([
    [
      "clean facts resolved through aliases and parent types",
      SPEC,
      {
        entities: [
          { id: "manager:m", type: "Manager", name: "M", properties: { age: 30 } },
          { id: "org:o", type: "org", name: "O" },
        ],
        relations: [{ from_entity: "manager:m", type: "works at", to_entity: "org:o" }],
      },
      [],
    ],
    [
      "a schema with nothing to check against",
      {},
      {
        entities: [{ id: "thing:x", type: "Whatever", name: "X" }],
        relations: [{ from_entity: "thing:x", type: "ANYTHING", to_entity: "thing:x" }],
      },
      [],
    ],
    [
      "an endpoint whose types are unrestricted",
      { entities: [{ name: "Person" }, { name: "Company" }], relations: [{ type: "RELATES_TO" }] },
      {
        entities: [PERSON, COMPANY],
        relations: [{ from_entity: "person:p", type: "RELATES_TO", to_entity: "company:c" }],
      },
      [],
    ],
    [
      "valid property values, an int for a float, and null",
      TYPES_SPEC,
      {
        entities: [
          { id: "thing:a", type: "Thing", name: "A", properties: { b: true, j: { x: [1, 2] }, f: 3, i: 7, s: "hi" } },
          { id: "thing:b", type: "Thing", name: "B", properties: { b: null, i: null } },
        ],
      },
      [],
    ],
    [
      "wrong property types and a boolean given as an integer",
      TYPES_SPEC,
      {
        entities: [
          { id: "thing:x", type: "Thing", name: "X", properties: { b: "yes", f: "big", i: true, s: 5, j: 42 } },
        ],
      },
      Array(4).fill("property_type_mismatch"),
    ],
    [
      "a missing required property and a type mismatch in order",
      SPEC,
      {
        entities: [
          { ...PERSON, properties: { score: "high" } },
          { ...COMPANY, properties: { founded: 5 } },
        ],
      },
      ["missing_required_property", "property_type_mismatch", "property_type_mismatch"],
    ],
    [
      "an unknown relation type",
      SPEC,
      { entities: [PERSON], relations: [{ from_entity: "person:p", type: "LIKES", to_entity: "person:p" }] },
      ["unknown_relation_type"],
    ],
    [
      "an endpoint whose type is not allowed",
      SPEC,
      { entities: [COMPANY], relations: [{ from_entity: "company:c", type: "WORKS_AT", to_entity: "company:c" }] },
      ["endpoint_type_violation"],
    ],
    [
      "cardinality above the endpoint max per insert",
      SPEC,
      {
        entities: [PERSON, COMPANY],
        relations: [
          { id: "relation:a", from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" },
          { id: "relation:b", from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" },
        ],
      },
      ["cardinality_violation"],
    ],
  ])("gives the codes for %s", (_, schema, facts, expected) => {
    expect(check(schema, facts).map((w) => w.code)).toEqual(expected);
  });

  it("uses canonical ids and words messages for inheritance, aliases, and min counts", () => {
    const [unknown, ...rest] = check(SPEC, {
      entities: [
        { type: "Alien", name: "Z" },
        { type: "Person", name: "A" },
      ],
    });
    expect(unknown).toEqual({
      code: "unknown_entity_type",
      message: "entity alien:z has unknown type 'Alien'",
      source_id: null,
      chunk_id: null,
      merge_id: null,
    });
    expect(rest.map((w) => w.message)).toEqual(["entity person:a is missing required property 'age'"]);
    expect(check(WRITE_SPEC, { entities: [{ id: "manager:m", type: "Manager", name: "M" }] })).toMatchObject([
      { message: "entity manager:m is missing required property 'age'" },
    ]);
    const twoEmployers = check(WRITE_SPEC, {
      entities: [
        PERSON,
        { id: "company:a", type: "Company", name: "A" },
        { id: "company:b", type: "Company", name: "B" },
      ],
      relations: [
        { from_entity: "person:p", type: "WORKS_AT", to_entity: "company:a" },
        { from_entity: "person:p", type: "employed by", to_entity: "company:b" },
      ],
    });
    expect(twoEmployers.map((w) => w.message)).toEqual(["person:p has 2 WORKS_AT (from) in this insert, above max 1"]);
    const below = check(
      {
        entities: [{ name: "Person" }, { name: "Company" }],
        relations: [{ type: "WORKS_AT", from: { types: ["Person"], min_count: 2 }, to: { types: ["Company"] } }],
      },
      {
        entities: [PERSON, COMPANY],
        relations: [{ from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" }],
      },
    );
    expect(below).toMatchObject([{ code: "cardinality_violation", message: expect.stringContaining("below min 2") }]);
  });

  it("checks datetime properties as ISO 8601", () => {
    const spec = { entities: [{ name: "Event", properties: [{ name: "at", type: "datetime" }] }] };
    const codes = (value: unknown) =>
      check(spec, { entities: [{ type: "Event", name: "E", properties: { at: value } }] }).map((w) => w.code);
    expect(["2024-01-02", "2024-01-02T03:04:05Z", "2024-01-02T03:04:05+05:30"].map(codes)).toEqual([[], [], []]);
    expect(["yesterday", "", "2024-13-01", 5].map(codes)).toEqual(Array(4).fill(["property_type_mismatch"]));
  });

  it("checks only own properties, so names like constructor are not always present", () => {
    const spec = {
      entities: [
        {
          name: "Car",
          properties: [
            { name: "constructor", type: "string" },
            { name: "toString", type: "string", required: true },
          ],
        },
      ],
    };
    const codes = (properties: Record<string, unknown>) =>
      check(spec, { entities: [{ type: "Car", name: "C", properties }] }).map((w) => w.code);
    expect(codes({ toString: "x" })).toEqual([]);
    expect(codes({ constructor: "Ferrari", toString: "x" })).toEqual([]);
    expect(codes({})).toEqual(["missing_required_property"]);
  });
});

describe("distinct relation cardinality", () => {
  it.each([
    { name: "one repeated ID counts once", relationIds: ["relation:a", "relation:a"], count: 1 },
    { name: "two different IDs count twice", relationIds: ["relation:a", "relation:b"], count: 2 },
  ])("$name", ({ relationIds, count }) => {
    const schema = {
      relations: [{ type: "WORKS_AT", from: { max_count: 1 }, to: { max_count: 1 } }],
    };
    const facts = {
      relations: relationIds.map((id) => ({ id, from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" })),
    };
    const found = check(schema, facts);
    expect(found.map((w) => w.code)).toEqual(count === 1 ? [] : ["cardinality_violation", "cardinality_violation"]);
    expect(found.map((w) => w.message)).toEqual(
      count === 1
        ? []
        : [
            "person:p has 2 WORKS_AT (from) in this insert, above max 1",
            "company:c has 2 WORKS_AT (to) in this insert, above max 1",
          ],
    );
  });
});

describe("renderSchemaCatalog", () => {
  it("lists entities with aliases and relations with endpoints, and nothing for an empty schema", () => {
    const [entities, relations] = renderSchemaCatalog(Schema.parse(SPEC));
    expect(entities).toBe(
      "Extract entities using these known types where they fit:\n" +
        "- Person: a human. aliases: user\n" +
        "- Manager: no description\n" +
        "- Company: no description. aliases: org",
    );
    expect(relations).toBe("Known relationship types:\n- WORKS_AT (Person -> Company)\n- KNOWS (Person -> Person)");
    expect(renderSchemaCatalog(Schema.parse({}))).toEqual(["", ""]);
  });
});

describe("schema through the client", () => {
  const dir = tempDir("selfgraph-schema-");
  const schema = {
    entities: [{ name: "Person", properties: [{ name: "age", type: "integer" as const, required: true }] }],
  };
  const facts = { entities: [{ id: "person:p", type: "Person", name: "P" }] };
  const open = freshGraphs(KUZU_SPEC, "schema");

  it("exposes a graph-level schema, rejects violations in strict mode, and lets a per-insert mode override it", async () => {
    const graph = open({ schema });
    expect(graph.schema?.entities[0]?.name).toBe("Person");
    expect((await graph.insert.facts(facts)).warnings.map((w) => w.code)).toEqual(["missing_required_property"]);
    expect((await graph.insert.facts(facts, { schema_mode: "off" })).warnings).toEqual([]);
    await expect(open({ schema, schema_mode: "strict" }).insert.facts(facts)).rejects.toBeInstanceOf(ValidationError);
  });

  it("stores an entity without an optional constructor property in strict mode", async () => {
    const cars = { entities: [{ name: "Car", properties: [{ name: "constructor", type: "string" as const }] }] };
    const graph = open({ schema: cars, schema_mode: "strict" });
    const result = await graph.insert.facts({ entities: [{ type: "Car", name: "SF-24", properties: { year: 2024 } }] });
    expect(result.warnings).toEqual([]);
    expect((await graph.entities.get("car:sf-24"))?.properties).toEqual({ year: 2024 });
  });

  it("injects the schema catalog into the extraction prompt", async () => {
    const prompts: string[] = [];
    const recorder: LLMClient = {
      async generate({ system, user, output }) {
        prompts.push(system + user);
        return output.parse({ entities: [], relations: [], preferences: [], decisions: [] });
      },
    };
    await open({ llm: recorder, schema: SPEC }).insert.text("Jane manages Acme.");
    const joined = prompts.join("\n");
    expect(joined).toContain("Extract entities using these known types");
    expect(joined).toContain("Known relationship types:");
  });

  it("rejects a bad schema mode and strict mode without a schema everywhere", async () => {
    const memory = (options: object) => () => new SelfGraph(new KuzuStore(":memory:"), options);
    expect(memory({ schema_mode: "loud" })).toThrow(/schema_mode/);
    await expect(open().insert.facts({ entities: [] }, { schema: SPEC, schema_mode: "loud" as never })).rejects.toThrow(
      /schema_mode/,
    );
    const message = /^schema_mode 'strict' needs a schema$/;
    expect(memory({ schema_mode: "strict" })).toThrow(message);
    await expect(open().insert.facts({ entities: [] }, { schema_mode: "strict" })).rejects.toThrow(message);
    await expect(open().insert.text("Jane met Bob.", { schema_mode: "strict" })).rejects.toThrow(message);
    await expect(runStdio({ ...DEFAULT_SETTINGS, store: "kuzu", schema_mode: "strict" })).rejects.toThrow(message);
  });

  it("loads the schema setting from a file or an object", async () => {
    const file = join(dir, "schema.json");
    writeFileSync(file, JSON.stringify(SPEC));
    const settings = { ...DEFAULT_SETTINGS, store: "kuzu", uri: join(dir, "e.kuzu"), schema_mode: "strict" };
    const fromFile = buildGraph({ ...settings, schema: file });
    try {
      expect(fromFile.schema).toEqual(Schema.parse(SPEC));
      await expect(fromFile.insert.facts({ entities: [{ type: "Robot", name: "R2" }] })).rejects.toBeInstanceOf(
        ValidationError,
      );
    } finally {
      await fromFile.close();
      await KuzuStore.closeDatabase(settings.uri);
    }
    expect(buildGraph({ ...settings, uri: ":memory:", schema: SPEC }).schema).toEqual(Schema.parse(SPEC));
    expect(() => buildGraph({ ...settings, schema: join(dir, "missing.json") })).toThrow(/cannot read/);
  });

  it("checks the endpoint types of stored entities, including undeclared types, on insert and create", async () => {
    const graph = open({ schema: WRITE_SPEC });
    await graph.entities.create("Acme", "Company");
    const result = await graph.insert.facts({
      entities: [{ type: "Company", name: "Beta" }],
      relations: [{ from_entity: "company:acme", type: "WORKS_AT", to_entity: "company:beta" }],
    });
    expect(result.warnings.map((w) => w.message)).toEqual([
      "relation company:acme -WORKS_AT-> company:beta from entity company:acme is not one of ['Person']",
    ]);
    const entities = [PERSON, { id: "tool:t", type: "Tool", name: "T" }];
    const toTool = { entities, relations: [{ from_entity: "person:p", type: "WORKS_AT", to_entity: "tool:t" }] };
    expect(check(WRITE_SPEC, toTool).at(-1)?.message).toBe(
      "relation person:p -WORKS_AT-> tool:t to entity tool:t is not one of ['Company']",
    );
    const strict = open({ schema: WRITE_SPEC, schema_mode: "strict" });
    await strict.insert.facts({ entities }, { schema_mode: "off" });
    await expect(strict.relations.create("person:p", "WORKS_AT", "tool:t")).rejects.toThrow(
      "to entity tool:t is not one of ['Company']",
    );
  });

  it("rejects entity and relation writes in strict mode before writing, ahead of a conflict", async () => {
    const graph = open({ schema: WRITE_SPEC, schema_mode: "strict" });
    await expect(graph.entities.create("R2", "Robot")).rejects.toThrow(/^entity robot:r2 has unknown type 'Robot'$/);
    expect(await graph.entities.get("robot:r2")).toBeNull();
    await expect(graph.entities.create("Jane", "Person")).rejects.toThrow(
      /^entity person:jane is missing required property 'age'$/,
    );
    await expect(graph.entities.create("Jane", "Person", { properties: { age: "old" } })).rejects.toThrow(
      /property 'age' should be integer/,
    );
    const jane = await graph.entities.create("Jane", "Person", { properties: { age: 30 } });
    await expect(graph.entities.update(jane.id, { remove_properties: ["age"] })).rejects.toThrow(
      /^entity person:jane is missing required property 'age'$/,
    );
    expect((await graph.entities.get(jane.id))?.properties).toEqual({ age: 30 });
    await expect(graph.entities.create("Jane", "Person")).rejects.toThrow("missing required property 'age'");
    await graph.entities.create("Acme", "Company");
    await expect(graph.relations.create("company:acme", "WORKS_AT", "person:jane")).rejects.toThrow(
      "from entity company:acme is not one of ['Person']",
    );
    await expect(graph.relations.create("person:jane", "LIKES", "company:acme")).rejects.toThrow(
      "has unknown type 'LIKES'",
    );
    expect((await graph.relations.list()).items).toEqual([]);
    const rel = await graph.relations.create("person:jane", "employed by", "company:acme", {
      properties: { since: 2020 },
    });
    await expect(graph.relations.update(rel.id, { set_properties: { since: "2020" } })).rejects.toThrow(
      `relation ${rel.id} property 'since' should be integer`,
    );
    expect((await graph.relations.versions(rel.id)).map((r) => r.revision)).toEqual([1]);
    await expect(
      graph.relations.create("person:jane", "WORKS_AT", "company:acme", { id: rel.id, properties: { since: "x" } }),
    ).rejects.toThrow(new RegExp(`^relation ${rel.id} property 'since' should be integer$`));
  });

  it("warns on stderr for each violation in warn mode and skips write checks in off mode", async () => {
    const { warnings } = await captureWarnings(async () => {
      const graph = open({ schema: WRITE_SPEC });
      await graph.entities.create("R2", "Robot");
      await graph.entities.update("robot:r2", { properties: { x: 1 } });
      await graph.relations.create("robot:r2", "WORKS_AT", "robot:r2");
      expect((await graph.entities.get("robot:r2"))?.properties).toEqual({ x: 1 });
    });
    expect(warnings).toEqual([
      "selfgraph: schema warning [unknown_entity_type]: entity robot:r2 has unknown type 'Robot'",
      "selfgraph: schema warning [endpoint_type_violation]: relation robot:r2 -WORKS_AT-> robot:r2 from entity robot:r2 is not one of ['Person']",
      "selfgraph: schema warning [endpoint_type_violation]: relation robot:r2 -WORKS_AT-> robot:r2 to entity robot:r2 is not one of ['Company']",
    ]);
    const off = await captureWarnings(async () => {
      const graph = open({ schema: WRITE_SPEC, schema_mode: "off" });
      await graph.entities.create("R2", "Robot");
      await graph.entities.update("robot:r2", { type: "ROBOT" });
      expect((await graph.entities.get("robot:r2"))?.type).toBe("Robot");
    });
    expect(off.warnings).toEqual([]);
  });

  it("fails or warns on an update only for violations it introduces", async () => {
    const plain = open();
    await plain.entities.create("Jane", "Person", { properties: { nick: "J" } });
    await plain.entities.create("Acme", "Company");
    const rel = await plain.relations.create("person:jane", "WORKS_AT", "company:acme", {
      properties: { since: "2020" },
    });
    const strict = open({ namespace: plain.namespace, schema: WRITE_SPEC, schema_mode: "strict" });
    const renamed = await strict.entities.update("person:jane", { name: "Janet", remove_properties: ["nick"] });
    expect([renamed.name, renamed.properties]).toEqual(["Janet", {}]);
    expect((await strict.relations.update(rel.id, { set_properties: { note: "x" } })).revision).toBe(2);
    await expect(strict.entities.update("person:jane", { properties: { age: "old" } })).rejects.toThrow(
      /^entity person:jane property 'age' should be integer$/,
    );
    const { warnings } = await captureWarnings(async () => {
      const warn = open({ namespace: plain.namespace, schema: WRITE_SPEC });
      await warn.entities.update("person:jane", { properties: { x: 1 } });
      await warn.entities.update("person:jane", { properties: { age: "old" } });
    });
    expect(warnings).toEqual([
      "selfgraph: schema warning [property_type_mismatch]: entity person:jane property 'age' should be integer",
    ]);
  });

  it("drops off-schema extractions on a strict text insert but rejects them on facts insert", async () => {
    const extracted = {
      entities: [
        { type: "Person", name: "Soham", aliases: null },
        { type: "Company", name: "HydraDB", aliases: null },
        { type: "Thing", name: "Team", aliases: null },
      ],
      relations: [
        { from_name: "Soham", type: "WORKS_AT", to_name: "HydraDB", event_time: null },
        { from_name: "Team", type: "SELECTED", to_name: "HydraDB", event_time: null },
      ],
      preferences: [],
      decisions: [],
    };
    const llm: LLMClient = { generate: async ({ output }) => output.parse(extracted) };
    const graph = open({ llm, schema: SINGLE_EMPLOYER, schema_mode: "strict" });
    const res = await graph.insert.text("Soham works at HydraDB. The team selected it.");
    expect(res.entities.map((e) => e.id).sort()).toEqual(["company:hydradb", "person:soham"]);
    expect(res.relations.map((r) => r.type)).toEqual(["WORKS_AT"]);
    const dropped = res.warnings.filter((w) => w.code === "dropped_off_schema").map((w) => w.message);
    expect(dropped[0]).toBe("dropped extracted entity thing:team: entity thing:team has unknown type 'Thing'");
    expect(dropped.some((m) => m.includes("relation") && m.includes("thing:team was dropped"))).toBe(true);
    await expect(graph.insert.facts({ entities: [{ type: "Team", name: "Core" }] })).rejects.toThrow(
      "unknown type 'Team'",
    );

    const agedSchema: Schema = {
      entities: [
        { name: "Person", properties: [{ name: "age", type: "integer", required: true }] },
        { name: "Company" },
      ],
      relations: [{ type: "WORKS_AT", from: { types: ["Person"] }, to: { types: ["Company"] } }],
    };
    const agedGraph = open({ llm, schema: agedSchema, schema_mode: "strict" });
    await agedGraph.insert.facts({
      entities: [{ type: "Person", name: "Soham Gupta", aliases: ["Soham"], properties: { age: 28 } }],
    });
    const agedRes = await agedGraph.insert.text("Soham works at HydraDB. The team selected it.");
    expect(agedRes.entities.map((e) => e.id).sort()).toEqual(["company:hydradb", "person:soham-gupta"]);
    expect(agedRes.relations.map((r) => [r.from_entity, r.type])).toEqual([["person:soham-gupta", "WORKS_AT"]]);
    expect(agedRes.merges.map((m) => m.survivor_id)).toEqual(["person:soham-gupta"]);
    expect((await agedGraph.entities.get("person:soham-gupta"))?.properties).toEqual({ age: 28 });
  });

  it("checks merged properties on insert and treats null as missing for required specs", async () => {
    const spec: Schema = {
      entities: [
        { name: "Person", properties: [{ name: "age", type: "integer", required: true }] },
        { name: "Company", properties: [{ name: "note", type: "string" }] },
      ],
      relations: [
        {
          type: "WORKS_AT",
          from: { types: ["Person"] },
          to: { types: ["Company"] },
          properties: [{ name: "since", type: "integer", required: true }],
        },
        {
          type: "KNOWS",
          from: { types: ["Person"] },
          to: { types: ["Person"] },
          properties: [{ name: "since", type: "integer", required: true }],
        },
      ],
    };
    const parsed = Schema.parse(spec);
    expect(
      validateAgainstSchema(
        Extraction.parse({ entities: [{ type: "Person", name: "Jane", properties: { age: null } }] }),
        parsed,
      ).map((w) => w.code),
    ).toEqual(["missing_required_property"]);
    expect(
      validateAgainstSchema(
        Extraction.parse({ entities: [{ type: "Company", name: "Acme", properties: { note: null } }] }),
        parsed,
      ),
    ).toEqual([]);

    const strict = open({ schema: spec, schema_mode: "strict" });
    await expect(
      strict.insert.facts({ entities: [{ type: "Person", name: "Ghost", properties: { age: null } }] }),
    ).rejects.toThrow(/^entity person:ghost is missing required property 'age'$/);
    expect(await strict.entities.get("person:ghost")).toBeNull();

    const seeded = await strict.insert.facts({
      entities: [
        { type: "Person", name: "Jane", properties: { city: "NYC" } },
        { type: "Person", name: "Jane", properties: { age: 30 } },
        { type: "Company", name: "Acme" },
      ],
      relations: [
        {
          from_entity: "person:jane",
          type: "WORKS_AT",
          to_entity: "company:acme",
          properties: { since: 2020 },
        },
      ],
    });
    expect(seeded.warnings).toEqual([]);

    const extended = await strict.insert.facts({
      entities: [{ type: "Person", name: "Jane", properties: { city: "SF" } }],
      relations: [
        {
          from_entity: "person:jane",
          type: "WORKS_AT",
          to_entity: "company:acme",
          properties: { role: "CTO" },
        },
      ],
    });
    expect(extended.warnings).toEqual([]);
    expect((await strict.entities.get("person:jane"))?.properties).toEqual({ age: 30, city: "SF" });
    const [rel] = (await strict.relations.list({ from_entity: "person:jane" })).items;
    expect(rel?.properties).toEqual({ since: 2020, role: "CTO" });

    const warn = open({ namespace: strict.namespace, schema: spec, schema_mode: "warn" });
    expect(
      (
        await warn.insert.facts({
          entities: [{ type: "Person", name: "Jane" }],
          relations: [{ from_entity: "person:jane", type: "WORKS_AT", to_entity: "company:acme" }],
        })
      ).warnings,
    ).toEqual([]);

    await expect(
      strict.insert.facts({ entities: [{ type: "Person", name: "Jane", properties: { age: null } }] }),
    ).rejects.toThrow(/^entity person:jane is missing required property 'age'$/);
    await expect(
      strict.insert.facts({
        relations: [
          {
            from_entity: "person:jane",
            type: "WORKS_AT",
            to_entity: "company:acme",
            properties: { since: null },
          },
        ],
      }),
    ).rejects.toThrow("missing required property 'since'");
    expect((await strict.entities.get("person:jane"))?.properties).toEqual({ age: 30, city: "SF" });
    expect((await strict.relations.get(rel!.id))?.properties).toEqual({ since: 2020, role: "CTO" });

    const foldedRel = await strict.insert.facts({
      entities: [{ type: "Person", name: "Jane Doe", aliases: ["Janie"], properties: { age: 35 } }],
      relations: [
        {
          from_entity: "person:jane",
          type: "KNOWS",
          to_entity: "person:jane-doe",
          properties: { role: "mentor" },
        },
        {
          from_entity: "person:jane",
          type: "KNOWS",
          to_entity: "person:jane-doe",
          properties: { since: 2021 },
        },
      ],
    });
    expect(foldedRel.warnings).toEqual([]);
    expect(foldedRel.relations[0]?.properties).toEqual({ role: "mentor", since: 2021 });

    const resolvedRes = await strict.insert.facts({
      entities: [{ type: "Person", name: "Janie" }],
      relations: [
        {
          from_entity: "person:janie",
          type: "WORKS_AT",
          to_entity: "company:acme",
          properties: { since: 2022 },
        },
      ],
    });
    expect(resolvedRes.merges.map((m) => m.survivor_id)).toEqual(["person:jane-doe"]);
    expect(resolvedRes.relations.map((r) => r.from_entity)).toEqual(["person:jane-doe"]);
  });
});

describe("unknown keys and options", () => {
  const open = freshGraphs(KUZU_SPEC, "opts");

  it("rejects them on every input and options bag with the location and a close suggestion", async () => {
    const g = open();
    const cases: Array<[() => unknown, string]> = [
      [
        () => parseOrThrow(Extraction, { entites: [] }, "facts"),
        "unknown key 'entites' in facts; did you mean 'entities'?",
      ],
      [
        () => parseOrThrow(Extraction, { entities: [{ type: "Person", nmae: "Jane" }] }, "facts"),
        "unknown key 'nmae' in facts.entities[0]; did you mean 'name'?",
      ],
      [
        () =>
          parseOrThrow(
            Extraction,
            {
              relations: [{ from_entity: "a", type: "X", to_entity: "b", evidence: [{ source_id: "s", qoute: "q" }] }],
            },
            "facts",
          ),
        "unknown key 'qoute' in facts.relations[0].evidence[0]; did you mean 'quote'?",
      ],
      [() => asSchema({ entity_types: [] } as never), "unknown key 'entity_types' in schema; did you mean 'entities'?"],
      [() => asSchema({ edges: [] } as never), "unknown key 'edges' in schema; did you mean 'relations'?"],
      [
        () => asSchema({ relations: [{ type: "X", from: { type: ["A"] } }] } as never),
        "unknown key 'type' in schema.relations[0].from; did you mean 'types'?",
      ],
      [
        () => new SelfGraph(new KuzuStore(":memory:"), { instructions: { entites: "x" } as never }),
        "unknown key 'entites' in instructions; did you mean 'entities'?",
      ],
      [
        () =>
          new SelfGraph(new KuzuStore(":memory:"), {
            prompts: { entities: { system: "s", user: "{text}", versoin: "1" } } as never,
          }),
        "unknown key 'versoin' in prompts.entities; did you mean 'version'?",
      ],
      [() => parseOrThrow(EntityInput, { type: "T", name: "n", zz: 1 }, "entity"), "unknown key 'zz' in entity"],
      [
        () => new SelfGraph(new KuzuStore(":memory:"), { namespce: "x" } as never),
        "unknown option 'namespce' for SelfGraph; did you mean 'namespace'?",
      ],
      [
        () => new KuzuStore(":memory:", { max_db_sise: 1 } as never),
        "unknown option 'max_db_sise' for KuzuStore; did you mean 'max_db_size'?",
      ],
      [
        () => new FalkorDBStore("localhost", 6379, { graphName: "g" } as never),
        "unknown option 'graphName' for FalkorDBStore; did you mean 'graph'?",
      ],
      [
        () => g.retrieve("x", { stratgy: "bfs" } as never),
        "unknown option 'stratgy' for retrieve; did you mean 'strategy'?",
      ],
      [
        () => g.insert.facts({}, { sourse_id: "s" } as never),
        "unknown option 'sourse_id' for insert.facts; did you mean 'source_id'?",
      ],
      [() => g.entities.create("A", "T", { evidence: [] } as never), "unknown option 'evidence' for entities.create"],
      [() => g.entities.list({ limt: 5 } as never), "unknown option 'limt' for entities.list; did you mean 'limit'?"],
      [
        () => g.entities.update("t:a", { nmae: "B" } as never),
        "unknown option 'nmae' for entities.update; did you mean 'name'?",
      ],
      [() => g.maintenance.prune({ apply: true } as never), "unknown option 'apply' for maintenance.prune"],
      [
        () => g.insert.text("Jane met Bob.", { instructions: { relatoins: "x" } as never }),
        "unknown key 'relatoins' in instructions; did you mean 'relations'?",
      ],
      [() => g.maintenance.prune({ min_relevance: -1 }), "min_relevance must be between 0 and 1, got -1"],
    ];
    for (const [call, message] of cases) {
      const error = await Promise.resolve()
        .then(call)
        .catch((exc: unknown) => exc);
      expect(error, message).toBeInstanceOf(ValidationError);
      expect((error as Error).message.split(" (valid keys: ")[0]).toContain(message);
    }
    expect(() => parseOrThrow(Extraction, { entities: [{ type: "Person", nmae: "Jane" }] }, "facts")).toThrow(
      "(valid keys: id, type, name, aliases, external_ids, properties)",
    );
    expect(() => parseOrThrow(Extraction, { entities: [{ type: "P", name: 3 }, { type: "P" }] }, "facts")).toThrow(
      "invalid facts:\n  entities[0].name: expected string\n  entities[1].name: field required",
    );
    const d = await g.decisions.create("D", { steps: [] });
    expect(d.steps).toEqual([]);
    expect((await g.decisions.create("No steps")).steps).toEqual([]);
    expect((await g.maintenance.decay()).dry_run).toBe(true);
    await g.insert.facts({
      entities: [
        { type: "Person", name: "Ann" },
        { type: "Company", name: "Acme" },
      ],
    });
    const rel = await g.relations.create("person:ann", "WORKS_AT", "company:acme", {
      properties: { role: "lead", r: "keep_r" },
    });
    const pref = await g.preferences.create("person:ann", "employer", "company:acme", {
      properties: { role: "lead", r: "keep_r" },
    });
    const listCases: Array<[() => Promise<unknown>, string]> = [
      [
        () => g.relations.update(rel.id, { remove_properties: "role" as never }),
        "remove_properties must be a list of strings, got string",
      ],
      [
        () => g.relations.update(rel.id, { remove_properties: null as never }),
        "remove_properties must be a list of strings, got null",
      ],
      [
        () => g.preferences.update(pref.id, { remove_properties: "role" as never }),
        "remove_properties must be a list of strings, got string",
      ],
      [
        () => g.decisions.create("Bad steps", { steps: "relation:x" as never }),
        "decision steps must be a list of strings, got string",
      ],
      [
        () => g.decisions.create("Bad alts", { alternative_entities: "person:ann" as never }),
        "alternative_entities must be a list of strings, got string",
      ],
      [
        () => g.decisions.update(d.id, { steps: "relation:x" as never }),
        "decision steps must be a list of strings, got string",
      ],
      [() => g.decisions.update(d.id, { steps: null as never }), "decision steps must be a list of strings, got null"],
      [
        () => g.decisions.update(d.id, { alternative_entities: null as never }),
        "alternative_entities must be a list of strings, got null",
      ],
    ];
    for (const [call, message] of listCases) {
      await expect(call()).rejects.toThrow(new ValidationError(message));
    }
    expect((await g.relations.get(rel.id))?.properties).toEqual({ role: "lead", r: "keep_r" });
    expect((await g.preferences.get(pref.id))?.properties).toEqual({ role: "lead", r: "keep_r" });
  });

  it("suggests within edit distance two and breaks ties by declared order", () => {
    expect(suggestKey("nmae", ["id", "type", "name"])).toBe("name");
    expect(suggestKey("ab", ["ax", "ay"])).toBe("ax");
    expect(suggestKey("x", ["id"])).toBeNull();
    expect(suggestKey("entity_types", ["name", "version", "entities", "relations"])).toBe("entities");
    expect(suggestKey("relationship_types", ["name", "version", "entities", "relations"])).toBe("relations");
    expect(suggestKey("nodes", ["id", "type"])).toBeNull();
    expect(suggestKey("properties", ["id", "set_properties", "remove_properties"])).toBe("set_properties");
  });
});
