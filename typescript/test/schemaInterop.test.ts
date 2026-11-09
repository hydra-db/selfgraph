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
