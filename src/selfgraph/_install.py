from __future__ import annotations

import json
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


@dataclass(frozen=True)
class _Agent:
    folder: str
    files: Mapping[str, str]
    key: str
    stdio: bool = False


_AGENTS = {
    "claude": _Agent(".claude", {"project": ".mcp.json", "user": ".claude.json"}, "mcpServers", stdio=True),
    "cursor": _Agent(".cursor", {"project": ".cursor/mcp.json", "user": ".cursor/mcp.json"}, "mcpServers", stdio=True),
    "vscode": _Agent(".vscode", {"project": ".vscode/mcp.json"}, "servers", stdio=True),
    "gemini": _Agent(".gemini", {"project": ".gemini/settings.json", "user": ".gemini/settings.json"}, "mcpServers"),
    "windsurf": _Agent(".codeium/windsurf", {"user": ".codeium/windsurf/mcp_config.json"}, "mcpServers"),
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
                new = _merge(old, agent.key, entry, shown)
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
