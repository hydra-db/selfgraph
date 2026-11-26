from __future__ import annotations

import json
import re
import shutil
import sys
import sysconfig
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from .errors import ValidationError, mask_uri
from .runtime import parse_json

__all__ = ["AGENTS", "Change", "apply_changes", "plan_install", "server_command"]

_SERVER = "selfgraph"
_SKILL = ".claude/skills/selfgraph/SKILL.md"
_SECRETS = ("auth", "llm_api_key")
_TOML_TABLE = ("mcp_servers", _SERVER)
_BARE_KEY = re.compile(r"[A-Za-z0-9_-]+")


@dataclass(frozen=True)
class _Agent:
    folder: str
    files: Mapping[str, str]
    key: str | None
    stdio: bool = False


_AGENTS = {
    "claude": _Agent(".claude", {"project": ".mcp.json", "user": ".claude.json"}, "mcpServers", stdio=True),
    "cursor": _Agent(".cursor", {"project": ".cursor/mcp.json", "user": ".cursor/mcp.json"}, "mcpServers", stdio=True),
    "vscode": _Agent(".vscode", {"project": ".vscode/mcp.json"}, "servers", stdio=True),
    "gemini": _Agent(".gemini", {"project": ".gemini/settings.json", "user": ".gemini/settings.json"}, "mcpServers"),
    "windsurf": _Agent(".codeium/windsurf", {"user": ".codeium/windsurf/mcp_config.json"}, "mcpServers"),
    "codex": _Agent(".codex", {"project": ".codex/config.toml", "user": ".codex/config.toml"}, None),
}
AGENTS = tuple(_AGENTS)


@dataclass(frozen=True)
class Change:
    agent: str
    path: Path
    shown: str
    text: str | None
    changed: bool


def server_command() -> tuple[str, list[str]]:
    """The command an agent runs to start this install's MCP server.

    @return (tuple[str, list[str]]): `selfgraph` when the one on PATH belongs to this install, else this interpreter.
    """
    found = shutil.which(_SERVER)
    if found:
        script = Path(sysconfig.get_path("scripts")) / Path(found).name
        if script.exists() and Path(found).resolve() == script.resolve():
            return _SERVER, ["mcp"]
    return sys.executable, ["-m", "selfgraph", "mcp"]


def _skill_text() -> str:
    """Read the SKILL.md shipped with the package, or the repository copy in a source checkout.

    @return (str): the skill text.
    """
    for path in (resources.files("selfgraph") / "SKILL.md", Path(__file__).resolve().parents[2] / "SKILL.md"):
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise ValidationError("SKILL.md is missing from this install; reinstall selfgraph")


def _merge(text: str | None, key: str, entry: Mapping[str, Any] | None, shown: str) -> str | None:
    """Set or remove the selfgraph server in a JSON config, keeping every other key.

    @param text (str | None): the file's text, or None when it does not exist.
    @param key (str): the object that holds the servers, such as mcpServers.
    @param entry (Mapping[str, Any] | None): the server entry, or None to remove it.
    @param shown (str): the file as shown to the user.
    @return (str | None): the new text, or the old one when nothing changes.
    """
    data: Any = {}
    if text and text.strip():
        try:
            data = parse_json(text)
        except ValidationError:
            raise ValidationError(f"cannot update {shown!r}: not valid JSON") from None
        if not isinstance(data, dict):
            raise ValidationError(f"cannot update {shown!r}: not a JSON object")
    servers = data.get(key)
    if servers is not None and not isinstance(servers, dict):
        raise ValidationError(f"cannot update {shown!r}: {key} is not an object")
    if entry is None:
        if not servers or _SERVER not in servers:
            return text
        del servers[_SERVER]
    else:
        data[key] = {**(servers or {}), _SERVER: dict(entry)}
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")


