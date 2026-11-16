import { kv } from "../../src/cli.js";
import type { Evidence, GraphStore, Page } from "../../src/index.js";
import {
  FalkorDBStore,
  fromTables,
  ids,
  KuzuStore,
  SelfGraph,
  toJsonable,
  toNeo4jOntology,
  ValidationError,
} from "../../src/index.js";
import { setLogger } from "../../src/internal/log.js";
import { comparePy } from "../../src/internal/py.js";
import { jsonIso } from "../../src/internal/time.js";
import { Extraction, parseOrThrow } from "../../src/models.js";
import { tokens } from "../../src/retrieval.js";
import { parseJson } from "../../src/runtime.js";
import { Schema, validateAgainstSchema } from "../../src/schema.js";
import { requireIdentifier } from "../../src/stores/cypherPrimitives.js";
import { expandTokens, schemaForms } from "../../src/terms.js";
import { parseTime } from "../../src/validate.js";
import { STORE_SPECS } from "../helpers.js";

const TERMS_SPEC = {
  entities: [
    {
      name: "Company",
      synonyms: ["employer", "firm"],
      certified: true,
      definitions: [{ name: "headcount", expression: "count(Person)", synonyms: ["staff size"] }],
    },
    { name: "Person", aliases: ["user"], synonyms: ["staff member"] },
    { name: "InvoiceLine", mappings: [{ table: "sales.invoice_lines", column: "id" }] },
  ],
  relations: [{ type: "WORKS_AT", synonyms: ["employed by"], certified: true }],
};
const TERM_QUESTIONS = [
  "What is the staff size of the firm Acme by ad spend?",
  "users employed by employers",
  "which employers hired staff members named Hopper",
  "total for invoice lines and Works At",
  "Zoë ÅNGSTRÖM",
];
const TABLES = [
  {
    name: "sales.invoice_lines",
    description: "one line of an invoice",
    columns: [
      { name: "invoice_id", type: "bigint", references: "sales.invoices" },
      { name: "soldByCustomerId", references: "Customers" },
      { name: "extended_price", type: "numeric(18,2)", nullable: false, description: "net" },
      { name: "note", type: "varchar", nullable: true },
      { name: "is_void", type: "BOOLEAN" },
      { name: "payload", type: "jsonb" },
      { name: "qty", type: "smallint" },
      { name: "pickup", type: "point" },
      { name: "lead_time", type: "interval" },
      { name: "untyped" },
    ],
  },
  {
    name: "sales.invoices",
    columns: [
      { name: "invoice_date", type: "date" },
      { name: "id", type: "uuid" },
    ],
  },
  { name: "Customers", columns: [{ name: "parent_id", references: "Customers" }] },
  { name: "addresses", columns: [{ name: "status_id", references: "order_statuses" }] },
  { name: "movies" },
  { name: "order_statuses" },
  { name: "Companies", columns: [{ name: "customer_id", references: "Customers" }] },
];

const NEO4J_LOSS_SPEC = {
  name: "conformance",
  entities: [
    {
      name: "Person",
      aliases: ["Human"],
      synonyms: ["individual"],
      certified: true,
      mappings: [{ source: "crm", table: "users" }],
      definitions: [{ name: "seniority", expression: "count(Job)" }],
    },
    { name: "Org" },
    { name: "Company", parent: "Org" },
  ],
  relations: [
    { type: "OWNS", synonyms: ["holds"], certified: true, from: { types: ["Person"] }, to: { types: ["Company"] } },
  ],
};

const SCHEMA_SPEC = {
  name: "conformance",
  entities: [
    {
      name: "Person",
      description: "a human",
      aliases: ["user"],
      properties: [
        { name: "age", type: "integer", required: true },
        { name: "nickname", type: "string" },
      ],
    },
    { name: "Manager", parent: "Person" },
    { name: "Company", aliases: ["org"], properties: [{ name: "founded", type: "datetime" }] },
  ],
  relations: [
    {
      type: "WORKS_AT",
      aliases: ["employed by"],
      from: { types: ["Person"], max_count: 1 },
      to: { types: ["Company"], min_count: 1 },
    },
    { type: "KNOWS", aliases: ["is friends with"], from: { types: ["Person"] }, to: { types: ["Person"] } },
  ],
};

