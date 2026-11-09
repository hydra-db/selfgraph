import argparse
import io
import json
import subprocess
import sys

import pytest
from helpers import (
    AB_ONTOLOGY,
    RAW_CYPHER,
    cli,
    extracting_llm,
    fresh_graph,
    json_file,
    kuzu_main,
    new_graph,
    preference_update_recorder,
    run,
    skip_on_generic,
    t_entities,
    utc,
)

import selfgraph
from selfgraph.cli import _metadata, build_parser, main
from selfgraph.errors import ValidationError
from selfgraph.runtime import parse_time


def test_insert_ontology_then_read(capsys, tmp_path):
    g = new_graph()
    path = json_file(
        tmp_path, "ont.json", {"entities": [{"name": "HydraDB", "type": "Company", "id": "company:hydradb"}]}
    )
    assert cli(g, ["insert", "ontology", path], capsys)["entities"][0]["id"] == "company:hydradb"
    assert cli(g, ["entity", "get", "company:hydradb"], capsys)["name"] == "HydraDB"
    assert [e["id"] for e in cli(g, ["entity", "list", "--type", "Company"], capsys)["items"]] == ["company:hydradb"]

    if RAW_CYPHER:
        query = "MATCH (e:Entity {id:'company:hydradb', ns:'default'}) RETURN e.id AS id"
        assert {"id": "company:hydradb"} in cli(g, ["query", query], capsys)["rows"]


def test_entity_create_parses_props_and_aliases(capsys):
    g = new_graph()
    argv = ["entity", "create", "--name", "A", "--type", "T", "--id", "t:a", "--alias", "Ay"]
    out = cli(g, [*argv, "--prop", "score=1", "--prop", "tag=x"], capsys)
    assert out["id"] == "t:a"
    assert out["aliases"] == ["Ay"]
    assert out["properties"] == {"score": 1, "tag": "x"}


def test_relation_create_update_versions(capsys):
    g = new_graph()
    t_entities(g, "a", "b")
    assert cli(g, ["relation", "create", "t:a", "KNOWS", "t:b", "--id", "relation:r1"], capsys)["id"] == "relation:r1"
    assert cli(g, ["relation", "update", "relation:r1", "--set", "weight=2"], capsys)["properties"]["weight"] == 2
    assert [v["revision"] for v in cli(g, ["relation", "versions", "relation:r1"], capsys)] == [2, 1]


@skip_on_generic
def test_query_param_is_json_typed(capsys):
    g = new_graph()
    cli(g, ["entity", "create", "--name", "A", "--type", "T", "--id", "t:a"], capsys)
    query = "MATCH (e:Entity {id:$id, ns:'default'}) RETURN e.id AS id"
    assert {"id": "t:a"} in cli(g, ["query", query, "--param", 'id="t:a"'], capsys)["rows"]


def test_insert_text_dash_reads_stdin(capsys, monkeypatch):
    g = new_graph()
    monkeypatch.setattr("sys.stdin", io.StringIO("Acme Corp hired Jane Doe."))
    out = cli(g, ["insert", "text", "-", "--event-time", "2024-01-02T03:04:05+00:00"], capsys)
    assert {e["name"] for e in out["entities"]} >= {"Acme Corp", "Jane Doe"}
    assert out["relations"] and all(r["event_time"] == "2024-01-02T03:04:05Z" for r in out["relations"])


def test_decision_event_time_and_alternatives(capsys):
    g = new_graph()
    t_entities(g, "a", "b", "c")
    cli(g, ["relation", "create", "t:a", "KNOWS", "t:b", "--id", "relation:r1"], capsys)

    create = ["decision", "create", "D", "--id", "decision:d1", "--step", "relation:r1", "--alternative", "t:c"]
    assert (
        cli(g, [*create, "--event-time", "2024-05-06T00:00:00+00:00"], capsys)["event_time"] == "2024-05-06T00:00:00Z"
    )

    update = ["decision", "update", "decision:d1", "--alternative", "t:a", "--alternative", "t:b"]
    for argv in (
        [*update, "--event-time", "2023-01-01T00:00:00+00:00"],
        ["decision", "update", "decision:d1", "--title", "D2"],
    ):
        out = cli(g, argv, capsys)
        assert out["alternative_entities"] == ["t:a", "t:b"]
        assert out["event_time"] == "2023-01-01T00:00:00Z"


