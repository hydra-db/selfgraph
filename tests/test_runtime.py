import json
import logging
import os
import subprocess
import sys
import traceback
import weakref
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from helpers import NEO4J_URI, DriverError, make_store, run, store_settings

from selfgraph import KuzuStore, Neo4jStore, Schema, SelfGraph, SyncSelfGraph, runtime
from selfgraph._serde import LABELS, _cached_iso, _parse_iso, from_iso
from selfgraph.errors import (
    StoreError,
    TransientError,
    ValidationError,
    mask_uri,
    redact_uri,
    require_encoded_userinfo,
    split_scheme,
    surface_hint,
)
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
from selfgraph.stores._cypher import bolt_auth, bolt_driver, bolt_error, parse_auth, query_error
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
    run(g.close())


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


def test_llm_tiers_fail_before_version_and_mcp(monkeypatch, capsys):
    from selfgraph.cli import main

    for key in (
        "SELFGRAPH_LLM_PROVIDER",
        "SELFGRAPH_LLM_MODEL",
        "SELFGRAPH_LEVEL",
        "SELFGRAPH_MAX_TIER",
        "SELFGRAPH_RESOLVER",
        "SELFGRAPH_CONTRADICTION",
    ):
        monkeypatch.delenv(key, raising=False)
    for args, message in (
        (["--level", "max", "version"], "level 'max' needs an LLM"),
        (["--resolver", "llm", "version"], "resolver 'llm' needs an LLM"),
        (["--contradiction", "llm", "version"], "contradiction 'llm' needs an LLM"),
    ):
        assert main(args) == 2
        assert message in capsys.readouterr().err
    assert main(["--schema-mode", "strict", "version"]) == 2
    assert "schema_mode 'strict' needs a schema" in capsys.readouterr().err
    assert main(["--level", "max", "--max-tier", "light", "version"]) == 0
    capsys.readouterr()
    llm = ["--llm-provider", "openai", "--llm-model", "gpt-4o-mini"]
    for args in (
        ["--level", "max", *llm, "version"],
        ["--resolver", "llm", *llm, "version"],
        ["--contradiction", "llm", *llm, "version"],
    ):
        assert main(args) == 0
        capsys.readouterr()
    env = {
        k: v
        for k, v in os.environ.items()
        if k
        not in {
            "SELFGRAPH_LLM_PROVIDER",
            "SELFGRAPH_LLM_MODEL",
            "SELFGRAPH_LEVEL",
            "SELFGRAPH_MAX_TIER",
            "SELFGRAPH_RESOLVER",
            "SELFGRAPH_CONTRADICTION",
        }
    }
    proc = subprocess.run(
        [sys.executable, "-m", "selfgraph", "--level", "max", "mcp"],
        capture_output=True,
        text=True,
        timeout=5,
        env=env,
    )
    assert proc.returncode == 2
    assert "level 'max' needs an LLM" in proc.stderr


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


def _fail_after_the_store(**options):
    raise ValidationError("the LLM setup failed", code="invalid_setting")


@pytest.mark.parametrize("in_loop", [False, True])
def test_a_build_that_fails_after_the_store_releases_the_kuzu_lock(tmp_path, monkeypatch, in_loop):
    pytest.importorskip("kuzu")
    monkeypatch.setattr(runtime, "SelfGraph", _fail_after_the_store)
    path = str(tmp_path / "g.kuzu")

    async def build_in_loop():
        build_graph(GraphSettings(store="kuzu", uri=path))

    with pytest.raises(ValidationError, match="the LLM setup failed"):
        run(build_in_loop()) if in_loop else build_graph(GraphSettings(store="kuzu", uri=path))
    opened = subprocess.run(
        [sys.executable, "-c", f"import kuzu; kuzu.Database({path!r})"], capture_output=True, text=True, timeout=60
    )
    assert opened.returncode == 0, opened.stderr


