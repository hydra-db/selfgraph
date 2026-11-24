import { describe, expect, it } from "vitest";

import { fromNeo4jOntology, toNeo4jOntology, ValidationError } from "../src/index.js";
import { Schema } from "../src/schema.js";
import { captureWarnings } from "./helpers.js";

const NEO4J = {
  node_types: [
    {
      label: "Person",
      description: "A human",
      properties: [
        { name: "name", type: "STRING", description: "full name" },
        { name: "born", type: "DATE", description: "" },
        { name: "home", type: "POINT", description: "" },
      ],
      additional_properties: false,
    },
    "Company",
    { label: "City", properties: [{ name: "pop", type: "INTEGER", required: true }] },
  ],
  relationship_types: [
    { label: "WORKS_FOR", description: "employment", properties: [{ name: "since", type: "FLOAT" }] },
    { label: "KNOWS" },
  ],
  patterns: [
    ["Person", "WORKS_FOR", "Company"],
    { source: "Person", relationship: "LIVES_IN", target: "City" },
    ["Company", "LIVES_IN", "City"],
    ["Person", "KNOWS", "Person"],
  ],
  constraints: [
    { type: "EXISTENCE", property_names: ["name"], node_type: "Person" },
    { type: "UNIQUENESS", property_names: ["name"], node_type: "Person" },
    { type: "KEY", property_name: "since", relationship_type: "WORKS_FOR" },
  ],
  additional_node_types: false,
  indexes: [],
};

const CANONICAL = {
  node_types: [
    {
      label: "Person",
      description: "A human",
      aliases: ["Human"],
      properties: [
        { name: "name", type: "STRING", description: "full name" },
        { name: "born", type: "ZONED_DATETIME", description: "" },
        { name: "age", type: "INTEGER", description: "" },
        { name: "score", type: "FLOAT", description: "" },
        { name: "active", type: "BOOLEAN", description: "" },
      ],
    },
    { label: "Company", description: "", properties: [] },
  ],
  relationship_types: [
    { label: "WORKS_FOR", description: "", properties: [{ name: "role", type: "STRING", description: "" }] },
    { label: "KNOWS", description: "", properties: [] },
  ],
  patterns: [
    ["Person", "WORKS_FOR", "Company"],
    ["Person", "WORKS_FOR", "Person"],
    ["Person", "KNOWS", "Person"],
  ],
  constraints: [
    { type: "EXISTENCE", property_names: ["name"], node_type: "Person" },
    { type: "EXISTENCE", property_names: ["role"], relationship_type: "WORKS_FOR" },
  ],
};

