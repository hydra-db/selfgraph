import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildParser } from "../src/cli.js";
import { buildGraph } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import { DEFAULT_SETTINGS, type GraphSettings, settingsFromEnv, storeKind } from "../src/runtime.js";
import { buildCli, runCli } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "sg-cli-"));

function cli(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const env = { SELFGRAPH_STORE: "", SELFGRAPH_URI: "", SELFGRAPH_NAMESPACE: "default", ...options.env };
  return runCli(args, { input: options.input, env });
}

beforeAll(buildCli);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("built CLI against Kuzu", () => {
  const kuzu = ["--store", "kuzu", "--uri", join(dir, "cli.kuzu")];

  it("prints the inferred store from init", () => {
    const res = cli(["init"], { env: { HOME: join(dir, "home"), SELFGRAPH_NAMESPACE: "" } });
    expect(res.code).toBe(2);
    expect(res.err).toContain("namespace must be a non-empty string");
    const ok = cli(["init"], { env: { HOME: join(dir, "home") } });
    expect(ok.code).toBe(0);
    expect(ok.out).toEqual({ ok: true, store: "kuzu", namespace: "default" });
  });

  it("rejects an empty or blank --namespace", () => {
    for (const ns of ["", "  "]) {
      const res = cli([...kuzu, "--namespace", ns, "init"]);
      expect(res.code).toBe(2);
      expect(res.err).toContain("namespace must be a non-empty string");
    }
  });

  it("reads insert text '-' from stdin with an event time", () => {
    const res = cli([...kuzu, "insert", "text", "-", "--event-time", "2024-01-02T03:04:05+00:00"], {
      input: "Acme Corp hired Jane Doe.",
    });
    expect(res.code).toBe(0);
    const out = res.out as { entities: Array<{ name: string }>; relations: Array<{ event_time: string }> };
    expect(out.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["Acme Corp", "Jane Doe"]));
    expect(out.relations.length).toBeGreaterThan(0);
    for (const r of out.relations) expect(r.event_time).toBe("2024-01-02T03:04:05Z");
  });

  it("sets decision event time and alternatives on create and update", () => {
    for (const name of ["a", "b", "c"]) cli([...kuzu, "entity", "create", "--name", name, "--type", "T"]);
    cli([...kuzu, "relation", "create", "t:a", "KNOWS", "t:b", "--id", "relation:r1"]);
    const created = cli([
      ...kuzu,
      "decision",
      "create",
      "D",
      "--id",
      "decision:d1",
      "--step",
      "relation:r1",
      "--alternative",
      "t:c",
      "--event-time",
      "2024-05-06T00:00:00+00:00",
    ]);
    expect(created.out).toMatchObject({ alternative_entities: ["t:c"], event_time: "2024-05-06T00:00:00Z" });
    const updated = cli([
      ...kuzu,
      "decision",
      "update",
      "decision:d1",
      "--alternative",
      "t:a",
      "--alternative",
      "t:b",
      "--event-time",
      "2023-01-01T00:00:00+00:00",
    ]);
    expect(updated.out).toMatchObject({ alternative_entities: ["t:a", "t:b"], event_time: "2023-01-01T00:00:00Z" });
    const titled = cli([...kuzu, "decision", "update", "decision:d1", "--title", "D2"]);
    expect(titled.out).toMatchObject({ alternative_entities: ["t:a", "t:b"], event_time: "2023-01-01T00:00:00Z" });
  });

  it("pages through entity and relation evidence", () => {
    const ns = ["--namespace", "cli_evidence"];
    const ontology = JSON.stringify({
      entities: [
        { name: "A", type: "T", id: "t:a" },
        { name: "B", type: "T", id: "t:b" },
      ],
      relations: [{ id: "relation:ab", from_entity: "t:a", type: "KNOWS", to_entity: "t:b" }],
    });
    for (const source of ["s1", "s2"]) {
      expect(cli([...kuzu, ...ns, "insert", "ontology", "-", "--source-id", source], { input: ontology }).code).toBe(0);
    }
    type EvidencePage = { items: Array<{ source_id: string }>; next_cursor: string | null };
    const first = cli([...kuzu, ...ns, "entity", "evidence", "t:a", "--limit", "1"]).out as EvidencePage;
    const rest = cli([...kuzu, ...ns, "entity", "evidence", "t:a", "--cursor", first.next_cursor!]).out as EvidencePage;
    expect([...first.items, ...rest.items].map((e) => e.source_id).sort()).toEqual(["s1", "s2"]);
    const rel = cli([...kuzu, ...ns, "relation", "evidence", "relation:ab"]).out as EvidencePage;
    expect(rel.items.map((e) => e.source_id).sort()).toEqual(["s1", "s2"]);
  });
});

describe("CLI settings", () => {
  it("rejects an empty or blank namespace and defaults an unset one", () => {
    const neo4j: GraphSettings = { ...DEFAULT_SETTINGS, store: "neo4j", uri: "bolt://localhost:7687" };
    for (const namespace of ["", "   "]) {
      expect(() => buildGraph({ ...neo4j, namespace })).toThrow(ValidationError);
    }
    const fromEnv = settingsFromEnv({ store: "neo4j", uri: "bolt://localhost:7687" }, { SELFGRAPH_NAMESPACE: "" });
    expect(() => buildGraph(fromEnv)).toThrow(/namespace must be a non-empty string/);
    expect(buildGraph({ ...neo4j, namespace: undefined as never }).namespace).toBe("default");
  });

  it("resolves the store kind", () => {
    expect(storeKind({ ...DEFAULT_SETTINGS })).toBe("kuzu");
    expect(storeKind({ ...DEFAULT_SETTINGS, uri: "bolt://x:1" })).toBe("hydradb");
    expect(storeKind({ ...DEFAULT_SETTINGS, store: "Neo4j", uri: "bolt://x:1" })).toBe("neo4j");
  });

  it("passes FalkorDB credentials and the graph name from settings", () => {
    const built = (over: Partial<GraphSettings>) => {
      const store = buildGraph({ ...DEFAULT_SETTINGS, store: "falkordb", ...over }).store as unknown as {
        host: string;
        port: number;
        graphName: string;
        clientOptions: Record<string, unknown>;
      };
      return [store.host, store.port, store.graphName, store.clientOptions];
    };
    expect(built({ uri: "db:6390" })).toEqual(["db", 6390, "selfgraph", {}]);
    expect(built({ uri: "db:6390", auth: "u:p w", database: "g1" })).toEqual([
      "db",
      6390,
      "g1",
      { username: "u", password: "p w" },
    ]);
    expect(built({ uri: "db", auth: "tok" })).toEqual(["db", 6379, "selfgraph", { password: "tok" }]);
    expect(built({ uri: "redis://u:p%40w@db:6390" })).toEqual([
      "db",
      6390,
      "selfgraph",
      { username: "u", password: "p@w" },
    ]);
    expect(built({ uri: "redis://u:bad@db:6390", auth: "v:ok" })[3]).toEqual({ username: "v", password: "ok" });
  });

  it("prints each option default once", () => {
    const retrieve = buildParser().commands.find((c) => c.name() === "retrieve")!;
    const help = retrieve.helpInformation();
    expect(help).toContain("(default: 3)");
    expect(help).not.toMatch(/\(default \d+\)/);
  });
});
