import { afterAll, describe, expect, it, vi } from "vitest";

import { HINTS, WARNING_HINTS } from "../src/errors.js";
import {
  buildGraph,
  DEFAULT_SETTINGS,
  type GraphSettings,
  type GraphStore,
  SelfGraph,
  toNeo4jOntology,
} from "../src/index.js";
import {
  buildServer,
  callTool,
  close,
  configure as configureServer,
  isBlockedQuery,
  runStdio,
  TOOLS,
} from "../src/mcp.js";
import { A_KNOWS_B, ANN_AT_ACME, errorLinks, SINGLE_EMPLOYER, tempKuzu } from "./helpers.js";

const BYPASSES = [
  "WITH 1 AS x insert (m:X) RETURN 1",
  "WITH 1 AS x \\u0043\\u0052EATE (m:X) RETURN 1",
  "MATCH (n) \\u0044ETACH \\u0044ELETE n",
];

const READS = ["MATCH (n) RETURN n.set AS x;", "RETURN 1; MATCH (n) RETURN n"];

const TOOL_NAMES = `certify_relation check_answerable check_readiness create_decision create_entity create_preference
  create_relation delete_decision delete_entity delete_preference delete_relation entity_evidence entity_merges
  get_decision get_entity get_preference get_relation get_schema graph_diff insert_facts insert_text list_decisions
  list_entities list_preferences list_relations maintenance_decay maintenance_dedupe_relations maintenance_prune
  preference_versions relation_evidence relation_versions retrieve run_cypher uncertify_relation unmerge_entity
  update_decision update_entity update_preference update_relation`.split(/\s+/);

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

it("graph_diff keeps proto and nested source metadata keys", async () => {
  const namespace = "mcp_diff_proto";
  const text = '{"__proto__":"literal","nested":[{"__proto__":{"kept":true},"sibling":"kept"}]}';
  await close();
  const g = buildGraph({ ...DEFAULT_SETTINGS, store: "kuzu", uri, namespace });
  try {
    await g.insert.text("Ann works at Acme.", { source_id: "proto", metadata: JSON.parse(text) });
  } finally {
    await g.close();
  }
  await configure({ namespace });
  const result = await mcpOk<{ source_versions_added: { metadata: unknown }[] }>("graph_diff", { since: "1900-01-01" });
  expect(result.source_versions_added.map((v) => JSON.stringify(v.metadata))).toEqual([text]);
});

it("graph_diff returns stored changes and validates the window", async () => {
  await configure({ namespace: "mcp_diff" });
  await mcpOk("create_entity", { name: "Ann", type: "Person" });
  const result = await mcpOk<{ entities_created: { id: string }[]; limitations: string[] }>("graph_diff", {
    since: "1900-01-01",
    until: "2100-01-01",
  });
  expect(result.entities_created.map((e) => e.id)).toEqual(["person:ann"]);
  expect(result.limitations).toEqual(["Deletes and entity edits are not visible."]);
  expect((await callTool("graph_diff", { since: "2100-01-01", until: "1900-01-01" })).isError).toBe(true);
});

describe("MCP run_cypher guard", () => {
  it("recognizes adjacent keyword tokens", () => {
    for (const fragment of ["42SET", ".5SET", "1.SET", "1.5e+2SET", "'text'SET", "/* text */SET", "]SET"]) {
      expect(isBlockedQuery(`RETURN ${fragment}`), fragment).toBe(true);
    }
    for (const fragment of ["offset42SET", "n.set", "{set: 42}", "'42SET'", ".5e+2"]) {
      expect(isBlockedQuery(`RETURN ${fragment}`), fragment).toBe(false);
    }
  });

  it("rejects INSERT, unicode escapes, bare keyword aliases, and chained admin statements", async () => {
    for (const q of BYPASSES) expect(isBlockedQuery(q), q).toBe(true);
    for (const q of READS) expect(isBlockedQuery(q), q).toBe(false);
    expect(await mcpError("run_cypher", { query: BYPASSES[1] })).toMatchObject({
      error_type: "ValidationError",
      code: "read_only_query",
    });
    expect(await mcpError("update_relation", { id: "relation:x", properties: {} })).toEqual({
      error:
        "unknown option 'properties' for update_relation; did you mean 'set_properties'? " +
        "(valid options: id, set_properties, remove_properties, event_time, evidence)",
      error_type: "ValidationError",
      code: "unknown_key",
      field: "properties",
      retryable: false,
      ...errorLinks("unknown_key"),
      tool: "update_relation",
    });
  });
});