def _subcommands(parser):
    return next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))


@pytest.mark.parametrize(
    ("argv", "env", "message"),
    [
        (["--namespace", ""], {}, "namespace cannot be empty"),
        ([], {"SELFGRAPH_NAMESPACE": " "}, "namespace cannot be empty"),
        ([], {"SELFGRAPH_NAMESPACE": ""}, "namespace cannot be empty"),
        (["--namespace", " x"], {}, "namespace cannot start or end with whitespace"),
        (["--llm-timeout", "-5"], {}, "llm_timeout must be a positive number"),
        (["--llm-concurrency", "0"], {}, "llm_concurrency must be a positive integer"),
        (["--llm-provider", "gemini"], {}, "pass --llm-model"),
        (
            ["--llm-provider", "anthropic", "--llm-model", "gemini/x"],
            {},
            "provider 'anthropic' conflicts with model prefix 'gemini'",
        ),
        (["--uri", ""], {}, "uri cannot be empty"),
        ([], {"SELFGRAPH_URI": ""}, "uri cannot be empty"),
        ([], {"SELFGRAPH_RESOLVER": "bogus"}, "resolver must be one of"),
        ([], {"SELFGRAPH_SCHEMA_MODE": "bogus"}, "schema_mode must be one of"),
        (["--schema", '{"nodes": []}'], {}, "unknown key 'nodes' in schema"),
        (["--prompts", "/nonexistent/prompts.json"], {}, "cannot read '/nonexistent/prompts.json'"),
        (["--prompts", '{"entities": {"system": "s", "user": "x", "version": "1"}}'], {}, "{text}"),
        (
            ["--prompts", '{"entities": {"system": "s", "user": "{text} {bogus}", "version": "1"}}'],
            {},
            "unknown variable {bogus}",
        ),
        (
            [],
            {"SELFGRAPH_PROMPTS": '{"entities": {"system": "s", "user": "{text}"}}'},
            "error: invalid prompts: entities.version: field required\n",
        ),
        (["--instructions", "{nope"], {}, "invalid JSON in the inline instructions"),
        (["--instructions", "/nonexistent/instructions.json"], {}, "cannot read"),
        (["--uri", "graph.kuzu"], {}, "this looks like a Kuzu path; pass --store kuzu (or SELFGRAPH_STORE=kuzu)"),
        (["--store", "falkordb", "--uri", "bolt://h:6379"], {}, "the 'falkordb' store expects host:port or a redis://"),
    ],
)
def test_bad_settings_exit_2_before_any_command(capsys, monkeypatch, argv, env, message):
    for var, value in env.items():
        monkeypatch.setenv(var, value)
    for command in ("version", "mcp"):
        assert main([*argv, command]) == 2
        assert message in capsys.readouterr().err


