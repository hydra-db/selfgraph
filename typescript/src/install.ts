import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maskUri, ValidationError } from "./errors.js";
import { isPlainObject, pyRepr } from "./internal/py.js";
import { parseJson } from "./runtime.js";

const SERVER = "selfgraph";
const SKILL = ".claude/skills/selfgraph/SKILL.md";
const SECRETS = ["auth", "llm_api_key"];
const TOML_TABLE = "mcp_servers.selfgraph";
const BARE_KEY = /[A-Za-z0-9_-]+/y;

type Scope = "project" | "user";
type Agent = { folder: string; files: Partial<Record<Scope, string>>; key: string | null; stdio?: boolean };

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
  codex: { folder: ".codex", files: { project: ".codex/config.toml", user: ".codex/config.toml" }, key: null },
};

export const AGENTS = Object.keys(AGENT_SPECS);
export const SERVER_COMMAND = "npx";
export const SERVER_ARGS = ["-y", "-p", "@hydradb/selfgraph", "-p", "@modelcontextprotocol/sdk", "selfgraph", "mcp"];

type ServerEntry = { command: string; args: string[]; env?: Record<string, string> };
export type Change = { agent: string; path: string; shown: string; text: string | null; changed: boolean };

/**
 * Read the SKILL.md shipped with the package, or the repository copy in a source checkout.
 *
 * @return (string): the skill text.
 */
function skillText(): string {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const path of [join(root, "SKILL.md"), join(root, "..", "SKILL.md")]) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new ValidationError("SKILL.md is missing from this install; reinstall @hydradb/selfgraph");
}

/**
 * Set or remove the selfgraph server in a JSON config, keeping every other key.
 *
 * @param text (string | null): the file's text, or null when it does not exist.
 * @param key (string): the object that holds the servers, such as mcpServers.
 * @param entry (Record<string, unknown> | null): the server entry, or null to remove it.
 * @param shown (string): the file as shown to the user.
 * @return (string | null): the new text, or the old one when nothing changes.
 */
