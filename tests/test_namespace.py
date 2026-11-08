import pytest
from helpers import make_store, new_graph, run

from selfgraph import SelfGraph, StoreError, SyncSelfGraph, TransientError, ValidationError


def test_namespaces_isolate_reads_and_writes():
    store = make_store()
    a = SelfGraph(store=store, namespace="tenant-a")
    b = SelfGraph(store=store, namespace="tenant-b")
    run(a.initialize())

    run(a.entities.create("Soham", "Person", id="person:soham"))
    assert run(a.entities.get("person:soham")) is not None
    assert run(b.entities.get("person:soham")) is None

    run(b.entities.create("Other", "Person", id="person:soham"))
    assert run(b.entities.get("person:soham")).name == "Other"
    assert run(a.entities.get("person:soham")).name == "Soham"

    a_list = run(a.entities.list())
    assert all(e.name == "Soham" for e in a_list.items)


def test_transaction_rolls_back_on_error():
    g = new_graph()
    run(g.entities.create("A", "T", id="t:a"))
    with pytest.raises(ValidationError):
        run(
            g.insert.ontology(
                {
                    "entities": [{"id": "t:b", "type": "T", "name": "B"}],
                    "relations": [{"from_entity": "t:b", "type": "R", "to_entity": "t:ghost"}],
                }
            )
        )
    assert run(g.entities.get("t:b")) is None


def test_calls_after_close_raise_store_error():
    g = new_graph()
    run(g.close())
    run(g.close())
    for call in (g.entities.get("person:x"), g.entities.create("X", "Person"), g.initialize()):
        with pytest.raises(StoreError, match="closed") as err:
            run(call)
        assert not isinstance(err.value, TransientError)


def test_sync_graph_after_close_raises_store_error():
    g = SyncSelfGraph(store=make_store())
    g.close()
    g.close()
    with pytest.raises(StoreError, match="closed"):
        g.entities.get("person:x")
