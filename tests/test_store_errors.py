import json

import pytest
from helpers import HYDRADB, KUZU, fresh_graph, run

from selfgraph import StoreError, ValidationError
from selfgraph.runtime import checked_cypher


@pytest.mark.skipif(not KUZU, reason="stored JSON documents use Kuzu's generic tables")
@pytest.mark.parametrize("doc", ["x", "{}", "[]", "null", "missing_fields"])
@pytest.mark.parametrize("edge", [False, True])
def test_malformed_stored_document_is_coded(doc, edge):
    g = fresh_graph("bad-doc")
    run(g.entities.create("Ada", "Person"))
    run(g.entities.create("Bo", "Person"))
    rel = run(g.relations.create("person:ada", "KNOWS", "person:bo"))
    if edge:
        query = "MATCH ()-[r:R]->() WHERE r.ns = $ns AND r.sid = $id SET r.doc = $doc"
        id = rel.id
        reads = [lambda: g.relations.get(id), lambda: g.relations.list(), lambda: g.relations.versions(id)]
    else:
        query = "MATCH (n:N) WHERE n.ns = $ns AND n.id = $id SET n.doc = $doc"
        id = "person:ada"
        reads = [lambda: g.entities.get(id), lambda: g.entities.list()]
    if doc == "missing_fields":
        doc = json.dumps({"id": id, "ns": g.namespace})
    run(g.run_cypher(query, {"ns": g.namespace, "id": id, "doc": doc}))
    reads.append(lambda: checked_cypher(g, "MATCH (n:N) WHERE false RETURN n", None))
    for read in reads:
        with pytest.raises(StoreError) as raised:
            run(read())
        assert raised.value.code == "invalid_stored_data"
        assert raised.value.field == "doc"
        assert id in str(raised.value)
        assert g.namespace in str(raised.value)


@pytest.mark.skipif(not (KUZU or HYDRADB), reason="regression backends")
def test_certification_surrogate_is_coded_and_does_not_write():
    g = fresh_graph("surrogate")
    run(g.entities.create("Ada", "Person"))
    run(g.entities.create("Bo", "Person"))
    rel = run(g.relations.create("person:ada", "KNOWS", "person:bo"))
    with pytest.raises(ValidationError) as raised:
        run(g.relations.certify(rel.id, by="a\ud83dlonely"))
    assert raised.value.code == "invalid_argument"
    assert raised.value.field == "by"
    assert str(raised.value) == "certified_by cannot contain unpaired surrogate characters"
    assert run(g.relations.get(rel.id)).certified_by is None
    assert run(g.relations.certify(rel.id, by="Ada 😀")).certified_by == "Ada 😀"


@pytest.mark.skipif(not HYDRADB, reason="HydraDB size guard")
def test_hydradb_size_guard_surrogate_is_coded():
    g = fresh_graph("bad-size")
    with pytest.raises(StoreError) as raised:
        run(g.store.upsert_node(g.namespace, "Entity", "person:ada", {"id": "person:ada", "name": "a\ud83dlonely"}))
    assert raised.value.code == "invalid_argument"
    assert raised.value.field == "name"
    assert str(raised.value) == "HydraDB write field 'name' cannot contain unpaired surrogate characters"
