import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type GraphSettings, toNeo4jOntology } from "../src/index.js";
import {
  buildServer,
  callTool,
  close,
  configure as configureServer,
  isBlockedQuery,
  runStdio,
  TOOLS,
} from "../src/mcp.js";
import { A_KNOWS_B, ANN_AT_ACME, SINGLE_EMPLOYER, tempKuzu } from "./helpers.js";

const BYPASSES = [
  "WITH 1 AS x insert (m:X) RETURN 1",
  "WITH 1 AS x \\u0043\\u0052EATE (m:X) RETURN 1",
  "MATCH (n) \\u0044ETACH \\u0044ELETE n",
];

const READS = ["MATCH (n) RETURN n.set AS x;", "RETURN 1; MATCH (n) RETURN n"];

const TOOL_NAMES =
  `coverage create_decision create_entity create_preference create_relation delete_decision delete_entity
  delete_preference delete_relation entity_evidence entity_merges get_decision get_entity get_preference get_relation
  get_schema insert_facts insert_text list_decisions list_entities list_preferences list_relations
  maintenance_decay maintenance_dedupe_relations maintenance_prune preference_versions relation_evidence relation_versions
  retrieve run_cypher unmerge_entity update_decision update_entity update_preference update_relation`.split(/\s+/);

const uri = tempKuzu("selfgraph-mcp-");
afterAll(close);

/**
 * Back the MCP server with the suite's Kuzu file.
 *
 * @param settings (Partial<GraphSettings>): extra settings.
 * @return (Promise<void>): resolves once the server is configured.
 */
function configure(settings: Partial<GraphSettings> = {}): Promise<void> {
  return configureServer({ ...DEFAULT_SETTINGS, store: "kuzu", uri, ...settings });
}

/**
 * Look up an MCP tool by name.
 *
 * @param name (string): the tool name.
 * @return ((typeof TOOLS)[number]): the tool.
 */
function mcpTool(name: string): (typeof TOOLS)[number] {
  return TOOLS.find((t) => t.name === name)!;
}

/**
 * Call an MCP tool by name and return its result, failing the test on an error result.
 *
 * @param name (string): the tool name.
 * @param args (Record<string, unknown>): the tool arguments.
 * @return (Promise<T>): the JSON-ready result.
 */
async function mcpOk<T = Record<string, string>>(name: string, args: Record<string, unknown>): Promise<T> {
  const { result, isError } = await callTool(name, args);
  expect(isError, JSON.stringify(result)).toBe(false);
  return result as T;
}

/**
 * Call an MCP tool by name and return its error result, failing the test on success.
 *
 * @param name (string): the tool name.
 * @param args (Record<string, unknown>): the tool arguments.
 * @return (Promise<{ error: string; error_type: string }>): the error message and type.
 */
async function mcpError(name: string, args: Record<string, unknown>): Promise<{ error: string; error_type: string }> {
  const { result, isError } = await callTool(name, args);
  expect(isError, `${name}: ${JSON.stringify(result)}`).toBe(true);
  return result as { error: string; error_type: string };
}

describe("MCP run_cypher guard", () => {
  it("rejects INSERT, unicode escapes, bare keyword aliases, and chained admin statements", async () => {
    for (const q of BYPASSES) expect(isBlockedQuery(q), q).toBe(true);
    for (const q of READS) expect(isBlockedQuery(q), q).toBe(false);
    expect((await mcpError("run_cypher", { query: BYPASSES[1] })).error_type).toBe("ValidationError");
    expect(await mcpError("update_relation", { id: "relation:x", properties: {} })).toEqual({
      error:
        "unknown option 'properties' for update_relation; did you mean 'set_properties'? " +
        "(valid options: id, set_properties, remove_properties, event_time, evidence)",
      error_type: "ValidationError",
    });
  });
});

/**
 * Call an MCP tool that must fail validation and return its message.
 *
 * @param name (string): the tool name.
 * @param args (Record<string, unknown>): the tool arguments.
 * @return (Promise<string>): the error message.
 */
async function invalid(name: string, args: Record<string, unknown>): Promise<string> {
  const { error, error_type } = await mcpError(name, args);
  expect(error_type, name).toBe("ValidationError");
  return error;
}

