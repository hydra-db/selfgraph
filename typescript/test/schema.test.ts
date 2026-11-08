import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { buildGraph } from "../src/client.js";
import { KuzuStore, type LLMClient, SelfGraph, ValidationError } from "../src/index.js";
import { callTool, close, configure, TOOLS } from "../src/mcp.js";
import { EntityInput, Ontology, parseOrThrow, suggestKey } from "../src/models.js";
import { DEFAULT_SETTINGS } from "../src/runtime.js";
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

  it("rejects an invalid schema or schema mode with ValidationError", async () => {
    expect(() => asSchema({ entities: [{ description: "no name" }] } as never)).toThrow(/invalid schema/);
    expect(() => new SelfGraph(new KuzuStore(":memory:"), { schema_mode: "loud" as never })).toThrow(/schema_mode/);
    await withGraph("d.kuzu", {}, async (graph) => {
      await expect(
        graph.insert.ontology({ entities: [] }, { schema: SPEC, schema_mode: "loud" as never }),
      ).rejects.toThrow(/schema_mode/);
    });
  });

  it("loads the schema setting from a file or an object", async () => {
    const file = join(dir, "schema.json");
    writeFileSync(file, JSON.stringify(SPEC));
    const settings = { ...DEFAULT_SETTINGS, store: "kuzu", uri: join(dir, "e.kuzu"), schema_mode: "strict" };
    const fromFile = buildGraph({ ...settings, schema: file });
    try {
      expect(fromFile.schema).toEqual(Schema.parse(SPEC));
      await expect(fromFile.insert.ontology({ entities: [{ type: "Robot", name: "R2" }] })).rejects.toBeInstanceOf(
        ValidationError,
      );
    } finally {
      await fromFile.close();
      await KuzuStore.closeDatabase(settings.uri);
    }
    expect(buildGraph({ ...settings, uri: ":memory:", schema: SPEC }).schema).toEqual(Schema.parse(SPEC));
    expect(() => buildGraph({ ...settings, schema: join(dir, "missing.json") })).toThrow(/cannot read/);
  });

  it("serves the schema through the get_schema MCP tool", async () => {
    const getSchema = TOOLS.find((t) => t.name === "get_schema")!;
    await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri: join(dir, "f.kuzu"), schema: SPEC });
    const got = (await callTool(getSchema, {})).result as { relations: Array<{ from: { types: string[] } }> };
    expect(got.relations[0]!.from.types).toEqual(["Person"]);
    await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri: join(dir, "f.kuzu") });
    expect((await callTool(getSchema, {})).result).toBeNull();
    await close();
    await KuzuStore.closeDatabase(join(dir, "f.kuzu"));
  });

  const writeSpec = {
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

  it("inherits required properties through parent types", () => {
    const warnings = validateAgainstSchema(
      Ontology.parse({ entities: [{ id: "manager:m", type: "Manager", name: "M" }] }),
      Schema.parse(writeSpec),
    );
    expect(warnings.map((w) => w.message)).toEqual(["entity manager:m is missing required property 'age'"]);
  });

  it("counts relation aliases toward the canonical type for cardinality", () => {
    const warnings = validateAgainstSchema(
      Ontology.parse({
        entities: [
          { id: "person:p", type: "Person", name: "P", properties: { age: 1 } },
          { id: "company:a", type: "Company", name: "A" },
          { id: "company:b", type: "Company", name: "B" },
        ],
        relations: [
          { from_entity: "person:p", type: "WORKS_AT", to_entity: "company:a" },
          { from_entity: "person:p", type: "employed by", to_entity: "company:b" },
        ],
      }),
      Schema.parse(writeSpec),
    );
    expect(warnings.map((w) => w.message)).toEqual(["person:p has 2 WORKS_AT (from) in this insert, above max 1"]);
  });

  it("checks the endpoint types of entities already in the graph on insert", async () => {
    await withGraph("g.kuzu", { schema: writeSpec }, async (graph) => {
      await graph.entities.create("Acme", "Company");
      const result = await graph.insert.ontology({
        entities: [{ type: "Company", name: "Beta" }],
        relations: [{ from_entity: "company:acme", type: "WORKS_AT", to_entity: "company:beta" }],
      });
      expect(result.warnings.map((w) => w.message)).toEqual([
        "relation company:acme -WORKS_AT-> company:beta from entity company:acme is not one of ['Person']",
      ]);
    });
  });

  it("rejects entity creates and updates in strict mode before writing", async () => {
    await withGraph("h.kuzu", { schema: writeSpec, schema_mode: "strict" }, async (graph) => {
      await expect(graph.entities.create("R2", "Robot")).rejects.toThrow(/^entity Robot:R2 has unknown type 'Robot'$/);
      expect(await graph.entities.get("robot:r2")).toBeNull();
      await expect(graph.entities.create("Jane", "Person")).rejects.toThrow(
        /^entity Person:Jane is missing required property 'age'$/,
      );
      await expect(graph.entities.create("Jane", "Person", { properties: { age: "old" } })).rejects.toThrow(
        /property 'age' should be integer/,
      );
      const jane = await graph.entities.create("Jane", "Person", { properties: { age: 30 } });
      await expect(graph.entities.update(jane.id, { remove_properties: ["age"] })).rejects.toThrow(
        /^entity person:jane is missing required property 'age'$/,
      );
      await graph.entities.create("Acme", "Company");
      await expect(graph.entities.update("company:acme", { type: "Manager" })).rejects.toThrow(
        /^entity company:acme is missing required property 'age'$/,
      );
      expect((await graph.entities.get(jane.id))?.properties).toEqual({ age: 30 });
      expect((await graph.entities.get("company:acme"))?.type).toBe("Company");
    });
  });

  it("rejects relation creates and updates in strict mode before writing", async () => {
    await withGraph("i.kuzu", { schema: writeSpec, schema_mode: "strict" }, async (graph) => {
      await graph.entities.create("Jane", "Person", { properties: { age: 30 } });
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
    });
  });

  it("writes and warns on stderr for each violation in warn mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withGraph("j.kuzu", { schema: writeSpec }, async (graph) => {
        await graph.entities.create("R2", "Robot");
        await graph.entities.update("robot:r2", { properties: { x: 1 } });
        await graph.relations.create("robot:r2", "WORKS_AT", "robot:r2");
        expect((await graph.entities.get("robot:r2"))?.properties).toEqual({ x: 1 });
      });
      expect(warn.mock.calls).toEqual([
        ["selfgraph: schema warning [unknown_entity_type]: entity Robot:R2 has unknown type 'Robot'"],
        ["selfgraph: schema warning [unknown_entity_type]: entity robot:r2 has unknown type 'Robot'"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips write checks in off mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withGraph("k.kuzu", { schema: writeSpec, schema_mode: "off" }, async (graph) => {
        await graph.entities.create("R2", "Robot");
        await graph.entities.update("robot:r2", { type: "Alien" });
        expect((await graph.entities.get("robot:r2"))?.type).toBe("Alien");
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects unknown instruction keys on insert.text", async () => {
    await withGraph("l.kuzu", {}, async (graph) => {
      await expect(graph.insert.text("Jane met Bob.", { instructions: { relatoins: "x" } as never })).rejects.toThrow(
        "unknown key 'relatoins' in instructions; did you mean 'relations'?",
      );
    });
  });
});

describe("unknown keys", () => {
  const cases: Array<[() => unknown, string]> = [
    [
      () => parseOrThrow(Ontology, { entites: [] }, "ontology"),
      "unknown key 'entites' in ontology; did you mean 'entities'?",
    ],
    [
      () => parseOrThrow(Ontology, { entities: [{ type: "Person", nmae: "Jane" }] }, "ontology"),
      "unknown key 'nmae' in ontology.entities[0]; did you mean 'name'?",
    ],
    [
      () =>
        parseOrThrow(
          Ontology,
          { relations: [{ from_entity: "a", type: "X", to_entity: "b", evidence: [{ source_id: "s", qoute: "q" }] }] },
          "ontology",
        ),
      "unknown key 'qoute' in ontology.relations[0].evidence[0]; did you mean 'quote'?",
    ],
    [() => asSchema({ entity_types: [] } as never), "unknown key 'entity_types' in schema"],
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
  ];

  it("rejects them with the location and a close suggestion", () => {
    for (const [build, message] of cases) {
      let error: unknown;
      try {
        build();
      } catch (exc) {
        error = exc;
      }
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(message);
    }
  });

  it("suggests within edit distance two and breaks ties by declared order", () => {
    expect(suggestKey("nmae", ["id", "type", "name"])).toBe("name");
    expect(suggestKey("ab", ["ax", "ay"])).toBe("ax");
    expect(suggestKey("x", ["id"])).toBeNull();
    expect(suggestKey("entity_types", ["name", "version", "entities", "relations"])).toBeNull();
  });
});
