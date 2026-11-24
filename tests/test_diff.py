import pytest
from helpers import create_entities, employment_graph, fresh_graph, instant, run

from selfgraph import ValidationError


def test_diff_tracks_insert_revision_and_supersede_by_known_time():
    g = employment_graph("diff", contradiction="supersede")
    start = instant()
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2000-01-01"))
    inserted = instant()
    revised = run(g.relations.update(acme.id, set_properties={"role": "cto"}))
    updated = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2001-01-01"))
    end = instant()
    first = run(g.diff(start, inserted))
    assert [(r.id, r.revision) for r in first.relations_added] == [(acme.id, 1)]
    assert first.relations_retired == first.relations_revised == first.entities_created == []
    second = run(g.diff(inserted, updated))
    assert [(r.id, r.revision) for r in second.relations_revised] == [(revised.id, 2)]
    assert second.relations_added == second.relations_retired == second.entities_created == []
    third = run(g.diff(updated, end))
    assert [r.id for r in third.relations_added] == [globex.id]
    assert [(r.id, r.invalidated_by) for r in third.relations_retired] == [(acme.id, globex.id)]
    assert third.relations_revised == third.entities_created == []
    assert run(g.relations.get(acme.id)) is None
    assert {r.id for r in run(g.relations.list(include_invalidated=True)).items} == {acme.id, globex.id}


def test_diff_entities_empty_window_validation_and_namespace():
    g = fresh_graph("diff")
    start = instant()
    create_entities(g, "Person:Ann", "Person:Bob")
    end = instant()
    d = run(g.diff(start.isoformat(), end))
    assert [e.id for e in d.entities_created] == ["person:ann", "person:bob"]
    assert d.limitations == ["Deletes and entity edits are not visible."]
    assert d.relations_added == d.relations_retired == d.relations_revised == []
    assert run(g.diff(end, end)).entities_created == []
    assert run(fresh_graph("other").diff(start, end)).entities_created == []
    for since, until in ((None, end), (end, start), ("bad", end)):
        with pytest.raises(ValidationError):
            run(g.diff(since, until))
    assert run(g.diff(end)).until >= end


def test_diff_source_replacement_reports_retirement():
    g = fresh_graph("diff-source")
    start = instant()
    run(g.insert.text("Ann works at Acme.", source_id="note"))
    before = instant()
    original = run(g.relations.list()).items
    assert original
    run(g.insert.text("Ann lives in Paris.", source_id="note", replace_source=True))
    after = instant()
    d = run(g.diff(before, after))
    assert {r.id for r in d.relations_retired} == {r.id for r in original}
    assert all(r.invalidated_by.startswith("sv:") for r in d.relations_retired)
    assert {r.id for r in d.relations_added} == {r.id for r in run(g.relations.list()).items}
    assert d.relations_revised == []
    assert [e.id for e in d.entities_created] == ["thing:paris"]
    first = run(g.diff(start, before))
    assert {r.id for r in first.relations_added} == {r.id for r in original}
    assert first.relations_retired == []


def test_diff_boundaries_all_revisions_and_read_only():
    g = fresh_graph("diff-boundaries")
    create_entities(g, "Person:Ann", "Person:Bob")
    r1 = run(g.relations.create("person:ann", "KNOWS", "person:bob"))
    r2 = run(g.relations.update(r1.id, set_properties={"n": 2}))
    r3 = run(g.relations.update(r1.id, set_properties={"n": 3}))
    before = run(g.relations.versions(r1.id))
    d = run(g.diff(r1.created_at, r3.created_at))
    assert d.relations_added == d.relations_retired == d.entities_created == []
    assert [(r.id, r.revision) for r in d.relations_revised] == [(r1.id, 2), (r1.id, 3)]
    assert [r.revision for r in run(g.diff(r1.created_at, r2.created_at)).relations_revised] == [2]
    assert run(g.diff(r3.created_at, r3.created_at)).relations_revised == []
    assert run(g.relations.versions(r1.id)) == before


