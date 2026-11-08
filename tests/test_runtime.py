import json

import pytest
from helpers import NEO4J_URI, run, store_settings

from selfgraph import Neo4jStore
from selfgraph.errors import ValidationError
from selfgraph.runtime import (
    GraphSettings,
    _parse_auth,
    build_graph,
    dumps,
    settings_from_env,
    store_kind,
    to_jsonable,
)


def test_settings_from_env_and_overrides(monkeypatch):
    monkeypatch.setenv("SELFGRAPH_STORE", "neo4j")
    monkeypatch.setenv("SELFGRAPH_NAMESPACE", "team")
    s = settings_from_env()
    assert s.store == "neo4j" and s.namespace == "team"
    assert settings_from_env(store="hydradb").store == "hydradb"


def test_build_neo4j_graph():
    g = build_graph(GraphSettings(store="neo4j", uri=NEO4J_URI, namespace="ns1"))
    assert isinstance(g.store, Neo4jStore)
    assert g.namespace == "ns1"


def test_unknown_store_rejected():
    with pytest.raises(ValidationError):
        build_graph(GraphSettings(store="bogus"))


def test_bolt_store_needs_uri():
    with pytest.raises(ValidationError):
        build_graph(GraphSettings(store="neo4j"))


def test_parse_auth():
    assert _parse_auth(None) is None
    assert _parse_auth("neo4j:secret") == ("neo4j", "secret")
    assert _parse_auth("a-bare-token") == ("neo4j", "a-bare-token")


def test_llm_needs_provider_and_model():
    with pytest.raises(ValidationError):
        build_graph(GraphSettings(store="neo4j", uri=NEO4J_URI, llm_provider="openai"))


def test_jsonable_and_dumps():
    g = build_graph(store_settings())
    run(g.initialize())
    e = run(g.entities.create("HydraDB", "Company", id="company:hydradb"))
    assert json.loads(dumps(e))["id"] == "company:hydradb"
    assert to_jsonable(None) is None
    assert to_jsonable([e])[0]["name"] == "HydraDB"


def test_blank_namespace_rejected_unset_defaults(monkeypatch):
    for ns in ("", "   "):
        with pytest.raises(ValidationError, match="namespace"):
            build_graph(GraphSettings(store="neo4j", uri=NEO4J_URI, namespace=ns))
    monkeypatch.setenv("SELFGRAPH_NAMESPACE", "")
    with pytest.raises(ValidationError, match="namespace"):
        build_graph(settings_from_env(store="neo4j", uri=NEO4J_URI))
    assert build_graph(GraphSettings(store="neo4j", uri=NEO4J_URI, namespace=None)).namespace == "default"


def test_store_kind():
    assert store_kind(GraphSettings()) == "kuzu"
    assert store_kind(GraphSettings(uri="bolt://x:1")) == "hydradb"
    assert store_kind(GraphSettings(store="Neo4j", uri="bolt://x:1")) == "neo4j"


def test_falkordb_settings_pass_credentials_and_graph():
    pytest.importorskip("falkordb")

    def built(**over):
        store = build_graph(GraphSettings(store="falkordb", **over)).store
        return store._host, store._port, store._graph_name, store._client_kwargs

    assert built(uri="db:6390") == ("db", 6390, "selfgraph", {})
    assert built(uri="db:6390", auth="u:p w", database="g1") == ("db", 6390, "g1", {"username": "u", "password": "p w"})
    assert built(uri="db", auth="tok") == ("db", 6379, "selfgraph", {"password": "tok"})
    assert built(uri="redis://u:p%40w@db:6390") == ("db", 6390, "selfgraph", {"username": "u", "password": "p@w"})
    assert built(uri="redis://u:bad@db:6390", auth="v:ok")[3] == {"username": "v", "password": "ok"}
