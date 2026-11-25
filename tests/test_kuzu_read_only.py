from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from helpers import KUZU, run

from selfgraph import KuzuStore, SelfGraph, StoreError, SyncSelfGraph

FACTS = {
    "entities": [
        {"id": "person:ann", "type": "Person", "name": "Ann"},
        {"id": "company:acme", "type": "Company", "name": "Acme"},
    ],
    "relations": [{"from_entity": "person:ann", "type": "WORKS_AT", "to_entity": "company:acme"}],
}
BOB = {"entities": [{"id": "person:bob", "type": "Person", "name": "Bob"}]}


class FailsToInitialize(KuzuStore):
    async def initialize(self) -> None:
        raise StoreError("setup failed")


def built() -> str:
    path = str(Path(tempfile.mkdtemp()) / "graph.kuzu")

    async def build() -> None:
        async with SelfGraph(store=KuzuStore(path)) as graph:
            await graph.insert.facts(FACTS)

    run(build())
    return path


def drop_key_table(path: str) -> None:
    import kuzu

    db = kuzu.Database(path)
    conn = kuzu.Connection(db)
    conn.execute("DROP TABLE K")
    conn.close()
    db.close()


async def read_only(path: str) -> tuple[list[str], str]:
    async with SelfGraph(store=KuzuStore(path, read_only=True)) as graph:
        ids = sorted(e.id for e in (await graph.entities.list()).items)
        context = (await graph.retrieve("who works at Acme")).context
    return ids, context


async def write_bob(path: str) -> str:
    async with SelfGraph(store=KuzuStore(path)) as graph:
        await graph.insert.facts(BOB)
        return (await graph.entities.get("person:bob")).name


@pytest.mark.skipif(not KUZU, reason="read_only is Kuzu's")
def test_a_graph_built_read_write_reads_back_read_only():
    ids, context = run(read_only(built()))
    assert ids == ["company:acme", "person:ann"]
    assert "Ann -[WORKS_AT]-> Acme" in context


@pytest.mark.skipif(not KUZU, reason="read_only is Kuzu's")
def test_a_graph_stored_before_the_key_table_reads_back_read_only():
    path = built()
    drop_key_table(path)
    ids, context = run(read_only(path))
    assert ids == ["company:acme", "person:ann"]
    assert "Ann -[WORKS_AT]-> Acme" in context


@pytest.mark.skipif(not KUZU, reason="read_only is Kuzu's")
def test_a_failed_read_only_open_leaves_the_path_open_to_a_read_write_store():
    path = built()

    async def fail() -> None:
        async with SelfGraph(store=FailsToInitialize(path, read_only=True)):
            pass

    with pytest.raises(StoreError, match="setup failed"):
        run(fail())
    assert run(write_bob(path)) == "Bob"


@pytest.mark.skipif(not KUZU, reason="read_only is Kuzu's")
def test_a_failed_sync_read_only_open_leaves_the_path_open_to_a_read_write_store():
    path = built()
    with pytest.raises(StoreError, match="setup failed"), SyncSelfGraph(store=FailsToInitialize(path, read_only=True)):
        pass
    assert run(write_bob(path)) == "Bob"