def test_diff_cli_and_mcp(capsys):
    from helpers import cli, mcp_session

    from selfgraph.cli import build_parser, dispatch
    from selfgraph.mcp import server
    from selfgraph.runtime import to_jsonable

    with mcp_session():
        g = run(server._graph_handle())
        start = instant()
        create_entities(g, "Person:Ann", "Tool:Anvil")
        rel = run(g.relations.create("person:ann", "USES", "tool:anvil"))
        run(g.relations.certify(rel.id, by="alice"))
        pref = run(g.preferences.create("person:ann", "tool", "tool:anvil"))
        decision = run(g.decisions.create("Pick a tool"))
        end = instant()
        expected = to_jsonable(run(g.diff(start, end)))
        flags = ["diff", "--since", start.isoformat(), "--until", end.isoformat()]
        assert cli(g, [*flags, "--json"], capsys) == expected
        run(dispatch(g, build_parser().parse_args(flags)))
        summary = capsys.readouterr().out
        assert "Note: Deletes and entity edits are not visible." in summary
        assert "+ entity person:ann" in summary
        assert f"* certified relation {rel.id} revision 1" in summary
        assert f"+ preference {pref.id} revision 1: person:ann tool -> tool:anvil" in summary
        assert f"+ decision {decision.id}: Pick a tool" in summary
        assert (
            "2 entities created, 1 relations added, 0 revised, 0 retired, 1 certified, 0 uncertified, "
            "1 preferences added, 0 revised, 1 decisions created, 0 updated, 0 merges, 0 unmerges, "
            "0 source versions added"
        ) in summary
        assert run(server.graph_diff(start.isoformat(), end.isoformat())) == expected
        assert "graph_diff" in [tool.__name__ for tool in server.TOOLS]


def test_diff_sync():
    from helpers import make_store, unique_ns

    from selfgraph import SyncSelfGraph

    with SyncSelfGraph(make_store(), namespace=unique_ns("diff-sync")) as g:
        start = instant()
        entity = g.entities.create("Ann", "Person")
        end = instant()
        d = g.diff(start, end)
        assert d.entities_created == [entity]
        assert d.relations_added == d.relations_revised == d.relations_retired == []
        assert d.limitations == ["Deletes and entity edits are not visible."]


def test_diff_pages_entities_and_skips_internal_edges():
    g = fresh_graph("diff-pages")
    start = instant()
    from selfgraph._ops import _PAGE

    count = _PAGE + 5
    run(g.insert.facts({"entities": [{"type": "T", "name": str(i)} for i in range(count)]}))
    run(
        g.insert.facts(
            {
                "relations": [
                    {"id": f"relation:page-{i}", "from_entity": "t:0", "type": "KNOWS", "to_entity": "t:1"}
                    for i in range(count)
                ]
            }
        )
    )
    rel = run(g.relations.create("t:0", "KNOWS", "t:1"))
    run(g.decisions.create("Decision", steps=[rel.id]))
    end = instant()
    d = run(g.diff(start, end))
    assert len(d.entities_created) == count
    assert len({e.id for e in d.entities_created}) == count
    assert {r.id for r in d.relations_added} == {rel.id, *(f"relation:page-{i}" for i in range(count))}
    assert d.relations_retired == d.relations_revised == []


def test_diff_is_read_only_after_initialization(monkeypatch):
    g = fresh_graph("diff-readonly")
    create_entities(g, "T:A", "T:B")
    rel = run(g.relations.create("t:a", "KNOWS", "t:b"))
    start = rel.created_at

    async def no_write(*args, **kwargs):
        raise AssertionError("diff attempted to write")

    for name in ("initialize", "upsert_node", "upsert_nodes", "create_edges", "delete_node", "lock_node"):
        monkeypatch.setattr(g.store, name, no_write)
    assert run(g.diff(start)).relations_added == []


def test_diff_revisions_do_not_repeat_a_copied_retirement():
    g = employment_graph("diff-copied", contradiction="supersede")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    start = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    retired = instant()
    run(
        g.insert.facts(
            {
                "relations": [
                    {
                        "id": acme.id,
                        "from_entity": "person:ann",
                        "type": "WORKS_AT",
                        "to_entity": "company:acme",
                        "properties": {"note": "still retired"},
                        "event_time": "2000-01-01T00:00:00Z",
                    }
                ]
            }
        )
    )
    end = instant()
    assert [(r.id, r.revision) for r in run(g.diff(start, end)).relations_retired] == [(acme.id, 1)]
    later = run(g.diff(retired, end))
    assert later.relations_retired == later.relations_added == []
    assert [(r.id, r.revision) for r in later.relations_revised] == [(acme.id, 2)]
    assert [r.id for r in run(g.retrieve("Ann", known_at=retired)).subgraph.relations] == [globex.id]