def test_a_build_that_fails_does_not_wait_for_a_query_another_graph_runs_on_the_path(tmp_path):
    pytest.importorskip("kuzu")
    path = str(tmp_path / "g.kuzu")
    script = f"""
import asyncio
from selfgraph import KuzuStore, runtime
from selfgraph.errors import ValidationError
from selfgraph.stores import kuzu

def fail(**options):
    raise ValidationError("the LLM setup failed", code="invalid_setting")

runtime.SelfGraph = fail

async def main():
    other = KuzuStore({path!r})
    async with other._lock:
        try:
            runtime.build_graph(runtime.GraphSettings(store="kuzu", uri={path!r}))
        except ValidationError as exc:
            print(exc)
        print(kuzu._OPEN_STORES.get(other._cache_key))
    await other.close()
    print(kuzu._OPEN_STORES.get(other._cache_key))

asyncio.run(main())
"""
    src = os.path.dirname(os.path.dirname(runtime.__file__))
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [src, os.environ.get("PYTHONPATH")]))}
    proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60, env=env)
    assert (proc.returncode, proc.stdout.splitlines()) == (0, ["the LLM setup failed", "1", "None"]), proc.stderr


@pytest.mark.parametrize("close_fails", [False, True])
def test_a_build_that_fails_after_the_store_closes_it_and_raises_the_build_error(monkeypatch, close_fails):
    closed = []

    class Store:
        async def close(self):
            closed.append(True)
            if close_fails:
                raise StoreError("close failed")

    monkeypatch.setattr(runtime, "_build_store", lambda settings: Store())
    monkeypatch.setattr(runtime, "SelfGraph", _fail_after_the_store)
    with pytest.raises(ValidationError, match="the LLM setup failed"):
        build_graph(GraphSettings(store="neo4j", uri=NEO4J_URI))
    assert closed == [True]


def test_jsonable_and_dumps():
    g = build_graph(store_settings())
    run(g.initialize())
    e = run(g.entities.create("HydraDB", "Company", id="company:hydradb"))
    assert json.loads(dumps(e))["id"] == "company:hydradb"
    assert to_jsonable(None) is None
    assert to_jsonable([e])[0]["name"] == "HydraDB"
    run(g.close())


def test_blank_namespace_rejected_unset_defaults(monkeypatch):
    for ns in ("", "   "):
        with pytest.raises(ValidationError, match="namespace"):
            build_graph(GraphSettings(store="neo4j", uri=NEO4J_URI, namespace=ns))
    monkeypatch.setenv("SELFGRAPH_NAMESPACE", "")
    with pytest.raises(ValidationError, match="namespace"):
        build_graph(settings_from_env(store="neo4j", uri=NEO4J_URI))
    g = build_graph(GraphSettings(store="neo4j", uri=NEO4J_URI, namespace=None))
    assert g.namespace == "default"
    run(g.close())


def test_store_kind():
    assert store_kind(GraphSettings()) == "kuzu"
    assert store_kind(GraphSettings(uri="bolt://x:1")) == "hydradb"
    assert store_kind(GraphSettings(store="Neo4j", uri="bolt://x:1")) == "neo4j"


@pytest.mark.parametrize("userinfo", ["default:100%", "u:%ff", "u%zz:p", "u:%e2%82"])
def test_falkordb_url_credentials_reject_a_malformed_escape_without_quoting_them(userinfo):
    with pytest.raises(ValidationError) as err:
        build_graph(GraphSettings(store="falkordb", uri=f"redis://{userinfo}@db:6390"))
    assert (err.value.code, err.value.field) == ("invalid_setting", "uri")
    assert str(err.value) == (
        "the store URI has a malformed percent escape in its user or password; "
        "write a literal % as %25 and percent-encode other characters as UTF-8"
    )


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
        (GraphSettings(store="neo4j"), "pass the uri option (or SELFGRAPH_URI)", "pass --uri (or SELFGRAPH_URI)"),
        (
            GraphSettings(llm_provider="gemini"),
            "pass the llm_model option (or SELFGRAPH_LLM_MODEL)",
            "pass --llm-model",
        ),
        (GraphSettings(uri=" "), "omit the uri option (or SELFGRAPH_URI)", "omit --uri (or SELFGRAPH_URI)"),
        (
            GraphSettings(llm_provider="openai", llm_model="anthropic/claude"),
            "pass the llm_provider option (or SELFGRAPH_LLM_PROVIDER) matching the model",
            "pass --llm-provider (or SELFGRAPH_LLM_PROVIDER) matching the model",
        ),
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


