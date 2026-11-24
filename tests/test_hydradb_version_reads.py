import asyncio
from unittest.mock import AsyncMock

from selfgraph import HydraDBStore
from selfgraph.models import CypherResult


def test_hydradb_version_reads_filter_edge_properties_without_index_seeks(monkeypatch):
    async def go():
        store = HydraDBStore("bolt://127.0.0.1:1", auth=("neo4j", "unused"))
        execute = AsyncMock(return_value=CypherResult())
        monkeypatch.setattr(store, "_exec", execute)
        try:
            await store.match_edges("versions", from_label="Entity", to_label="Entity", type="KNOWS", current_only=True)
            await store.match_edges("versions", from_label="Entity", to_label="Entity", from_in=["person:a"])
            await store.get_current_edge("versions", "relation:a")
            await store.list_edge_versions("versions", "relation:a")
            assert await store.edge_versions("versions", "Entity", "Entity", ["relation:b", "relation:a"]) == []
        finally:
            await store.close()
        current, history, by_id, versions, batch = (call.args[0] for call in execute.await_args_list)
        assert "(a:Entity {ns: $ns})" in current
        assert "NOT r.`ns` <> $eq0" in current and "NOT r.`etype` <> $eq1" in current
        assert "NOT r.is_current <> true" in current
        assert "a.id IN $fiids_in" in history and "NOT r.`ns` <> $eq0" in history
        assert "r.is_current" not in history
        assert "NOT r.`sid` <> $sid" in by_id and "NOT r.`sid` <> $sid" in versions
        assert "NOT (NOT r.sid IN $sids)" in batch

    asyncio.run(go())
