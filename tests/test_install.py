import json
import os
import sys

import pytest

from selfgraph import _install
from selfgraph.cli import main
from selfgraph.runtime import SETTING_KEYS


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    """Run in an empty project folder with an empty home folder and no SELFGRAPH_* variables.

    @param tmp_path (Path): the test's temporary folder.
    @param monkeypatch (pytest.MonkeyPatch): restores the environment afterwards.
    @return (tuple[Path, Path]): the project and home folders.
    """
    project, home = tmp_path / "project", tmp_path / "home"
    project.mkdir()
    home.mkdir()
    monkeypatch.chdir(project)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    for key in SETTING_KEYS:
        monkeypatch.delenv(f"SELFGRAPH_{key.upper()}", raising=False)
    monkeypatch.setattr("selfgraph.cli.server_command", lambda: ("selfgraph", ["mcp"]))
    return project, home


def install(capsys, *argv):
    code = main(["install", *argv])
    out, err = capsys.readouterr()
    return code, out.splitlines(), err.splitlines()


def snapshot(*roots):
    return {str(p): p.read_bytes() for root in roots for p in sorted(root.rglob("*")) if p.is_file()}


def test_writes_each_agents_file_shape(capsys, dirs):
    project, home = dirs
    code, out, _ = install(capsys, "claude", "cursor", "vscode", "gemini", "windsurf")
    assert code == 0
    assert out == [
        "claude: wrote .mcp.json",
        "cursor: wrote .cursor/mcp.json",
        "vscode: wrote .vscode/mcp.json",
        "gemini: wrote .gemini/settings.json",
        "windsurf: wrote ~/.codeium/windsurf/mcp_config.json",
        "Restart or reload the agent to pick up the change.",
    ]
    stdio = {"type": "stdio", "command": "selfgraph", "args": ["mcp"]}
    plain = {"command": "selfgraph", "args": ["mcp"]}
    for path, key, entry in [
        (project / ".mcp.json", "mcpServers", stdio),
        (project / ".cursor/mcp.json", "mcpServers", stdio),
        (project / ".vscode/mcp.json", "servers", stdio),
        (project / ".gemini/settings.json", "mcpServers", plain),
        (home / ".codeium/windsurf/mcp_config.json", "mcpServers", plain),
    ]:
        assert path.read_text(encoding="utf-8") == json.dumps({key: {"selfgraph": entry}}, indent=2) + "\n"


def test_global_writes_user_files(capsys, dirs):
    project, home = dirs
    code, out, _ = install(capsys, "claude", "--global")
    assert code == 0
    assert out[0] == "claude: wrote ~/.claude.json"
    assert json.loads((home / ".claude.json").read_text())["mcpServers"]["selfgraph"]["command"] == "selfgraph"
    assert not list(project.iterdir())


def test_merges_with_other_servers_idempotently(capsys, dirs):
    project, _ = dirs
    (project / ".cursor").mkdir()
    cursor = {"theme": "dark", "mcpServers": {"other": {"command": "other", "args": ["x"]}}}
    (project / ".cursor/mcp.json").write_text(json.dumps(cursor), encoding="utf-8")

    assert install(capsys, "--store", "kuzu")[0] == 0
    first = snapshot(project)
    merged = json.loads((project / ".cursor/mcp.json").read_text())
    assert merged == {
        "theme": "dark",
        "mcpServers": {
            "other": {"command": "other", "args": ["x"]},
            "selfgraph": {
                "type": "stdio",
                "command": "selfgraph",
                "args": ["mcp"],
                "env": {"SELFGRAPH_STORE": "kuzu"},
            },
        },
    }
    assert install(capsys, "--store", "kuzu")[1] == ["cursor: unchanged .cursor/mcp.json"]
    assert snapshot(project) == first


def test_dry_run_writes_nothing(capsys, dirs):
    project, home = dirs
    (project / ".gemini").mkdir()
    code, out, _ = install(capsys, "--dry-run", "claude", "gemini")
    assert code == 0
    assert out == [
        "claude: would write .mcp.json",
        "gemini: would write .gemini/settings.json",
        "Dry run: nothing was written.",
    ]
    assert snapshot(project, home) == {}


def test_detects_agents_by_config_folder(capsys, dirs):
    project, home = dirs
    code, _, err = install(capsys)
    assert (code, err[0]) == (
        2,
        "error[invalid_argument]: found no agent config folder in this folder; "
        "name one or more of: claude, cursor, vscode, gemini, windsurf",
    )
    for folder in (project / ".vscode", project / ".claude", home / ".codeium/windsurf", home / ".gemini"):
        folder.mkdir(parents=True)
    assert [line.split(":")[0] for line in install(capsys, "--dry-run")[1][:-1]] == ["claude", "vscode"]
    assert install(capsys, "--dry-run", "--global")[1][:-1] == [
        "gemini: would write ~/.gemini/settings.json",
        "windsurf: would write ~/.codeium/windsurf/mcp_config.json",
    ]