def test_store_errors_hide_uri_credentials():
    assert mask_uri("redis://u:pw@host:1") == "redis://***@host:1"
    assert mask_uri("u:pw@host:1") == "***@host:1"
    assert mask_uri("bolt://host:7687") == "bolt://host:7687"
    assert mask_uri("/tmp/graph.kuzu") == "/tmp/graph.kuzu"
    assert mask_uri("bolt://u:pw@127.0.0.1:7687?a=b@c") == "bolt://***@127.0.0.1:7687?a=b@c"
    assert mask_uri("bolt://h:1/db@x") == "bolt://h:1/db@x"
    quoted = "bolt://u:it'ss3cr3tPW@127.0.0.1:7687/db\"x"
    for shown in (repr(quoted), json.dumps(quoted), quoted):
        assert "ss3cr3t" not in redact_uri(f"Given URI: {shown}", quoted), shown
    assert redact_uri(f"Given URI: {quoted!r}", quoted) == "Given URI: 'bolt://***@127.0.0.1:7687/db\"x'"
    assert redact_uri("Given URI: 'bolt://u:hun\\nter2@h:1'", "bolt://u:hun\nter2@h:1") == "Given URI: 'bolt://***@h:1'"
    dollar = "bolt://u:pw@h:1/d$&b"
    assert redact_uri(f"x {dollar} y", dollar) == "x bolt://***@h:1/d$&b y"
    assert mask_uri("u:p\uff20ss@h:1") == "***@h:1"
    for at in ("\uff20", "\ufe6b"):
        assert mask_uri(f"admin:s3cr3tPW{at}127.0.0.1:6379") == f"***{at}127.0.0.1:6379"
        assert mask_uri(f"redis://admin:s3cr3tPW{at}127.0.0.1:6379") == f"redis://***{at}127.0.0.1:6379"
        netloc = f"admin:s3cr3tPW{at}127.0.0.1:7687"
        assert (
            redact_uri(f"netloc {netloc!r} is invalid", f"bolt://{netloc}")
            == f"netloc '***{at}127.0.0.1:7687' is invalid"
        )
    assert redact_uri("x u:pw$'@h y", "bolt://u:pw$'@h") == "x ***@h y"
    leaks = ("hun", "ter2")
    for store, uri in (
        ("falkordb", "redis://u:hunter2@host:99999"),
        ("falkordb", "http://u:hunter2@host:1"),
        ("falkordb", "u:hunter2@host:6379/0"),
        ("falkordb", "redis://u:hun\nter2@host:99999"),
        ("neo4j", "u:hunter2@host/db"),
    ):
        with pytest.raises(ValidationError) as caught:
            build_graph(GraphSettings(store=store, uri=uri))
        assert "***@host" in str(caught.value) and not any(x in str(caught.value) for x in leaks), uri
    for uri in (
        "bolt://u:hunter2@host:7687",
        "bolt://u:hun\nter2@host:7687",
        "bolt://u:it's\"2@host:7687",
        "bolt://u:it'shunter2@host:7687/db\"x",
    ):
        with pytest.raises(StoreError) as caught:
            bolt_driver(uri, None)
        assert "bolt://***@host:7687" in str(caught.value) and not any(
            x in str(caught.value) for x in (*leaks, "it")
        ), uri
        assert caught.value.__cause__ is None and caught.value.__context__ is None, uri
        shown = "".join(traceback.format_exception(caught.value))
        assert not any(x in shown for x in (*leaks, "it's", "it\\'s")), uri
    with pytest.raises(StoreError, match=r"^'http://\*\*\*@h:1' is not a Bolt URI"):
        bolt_driver("http://u:hunter2@h:1", None)
    denied = DriverError("Neo.ClientError.Security.Unauthorized", "invalid credentials")
    assert str(bolt_error(denied, "bolt://u:hunter2@h:1", None)) == (
        "authentication failed for bolt://***@h:1: check the token/password"
    )
    down = DriverError("", "Couldn't connect to bolt://u:hunter2@h:1")
    assert str(bolt_error(down, "bolt://u:hunter2@h:1", None)).startswith("could not connect to bolt://***@h:1: ")
    assert "hunter2" not in str(bolt_error(down, "bolt://u:hunter2@h:1", None))


