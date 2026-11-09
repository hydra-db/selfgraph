import json
import sys
from types import SimpleNamespace

import pytest
from helpers import NEO4J_URI, DriverError, make_store, run, store_settings

from selfgraph import KuzuStore, Neo4jStore, Schema, SelfGraph
from selfgraph._serde import LABELS
from selfgraph.errors import StoreError, TransientError, ValidationError, surface_hint
from selfgraph.models import CypherResult
from selfgraph.runtime import (
    GraphSettings,
    bind_params,
    build_graph,
    check_settings,
    dumps,
    settings_from_env,
    store_kind,
    to_jsonable,
)
from selfgraph.stores import cypher
from selfgraph.stores._cypher import bolt_auth, bolt_error, parse_auth, query_error
from selfgraph.stores.cypher import CypherStore
from selfgraph.stores.hydradb import HydraDBStore
from selfgraph.stores.kuzu import _kuzu_error


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


def test_parse_auth():
    assert parse_auth(None) is None
    assert parse_auth(("neo4j", "pw")) == ("neo4j", "pw")
    assert parse_auth("neo4j:secret") == ("neo4j", "secret")
    assert parse_auth("a-bare-token") == ("neo4j", "a-bare-token")
    assert bolt_auth("tok") == ("neo4j", "tok")
    for bad in (123, ("a",), ("a", 1)):
        with pytest.raises(ValidationError, match="auth must be 'user:password', a bare token"):
            HydraDBStore("bolt://127.0.0.1:1", auth=bad)


def test_unknown_llm_provider_fails_every_command_and_mcp_startup(monkeypatch, capsys):
    import selfgraph.mcp.server as srv
    from selfgraph.cli import main

    monkeypatch.setitem(sys.modules, "litellm", SimpleNamespace(provider_list=["anthropic", "openai"]))
    check_settings(GraphSettings(llm_model="openai/m"))
    bad = GraphSettings(store="kuzu", llm_provider="nonesuch", llm_model="m")
    with pytest.raises(ValidationError, match="^unknown LLM provider 'nonesuch'"):
        check_settings(bad)
    with pytest.raises(ValidationError, match="^unknown LLM provider 'nonesuch'"):
        srv.run_stdio(bad)
    assert main(["--llm-provider", "nonesuch", "--llm-model", "m", "version"]) == 2
    assert "unknown LLM provider 'nonesuch'" in capsys.readouterr().err
    assert main(["--llm-provider", "nonesuch", "version"]) == 2
    assert "an LLM needs a model" in capsys.readouterr().err


def test_check_settings_needs_no_store():
    check_settings(GraphSettings())
    cases = (
        (GraphSettings(llm_concurrency="0"), "llm_concurrency must be a positive integer, got '0'"),
        (GraphSettings(llm_concurrency="x"), "llm_concurrency must be a positive integer"),
        (GraphSettings(contradiction="bogus"), "contradiction"),
        (GraphSettings(store="bogus"), "unknown store 'bogus'"),
        (GraphSettings(schema='{"nodes": []}'), "unknown key 'nodes' in schema"),
    )
    for settings, message in cases:
        with pytest.raises(ValidationError, match=message):
            check_settings(settings)
    with pytest.raises(ValidationError, match="did you mean 'namespace'"):
        SelfGraph.connect(store="kuzu", namspace="x")
    with pytest.raises(ValidationError, match="did you mean 'store'"):
        SelfGraph.from_env(stor="kuzu")


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
    assert built(uri="falkor://db:6390") == ("db", 6390, "selfgraph", {})
    assert built(uri="rediss://db:6390")[3] == {"ssl": True}
    for uri in ("bolt://db:6390", "falkordb://db:6390"):
        with pytest.raises(ValidationError, match="the 'falkordb' store expects host:port or a redis://"):
            check_settings(GraphSettings(store="falkordb", uri=uri))