it("enforces raw Cypher limits before store dispatch", async () => {
  const result = { columns: [], rows: [], counters: {}, warnings: [] };
  const store = { initialize: vi.fn().mockResolvedValue(undefined), runCypher: vi.fn().mockResolvedValue(result) };
  const graph = new SelfGraph(store as unknown as GraphStore);
  const prefix = "RETURN 1 // ";
  const exactBytes = prefix + "é".repeat((65_536 - prefix.length) / 2);
  for (const [query, limit] of [
    [`${exactBytes}é`, "maximum length of 65536 UTF-8 bytes"],
    [`RETURN ${"([{item:".repeat(11)}1${"}])".repeat(11)}`, "maximum nesting depth of 32"],
  ] as const) {
    await expect(graph.runCypher(query)).rejects.toMatchObject({
      message: `query exceeds the ${limit}`,
      code: "cypher_query_limit",
      field: "query",
    });
  }
  expect(store.initialize).not.toHaveBeenCalled();
  expect(store.runCypher).not.toHaveBeenCalled();
  const ignored = "([{ ".repeat(33);
  for (const query of [
    exactBytes,
    `RETURN ${"(".repeat(32)}1${")".repeat(32)}`,
    `RETURN '${ignored}' AS \`${ignored}\` /* ${ignored} */`,
  ]) {
    await expect(graph.runCypher(query)).resolves.toEqual(result);
    expect(store.runCypher).toHaveBeenLastCalledWith(query, undefined);
  }
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

describe("MCP hints per session", () => {
  it("sends each code's hint once and the hint of each new warning code", async () => {
    await configure({ namespace: "hints" });
    const session = new Set<string>();
    const call = async (name: string, args: Record<string, unknown>, hinted = session) =>
      (await callTool(name, args, hinted)).result as Record<string, unknown>;
    const schema = { entities: [{ name: "Person" }] };
    const first = await call("insert_facts", { facts: { entities: [{ name: "B", type: "Company" }] }, schema });
    const again = await call("insert_facts", { facts: { entities: [{ name: "C", type: "Company" }] }, schema });
    expect(first.warning_hints).toEqual({ unknown_entity_type: WARNING_HINTS.unknown_entity_type });
    expect(again).not.toHaveProperty("warning_hints");
    const missing = await call("delete_entity", { id: "company:bb" });
    expect(missing.error).toMatch(/; did you mean 'company:b'\?$/);
    expect([missing.tool, missing.hint]).toEqual(["delete_entity", HINTS.not_found]);
    expect(await call("delete_entity", { id: "company:bb" })).not.toHaveProperty("hint");
    expect(await call("list_entities", { limit: "x" })).toHaveProperty("hint", HINTS.invalid_argument);
    expect(await call("list_entities", { limit: "x" })).not.toHaveProperty("hint");
    const other = new Set<string>();
    expect(await call("delete_entity", { id: "company:bb" }, other)).toHaveProperty("hint", HINTS.not_found);
    expect(await call("list_entities", { limit: "x" }, other)).toHaveProperty("hint", HINTS.invalid_argument);
  });

  it("keeps a separate session for each built server", async () => {
    await configure({ namespace: "hints" });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const hints: unknown[] = [];
    for (const server of [await buildServer(), await buildServer()]) {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "hints", version: "0" });
      await server.connect(serverSide);
      await client.connect(clientSide);
      for (let i = 0; i < 2; i++) {
        const res = await client.callTool({ name: "list_entities", arguments: { limit: "x" } });
        hints.push((res.structuredContent as { hint?: string }).hint);
      }
      await client.close();
      await server.close();
    }
    expect(hints).toEqual([HINTS.invalid_argument, undefined, HINTS.invalid_argument, undefined]);
  });
});