def test_store_uris_with_unencoded_userinfo_are_rejected():
    unencoded = (
        "the store URI has an unencoded character in its user or password; "
        "percent-encode it (/ as %2F, ? as %3F, # as %23, @ as %40, [ as %5B, ] as %5D)"
    )
    for sep in ("/", "?", "#", "@", "[", "]", "\uff20", "\ufe6b", "\uff0f", "\uff1f", "\uff03", "\uff1a", "\uff3b"):
        for store, uri in (
            ("falkordb", f"redis://u:pa{sep}s3cr3tPW@127.0.0.1:6379"),
            ("falkordb", f"u:pa{sep}s3cr3tPW@127.0.0.1:6379"),
            ("neo4j", f"bolt://u:pa{sep}s3cr3tPW@127.0.0.1:7687"),
            ("neo4j", f"u:pa{sep}s3cr3tPW@127.0.0.1:7687"),
            ("hydradb", f"bolt://u:pa{sep}s3cr3tPW@127.0.0.1:7687"),
            ("memgraph", f"bolt://u:pa{sep}s3cr3tPW@127.0.0.1:7687"),
            ("cypher", f"bolt://u:pa{sep}s3cr3tPW@127.0.0.1:7687"),
        ):
            with pytest.raises(ValidationError) as caught:
                build_graph(GraphSettings(store=store, uri=uri))
            assert str(caught.value) == unencoded, (store, uri)
            assert "cr3t" not in "".join(traceback.format_exception(caught.value)), (store, uri)
        for uri in (f"bolt://u:pa{sep}s3cr3tPW@127.0.0.1:7687", f"http://u:pa{sep}s3cr3tPW@127.0.0.1:7687"):
            with pytest.raises(ValidationError) as caught:
                bolt_driver(uri, None)
            assert str(caught.value) == unencoded, uri
            assert "cr3t" not in "".join(traceback.format_exception(caught.value)), uri
    in_password = "admin:s3cr3tPW://x@127.0.0.1:6379"
    lookalike_at = [
        f"{scheme}{who}{at}127.0.0.1:7687"
        for scheme in ("", "bolt://", "redis://")
        for at in "\uff20\ufe6b"
        for who in ("S3cr3tTOKEN", "admin:s3cr3tPW")
    ]
    misplaced = (
        "redis://u:p[s3cr3t]@[::1]:6379",
        "bolt://S3cr3tTOKEN\uff3b@[::1]:7687",
        "bolt://admin:S3cr3t/PW\uff20127.0.0.1:7687",
        "bolt://admin:S3cr3t?PW\uff20127.0.0.1:7687",
        "bolt://S3cr3tTOK/EN\ufe6b127.0.0.1:7687",
        "redis://admin:S3cr3t/PW\uff20127.0.0.1:6379",
        "bolt://u:s3cr3t@h\uff0fx:7687",
        "bolt://u:s3cr3t@[::1\uff3d:7687",
        "bolt://h:7687/db\uff20s3cr3t",
    )
    for uri in (in_password, *lookalike_at, *misplaced):
        for store in ("falkordb", "neo4j", "hydradb", "memgraph", "cypher"):
            with pytest.raises(ValidationError) as caught:
                build_graph(GraphSettings(store=store, uri=uri))
            assert str(caught.value) == unencoded, (store, uri)
            assert (caught.value.code, caught.value.field) == ("invalid_setting", "uri"), (store, uri)
            assert "cr3t" not in "".join(traceback.format_exception(caught.value)), (store, uri)
        with pytest.raises(ValidationError) as caught:
            bolt_driver(uri, None)
        assert str(caught.value) == unencoded, uri
        assert "cr3t" not in "".join(traceback.format_exception(caught.value)), uri
    for uri in ("bolt://u:pw@127.0.0.1:7687?a=b@c", "bolt://h:1/db@x", "bolt://u:p@ss@h:1", in_password):
        with pytest.raises(ValidationError, match=r"^the store URI has an unencoded character"):
            bolt_driver(uri, None)
    assert split_scheme("bolt://h:1") == ("bolt", "h:1")
    assert split_scheme("a+b.c-d://h") == ("a+b.c-d", "h")
    for uri in (in_password, "h:6379", "1x://h", "://h", "/tmp/a://b"):
        assert split_scheme(uri) == ("", uri), uri
    for uri in (
        "bolt://u:p%2Fa%3Fb%23c%40d@127.0.0.1:7687",
        "neo4j://127.0.0.1:7687/db?x=y#z",
        "redis://u:pw@host:6379/0",
        "host:6379",
        "/tmp/graph.kuzu",
        "bolt://[::1]:7687",
        "bolt://u:pw@[::1]:7687",
        "redis://u:p%5Bw%5D@[fe80::1]:6379",
        "neo4j://h:7687/db?x=[1]",
        "bolt://us\u00e9r:p\u00e4ss@h\u00f4st:7687",
    ):
        require_encoded_userinfo(uri)
    for store, uri in (
        ("neo4j", "bolt://[::1]:7687"),
        ("falkordb", "redis://u:p%5Bw%5D@[::1]:6379"),
        ("falkordb", "redis://us\u00e9r:p\u00e4ss@h:6379"),
    ):
        check_settings(GraphSettings(store=store, uri=uri))
    run(bolt_driver("bolt://[::1]:7687", None).close())