function merge(text: string | null, key: string, entry: Record<string, unknown> | null, shown: string): string | null {
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
  if (entry === null) {
    if (!servers || !Object.hasOwn(servers, SERVER)) return text;
    delete servers[SERVER];
  } else {
    data[key] = { ...servers, [SERVER]: { ...entry } };
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

const tomlString = (value: string): string => JSON.stringify(value).replace(/\x7f/g, "\\u007f");

/**
 * Render the selfgraph server as a TOML table, with its env as a subtable.
 *
 * @param entry (ServerEntry): the command, args, and optional env.
 * @return (string): the table text, ending in a newline.
 */
function tomlBlock(entry: ServerEntry): string {
  const lines = [
    `[${TOML_TABLE}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
  ];
  if (entry.env && Object.keys(entry.env).length) {
    lines.push("", `[${TOML_TABLE}.env]`);
    for (const [name, value] of Object.entries(entry.env)) lines.push(`${name} = ${tomlString(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Read a dotted TOML key starting at a position.
 *
 * @param line (string): the line.
 * @param start (number): where the key starts.
 * @return ([string[], number] | null): the key parts and the position after them, or null when there is no key.
 */
function tomlKey(line: string, start: number): [string[], number] | null {
  const parts: string[] = [];
  let i = start;
  const blank = () => {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  };
  for (;;) {
    blank();
    const quote = line[i];
    if (quote === '"' || quote === "'") {
      let end = i + 1;
      while (end < line.length && line[end] !== quote) end += quote === '"' && line[end] === "\\" ? 2 : 1;
      if (end >= line.length) return null;
      parts.push(line.slice(i + 1, end));
      i = end + 1;
    } else {
      BARE_KEY.lastIndex = i;
      const bare = BARE_KEY.exec(line);
      if (!bare) return null;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    blank();
    if (i >= line.length || line[i] !== ".") return [parts, i];
    i++;
  }
}

type ScanState = { string: string | null; depth: number };

/**
 * Track strings, arrays, and inline tables through a value, so a header inside one is not read as a table.
 *
 * @param line (string): the line.
 * @param start (number): where the value text starts.
 * @param state (ScanState): the open multi-line string delimiter and the bracket depth, updated in place.
 * @return (boolean): false when a bracket closes that never opened, or a one-line string does not end.
 */
function scanValue(line: string, start: number, state: ScanState): boolean {
  let i = start;
  while (i < line.length) {
    if (state.string) {
      const delim = state.string;
      while (i < line.length && !line.startsWith(delim, i)) i += delim === '"""' && line[i] === "\\" ? 2 : 1;
      if (i >= line.length) return true;
      i += 3;
      while (i < line.length && line[i] === delim[0]) i++;
      state.string = null;
      continue;
    }
    const char = line[i]!;
    if (char === "#") return true;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.string = line.slice(i, i + 3);
      i += 3;
    } else if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < line.length && line[end] !== char && line[end] !== "\n")
        end += char === '"' && line[end] === "\\" ? 2 : 1;
      if (end >= line.length || line[end] !== char) return false;
      i = end + 1;
    } else {
      if (char === "[" || char === "{") state.depth++;
      else if (char === "]" || char === "}") {
        state.depth--;
        if (state.depth < 0) return false;
      }
      i++;
    }
  }
  return true;
}

const isServerTable = (parts: string[]): boolean => parts[0] === "mcp_servers" && parts[1] === SERVER;

/**
 * Check a TOML file's structure and find its table headers.
 *
 * @param lines (string[]): the file's lines, each with its newline.
 * @param shown (string): the file as shown to the user.
 * @return ([Array<[number, string[]]>, boolean[]]): each table header's line and key, and per line whether it is blank or a comment outside any value.
 */
function tomlLayout(lines: string[], shown: string): [Array<[number, string[]]>, boolean[]] {
  const state: ScanState = { string: null, depth: 0 };
  const headers: Array<[number, string[]]> = [];
  const quiet = lines.map(() => false);
  let table: string[] = [];
  let opened = 0;
  const bad = (n: number) => new ValidationError(`cannot update ${pyRepr(shown)}: not valid TOML at line ${n + 1}`);
  const unsupported = () =>
    new ValidationError(
      `cannot update ${pyRepr(shown)}: it sets ${TOML_TABLE} outside a [${TOML_TABLE}] table; move it into one or remove it`,
    );
  for (const [n, line] of lines.entries()) {
    if (state.string || state.depth) {
      if (!scanValue(line, 0, state)) throw bad(n);
      continue;
    }
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) {
      quiet[n] = true;
      continue;
    }
    opened = n;
    const start = line.length - line.trimStart().length;
    if (stripped.startsWith("[")) {
      const array = stripped.startsWith("[[");
      const key = tomlKey(line, start + (array ? 2 : 1));
      if (key === null) throw bad(n);
      const [parts, i] = key;
      const close = array ? "]]" : "]";
      if (!line.startsWith(close, i)) throw bad(n);
      const rest = line.slice(i + close.length).trim();
      if (rest && !rest.startsWith("#")) throw bad(n);
      if (array && isServerTable(parts)) throw unsupported();
      table = parts;
      if (!array) headers.push([n, parts]);
      continue;
    }
    const key = tomlKey(line, start);
    if (key === null || key[1] >= line.length || line[key[1]] !== "=") throw bad(n);
    const full = [...table, ...key[0]];
    if (!isServerTable(table) && ((full.length === 1 && full[0] === "mcp_servers") || isServerTable(full)))
      throw unsupported();
    const value = line.slice(key[1] + 1).trim();
    if (!value || value.startsWith("#") || !scanValue(line, key[1] + 1, state)) throw bad(n);
  }
  if (state.string || state.depth) throw bad(opened);
  return [headers, quiet];
}

/**
 * Set or remove the [mcp_servers.selfgraph] table and its subtables, leaving the rest of the file as it is.
 *
 * @param text (string | null): the file's text, or null when it does not exist.
 * @param entry (ServerEntry | null): the command, args, and optional env, or null to remove the table.
 * @param shown (string): the file as shown to the user.
 * @return (string | null): the new text, or the old one when nothing changes.
 */
export function mergeToml(text: string | null, entry: ServerEntry | null, shown: string): string | null {
  const lines = (text ?? "").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const [headers, quiet] = tomlLayout(lines, shown);
  const blocks: Array<[number, number]> = [];
  for (const [index, [first, parts]] of headers.entries()) {
    if (!isServerTable(parts)) continue;
    let n = first;
    let end = index + 1 < headers.length ? headers[index + 1]![0] : lines.length;
    while (end > n + 1 && quiet[end - 1]) end--;
    const previous = blocks.at(-1);
    if (previous && quiet.slice(previous[1], n).every(Boolean)) {
      n = previous[0];
      blocks.pop();
    }
    blocks.push([n, end]);
  }
  const block = entry === null ? null : tomlBlock(entry);
  if (!blocks.length) {
    if (block === null) return text;
    let head = text ?? "";
    if (head && !head.endsWith("\n")) head += "\n";
    if (head && !head.endsWith("\n\n")) head += "\n";
    return head + block;
  }
  const keep = lines.map(() => true);
  for (const [start, end] of blocks) keep.fill(false, start, end);
  const [lastStart, lastEnd] = blocks.at(-1)!;
  if (block === null && quiet.slice(lastEnd).every(Boolean)) {
    for (let n = lastStart; n > 0 && !lines[n - 1]!.trim(); n--) keep[n - 1] = false;
  }
  const out: string[] = [];
  for (const [n, line] of lines.entries()) {
    if (n === blocks[0]![0] && block !== null) out.push(block);
    if (keep[n]) out.push(line);
  }
  return out.join("");
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
 * Work out every file install would write or remove, reading them all before anything is written.
 *
 * @param names (string[]): the agents named on the command line; none means every detected one.
 * @param options ({ user: boolean; remove: boolean; command: string; args: string[]; settings: Record<string, string>; cwd: string; home: string }): the scope, whether to remove, the server command, the settings given as flags (written to the env as SELFGRAPH_*), and the project and home folders.
 * @return (Change[]): one change per file, in output order.
 */
export function planInstall(
  names: string[],
  options: {
    user: boolean;
    remove: boolean;
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
    if (secret && scope === "project" && !options.remove)
      throw new ValidationError(
        `--${secret.replaceAll("_", "-")} holds a credential and ${agent.files[scope]} may be committed; pass ` +
          `--global to write the user config, or add SELFGRAPH_${secret.toUpperCase()} to the entry's env by hand`,
        { field: secret },
      );
    const entry = options.remove
      ? null
      : {
          ...(agent.stdio && { type: "stdio" }),
          command: options.command,
          args: [...options.args],
          ...(settings.length && {
            env: Object.fromEntries(settings.map(([key, value]) => [`SELFGRAPH_${key.toUpperCase()}`, value])),
          }),
        };
    for (const rel of [agent.files[scope]!, ...(name === "claude" ? [SKILL] : [])]) {
      const path = join(roots[scope], rel);
      const shown = scope === "project" ? rel : `~/${rel}`;
      const old = read(path, shown);
      let text: string | null;
      if (rel !== SKILL) text = agent.key === null ? mergeToml(old, entry, shown) : merge(old, agent.key, entry, shown);
      else if (options.remove) text = null;
      else text = skillText();
      if (old !== null || text !== null) changes.push({ agent: name, path, shown, text, changed: text !== old });
    }
  }
  return changes;
}

/**
 * Write or remove each changed file, and describe every file in one line.
 *
 * @param changes (Change[]): the planned changes.
 * @param dryRun (boolean): describe the changes without writing anything.
 * @return (string[]): the output lines.
 */
export function applyChanges(changes: Change[], dryRun: boolean): string[] {
  const lines: string[] = [];
  for (const c of changes) {
    let verb = !c.changed ? "unchanged" : c.text === null ? "removed" : "wrote";
    if (dryRun && c.changed) verb = `would ${c.text === null ? "remove" : "write"}`;
    lines.push(`${c.agent}: ${verb} ${c.shown}`);
    if (dryRun || !c.changed) continue;
    if (c.text === null) {
      unlinkSync(c.path);
      if (!readdirSync(dirname(c.path)).length) rmdirSync(dirname(c.path));
    } else {
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, c.text, "utf8");
    }
  }
  if (dryRun) lines.push("Dry run: nothing was written.");
  else if (changes.some((c) => c.changed)) lines.push("Restart or reload the agent to pick up the change.");
  return lines;
}