describe("MCP tools over Kuzu", () => {
  it("maps event_time on every write tool, dates facts inserts, and clears decision and preference fields", async () => {
    await configure();
    const keys = (name: string) => Object.keys(mcpTool(name).input).sort();
    expect(keys("insert_text")).toEqual(
      "contradiction event_time instructions metadata prompts replace_source resolver schema schema_mode source_id text".split(
        " ",
      ),
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

  it("checks number arguments and decision steps with the same messages as the Python server", async () => {
    await configure({ namespace: "mcp_numbers" });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["list_entities", { limit: "5" }, "limit: expected number"],
      ["list_entities", { limit: true }, "limit: expected number"],
      ["retrieve", { query: "x", depth: "2" }, "depth: expected number"],
      ["check_answerable", { question: "x", depth: false }, "depth: expected number"],
      ["maintenance_decay", { half_life_days: "30" }, "half_life_days: expected number"],
      ["maintenance_prune", { min_relevance: true }, "min_relevance: expected number"],
      [
        "create_preference",
        { subject_entity: "t:a", key: "k", value_entity: "t:b", strength: "0.5" },
        "strength: expected number",
      ],
      ["create_decision", { title: "t", steps: null }, "steps: expected array"],
    ];
    for (const [name, args, message] of cases) {
      expect(await invalid(name, args), name).toBe(`invalid arguments: ${message}`);
    }
    expect((await mcpOk<{ items: unknown[] }>("list_entities", { limit: 5.0 })).items).toEqual([]);
    expect((await mcpOk<{ half_life_days: number }>("maintenance_decay", { half_life_days: 7 })).half_life_days).toBe(
      7,
    );
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

  it("lists 39 tools over a transport and reports bad arguments as path: message lines", async () => {
    await configure();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = await buildServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      expect(client.getInstructions()).toContain("check_answerable");
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
      expect(hints.graph_diff).toMatchObject({ readOnlyHint: true });
      expect(hints.retrieve).toMatchObject({ readOnlyHint: true });
      expect(hints.check_answerable).toMatchObject({ readOnlyHint: true });
      expect(hints.create_entity).toMatchObject({ destructiveHint: false, idempotentHint: false });
      expect(hints.insert_facts).toMatchObject({ idempotentHint: true });
      for (const [tool, args, message, field, links] of [
        [
          "get_schema",
          { format: "bogus" },
          "invalid arguments: format: expected 'selfgraph', 'neo4j' or 'ossie'",
          { field: "format" },
          errorLinks("invalid_argument"),
        ],
        ["create_entity", { name: "a" }, "invalid arguments: type: field required", { field: "type" }, {}],
        ["list_entitys", {}, "unknown tool 'list_entitys'", {}, {}],
      ] as const) {
        const res = await client.callTool({ name: tool, arguments: args });
        expect(res.isError).toBe(true);
        expect(res.structuredContent).toEqual({
          error: message,
          error_type: "ValidationError",
          code: "invalid_argument",
          ...field,
          retryable: false,
          ...links,
          tool,
        });
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

  it("puts the object in result for the tools that can return null, found or not, as the Python server does", async () => {
    await configure({ namespace: "mcp_395", schema: { entities: [{ name: "T" }] } });
    await mcpOk("insert_facts", { facts: A_KNOWS_B });
    const rel = await mcpOk("create_relation", { from_entity: "t:a", type: "KNOWS", to_entity: "t:b" });
    const pref = await mcpOk("create_preference", { subject_entity: "t:a", key: "likes", value_entity: "t:b" });
    const dec = await mcpOk("create_decision", { title: "Pick", steps: [rel.id] });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = await buildServer();
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const found: Array<[string, Record<string, unknown>, string | null]> = [
        ["get_entity", { id: "t:a" }, "t:a"],
        ["get_relation", { id: rel.id }, rel.id],
        ["get_preference", { id: pref.id }, pref.id],
        ["get_decision", { id: dec.id }, dec.id],
        ["get_schema", {}, null],
        ["get_schema", { format: "neo4j" }, null],
      ];
      for (const [name, args, id] of found) {
        const res = await client.callTool({ name, arguments: args });
        const text = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
        expect(res.isError, name).toBeFalsy();
        expect(Object.keys(res.structuredContent as object), name).toEqual(["result"]);
        expect(res.structuredContent, name).toEqual({ result: text });
        if (id !== null) expect((text as { id: string }).id, name).toBe(id);
      }
      for (const [name, id] of [
        ["get_entity", "x:missing"],
        ["get_relation", "relation:missing"],
        ["get_preference", "preference:missing"],
        ["get_decision", "decision:missing"],
      ] as const) {
        const res = await client.callTool({ name, arguments: { id } });
        expect(res.structuredContent, name).toEqual({ result: null });
        expect((res.content as Array<{ text: string }>)[0]!.text, name).toBe("null");
      }
      await configure();
      const none = await client.callTool({ name: "get_schema", arguments: {} });
      expect(none.structuredContent).toEqual({ result: null });
      const failed = await client.callTool({ name: "get_entity", arguments: { id: "bad" } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ error_type: "ValidationError", tool: "get_entity" });
    } finally {
      await client.close();
      await server.close();
    }
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

it("wraps an unexpected tool error as a coded, credential-masked internal error", async () => {
  const baseUrl = "https://proxy:llm-secret@llm.example/v1";
  await configure({ namespace: "mcp_internal", llm_base_url: baseUrl });
  const tool = {
    name: "insert_facts",
    input: {},
    run: () => {
      throw new Error(`driver blew up talking to ${baseUrl}`);
    },
  };
  const { result, isError } = await callTool(tool as never, {});
  const error = result as { error: string; error_type: string; code: string };
  expect(isError).toBe(true);
  expect(error.error_type).toBe("InternalError");
  expect(error.code).toBe("internal_error");
  expect(error.error).not.toContain("llm-secret");
  expect(error.error).toContain("https://***@llm.example/v1");
});

it("rejects proto keys before MCP argument parsing drops them", async () => {
  await configure({ namespace: "proto_rejection" });
  for (const [name, args] of [
    ["create_entity", { name: "Ann", type: "Person", properties: JSON.parse('{"__proto__":"x"}') }],
    ["create_entity", { name: "Ann", type: "Person", external_ids: JSON.parse('{"__proto__":"x"}') }],
    [
      "insert_facts",
      {
        facts: {
          entities: [{ name: "Ann", type: "Person", properties: JSON.parse('{"nested":[{"__proto__":"x"}]}') }],
        },
      },
    ],
  ] as const) {
    expect(await callTool(name, args)).toEqual({
      isError: true,
      result: expect.objectContaining({
        error: "property and external id keys cannot be '__proto__'",
        error_type: "ValidationError",
        code: "invalid_argument",
      }),
    });
  }
});