const SCHEMA_CASES = [
  {
    entities: [
      { id: "person:p", type: "Person", name: "P", properties: { age: 30 } },
      { id: "company:c", type: "Company", name: "C" },
    ],
    relations: [
      { from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" },
      { from_entity: "person:p", type: "works at", to_entity: "company:c" },
      {
        id: ids.relationId("person:p", "WORKS_AT", "company:c"),
        from_entity: "person:p",
        type: "WORKS_AT",
        to_entity: "company:c",
      },
    ],
  },
  {
    entities: [
      { id: "manager:m", type: "Manager", name: "M", properties: { age: 30 } },
      { id: "org:o", type: "org", name: "O" },
    ],
    relations: [{ from_entity: "manager:m", type: "works at", to_entity: "org:o" }],
  },
  {
    entities: [
      { id: "person:p", type: "Person", name: "P" },
      { id: "thing:x", type: "Alien", name: "X" },
      { id: "company:c", type: "Company", name: "C", properties: { founded: 5 } },
    ],
    relations: [
      { id: "relation:r1", from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" },
      { id: "relation:r2", from_entity: "person:p", type: "WORKS_AT", to_entity: "company:c" },
      { id: "relation:r3", from_entity: "company:c", type: "WORKS_AT", to_entity: "company:c" },
      { id: "relation:r4", from_entity: "person:p", type: "LIKES", to_entity: "company:c" },
    ],
  },
  {
    entities: [{ id: "manager:z", type: "Manager", name: "Z" }],
    relations: [
      { from_entity: "manager:z", type: "WORKS_AT", to_entity: "org:o" },
      { from_entity: "manager:z", type: "employed by", to_entity: "org:o2" },
      { from_entity: "company:stored", type: "KNOWS", to_entity: "manager:z" },
    ],
  },
  {
    entities: [{ id: "person:n", type: "Person", name: "N", properties: { age: null } }],
    relations: [],
  },
];

const GRAPH_TYPES = new Map([
  ["company:stored", "Company"],
  ["org:o", "org"],
]);

const OWN_KEY_SPEC = {
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
const OWN_KEY_CASES = [
  { entities: [{ type: "Car", name: "SF-24", properties: { toString: "x" } }] },
  { entities: [{ type: "Car", name: "SF-24", properties: { constructor: "Ferrari", toString: "x" } }] },
  { entities: [{ type: "Car", name: "SF-24", properties: { constructor: 5, toString: "x" } }] },
  { entities: [{ type: "Car", name: "SF-24", properties: {} }] },
];

const UNKNOWN_KEY_CASES: Array<["facts" | "schema", unknown]> = [
  ["facts", { entites: [] }],
  ["facts", { entities: [{ type: "P", nmae: "x" }] }],
  ["facts", { entities: [{ type: "P", name: "x", b: 1, a: 2 }] }],
  [
    "facts",
    { relations: [{ from_entity: "a", type: "X", to_entity: "b", evidence: [{ source_id: "s", qoute: "q" }] }] },
  ],
  ["facts", { decisions: [{ title: "t", steps: [], stauts: "active" }] }],
  ["facts", { preferences: [{ subject_entity: "a", key: "k", value_entity: "b", strenght: 1 }] }],
  ["schema", { entity_types: [] }],
  ["schema", { entities: [{ name: "A", properties: [{ name: "x", requird: true }] }] }],
  ["schema", { relations: [{ type: "X", from: { type: ["A"] } }] }],
  ["schema", { relations: [{ type: "X", to: { max: 1 } }] }],
];

/**
 * Parse a value with an unknown key and return the error message.
 *
 * @param kind ("facts" | "schema"): which input it is.
 * @param value (unknown): the raw input.
 * @return (string): the ValidationError message.
 */
function unknownKeyError(kind: "facts" | "schema", value: unknown): string {
  try {
    if (kind === "facts") parseOrThrow(Extraction, value, kind);
    else parseOrThrow(Schema, value, kind);
  } catch (exc) {
    return (exc as Error).message;
  }
  return "no error";
}

/**
 * Export a schema holding every field the Neo4j ontology cannot carry, and return what it logs.
 *
 * @return (string): the logged warning lines joined by newlines, empty when the export logs nothing.
 */
export function neo4jExportWarnings(): string {
  const lines: string[] = [];
  const previous = setLogger((message) => lines.push(message));
  try {
    toNeo4jOntology(Schema.parse(NEO4J_LOSS_SPEC));
  } finally {
    setLogger(previous);
  }
  return lines.join("\n");
}

const JSON_INPUTS = ["NaN", "Infinity", "-Infinity", "1.5", "[1]", "nope"];

/**
 * Parse each input as a KEY=VALUE flag value and inside a JSON document, as the CLI and settings do.
 *
 * @return ({ flags: unknown[]; documents: unknown[] }): each input's flag value, and each document's parsed value or its error up to the first colon, since the two JSON parsers word a syntax error differently.
 */
function jsonConstants(): { flags: unknown[]; documents: unknown[] } {
  const document = (text: string): unknown => {
    try {
      return parseJson(text, " in --metadata");
    } catch (exc) {
      if (!(exc instanceof ValidationError)) throw exc;
      return exc.message.split(":")[0];
    }
  };
  return {
    flags: JSON_INPUTS.map((x) => kv([`v=${x}`], "--prop").v),
    documents: JSON_INPUTS.map((x) => document(`{"v": ${x}}`)),
  };
}

/**
 * Validate each schema case and return its warnings as code and message pairs, plus unknown-key errors.
 *
 * @return ({ warnings: Array<Array<{ code: string; message: string }>>; unknown_keys: string[]; tables: unknown; term_forms: unknown; terms: unknown[]; neo4j_dropped: string }): one list per case, one message per unknown-key case, the schema drafted from tables, the schema term forms, the expanded tokens per question, the fields the Neo4j export drops, and how NaN and Infinity parse.
 */
export function schemaWarnings(): {
  warnings: Array<Array<{ code: string; message: string }>>;
  unknown_keys: string[];
  alias_errors: string[];
  own_keys: Array<Array<{ code: string; message: string }>>;
  parents: unknown[];
  tables: unknown;
  term_forms: unknown;
  terms: unknown[];
  datetime_errors: string[];
  terms_subtypes: unknown[];
  neo4j_dropped: string;
  json_constants: { flags: unknown[]; documents: unknown[] };
} {
  const terms = Schema.parse(TERMS_SPEC);
  const subSchema = Schema.parse({
    entities: [
      {
        name: "Employee",
        aliases: ["Worker"],
        synonyms: ["staff"],
        definitions: [{ name: "Active Staff", expression: "a", synonyms: ["personnel"] }],
      },
      { name: "Engineer", parent: "Employee" },
      { name: "PrincipalEngineer", parent: "Engineer" },
    ],
  });
  const schema = Schema.parse(SCHEMA_SPEC);
  return {
    warnings: SCHEMA_CASES.map((c) =>
      validateAgainstSchema(Extraction.parse(c), schema, { graphTypes: GRAPH_TYPES }).map((w) => ({
        code: w.code,
        message: w.message,
      })),
    ),
    alias_errors: [
      { entities: [{ name: "Person" }, { name: "Company", aliases: ["Person"] }] },
      {
        entities: [
          { name: "Company", aliases: ["org"] },
          { name: "Team", aliases: ["Org"] },
        ],
      },
      { entities: [{ name: "Straße" }, { name: "Company", aliases: ["STRASSE"] }] },
      { relations: [{ type: "WORKS_AT" }, { type: "OWNS", aliases: ["works at"] }] },
      { relations: [{ type: "OWNS", aliases: ["works-at"] }, { type: "WORKS_AT" }] },
      {
        relations: [
          { type: "OWNS", aliases: ["employed by"] },
          { type: "WORKS_AT", aliases: ["employed-by"] },
        ],
      },
    ].map((spec) => unknownKeyError("schema", spec)),
    own_keys: OWN_KEY_CASES.map((c) =>
      validateAgainstSchema(Extraction.parse(c), Schema.parse(OWN_KEY_SPEC)).map((w) => ({
        code: w.code,
        message: w.message,
      })),
    ),
    parents: [
      { entities: [{ name: "Person" }, { name: "Manager", parent: "person" }] },
      {
        entities: [
          { name: "Person", aliases: ["Human"] },
          { name: "Manager", parent: "human" },
        ],
      },
      {
        entities: [
          { name: "Person", aliases: ["Human"] },
          { name: "Manager", parent: "HUMAN" },
        ],
      },
      { entities: [{ name: "Person" }, { name: "Manager", parent: "Person" }] },
      {
        entities: [
          { name: "Person", aliases: ["Human"] },
          { name: "Manager", parent: "Human" },
        ],
      },
      { entities: [{ name: "Person" }, { name: "Manager", parent: "X" }] },
      {
        entities: [
          { name: "A", parent: "b" },
          { name: "B", parent: "a" },
        ],
      },
      { entities: [{ name: "A", parent: "a" }] },
    ].map((spec) => {
      try {
        return parseOrThrow(Schema, spec, "schema").entities.map((entity) => entity.parent);
      } catch (exc) {
        return (exc as Error).message;
      }
    }),
    unknown_keys: UNKNOWN_KEY_CASES.map(([kind, value]) => unknownKeyError(kind, value)),
    tables: toJsonable(fromTables(TABLES, { name: "sales" })),
    neo4j_dropped: neo4jExportWarnings(),
    json_constants: jsonConstants(),
    term_forms: Object.fromEntries(
      Object.entries(schemaForms(terms)).map(([kind, named]) => [kind, Object.fromEntries(named)]),
    ),
    terms: TERM_QUESTIONS.map((q) => [...expandTokens(tokens(q), terms, tokens)].sort(comparePy)),
    datetime_errors: ["0001-01-01T00:00:00+01:00", "9999-12-31T23:00:00-02:00"].map((text) => {
      try {
        parseTime(text, "event_time");
        return "accepted";
      } catch (exc) {
        if (!(exc instanceof ValidationError)) throw exc;
        return exc.message;
      }
    }),
    terms_subtypes: ["Employees", "staff", "personnel"].map((q) =>
      [...expandTokens(tokens(q), subSchema, tokens)].sort(comparePy),
    ),
  };
}

const ZOE = ids.entityId("Person", "Zoë Ångström");

export const FACTS = {
  entities: [
    {
      type: "Person",
      name: "Jane Doe",
      aliases: ["JD", "J. Doe"],
      properties: {
        title: "CTO",
        score: 1.5,
        weight: 2.0,
        ratios: [1.0, 0.5, -0.0, 1e-7],
        tags: ["a", "é"],
        meta: { x: null, ok: true, level: 3.0 },
      },
    },
    { type: "Company", name: "Acme, Inc.", external_ids: { crunchbase: "acme-inc" } },
    { type: "Database", name: "HydraDB" },
    { type: "Database", name: "Postgres" },
    { type: "Person", name: "Zoë Ångström" },
    { type: "Person", name: "राम" },
    { type: "Person", name: "रीमा" },
  ],
  relations: [
    {
      from_entity: "person:jane-doe",
      type: "works at",
      to_entity: "company:acme",
      properties: { since: 2020, note: "x", weight: 2.0 },
    },
    {
      from_entity: "company:acme",
      type: "USES",
      to_entity: "database:hydradb",
      event_time: "2024-03-01T12:30:00.654321Z",
    },
    { from_entity: ZOE, type: "KNOWS", to_entity: "person:jane-doe" },
    { from_entity: ids.entityId("Person", "रीमा"), type: "रहती है", to_entity: "database:postgres" },
  ],
  preferences: [
    {
      subject_entity: "person:jane-doe",
      key: "database",
      value_entity: "database:hydradb",
      strength: 0.9,
      about_entity: "company:acme",
    },
    {
      subject_entity: "person:jane-doe",
      stance: "disinterest" as const,
      key: "database",
      value_entity: "database:postgres",
    },
  ],
  decisions: [
    {
      title: "Pick HydraDB",
      actor_entity: "person:jane-doe",
      steps: [ids.relationId("company:acme", "USES", "database:hydradb")],
      outcome_entity: "database:hydradb",
      alternative_entities: ["database:postgres"],
      rationale: "temporal history",
      summary: "chose a graph",
    },
  ],
};

export const TEXT =
  "Grace Hopper joined Remington Rand. Grace Hopper wrote COBOL. Zoë Ångström met Ada Lovelace in 北京.";

/**
 * A store pointed at the same database the Python side uses for a backend.
 *
 * @param name (string): the backend name.
 * @param kuzuPath (string): the Kuzu database path.
 * @return (GraphStore): the store.
 */
export function conformanceStore(name: string, kuzuPath: string): GraphStore {
  if (name === "falkordb")
    return new FalkorDBStore("localhost", Number(process.env.SG_FALKOR_PORT ?? 6380), {
      graph: "selfgraph_conformance",
    });
  if (name === "kuzu") return new KuzuStore(kuzuPath);
  return STORE_SPECS.find((s) => s.name === name)!.make();
}

const JOINED = { from_entity: "company:acme", type: "JOINED", to_entity: "person:jane-doe" };
const LIKES = { subject_entity: "person:jane-doe", key: "employer", value_entity: "company:acme" };
const FACTS_TYPE_CASES: unknown[] = [
  { relations: [{ ...JOINED, event_time: "2021" }] },
  { relations: [{ ...JOINED, event_time: 2021 }] },
  { relations: [{ ...JOINED, event_time: true }] },
  { relations: [{ ...JOINED, evidence: [{ source_id: "s", confidence: "0.5" }] }] },
  { preferences: [{ ...LIKES, strength: "0.9" }] },
  { preferences: [{ ...LIKES, strength: false }] },
  { preferences: [{ ...LIKES, event_time: "20210304T" }] },
  { decisions: [{ title: "t", event_time: 1700000000 }] },
  { decisions: [{ title: "t", event_time: "soon", steps: [] }] },
];

const USES_SPEC = {
  entities: [{ name: "Person" }, { name: "Tool" }],
  relations: [{ type: "USES", from: { types: ["Person"], max_count: 2 } }],
};

export async function write(graph: SelfGraph): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  out.facts = toJsonable(await graph.insert.facts(FACTS, { source_id: "spec" }));
  out.text = toJsonable(
    await graph.insert.text(TEXT, { source_id: "notes", metadata: { author: "conformance", n: 1, f: 0.5 } }),
  );
  const worksAt = ids.relationId("person:jane-doe", "WORKS_AT", "company:acme");
  out.rel_update = toJsonable(
    await graph.relations.update(worksAt, {
      set_properties: { since: 2021, title: "CTO" },
      remove_properties: ["note"],
    }),
  );
  const pref = ids.preferenceId("person:jane-doe", "preference", "database", "database:hydradb");
  out.pref_update = toJsonable(await graph.preferences.update(pref, { strength: 0.25 }));
  const dec = ids.decisionId("person:jane-doe", "Pick HydraDB");
  out.dec_update = toJsonable(await graph.decisions.update(dec, { status: "active", rationale: null }));
  const restated = { title: "Pick HydraDB", actor_entity: "person:jane-doe" };
  out.dec_restate = toJsonable(await graph.insert.facts({ decisions: [restated] }));
  out.rel_restate = toJsonable(
    await graph.insert.facts({
      relations: [{ from_entity: "company:acme", type: "USES", to_entity: "database:hydradb" }],
    }),
  );
  out.pref_restate = toJsonable(
    await graph.insert.facts({
      preferences: [
        {
          subject_entity: "person:jane-doe",
          key: "database",
          value_entity: "database:hydradb",
        },
      ],
    }),
  );
  const step = ids.stepId(dec, 0);
  for (const [label, node, type] of [
    ["DecisionStep", step, "FROM"],
    ["DecisionStep", step, "TO"],
  ] as const) {
    await graph.store.deleteEdgesTouchingByType(graph.namespace, label, node, type);
  }
  await graph.insert.facts({ decisions: [restated] });
  const links: string[][] = [];
  for (const [from_label, to_label, filters] of [
    ["Entity", "DecisionTrace", { to_in: [dec] }],
    ["DecisionTrace", "Entity", { from_in: [dec] }],
    ["DecisionStep", "Entity", { from_in: [step] }],
  ] as const) {
    const edges = await graph.store.matchEdges(graph.namespace, { from_label, to_label, ...filters });
    links.push(...edges.map((e) => [e.type, e.from_id, e.to_id]));
  }
  const repaired = (await graph.decisions.get(dec))!;
  await graph.insert.facts({ decisions: [restated] });
  const retried = (await graph.decisions.get(dec))!;
  out.dec_retry = {
    links: links.sort((a, b) => comparePy(a[0]!, b[0]!)),
    unchanged: retried.updated_at.getTime() === repaired.updated_at.getTime(),
  };
  out.ent_update = toJsonable(
    await graph.entities.update("company:acme", { aliases: ["ACME", "Acme Co"], properties: { hq: "Paris", n: 3 } }),
  );
  out.ent_type_case = toJsonable(await graph.insert.facts({ entities: [{ type: "company", name: "Acme, Inc." }] }));
  out.rel_create = toJsonable(
    await graph.relations.create("thing:grace-hopper", "PIONEERED", "thing:cobol", {
      properties: { year: 1959 },
      event_time: "1959-05-28T09:00:00.123456+00:00",
      evidence: [{ source_id: "manual", quote: "wrote COBOL", start_offset: 1, end_offset: 5, confidence: 0.75 }],
    }),
  );
  out.rel_evidence = toJsonable(
    await graph.relations.update(ids.relationId("thing:grace-hopper", "PIONEERED", "thing:cobol"), {
      evidence: [{ source_id: "manual2", quote: "again", confidence: 0.5 }],
    }),
  );
  await graph.entities.create("Temp Thing", "Thing", { properties: { k: "v" } });
  await graph.relations.create("thing:temp-thing", "TOUCHES", "company:acme", {
    id: "relation:touch-a",
    properties: { active: 1, flags: [false], count: 1 },
  });
  await graph.relations.create("thing:temp-thing", "TOUCHES", "company:acme", {
    id: "relation:touch-b",
    properties: { active: true, flags: [0], count: 1 },
  });
  out.dedupe_conflicts = (await graph.maintenance.dedupeRelations()).groups[0]!.conflicts;
  await graph.relations.create("thing:temp-thing", "BUILT_BY", "company:acme", {
    id: "relation:built-a",
    properties: { year: 2024 },
  });
  await graph.relations.create("thing:temp-thing", "BUILT_BY", "company:acme", {
    id: "relation:built-b",
    properties: { constructor: "Ferrari", toString: "x" },
  });
  out.dedupe_own_keys = toJsonable(
    (await graph.maintenance.dedupeRelations()).groups.filter((g) => g.survivor === "relation:built-a"),
  );
  await graph.preferences.create("thing:temp-thing", "color", "company:acme", { strength: 1.0 });
  try {
    await graph.insert.facts(null as never);
    out.facts_none = "accepted";
  } catch (exc) {
    if (!(exc instanceof ValidationError)) throw exc;
    out.facts_none = exc.message;
  }
  const factsTypes: string[] = [];
  for (const facts of FACTS_TYPE_CASES) {
    try {
      await graph.insert.facts(facts as never);
      factsTypes.push("accepted");
    } catch (exc) {
      if (!(exc instanceof ValidationError)) throw exc;
      factsTypes.push(exc.message);
    }
  }
  out.facts_types = factsTypes;
  try {
    await graph.entities.create("Unsafe", "Thing", { properties: { n: 2 ** 53 } } as never);
    out.unsafe_integer = "accepted";
  } catch (exc) {
    if (!(exc instanceof ValidationError)) throw exc;
    out.unsafe_integer = exc.message;
  }
  const restateSchema: Schema = {
    entities: [{ name: "Thing", properties: [{ name: "k", type: "string", required: true }] }, { name: "Company" }],
    relations: [{ type: "TOUCHES", from: { types: ["Thing"] }, to: { types: ["Company"] } }],
  };
  out.schema_restate = toJsonable(
    (
      await graph.insert.facts(
        { entities: [{ type: "Thing", name: "Temp Thing", properties: { extra: "ok" } }] },
        { schema: restateSchema, schema_mode: "strict" },
      )
    ).entities[0]?.properties,
  );
  try {
    await graph.insert.facts(
      { entities: [{ type: "Thing", name: "Temp Thing", properties: { k: null } }] },
      { schema: restateSchema, schema_mode: "strict" },
    );
    out.schema_null_required = "accepted";
  } catch (exc) {
    if (!(exc instanceof ValidationError)) throw exc;
    out.schema_null_required = exc.message;
  }
  out.ent_delete = toJsonable(await graph.entities.delete("thing:temp-thing"));
  out.rel_delete = toJsonable(await graph.relations.delete(ids.relationId(ZOE, "KNOWS", "person:jane-doe")));
  await graph.insert.facts(
    { entities: [{ type: "Person", name: "Mergia Robert", aliases: ["Mergia Bob"] }] },
    { source_id: "merge-seed" },
  );
  const merged = await graph.insert.facts(
    {
      entities: [
        { type: "Person", name: "Mergia Bob" },
        { type: "Tool", name: "Mergia Anvil" },
      ],
      preferences: [{ subject_entity: "person:mergia-bob", key: "tool", value_entity: "tool:mergia-anvil" }],
    },
    { source_id: "merge-doc", resolver: "default" },
  );
  await graph.entities.delete("tool:mergia-anvil");
  const undone = await graph.entities.unmerge(merged.merges[0]!.id);
  out.unmerge_after_delete = {
    entity: undone.entity.id,
    survivor: undone.survivor?.id ?? null,
    reverted: undone.merge.reverted_at !== null,
    relations: undone.relations.map((r) => r.id),
    preferences: undone.preferences.map((p) => p.id),
    decisions: undone.decisions.map((d) => d.id),
  };
  const repeatedMerges: Record<string, unknown> = {};
  const first = {
    type: "Person",
    name: "Bob",
    aliases: ["Bobby"],
    external_ids: { crm: "C1" },
    properties: { one: 1 },
  };
  const later = {
    type: "Person",
    name: "Bob",
    aliases: ["Robbie"],
    external_ids: { crm: "C2" },
    properties: { two: 2 },
  };
  for (const [mode, batches] of [
    ["one_insert", [[first, later]]],
    ["across_inserts", [[first], [later]]],
  ] as const) {
    const resolved = new SelfGraph(graph.store, { namespace: `${graph.namespace}_${mode}`, resolver: "default" });
    await resolved.insert.facts({
      entities: [{ type: "Person", name: "Robert", aliases: ["Bob"], properties: { one: 0 } }],
    });
    for (const batch of [...batches, batches.at(-1)!]) await resolved.insert.facts({ entities: [...batch] });
    const record = (await resolved.entities.merges("person:robert")).items[0]!;
    const merged = await resolved.entities.get("person:robert");
    const restored = await resolved.entities.unmerge(record.id);
    repeatedMerges[mode] = toJsonable({
      absorbed: record.absorbed,
      merged,
      restored: restored.entity,
      survivor: restored.survivor,
    });
  }
  out.repeated_merges = repeatedMerges;
  await graph.insert.facts(
    {
      entities: [
        { type: "Database", name: "HydraDB" },
        { type: "Company", name: "Acme, Inc." },
      ],
    },
    { source_id: "follow-up" },
  );
  out.retrieval_overflow = await overflow(graph);
  const capped = new SelfGraph(graph.store, {
    namespace: graph.namespace,
    schema: USES_SPEC,
    contradiction: "supersede",
  });
  const names = ["a", "b", "c", "d"];
  await capped.insert.facts({
    entities: [{ type: "Person", name: "Ann" }, ...names.map((name) => ({ type: "Tool", name }))],
  });
  const uses = names.map((n) => ids.relationId("person:ann", "USES", `tool:${n}`));
  for (const [i, name] of names.entries()) {
    await capped.relations.create("person:ann", "USES", `tool:${name}`, {
      event_time: `${2020 + i}-01-01T00:00:00+00:00`,
    });
  }
  out.resettle_delete = toJsonable(await capped.relations.delete(uses[2]!));
  const versions: Record<string, unknown> = {};
  for (const rid of uses.filter((r) => r !== uses[2])) {
    versions[rid] = await capped.relations.versions(rid, { newest_first: false });
  }
  out.resettle_versions = toJsonable(versions);
  const requireIdentifierCases: Record<string, string> = {};
  for (const name of ["id", "external_ids", "a b", "1x", ""]) {
    try {
      requireIdentifierCases[name] = requireIdentifier(name);
    } catch (exc) {
      requireIdentifierCases[name] = (exc as Error).message;
    }
  }
  out.require_identifier = requireIdentifierCases;
  return out;
}

/**
 * Retrieve under a budget where a near line fits, the next overflows under any counter, and short lines remain.
 *
 * @param graph (SelfGraph): the conformance graph, whose store holds a separate namespace for this case.
 * @return (Promise<{ tight: string; full: string }>): the context at the tight budget and at the default one.
 */
async function overflow(graph: SelfGraph): Promise<{ tight: string; full: string }> {
  const g = new SelfGraph(graph.store, { namespace: `${graph.namespace}_budget` });
  for (const name of ["Ann", "Bob", "Cid"])
    await g.entities.create(name, "Person", { id: `person:${name.toLowerCase()}` });
  await g.relations.create("person:ann", "KNOWS", "person:bob");
  await g.relations.create("person:bob", "KNOWS", "person:cid", {
    properties: { note: "met at the old harbour ".repeat(20) },
  });
  const tight = await g.retrieve("Ann", { k: 1, depth: 2, budget_tokens: 12 });
  const full = await g.retrieve("Ann", { k: 1, depth: 2 });
  return { tight: tight.context, full: full.context };
}

async function allEvidence(list: (cursor: string | null) => Promise<Page<Evidence>>): Promise<Evidence[]> {
  const out: Evidence[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Evidence> = await list(cursor);
    out.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return out;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export async function dump(graph: SelfGraph, ns: string): Promise<unknown> {
  const store = graph.store;
  const entities = (await collect(graph.entities.iterate({ limit: 3 }))).sort((a, b) => (a.id < b.id ? -1 : 1));
  const relations: Record<string, unknown> = {};
  const rels = (await collect(graph.relations.iterate({ limit: 3 }))).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const r of rels) relations[r.id] = await graph.relations.versions(r.id, { newest_first: false });
  const preferences: Record<string, unknown> = {};
  for (const e of entities) preferences[e.id] = await collect(graph.preferences.iterate(e.id));
  const preferenceVersions: Record<string, unknown> = {};
  const allPrefs = (await collect(graph.preferences.iterate())).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const p of allPrefs) preferenceVersions[p.id] = await graph.preferences.versions(p.id, { newest_first: false });
  const sources = (await store.matchNodes(ns, "Source")).sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
  const decisions = await collect(graph.decisions.iterate());
  const rawEntities: Record<string, unknown> = {};
  for (const e of entities) rawEntities[e.id] = await store.getNode(ns, "Entity", e.id);
  const evidence: Record<string, unknown> = {};
  for (const e of entities)
    evidence[e.id] = await allEvidence((cursor) => graph.entities.evidence(e.id, { cursor, limit: 2 }));
  for (const r of rels)
    evidence[r.id] = await allEvidence((cursor) => graph.relations.evidence(r.id, { cursor, limit: 2 }));
  const rawEvidence = (await store.matchNodes(ns, "Evidence")).sort((a, b) =>
    (a.id as string) < (b.id as string) ? -1 : 1,
  );
  const sourceVersions = (await store.matchNodes(ns, "SourceVersion")).sort((a, b) =>
    (a.id as string) < (b.id as string) ? -1 : 1,
  );
  const chunks: Record<string, unknown> = {};
  for (const sv of sourceVersions) {
    const rows = await store.childNodes(ns, "SourceVersion", sv.id as string, "HAS_CHUNK", "Chunk");
    chunks[sv.id as string] = rows.sort((a, b) => Number(a.index) - Number(b.index));
  }
  const cutoff = sourceVersions.find((s) => s.source_id === "spec")!.created_at as string;
  const historical = await graph.retrieve("database", { known_at: cutoff, k: 1, depth: 1 });
  const retrieval = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", { depth: 2 });
  const ppr = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", {
    strategy: "ppr",
    depth: 3,
    max_nodes: 4,
  });
  const dfs = await graph.retrieve("Zoë ÅNGSTRÖM acme", { strategy: "dfs", depth: 2 });
  const marks = await graph.retrieve("रीमा कहाँ रहती है?", { depth: 1 });
  const tight: Record<string, unknown> = {};
  for (const walk of ["bfs", "dfs"] as const) {
    const r = await graph.retrieve("Grace Hopper COBOL Jane acme", { strategy: walk, k: 1, depth: 4, max_nodes: 3 });
    tight[walk] = { entities: r.subgraph.entities.map((e) => e.id), relations: r.subgraph.relations.map((x) => x.id) };
  }
  const termed = new SelfGraph(store, { namespace: ns, schema: TERMS_SPEC, extraction: "regex" });
  const answerable = [];
  for (const q of TERM_QUESTIONS) answerable.push(await termed.checkAnswerable(q));
  const seeded: Record<string, unknown> = {};
  for (const tier of ["bm25", "synonyms"] as const) {
    const r = await termed.retrieve("which employers hired staff members named Hopper", { seeds: tier, depth: 0 });
    seeded[tier] = { seeds: r.seeds, tiers: r.tiers };
  }
  const pruned = await termed.maintenance.prune({ older_than: new Date(), types: ["User", "DATABASE"] });
  return toJsonable({
    answerable,
    prune_types: pruned,
    known_at_sources: {
      seeds: historical.seeds.map((s) => s.id),
      counts: Object.fromEntries(historical.subgraph.entities.map((e) => [e.id, e.source_count])),
    },
    retrieval_seeded: seeded,
    tiers: termed.tiers,
    entities,
    relations,
    preferences,
    preference_versions: preferenceVersions,
    sources,
    decisions,
    raw_steps: (await store.matchNodes(ns, "DecisionStep")).sort((a, b) => comparePy(a.id as string, b.id as string)),
    raw_entities: rawEntities,
    evidence,
    raw_evidence: rawEvidence,
    source_versions: sourceVersions,
    chunks,
    retrieval: { seeds: retrieval.seeds, context: retrieval.context },
    retrieval_ppr: { seeds: ppr.seeds, context: ppr.context, entities: ppr.subgraph.entities.map((e) => e.id) },
    retrieval_dfs: { seeds: dfs.seeds, context: dfs.context },
    retrieval_marks: { seeds: marks.seeds, context: marks.context },
    retrieval_tight: tight,
  });
}