def test_diff_reports_a_certification_once_after_a_delete_copies_it():
    g = employment_graph("diff-cert-copy", contradiction="supersede")
    run(g.entities.create("Initech", "Company"))
    start = instant()
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2020-01-01"))
    run(g.relations.certify(acme.id, by="alice"))
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2021-01-01"))
    run(g.relations.uncertify(acme.id))
    run(g.relations.create("person:ann", "WORKS_AT", "company:initech", event_time="2022-01-01"))
    deleting = instant()
    run(g.relations.delete(globex.id))
    end = instant()
    d = run(g.diff(start, end))
    assert [(r.id, r.revision) for r in d.relations_certified] == [(acme.id, 1)]
    assert [(r.id, r.revision) for r in d.relations_uncertified] == [(acme.id, 1)]
    later = run(g.diff(deleting, end))
    assert later.relations_certified == later.relations_uncertified == []


def test_diff_validates_naive_and_offset_times_and_closed_graph():
    from datetime import datetime

    from selfgraph import StoreError

    g = fresh_graph("diff-time")
    d = run(g.diff("2020-01-01T05:30:00+05:30", datetime(2020, 1, 1)))
    assert d.since == d.until
    for since, until in ((1, None), ("2020-01-01", False), ("2020-01-01", "bad")):
        with pytest.raises(ValidationError):
            run(g.diff(since, until))
    run(g.close())
    with pytest.raises(StoreError):
        run(g.diff("2020-01-01"))


def test_diff_retirement_boundaries_reassertion_and_delete_limit():
    from datetime import timedelta

    g = employment_graph("diff-retired", contradiction="supersede")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    old = run(g.relations.versions(acme.id))[0]
    ended = old.invalidated_known_at
    d = run(g.diff(acme.created_at - timedelta(microseconds=1), ended))
    assert {r.id for r in d.relations_added} == {acme.id, globex.id}
    assert [r.id for r in d.relations_retired] == [acme.id]
    assert d.relations_revised == []
    assert run(g.diff(ended, ended)).relations_retired == []
    revived = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    later = run(g.diff(ended, revived.created_at))
    assert [(r.id, r.revision) for r in later.relations_revised] == [(acme.id, 2)]
    assert [r.id for r in later.relations_retired] == [globex.id]
    before_delete = instant()
    run(g.relations.delete(acme.id))
    deleted = run(g.diff(before_delete))
    assert deleted.relations_added == deleted.relations_retired == []
    assert [(r.id, r.revision) for r in deleted.relations_revised] == [(globex.id, 2)]
    assert run(g.relations.get(acme.id)) is None
    assert run(g.relations.get(globex.id)) is not None


def test_bolt_edge_pages_order_revisions_within_each_relation(monkeypatch):
    from selfgraph.models import CypherResult
    from selfgraph.stores._cypher import CypherPrimitives

    store = CypherPrimitives()
    queries = []

    async def capture(query, params):
        queries.append((query, params))
        return CypherResult(columns=[], rows=[])

    monkeypatch.setattr(store, "_run", capture)
    run(store.match_edges("test", from_label="Entity", current_only=False, skip=500, limit=500))
    query, params = queries[0]
    assert "ORDER BY r.id, r.revision, from_e, to_e, t SKIP $skip LIMIT $limit" in query
    assert params["skip"] == params["limit"] == 500


def test_diff_late_fact_retirement_correction_and_quiet_restatement():
    g = employment_graph("diff-late", contradiction="supersede")
    create_entities(g, "Company:Initech")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2000-01-01"))
    initech = run(g.relations.create("person:ann", "WORKS_AT", "company:initech", event_time="2004-01-01"))
    before = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2002-01-01"))
    after = instant()
    d = run(g.diff(before, after))
    assert [r.id for r in d.relations_added] == [globex.id]
    assert [(r.id, r.revision) for r in d.relations_revised] == [(acme.id, 2)]
    assert {r.id: r.invalidated_by for r in d.relations_retired} == {acme.id: globex.id, globex.id: initech.id}
    run(
        g.insert.facts(
            {"relations": [{"from_entity": "person:ann", "type": "WORKS_AT", "to_entity": "company:initech"}]}
        )
    )
    quiet = run(g.diff(after))
    assert quiet.relations_added == quiet.relations_revised == quiet.relations_retired == []
    assert run(g.relations.get(initech.id)).event_time == initech.event_time