def test_unsupported_scope_and_unknown_agent_fail(capsys, dirs):
    assert install(capsys, "vscode", "--global")[2][0] == (
        "error[invalid_argument]: vscode has no user-level config; run install vscode without --global"
    )
    code, _, err = install(capsys, "cursor", "nope")
    assert (code, err[0]) == (
        2,
        "error[invalid_argument]: unknown agent 'nope'; choose from claude, cursor, vscode, gemini, windsurf",
    )
    assert "field: agents" in err
    assert snapshot(*dirs) == {}


@pytest.mark.parametrize(
    "argv",
    [
        ["--store", "neo4j", "--uri", "bolt://db:7687", "--auth", "neo4j:secret"],
        ["--store", "neo4j", "--uri", "bolt://neo4j:secret@db:7687"],
        ["--llm-api-key", "sk-secret"],
        ["--llm-base-url", "https://u:secret@llm.example"],
    ],
)
def test_credentials_stay_out_of_project_files(capsys, dirs, argv):
    code, _, err = install(capsys, "claude", *argv)
    flag = argv[-2]
    key = flag[2:].replace("-", "_")
    assert code == 2
    assert err[0] == (
        f"error[invalid_argument]: {flag} holds a credential and .mcp.json may be committed; pass --global to write "
        f"the user config, or add SELFGRAPH_{key.upper()} to the entry's env by hand"
    )
    assert f"field: {key}" in err
    assert "secret" not in "\n".join(err)
    assert snapshot(*dirs) == {}
    assert install(capsys, "claude", "--global", *argv)[0] == 0
    entry = json.loads((dirs[1] / ".claude.json").read_text())["mcpServers"]["selfgraph"]
    assert entry["env"][f"SELFGRAPH_{key.upper()}"] == argv[-1]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("{nope", "cannot update '.cursor/mcp.json': not valid JSON"),
        ("[]", "cannot update '.cursor/mcp.json': not a JSON object"),
        ('{"mcpServers": []}', "cannot update '.cursor/mcp.json': mcpServers is not an object"),
    ],
)
def test_bad_file_fails_without_writing_anything(capsys, dirs, text, message):
    project, _ = dirs
    (project / ".cursor").mkdir()
    (project / ".cursor/mcp.json").write_text(text, encoding="utf-8")
    before = snapshot(project)
    code, out, err = install(capsys, "claude", "cursor")
    assert (code, out, err[0]) == (2, [], f"error[invalid_argument]: {message}")
    assert snapshot(project) == before


@pytest.mark.skipif(sys.platform == "win32" or os.geteuid() == 0, reason="needs POSIX permissions")
def test_unreadable_file_fails(capsys, dirs):
    project, _ = dirs
    (project / ".gemini").mkdir()
    (project / ".gemini/settings.json").write_text("{}", encoding="utf-8")
    (project / ".gemini/settings.json").chmod(0)
    try:
        assert install(capsys, "gemini")[2][0] == "error[invalid_argument]: cannot read '.gemini/settings.json'"
    finally:
        (project / ".gemini/settings.json").chmod(0o600)


def test_settings_given_as_flags_go_to_env(capsys, dirs, monkeypatch):
    project, _ = dirs
    monkeypatch.setenv("SELFGRAPH_LEVEL", "light")
    argv = ["--store", "kuzu", "--auth", "u:p", "install", "gemini", "--uri", "graph.kuzu", "--namespace", "team"]
    assert main(argv) == 0
    assert capsys.readouterr().err == "warning: --auth is ignored by store kuzu\n"
    entry = json.loads((project / ".gemini/settings.json").read_text())["mcpServers"]["selfgraph"]
    assert entry["env"] == {"SELFGRAPH_STORE": "kuzu", "SELFGRAPH_URI": "graph.kuzu", "SELFGRAPH_NAMESPACE": "team"}


def test_server_command_falls_back_to_this_interpreter(monkeypatch):
    monkeypatch.setattr(_install.shutil, "which", lambda name: None)
    assert _install.server_command() == (sys.executable, ["-m", "selfgraph", "mcp"])
    monkeypatch.setattr(_install.shutil, "which", lambda name: "/elsewhere/bin/selfgraph")
    assert _install.server_command() == (sys.executable, ["-m", "selfgraph", "mcp"])
