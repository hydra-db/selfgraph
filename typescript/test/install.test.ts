import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SERVER_ARGS, SERVER_COMMAND } from "../src/install.js";
import { SETTING_KEYS } from "../src/runtime.js";
import { buildCli, runCli, tempDir } from "./helpers.js";

const base = tempDir("sg-install-");
const NO_SETTINGS = Object.fromEntries(SETTING_KEYS.map((key) => [`SELFGRAPH_${key.toUpperCase()}`, undefined]));
const entry = { command: SERVER_COMMAND, args: SERVER_ARGS };

/**
 * Make an empty project folder and an empty home folder.
 *
 * @return ({ project: string; home: string }): the two folders.
 */
function dirs(): { project: string; home: string } {
  const root = mkdtempSync(join(base, "case-"));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  return { project, home };
}

/**
 * Run the built CLI's install command in a project folder with its own home folder and no SELFGRAPH_* variables.
 *
 * @param where ({ project: string; home: string }): the folders.
 * @param args (string[]): the arguments after install.
 * @return ({ code: number; out: string[]; err: string[] }): the exit code, stdout lines, and stderr lines.
 */
function install(where: { project: string; home: string }, args: string[]) {
  const res = runCli(["install", ...args], {
    cwd: where.project,
    env: { ...NO_SETTINGS, HOME: where.home, USERPROFILE: where.home },
  });
  return { code: res.code, out: String(res.out).split("\n").filter(Boolean), err: res.err.split("\n") };
}

/**
 * Read every file under some folders, keyed by path.
 *
 * @param roots (string[]): the folders.
 * @return (Record<string, string>): each file's text.
 */
function snapshot(...roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path] = readFileSync(path, "utf8");
    }
  };
  for (const root of roots) walk(root);
  return out;
}

const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

beforeAll(buildCli);