_MEMGRAPH_TOKEN_ERROR = (
    b"Invalid query. There is a wrong token at position 0 starting with \xf0. "
    b"Remove that part of the query and try to rerun it."
)


def test_a_non_utf8_server_message_keeps_the_engines_reason(monkeypatch):
    from neo4j import AsyncSession

    async def undecodable(self, query, parameters=None, **kwargs):
        raise UnicodeDecodeError("utf-8", _MEMGRAPH_TOKEN_ERROR, 66, 67, "invalid continuation byte")

    monkeypatch.setattr(AsyncSession, "run", undecodable)
    store = Neo4jStore("bolt://127.0.0.1:1")
    with pytest.raises(StoreError) as err:
        run(store.run_cypher("RETURN 1"))
    assert err.value.code == "query_failed"
    assert str(err.value) == (
        "Cypher query failed: Invalid query. There is a wrong token at position 0 starting with \ufffd. "
        "Remove that part of the query and try to rerun it."
    )
    run(store.close())


def test_the_driver_log_line_for_an_undecodable_response_is_dropped(caplog):
    run(bolt_driver("bolt://127.0.0.1:1", None).close())
    bad = UnicodeDecodeError("utf-8", _MEMGRAPH_TOKEN_ERROR, 66, 67, "invalid continuation byte")
    driver_log = logging.getLogger("neo4j.io")
    with caplog.at_level(logging.DEBUG, logger="neo4j.io"):
        driver_log.error("<CONNECTION> error: %s: %r", "Failed to read from defunct connection", bad)
        driver_log.debug("Failed to unpack response: %r", bad)
        driver_log.error("<CONNECTION> error: %s: %r", "Failed to read from defunct connection", OSError("reset"))
    assert [r.getMessage() for r in caplog.records if r.name == "neo4j.io"] == [
        f"Failed to unpack response: {bad!r}",
        "<CONNECTION> error: Failed to read from defunct connection: OSError('reset')",
    ]


def test_falkordb_addresses_urlparse_refuses_are_masked():
    for uri, masked in (
        ("redis://u:s3cr3tPW@127.0.0.1[:6379", "redis://***@127.0.0.1[:6379"),
        ("redis://u:s3cr3tPW@[::1:6379", "redis://***@[::1:6379"),
        ("u:s3cr3tPW@::1]:6379", "***@::1]:6379"),
    ):
        with pytest.raises(ValidationError) as caught:
            build_graph(GraphSettings(store="falkordb", uri=uri))
        assert str(caught.value) == (
            f"invalid FalkorDB address {masked!r}: expected host:port with a port from 1 to 65535"
        ), uri
        assert caught.value.__cause__ is None and caught.value.__context__ is None, uri
        assert "cr3t" not in "".join(traceback.format_exception(caught.value)), uri


def test_bolt_initialize_skips_existing_constraints():
    def no_ddl():
        raise AssertionError("constraint DDL ran")

    async def memgraph_rows(query, params=None):
        if query == "SHOW INDEX INFO":
            return CypherResult(
                columns=[],
                rows=[{"index type": "label+property", "label": label, "property": "id"} for label in LABELS],
            )
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
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    store = KuzuStore("~/sub/x.kuzu")
    run(store.initialize())
    run(store.close())
    assert (tmp_path / "sub" / "x.kuzu").exists()
    kuzu_lock = "IO exception: Could not set lock on file : /x\nSee the docs: https://docs.kuzudb.com/concurrency"
    assert str(_kuzu_error(RuntimeError(kuzu_lock), "could not open")) == (
        "could not open: another process (an MCP server or script) has this Kuzu database open; "
        "Kuzu allows one process at a time"
    )
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


def test_kuzu_relative_path_uses_each_stores_working_directory(tmp_path, monkeypatch):
    pytest.importorskip("kuzu")
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.chdir(tmp_path)
    with SyncSelfGraph(KuzuStore("graph.kuzu")) as first:
        entity = first.entities.create("Jane", "Person")
        monkeypatch.chdir(other)
        with SyncSelfGraph(KuzuStore("graph.kuzu")) as second:
            assert second.entities.get(entity.id) is None
        assert first.entities.get(entity.id) == entity


