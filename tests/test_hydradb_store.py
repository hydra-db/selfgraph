import pytest
from helpers import HYDRADB, make_store, run, unique_ns

from selfgraph import StoreError

pytestmark = pytest.mark.skipif(not HYDRADB, reason="the write queue is HydraDB's")


def _props(ns, eid):
    return {"id": eid, "ns": ns, "name": eid}


def test_a_nested_transaction_on_another_store_runs_its_own_writes():
    outer, inner, ns = make_store(), make_store(), unique_ns("queue")

    async def go():
        async with outer.transaction() as a:
            await a.upsert_node(ns, "Source", "x:outer", _props(ns, "x:outer"))
            async with inner.transaction() as b:
                await b.upsert_node(ns, "Source", "x:inner", _props(ns, "x:inner"))
        found = [await outer.get_node(ns, "Source", i) is not None for i in ("x:outer", "x:inner")]
        await outer.close()
        await inner.close()
        return found

    assert run(go()) == [True, True]


def test_create_edge_checks_the_label_of_an_endpoint_still_queued():
    store, ns = make_store(), unique_ns("queue")

    async def go():
        async with store.transaction() as tx:
            await tx.upsert_node(ns, "Source", "x:a", _props(ns, "x:a"))
            await tx.upsert_node(ns, "Profile", "x:b", _props(ns, "x:b"))
            wrong = await tx.create_edge(ns, "KNOWS", "Source", "x:a", "Source", "x:b", {"id": "e1", "ns": ns})
            right = await tx.create_edge(ns, "KNOWS", "Source", "x:a", "Profile", "x:b", {"id": "e2", "ns": ns})
        stored = [e["props"]["id"] for e in await store.list_edge_versions(ns, "e2")]
        await store.close()
        return wrong, right, stored

    assert run(go()) == (False, True, ["e2"])


def test_evidence_is_not_written_when_a_write_queued_before_it_fails():
    store, ns = make_store(), unique_ns("queue")
    real = store._exec

    async def failing(query, params=None):
        if "SET n:Source" in query:
            raise StoreError("write failed")
        return await real(query, params)

    async def go():
        store._exec = failing
        with pytest.raises(StoreError):
            async with store.transaction() as tx:
                await tx.upsert_node(ns, "Source", "x:s", _props(ns, "x:s"))
                await tx.upsert_node(ns, "Evidence", "x:e", {**_props(ns, "x:e"), "target_id": "x:s"})
        store._exec = real
        found = await store.get_node(ns, "Evidence", "x:e")
        await store.close()
        return found

    assert run(go()) is None