def test_library_errors_name_settings_and_the_cli_rewords_them_to_flags():
    cases = (
        (GraphSettings(store="neo4j", uri="g.kuzu"), 'pass store="kuzu"', "pass --store kuzu"),
        (GraphSettings(store="neo4j"), "pass uri= (or SELFGRAPH_URI)", "pass --uri (or SELFGRAPH_URI)"),
        (GraphSettings(llm_provider="gemini"), "pass llm_model= (or SELFGRAPH_LLM_MODEL)", "pass --llm-model"),
        (GraphSettings(uri=" "), "omit uri= (or SELFGRAPH_URI)", "omit --uri (or SELFGRAPH_URI)"),
    )
    for settings, library, surface in cases:
        with pytest.raises(ValidationError) as exc:
            SelfGraph.connect(**{k: v for k, v in vars(settings).items() if v is not None})
        assert library in str(exc.value) and "--" not in str(exc.value)
        assert surface in surface_hint(str(exc.value))


def test_check_settings_reads_the_schema_and_prompts(tmp_path):
    prompts = {"entities": {"system": "s", "user": "{text}", "version": "1"}}
    path = tmp_path / "prompts.json"
    path.write_text(json.dumps(prompts))
    checked = check_settings(GraphSettings(schema='{"entities": [{"name": "Person"}]}', prompts=str(path)))
    assert isinstance(checked.schema, Schema) and checked.prompts.entities.user == "{text}"


def test_store_errors_are_plain_and_actionable():
    auth = DriverError("Neo.ClientError.Security.Unauthorized", "{neo4j_code: ...} invalid credentials")
    assert (
        str(bolt_error(auth, "bolt://h:1", "default"))
        == "authentication failed for bolt://h:1: check the token/password"
    )
    missing = DriverError("Neo.ClientError.Statement.InvalidSyntax", "unknown graph database nosuch")
    assert str(bolt_error(missing, "bolt://h:1", "nosuch")) == "database 'nosuch' not found"
    down = DriverError("", "Couldn't connect to h:1:\nFailed to read four byte Bolt handshake response")
    assert str(bolt_error(down, "bolt://h:1", None)).startswith("could not connect to bolt://h:1: Couldn't connect")
    assert bolt_error(DriverError("Neo.ClientError.Statement.SyntaxError", "bad"), "bolt://h:1", None) is None
    with pytest.raises(ValidationError, match="invalid FalkorDB address 'nonsense:abc'"):
        build_graph(GraphSettings(store="falkordb", uri="nonsense:abc"))
    with pytest.raises(StoreError, match="is not a Bolt URI; use bolt://host:port"):
        HydraDBStore("http://127.0.0.1:1")
    expected = "mismatched input 'RETURN' expecting {" + ", ".join(f"'T{i}'" for i in range(80)) + "}"
    syntax = DriverError("Memgraph.ClientError.MemgraphError.MemgraphError", f"parsing error is {expected}\nmore")
    message = str(query_error(syntax, "bolt://h:1", None, "Cypher", lambda _: False))
    assert message.startswith("Cypher query failed: parsing error is mismatched") and message.endswith("...")
    assert len(message) == len("Cypher query failed: ") + 120
    store = HydraDBStore("bolt://127.0.0.1:1")
    unauthorized = DriverError("Neo.ClientError.Security.Unauthorized", "invalid credentials")
    message = str(store._error(unauthorized))
    assert message == "HydraDB needs a token: pass auth=TOKEN to HydraDBStore (or set SELFGRAPH_AUTH)"
    assert surface_hint(message) == "HydraDB needs a token: pass --auth TOKEN (or SELFGRAPH_AUTH)"
    missing = DriverError(
        "Memgraph.ClientError.MemgraphError.MemgraphError", 'Tried to retrieve an unknown database "default".'
    )
    message = str(store._error(missing))
    assert message == (
        'database \'default\' not found; if this is Neo4j or Memgraph, pass store="neo4j" (or store="memgraph")'
    )
    assert surface_hint(message).endswith("pass --store neo4j (or memgraph)")
    own = DriverError(
        "Neo.ClientError.Statement.InvalidSyntax",
        "ClientProtocol query is not supported yet: unknown graph database foo",
    )
    assert str(store._error(own)) == "database 'default' not found"
    authed = HydraDBStore("bolt://127.0.0.1:1", auth=("neo4j", "bad"))
    assert str(authed._error(unauthorized)).startswith("authentication failed for bolt://127.0.0.1:1")
    run(store.close())
    run(authed.close())