@pytest.mark.parametrize("count", [499, 500, 501, 505, 1005])
def test_diff_pages_every_revision_of_one_relation(count):
    from selfgraph._serde import encode_relation_props

    g = fresh_graph("diff-revision-pages")
    create_entities(g, "T:A", "T:B")
    stamp = instant()
    rows = [
        (
            "KNOWS",
            "t:a",
            "t:b",
            encode_relation_props(
                ns=g.namespace,
                id="relation:many",
                revision=revision,
                properties={},
                event_time=None,
                created_at=stamp,
                is_current=revision == count,
                source_count=0,
            ),
        )
        for revision in range(count, 0, -1)
    ]
    run(g.store.create_edges(g.namespace, "Entity", "Entity", rows))
    result = run(g.diff("1900-01-01", "2100-01-01"))
    assert [(r.id, r.revision) for r in result.relations_added] == [("relation:many", 1)]
    assert [(r.id, r.revision) for r in result.relations_revised] == [
        ("relation:many", revision) for revision in range(2, count + 1)
    ]
    assert result.relations_retired == []


@pytest.mark.parametrize("backend", ["kuzu", "hydradb"])
def test_document_edge_pages_order_by_id_and_revision(backend, monkeypatch):
    from selfgraph import HydraDBStore, KuzuStore
    from selfgraph.models import CypherResult

    if backend == "kuzu":
        pytest.importorskip("kuzu")
        store = KuzuStore(":memory:")
    else:
        store = HydraDBStore("bolt://localhost:17687", auth=("neo4j", "test"))
    queries = []

    async def capture(query, params):
        queries.append(query)
        return CypherResult(columns=[], rows=[])

    monkeypatch.setattr(store, "_run", capture)
    try:
        run(store.match_edges("test", from_label="Entity", skip=500, limit=500))
        if backend == "kuzu":
            assert "ORDER BY r.sid, r.revision, a.id, b.id, r.etype SKIP 500 LIMIT 500" in queries[-1]
        else:
            assert "r.revision AS __rev" in queries[-1]
            assert "ORDER BY __ob, __rev, fa, tb, et SKIP $skip LIMIT $limit" in queries[-1]
        run(store.match_edges("test", from_label="Entity", order_by="revision"))
        assert "__rev" not in queries[-1]
        assert "ORDER BY r.revision, a.id" in queries[-1] if backend == "kuzu" else "ORDER BY __ob, fa" in queries[-1]
    finally:
        run(store.close())


def test_diff_lists_preference_decision_merge_unmerge_and_source_history():
    g = fresh_graph("diff-history")
    create_entities(g, "Person:Ann", "Tool:Anvil")
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Mergia Robert", "aliases": ["Mergia Bob"]}]}))
    start = instant()
    pref = run(g.preferences.create("person:ann", "tool", "tool:anvil"))
    run(g.preferences.update(pref.id, strength=0.5))
    decision = run(g.decisions.create("Pick a tool"))
    written = instant()
    run(g.decisions.update(decision.id, summary="the anvil"))
    merged = run(
        g.insert.facts({"entities": [{"type": "Person", "name": "Mergia Bob"}]}, source_id="doc", resolver="default")
    )
    [record] = merged.merges
    middle = instant()
    run(g.entities.unmerge(record.id))
    end = instant()
    d = run(g.diff(start, end))
    assert [(p.id, p.revision) for p in d.preferences_added] == [(pref.id, 1)]
    assert [(p.id, p.revision, p.strength) for p in d.preferences_revised] == [(pref.id, 2, 0.5)]
    assert [t.id for t in d.decisions_created] == [t.id for t in d.decisions_updated] == [decision.id]
    assert d.decisions_updated[0].summary == "the anvil"
    assert [(m.id, m.absorbed_id, m.survivor_id) for m in d.entities_merged] == [
        (record.id, record.absorbed_id, record.survivor_id)
    ]
    assert [m.id for m in d.entities_unmerged] == [record.id]
    assert d.entities_unmerged[0].reverted_at is not None
    assert [(v.source_id, v.id, v.media_type) for v in d.source_versions_added] == [
        ("doc", merged.source_version, "application/octet-stream")
    ]
    early = run(g.diff(start, written))
    assert [t.id for t in early.decisions_created] == [decision.id]
    assert early.decisions_updated == early.entities_merged == early.source_versions_added == []
    late = run(g.diff(middle, end))
    assert late.entities_merged == late.preferences_added == late.decisions_created == []
    assert [m.id for m in late.entities_unmerged] == [record.id]
    assert run(g.diff(end)).model_dump(exclude={"since", "until", "limitations"}) == {
        name: [] for name in d.model_dump(exclude={"since", "until", "limitations"})
    }


