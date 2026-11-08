import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { KuzuStore } from "../src/index.js";
import { callTool, close, configure, isBlockedQuery, TOOLS } from "../src/mcp.js";
import { DEFAULT_SETTINGS } from "../src/runtime.js";

const BYPASSES = [
  "MATCH (n) WITH n LIMIT 1 INSERT (m:X) RETURN 1",
  "WITH 1 AS x insert (m:X) RETURN 1",
  "WITH 1 AS x \\u0043REATE (m:X) RETURN 1",
  "WITH 1 AS x \\u0043\\u0052EATE (m:X) RETURN 1",
  "MATCH (n) \\u0044ETACH \\u0044ELETE n",
  "WITH 1 AS x \\U00000043REATE (m:X) RETURN 1",
  "WITH 1 AS x // \\u000a CREATE (m:X) RETURN 1",
  "WITH 1 AS x /* \\u002a/ CREATE (m:X) /* */ RETURN 1",
  "MATCH (n) WHERE n.x = 'a\\u0027 CREATE (m:X) //' RETURN 1",
  "RETURN `a\\u0060 AS y",
  "RETURN '\\\\\\u0027' AS x",
  "WITH 1 AS x \\ CREATE (m:X) RETURN 1",
  "UNWIND [1] AS as WITH as CREATE (m:X) RETURN 1",
  "MATCH (n) WHERE n:as CREATE (m:X) RETURN 1",
  "MATCH (n) RETURN n AS create",
  "SHOW TRANSACTIONS YIELD transactionId AS t TERMINATE TRANSACTIONS t YIELD transactionId AS z RETURN z",
  "RETURN 1; ANALYZE GRAPH",
];

const READS = [
  "MATCH (n) RETURN n AS `create`",
  "MATCH (n) WHERE n.path = 'C:\\\\users' RETURN n",
  "RETURN '\\\\u0027' AS x",
  "MATCH (n) RETURN n.set AS x;",
  "RETURN 1; MATCH (n) RETURN n",
];

const byName = (name: string) => TOOLS.find((t) => t.name === name)!;

/**
 * Call a tool by name and return its result, failing the test on an error result.
 *
 * @param name (string): the tool name.
 * @param args (Record<string, unknown>): the tool arguments.
 * @return (Promise<Record<string, string>>): the JSON-ready result.
 */
async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, string>> {
  const { result, isError } = await callTool(byName(name), args);
  expect(isError, JSON.stringify(result)).toBe(false);
  return result as Record<string, string>;
}

describe("MCP run_cypher guard", () => {
  it("rejects INSERT, unicode escapes, bare keyword aliases, and chained admin statements", async () => {
    for (const q of BYPASSES) expect(isBlockedQuery(q), q).toBe(true);
    for (const q of READS) expect(isBlockedQuery(q), q).toBe(false);
    const { result, isError } = await callTool(byName("run_cypher"), { query: BYPASSES[2] });
    expect(isError).toBe(true);
    expect(result).toMatchObject({ error_type: "ValidationError" });
  });
});

describe("MCP tools pass event_time and metadata through", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfgraph-mcp-"));
  const uri = join(dir, "g.kuzu");
  afterAll(async () => {
    await close();
    await KuzuStore.closeDatabase(uri);
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps event_time on every write tool and clears decision fields on explicit null", async () => {
    await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri });
    await ok("create_entity", { name: "Jane", type: "Person" });
    await ok("create_entity", { name: "Acme", type: "Company" });
    const rel = await ok("create_relation", {
      from_entity: "person:jane",
      type: "WORKS_AT",
      to_entity: "company:acme",
      event_time: "2020-01-02T03:04:05+00:00",
    });
    expect(rel.event_time).toMatch(/^2020-01-02T03:04:05/);
    const updated = await ok("update_relation", {
      id: rel.id,
      set_properties: { w: 1 },
      event_time: "2021-01-01T00:00:00+00:00",
    });
    expect(updated.event_time).toMatch(/^2021-01-01/);
    let pref = await ok("create_preference", {
      subject_entity: "person:jane",
      key: "employer",
      value_entity: "company:acme",
      event_time: "2019-05-05",
    });
    expect(pref.event_time).toMatch(/^2019-05-05/);
    pref = await ok("update_preference", { id: pref.id, strength: 0.5, event_time: "2022-02-02T00:00:00+00:00" });
    expect(pref.event_time).toMatch(/^2022-02-02/);
    const dec = await ok("create_decision", {
      title: "Join Acme",
      steps: [rel.id],
      summary: "s",
      rationale: "r",
      event_time: "2020-06-01T00:00:00+00:00",
    });
    expect(dec.event_time).toMatch(/^2020-06-01/);
    const kept = await ok("update_decision", { id: dec.id, title: "Join Acme Inc" });
    expect([kept.summary, kept.rationale, kept.event_time.slice(0, 10)]).toEqual(["s", "r", "2020-06-01"]);
    const cleared = await ok("update_decision", { id: dec.id, summary: null, event_time: null });
    expect([cleared.summary, cleared.rationale, cleared.event_time]).toEqual([null, "r", null]);
    const bad = await callTool(byName("create_relation"), {
      from_entity: "person:jane",
      type: "KNOWS",
      to_entity: "company:acme",
      event_time: "not a date",
    });
    expect(bad.isError).toBe(true);
    expect(bad.result).toMatchObject({ error_type: "ValidationError" });
    const inserted = await ok("insert_text", {
      text: "Jane works at Acme.",
      source_id: "note",
      event_time: "2018-01-01",
      metadata: { k: 1 },
    });
    expect(inserted.source_id).toBe("note");
  });

  it("pages through evidence with entity_evidence and relation_evidence", async () => {
    await configure({ ...DEFAULT_SETTINGS, store: "kuzu", uri, namespace: "mcp_evidence" });
    const ontology = {
      entities: [
        { name: "A", type: "T", id: "t:a" },
        { name: "B", type: "T", id: "t:b" },
      ],
      relations: [{ id: "relation:ab", from_entity: "t:a", type: "KNOWS", to_entity: "t:b" }],
    };
    await ok("insert_ontology", { ontology, source_id: "s1" });
    await ok("insert_ontology", { ontology, source_id: "s2" });
    expect((await ok("get_entity", { id: "t:a" })).source_count).toBe(2);
    const first = (await ok("entity_evidence", { id: "t:a", limit: 1 })) as unknown as {
      items: Array<{ source_id: string }>;
      next_cursor: string | null;
    };
    const rest = (await ok("entity_evidence", { id: "t:a", limit: 1, cursor: first.next_cursor })) as unknown as {
      items: Array<{ source_id: string }>;
      next_cursor: string | null;
    };
    expect([...first.items, ...rest.items].map((e) => e.source_id).sort()).toEqual(["s1", "s2"]);
    expect(rest.next_cursor).toBeNull();
    const rel = (await ok("relation_evidence", { id: "relation:ab" })) as unknown as {
      items: Array<{ source_id: string }>;
    };
    expect(rel.items.map((e) => e.source_id).sort()).toEqual(["s1", "s2"]);
  });

  it("exposes event_time on every write tool and metadata on insert_text", () => {
    const keys = (name: string) => Object.keys(byName(name).input).sort();
    expect(keys("insert_text")).toEqual(["event_time", "metadata", "source_id", "text"]);
    for (const name of [
      "create_relation",
      "update_relation",
      "create_preference",
      "update_preference",
      "create_decision",
      "update_decision",
    ])
      expect(keys(name), name).toContain("event_time");
  });
});