def _toml_block(entry: Mapping[str, Any]) -> str:
    """Render the selfgraph server as a TOML table, with its env as a subtable.

    @param entry (Mapping[str, Any]): the command, args, and optional env.
    @return (str): the table text, ending in a newline.
    """
    args = ", ".join(_toml_string(a) for a in entry["args"])
    lines = [f"[{'.'.join(_TOML_TABLE)}]", f"command = {_toml_string(entry['command'])}", f"args = [{args}]"]
    if entry.get("env"):
        lines += ["", f"[{'.'.join(_TOML_TABLE)}.env]"]
        lines += [f"{name} = {_toml_string(value)}" for name, value in entry["env"].items()]
    return "\n".join(lines) + "\n"


def _toml_key(line: str, i: int) -> tuple[list[str], int] | None:
    """Read a dotted TOML key starting at a position.

    @param line (str): the line.
    @param i (int): where the key starts.
    @return (tuple[list[str], int] | None): the key parts and the position after them, or None when there is no key.
    """
    parts: list[str] = []
    while True:
        while i < len(line) and line[i] in " \t":
            i += 1
        if i < len(line) and line[i] in "\"'":
            quote = line[i]
            end = i + 1
            while end < len(line) and line[end] != quote:
                end += 2 if quote == '"' and line[end] == "\\" else 1
            if end >= len(line):
                return None
            parts.append(line[i + 1 : end])
            i = end + 1
        else:
            bare = _BARE_KEY.match(line, i)
            if not bare:
                return None
            parts.append(bare.group())
            i = bare.end()
        while i < len(line) and line[i] in " \t":
            i += 1
        if i >= len(line) or line[i] != ".":
            return parts, i
        i += 1


def _scan_value(line: str, i: int, state: dict[str, Any]) -> bool:
    """Track strings, arrays, and inline tables through a value, so a header inside one is not read as a table.

    @param line (str): the line.
    @param i (int): where the value text starts.
    @param state (dict[str, Any]): the open multi-line string delimiter and the bracket depth, updated in place.
    @return (bool): False when a bracket closes that never opened, or a one-line string does not end.
    """
    while i < len(line):
        if state["string"]:
            delim = state["string"]
            while i < len(line) and not line.startswith(delim, i):
                i += 2 if delim == '"""' and line[i] == "\\" else 1
            if i >= len(line):
                return True
            i += 3
            while i < len(line) and line[i] == delim[0]:
                i += 1
            state["string"] = None
            continue
        char = line[i]
        if char == "#":
            return True
        if line.startswith('"""', i) or line.startswith("'''", i):
            state["string"] = line[i : i + 3]
            i += 3
        elif char in "\"'":
            end = i + 1
            while end < len(line) and line[end] != char and line[end] != "\n":
                end += 2 if char == '"' and line[end] == "\\" else 1
            if end >= len(line) or line[end] != char:
                return False
            i = end + 1
        else:
            if char in "[{":
                state["depth"] += 1
            elif char in "]}":
                state["depth"] -= 1
                if state["depth"] < 0:
                    return False
            i += 1
    return True


