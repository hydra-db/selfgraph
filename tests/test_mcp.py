import importlib.util

import pytest
from helpers import RAW_CYPHER, run, store_settings

import selfgraph.mcp.server as srv

_HAS_MCP = importlib.util.find_spec("mcp") is not None


def _memory():
    srv.configure(store_settings())


def test_tools_build_and_read_graph():
    _memory()
    run(srv.create_entity("HydraDB", "Company", id="company:hydradb"))
    assert run(srv.get_entity("company:hydradb"))["name"] == "HydraDB"

    listed = run(srv.list_entities(type="Company"))
    assert [e["id"] for e in listed["items"]] == ["company:hydradb"]

    if RAW_CYPHER:
        rows = run(srv.run_cypher("MATCH (e:Entity {id:'company:hydradb', ns:'default'}) RETURN e.id AS id"))
        assert {"id": "company:hydradb"} in rows["rows"]


def test_insert_ontology_tool_and_relation_versions():
    _memory()
    run(
        srv.insert_ontology(
            {
                "entities": [
                    {"name": "A", "type": "T", "id": "t:a"},
                    {"name": "B", "type": "T", "id": "t:b"},
                ],
                "relations": [{"from_entity": "t:a", "type": "KNOWS", "to_entity": "t:b", "id": "relation:r1"}],
            }
        )
    )
    assert run(srv.get_relation("relation:r1"))["type"] == "KNOWS"
    run(srv.update_relation("relation:r1", set_properties={"w": 2}))
    assert [v["revision"] for v in run(srv.relation_versions("relation:r1"))] == [2, 1]


def test_build_server_contract():
    if _HAS_MCP:
        assert srv.build_server() is not None
    else:
        with pytest.raises(RuntimeError):
            srv.build_server()