describe("Neo4j graph schema interop", () => {
  it.each([
    ["node_types", "entities", false],
    ["relationship_types", "relations", false],
    ["node_types", "entities", true],
    ["relationship_types", "relations", true],
  ] as const)("requires string descriptions for %s (%s, property: %s)", (source, target, propertyDescription) => {
    const field = `${target}[0].${propertyDescription ? "properties[0]." : ""}description`;
    for (const description of [false, 0, {}, [], true, 42, { text: "bad" }, ["bad"], null, "", "A description", " "]) {
      const body: Record<string, unknown> = { label: source === "node_types" ? "Person" : "KNOWS" };
      if (propertyDescription) body.properties = [{ name: "note", description }];
      else body.description = description;
      const data = { [source]: [body] };
      if (description !== null && typeof description !== "string") {
        expect(() => fromNeo4jOntology(data)).toThrow(
          expect.objectContaining({
            code: "invalid_argument",
            field,
            message: `invalid schema: ${field}: expected string`,
          }),
        );
      } else {
        const schema = fromNeo4jOntology(data);
        const item = propertyDescription ? schema[target][0]!.properties[0]! : schema[target][0]!;
        expect(item.description).toBe(description === "" ? null : description);
      }
    }
  });

  it("maps types, patterns, and constraints, and lists what it drops", async () => {
    const { result: schema, warnings: lines } = await captureWarnings(() => fromNeo4jOntology(NEO4J));
    const [person, company, city] = schema.entities;
    expect([person!.name, person!.description]).toEqual(["Person", "A human"]);
    expect(person!.properties.map((p) => [p.name, p.type, p.required, p.description])).toEqual([
      ["name", "string", true, "full name"],
      ["born", "datetime", false, null],
      ["home", "json", false, null],
    ]);
    expect([company!.name, company!.properties]).toEqual(["Company", []]);
    expect(city!.properties.map((p) => [p.name, p.type, p.required])).toEqual([["pop", "integer", true]]);
    const [works, knows, lives] = schema.relations;
    expect([works!.type, works!.description, works!.from.types, works!.to.types]).toEqual([
      "WORKS_FOR",
      "employment",
      ["Person"],
      ["Company"],
    ]);
    expect(works!.properties.map((p) => [p.name, p.type, p.required])).toEqual([["since", "float", true]]);
    expect([knows!.from.types, knows!.to.types]).toEqual([["Person"], ["Person"]]);
    expect([lives!.type, lives!.from.types, lives!.to.types]).toEqual(["LIVES_IN", ["Person", "Company"], ["City"]]);
    expect(lines.join("\n")).toContain("Person.home type POINT maps to json");
    const dropped = lines.filter((l) => l.includes("dropped"));
    expect(dropped).toHaveLength(1);
    for (const key of [
      "additional_node_types",
      "indexes",
      "Person.additional_properties",
      "constraints[1] UNIQUENESS on Person(name)",
      "constraints[2] KEY uniqueness on WORKS_FOR(since)",
    ]) {
      expect(dropped[0]).toContain(key);
    }
  });

  it("round-trips the mapped subset", async () => {
    const { result: schema, warnings } = await captureWarnings(() => {
      const parsed = fromNeo4jOntology(CANONICAL);
      expect(toNeo4jOntology(parsed)).toEqual(CANONICAL);
      return parsed;
    });
    expect(warnings).toEqual([]);
    expect(fromNeo4jOntology(toNeo4jOntology(schema))).toEqual(schema);
  });

  it("warns on export about fields without a Neo4j counterpart", async () => {
    const schema = Schema.parse({
      name: "s",
      entities: [{ name: "Person", parent: "Agent", properties: [{ name: "blob", type: "json" }] }, { name: "Agent" }],
      relations: [{ type: "OWNS", from: { types: ["Person"], max_count: 1 } }],
    });
    const { result, warnings } = await captureWarnings(() => toNeo4jOntology(schema));
    const out = result as {
      patterns: unknown[];
      node_types: Array<{ properties: Array<{ type: string }> }>;
    };
    expect(out.patterns).toEqual([]);
    expect(out.node_types[0]!.properties[0]!.type).toBe("STRING");
    for (const key of [
      "name",
      "Person.parent",
      "Person.blob json type",
      "OWNS endpoint types on one side only",
      "OWNS.from",
    ]) {
      expect(warnings.join("\n")).toContain(key);
    }
  });

  it("names every field it drops, and the round trip loses", async () => {
    const schema = Schema.parse({
      name: "s",
      entities: [
        {
          name: "Person",
          aliases: ["Human"],
          synonyms: ["individual"],
          certified: true,
          mappings: [{ source: "crm", table: "users" }],
          definitions: [{ name: "seniority", expression: "count(Job)" }],
        },
        { name: "Company" },
      ],
      relations: [
        { type: "OWNS", synonyms: ["holds"], certified: true, from: { types: ["Person"] }, to: { types: ["Company"] } },
      ],
    });
    const { result, warnings } = await captureWarnings(() => toNeo4jOntology(schema));
    const out = result as { node_types: Array<{ aliases?: string[] }> };
    expect(out.node_types[0]!.aliases).toEqual(["Human"]);
    const named = new Set(
      warnings
        .join("\n")
        .split(":")
        .pop()!
        .split(",")
        .map((part) => part.trim()),
    );
    const spelled: Record<string, string> = { certified: "certified flag" };
    const restored = fromNeo4jOntology(out as never);
    const pairs: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ...schema.entities.map((entity, i) => [entity.name, entity, restored.entities[i]!] as [string, never, never]),
      ...schema.relations.map(
        (relation, i) => [relation.type, relation, restored.relations[i]!] as [string, never, never],
      ),
    ];
    for (const [name, before, after] of pairs) {
      for (const field of ["aliases", "synonyms", "certified", "mappings", "definitions"]) {
        if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
        const key = `${name}.${spelled[field] ?? field}`;
        expect(named, `${key} was lost without being named`).toContain(key);
      }
    }
  });

  it("rejects malformed input on import and export", () => {
    for (const bad of [
      [],
      { node_types: "Person" },
      { node_types: [{ description: "no label" }] },
      { node_types: [{ label: "P", properties: [{ type: "STRING" }] }] },
      { patterns: [["A", "R"]] },
      { node_types: [{ label: "P", aliases: "x" }] },
    ]) {
      expect(() => fromNeo4jOntology(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
    for (const bad of [null, [], { entity_types: [] }]) {
      expect(() => toNeo4jOntology(bad as never), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });

  it("rejects non-list constraint property_names", () => {
    for (const [bad, name] of [
      [1, "number"],
      [true, "boolean"],
      [1.5, "number"],
      ["age", "string"],
    ] as const) {
      let err: unknown;
      try {
        fromNeo4jOntology({
          node_types: ["Person"],
          constraints: [{ type: "EXISTENCE", node_type: "Person", property_names: bad }],
        });
        expect.unreachable(`property_names ${String(JSON.stringify(bad))} should have been rejected`);
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toBe(`constraints[0].property_names must be a list, got ${name}`);
      expect((err as ValidationError).field).toBe("property_names");
    }
  });

  it("reads camelCase keys and exports a raw schema object", () => {
    const schema = fromNeo4jOntology({
      nodeTypes: [{ label: "Person", properties: [{ name: "age", type: "INTEGER" }] }],
      relationshipTypes: [{ label: "KNOWS" }],
      patterns: [["Person", "KNOWS", "Person"]],
      constraints: [{ type: "EXISTENCE", nodeType: "Person", propertyNames: ["age"] }],
    });
    expect(schema.entities.map((e) => [e.name, e.properties[0]?.required])).toEqual([["Person", true]]);
    expect(schema.relations.map((r) => [r.type, r.from.types, r.to.types])).toEqual([
      ["KNOWS", ["Person"], ["Person"]],
    ]);
    expect(toNeo4jOntology({ entities: [{ name: "Person" }] }).node_types).toEqual([
      { label: "Person", description: "", properties: [] },
    ]);
  });
});