def _toml_layout(lines: list[str], shown: str) -> tuple[list[tuple[int, list[str]]], list[bool]]:
    """Check a TOML file's structure and find its table headers.

    @param lines (list[str]): the file's lines, each with its newline.
    @param shown (str): the file as shown to the user.
    @return (tuple[list[tuple[int, list[str]]], list[bool]]): each table header's line and key, and per line whether it
        is blank or a comment outside any value.
    """
    state: dict[str, Any] = {"string": None, "depth": 0}
    headers: list[tuple[int, list[str]]] = []
    quiet = [False] * len(lines)
    table: list[str] = []
    opened = 0

    def bad(n: int) -> ValidationError:
        return ValidationError(f"cannot update {shown!r}: not valid TOML at line {n + 1}")

    def unsupported() -> ValidationError:
        return ValidationError(
            f"cannot update {shown!r}: it sets {'.'.join(_TOML_TABLE)} outside a "
            f"[{'.'.join(_TOML_TABLE)}] table; move it into one or remove it"
        )

    for n, line in enumerate(lines):
        if state["string"] or state["depth"]:
            if not _scan_value(line, 0, state):
                raise bad(n)
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            quiet[n] = True
            continue
        opened = n
        start = len(line) - len(line.lstrip())
        if stripped.startswith("["):
            array = stripped.startswith("[[")
            key = _toml_key(line, start + (2 if array else 1))
            if key is None:
                raise bad(n)
            parts, i = key
            close = "]]" if array else "]"
            if not line.startswith(close, i):
                raise bad(n)
            rest = line[i + len(close) :].strip()
            if rest and not rest.startswith("#"):
                raise bad(n)
            if array and tuple(parts[:2]) == _TOML_TABLE:
                raise unsupported()
            table = parts
            if not array:
                headers.append((n, parts))
            continue
        key = _toml_key(line, start)
        if key is None or key[1] >= len(line) or line[key[1]] != "=":
            raise bad(n)
        full = [*table, *key[0]]
        if tuple(table[:2]) != _TOML_TABLE and (full == ["mcp_servers"] or tuple(full[:2]) == _TOML_TABLE):
            raise unsupported()
        value = line[key[1] + 1 :].strip()
        if not value or value.startswith("#") or not _scan_value(line, key[1] + 1, state):
            raise bad(n)
    if state["string"] or state["depth"]:
        raise bad(opened)
    return headers, quiet


def _merge_toml(text: str | None, entry: Mapping[str, Any] | None, shown: str) -> str | None:
    """Set or remove the [mcp_servers.selfgraph] table and its subtables, leaving the rest of the file as it is.

    @param text (str | None): the file's text, or None when it does not exist.
    @param entry (Mapping[str, Any] | None): the command, args, and optional env, or None to remove the table.
    @param shown (str): the file as shown to the user.
    @return (str | None): the new text, or the old one when nothing changes.
    """
    lines = re.findall(r"[^\n]*\n|[^\n]+$", text or "")
    headers, quiet = _toml_layout(lines, shown)
    blocks: list[tuple[int, int]] = []
    for index, (n, parts) in enumerate(headers):
        if tuple(parts[:2]) != _TOML_TABLE:
            continue
        end = headers[index + 1][0] if index + 1 < len(headers) else len(lines)
        while end > n + 1 and quiet[end - 1]:
            end -= 1
        if blocks and all(quiet[blocks[-1][1] : n]):
            n = blocks.pop()[0]
        blocks.append((n, end))
    block = None if entry is None else _toml_block(entry)
    if not blocks:
        if block is None:
            return text
        head = text or ""
        if head and not head.endswith("\n"):
            head += "\n"
        if head and not head.endswith("\n\n"):
            head += "\n"
        return head + block
    keep = [True] * len(lines)
    for start, end in blocks:
        keep[start:end] = [False] * (end - start)
    last_start, last_end = blocks[-1]
    if block is None and all(quiet[last_end:]):
        n = last_start
        while n > 0 and not lines[n - 1].strip():
            n -= 1
            keep[n] = False
    out = []
    for n, line in enumerate(lines):
        if n == blocks[0][0] and block is not None:
            out.append(block)
        if keep[n]:
            out.append(line)
    return "".join(out)


def _read(path: Path, shown: str) -> str | None:
    """Read a config file as it is on disk, newlines included.

    @param path (Path): the file.
    @param shown (str): the file as shown to the user.
    @return (str | None): the text, or None when the file does not exist.
    """
    try:
        return path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError):
        raise ValidationError(f"cannot read {shown!r}") from None