describe("selfgraph install", () => {
  it("writes each agent's file shape", () => {
    const where = dirs();
    const res = install(where, ["claude", "cursor", "vscode", "gemini", "windsurf"]);
    expect(res.code).toBe(0);
    expect(res.out).toEqual([
      "claude: wrote .mcp.json",
      "cursor: wrote .cursor/mcp.json",
      "vscode: wrote .vscode/mcp.json",
      "gemini: wrote .gemini/settings.json",
      "windsurf: wrote ~/.codeium/windsurf/mcp_config.json",
      "Restart or reload the agent to pick up the change.",
    ]);
    const stdio = { type: "stdio", ...entry };
    for (const [path, key, value] of [
      [join(where.project, ".mcp.json"), "mcpServers", stdio],
      [join(where.project, ".cursor/mcp.json"), "mcpServers", stdio],
      [join(where.project, ".vscode/mcp.json"), "servers", stdio],
      [join(where.project, ".gemini/settings.json"), "mcpServers", entry],
      [join(where.home, ".codeium/windsurf/mcp_config.json"), "mcpServers", entry],
    ] as const) {
      expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ [key]: { selfgraph: value } }, null, 2)}\n`);
    }
  });

  it("writes the user files with --global", () => {
    const where = dirs();
    const res = install(where, ["claude", "--global"]);
    expect(res.out[0]).toBe("claude: wrote ~/.claude.json");
    expect(json(join(where.home, ".claude.json"))).toEqual({ mcpServers: { selfgraph: { type: "stdio", ...entry } } });
    expect(readdirSync(where.project)).toEqual([]);
  });

  it("merges with other servers and is idempotent", () => {
    const where = dirs();
    mkdirSync(join(where.project, ".cursor"));
    const cursor = { theme: "dark", mcpServers: { other: { command: "other", args: ["x"] } } };
    writeFileSync(join(where.project, ".cursor/mcp.json"), JSON.stringify(cursor));

    expect(install(where, ["--store", "kuzu"]).code).toBe(0);
    const first = snapshot(where.project);
    expect(json(join(where.project, ".cursor/mcp.json"))).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "other", args: ["x"] },
        selfgraph: { type: "stdio", ...entry, env: { SELFGRAPH_STORE: "kuzu" } },
      },
    });
    expect(install(where, ["--store", "kuzu"]).out).toEqual(["cursor: unchanged .cursor/mcp.json"]);
    expect(snapshot(where.project)).toEqual(first);
  });

  it("writes nothing on --dry-run", () => {
    const where = dirs();
    mkdirSync(join(where.project, ".gemini"));
    expect(install(where, ["--dry-run", "claude", "gemini"]).out).toEqual([
      "claude: would write .mcp.json",
      "gemini: would write .gemini/settings.json",
      "Dry run: nothing was written.",
    ]);
    expect(snapshot(where.project, where.home)).toEqual({});
  });

  it("detects agents by their config folder", () => {
    const where = dirs();
    const res = install(where, []);
    expect([res.code, res.err[0]]).toEqual([
      2,
      "error[invalid_argument]: found no agent config folder in this folder; name one or more of: claude, cursor, vscode, gemini, windsurf",
    ]);
    for (const folder of [
      join(where.project, ".vscode"),
      join(where.project, ".claude"),
      join(where.home, ".codeium/windsurf"),
      join(where.home, ".gemini"),
    ])
      mkdirSync(folder, { recursive: true });
    expect(
      install(where, ["--dry-run"])
        .out.slice(0, -1)
        .map((line) => line.split(":")[0]),
    ).toEqual(["claude", "vscode"]);
    expect(install(where, ["--dry-run", "--global"]).out.slice(0, -1)).toEqual([
      "gemini: would write ~/.gemini/settings.json",
      "windsurf: would write ~/.codeium/windsurf/mcp_config.json",
    ]);
  });

  it("fails on an unsupported scope or an unknown agent", () => {
    const where = dirs();
    expect(install(where, ["vscode", "--global"]).err[0]).toBe(
      "error[invalid_argument]: vscode has no user-level config; run install vscode without --global",
    );
    const res = install(where, ["cursor", "nope"]);
    expect([res.code, res.err[0]]).toEqual([
      2,
      "error[invalid_argument]: unknown agent 'nope'; choose from claude, cursor, vscode, gemini, windsurf",
    ]);
    expect(res.err).toContain("field: agents");
    expect(snapshot(where.project, where.home)).toEqual({});
  });

  for (const args of [
    ["--store", "neo4j", "--uri", "bolt://db:7687", "--auth", "neo4j:secret"],
    ["--store", "neo4j", "--uri", "bolt://neo4j:secret@db:7687"],
    ["--llm-api-key", "sk-secret"],
    ["--llm-base-url", "https://u:secret@llm.example"],
  ]) {
    it(`keeps a credential out of project files: ${args.at(-2)}`, () => {
      const where = dirs();
      const flag = args.at(-2)!;
      const key = flag.slice(2).replaceAll("-", "_");
      const res = install(where, ["claude", ...args]);
      expect([res.code, res.err[0]]).toEqual([
        2,
        `error[invalid_argument]: ${flag} holds a credential and .mcp.json may be committed; pass --global to write the user config, or add SELFGRAPH_${key.toUpperCase()} to the entry's env by hand`,
      ]);
      expect(res.err).toContain(`field: ${key}`);
      expect(res.err.join("\n")).not.toContain("secret");
      expect(snapshot(where.project, where.home)).toEqual({});
      expect(install(where, ["claude", "--global", ...args]).code).toBe(0);
      const written = json(join(where.home, ".claude.json")) as { mcpServers: { selfgraph: { env: object } } };
      expect(written.mcpServers.selfgraph.env).toMatchObject({ [`SELFGRAPH_${key.toUpperCase()}`]: args.at(-1) });
    });
  }

  for (const [text, message] of [
    ["{nope", "cannot update '.cursor/mcp.json': not valid JSON"],
    ["[]", "cannot update '.cursor/mcp.json': not a JSON object"],
    ['{"mcpServers": []}', "cannot update '.cursor/mcp.json': mcpServers is not an object"],
  ] as const) {
    it(`fails without writing anything: ${message}`, () => {
      const where = dirs();
      mkdirSync(join(where.project, ".cursor"));
      writeFileSync(join(where.project, ".cursor/mcp.json"), text);
      const before = snapshot(where.project);
      const res = install(where, ["claude", "cursor"]);
      expect([res.code, res.out, res.err[0]]).toEqual([2, [], `error[invalid_argument]: ${message}`]);
      expect(snapshot(where.project)).toEqual(before);
    });
  }

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fails on an unreadable file", () => {
    const where = dirs();
    mkdirSync(join(where.project, ".gemini"));
    const path = join(where.project, ".gemini/settings.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0);
    try {
      expect(install(where, ["gemini"]).err[0]).toBe("error[invalid_argument]: cannot read '.gemini/settings.json'");
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("writes only the settings given as flags into env", () => {
    const where = dirs();
    const res = runCli(
      ["--store", "kuzu", "--auth", "u:p", "install", "gemini", "--uri", "graph.kuzu", "--namespace", "team"],
      { cwd: where.project, env: { ...NO_SETTINGS, HOME: where.home, SELFGRAPH_LEVEL: "light" } },
    );
    expect(res.code).toBe(0);
    expect(res.err).toBe("warning: --auth is ignored by store kuzu\n");
    expect(json(join(where.project, ".gemini/settings.json"))).toEqual({
      mcpServers: {
        selfgraph: {
          ...entry,
          env: { SELFGRAPH_STORE: "kuzu", SELFGRAPH_URI: "graph.kuzu", SELFGRAPH_NAMESPACE: "team" },
        },
      },
    });
  });
});
