import os
import sys

import pytest

_SRC = os.path.join(os.path.dirname(__file__), "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)


def _env(*names, default=None):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default


_TEST_STORE = (
    (os.environ.get("SELFGRAPH_TEST_STORE") or _env("SELFGRAPH_TEST_STORES", default="neo4j").split(",")[0])
    .strip()
    .lower()
)
_CYPHER = _TEST_STORE in ("cypher", "memgraph")
_URI = (
    _env("SG_MEMGRAPH_URI", "CYPHER_URI", default="bolt://127.0.0.1:7688")
    if _CYPHER
    else _env("SG_NEO4J_URI", "NEO4J_URI", default="bolt://127.0.0.1:7687")
)
_HYDRADB_URI = _env("SG_HYDRADB_URI", "HYDRADB_URI", default="bolt://127.0.0.1:17687")
_HYDRADB_TOKEN = _env("SG_HYDRADB_TOKEN", "HYDRADB_TOKEN", default="local-dev-auth-token-32-characters-long")
_LABELS = ("Entity", "Profile", "DecisionTrace", "DecisionStep", "Source", "SourceVersion", "Chunk")


def _auth():
    password = os.environ.get("SG_NEO4J_PASSWORD")
    if password:
        return ("neo4j", password)
    raw = os.environ.get("NEO4J_AUTH")
    if not raw:
        return None
    user, _, password = raw.partition(":")
    return (user, password)


def _wipe_hydradb(session):
    for label in _LABELS:
        ids = [r["id"] for r in session.run(f"MATCH (n:{label}) RETURN n.id AS id")]
        for node_id in ids:
            session.run(f"MATCH (n:{label} {{id:$id}}) DETACH DELETE n", id=node_id)


def _wipe_kuzu():
    from selfgraph.stores.kuzu import _SCHEMA, KuzuStore

    store = KuzuStore(os.environ.get("KUZU_PATH", "/tmp/selfgraph_kuzu_test"))
    for stmt in _SCHEMA:
        try:
            store._conn.execute(stmt)
        except Exception:
            pass
    store._conn.execute("MATCH (n:N) DETACH DELETE n")


def _wipe_falkordb():
    from falkordb import FalkorDB

    db = FalkorDB(
        host=_env("FALKOR_HOST", default="localhost"), port=int(_env("SG_FALKOR_PORT", "FALKOR_PORT", default="6380"))
    )
    for name in ("selfgraph_test", "selfgraph"):
        try:
            db.select_graph(name).delete()
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _wipe_store():
    from neo4j import GraphDatabase

    if _TEST_STORE == "kuzu":
        _wipe_kuzu()
        yield
        return

    if _TEST_STORE == "falkordb":
        _wipe_falkordb()
        yield
        return

    if _TEST_STORE == "hydradb":
        driver = GraphDatabase.driver(_HYDRADB_URI, auth=("neo4j", _HYDRADB_TOKEN))
        try:
            with driver.session(database="default") as session:
                _wipe_hydradb(session)
        finally:
            driver.close()
        yield
        return

    driver = GraphDatabase.driver(_URI, auth=_auth())
    try:
        with driver.session() as session:
            session.run("MATCH (n) DETACH DELETE n")
    finally:
        driver.close()
    yield