def test_init_prints_the_inferred_store(capsys, monkeypatch, tmp_path):
    pytest.importorskip("kuzu")
    for var in ("SELFGRAPH_STORE", "SELFGRAPH_URI", "SELFGRAPH_NAMESPACE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert main(["init"]) == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True, "store": "kuzu", "namespace": "default"}


def test_closed_stdout_pipe_exits_141(capsys, tmp_path):
    entities = [{"type": "T", "name": f"Entity number {i} with a long name"} for i in range(600)]
    assert kuzu_main(tmp_path, "insert", "ontology", json_file(tmp_path, "many.json", {"entities": entities})) == 0
    command = [sys.executable, "-m", "selfgraph.cli", "--store", "kuzu", "--uri", str(tmp_path / "cli.kuzu")]
    script = " ".join(f"'{a}'" for a in [*command, "entity", "list", "--limit", "1000"])
    closed = subprocess.run(
        ["bash", "-c", script + ' | head -c 0; echo "status=${PIPESTATUS[0]}"'], capture_output=True, text=True
    )
    assert closed.stdout.strip() == "status=141"
    assert "BrokenPipeError" not in closed.stderr


def test_get_of_a_missing_id_fails_like_delete(capsys, tmp_path):
    for resource in ("entity", "relation", "preference", "decision"):
        missing = "x:missing" if resource == "entity" else f"{resource}:missing"
        assert kuzu_main(tmp_path, resource, "get", missing) == 1
        captured = capsys.readouterr()
        assert captured.out == ""
        assert f"{missing!r} does not exist" in captured.err
        for action in ("get", "delete") if resource != "entity" else ():
            assert kuzu_main(tmp_path, resource, action, "my-id") == 2
            assert f"{resource} id must start with '{resource}:', got 'my-id'" in capsys.readouterr().err


def test_global_flags_after_the_subcommand(capsys, tmp_path):
    pytest.importorskip("kuzu")
    uri = str(tmp_path / "late.kuzu")
    assert (
        main(["entity", "create", "--name", "A", "--type", "T", "--store", "kuzu", "--uri", uri, "--namespace", "n"])
        == 0
    )
    capsys.readouterr()
    assert main(["--store", "kuzu", "--uri", uri, "entity", "get", "t:a", "--namespace", "n"]) == 0
    assert json.loads(capsys.readouterr().out)["id"] == "t:a"
    assert main(["--store", "kuzu", "--uri", uri, "--namespace", "n", "entity", "get", "t:a", "--namespace", "m"]) == 1
    capsys.readouterr()
    with pytest.raises(SystemExit) as exc:
        main(["entity", "get", "t:a", "--bogus"])
    assert exc.value.code == 2


def test_time_flags_share_one_parser(capsys):
    for text in ("2024-01-02T00:00:00Z", "2024-01-02", "2024-01-02T00:00:00", "2024-01-02T01:00:00+01:00"):
        assert parse_time(text, "event_time") == utc(2024, 1, 2)
    with pytest.raises(ValidationError, match="invalid now: 'soon' is not an ISO 8601 date or time"):
        parse_time("soon", "now")
    g = fresh_graph("cli-time")
    cli(g, ["entity", "create", "--name", "a", "--type", "T"], capsys)
    cli(g, ["entity", "create", "--name", "b", "--type", "T"], capsys)
    out = cli(g, ["relation", "create", "t:a", "KNOWS", "t:b", "--event-time", "2024-01-02T03:04:05Z"], capsys)
    assert out["event_time"] == "2024-01-02T03:04:05Z"
    with pytest.raises(SystemExit):
        cli(g, ["relation", "create", "t:a", "KNOWS", "t:b", "--event-time", "soon"], capsys)
    assert "is not an ISO 8601 date or time" in capsys.readouterr().err


def test_schema_formats_default_to_neo4j_and_bare_schema_hints(capsys, tmp_path):
    neo = {"node_types": [{"label": "Person", "properties": []}], "relationship_types": [], "patterns": []}
    assert kuzu_main(tmp_path, "schema", "import", json_file(tmp_path, "neo.json", neo)) == 0
    schema = tmp_path / "schema.json"
    schema.write_text(capsys.readouterr().out)
    assert kuzu_main(tmp_path, "--schema", str(schema), "schema", "export") == 0
    assert json.loads(capsys.readouterr().out)["node_types"][0]["label"] == "Person"
    assert kuzu_main(tmp_path, "schema") == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) is None
    assert "no schema set; pass --schema FILE or SELFGRAPH_SCHEMA" in captured.err


