import io
import json

import pytest
from helpers import RAW_CYPHER, new_graph, run, skip_on_generic, unique_ns

from selfgraph.cli import build_parser, dispatch, main


def _args(argv):
    return build_parser().parse_args(argv)


def _out(capsys):
    return json.loads(capsys.readouterr().out)


def test_insert_ontology_then_read(capsys, tmp_path):
    g = new_graph()
    ont = {"entities": [{"name": "HydraDB", "type": "Company", "id": "company:hydradb"}]}
    path = tmp_path / "ont.json"
    path.write_text(json.dumps(ont))

    run(dispatch(g, _args(["insert", "ontology", str(path)])))
    assert _out(capsys)["entities"][0]["id"] == "company:hydradb"

    run(dispatch(g, _args(["entity", "get", "company:hydradb"])))
    assert _out(capsys)["name"] == "HydraDB"

    run(dispatch(g, _args(["entity", "list", "--type", "Company"])))
    assert [e["id"] for e in _out(capsys)["items"]] == ["company:hydradb"]

    if RAW_CYPHER:
        run(
            dispatch(
                g,
                _args(
                    [
                        "query",
                        "MATCH (e:Entity {id:'company:hydradb', ns:'default'}) RETURN e.id AS id",
                    ]
                ),
            )
        )
        assert {"id": "company:hydradb"} in _out(capsys)["rows"]


def test_entity_create_parses_props_and_aliases(capsys):
    g = new_graph()
    run(
        dispatch(
            g,
            _args(
                [
                    "entity",
                    "create",
                    "--name",
                    "A",
                    "--type",
                    "T",
                    "--id",
                    "t:a",
                    "--alias",
                    "Ay",
                    "--prop",
                    "score=1",
                    "--prop",
                    "tag=x",
                ]
            ),
        )
    )
    out = _out(capsys)
    assert out["id"] == "t:a"
    assert out["aliases"] == ["Ay"]
    assert out["properties"] == {"score": 1, "tag": "x"}


def test_relation_create_update_versions(capsys):
    g = new_graph()
    for name in ("a", "b"):
        run(dispatch(g, _args(["entity", "create", "--name", name, "--type", "T", "--id", f"t:{name}"])))
        capsys.readouterr()

    run(dispatch(g, _args(["relation", "create", "t:a", "KNOWS", "t:b", "--id", "relation:r1"])))
    assert _out(capsys)["id"] == "relation:r1"

    run(dispatch(g, _args(["relation", "update", "relation:r1", "--set", "weight=2"])))
    assert _out(capsys)["properties"]["weight"] == 2

    run(dispatch(g, _args(["relation", "versions", "relation:r1"])))
    versions = _out(capsys)
    assert [v["revision"] for v in versions] == [2, 1]


@skip_on_generic
def test_query_param_is_json_typed(capsys):
    g = new_graph()
    run(dispatch(g, _args(["entity", "create", "--name", "A", "--type", "T", "--id", "t:a"])))
    capsys.readouterr()
    run(
        dispatch(
            g,
            _args(
                [
                    "query",
                    "MATCH (e:Entity {id:$id, ns:'default'}) RETURN e.id AS id",
                    "--param",
                    'id="t:a"',
                ]
            ),
        )
    )
    assert {"id": "t:a"} in _out(capsys)["rows"]


def test_insert_text_dash_reads_stdin(capsys, monkeypatch):
    g = new_graph()
    monkeypatch.setattr("sys.stdin", io.StringIO("Acme Corp hired Jane Doe."))
    run(dispatch(g, _args(["insert", "text", "-", "--event-time", "2024-01-02T03:04:05+00:00"])))
    out = _out(capsys)
    assert {e["name"] for e in out["entities"]} >= {"Acme Corp", "Jane Doe"}
    assert out["relations"] and all(r["event_time"] == "2024-01-02T03:04:05Z" for r in out["relations"])


def test_decision_event_time_and_alternatives(capsys):
    g = new_graph()
    for name in ("a", "b", "c"):
        run(dispatch(g, _args(["entity", "create", "--name", name, "--type", "T", "--id", f"t:{name}"])))
    run(dispatch(g, _args(["relation", "create", "t:a", "KNOWS", "t:b", "--id", "relation:r1"])))
    capsys.readouterr()

    create = ["decision", "create", "D", "--id", "decision:d1", "--step", "relation:r1", "--alternative", "t:c"]
    run(dispatch(g, _args([*create, "--event-time", "2024-05-06T00:00:00+00:00"])))
    assert _out(capsys)["event_time"] == "2024-05-06T00:00:00Z"

    update = ["decision", "update", "decision:d1", "--alternative", "t:a", "--alternative", "t:b"]
    run(dispatch(g, _args([*update, "--event-time", "2023-01-01T00:00:00+00:00"])))
    out = _out(capsys)
    assert out["alternative_entities"] == ["t:a", "t:b"]
    assert out["event_time"] == "2023-01-01T00:00:00Z"

    run(dispatch(g, _args(["decision", "update", "decision:d1", "--title", "D2"])))
    out = _out(capsys)
    assert out["alternative_entities"] == ["t:a", "t:b"]
    assert out["event_time"] == "2023-01-01T00:00:00Z"


def test_blank_namespace_is_a_validation_error(capsys, monkeypatch):
    assert main(["--namespace", "", "init"]) == 2
    assert "namespace must be a non-empty string" in capsys.readouterr().err
    monkeypatch.setenv("SELFGRAPH_NAMESPACE", " ")
    assert main(["init"]) == 2
    assert "namespace must be a non-empty string" in capsys.readouterr().err


def test_init_prints_the_inferred_store(capsys, monkeypatch, tmp_path):
    pytest.importorskip("kuzu")
    for var in ("SELFGRAPH_STORE", "SELFGRAPH_URI", "SELFGRAPH_NAMESPACE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert main(["init"]) == 0
    assert _out(capsys) == {"ok": True, "store": "kuzu", "namespace": "default"}


def test_entity_and_relation_evidence_commands(capsys, tmp_path):
    g = new_graph(namespace=unique_ns("cli-ev"))
    ont = {
        "entities": [{"name": "A", "type": "T", "id": "t:a"}, {"name": "B", "type": "T", "id": "t:b"}],
        "relations": [{"id": "relation:ab", "from_entity": "t:a", "type": "KNOWS", "to_entity": "t:b"}],
    }
    path = tmp_path / "ont.json"
    path.write_text(json.dumps(ont))
    for source in ("s1", "s2"):
        run(dispatch(g, _args(["insert", "ontology", str(path), "--source-id", source])))
        capsys.readouterr()

    run(dispatch(g, _args(["entity", "evidence", "t:a", "--limit", "1"])))
    page = _out(capsys)
    run(dispatch(g, _args(["entity", "evidence", "t:a", "--cursor", page["next_cursor"]])))
    rest = _out(capsys)
    assert sorted(e["source_id"] for e in page["items"] + rest["items"]) == ["s1", "s2"]

    run(dispatch(g, _args(["relation", "evidence", "relation:ab"])))
    assert sorted(e["source_id"] for e in _out(capsys)["items"]) == ["s1", "s2"]
