import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildParser, main } from "../src/cli.js";
import { buildGraph, SelfGraph } from "../src/client.js";
import { surfaceHint, ValidationError, WARNING_HINTS } from "../src/errors.js";
import { pyRepr } from "../src/internal/py.js";
import { checkLlmConfig } from "../src/llm/index.js";
import {
  bindParams,
  buildLlm,
  checkSettings,
  DEFAULT_SETTINGS,
  type GraphSettings,
  parseTime,
  settingsFromEnv,
  storeKind,
  version,
} from "../src/runtime.js";
import {
  A_KNOWS_B,
  ANN_AT_ACME,
  buildCli,
  CLI,
  captureWarnings,
  cliError,
  runCli,
  SINGLE_EMPLOYER,
  tempDir,
} from "./helpers.js";

const dir = tempDir("sg-cli-");

const ENV = { SELFGRAPH_STORE: "", SELFGRAPH_URI: undefined, SELFGRAPH_NAMESPACE: "default" };

function cli(args: string[], options: { input?: string; env?: Record<string, string | undefined> } = {}) {
  return runCli(args, { ...options, env: { ...ENV, ...options.env } });
}

beforeAll(buildCli);

describe("built CLI against Kuzu", () => {
  it.each([
    ["--store", "bogus", "entity", "list"],
    ["--store", "kuzu", "--uri", ":memory:", "entity", "list", "--limit", "x"],
    ["--store", "kuzu", "--uri", ":memory:", "retrieve", "Ada", "--k", "1.5"],
    ["--store", "kuzu", "--uri", ":memory:", "diff", "--since", "nope"],
    ["--store", "kuzu", "--uri", ":memory:", "preference", "create", "--stance", "bogus"],
  ])("reports a coded error for %j", (...args) => {
    const result = cli(args as string[]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/^error\[(invalid_argument|invalid_setting)\]: /);
    expect(result.err).toContain("field: ");
    expect(result.err).not.toContain("Usage:");
  });

  const kuzu = ["--store", "kuzu", "--uri", join(dir, "cli.kuzu")];
  const seed = (ns: string[], ...names: string[]) => {
    for (const name of names) cli([...kuzu, ...ns, "entity", "create", "--name", name, "--type", "T"]);
  };

  it("reports a non-UTF-8 input file with a coded error", () => {
    const bad = join(dir, "bad-schema.json");
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x7b]));

    const result = cli(["--schema", bad, ...kuzu, "entity", "list"]);

    expect(result.code).toBe(2);
    expect(result.err).toContain(
      `error[invalid_argument]: cannot read ${pyRepr(bad)}: not valid UTF-8; save the file as UTF-8 and try again`,
    );
    expect(result.err).toContain("field: path");
    expect(result.err).not.toContain("stack");
  });

  it("rejects proto keys supplied through property and external-id flags", () => {
    for (const flags of [
      ["--prop", "__proto__=1"],
      ["--prop", 'nested={"items":[{"__proto__":"x"}]}'],
      ["--external-id", "__proto__=x"],
    ]) {
      const result = cli([...kuzu, "entity", "create", "--name", "Proto", "--type", "Person", ...flags]);
      expect(result.code).toBe(2);
      expect(result.err).toContain("property and external id keys cannot be '__proto__'");
    }
  });

  it("stores a __proto__ metadata key that Python stores too", () => {
    const proto = cli([
      ...kuzu,
      "insert",
      "text",
      "Ada met Charles.",
      "--source-id",
      "s1",
      "--metadata",
      '{"__proto__":{"x":1},"a":1}',
    ]);
    expect(proto.code).toBe(0);
    const kvForm = cli([
      ...kuzu,
      "insert",
      "text",
      "Ada met Charles.",
      "--source-id",
      "s2",
      "--metadata",
      '__proto__={"x":1}',
      "--metadata",
      "a=1",
    ]);
    expect(kvForm.code).toBe(0);
    expect(proto.out).toMatchObject({ source_id: "s1" });
    expect(kvForm.out).toMatchObject({ source_id: "s2" });
  });

  it("prints diff summaries and JSON", () => {
    const ns = ["--namespace", "cli_diff"];
    seed(ns, "Ann", "Anvil");
    const rel = cli([...kuzu, ...ns, "relation", "create", "t:ann", "USES", "t:anvil"]).out as { id: string };
    cli([...kuzu, ...ns, "relation", "certify", rel.id, "--by", "alice"]);
    const pref = cli([...kuzu, ...ns, "preference", "create", "t:ann", "tool", "t:anvil"]).out as { id: string };
    const decision = cli([...kuzu, ...ns, "decision", "create", "Pick a tool"]).out as { id: string };
    const args = [...kuzu, ...ns, "diff", "--since", "1900-01-01", "--until", "2100-01-01"];
    const summary = cli(args);
    expect(summary.code).toBe(0);
    expect(summary.out).toContain("+ entity t:ann");
    expect(summary.out).toContain("Deletes and entity edits are not visible.");
    expect(summary.out).toContain(`* certified relation ${rel.id} revision 1`);
    expect(summary.out).toContain(`+ preference ${pref.id} revision 1: t:ann tool -> t:anvil`);
    expect(summary.out).toContain(`+ decision ${decision.id}: Pick a tool`);
    expect(summary.out).toContain(
      "2 entities created, 1 relations added, 0 revised, 0 retired, 1 certified, 0 uncertified, " +
        "1 preferences added, 0 revised, 1 decisions created, 0 updated, 0 merges, 0 unmerges, " +
        "0 source versions added",
    );
    const json = cli([...args, "--json"]);
    expect(json.code).toBe(0);
    expect(json.out).toMatchObject({
      entities_created: [{ id: "t:ann" }, { id: "t:anvil" }],
      relations_certified: [{ id: rel.id }],
      preferences_added: [{ id: pref.id }],
      decisions_created: [{ id: decision.id }],
      limitations: ["Deletes and entity edits are not visible."],
    });
  });

  it("reports an export filesystem error with a code, a field, and no traceback", () => {
    const ns = ["--namespace", "cli_export_error"];
    seed(ns, "Ada");
    const parent = join(dir, "notes");
    writeFileSync(parent, "not a directory");
    const target = join(parent, "nested");

    const result = cli([...kuzu, ...ns, "export", "obsidian", target]);

    expect(result.code).toBe(2);
    expect(result.err).toContain(
      `error[invalid_argument]: cannot write the vault to ${pyRepr(target)}: not a directory`,
    );
    expect(result.err).toContain("field: directory");
  });

  it("keeps proto and nested source metadata keys in diff JSON", async () => {
    const namespace = "cli_diff_proto";
    const text = '{"__proto__":"literal","nested":[{"__proto__":{"kept":true},"sibling":"kept"}]}';
    const g = buildGraph({ ...DEFAULT_SETTINGS, store: "kuzu", uri: kuzu[3]!, namespace });
    try {
      await g.insert.text("Ann works at Acme.", { source_id: "proto", metadata: JSON.parse(text) });
    } finally {
      await g.close();
    }
    const json = cli([...kuzu, "--namespace", namespace, "diff", "--since", "1900-01-01", "--json"]);
    expect(json.code).toBe(0);
    const versions = (json.out as { source_versions_added: { metadata: unknown }[] }).source_versions_added;
    expect(versions.map((v) => JSON.stringify(v.metadata))).toEqual([text]);
  });

  it("prints init, the version, and help, warning only about flags kuzu ignores", () => {
    const ok = cli(["init"], { env: { HOME: join(dir, "home") } });
    expect(ok.code).toBe(0);
    expect(ok.out).toEqual({ ok: true, store: "kuzu", namespace: "default" });
    for (const flag of ["--version", "-V"]) {
      const res = cli([flag]);
      expect([res.code, String(res.out).trim()]).toEqual([0, String(version)]);
    }
    const help = cli(["mcp", "--help"]);
    expect(help.out).toContain("--store");
    expect(help.out).toContain("--schema");
    expect(help.out).toContain("default: server default");
    expect(cli(["schema", "--help"]).out).toContain("null\nschema import");
    const init = cli([...kuzu, "--database", "x", "--auth", "u:p", "--resolver", "fuzzy", "init"]);
    expect(init.code).toBe(0);
    expect(init.err).toContain("warning: --database is ignored by store kuzu");
    expect(init.err).toContain("warning: --auth is ignored by store kuzu");
    const quiet = cli([...kuzu, "init"], { env: { SELFGRAPH_DATABASE: "x", SELFGRAPH_AUTH: "u:p" } });
    expect([quiet.code, quiet.err]).toEqual([0, ""]);
  });

  it("checks every setting and settings file before version and mcp, exiting 2", () => {
    const prompts = (user: string, version?: string) =>
      JSON.stringify({ entities: { system: "s", user, ...(version ? { version } : {}) } });
    for (const [args, env, message] of [
      [["--namespace", ""], {}, "namespace cannot be empty"],
      [["--namespace", "  "], {}, "namespace cannot be empty"],
      [[], { SELFGRAPH_NAMESPACE: "" }, "namespace cannot be empty"],
      [["--namespace", " x"], {}, "namespace cannot start or end with whitespace"],
      [["--llm-timeout", "0"], {}, "llm_timeout must be a positive number"],
      [["--llm-concurrency", "0"], {}, "llm_concurrency must be a positive integer, got '0'"],
      [
        ["--llm-concurrency", "++5"],
        {},
        "error[invalid_setting]: llm_concurrency must be a positive integer, got '++5'",
      ],
      [[], { SELFGRAPH_LLM_CONCURRENCY: "++5" }, "llm_concurrency must be a positive integer, got '++5'"],
      [["--llm-concurrency", "\u0665"], {}, "llm_concurrency must be a positive integer"],
      [[], { SELFGRAPH_LLM_CONCURRENCY: "99999999999999999999" }, "llm_concurrency must be a positive integer"],
      [["--llm-timeout", "1_0"], {}, "llm_timeout must be a positive number"],
      [["--llm-timeout", "0x10"], {}, "llm_timeout must be a positive number"],
      [[], { SELFGRAPH_LLM_TIMEOUT: "0b1" }, "llm_timeout must be a positive number"],
      [[], { SELFGRAPH_LLM_TIMEOUT: "\u0665" }, "llm_timeout must be a positive number"],
      [["--llm-provider", "gemini"], {}, "pass --llm-model"],
      [
        ["--llm-provider", "anthropic", "--llm-model", "gemini/x"],
        {},
        "error[invalid_setting]: llm_provider 'anthropic' conflicts with model prefix 'gemini'; " +
          "pass --llm-provider (or SELFGRAPH_LLM_PROVIDER) matching the model\n",
      ],
      [["--llm-provider", "nonesuch", "--llm-model", "m"], {}, "unknown LLM provider 'nonesuch'"],
      [["--llm-provider", "nonesuch"], {}, "an LLM needs a model"],
      [["--uri", ""], {}, "uri cannot be empty"],
      [[], { SELFGRAPH_URI: "" }, "uri cannot be empty"],
      [[], { SELFGRAPH_RESOLVER: "bogus" }, "resolver must be one of"],
      [[], { SELFGRAPH_SCHEMA_MODE: "bogus" }, "schema_mode must be one of"],
      [["--schema", '{"nodes": []}'], {}, "unknown key 'nodes' in schema"],
      [["--prompts", "/nonexistent/prompts.json"], {}, "cannot read '/nonexistent/prompts.json'"],
      [["--prompts", prompts("x", "1")], {}, "{text}"],
      [["--prompts", prompts("{text} {bogus}", "1")], {}, "unknown variable {bogus}"],
      [
        [],
        { SELFGRAPH_PROMPTS: prompts("{text}") },
        "error[invalid_argument]: invalid prompts: entities.version: field required\n",
      ],
      [["--instructions", "{nope"], {}, "invalid JSON in the inline instructions"],
      [["--instructions", join(dir, "nofile.json")], {}, "cannot read"],
      [["--uri", "graph.kuzu"], {}, "this looks like a Kuzu path; pass --store kuzu (or SELFGRAPH_STORE=kuzu)"],
      [["--store", "falkordb", "--uri", "bolt://h:6379"], {}, "the 'falkordb' store expects host:port or a redis://"],
    ] as Array<[string[], Record<string, string>, string]>) {
      for (const command of ["version", "mcp"]) {
        const res = cli([...args, command], { env });
        expect(res.code, `${args.join(" ")} ${command}`).toBe(2);
        expect(res.err).toContain(message);
      }
    }
  });

  it.each([
    ["30", 30],
    [" 1.5 ", 1.5],
    ["+2", 2],
    [".5", 0.5],
    ["5.", 5],
    ["1e1", 10],
    ["1E+1", 10],
  ])("reads the llm_timeout setting %j as %d seconds", (value, seconds) => {
    const settings = { ...DEFAULT_SETTINGS, llm_model: "openai/m", llm_timeout: value };
    expect(() => checkSettings(settings)).not.toThrow();
    expect(buildLlm(settings)?.timeout).toBe(seconds);
  });

  it.each([
    ["7", 7],
    [" 7 ", 7],
    ["+7", 7],
    ["007", 7],
    ["9007199254740991", 9007199254740991],
  ])("reads the llm_concurrency setting %j as %d chunks", (value, count) => {
    const settings = { ...DEFAULT_SETTINGS, llm_model: "openai/m", llm_concurrency: value };
    expect(() => checkSettings(settings)).not.toThrow();
    expect(buildLlm(settings)?.concurrency).toBe(count);
  });

  it.each([
    ...[
      "1_0",
      "\u0665",
      "\uff15",
      "0x10",
      "0b1",
      "0o7",
      "inf",
      "nan",
      "-5",
      "--5",
      "0",
      "1 0",
      "soon",
      "1e400",
      "1e-400",
    ].map((value) => ["llm_timeout", value, `llm_timeout must be a positive number of seconds, got ${pyRepr(value)}`]),
    ...[
      "++5",
      "+",
      "-1",
      "0",
      "\u0665",
      "\uff15",
      "99999999999999999999",
      "9007199254740992",
      "1_0",
      "5.0",
      "1e3",
      "0x10",
      "x",
    ].map((value) => ["llm_concurrency", value, `llm_concurrency must be a positive integer, got ${pyRepr(value)}`]),
  ])("rejects the %s setting %j with invalid_setting from the API and the environment", (setting, value, message) => {
    for (const settings of [
      { ...DEFAULT_SETTINGS, [setting]: value },
      settingsFromEnv({}, { [`SELFGRAPH_${setting.toUpperCase()}`]: value }),
    ]) {
      expect(() => checkSettings(settings)).toThrow(
        expect.objectContaining({ code: "invalid_setting", field: setting, message }),
      );
    }
  });

  it("exits 2 for an invalid_setting raised as a StoreError, and 1 for a missing id", () => {
    const setting = cli(["--store", "hydradb", "--uri", "http://127.0.0.1:1", "entity", "list"]);
    expect(setting.code).toBe(2);
    expect(setting.err).toMatch(/^error\[invalid_setting\]: /);
    const missing = cli([...kuzu, "entity", "get", "person:none"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^error\[not_found\]: /);
  });

  it("keeps NaN and Infinity flag values as text, since they are not JSON", () => {
    const ns = ["--namespace", "nan_flags"];
    const props = ["--prop", "a=NaN", "--prop", "b=Infinity", "--prop", "c=-Infinity"];
    const created = cli([...kuzu, ...ns, "entity", "create", "--name", "A", "--type", "T", ...props]);
    expect(created.code).toBe(0);
    expect(created.out).toMatchObject({ properties: { a: "NaN", b: "Infinity", c: "-Infinity" } });
  });

  it("rejects llm tiers before version and mcp unless the cap or an llm removes them", () => {
    const cleared = {
      SELFGRAPH_LLM_PROVIDER: undefined,
      SELFGRAPH_LLM_MODEL: undefined,
      SELFGRAPH_LEVEL: undefined,
      SELFGRAPH_MAX_TIER: undefined,
      SELFGRAPH_RESOLVER: undefined,
      SELFGRAPH_CONTRADICTION: undefined,
    };
    for (const [args, message] of [
      [["--level", "max"], "level 'max' needs an LLM"],
      [["--resolver", "llm"], "resolver 'llm' needs an LLM"],
      [["--contradiction", "llm"], "contradiction 'llm' needs an LLM"],
    ] as Array<[string[], string]>) {
      const res = cli([...args, "version"], { env: cleared });
      expect(res.code, args.join(" ")).toBe(2);
      expect(res.err).toContain(message);
    }
    const strict = cli(["--schema-mode", "strict", "version"], { env: cleared });
    expect([strict.code, strict.err]).toEqual([2, expect.stringContaining("schema_mode 'strict' needs a schema")]);
    expect(cli(["--level", "max", "--max-tier", "light", "version"], { env: cleared }).code).toBe(0);
    const llm = { SELFGRAPH_LLM_PROVIDER: "openai", SELFGRAPH_LLM_MODEL: "gpt-4o-mini" };
    for (const args of [
      ["--level", "max"],
      ["--resolver", "llm"],
      ["--contradiction", "llm"],
    ]) {
      expect(cli([...args, "version"], { env: llm }).code, args.join(" ")).toBe(0);
    }
    const env = { ...process.env };
    for (const key of Object.keys(cleared)) delete env[key];
    const mcp = spawnSync(process.execPath, [CLI, "--level", "max", "mcp"], { encoding: "utf8", timeout: 3000, env });
    expect(mcp.status).toBe(2);
    expect(mcp.stderr).toContain("level 'max' needs an LLM");
  });

  it("exits 2 on bad command input with a message in CLI words", () => {
    const noLlm = { SELFGRAPH_LLM_PROVIDER: "", SELFGRAPH_LLM_MODEL: "", SELFGRAPH_RESOLVER: "" };
    for (const [args, message, env] of [
      [["retrieve", "x", "--depth", "abc"], "--depth expects an integer, got 'abc'"],
      [["retrieve", "x", "--depth", "-1", "--k", "0", "--budget-tokens", "0"], "depth must be >= 0, got -1"],
      [["retrieve", "x", "--k", "0"], "k must be >= 1, got 0"],
      [["insert", "facts", join(dir, "nofile.json")], "cannot read"],
      [["insert", "text", ""], "text cannot be empty or whitespace"],
      [["insert", "text", "  "], "text cannot be empty or whitespace"],
      [["insert", "text", "Ann.", "--metadata", "nope"], "--metadata expects KEY=VALUE, got 'nope'"],
      [["insert", "text", "Ann.", "--metadata", "{notjson"], "invalid JSON in --metadata"],
      [["insert", "text", "Ann.", "--metadata", '{"n": Infinity}'], "invalid JSON in --metadata"],
      [
        ["entity", "create", "--name", "a", "--type", "T", "--prop", '{"x":1}'],
        `--prop expects KEY=VALUE, got '{"x":1}'`,
      ],
      [["entity", "get", "t:a", "--bogus"], "Usage: selfgraph entity get"],
      [["relations"], "unknown command 'relations'"],
      [["query", "RETURN $a AS a, '$b' AS b"], "missing parameter $a"],
      [["maintenance", "decay", "--now", "soon"], "invalid now: 'soon' is not an ISO 8601 date or time"],
      [["maintenance", "prune"], "prune needs min_relevance or older_than"],
      [["maintenance", "prune", "--older-than", "2999-01-01"], "older_than 2999-01-01T00:00:00Z is in the future"],
      [["schema", "export", "--to", "neo4j"], "no schema set; pass --schema FILE or SELFGRAPH_SCHEMA"],
      [["--schema-mode", "strict", "entity", "list"], "schema_mode 'strict' needs a schema"],
      [["--resolver", "fuzzier", "init"], "--resolver got 'fuzzier'; choose from exact, default, fuzzy, llm"],
      [["--resolver", "llm", "entity", "list"], "pass --llm-provider and --llm-model (or SELFGRAPH_LLM_*)", noLlm],
    ] as Array<[string[], string, Record<string, string>?]>) {
      const res = cli([...kuzu, ...args], { env });
      expect([res.code, res.err], args.join(" ")).toEqual([2, expect.stringContaining(message)]);
      expect(res.err).not.toMatch(/isoformat|SelfGraph options/);
    }
    expect(cli([...kuzu, "retrieve", "x", "--k", "0"]).err).toBe(
      cliError("invalid_argument", "k must be >= 1, got 0", "selfgraph retrieve", "k"),
    );
    const bad = cli([...kuzu, "insert", "facts", "-"], {
      input: JSON.stringify({ entities: [{ type: "P" }, { name: 3, type: "P" }] }),
    });
    expect(bad.err).toBe(
      cliError(
        "invalid_argument",
        "invalid facts:\n  entities[0].name: field required\n  entities[1].name: expected string",
        "selfgraph insert facts",
        "entities[0].name",
      ),
    );
  });

  it("fails get of a missing id like delete", () => {
    for (const resource of ["entity", "relation", "preference", "decision"]) {
      const missing = resource === "entity" ? "x:missing" : `${resource}:missing`;
      const res = cli([...kuzu, resource, "get", missing]);
      expect(res.code).toBe(1);
      expect(res.out).toBe("");
      expect(res.err).toContain(`'${missing}' does not exist`);
      for (const action of resource === "entity" ? [] : ["get", "delete"]) {
        const bad = cli([...kuzu, resource, action, "my-id"]);
        expect(bad.code).toBe(2);
        expect(bad.err).toContain(`${resource} id must start with '${resource}:', got 'my-id'`);
      }
    }
  });

  it("reads insert text '-' from stdin and dates text and facts inserts with an event time", () => {
    const res = cli([...kuzu, "insert", "text", "-", "--event-time", "2024-01-02T03:04:05+00:00"], {
      input: "Acme Corp hired Jane Doe.",
    });
    expect(res.code).toBe(0);
    const out = res.out as { entities: Array<{ name: string }>; relations: Array<{ event_time: string }> };
    expect(out.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["Acme Corp", "Jane Doe"]));
    expect(out.relations.length).toBeGreaterThan(0);
    for (const r of out.relations) expect(r.event_time).toBe("2024-01-02T03:04:05Z");
    const facts = cli([...kuzu, "--namespace", "cli_dated", "insert", "facts", "-", "--event-time", "2020-05-01"], {
      input: JSON.stringify(A_KNOWS_B),
    }).out as { relations: Array<{ event_time: string }> };
    expect(facts.relations[0]!.event_time).toBe("2020-05-01T00:00:00Z");
    const basic = cli([...kuzu, "--namespace", "cli_dated", "insert", "text", "Acme acquired Globex."], {
      env: { SELFGRAPH_LLM_PROVIDER: "", SELFGRAPH_LLM_MODEL: "" },
    });
    expect(basic.err).toContain("for model-based extraction, pass --llm-provider and --llm-model");
    expect(JSON.stringify(basic.out)).not.toContain("SelfGraph options");
  });

  it("sets, keeps, and clears decision fields, and rejects empty updates", () => {
    const ns = ["--namespace", "cli_update"];
    seed(ns, "a", "b", "c");
    const rel = (cli([...kuzu, ...ns, "relation", "create", "t:a", "KNOWS", "t:b"]).out as { id: string }).id;
    const pref = (cli([...kuzu, ...ns, "preference", "create", "t:a", "likes", "t:b"]).out as { id: string }).id;
    const decision = (...args: string[]) => cli([...kuzu, ...ns, "decision", ...args]);
    const update = (...args: string[]) => decision("update", "decision:d", ...args);
    const created = decision(
      ...["create", "D", "--id", "decision:d", "--step", rel, "--summary", "s", "--rationale", "r", "--actor", "t:a"],
      ...["--alternative", "t:c", "--event-time", "2024-05-06T00:00:00+00:00"],
    );
    expect(created.out).toMatchObject({ alternative_entities: ["t:c"], event_time: "2024-05-06T00:00:00Z" });
    const moved = { alternative_entities: ["t:a", "t:b"], event_time: "2023-01-01T00:00:00Z" };
    const event = ["--event-time", "2023-01-01T00:00:00+00:00"];
    expect(update("--alternative", "t:a", "--alternative", "t:b", ...event).out).toMatchObject(moved);
    expect(update("--title", "D2").out).toMatchObject(moved);
    for (const args of [
      ["entity", "update", "t:a"],
      ["relation", "update", rel],
      ["preference", "update", pref],
      ["decision", "update", "decision:d"],
    ]) {
      const res = cli([...kuzu, ...ns, ...args]);
      expect(res.code).toBe(2);
      expect(res.err).toContain("nothing to update");
    }
    expect(update("--summary", "x", "--clear", "summary").err).toContain(
      "decisions.update cannot both set and clear 'summary'",
    );
    const cleared = update("--clear", "summary", "--clear", "actor_entity");
    expect(cleared.out).toMatchObject({ summary: null, actor_entity: null, rationale: "r" });
    expect(update("--clear", "event_time").out).toMatchObject({ event_time: null });
    const noAlternatives = update("--clear", "alternative_entities");
    expect(noAlternatives.out).toMatchObject({ alternative_entities: [], steps: [{ relation_id: rel }] });
    expect(update("--clear", "steps").out).toMatchObject({ steps: [] });
    expect(decision("create", "No steps").out).toMatchObject({ steps: [] });
  });

  it("merges with --resolver and reverses with entity unmerge", () => {
    const ns = ["--namespace", "cli_resolution"];
    const robert = JSON.stringify({ entities: [{ type: "Person", name: "Robert", aliases: ["Bob"] }] });
    expect(cli([...kuzu, ...ns, "insert", "facts", "-"], { input: robert }).code).toBe(0);
    const bob = JSON.stringify({ entities: [{ type: "Person", name: "Bob" }] });
    const res = cli([...kuzu, ...ns, "insert", "facts", "-", "--resolver", "default"], { input: bob });
    const mergeId = (res.out as { merges: Array<{ id: string }> }).merges[0]!.id;
    const listed = cli([...kuzu, ...ns, "entity", "merges", "person:robert"]).out as { items: Array<{ id: string }> };
    expect(listed.items.map((m) => m.id)).toEqual([mergeId]);
    const out = cli([...kuzu, ...ns, "entity", "unmerge", mergeId]).out as { entity: { id: string } };
    expect(out.entity.id).toBe("person:bob");
  });

  it("plans maintenance unless --apply, and decays relevance", () => {
    const ns = ["--namespace", "cli_maintenance"];
    const run = (...args: string[]) => cli([...kuzu, ...ns, "maintenance", ...args]);
    for (const action of [["decay"], ["prune", "--min-relevance", "0.1"], ["dedupe-relations"]]) {
      expect(run(...action).code).toBe(0);
    }
    seed(ns, "A");
    const soon = new Date(Date.now() + 40_000).toISOString();
    const plan = run("prune", "--older-than", soon);
    expect(plan.out).toMatchObject({ dry_run: true, entity_ids: ["t:a"] });
    expect(plan.out).not.toHaveProperty("deleted");
    const dedupe = run("dedupe-relations");
    expect(dedupe.out).toMatchObject({ dry_run: true, groups: [] });
    expect(dedupe.out).not.toHaveProperty("deleted");
    const unscored = run("prune", "--min-relevance", "0.5");
    expect(unscored.err).toBe("");
    expect((unscored.out as { note: string }).note).toMatch(/run maintenance decay --apply first$/);
    const decay = run("decay", "--half-life-days", "7", "--apply");
    expect(decay.out).toMatchObject({ dry_run: false, updated_entities: 1 });
    const applied = run("prune", "--older-than", soon, "--apply");
    expect(applied.out).toMatchObject({ dry_run: false, deleted: { deleted_entities: 1 } });
  });

  it("pages evidence and takes the parity flags", () => {
    const ns = [...kuzu, "--namespace", "cli_parity"];
    for (const source of ["s1", "s2"]) {
      expect(
        cli([...ns, "insert", "facts", "-", "--source-id", source], { input: JSON.stringify(A_KNOWS_B) }).code,
      ).toBe(0);
    }
    type EvidencePage = { items: Array<{ source_id: string; quote: string | null }>; next_cursor: string | null };
    const first = cli([...ns, "entity", "evidence", "t:a", "--limit", "1"]).out as EvidencePage;
    const rest = cli([...ns, "entity", "evidence", "t:a", "--cursor", first.next_cursor!]).out as EvidencePage;
    expect([...first.items, ...rest.items].map((e) => e.source_id).sort()).toEqual(["s1", "s2"]);
    const evidence = '{"source_id": "doc-1", "quote": "A knows B"}';
    const id = "relation:ab";
    expect(cli([...ns, "relation", "update", id, "--set", "w=2", "--evidence", evidence]).code).toBe(0);
    const ev = cli([...ns, "relation", "evidence", id]).out as EvidencePage;
    expect(Object.fromEntries(ev.items.map((e) => [e.source_id, e.quote]))).toEqual({
      s1: null,
      s2: null,
      "doc-1": "A knows B",
    });
    const versions = cli([...ns, "relation", "versions", id, "--oldest-first"]).out as Array<{ revision: number }>;
    expect(versions.map((v) => v.revision)).toEqual([1, 2]);
    const updated = cli([...ns, "relation", "update", id, "--prop", "v=3", "--remove-prop", "w"]);
    expect(updated.out).toMatchObject({ properties: { v: 3 } });
    const retrieved = cli([...ns, "retrieve", "who", "knows", "B", "--k", "5"]).out as { query: string };
    expect(retrieved.query).toBe("who knows B");
    const context = cli([...ns, "retrieve", "A", "--context-only"]);
    expect(context.code).toBe(0);
    expect(typeof context.out === "string" && context.out.includes("A")).toBe(true);
    const text = cli([...ns, "insert", "text", "Ann met Bob.", "--metadata", "a=1", "--metadata", '{"b": "x"}']);
    expect(text.code).toBe(0);
    expect(cli([...ns, "query", "RETURN $a AS a", "--param", "a=1", "--param", "b=2"]).out).toMatchObject({
      rows: [{ a: 1 }],
    });
  });

  it("imports and exports Neo4j graph schemas and warns about unknown types", () => {
    const neo = {
      node_types: [
        { label: "Person", description: "", properties: [{ name: "name", type: "STRING", description: "" }] },
      ],
      relationship_types: [{ label: "KNOWS", description: "", properties: [] }],
      patterns: [["Person", "KNOWS", "Person"]],
      constraints: [{ type: "EXISTENCE", property_names: ["name"], node_type: "Person" }],
    };
    const imported = cli([...kuzu, "schema", "import", "--from", "neo4j", "-"], { input: JSON.stringify(neo) });
    expect(imported.code).toBe(0);
    expect(imported.out).toMatchObject({ entities: [{ name: "Person" }], relations: [{ type: "KNOWS" }] });
    const path = join(dir, "schema.json");
    writeFileSync(path, JSON.stringify(imported.out));
    expect(cli([...kuzu, "--schema", path, "schema", "export", "--to", "neo4j"]).out).toEqual(neo);
    const none = cli([...kuzu, "schema"]);
    expect(none.out).toBeNull();
    expect(none.err).toContain("no schema set; pass --schema FILE or SELFGRAPH_SCHEMA");
    const bare = cli([...kuzu, "schema", "import", "-"], { input: JSON.stringify(neo) });
    expect(bare.out).toEqual(imported.out);
    expect(cli([...kuzu, "--schema", path, "schema", "export"]).out).toEqual(neo);

    const schema = JSON.stringify({ entities: [{ name: "Person" }] });
    expect(cli([...kuzu, "--schema", schema, "schema"]).out).toMatchObject({ entities: [{ name: "Person" }] });
    expect(cli([...kuzu, "schema", "import", "-"], { input: schema }).err).toContain(
      "looks like a SelfGraph schema, not a Neo4j one",
    );
    const warned = cli([...kuzu, "--namespace", "cli_warn", "--schema", schema, "insert", "facts", "-"], {
      input: JSON.stringify({
        entities: [
          { name: "B", type: "Company" },
          { name: "C", type: "Company" },
        ],
      }),
    });
    expect(warned.err).toBe(
      "selfgraph: unknown_entity_type: entity company:b has unknown type 'Company'\n" +
        `hint: ${WARNING_HINTS.unknown_entity_type}\n` +
        "selfgraph: unknown_entity_type: entity company:c has unknown type 'Company'\n",
    );
    expect(warned.out).toMatchObject({ warnings: [{ code: "unknown_entity_type" }, { code: "unknown_entity_type" }] });
  });

  it("explains a retired relation on get and supersedes from now on create", () => {
    const schema = join(dir, "employer.json");
    writeFileSync(schema, JSON.stringify(SINGLE_EMPLOYER));
    const g = ["--store", "kuzu", "--uri", join(dir, "retired.kuzu"), "--schema", schema];
    const facts = join(dir, "ann.json");
    writeFileSync(facts, JSON.stringify(ANN_AT_ACME));
    expect(cli([...g, "insert", "facts", facts]).code).toBe(0);
    const made = cli([
      ...g,
      "relation",
      "create",
      "person:ann",
      "WORKS_AT",
      "company:globex",
      "--contradiction",
      "supersede",
    ]);
    expect(made.code).toBe(0);
    const acme = (
      cli([...g, "relation", "list", "--include-invalidated"]).out as {
        items: Array<{ id: string; invalidated_by: string | null }>;
      }
    ).items.find((r) => r.invalidated_by !== null);
    expect(acme?.invalidated_by).toBe((made.out as { id: string }).id);
    const res = cli([...g, "relation", "get", acme!.id]);
    expect(res.code).toBe(1);
    expect(res.err).toContain(`relation ${acme!.id} was invalidated by ${acme!.invalidated_by} at `);
    expect(res.err).toContain("; use relation versions or relation list --include-invalidated");
    const none = cli([...g, "relation", "versions", "relation:ghost"]);
    expect([none.code, none.err]).toEqual([
      1,
      cliError(
        "not_found",
        "Relation 'relation:ghost' does not exist in namespace 'default'",
        "selfgraph relation versions",
      ),
    ]);
  });

  it("takes connection flags after the subcommand and parses time flags", () => {
    const ns = ["--namespace", "cli_late"];
    expect(cli(["entity", "create", "--name", "A", "--type", "T", ...kuzu, ...ns]).code).toBe(0);
    expect(cli([...kuzu, "entity", "get", "t:a", ...ns]).out).toMatchObject({ id: "t:a" });
    expect(cli([...kuzu, ...ns, "entity", "get", "t:a", "--namespace", "other"]).code).toBe(1);
    seed(ns, "b");
    const event = ["--event-time", "2024-01-02T03:04:05Z"];
    const rel = cli([...kuzu, ...ns, "relation", "create", "t:a", "KNOWS", "t:b", ...event]);
    expect(rel.out).toMatchObject({ event_time: "2024-01-02T03:04:05Z" });
    expect(cli([...kuzu, ...ns, "retrieve", "A", "--as-of", "2000-01-01"]).code).toBe(0);
  });

  it("describes every subcommand, words maintenance and entity help, and prints each default once", () => {
    const program = buildParser();
    const sub = (name: string) => program.commands.find((c) => c.name() === name)!;
    for (const group of ["entity", "relation", "preference", "decision"]) {
      for (const c of sub(group).commands) expect(c.description(), `${group} ${c.name()}`).not.toBe("");
    }
    const option = (group: string, action: string, flag: string) =>
      sub(group)
        .commands.find((c) => c.name() === action)!
        .options.find((o) => o.long === flag)!.description;
    expect(sub("maintenance").description()).toBe("decay (score relevance), prune, or deduplicate relations");
    expect(option("entity", "list", "--name")).toBe("exact, case-sensitive match on the current name");
    expect(option("entity", "update", "--type")).toBe(
      "change the type's case or spacing only (the type is part of the id)",
    );
    expect(option("relation", "update", "--remove")).toContain("ignored if absent");
    expect(option("entity", "create", "--prop")).toContain("KEY=VALUE, VALUE parsed as JSON");
    expect(option("preference", "update", "--clear")).toContain("strength, about_entity");
    const help = sub("retrieve").helpInformation();
    expect(help).toContain("(default: 3)");
    expect(help).not.toMatch(/\(default \d+\)/);
  });

  it("writes a large result through a pipe in full and exits quietly when the reader closes", () => {
    const ns = ["--namespace", "cli_pipe"];
    const entities = Array.from({ length: 600 }, (_, i) => ({
      type: "T",
      name: `Entity number ${i} with a long name`,
    }));
    expect(cli([...kuzu, ...ns, "insert", "facts", "-"], { input: JSON.stringify({ entities }) }).code).toBe(0);
    const args = [CLI, ...kuzu, ...ns, "entity", "list", "--limit", "1000"].map((a) => `'${a}'`).join(" ");
    const env = { ...process.env, ...ENV };
    const full = spawnSync("sh", ["-c", `'${process.execPath}' ${args} | wc -c`], { encoding: "utf8", env });
    expect(Number(full.stdout.trim())).toBeGreaterThan(65536);
    const closed = spawnSync(
      "bash",
      ["-c", `'${process.execPath}' ${args} | head -c 0; echo "status=\${PIPESTATUS[0]}"`],
      {
        encoding: "utf8",
        env,
      },
    );
    expect(closed.stderr).toBe("");
    expect(closed.stdout.trim()).toBe("status=141");
  });
});