def test_diff_and_decision_list_read_every_decision_in_one_batch(monkeypatch):
    g = fresh_graph("diff-decision-reads")
    create_entities(g, "Person:Ann", "Tool:Anvil")
    rel = run(g.relations.create("person:ann", "USES", "tool:anvil"))
    start = instant()
    decisions = [run(g.decisions.create(f"Pick {i}", steps=[rel.id, rel.id])) for i in range(20)]
    reads: list[str] = []
    for name in ("get_node", "child_nodes", "match_nodes", "match_edges"):
        original = getattr(g.store, name)

        async def counted(*args, _name=name, _original=original, **kwargs):
            reads.append(_name)
            return await _original(*args, **kwargs)

        monkeypatch.setattr(g.store, name, counted)
    d = run(g.diff(start))
    assert sorted(t.id for t in d.decisions_created) == sorted(t.id for t in decisions)
    assert all([s.relation_id for s in t.steps] == [rel.id, rel.id] for t in d.decisions_created)
    assert "get_node" not in reads and "child_nodes" not in reads
    assert len(reads) <= 12
    reads.clear()
    listed = run(g.decisions.list()).items
    assert [len(t.steps) for t in listed] == [2] * 20
    assert len(reads) <= 3


def test_diff_source_version_metadata_keeps_proto_and_nested_keys(capsys):
    from helpers import cli, mcp_session

    from selfgraph.runtime import to_jsonable

    metadata = {"__proto__": "literal", "nested": [{"__proto__": {"kept": True}, "sibling": "kept"}]}
    with mcp_session("diff-proto") as server:
        g = run(server._graph_handle())
        run(g.insert.text("Ann works at Acme.", source_id="proto", metadata=metadata))
        d = run(g.diff("1900-01-01"))
        assert [v.metadata for v in d.source_versions_added] == [metadata]
        json_out = cli(g, ["diff", "--since", "1900-01-01", "--json"], capsys)
        assert [v["metadata"] for v in json_out["source_versions_added"]] == [metadata]
        tool = run(server.graph_diff("1900-01-01"))
        assert [v["metadata"] for v in tool["source_versions_added"]] == [metadata]
        assert to_jsonable(d)["source_versions_added"][0]["metadata"] == metadata


def test_diff_lists_certify_and_uncertify_by_their_own_times():
    g = fresh_graph("diff-certify")
    create_entities(g, "Person:Ann", "Person:Bob")
    rel = run(g.relations.create("person:ann", "KNOWS", "person:bob"))
    start = instant()
    run(g.relations.certify(rel.id, by="alice"))
    certified = instant()
    run(g.relations.certify(rel.id, by="bob"))
    switched = instant()
    run(g.relations.uncertify(rel.id))
    end = instant()
    first = run(g.diff(start, certified))
    assert [(r.id, r.revision) for r in first.relations_certified] == [(rel.id, 1)]
    assert first.relations_uncertified == first.relations_added == first.relations_revised == []
    second = run(g.diff(certified, switched))
    assert [r.id for r in second.relations_certified] == [r.id for r in second.relations_uncertified] == [rel.id]
    third = run(g.diff(switched, end))
    assert third.relations_certified == []
    [ended] = third.relations_uncertified
    assert [(c.by, c.until is not None) for c in ended.certifications] == [("alice", True), ("bob", True)]


def test_diff_reads_certifications_from_every_version():
    g = fresh_graph("diff-certify-versions")
    create_entities(g, "Person:Ann", "Person:Bob")
    rel = run(g.relations.create("person:ann", "KNOWS", "person:bob"))
    start = instant()
    run(g.relations.certify(rel.id, by="alice"))
    run(g.relations.update(rel.id, set_properties={"n": 2}))
    d = run(g.diff(start))
    assert [(r.id, r.revision, r.is_current) for r in d.relations_certified] == [(rel.id, 1, False)]
    assert [(r.id, r.revision) for r in d.relations_revised] == [(rel.id, 2)]


def test_diff_certify_update_uncertify_ends_the_certification_at_the_update():
    g = fresh_graph("diff-certify-update")
    create_entities(g, "Person:Ann", "Person:Bob")
    rel = run(g.relations.create("person:ann", "KNOWS", "person:bob"))
    start = instant()
    run(g.relations.certify(rel.id, by="alice"))
    revised = run(g.relations.update(rel.id, set_properties={"n": 2}))
    run(g.relations.uncertify(rel.id))
    d = run(g.diff(start))
    assert [(r.id, r.revision) for r in d.relations_certified] == [(rel.id, 1)]
    assert [(r.id, r.revision) for r in d.relations_uncertified] == [(rel.id, 1)]
    assert d.relations_uncertified[0].certifications[0].until == revised.created_at
