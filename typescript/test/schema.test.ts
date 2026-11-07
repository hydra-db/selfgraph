import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { KuzuStore, type LLMClient, SelfGraph, ValidationError } from "../src/index.js";
import { Ontology } from "../src/models.js";
import { asSchema, renderSchemaCatalog, Schema, validateAgainstSchema } from "../src/schema.js";

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

const codes = (schema: ReturnType<typeof Schema.parse>, ont: unknown): string[] =>
  validateAgainstSchema(Ontology.parse(ont), schema).map((w) => w.code);

describe("Schema.parse", () => {
  it("fills defaults and keeps endpoints and aliases", () => {
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
  });
});

describe("asSchema", () => {
  it("passes a parsed schema through, validates an object, and keeps null", () => {
    const parsed = Schema.parse(SPEC);
    expect(asSchema(parsed)).toEqual(parsed);
    expect(asSchema(SPEC)).toEqual(parsed);
    expect(asSchema(null)).toBeNull();
    expect(asSchema(undefined)).toBeNull();
  });
});

describe("validateAgainstSchema", () => {
  const schema = Schema.parse(SPEC);

  it("accepts a clean ontology resolved through aliases and parent types", () => {
    expect(
      codes(schema, {
        entities: [
          { id: "manager:m", type: "Manager", name: "M", properties: { age: 30 } },
          { id: "org:o", type: "org", name: "O" },
        ],
        relations: [{ from_entity: "manager:m", type: "works at", to_entity: "org:o" }],
      }),
    ).toEqual([]);
  });

  it("flags an unknown entity type", () => {
    const warnings = validateAgainstSchema(
      Ontology.parse({ entities: [{ id: "thing:x", type: "Alien", name: "X" }] }),
      schema,
    );
    expect(warnings).toEqual([
      {
        code: "unknown_entity_type",
        message: "entity thing:x has unknown type 'Alien'",
        source_id: null,
        chunk_id: null,
      },
    ]);
  });

  it("flags a missing required property and a type mismatch in order", () => {
    expect(
      codes(schema, {
        entities: [
          { id: "person:p", type: "Person", name: "P", properties: { score: "high" } },
          { id: "company:c", type: "Company", name: "C", properties: { founded: 5 } },
        ],
      }),
    ).toEqual(["missing_required_property", "property_type_mismatch", "property_type_mismatch"]);
  });

  it("flags an unknown relation type", () => {
    expect(
      codes(schema, {
        entities: [{ id: "person:p", type: "Person", name: "P", properties: { age: 1 } }],
        relations: [{ from_entity: "person:p", type: "LIKES", to_entity: "person:p" }],
      }),
    ).toEqual(["unknown_relation_type"]);
  });

  it("flags an endpoint whose type is not allowed", () => {
    expect(
      codes(schema, {
        entities: [{ id: "company:c", type: "Company", name: "C" }],
        relations: [{ from_entity: "company:c", type: "WORKS_AT", to_entity: "company:c" }],
      }),
    ).toEqual(["endpoint_type_violation"]);
  });

  it("flags cardinality above the endpoint max per insert", () => {
    expect(
      codes(schema, {
        entities: [
          { id: "person:p", type: "Person", name: "P", properties: { age: 1 } },
          { id: "company:c", type: "Company", name: "C" },
        ],
        relations: [
          { id: "relation:a", from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" },
          { id: "relation:b", from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" },
        ],
      }),
    ).toEqual(["cardinality_violation"]);
  });

  it("flags cardinality below the endpoint min per insert", () => {
    const strict = Schema.parse({
      entities: [{ name: "Person" }, { name: "Company" }],
      relations: [{ type: "WORKS_AT", from: { types: ["Person"], min_count: 2 }, to: { types: ["Company"] } }],
    });
    const warnings = validateAgainstSchema(
      Ontology.parse({
        entities: [
          { id: "person:p", type: "Person", name: "P" },
          { id: "company:c", type: "Company", name: "C" },
        ],
        relations: [{ from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" }],
      }),
      strict,
    );
    expect(warnings.map((w) => w.code)).toEqual(["cardinality_violation"]);
    expect(warnings[0]?.message).toContain("below min 2");
  });

  it("reports nothing when the schema has no entities or relations to check against", () => {
    const empty = Schema.parse({});
    expect(
      codes(empty, {
        entities: [{ id: "thing:x", type: "Whatever", name: "X" }],
        relations: [{ from_entity: "thing:x", type: "ANYTHING", to_entity: "thing:x" }],
      }),
    ).toEqual([]);
  });

  it("accepts valid property values, an int for a float, and null", () => {
    const schema = Schema.parse(TYPES_SPEC);
    expect(
      codes(schema, {
        entities: [
          { id: "thing:a", type: "Thing", name: "A", properties: { b: true, j: { x: [1, 2] }, f: 3, i: 7, s: "hi" } },
          { id: "thing:b", type: "Thing", name: "B", properties: { b: null, i: null } },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects wrong property types and a boolean given as an integer", () => {
    const schema = Schema.parse(TYPES_SPEC);
    const warnings = validateAgainstSchema(
      Ontology.parse({
        entities: [
          { id: "thing:x", type: "Thing", name: "X", properties: { b: "yes", f: "big", i: true, s: 5, j: 42 } },
        ],
      }),
      schema,
    );
    expect(warnings.map((w) => w.code)).toEqual(Array(4).fill("property_type_mismatch"));
  });

  it("does not flag an endpoint whose types are unrestricted", () => {
    const schema = Schema.parse({
      entities: [{ name: "Person" }, { name: "Company" }],
      relations: [{ type: "RELATES_TO" }],
    });
    expect(
      codes(schema, {
        entities: [
          { id: "person:p", type: "Person", name: "P" },
          { id: "company:c", type: "Company", name: "C" },
        ],
        relations: [{ from_entity: "person:p", type: "RELATES_TO", to_entity: "company:c" }],
      }),
    ).toEqual([]);
  });
});

describe("renderSchemaCatalog", () => {
  it("lists entities with aliases and relations with endpoints", () => {
    const [entities, relations] = renderSchemaCatalog(Schema.parse(SPEC));
    expect(entities).toBe(
      "Extract entities using these known types where they fit:\n" +
        "- Person: a human. aliases: user\n" +
        "- Manager: no description\n" +
        "- Company: no description. aliases: org",
    );
    expect(relations).toBe("Known relationship types:\n- WORKS_AT (Person -> Company)\n- KNOWS (Person -> Person)");
  });

  it("returns empty blocks for an empty schema", () => {
    expect(renderSchemaCatalog(Schema.parse({}))).toEqual(["", ""]);
  });
});

describe("schema through the client", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfgraph-schema-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const schema = {
    entities: [{ name: "Person", properties: [{ name: "age", type: "integer" as const, required: true }] }],
  };
  const ontology = { entities: [{ id: "person:p", type: "Person", name: "P" }] };

  async function withGraph<T>(name: string, opts: object, fn: (g: SelfGraph) => Promise<T>): Promise<T> {
    const path = join(dir, name);
    const graph = new SelfGraph(new KuzuStore(path), opts);
    try {
      await graph.initialize();
      return await fn(graph);
    } finally {
      await graph.close();
      await KuzuStore.closeDatabase(path);
    }
  }

  it("exposes a graph-level schema and lets a per-insert mode override it", async () => {
    await withGraph("a.kuzu", { schema }, async (graph) => {
      expect(graph.schema?.entities[0]?.name).toBe("Person");
      expect((await graph.insert.ontology(ontology)).warnings.map((w) => w.code)).toEqual([
        "missing_required_property",
      ]);
      expect((await graph.insert.ontology(ontology, { schema_mode: "off" })).warnings).toEqual([]);
    });
  });

  it("rejects violations when the graph is in strict mode", async () => {
    await withGraph("b.kuzu", { schema, schema_mode: "strict" }, async (graph) => {
      await expect(graph.insert.ontology(ontology)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it("injects the schema catalog into the extraction prompt", async () => {
    const prompts: string[] = [];
    const recorder: LLMClient = {
      async generate({ system, user, output }) {
        prompts.push(system + user);
        return output.parse({ entities: [], relations: [], preferences: [], decisions: [] });
      },
    };
    await withGraph("c.kuzu", { llm: recorder, schema: SPEC }, async (graph) => {
      await graph.insert.text("Jane manages Acme.");
      const joined = prompts.join("\n");
      expect(joined).toContain("Extract entities using these known types");
      expect(joined).toContain("Known relationship types:");
    });
  });
});