def test_updates_need_a_change_and_clear_named_fields(capsys):
    g = fresh_graph("cli-update")
    t_entities(g, "a", "b")
    rel = cli(g, ["relation", "create", "t:a", "KNOWS", "t:b"], capsys)["id"]
    pref = cli(g, ["preference", "create", "t:a", "likes", "t:b"], capsys)["id"]
    create = ["decision", "create", "D", "--id", "decision:d", "--step", rel, "--summary", "s", "--rationale", "r"]
    cli(g, [*create, "--actor", "t:a", "--event-time", "2024-01-01"], capsys)
    for argv in (
        ["entity", "update", "t:a"],
        ["relation", "update", rel],
        ["preference", "update", pref],
        ["decision", "update", "decision:d"],
    ):
        with pytest.raises(ValidationError, match="nothing to update"):
            cli(g, argv, capsys)
    with pytest.raises(ValidationError, match="cannot both set and clear 'summary'"):
        cli(g, ["decision", "update", "decision:d", "--summary", "x", "--clear", "summary"], capsys)
    out = cli(g, ["decision", "update", "decision:d", "--clear", "summary", "--clear", "actor_entity"], capsys)
    assert (out["summary"], out["actor_entity"], out["rationale"]) == (None, None, "r")
    out = cli(g, ["decision", "update", "decision:d", "--clear", "event_time"], capsys)
    assert out["event_time"] is None
    out = cli(g, ["decision", "update", "decision:d", "--alternative", "t:b"], capsys)
    assert out["alternative_entities"] == ["t:b"]
    out = cli(g, ["decision", "update", "decision:d", "--clear", "alternative_entities"], capsys)
    assert (out["alternative_entities"], [s["relation_id"] for s in out["steps"]]) == ([], [rel])
    assert cli(g, ["decision", "update", "decision:d", "--clear", "steps"], capsys)["steps"] == []
    with pytest.raises(ValidationError, match="preferences.update cannot both set and clear 'strength'"):
        cli(g, ["preference", "update", pref, "--strength", "1", "--clear", "strength"], capsys)
    graph, calls = preference_update_recorder()
    args = build_parser().parse_args(["preference", "update", "preference:p", "--clear", "strength"])
    run(args.func(graph, args))
    assert calls == [("preference:p", {"clear": ["strength"]})]


def test_store_settings_warnings_params_and_inline_schema(capsys, tmp_path, monkeypatch):
    monkeypatch.delenv("SELFGRAPH_STORE", raising=False)
    assert kuzu_main(tmp_path, "--database", "x", "--auth", "u:p", "init") == 0
    err = capsys.readouterr().err
    assert "warning: --database is ignored by store kuzu" in err
    assert "warning: --auth is ignored by store kuzu" in err
    assert kuzu_main(tmp_path, "query", "RETURN $a AS a, '$b' AS b") == 2
    assert "missing parameter $a" in capsys.readouterr().err
    assert kuzu_main(tmp_path, "query", "RETURN $a AS a", "--param", "a=1", "--param", "b=2") == 0
    assert json.loads(capsys.readouterr().out)["rows"] == [{"a": 1}]
    schema = json.dumps({"entities": [{"name": "Person"}]})
    assert kuzu_main(tmp_path, "--schema", schema, "schema") == 0
    assert json.loads(capsys.readouterr().out)["entities"][0]["name"] == "Person"


def test_bad_ontology_and_schema_files_fail_cleanly_and_warnings_reach_stderr(capsys, tmp_path):
    bad = json_file(tmp_path, "bad.json", {"entities": [{"type": "P"}, {"name": 3, "type": "P"}]})
    assert kuzu_main(tmp_path, "insert", "ontology", bad) == 2
    expected = "error: invalid ontology:\n  entities[0].name: field required\n  entities[1].name: expected string\n"
    assert capsys.readouterr().err == expected
    schema = json_file(tmp_path, "schema.json", {"entities": [{"name": "Person"}]})
    assert kuzu_main(tmp_path, "schema", "import", schema) == 2
    assert "looks like a SelfGraph schema, not a Neo4j one" in capsys.readouterr().err
    ont = json_file(tmp_path, "ont.json", {"entities": [{"name": "B", "type": "Company"}]})
    assert kuzu_main(tmp_path, "--schema", schema, "insert", "ontology", ont) == 0
    captured = capsys.readouterr()
    assert "selfgraph: unknown_entity_type: entity company:b has unknown type 'Company'\n" in captured.err
    assert json.loads(captured.out)["warnings"][0]["code"] == "unknown_entity_type"


