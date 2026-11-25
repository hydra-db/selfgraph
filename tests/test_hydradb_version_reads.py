import asyncio
import json
from unittest.mock import AsyncMock

from selfgraph import HydraDBStore
from selfgraph.models import CypherResult


def test_hydradb_version_reads_filter_after_selecting_sources(monkeypatch):
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
        current, history, by_id, version_seed, versions, batch = (call.args[0] for call in execute.await_args_list)
        assert "(a:Entity {ns: $ns})" in current
        assert "NOT r.`ns` <> $eq0" in current and "NOT r.`etype` <> $eq1" in current
        assert "NOT r.is_current <> true" in current
        assert "a.id IN $fiids_in" in history and "NOT r.`ns` <> $eq0" in history
        assert "r.is_current" not in history
        assert "{sid: $sid}" in by_id and "{sid: $sid}" in version_seed
        assert "NOT r.is_current <> true" in by_id
        assert "a.id IN $sources" in versions and "NOT r.`ns` <> $ns" in versions
        assert "[r:RELATES {sid: $sid}]" in versions and "r.`sid`" not in versions
        assert "r.sid IN $sids" in batch
        assert "RETURN a.id AS source" in batch

    asyncio.run(go())


def test_bulk_version_reads_deduplicate_sources_and_preserve_requested_id_order(monkeypatch):
    async def go():
        store = HydraDBStore("bolt://127.0.0.1:1")
        rows = [
            {
                "sid": sid,
                "stored_id": sid,
                "stored_ns": "versions",
                "doc": json.dumps({"id": sid, "revision": revision}),
                "fa": "x:a",
                "tb": "x:b",
                "et": "LINK",
            }
            for sid, revision in (("relation:a", 1), ("relation:b", 1), ("relation:a", 2))
        ]
        execute = AsyncMock(
            side_effect=[CypherResult(rows=[{"source": 1}, {"source": 1}, {"source": 2}]), CypherResult(rows=rows)]
        )
        monkeypatch.setattr(store, "_exec", execute)
        try:
            result = await store.edge_versions("versions", "Entity", "Entity", ["relation:b", "relation:a"])
            assert [(r["props"]["id"], r["props"]["revision"]) for r in result] == [
                ("relation:b", 1),
                ("relation:a", 1),
                ("relation:a", 2),
            ]
            second = execute.await_args_list[1]
            assert second.args[1]["sources"] == [1, 2]
            assert "a.id IN $sources" in second.args[0]
            assert "NOT r.`ns` <> $ns" in second.args[0]
            assert "NOT r.`fl` <> $fl" in second.args[0] and "NOT r.`tl` <> $tl" in second.args[0]
            execute.reset_mock()
            assert await store.edge_versions("versions", None, None, []) == []
            assert await store.edge_versions("versions", None, None, [str(i) for i in range(257)]) is None
            execute.assert_not_awaited()
        finally:
            await store.close()

    asyncio.run(go())


def test_unanchored_scalar_filters_seek_sources_before_reading_histories(monkeypatch):
    async def go():
        store = HydraDBStore("bolt://127.0.0.1:1")
        execute = AsyncMock(return_value=CypherResult())
        monkeypatch.setattr(store, "_exec", execute)
        try:
            assert (
                await store.match_edges(
                    "versions", from_label="Profile", to_label="Entity", equals={"about_entity": "x:missing"}
                )
                == []
            )
            execute.assert_awaited_once()
            assert "{`about_entity`: $seek}" in execute.call_args.args[0]
            execute.reset_mock()
            execute.side_effect = [CypherResult(rows=[{"source": 1}, {"source": 1}, {"source": 2}]), CypherResult()]
            assert (
                await store.match_edges(
                    "versions",
                    from_label="Profile",
                    to_label="Entity",
                    equals={"about_entity": "x:a"},
                    type="PREF",
                    current_only=True,
                    skip=2,
                    limit=3,
                    id_gt="relation:a",
                )
                == []
            )
            second = execute.await_args_list[1]
            assert "MATCH (a:Profile)" in second.args[0] and "a.id IN $sources" in second.args[0]
            assert second.args[1]["sources"] == [1, 2]
            assert second.args[1]["ns"] == "versions" and second.args[1]["skip"] == 2 and second.args[1]["limit"] == 3
            assert "NOT r.is_current <> true" in second.args[0] and "ORDER BY __ob, __rev" in second.args[0]
        finally:
            await store.close()

    asyncio.run(go())


def test_filtered_source_seek_caps_history_rows_and_falls_back(monkeypatch):
    async def go():
        store = HydraDBStore("bolt://127.0.0.1:1")
        execute = AsyncMock(side_effect=[CypherResult(rows=[{"source": 1}] * 257), CypherResult()])
        monkeypatch.setattr(store, "_exec", execute)
        try:
            assert (
                await store.match_edges("versions", from_label="Profile", equals={"about_entity": "x:a"}, limit=1) == []
            )
            first, second = execute.await_args_list
            assert "LIMIT $seek_limit" in first.args[0] and first.args[1]["seek_limit"] == 257
            assert "(a:Profile {ns: $ns})" in second.args[0] and "sources" not in second.args[1]
            execute.reset_mock()
            execute.side_effect = None
            execute.return_value = CypherResult()
            assert await store.match_edges("versions", from_label="Profile", equals={"value": ["a"]}, limit=1) == []
            execute.assert_awaited_once()
            assert "seek_limit" not in execute.call_args.args[1]
        finally:
            await store.close()

    asyncio.run(go())
