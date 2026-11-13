import type { Evidence, GraphStore, Page } from "../../src/index.js";
import { FalkorDBStore, ids, KuzuStore, type SelfGraph, toJsonable } from "../../src/index.js";
import { Extraction, parseOrThrow } from "../../src/models.js";
import { Schema, validateAgainstSchema } from "../../src/schema.js";
import { STORE_SPECS } from "../helpers.js";

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
];

const GRAPH_TYPES = new Map([
  ["company:stored", "Company"],
  ["org:o", "org"],
]);

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
 * Validate each schema case and return its warnings as code and message pairs, plus unknown-key errors.
 *
 * @return ({ warnings: Array<Array<{ code: string; message: string }>>; unknown_keys: string[] }): one list per case, and one message per unknown-key case.
 */
export function schemaWarnings(): {
  warnings: Array<Array<{ code: string; message: string }>>;
  unknown_keys: string[];
} {
  const schema = Schema.parse(SCHEMA_SPEC);
  return {
    warnings: SCHEMA_CASES.map((c) =>
      validateAgainstSchema(Extraction.parse(c), schema, { graphTypes: GRAPH_TYPES }).map((w) => ({
        code: w.code,
        message: w.message,
      })),
    ),
    unknown_keys: UNKNOWN_KEY_CASES.map(([kind, value]) => unknownKeyError(kind, value)),
  };
}

const ZOE = ids.entityId("Person", "Zoë Ångström");

export const FACTS = {
  entities: [
    {
      type: "Person",
      name: "Jane Doe",
      aliases: ["JD", "J. Doe"],
      properties: { title: "CTO", score: 1.5, tags: ["a", "é"], meta: { x: null, ok: true } },
    },
    { type: "Company", name: "Acme, Inc.", external_ids: { crunchbase: "acme-inc" } },
    { type: "Database", name: "HydraDB" },
    { type: "Database", name: "Postgres" },
    { type: "Person", name: "Zoë Ångström" },
  ],
  relations: [
    {
      from_entity: "person:jane-doe",
      type: "works at",
      to_entity: "company:acme",
      properties: { since: 2020, note: "x" },
    },
    {
      from_entity: "company:acme",
      type: "USES",
      to_entity: "database:hydradb",
      event_time: "2024-03-01T12:30:00.654321Z",
    },
    { from_entity: ZOE, type: "KNOWS", to_entity: "person:jane-doe" },
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
  out.ent_update = toJsonable(
    await graph.entities.update("company:acme", { aliases: ["ACME", "Acme Co"], properties: { hq: "Paris", n: 3 } }),
  );
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
  await graph.relations.create("thing:temp-thing", "TOUCHES", "company:acme");
  await graph.preferences.create("thing:temp-thing", "color", "company:acme", { strength: 1.0 });
  out.ent_delete = toJsonable(await graph.entities.delete("thing:temp-thing"));
  out.rel_delete = toJsonable(await graph.relations.delete(ids.relationId(ZOE, "KNOWS", "person:jane-doe")));
  return out;
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
  const retrieval = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", { depth: 2 });
  const ppr = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", {
    strategy: "ppr",
    depth: 3,
    max_nodes: 4,
  });
  const dfs = await graph.retrieve("Zoë ÅNGSTRÖM acme", { strategy: "dfs", depth: 2 });
  const tight: Record<string, unknown> = {};
  for (const walk of ["bfs", "dfs"] as const) {
    const r = await graph.retrieve("Grace Hopper COBOL Jane acme", { strategy: walk, k: 1, depth: 4, max_nodes: 3 });
    tight[walk] = { entities: r.subgraph.entities.map((e) => e.id), relations: r.subgraph.relations.map((x) => x.id) };
  }
  return toJsonable({
    entities,
    relations,
    preferences,
    preference_versions: preferenceVersions,
    sources,
    decisions,
    raw_entities: rawEntities,
    evidence,
    raw_evidence: rawEvidence,
    source_versions: sourceVersions,
    chunks,
    retrieval: { seeds: retrieval.seeds, context: retrieval.context },
    retrieval_ppr: { seeds: ppr.seeds, context: ppr.context, entities: ppr.subgraph.entities.map((e) => e.id) },
    retrieval_dfs: { seeds: dfs.seeds, context: dfs.context },
    retrieval_tight: tight,
  });
}