def test_relation_update_aliases_and_dry_run_plans_omit_deleted(capsys):
    g = new_graph()
    t_entities(g, "a", "b")
    cli(g, ["relation", "create", "t:a", "KNOWS", "t:b", "--id", "relation:r1", "--prop", "x=1"], capsys)
    out = cli(g, ["relation", "update", "relation:r1", "--prop", "w=2", "--remove-prop", "x"], capsys)
    assert out["properties"] == {"w": 2}
    assert "deleted" not in cli(g, ["maintenance", "consolidate"], capsys)
    assert cli(g, ["maintenance", "consolidate"], capsys)["dry_run"] is True
    plan = cli(g, ["maintenance", "prune", "--min-relevance", "0.5"], capsys)
    assert "deleted" not in plan and plan["dry_run"] is True
    assert "deleted" in cli(g, ["maintenance", "consolidate", "--apply"], capsys)


def test_surface_hints_flag_errors_and_iso_times(capsys, tmp_path, monkeypatch):
    for key in ("SELFGRAPH_LLM_PROVIDER", "SELFGRAPH_LLM_MODEL", "SELFGRAPH_RESOLVER"):
        monkeypatch.delenv(key, raising=False)
    assert kuzu_main(tmp_path, "--resolver", "llm", "entity", "list") == 2
    err = capsys.readouterr().err
    assert "pass --llm-provider and --llm-model (or SELFGRAPH_LLM_*)" in err and "llm=" not in err
    assert kuzu_main(tmp_path, "insert", "text", "Acme acquired Globex.") == 0
    captured = capsys.readouterr()
    assert "for model-based extraction, pass --llm-provider and --llm-model" in captured.err
    assert "llm=" not in captured.err
    assert "pass --llm-provider" in json.loads(captured.out)["warnings"][0]["message"]
    assert kuzu_main(tmp_path, "maintenance", "prune", "--older-than", "2999-01-01") == 2
    assert "older_than 2999-01-01T00:00:00Z is in the future" in capsys.readouterr().err
    assert kuzu_main(tmp_path, "entity", "create", "--name", "a", "--type", "T", "--prop", '{"x":1}') == 2
    assert "--prop expects KEY=VALUE, got '{\"x\":1}'" in capsys.readouterr().err
    assert kuzu_main(tmp_path, "insert", "text", "Ann.", "--metadata", "{notjson") == 2
    assert "invalid JSON in --metadata" in capsys.readouterr().err
    monkeypatch.setenv("SELFGRAPH_DATABASE", "x")
    monkeypatch.setenv("SELFGRAPH_AUTH", "u:p")
    assert kuzu_main(tmp_path, "init") == 0
    assert "ignored" not in capsys.readouterr().err


def test_version_and_help_text(capsys):
    for flag in ("--version", "-V"):
        with pytest.raises(SystemExit) as exc:
            main([flag])
        assert exc.value.code == 0
        assert capsys.readouterr().out.strip() == selfgraph.__version__
    with pytest.raises(SystemExit):
        main(["mcp", "--help"])
    out = capsys.readouterr().out
    assert "--store" in out and "--schema" in out and "default: server default" in out
    top = _subcommands(build_parser())
    for group in ("entity", "relation", "preference", "decision"):
        sub = _subcommands(top.choices[group])
        helps = {a.dest: a.help for a in sub._choices_actions}
        assert set(helps) == set(sub.choices)
        assert all(helps.values()), helps
    helps = {a.dest: a.help for a in top._choices_actions}
    assert helps["maintenance"] == "decay (score relevance), prune, or consolidate duplicate relations"

    def flag_help(group, action, flag):
        return _subcommands(top.choices[group]).choices[action]._option_string_actions[flag].help

    assert flag_help("entity", "list", "--name") == "exact, case-sensitive match on the current name"
    assert flag_help("entity", "update", "--type") == (
        "change the type's case or spacing only (the type is part of the id)"
    )
    assert "ignored if absent" in flag_help("relation", "update", "--remove")
    assert "KEY=VALUE, VALUE parsed as JSON" in flag_help("entity", "create", "--prop")
    assert "\nschema import" in top.choices["schema"].format_help()


