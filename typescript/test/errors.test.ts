import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  connectionReason,
  escapeControls,
  HINTS,
  internalError,
  SelfGraphError,
  WARNING_HINTS,
} from "../src/errors.js";
import {
  Extraction,
  FalkorDBStore,
  HydraDBStore,
  Neo4jStore,
  NotFoundError,
  SelfGraph,
  StoreError,
  TransientError,
} from "../src/index.js";
import { Lazy } from "../src/internal/lazy.js";
import { buildLlmClient } from "../src/llm/index.js";
import { TOOLS } from "../src/mcp.js";
import { parseOrThrow } from "../src/models.js";
import { checkSettings, settingsFromEnv } from "../src/runtime.js";
import { decodeEntity } from "../src/serde.js";
import { kuzuError } from "../src/stores/kuzu.js";
import { errorLinks, freshGraphs, KUZU_SPEC } from "./helpers.js";

const DOCS = readFileSync(new URL("../../docs/errors.md", import.meta.url), "utf8");
const CLOSED_PORT = "bolt://127.0.0.1:1";
const PEOPLE = {
  entities: [
    { name: "Ada", type: "Person" },
    { name: "Acme", type: "Company" },
    { name: "Globex", type: "Company" },
  ],
};
const WORKS_AT = { from_entity: "person:ada", type: "WORKS_AT" };

/**
 * The code of the SelfGraphError a call throws.
 *
 * @param call (() => unknown): the call.
 * @return (Promise<string | null>): the code, or null when nothing was thrown.
 */
async function codeOf(call: () => unknown): Promise<string | null> {
  try {
    await call();
  } catch (exc) {
    if (exc instanceof SelfGraphError) return exc.code;
    throw exc;
  }
  return null;
}

/**
 * Throw the error a mapping function returned.
 *
 * @param exc (unknown): the error.
 */
function raise(exc: unknown): never {
  throw exc;
}

/**
 * Call an LLM provider through a local server that answers every request with one HTTP status.
 *
 * @param status (number): the status.
 * @return (Promise<void>): resolves when the call returns; rejects with its error.
 */
