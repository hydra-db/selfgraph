import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskUri, ValidationError } from "./errors.js";
import { isPlainObject, pyRepr } from "./internal/py.js";
import { parseJson } from "./runtime.js";

const SERVER = "selfgraph";
const SECRETS = ["auth", "llm_api_key"];

type Scope = "project" | "user";
type Agent = { folder: string; files: Partial<Record<Scope, string>>; key: string; stdio?: boolean };

const AGENT_SPECS: Record<string, Agent> = {
  claude: { folder: ".claude", files: { project: ".mcp.json", user: ".claude.json" }, key: "mcpServers", stdio: true },
  cursor: {
    folder: ".cursor",
    files: { project: ".cursor/mcp.json", user: ".cursor/mcp.json" },
    key: "mcpServers",
    stdio: true,
  },
  vscode: { folder: ".vscode", files: { project: ".vscode/mcp.json" }, key: "servers", stdio: true },
  gemini: {
    folder: ".gemini",
    files: { project: ".gemini/settings.json", user: ".gemini/settings.json" },
    key: "mcpServers",
  },
  windsurf: { folder: ".codeium/windsurf", files: { user: ".codeium/windsurf/mcp_config.json" }, key: "mcpServers" },
};

export const AGENTS = Object.keys(AGENT_SPECS);
export const SERVER_COMMAND = "npx";
export const SERVER_ARGS = ["-y", "-p", "@hydradb/selfgraph", "-p", "@modelcontextprotocol/sdk", "selfgraph", "mcp"];

export type Change = { agent: string; path: string; shown: string; text: string; changed: boolean };

/**
 * Set the selfgraph server in a JSON config, keeping every other key.
 *
 * @param text (string | null): the file's text, or null when it does not exist.
 * @param key (string): the object that holds the servers, such as mcpServers.
 * @param entry (Record<string, unknown>): the server entry.
 * @param shown (string): the file as shown to the user.
 * @return (string): the new text.
 */
function merge(text: string | null, key: string, entry: Record<string, unknown>, shown: string): string {
  let data: Record<string, unknown> = {};
  if (text?.trim()) {
    let parsed: unknown;
    try {
      parsed = parseJson(text, "");
    } catch {
      throw new ValidationError(`cannot update ${pyRepr(shown)}: not valid JSON`);
    }
    if (!isPlainObject(parsed)) throw new ValidationError(`cannot update ${pyRepr(shown)}: not a JSON object`);
    data = parsed;
  }
  const servers = data[key] ?? null;
  if (servers !== null && !isPlainObject(servers))
    throw new ValidationError(`cannot update ${pyRepr(shown)}: ${key} is not an object`);
  data[key] = { ...servers, [SERVER]: { ...entry } };
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * Read a config file as it is on disk, newlines included.
 *
 * @param path (string): the file.
 * @param shown (string): the file as shown to the user.
 * @return (string | null): the text, or null when the file does not exist.
 */
function read(path: string, shown: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ValidationError(`cannot read ${pyRepr(shown)}`);
  }
}

/**
 * Check the named agents, or find those whose config folder exists in the scope.
 *
 * @param names (string[]): the agents named on the command line.
 * @param user (boolean): whether --global was passed.
 * @param roots (Record<Scope, string>): the project and user folders.
 * @return (string[]): the agents to install for, in a stable order.
 */
function pickAgents(names: string[], user: boolean, roots: Record<Scope, string>): string[] {
  for (const name of names) {
    if (!Object.hasOwn(AGENT_SPECS, name))
      throw new ValidationError(`unknown agent ${pyRepr(name)}; choose from ${AGENTS.join(", ")}`, { field: "agents" });
  }
  if (names.length) return [...new Set(names)];
  const scope: Scope = user ? "user" : "project";
  const found = AGENTS.filter((name) => {
    const folder = join(roots[scope], AGENT_SPECS[name]!.folder);
    return AGENT_SPECS[name]!.files[scope] && existsSync(folder) && statSync(folder).isDirectory();
  });
  if (!found.length) {
    const place = user ? "your home folder" : "this folder";
    throw new ValidationError(`found no agent config folder in ${place}; name one or more of: ${AGENTS.join(", ")}`);
  }
  return found;
}

/**
 * Work out every file install would write, reading them all before anything is written.
 *
 * @param names (string[]): the agents named on the command line; none means every detected one.
 * @param options ({ user: boolean; command: string; args: string[]; settings: Record<string, string>; cwd: string; home: string }): the scope, the server command, the settings given as flags (written to the env as SELFGRAPH_*), and the project and home folders.
 * @return (Change[]): one change per file, in output order.
 */
export function planInstall(
  names: string[],
  options: {
    user: boolean;
    command: string;
    args: string[];
    settings: Record<string, string>;
    cwd: string;
    home: string;
  },
): Change[] {
  const settings = Object.entries(options.settings);
  const secret = settings.find(([key, value]) => SECRETS.includes(key) || maskUri(value) !== value)?.[0];
  const roots: Record<Scope, string> = { project: options.cwd, user: options.home };
  const changes: Change[] = [];
  for (const name of pickAgents(names, options.user, roots)) {
    const agent = AGENT_SPECS[name]!;
    if (options.user && !agent.files.user)
      throw new ValidationError(`${name} has no user-level config; run install ${name} without --global`);
    const scope: Scope = !options.user && agent.files.project ? "project" : "user";
    if (secret && scope === "project")
      throw new ValidationError(
        `--${secret.replaceAll("_", "-")} holds a credential and ${agent.files[scope]} may be committed; pass ` +
          `--global to write the user config, or add SELFGRAPH_${secret.toUpperCase()} to the entry's env by hand`,
        { field: secret },
      );
    const entry = {
      ...(agent.stdio && { type: "stdio" }),
      command: options.command,
      args: [...options.args],
      ...(settings.length && {
        env: Object.fromEntries(settings.map(([key, value]) => [`SELFGRAPH_${key.toUpperCase()}`, value])),
      }),
    };
    const rel = agent.files[scope]!;
    const path = join(roots[scope], rel);
    const shown = scope === "project" ? rel : `~/${rel}`;
    const old = read(path, shown);
    const text = merge(old, agent.key, entry, shown);
    changes.push({ agent: name, path, shown, text, changed: text !== old });
  }
  return changes;
}

/**
 * Write each changed file, and describe every file in one line.
 *
 * @param changes (Change[]): the planned changes.
 * @param dryRun (boolean): describe the changes without writing anything.
 * @return (string[]): the output lines.
 */
export function applyChanges(changes: Change[], dryRun: boolean): string[] {
  const lines: string[] = [];
  for (const c of changes) {
    const verb = !c.changed ? "unchanged" : dryRun ? "would write" : "wrote";
    lines.push(`${c.agent}: ${verb} ${c.shown}`);
    if (c.changed && !dryRun) {
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, c.text, "utf8");
    }
  }
  if (dryRun) lines.push("Dry run: nothing was written.");
  else if (changes.some((c) => c.changed)) lines.push("Restart or reload the agent to pick up the change.");
  return lines;
}