describe("MCP tools over Kuzu", () => {
  it("maps event_time on every write tool, dates facts inserts, and clears decision and preference fields", async () => {
    await configure();
    const keys = (name: string) => Object.keys(mcpTool(name).input).sort();
    expect(keys("insert_text")).toEqual(
      "contradiction event_time instructions metadata prompts resolver schema schema_mode source_id text".split(" "),
    );
    const dated = "insert_facts create_relation update_relation create_preference update_preference create_decision";
    for (const name of [...dated.split(" "), "update_decision"]) expect(keys(name), name).toContain("event_time");
    const inserted = await mcpOk<{ relations: Array<{ event_time: string }> }>("insert_facts", {
      facts: A_KNOWS_B,
      event_time: "2020-05-01",
    });
    expect(inserted.relations[0]!.event_time).toBe("2020-05-01T00:00:00Z");
    const at = { event_time: "2020-01-02T03:04:05+00:00" };
    const rel = await mcpOk("create_relation", { from_entity: "t:b", type: "WORKS_AT", to_entity: "t:a", ...at });
    expect(rel.event_time).toMatch(/^2020-01-02T03:04:05/);
    const updated = await mcpOk("update_relation", { id: rel.id, set_properties: { w: 1 }, event_time: "2021-01-01" });
    expect(updated.event_time).toMatch(/^2021-01-01/);
    const prefArgs = { subject_entity: "t:b", key: "employer", value_entity: "t:a", event_time: "2019-05-05" };
    let pref = await mcpOk("create_preference", prefArgs);
    expect(pref.event_time).toMatch(/^2019-05-05/);
    pref = await mcpOk("update_preference", { id: pref.id, strength: 0.5, event_time: "2022-02-02T00:00:00+00:00" });
    expect(pref.event_time).toMatch(/^2022-02-02/);
    const decArgs = { title: "Join Acme", steps: [rel.id], summary: "s", rationale: "r", event_time: "2020-06-01" };
    const dec = await mcpOk("create_decision", decArgs);
    expect(dec.event_time).toMatch(/^2020-06-01/);
    const kept = await mcpOk("update_decision", { id: dec.id, title: "Join Acme Inc" });
    expect([kept.summary, kept.rationale, kept.event_time.slice(0, 10)]).toEqual(["s", "r", "2020-06-01"]);
    const cleared = await mcpOk("update_decision", { id: dec.id, summary: null, event_time: null });
    expect([cleared.summary, cleared.rationale, cleared.event_time]).toEqual([null, "r", null]);
    expect((await mcpOk<{ steps: unknown[] }>("update_decision", { id: dec.id, steps: [] })).steps).toEqual([]);
    await mcpOk("update_decision", { id: dec.id, steps: [rel.id], rationale: "r2" });
    const emptied = await mcpOk<{ steps: unknown[]; rationale: null }>("update_decision", {
      id: dec.id,
      clear: ["steps", "rationale"],
    });
    expect([emptied.steps, emptied.rationale]).toEqual([[], null]);
    expect(await invalid("update_decision", { id: dec.id, summary: "x", clear: ["summary"] })).toBe(
      "decisions.update cannot both set and clear 'summary'",
    );
    expect(await mcpOk("create_decision", { title: "No steps" })).toMatchObject({ steps: [] });
    const calls: unknown[] = [];
    const fake = { preferences: { update: async (...args: unknown[]) => calls.push(args) } } as never;
    await mcpTool("update_preference").run(fake, { id: "preference:p", clear: ["strength", "about_entity"] });
    expect(calls).toEqual([["preference:p", { event_time: undefined, clear: ["strength", "about_entity"] }]]);
    expect(mcpTool("update_entity").description).toContain("case or spacing");
    await invalid("create_relation", { from_entity: "t:a", type: "LIKES", to_entity: "t:b", event_time: "not a date" });
    const textArgs = { text: "Jane works at Acme.", source_id: "note", event_time: "2018-01-01", metadata: { k: 1 } };
    const text = await mcpOk("insert_text", textArgs);
    expect(text.source_id).toBe("note");
  });

  it("pages evidence, passes relation evidence and a per-call schema to the library, and checks file settings at startup", async () => {
    await configure({ namespace: "mcp_parity" });
    await mcpOk("insert_facts", { facts: A_KNOWS_B, source_id: "s1" });
    await mcpOk("insert_facts", { facts: A_KNOWS_B, source_id: "s2" });
    expect((await mcpOk("get_entity", { id: "t:a" })).source_count).toBe(2);
    type Page = { items: Array<{ source_id: string; quote: string | null }>; next_cursor: string | null };
    const first = await mcpOk<Page>("entity_evidence", { id: "t:a", limit: 1 });
    const rest = await mcpOk<Page>("entity_evidence", { id: "t:a", limit: 1, cursor: first.next_cursor });
    expect([...first.items, ...rest.items].map((e) => e.source_id).sort()).toEqual(["s1", "s2"]);
    expect(rest.next_cursor).toBeNull();
    const evidence = [{ source_id: "doc-1", quote: "A knows B", confidence: 0.9 }];
    const created = await mcpOk("create_relation", { from_entity: "t:b", type: "LIKES", to_entity: "t:a", evidence });
    expect((await mcpOk<Page>("relation_evidence", { id: created.id })).items[0]!.quote).toBe("A knows B");
    await mcpOk("update_relation", { id: "relation:ab", evidence: [{ source_id: "doc-2" }] });
    const sources = (await mcpOk<Page>("relation_evidence", { id: "relation:ab" })).items.map((e) => e.source_id);
    expect(sources.sort()).toEqual(["doc-2", "s1", "s2"]);
    const schema = { entities: [{ name: "Person" }] };
    const facts = { entities: [{ name: "X", type: "T" }] };
    expect((await mcpError("insert_facts", { facts, schema, schema_mode: "strict" })).error).toContain("unknown type");
    const text = await mcpOk<{ warnings: Array<{ code: string }> }>("insert_text", {
      text: "Ann met Bob.",
      schema,
      schema_mode: "off",
      instructions: { entities: "x" },
    });
    expect(text.warnings.map((w) => w.code)).toContain("prompts_ignored");
    await expect(runStdio({ ...DEFAULT_SETTINGS, store: "kuzu", uri, prompts: "/nonexistent.json" })).rejects.toThrow(
      "cannot read",
    );
  });

  it("validates arguments with the library messages, binds every parameter, and returns null for a missing get", async () => {
    await configure({ namespace: "mcp_strict" });
    await mcpOk("create_entity", { name: "A", type: "T" });
    await mcpOk("create_entity", { name: "B", type: "T" });
    const rel = await mcpOk("create_relation", { from_entity: "t:a", type: "KNOWS", to_entity: "t:b" });
    const pref = await mcpOk("create_preference", { subject_entity: "t:a", key: "likes", value_entity: "t:b" });
    const dec = await mcpOk("create_decision", { title: "D", steps: [rel.id] });
    for (const [name, id] of [
      ["update_entity", "t:a"],
      ["update_relation", rel.id],
      ["update_preference", pref.id],
      ["update_decision", dec.id],
    ] as const) {
      expect(await invalid(name, { id })).toContain("nothing to update");
    }
    expect(await invalid("insert_text", { text: "  " })).toBe("text cannot be empty or whitespace");
    expect(await invalid("list_entities", { limit: 0 })).toBe("limit must be >= 1, got 0");
    for (const flag of ["no", "false", "0", 0, null]) {
      for (const name of ["maintenance_decay", "maintenance_dedupe_relations"]) {
        expect(await invalid(name, { dry_run: flag })).toContain("dry_run");
      }
      expect(await invalid("maintenance_prune", { min_relevance: 2, dry_run: flag })).toContain("dry_run");
      expect(await invalid("list_relations", { include_invalidated: flag })).toContain("include_invalidated");
      expect(await invalid("relation_versions", { id: rel.id, newest_first: flag })).toContain("newest_first");
    }
    expect(await invalid("list_decisions", { status: "bogus" })).toContain("status");
    expect(await invalid("list_preferences", { stance: "bogus" })).toContain("stance");
    expect(await invalid("create_decision", { title: "D", steps: [rel.id], status: "bogus" })).toContain("status");
    expect(await invalid("run_cypher", { query: "RETURN $a AS a, '$b' AS b // $c" })).toBe("missing parameter $a");
    expect(await mcpOk("run_cypher", { query: "RETURN $a AS a", params: { a: 1, b: 2 } })).toMatchObject({
      rows: [{ a: 1 }],
    });
    const prefixed =
      `get_relation delete_relation relation_versions relation_evidence get_preference preference_versions
      delete_preference get_decision delete_decision`.split(/\s+/);
    for (const [name, args] of [
      ...prefixed.map((name) => [name, {}] as const),
      ["update_relation", { set_properties: { a: 1 } }],
      ["update_decision", { title: "x" }],
    ] as const) {
      const kind = /relation|preference|decision/.exec(name)![0];
      expect(await invalid(name, { id: "my-id", ...args })).toContain(`${kind} id must start with '${kind}:'`);
    }
    for (const id of ["x:missing", "relation:missing", "preference:missing", "decision:missing"]) {
      const kind = id.startsWith("x:") ? "entity" : id.split(":")[0];
      expect(await mcpOk(`get_${kind}`, { id })).toBeNull();
    }
  });

  it("names who retired a relation, fails versions of an unknown one, and supersedes from now", async () => {
    await configure({ namespace: "mcp_retired", contradiction: "supersede", schema: SINGLE_EMPLOYER });
    await mcpOk("insert_facts", { facts: ANN_AT_ACME });
    const made = await mcpOk("create_relation", {
      from_entity: "person:ann",
      type: "WORKS_AT",
      to_entity: "company:globex",
    });
    const listed = await mcpOk<{ items: Array<{ id: string }> }>("list_relations", {});
    expect(listed.items.map((r) => r.id)).toEqual([made.id]);
    const { items } = await mcpOk<{ items: Array<{ id: string; invalidated_by: string | null }> }>("list_relations", {
      include_invalidated: true,
    });
    const acme = items.find((r) => r.invalidated_by !== null)!;
    const retired = await mcpError("get_relation", { id: acme.id });
    expect(retired.error_type).toBe("NotFoundError");
    expect(retired.error).toContain(`relation ${acme.id} was invalidated by ${made.id}`);
    for (const name of ["relation_versions", "preference_versions"]) {
      expect((await mcpError(name, { id: `${name.split("_")[0]}:ghost` })).error_type).toBe("NotFoundError");
    }
  });

  it("lists 35 tools over a transport and reports bad arguments as path: message lines", async () => {
    await configure();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = await buildServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
      expect(TOOLS.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
      const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
      for (const name of ["get_entity", "list_relations", "relation_versions", "entity_evidence", "run_cypher"]) {
        expect(hints[name]).toMatchObject({ readOnlyHint: true });
      }
      for (const name of ["delete_entity", "maintenance_prune", "maintenance_dedupe_relations"]) {
        expect(hints[name]).toMatchObject({ destructiveHint: true, idempotentHint: true });
      }
      expect(hints.retrieve).toMatchObject({ readOnlyHint: true });
      expect(hints.coverage).toMatchObject({ readOnlyHint: true });
      expect(hints.create_entity).toMatchObject({ destructiveHint: false, idempotentHint: false });
      expect(hints.insert_facts).toMatchObject({ idempotentHint: true });
      for (const [tool, args, message] of [
        ["get_schema", { format: "bogus" }, "invalid arguments: format: expected 'selfgraph' or 'neo4j'"],
        ["create_entity", { name: "a" }, "invalid arguments: type: field required"],
        ["list_entitys", {}, "unknown tool 'list_entitys'"],
      ] as const) {
        const res = await client.callTool({ name: tool, arguments: args });
        expect(res.isError).toBe(true);
        expect(res.structuredContent).toEqual({ error: message, error_type: "ValidationError" });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("defaults maintenance to a dry run without deleted, applies on request, and rejects a bad time", async () => {
    await configure({ namespace: "mcp_maintenance" });
    await mcpOk("create_entity", { name: "A", type: "T", id: "t:a" });
    const soon = new Date(Date.now() + 43_200).toISOString();
    expect(await mcpOk("maintenance_prune", { older_than: soon })).toMatchObject({
      dry_run: true,
      entity_ids: ["t:a"],
    });
    expect(await mcpOk("maintenance_prune", { min_relevance: 0.5 })).not.toHaveProperty("deleted");
    const plan = await mcpOk("maintenance_dedupe_relations", {});
    expect(plan).toMatchObject({ dry_run: true });
    expect(plan).not.toHaveProperty("deleted");
    expect(await mcpOk("maintenance_dedupe_relations", { dry_run: false })).toHaveProperty("deleted");
    const decay = await mcpOk<{ entities: Record<string, number> }>("maintenance_decay", { dry_run: true });
    expect(decay.entities["t:a"]).toBeGreaterThan(0);
    await mcpError("maintenance_prune", { older_than: "not a date" });
    expect(await invalid("maintenance_decay", { now: "soon" })).toBe(
      "invalid now: 'soon' is not an ISO 8601 date or time (e.g. 2024-01-02T03:04:05Z)",
    );
    expect(await mcpOk("get_entity", { id: "t:a" })).not.toBeNull();
  });

  it("takes a resolver on insert and unmerges by id", async () => {
    await configure({ namespace: "mcp_resolution" });
    await mcpOk("insert_facts", { facts: { entities: [{ type: "Person", name: "Robert", aliases: ["Bob"] }] } });
    const res = await mcpOk<{ merges: Array<{ id: string }>; warnings: Array<{ code: string }> }>("insert_facts", {
      facts: { entities: [{ type: "Person", name: "Bob" }] },
      resolver: "default",
    });
    expect(res.warnings.map((w) => w.code)).toEqual(["entity_merged"]);
    const merges = await mcpOk<{ items: Array<{ id: string }> }>("entity_merges", { id: "person:robert" });
    expect(merges.items.map((m) => m.id)).toEqual([res.merges[0]!.id]);
    const out = await mcpOk<{ entity: { id: string } }>("unmerge_entity", { merge_id: res.merges[0]!.id });
    expect(out.entity.id).toBe("person:bob");
  });

  it("serves the schema through get_schema in either format, and null without one", async () => {
    const schema = {
      entities: [{ name: "Person" }, { name: "Company" }],
      relations: [{ type: "WORKS_AT", from: { types: ["Person"] }, to: { types: ["Company"] } }],
    };
    await configure({ schema });
    expect(await mcpOk("get_schema", {})).toMatchObject(schema);
    expect(await mcpOk("get_schema", { format: "neo4j" })).toEqual(toNeo4jOntology(schema));
    await configure();
    expect(await mcpOk("get_schema", {})).toBeNull();
  });
});
