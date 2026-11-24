import pytest
from helpers import HYDRADB, make_store, run, unique_ns

from selfgraph import SelfGraph, StoreError

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


def test_upsert_nodes_applies_extra_label():
    store, ns = make_store(), unique_ns("queue")

    async def go():
        async with store.transaction() as tx:
            await tx.upsert_nodes(
                ns,
                "Source",
                [("x:a", _props(ns, "x:a")), ("x:b", _props(ns, "x:b"))],
                extra_label="CustomLabel",
            )
        found_primary = [await store.get_node(ns, "Source", i) for i in ("x:a", "x:b")]
        found_extra = [await store.get_node(ns, "CustomLabel", i) for i in ("x:a", "x:b")]
        await store.close()
        return [f["id"] for f in found_primary if f], [f["id"] for f in found_extra if f]

    assert run(go()) == (["x:a", "x:b"], ["x:a", "x:b"])


def test_entity_types_that_are_not_hydradb_labels_still_write():
    ns = unique_ns("labels")
    g = SelfGraph(make_store(), namespace=ns)

    async def go():
        await g.initialize()
        for name, type in (("Acme", "Big Co"), ("Delhi", "शहर"), ("Ada", "Person"), ("Bot", "Big-Co.v2")):
            await g.entities.create(name, type)
        types = {e.id: e.type for e in (await g.entities.list()).items}
        labelled = await g.store.get_node(ns, "Person", "person:ada") is not None
        await g.close()
        return types, labelled

    types, labelled = run(go())
    assert types == {"big-co:acme": "Big Co", "शहर:delhi": "शहर", "person:ada": "Person", "big-co.v2:bot": "Big-Co.v2"}
    assert labelled


@pytest.mark.parametrize("operation", ["node", "edge", "update"])
def test_json_blobs_use_the_full_hydradb_row_budget(operation):
    store, ns = make_store(), unique_ns("blob")
    blob = '{"text":"' + "x" * (1100 * 1024) + '"}'

    async def go():
        await store.initialize()
        await store.upsert_node(ns, "Source", "x:a", _props(ns, "x:a"))
        await store.upsert_node(ns, "Source", "x:b", _props(ns, "x:b"))
        props = {"id": "e:blob", "ns": ns, "revision": 1, "is_current": True, "properties_json": blob}
        if operation == "node":
            await store.upsert_node(ns, "Source", "x:a", {**_props(ns, "x:a"), "properties_json": blob})
            assert (await store.get_node(ns, "Source", "x:a"))["properties_json"] == blob
            query = "MATCH (n:Source {ns: $ns, sid: 'x:a'}) RETURN n.properties_json AS duplicate"
        else:
            initial = {**props, "properties_json": "{}"} if operation == "update" else props
            assert await store.create_edge(ns, "LINK", "Source", "x:a", "Source", "x:b", initial)
            if operation == "update":
                await store.update_current_edge(ns, "e:blob", {"properties_json": blob})
            assert (await store.get_current_edge(ns, "e:blob"))["props"]["properties_json"] == blob
            query = "MATCH (:Source {ns: $ns})-[r:RELATES]->() RETURN r.properties_json AS duplicate"
        assert (await store.run_cypher(query, {"ns": ns})).rows == [{"duplicate": None}]
        await store.delete_node(ns, "Source", "x:a")
        await store.delete_node(ns, "Source", "x:b")

    run(go())