describe("CLI settings", () => {
  it("rejects an empty or blank namespace and defaults an unset one", () => {
    const neo4j: GraphSettings = { ...DEFAULT_SETTINGS, store: "neo4j", uri: "bolt://localhost:7687" };
    for (const namespace of ["", "   "]) {
      expect(() => buildGraph({ ...neo4j, namespace })).toThrow(ValidationError);
    }
    const fromEnv = settingsFromEnv({ store: "neo4j", uri: "bolt://localhost:7687" }, { SELFGRAPH_NAMESPACE: "" });
    expect(() => buildGraph(fromEnv)).toThrow(/namespace cannot be empty/);
    expect(buildGraph({ ...neo4j, namespace: undefined as never }).namespace).toBe("default");
  });

  it("resolves the store kind", () => {
    expect(storeKind({ ...DEFAULT_SETTINGS })).toBe("kuzu");
    expect(storeKind({ ...DEFAULT_SETTINGS, uri: "bolt://x:1" })).toBe("hydradb");
    expect(storeKind({ ...DEFAULT_SETTINGS, store: "Neo4j", uri: "bolt://x:1" })).toBe("neo4j");
  });

  it("rejects a malformed escape in FalkorDB URL credentials without quoting them", () => {
    for (const userinfo of ["default:100%", "u:%ff", "u%zz:p", "u:%e2%82"]) {
      let caught: unknown;
      try {
        buildGraph({ ...DEFAULT_SETTINGS, store: "falkordb", uri: `redis://${userinfo}@db:6390` });
      } catch (exc) {
        caught = exc;
      }
      expect(caught, userinfo).toBeInstanceOf(ValidationError);
      const err = caught as ValidationError;
      expect([err.code, err.field]).toEqual(["invalid_setting", "uri"]);
      expect(err.message).toBe(
        "the store URI has a malformed percent escape in its user or password; " +
          "write a literal % as %25 and percent-encode other characters as UTF-8",
      );
    }
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
    expect(built({ uri: "falkor://db:6390" })).toEqual(["db", 6390, "selfgraph", {}]);
    expect(built({ uri: "rediss://db:6390" })[3]).toEqual({ socket: { tls: true } });
    for (const uri of ["bolt://db:6390", "falkordb://db:6390"]) {
      expect(() => built({ uri })).toThrow("the 'falkordb' store expects host:port or a redis://");
    }
  });

  it("names settings in library errors and flags in CLI errors", () => {
    const cases: Array<[Partial<GraphSettings>, string, string]> = [
      [{ store: "neo4j", uri: "g.kuzu" }, 'pass store: "kuzu"', "pass --store kuzu"],
      [{ store: "neo4j" }, "pass the uri option (or SELFGRAPH_URI)", "pass --uri (or SELFGRAPH_URI)"],
      [{ llm_provider: "gemini" }, "pass the llm_model option (or SELFGRAPH_LLM_MODEL)", "pass --llm-model"],
      [{ uri: " " }, "omit the uri option (or SELFGRAPH_URI)", "omit --uri (or SELFGRAPH_URI)"],
      [
        { llm_provider: "openai", llm_model: "anthropic/claude" },
        "pass the llm_provider option (or SELFGRAPH_LLM_PROVIDER) matching the model",
        "pass --llm-provider (or SELFGRAPH_LLM_PROVIDER) matching the model",
      ],
    ];
    for (const [settings, library, surface] of cases) {
      let message = "";
      try {
        SelfGraph.connect(settings);
      } catch (exc) {
        message = (exc as Error).message;
      }
      expect(message).toContain(library);
      expect(message).not.toContain("--");
      expect(surfaceHint(message)).toContain(surface);
    }
  });

  it("rewords the embedder hint for the CLI", async () => {
    const { seedTier } = await import("../src/access.js");
    let message = "";
    try {
      seedTier("embeddings", null, "max");
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toBe("seeds 'embeddings' needs an embedder: pass embedder= to SelfGraph");
    expect(surfaceHint(message)).toBe(
      "seeds 'embeddings' needs an embedder: which only the SDK can take; use --seeds bm25 or synonyms here",
    );
  });

  it("binds raw query parameters, warns when kuzu ignores a setting, and rejects a kuzu path for a server", async () => {
    expect(bindParams("RETURN $a AS a", { a: 1, b: 2 })).toEqual({ a: 1 });
    expect(bindParams("RETURN '$a' AS a, `$b` AS b /* $c */ // $d", null)).toEqual({});
    expect(() => bindParams("RETURN $a, '$b'", {})).toThrow(/^missing parameter \$a$/);
    expect(() => bindParams("RETURN $a, $c, $a", null)).toThrow(/^missing parameters \$a, \$c$/);
    const { warnings } = await captureWarnings(() =>
      SelfGraph.connect({ store: "kuzu", uri: join(dir, "warn.kuzu"), database: "x" }).close(),
    );
    expect(warnings).toContain("selfgraph: database is ignored by store kuzu");
    for (const uri of ["graph.kuzu", join(dir, "db")]) {
      expect(() => SelfGraph.connect({ uri })).toThrow('this looks like a Kuzu path; pass store: "kuzu"');
    }
  });

  it("wraps an unexpected CLI error as a coded, credential-masked internal error", async () => {
    const uri = "bolt://user:store-secret@db.example:7687";
    const baseUrl = "https://proxy:llm-secret@llm.example/v1";
    const connect = vi.spyOn(SelfGraph, "connect").mockImplementation(() => {
      throw new Error(`driver crashed talking to ${uri} with ${baseUrl}`);
    });
    const chunks: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const code = await main([
        "--store",
        "neo4j",
        "--uri",
        uri,
        "--llm-provider",
        "openai",
        "--llm-model",
        "m",
        "--llm-base-url",
        baseUrl,
        "entity",
        "list",
      ]);
      expect(code).toBe(1);
    } finally {
      write.mockRestore();
      connect.mockRestore();
    }
    const err = chunks.join("");
    expect(err).toContain("error[internal_error]:");
    expect(err).not.toContain("store-secret");
    expect(err).not.toContain("llm-secret");
    expect(err).toContain("bolt://***@db.example:7687");
    expect(err).toContain("https://***@llm.example/v1");
  });

  it("accepts an auth pair, a provider-prefixed model, and names an unknown setting", () => {
    const neo4j = { store: "neo4j", uri: "bolt://localhost:1" };
    expect(SelfGraph.connect({ ...neo4j, auth: ["neo4j", "pw"] })).toBeInstanceOf(SelfGraph);
    expect(() => SelfGraph.connect({ ...neo4j, namspace: "x" } as never)).toThrow(/did you mean 'namespace'/);
    expect(() => SelfGraph.fromEnv({ stor: "kuzu" } as never)).toThrow(/did you mean 'store'/);
    expect(buildLlm({ ...DEFAULT_SETTINGS, llm_model: "google/gemini-3.7-flash" })?.provider).toBe("google");
    expect(() => buildLlm({ ...DEFAULT_SETTINGS, llm_model: "gpt-4o-mini" })).toThrow(/provider-prefixed model/);
    const llm = (llm_provider: string, llm_model: string, llm_base_url: string | null = null) =>
      buildLlm({ ...DEFAULT_SETTINGS, llm_provider, llm_model, llm_base_url });
    const failure = (fn: () => unknown) => {
      try {
        fn();
      } catch (exc) {
        const { code, field, message } = exc as ValidationError;
        return { code, field, message };
      }
      return null;
    };
    expect(failure(() => llm("anthropic", "gemini/gemini-3.7-flash"))).toEqual({
      code: "invalid_setting",
      field: "llm_provider",
      message:
        "llm_provider 'anthropic' conflicts with model prefix 'gemini'; " +
        "pass the llm_provider option (or SELFGRAPH_LLM_PROVIDER) matching the model",
    });
    expect(failure(() => checkLlmConfig({ provider: "anthropic", model: "gemini/x" }))).toEqual({
      code: "invalid_setting",
      field: "provider",
      message: "provider 'anthropic' conflicts with model prefix 'gemini'",
    });
    expect(llm("gemini", "google/x")?.model).toBe("google/x");
    expect(llm("openrouter", "anthropic/claude")?.provider).toBe("openrouter");
    expect(llm("openai", "anthropic/x", "http://h")?.model).toBe("anthropic/x");
    expect(llm("openai", "meta-llama/x")?.model).toBe("meta-llama/x");
    expect(parseTime("2024-01-02", "now").toISOString()).toBe("2024-01-02T00:00:00.000Z");
    expect(() => parseTime("soon", "now")).toThrow("invalid now: 'soon' is not an ISO 8601 date or time");
    expect(parseTime("2021-03-04T10:15:00+0530", "as_of").toISOString()).toBe("2021-03-04T04:45:00.000Z");
    for (const text of ["2021-03-04T10:15:00+24:00", "2021-03-04T10:15:00+05:60", "2021-03-04T10:15:00\u00a0+05:30"]) {
      expect(() => parseTime(text, "as_of"), text).toThrow("is not an ISO 8601 date or time");
    }
  });
});