def test_kuzu_reopens_its_connection_without_changing_results(tmp_path):
    pytest.importorskip("kuzu")
    store = KuzuStore(str(tmp_path / "r.kuzu"))
    g = SelfGraph(store, namespace="reconnect")
    run(g.initialize())
    first = weakref.ref(store._conn)
    people = [{"id": f"person:p{i}", "type": "Person", "name": f"Person {i}"} for i in range(30)]
    knows = [{"from_entity": f"person:p{i}", "type": "KNOWS", "to_entity": f"person:p{i - 1}"} for i in range(1, 30)]
    run(g.insert.facts({"entities": people, "relations": knows}))

    async def reads():
        return [(await g.run_cypher("RETURN $i AS i", {"i": i})).rows for i in range(600)]

    assert run(reads()) == [[{"i": i}] for i in range(600)]
    run(g.insert.facts({"relations": [{**r, "properties": {"since": 2020}} for r in knows]}))
    rels = run(g.relations.list(type="KNOWS", limit=100)).items
    assert first() is None
    assert len(run(g.entities.list(limit=100)).items) == 30
    assert sorted((r.revision, r.is_current, r.properties["since"]) for r in rels) == [(2, True, 2020)] * 29
    assert "person:p7" in {e.id for e in run(g.retrieve("Person 7")).subgraph.entities}
    run(g.close())


def test_kuzu_keeps_its_connection_while_a_raw_transaction_is_open(tmp_path):
    pytest.importorskip("kuzu")
    store = KuzuStore(str(tmp_path / "t.kuzu"))
    g = SelfGraph(store, namespace="tx")
    run(g.initialize())
    held = store._conn

    async def session():
        await g.run_cypher("BEGIN /* keep */ TRANSACTION")
        for i in range(300):
            await g.run_cypher("CREATE (:N {pk: $pk, ns: 'tx'})", {"pk": f"p{i}"})
        await g.entities.create("Jane", "Person")
        for _ in range(600):
            await g.entities.get("person:jane")
        await g.run_cypher("ROLLBACK")

    run(session())
    assert store._conn is held
    assert run(g.run_cypher("MATCH (n:N) WHERE n.ns = 'tx' RETURN count(*) AS n")).rows == [{"n": 0}]
    assert run(g.entities.get("person:jane")) is None

    async def reads():
        for i in range(600):
            await g.run_cypher("RETURN $i AS i", {"i": i})

    run(reads())
    assert store._conn is not held
    run(g.close())


def test_kuzu_rejects_multi_statement_before_running(tmp_path):
    pytest.importorskip("kuzu")
    store = KuzuStore(str(tmp_path / "m.kuzu"))
    g = SelfGraph(store, namespace="multi")
    run(g.initialize())
    run(g.entities.create("A", "T", id="t:a"))
    run(g.entities.create("B", "T", id="t:b"))

    async def ids():
        return [r["id"] for r in (await store.run_cypher("MATCH (n:N) RETURN n.id AS id ORDER BY id")).rows]

    assert run(ids()) == ["t:a", "t:b"]
    for query in ("RETURN 1 AS a; MATCH (n:N) DETACH DELETE n", "CREATE (:N {pk:'x'}); CREATE (:N {pk:'y'})"):
        with pytest.raises(StoreError, match="one statement") as err:
            run(store.run_cypher(query))
        assert err.value.code == "query_failed"
    assert run(ids()) == ["t:a", "t:b"]
    assert run(store.run_cypher("RETURN 'a; b' AS s")).rows == [{"s": "a; b"}]
    assert run(store.run_cypher("MATCH (n:N) RETURN count(*) AS c ; // trailing")).rows == [{"c": 2}]
    run(g.close())