export const SUPERSEDE_SCHEMA: Schema = {
  entities: [{ name: "Person" }, { name: "Company" }],
  relations: [
    { type: "WORKS_AT", from: { types: ["Person"], max_count: 1 }, to: { types: ["Company"], max_count: 1 } },
  ],
};

/**
 * Supersede relations capped at both endpoints, with facts arriving out of order across batches.
 *
 * @param graph (SelfGraph): a graph with a two-sided max_count schema and contradiction "supersede".
 * @return (Promise<Record<string, unknown>>): each relation's versions, newest first, and the warning codes of each insert.
 */
export async function supersede(graph: SelfGraph): Promise<Record<string, unknown>> {
  await graph.insert.facts({
    entities: [
      ...["Ann", "Bob"].map((name) => ({ type: "Person", name })),
      ...["Acme", "Globex", "Initech"].map((name) => ({ type: "Company", name })),
    ],
  });
  const link = (person: string, company: string, year: number) => ({
    from_entity: `person:${person}`,
    type: "WORKS_AT",
    to_entity: `company:${company}`,
    event_time: new Date(Date.UTC(year, 0, 1)),
  });
  const batches = [
    [link("ann", "acme", 2020)],
    [link("ann", "initech", 2026)],
    [link("ann", "globex", 2024), link("bob", "acme", 2022)],
  ];
  const warnings: string[][] = [];
  for (const relations of batches) {
    const result = await graph.insert.facts({ relations });
    warnings.push(result.warnings.map((w) => w.code));
  }
  const versions: Record<string, unknown> = {};
  for (const [person, company] of [
    ["ann", "acme"],
    ["ann", "globex"],
    ["ann", "initech"],
    ["bob", "acme"],
  ]) {
    const rid = ids.relationId(`person:${person}`, "WORKS_AT", `company:${company}`);
    versions[rid] = (await graph.relations.versions(rid)).map((v) => [
      v.revision,
      v.is_current,
      v.invalidated_by,
      v.invalidated_at ? jsonIso(v.invalidated_at) : null,
    ]);
  }
  await graph.insert.facts({ entities: [{ type: "Person", name: "Cid" }] });
  await graph.insert.facts({ relations: [link("cid", "acme", 2020)] }, { source_id: "cid-withdrawn" });
  await graph.insert.text("nothing happened.", { source_id: "cid-withdrawn", replace_source: true });
  const cidOlder = await graph.insert.facts({ relations: [link("cid", "globex", 2019)] }, { source_id: "cid-globex" });
  const withdrawn_versions: Record<string, unknown> = {};
  for (const company of ["acme", "globex"]) {
    const rid = ids.relationId("person:cid", "WORKS_AT", `company:${company}`);
    withdrawn_versions[rid] = (await graph.relations.versions(rid)).map((v) => [
      v.revision,
      v.is_current,
      v.invalidated_by,
      v.invalidated_at ? jsonIso(v.invalidated_at) : null,
    ]);
  }
  await graph.insert.facts({
    entities: [
      ...["Dan", "Eve"].map((name) => ({ type: "Person", name })),
      ...["Hooli", "Umbrella", "Wayne"].map((name) => ({ type: "Company", name })),
    ],
  });
  for (const [person, company, year] of [
    ["dan", "hooli", 2020],
    ["dan", "umbrella", 2021],
    ["eve", "hooli", 2022],
  ] as const) {
    await graph.insert.facts({ relations: [link(person, company, year)] });
  }
  await graph.insert.facts({ relations: [link("eve", "wayne", 2023)] });
  const deleted = await graph.relations.delete(ids.relationId("person:dan", "WORKS_AT", "company:umbrella"));
  const delete_versions = (
    await graph.relations.versions(ids.relationId("person:dan", "WORKS_AT", "company:hooli"))
  ).map((v) => [v.revision, v.is_current, v.invalidated_by, v.invalidated_at ? jsonIso(v.invalidated_at) : null]);
  return {
    warnings,
    versions,
    withdrawn_warnings: cidOlder.warnings.map((w) => w.code),
    withdrawn_versions,
    delete_restored: deleted.restored_relations,
    delete_versions,
  };
}