def _agents(names: Sequence[str], user: bool, roots: Mapping[str, Path]) -> list[str]:
    """Check the named agents, or find those whose config folder exists in the scope.

    @param names (Sequence[str]): the agents named on the command line.
    @param user (bool): whether --global was passed.
    @param roots (Mapping[str, Path]): the project and user folders.
    @return (list[str]): the agents to install for, in a stable order.
    """
    for name in names:
        if name not in _AGENTS:
            raise ValidationError(f"unknown agent {name!r}; choose from {', '.join(AGENTS)}", field="agents")
    if names:
        return list(dict.fromkeys(names))
    scope = "user" if user else "project"
    found = [name for name, a in _AGENTS.items() if scope in a.files and (roots[scope] / a.folder).is_dir()]
    if not found:
        place = "your home folder" if user else "this folder"
        raise ValidationError(f"found no agent config folder in {place}; name one or more of: {', '.join(AGENTS)}")
    return found


def plan_install(
    names: Sequence[str],
    *,
    user: bool,
    remove: bool,
    command: str,
    args: Sequence[str],
    settings: Mapping[str, str],
    cwd: Path,
    home: Path,
) -> list[Change]:
    """Work out every file install would write or remove, reading them all before anything is written.

    @param names (Sequence[str]): the agents named on the command line; none means every detected one.
    @param user (bool): write the user-level files instead of the project's.
    @param remove (bool): remove the selfgraph server instead of adding it.
    @param command (str): the command that starts the MCP server.
    @param args (Sequence[str]): its arguments.
    @param settings (Mapping[str, str]): the settings given as flags, written to the entry's env as SELFGRAPH_*.
    @param cwd (Path): the project folder.
    @param home (Path): the user's home folder.
    @return (list[Change]): one change per file, in output order.
    """
    secret = next((key for key, value in settings.items() if key in _SECRETS or mask_uri(value) != value), None)
    roots = {"project": cwd, "user": home}
    changes: list[Change] = []
    for name in _agents(names, user, roots):
        agent = _AGENTS[name]
        if user and "user" not in agent.files:
            raise ValidationError(f"{name} has no user-level config; run install {name} without --global")
        scope = "project" if not user and "project" in agent.files else "user"
        if secret and scope == "project" and not remove:
            raise ValidationError(
                f"--{secret.replace('_', '-')} holds a credential and {agent.files[scope]} may be committed; pass "
                f"--global to write the user config, or add SELFGRAPH_{secret.upper()} to the entry's env by hand",
                field=secret,
            )
        entry: dict[str, Any] | None = None
        if not remove:
            entry = {"type": "stdio"} if agent.stdio else {}
            entry.update(command=command, args=list(args))
            if settings:
                entry["env"] = {f"SELFGRAPH_{key.upper()}": value for key, value in settings.items()}
        for rel in [agent.files[scope], *([_SKILL] if name == "claude" else [])]:
            path = roots[scope] / rel
            shown = rel if scope == "project" else f"~/{rel}"
            old = _read(path, shown)
            if rel != _SKILL:
                new = _merge(old, agent.key, entry, shown) if agent.key else _merge_toml(old, entry, shown)
            elif remove:
                new = None
            else:
                new = _skill_text()
            if old is not None or new is not None:
                changes.append(Change(name, path, shown, new, new != old))
    return changes


def apply_changes(changes: Sequence[Change], *, dry_run: bool) -> list[str]:
    """Write or remove each changed file, and describe every file in one line.

    @param changes (Sequence[Change]): the planned changes.
    @param dry_run (bool): describe the changes without writing anything.
    @return (list[str]): the output lines.
    """
    lines = []
    for c in changes:
        verb = "unchanged" if not c.changed else "removed" if c.text is None else "wrote"
        if dry_run and c.changed:
            verb = f"would {'remove' if c.text is None else 'write'}"
        lines.append(f"{c.agent}: {verb} {c.shown}")
        if dry_run or not c.changed:
            continue
        if c.text is None:
            c.path.unlink()
            if not any(c.path.parent.iterdir()):
                c.path.parent.rmdir()
        else:
            c.path.parent.mkdir(parents=True, exist_ok=True)
            c.path.write_bytes(c.text.encode("utf-8"))
    if dry_run:
        lines.append("Dry run: nothing was written.")
    elif any(c.changed for c in changes):
        lines.append("Restart or reload the agent to pick up the change.")
    return lines