_CANCEL_CLOSE = """
import asyncio, os, shutil, tempfile, time
from selfgraph import KuzuStore, SelfGraph

SLOW = "UNWIND range(1, 1000000) AS x WITH x WHERE x % 7 = 0 RETURN count(*) AS c"
FAST = "UNWIND range(1, 50000) AS x WITH x WHERE x % 7 = 0 RETURN count(*) AS c"


async def one(query):
    path = tempfile.mkdtemp(prefix="sg290c-")
    store = KuzuStore(os.path.join(path, "g.kuzu"), buffer_pool_size=128 << 20)
    g = SelfGraph(store=store, namespace="x")
    await g.initialize()
    start = time.monotonic()
    try:
        await asyncio.wait_for(store.run_cypher(query), timeout=0.015)
    except asyncio.TimeoutError:
        pass
    waited = time.monotonic() - start
    await g.close()  # may wait for the worker, but the cancelled await above must not have
    shutil.rmtree(path, ignore_errors=True)
    return waited


async def main():
    waited = await one(SLOW)
    assert waited < 0.4, f"cancelled await blocked for {waited:.2f}s"
    for _ in range(50):
        await one(FAST)
    print("OK")


asyncio.run(main())
"""


def test_kuzu_cancel_then_close_returns_promptly_and_does_not_crash():
    pytest.importorskip("kuzu")
    import selfgraph

    src = os.path.dirname(os.path.dirname(os.path.abspath(selfgraph.__file__)))
    env = {**os.environ, "PYTHONPATH": src}
    proc = subprocess.run([sys.executable, "-c", _CANCEL_CLOSE], capture_output=True, text=True, timeout=120, env=env)
    assert proc.returncode == 0 and proc.stdout.strip().endswith("OK"), (
        f"rc={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr[-2000:]}"
    )


@pytest.mark.parametrize("path", ["", ":memory:", "file"])
def test_kuzu_database_identity_and_close(path, tmp_path):
    pytest.importorskip("kuzu")
    shared = path == "file"
    if shared:
        path = str(tmp_path / "shared.kuzu")
    with SyncSelfGraph(KuzuStore(path)) as first:
        entity = first.entities.create("Jane", "Person")
        with SyncSelfGraph(KuzuStore(path)) as second:
            assert (second.entities.get(entity.id) is not None) == shared
            if not shared:
                second.entities.create("Jane", "Person")
            second.entities.delete(entity.id)
            assert (first.entities.get(entity.id) is None) == shared
        assert (first.entities.get(entity.id) is None) == shared
        first.entities.create("Ann", "Person")


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


@pytest.mark.parametrize(
    "value",
    [
        "2026-01-01",
        "2026-01-01T12:30:45.123456789Z",
        "2026-01-01t12:30:45z",
        "2026-01-01T12:30:45+05:30:01",
        "2026-01-01T12:30:45-0330",
        "2026-01-01T12:30:45.123456+00:00",
    ],
)
def test_cached_timestamps_keep_the_parser_grammar(value):
    _cached_iso.cache_clear()
    assert from_iso(value) == _parse_iso(value)
    assert from_iso(value) == _parse_iso(value)
    assert _cached_iso.cache_info().hits == 1


@pytest.mark.parametrize(
    "value", ["2026-01-01T12:30:45+05:60", "2026-02-30", "2026-W01-1", "2026-01-01T12:30:45+24:00"]
)
def test_invalid_dates_are_rejected_without_being_cached(value):
    _cached_iso.cache_clear()
    with pytest.raises(ValueError):
        from_iso(value)
    assert _cached_iso.cache_info().currsize == 0


def test_timestamp_cache_bounds_entry_count_and_key_length():
    _cached_iso.cache_clear()
    for microsecond in range(1030):
        value = f"2026-01-01T00:00:00.{microsecond:06}+00:00"
        assert from_iso(value) == datetime(2026, 1, 1, microsecond=microsecond, tzinfo=timezone.utc)
    assert _cached_iso.cache_info().currsize == 1024
    info = _cached_iso.cache_info()
    assert from_iso("2026-01-01" + " " * 10000 + "Z") == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert _cached_iso.cache_info() == info
    assert from_iso(None) is None
    stamp = datetime.now(timezone.utc)
    assert from_iso(stamp) is stamp


@pytest.mark.parametrize("base,value", [(str, "text"), (int, 7), (float, float("nan"))])
def test_falkordb_scalar_subclasses_keep_graph_properties(base, value):
    from selfgraph.stores.falkordb import _to_json

    scalar = type("Scalar", (base,), {"properties": {"value": 3, "_lock": "hidden"}})(value)
    assert _to_json(scalar) == {"value": 3}


def test_falkordb_nested_values_preserve_nulls_and_nonfinite_numbers():
    from selfgraph.stores.falkordb import _to_json

    assert _to_json({"values": (None, float("nan"), float("inf"), float("-inf"), 2.5)}) == {
        "values": [None, None, None, None, 2.5]
    }