def test_exit_codes_and_context_only(capsys, tmp_path):
    assert kuzu_main(tmp_path, "insert", "ontology", str(tmp_path / "nofile.json")) == 2
    capsys.readouterr()
    assert kuzu_main(tmp_path, "retrieve", "x", "--depth", "-1", "--k", "0", "--budget-tokens", "0") == 2
    assert capsys.readouterr().err == "error: depth must be >= 0, got -1\n"
    assert kuzu_main(tmp_path, "retrieve", "x", "--k", "0") == 2
    assert capsys.readouterr().err == "error: k must be >= 1, got 0\n"
    ont = json_file(tmp_path, "ab.json", AB_ONTOLOGY)
    assert kuzu_main(tmp_path, "insert", "ontology", ont) == 0
    capsys.readouterr()
    assert kuzu_main(tmp_path, "retrieve", "A", "--context-only") == 0
    out = capsys.readouterr().out
    assert out.strip() and not out.startswith("{")
    assert kuzu_main(tmp_path, "decision", "create", "No steps") == 0
    assert json.loads(capsys.readouterr().out)["steps"] == []


def test_multi_chunk_llm_insert_prints_progress_on_stderr(capsys, tmp_path, monkeypatch):
    monkeypatch.setattr(selfgraph.runtime, "_build_llm", lambda settings: extracting_llm([("Person", "Alice")]))
    text = "Alice met Bob near the old river bridge at dawn. " * 600
    assert kuzu_main(tmp_path, "insert", "text", text) == 0
    err = capsys.readouterr().err
    assert "selfgraph: extracting chunk 1/" in err and "selfgraph: extracting chunk 2/" in err


def test_evidence_commands_and_parity_flags(capsys, tmp_path):
    g = fresh_graph("cli-parity")
    path = json_file(tmp_path, "ab.json", AB_ONTOLOGY)
    for source in ("s1", "s2"):
        out = cli(g, ["insert", "ontology", path, "--source-id", source, "--event-time", "2020-05-01"], capsys)
        assert out["relations"][0]["event_time"] == "2020-05-01T00:00:00Z"
    page = cli(g, ["entity", "evidence", "t:a", "--limit", "1"], capsys)
    rest = cli(g, ["entity", "evidence", "t:a", "--cursor", page["next_cursor"]], capsys)
    assert sorted(e["source_id"] for e in page["items"] + rest["items"]) == ["s1", "s2"]
    evidence = '{"source_id": "doc-1", "quote": "A knows B"}'
    cli(g, ["relation", "update", "relation:ab", "--set", "w=2", "--evidence", evidence], capsys)
    quotes = {e["source_id"]: e["quote"] for e in cli(g, ["relation", "evidence", "relation:ab"], capsys)["items"]}
    assert quotes == {"s1": None, "s2": None, "doc-1": "A knows B"}
    assert [v["revision"] for v in cli(g, ["relation", "versions", "relation:ab", "--oldest-first"], capsys)] == [1, 2]
    created = cli(g, ["relation", "create", "t:b", "LIKES", "t:a", "--evidence", f"[{evidence}]"], capsys)
    assert cli(g, ["relation", "evidence", created["id"]], capsys)["items"][0]["source_id"] == "doc-1"
    result = cli(g, ["retrieve", "who", "knows", "B", "--k", "5"], capsys)
    assert result["query"] == "who knows B"
    assert _metadata(["a=1", '{"b": "x"}', "c=text"]) == {"a": 1, "b": "x", "c": "text"}
    with pytest.raises(ValidationError, match="--metadata expects KEY=VALUE, got 'nope'"):
        _metadata(["nope"])
    args = build_parser().parse_args(["preference", "list", "--key", "db", "--kind", "disinterest"])
    assert (args.key, args.kind) == ("db", "disinterest")
