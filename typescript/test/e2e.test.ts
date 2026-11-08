import { beforeAll, describe, expect, it } from "vitest";

import {
  buildCli,
  CLI,
  runCli as cli,
  NEO4J_PASSWORD,
  NEO4J_URI,
  reachable,
  STORE_SPECS,
  uniqueNs,
} from "./helpers.js";

const neo4jUp = await reachable(STORE_SPECS.find((s) => s.name === "neo4j")!);
const ns = uniqueNs("e2e");
const GLOBAL = ["--store", "neo4j", "--uri", NEO4J_URI, "--auth", `neo4j:${NEO4J_PASSWORD}`, "--namespace", ns];

beforeAll(() => {
  if (neo4jUp) buildCli();
});

describe.skipIf(!neo4jUp)("built CLI against Neo4j", () => {
  it("creates, reads, inserts from stdin, queries, and retrieves", () => {
    const created = cli([
      ...GLOBAL,
      "entity",
      "create",
      "--name",
      "Jane Doe",
      "--type",
      "Person",
      "--prop",
      "age=41",
      "--prop",
      "team=core",
    ]);
    expect(created.code).toBe(0);
    expect(created.out).toMatchObject({ id: "person:jane-doe", properties: { age: 41, team: "core" } });
    expect((created.out as { created_at: string }).created_at).toMatch(/Z$/);

    const ontology = JSON.stringify({
      entities: [{ type: "Company", name: "Acme" }],
      relations: [{ from_entity: "person:jane-doe", type: "works at", to_entity: "company:acme" }],
    });
    const inserted = cli([...GLOBAL, "insert", "ontology", "-", "--source-id", "stdin"], { input: ontology });
    expect(inserted.code).toBe(0);
    expect((inserted.out as { relations: Array<{ type: string }> }).relations[0]!.type).toBe("WORKS_AT");

    const listed = cli([...GLOBAL, "relation", "list", "--from", "person:jane-doe"]);
    expect((listed.out as { items: unknown[] }).items).toHaveLength(1);

    const q = cli([
      ...GLOBAL,
      "query",
      "MATCH (n:Entity) WHERE n.ns = $ns RETURN count(n) AS c",
      "--param",
      `ns="${ns}"`,
    ]);
    expect(q.out).toMatchObject({ columns: ["c"], rows: [{ c: 2 }] });

    const r = cli([...GLOBAL, "retrieve", "where does Jane work", "--depth", "1"]);
    expect((r.out as { context: string }).context).toContain("Jane Doe -[WORKS_AT]-> Acme");
  });

  it("exits 2 for validation errors and 1 for other SelfGraph errors", () => {
    const missing = cli([...GLOBAL, "entity", "delete", "person:nobody"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Entity 'person:nobody' does not exist");
    const badRef = cli([...GLOBAL, "relation", "create", "person:jane-doe", "KNOWS", "person:nobody"]);
    expect(badRef.code).toBe(2);
    expect(cli([...GLOBAL, "retrieve", "x", "--depth", "lots"]).code).toBe(2);
    expect(cli(["--store", "kuzu-nope", "init"]).code).toBe(2);
  });
});

describe.skipIf(!neo4jUp)("built MCP server over stdio", () => {
  it("lists the tools and serves calls", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, ...GLOBAL, "mcp"] });
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "create_decision",
          "create_entity",
          "create_preference",
          "create_relation",
          "delete_decision",
          "delete_entity",
          "delete_preference",
          "delete_relation",
          "entity_evidence",
          "get_decision",
          "get_entity",
          "get_preference",
          "get_relation",
          "get_schema",
          "insert_ontology",
          "insert_text",
          "list_decisions",
          "list_entities",
          "list_preferences",
          "list_relations",
          "preference_versions",
          "relation_evidence",
          "relation_versions",
          "retrieve",
          "run_cypher",
          "update_decision",
          "update_entity",
          "update_preference",
          "update_relation",
        ].sort(),
      );
      const created = await client.callTool({ name: "create_entity", arguments: { name: "Mcp Bot", type: "Agent" } });
      expect(created.isError).toBeFalsy();
      expect(created.structuredContent).toMatchObject({ id: "agent:mcp-bot" });
      const got = await client.callTool({ name: "get_entity", arguments: { id: "agent:mcp-bot" } });
      expect(JSON.parse((got.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ name: "Mcp Bot" });
      const missing = await client.callTool({ name: "delete_entity", arguments: { id: "agent:nobody" } });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toEqual({
        error: "Entity 'agent:nobody' does not exist",
        error_type: "NotFoundError",
      });
      const write = await client.callTool({ name: "run_cypher", arguments: { query: "MATCH (n) DETACH DELETE n" } });
      expect(write.isError).toBe(true);
      expect((write.structuredContent as { error_type: string }).error_type).toBe("ValidationError");
      const read = await client.callTool({
        name: "run_cypher",
        arguments: { query: "MATCH (n:Entity) WHERE n.ns = $ns RETURN count(n) AS c", params: { ns } },
      });
      expect(read.structuredContent).toMatchObject({ columns: ["c"] });
      const versions = await client.callTool({ name: "relation_versions", arguments: { id: "relation:none" } });
      expect(versions.structuredContent).toEqual({ result: [] });
    } finally {
      await client.close();
    }
  });
});