def test_bolt_initialize_skips_existing_constraints():
    def no_ddl():
        raise AssertionError("constraint DDL ran")

    async def memgraph_rows(query, params=None):
        if query == "SHOW CONSTRAINTS":
            raise cypher._translate_cypher_error(DriverError("x", "parsing error at SHOW"), "bolt://h:1", None)
        rows = [{"constraint type": "unique", "label": label, "properties": ["ns", "id"]} for label in LABELS]
        return CypherResult(columns=[], rows=rows)

    async def busy(query, params=None):
        raise TransientError("Cannot get read-only access to the storage")

    store = CypherStore("bolt://127.0.0.1:1")
    store._session = no_ddl
    for fake in (memgraph_rows, busy):
        store._run = fake
        run(store.initialize())
    neo4j_rows = [{"type": "UNIQUENESS", "labelsOrTypes": [label], "properties": ["id", "ns"]} for label in LABELS]
    assert cypher._unique_labels(neo4j_rows) == set(LABELS)
    assert cypher._unique_labels(neo4j_rows[1:]) == set(LABELS[1:])
    run(store.close())


def test_kuzu_paths_settings_and_errors(caplog, monkeypatch, tmp_path):
    pytest.importorskip("kuzu")
    monkeypatch.setenv("HOME", str(tmp_path))
    store = KuzuStore("~/sub/x.kuzu")
    run(store.initialize())
    run(store.close())
    assert (tmp_path / "sub" / "x.kuzu").exists()
    lock = _kuzu_error(RuntimeError("IO exception: Could not set lock on file : /x"), "could not open")
    assert str(lock).endswith("Kuzu allows one process at a time")
    mmap = _kuzu_error(RuntimeError("Buffer manager exception: Mmap for size 8796093022208 failed."), "failed")
    assert str(mmap).endswith("pass a smaller max_db_size")
    for size in (-1, 0, 1.5, True):
        with pytest.raises(ValidationError, match="max_db_size must be a positive integer of bytes"):
            KuzuStore(str(tmp_path / "s.kuzu"), max_db_size=size)
    with caplog.at_level("WARNING", logger="selfgraph"):
        g = SelfGraph.connect(store="kuzu", uri=str(tmp_path / "w.kuzu"), database="x")
    run(g.close())
    assert "database is ignored by store kuzu" in caplog.text
    for uri in ("graph.kuzu", str(tmp_path / "db")):
        with pytest.raises(ValidationError, match='this looks like a Kuzu path; pass store="kuzu"'):
            build_graph(GraphSettings(uri=uri))


def test_bind_params_checks_references_and_drops_unused():
    assert bind_params("RETURN $a AS a", {"a": 1, "b": 2}) == {"a": 1}
    assert bind_params("RETURN '$a' AS a, `$b` AS b /* $c */ // $d", None) == {}
    with pytest.raises(ValidationError, match=r"^missing parameter \$a$"):
        bind_params("RETURN $a, '$b'", {})
    with pytest.raises(ValidationError, match=r"^missing parameters \$a, \$c$"):
        bind_params("RETURN $a, $c, $a", None)


def test_a_closed_store_says_so_on_reuse():
    store = make_store()
    g = SelfGraph(store, namespace="closed-reuse")
    run(g.initialize())
    run(g.close())
    again = SelfGraph(store, namespace="closed-reuse")
    for call in (again.initialize(), again.entities.list()):
        with pytest.raises(StoreError, match=r"^this store is closed; create a new store for each SelfGraph$"):
            run(call)


def test_run_cypher_results_drop_internal_node_properties():
    pytest.importorskip("falkordb")
    from selfgraph.stores.falkordb import _to_json

    node = SimpleNamespace(properties={"id": "t:a", "_lock": 3, "tags": [1]})
    assert _to_json({"n": node, "rows": [node]}) == {
        "n": {"id": "t:a", "tags": [1]},
        "rows": [{"id": "t:a", "tags": [1]}],
    }
