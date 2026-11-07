import json

from helpers import RAW_CYPHER, new_graph, run, skip_on_generic

from selfgraph.cli import build_parser, dispatch


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
