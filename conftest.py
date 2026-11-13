import os
import sys

import pytest

_ROOT = os.path.dirname(__file__)
for _path in (os.path.join(_ROOT, "src"), os.path.join(_ROOT, "tests")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from helpers import (  # noqa: E402
    CYPHER_URI,
    FALKOR_HOST,
    FALKOR_PORT,
    HYDRADB_TOKEN,
    HYDRADB_URI,
    KUZU_PATH,
    NEO4J_URI,
    TEST_STORE,
    neo4j_auth,
)

_LABELS = (
    "Entity",
    "Profile",
    "DecisionTrace",
    "DecisionStep",
    "Source",
    "SourceVersion",
    "Chunk",
    "Evidence",
    "EntityMerge",
    "EntityMergeEntry",
)
_HYDRADB_DELETE_BATCH = 1024


def _wipe_bolt(uri, auth, database=None):
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(uri, auth=auth)
    try:
        with driver.session(database=database) as session:
            if TEST_STORE != "hydradb":
                session.run("MATCH (n) DETACH DELETE n")
                return
            for label in _LABELS:
                ids = [r["id"] for r in session.run(f"MATCH (n:{label}) RETURN n.id AS id")]
                for start in range(0, len(ids), _HYDRADB_DELETE_BATCH):
                    batch = ids[start : start + _HYDRADB_DELETE_BATCH]
                    session.run("MATCH (n) WHERE n.id IN $ids DETACH DELETE n", ids=batch)
    finally:
        driver.close()


def _wipe_kuzu():
    from selfgraph.stores.kuzu import _SCHEMA, KuzuStore

    store = KuzuStore(KUZU_PATH)
    for stmt in _SCHEMA:
        try:
            store._conn.execute(stmt)
        except Exception:
            pass
    store._conn.execute("MATCH (n:N) DETACH DELETE n")


def _wipe_falkordb():
    from falkordb import FalkorDB

    db = FalkorDB(host=FALKOR_HOST, port=FALKOR_PORT)
    for name in ("selfgraph_test", "selfgraph"):
        try:
            db.select_graph(name).delete()
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _wipe_store():
    if TEST_STORE == "kuzu":
        _wipe_kuzu()
    elif TEST_STORE == "falkordb":
        _wipe_falkordb()
    elif TEST_STORE == "hydradb":
        _wipe_bolt(HYDRADB_URI, ("neo4j", HYDRADB_TOKEN), database="default")
    elif TEST_STORE in ("cypher", "memgraph"):
        _wipe_bolt(CYPHER_URI, neo4j_auth())
    else:
        _wipe_bolt(NEO4J_URI, neo4j_auth())
    yield