async function callProvider(status: number): Promise<void> {
  const server = createServer((_req, res) => res.writeHead(status, { "Content-Type": "application/json" }).end("{}"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const base_url = `http://127.0.0.1:${port}`;
    const llm = buildLlmClient({ provider: "openai", model: "m", api_key: "k", base_url, max_retries: 0 });
    await llm.generate({ system: "", user: "x", output: z.object({ ok: z.boolean() }) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * The first paragraph of each code section between two second-level headings of docs/errors.md.
 *
 * @param start (string): the heading the sections follow.
 * @param end (string): the heading after them.
 * @return (Record<string, string>): the paragraph by code, as one line of text.
 */
function sections(start: string, end: string): Record<string, string> {
  const part = DOCS.slice(DOCS.indexOf(`\n## ${start}\n`), DOCS.indexOf(`\n## ${end}\n`));
  const found = part.matchAll(/^#### `(\w+)`\n\n([\s\S]*?)(?=\n\n|\n#|$(?![\s\S]))/gm);
  return Object.fromEntries([...found].map((m) => [m[1]!, m[2]!.split(/\s+/).join(" ").trim()]));
}

it.each(["list", "map"])("reports result depth as a coded error for %s", async (kind) => {
  const { checkResultDepth } = await import("../src/models.js");
  let value: unknown = 1;
  for (let depth = 0; depth < 254; depth++) value = kind === "list" ? [value] : { a: value };
  checkResultDepth([{ x: value }]);
  value = kind === "list" ? [value] : { a: value };
  expect(() => checkResultDepth([{ x: value }])).toThrowError(
    expect.objectContaining({
      code: "invalid_argument",
      field: "rows",
      message: "run_cypher result exceeds the maximum nesting depth of 254",
    }),
  );
});

describe("error codes", () => {
  const open = freshGraphs(KUZU_SPEC, "codes");

  it("documents every code, with its hint as the first paragraph of its section", () => {
    expect(sections("Codes", "Messages")).toEqual(HINTS);
    expect(sections("Warning codes", "Warnings and logging")).toEqual(WARNING_HINTS);
  });

  it("raises every code from a real call", async () => {
    const g = open();
    const gs = open({
      schema: { relations: [{ type: "WORKS_AT", from: { types: ["Person"], max_count: 1 } }] },
      contradiction: "supersede",
    });
    const closedGraph = new SelfGraph(new HydraDBStore(CLOSED_PORT, { auth: "token" }));
    const closedStore = new HydraDBStore(CLOSED_PORT, { auth: "token" });
    await g.insert.facts(PEOPLE);
    await g.entities.create("Augusta", "Person", { aliases: ["Augusta Ada"] });
    const merged = await g.insert.facts({
      entities: [{ name: "Augusta Ada", type: "Person" }],
      relations: [{ ...WORKS_AT, from_entity: "person:augusta-ada", to_entity: "company:acme" }],
    });
    const mergeId = merged.merges[0]!.id;
    const moved = merged.relations[0]!.id;
    await g.relations.certify(moved, { by: "test" });
    const codes: Record<string, string | null> = {
      relation_certified: await codeOf(() => g.entities.unmerge(mergeId)),
    };
    await g.relations.uncertify(moved);
    await g.entities.unmerge(mergeId);
    await gs.insert.facts({
      ...PEOPLE,
      relations: [{ ...WORKS_AT, to_entity: "company:acme", event_time: "2024-01-01" }],
    });
    const retired = (await gs.relations.list()).items[0]!.id;
    await gs.insert.facts({ relations: [{ ...WORKS_AT, to_entity: "company:globex", event_time: "2025-01-01" }] });
    await closedGraph.close();
    await closedStore.close();
    const hydradb = new HydraDBStore(CLOSED_PORT, { auth: "token" });
    const noToken = new HydraDBStore(CLOSED_PORT);
    const mapError = (store: HydraDBStore, code: string, message: string) =>
      raise(
        (store as unknown as { error(exc: unknown): StoreError }).error(Object.assign(new Error(message), { code })),
      );
    const busy = new FalkorDBStore();
    Object.assign(busy, {
      connection: new Lazy(async () => ({ graph: { query: () => Promise.reject(new Error("Query timed out")) } })),
    });
    const strict = { schema: { entities: [{ name: "Person" }] }, schema_mode: "strict" as const };
    const failing = { generate: () => Promise.reject(new Error("boom")) };
    const resolver = { resolve: async () => ({ target_id: "person:nobody", confidence: 1, reason: "test" }) };
    const triggers: Record<string, () => unknown> = {
      invalid_argument: () => g.entities.list({ limit: 0 }),
      unknown_key: () => parseOrThrow(Extraction, { entities: [{ name: "A", type: "Person", bogus: 1 }] }, "facts"),
      invalid_setting: () => checkSettings(settingsFromEnv({ store: "bogus" }, {})),
      llm_required: () => checkSettings(settingsFromEnv({ level: "max" }, {})),
      embedder_required: () => new SelfGraph(g.store, { seeds: "embeddings" }),
      schema_required: () => checkSettings(settingsFromEnv({ schema_mode: "strict" }, {})),
      schema_violation: () => g.insert.facts({ entities: [{ name: "Bo", type: "Robot" }] }, strict),
      immutable_identity: () => g.entities.update("person:ada", { type: "Robot" }),
      unknown_reference: () => g.relations.create("person:ada", "KNOWS", "person:nobody"),
      relation_invalidated: () => gs.relations.certify(retired, { by: "test" }),
      merge_reverted: () => g.entities.unmerge(mergeId),
      invalid_cursor: () => g.entities.list({ cursor: "bogus" }),
      invalid_resolver_decision: () =>
        g.insert.facts({ entities: [{ name: "Cy", type: "Person" }] }, { resolver: resolver as never }),
      read_only_query: () => TOOLS.find((t) => t.name === "run_cypher")!.run(g, { query: "CREATE (n)" } as never),
      cypher_query_limit: () => g.runCypher(`RETURN 1 // ${" ".repeat(65_536)}`),
      missing_package: () =>
        buildLlmClient({ provider: "cerebras", model: "m", api_key: "k" }).generate({
          system: "",
          user: "x",
          output: z.object({ ok: z.boolean() }),
        }),
      not_found: () => g.entities.delete("person:nobody"),
      already_exists: () => g.entities.create("Ada", "Person"),
      extraction_failed: () => new SelfGraph(g.store, { llm: failing }).insert.text("Ada."),
      llm_auth_failed: () => callProvider(401),
      llm_model_not_found: () => callProvider(404),
      invalid_llm_output: () =>
        new SelfGraph(g.store, { llm: { generate: async () => ({ nothing: 1 }) } }).insert.text("Ada."),
      invalid_prompt_template: () =>
        new SelfGraph(g.store, { prompts: { entities: { version: "v1", system: "s", user: "no placeholder" } } }),
      invalid_stored_data: () => decodeEntity({ id: "person:broken", ns: "codes" }),
      query_failed: () => g.runCypher("RETURN ("),
      inexact_value: () => g.runCypher("RETURN cast('-0.05' AS DECIMAL(5,2))"),
      graph_closed: () => closedGraph.entities.list(),
      store_closed: () => new SelfGraph(closedStore).entities.list(),
      store_unreachable: () => new SelfGraph(new Neo4jStore(CLOSED_PORT, { auth: ["neo4j", "pw"] })).entities.list(),
      store_locked: () => raise(kuzuError(new Error("IO exception: Could not set lock on file : g"), "x")),
      store_auth_failed: () => mapError(noToken, "Neo.ClientError.Security.Unauthorized", ""),
      database_not_found: () => mapError(hydradb, "", "database does not exist"),
      wrong_engine: () => mapError(hydradb, "", "unsupported protocol version"),
      write_too_large: () => hydradb.upsertNode("n", "Entity", "x", { id: "x", blob: "x".repeat(3_000_000) }),
      write_conflict: () => mapError(hydradb, "", "transaction conflict"),
      store_busy: () => busy.runCypher("RETURN 1"),
      internal_error: () => raise(internalError(new Error("boom"))),
    };
    for (const [code, call] of Object.entries(triggers)) codes[code] = await codeOf(call);
    expect(codes).toEqual(Object.fromEntries(Object.keys(HINTS).map((code) => [code, code])));
  }, 60_000);

  it("reads a failed connection in plain words", () => {
    const bolt = (cause: string) => new Error(`Failed to connect to server. Caused by: ${cause}`);
    expect([
      connectionReason(bolt("getaddrinfo ENOTFOUND nohost.invalid")),
      connectionReason(bolt("connect ECONNREFUSED 127.0.0.1:1")),
    ]).toEqual(["host not found", "connection refused"]);
  });

  it("escapes control characters in a failed query", async () => {
    expect(escapeControls("a\x1b[2Jb\nc\td\x00\x7f\x85e")).toBe("a\\x1b[2Jb\\nc\\td\\x00\\x7f\\x85e");
    expect(escapeControls("a\u202eb")).toBe("a\\u202eb");
    expect(escapeControls("a\u200bb\u200cc\u200dd\ufeffe")).toBe("a\\u200bb\\u200cc\\u200dd\\ufeffe");
    expect(escapeControls("a\u2066b\u2069c")).toBe("a\\u2066b\\u2069c");
    expect(escapeControls("hello world")).toBe("hello world");
    const detail = kuzuError(new Error("a\tb  c\x85d\u202ee"), "Kuzu query failed");
    expect(detail.message).toBe("Kuzu query failed: a\\tb c\\x85d\\u202ee");
    expect(detail.message).not.toContain("\t");
    expect(detail.message).not.toContain("\x85");
    expect(detail.message).not.toContain("\u202e");
    const g = open();
    try {
      await g.runCypher("RETURN (\x1b[2J");
      expect.unreachable();
    } catch (exc) {
      const err = exc as SelfGraphError;
      expect(err.code).toBe("query_failed");
      expect(err.message).not.toContain("\x1b");
      expect(err.message).toContain("\\x1b");
    }
  });

  it("carries the code, hint, retryability, and both docs links", () => {
    expect(new NotFoundError("Entity", "person:nobody").toJSON()).toEqual({
      error: "Entity 'person:nobody' does not exist",
      error_type: "NotFoundError",
      code: "not_found",
      retryable: false,
      ...errorLinks("not_found"),
    });
    expect([new TransientError().retryable, new StoreError().retryable]).toEqual([true, false]);
  });

  it("names the namespace and the closest id of the type for a missing entity", async () => {
    const g = open();
    await g.insert.facts({
      entities: [
        { name: "Ada", type: "Person" },
        { name: "Acme", type: "Company" },
      ],
    });
    await expect(g.entities.update("person:ad", { name: "Ad" })).rejects.toThrow(
      `Entity 'person:ad' does not exist in namespace '${g.namespace}'; did you mean 'person:ada'?`,
    );
    await expect(g.entities.delete("person:zzzz")).rejects.toThrow(
      new RegExp(`^Entity 'person:zzzz' does not exist in namespace '${g.namespace}'$`),
    );
    await g.insert.facts({
      entities: [
        { name: "Belxy", type: "Person" },
        { name: "Kelvo", type: "Person" },
      ],
    });
    await expect(g.entities.delete("person:belvo")).rejects.toThrow(/; did you mean 'person:kelvo'\?$/);
    const filler = Array.from({ length: 500 }, (_, i) => ({
      name: `A${String(i).padStart(3, "0")}`,
      type: "Person",
    }));
    await g.insert.facts({ entities: filler });
    await g.insert.facts({ entities: [{ name: "Zelda", type: "Person" }] });
    for (const typo of ["person:zeld", "person:zalda"]) {
      await expect(g.entities.delete(typo)).rejects.toThrow(/; did you mean 'person:zelda'\?$/);
    }
  });

  it.each([
    [{ entities: [{ name: "Ada", type: "Person", bogus: 1 }] }, "unknown_key", "entities[0].bogus"],
    [{ entities: [{ type: "Person" }] }, "invalid_argument", "entities[0].name"],
  ] as const)("names the field at fault in %o", (facts, code, field) => {
    expect(() => parseOrThrow(Extraction, facts, "facts")).toThrow(expect.objectContaining({ code, field }));
  });

  it.each([
    [{ store: "bogus" }, "invalid_setting", "store"],
    [{ level: "max" }, "llm_required", undefined],
    [{ schema_mode: "strict" }, "schema_required", undefined],
    [{ llm_timeout: "-1" }, "invalid_setting", "llm_timeout"],
  ] as const)("fails settings %o with %s", (overrides, code, field) => {
    expect(() => checkSettings(settingsFromEnv(overrides, {}))).toThrow(expect.objectContaining({ code, field }));
  });
});
