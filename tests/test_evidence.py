import pytest
from helpers import HYDRADB, create_entities, fresh_graph, make_store, run, unique_ns

from selfgraph import EvidenceInput, Extraction, NotFoundError, SyncSelfGraph, ValidationError, relation_id

FACTS = {
    "entities": [{"type": "Person", "name": "Ada"}, {"type": "Company", "name": "Acme"}],
    "relations": [{"from_entity": "person:ada", "type": "WORKS_AT", "to_entity": "company:acme"}],
}
REL = relation_id("person:ada", "WORKS_AT", "company:acme")


def _all(page_fn, id):
    items, cursor = [], None
    while True:
        page = run(page_fn(id, cursor=cursor, limit=2))
        items.extend(page.items)
        if page.next_cursor is None:
            return items
        cursor = page.next_cursor


def _records(g):
    return run(g.store.match_nodes(g.namespace, "Evidence"))


def test_sources_counted_once_and_evidence_paginated():
    g = fresh_graph("ev")
    for i in range(5):
        res = run(g.insert.facts(FACTS, source_id=f"doc-{i}"))
    again = run(g.insert.facts(FACTS, source_id="doc-0"))
    assert [e.source_count for e in res.entities] == [5, 5]
    assert [e.source_count for e in again.entities] == [5, 5]
    assert again.relations[0].source_count == 5
    assert run(g.entities.get("person:ada")).source_count == 5
    evidence = _all(g.entities.evidence, "person:ada")
    assert sorted(e.source_id for e in evidence) == [f"doc-{i}" for i in range(5)]
    assert len(_all(g.relations.evidence, REL)) == 5
    assert len(_records(g)) == 15


def test_repeated_entity_in_one_insert_counts_its_source_once():
    g = fresh_graph("ev")
    res = run(
        g.insert.facts(
            {"entities": [{"type": "Person", "name": "Ada"}, {"type": "Person", "name": "Ada", "aliases": ["A"]}]},
            source_id="s",
        )
    )
    assert [e.source_count for e in res.entities] == [1]
    assert res.entities[0].aliases == ["A"]
    assert len(_all(g.entities.evidence, "person:ada")) == 1


def test_relation_update_adds_evidence_and_never_clears_it():
    g = fresh_graph("ev")
    run(g.insert.facts(FACTS, source_id="s1"))
    same = run(g.relations.update(REL, evidence=[EvidenceInput(source_id="s2", quote="works there")]))
    assert (same.revision, same.source_count) == (1, 2)
    moved = run(g.relations.update(REL, set_properties={"role": "CTO"}))
    assert (moved.revision, moved.source_count) == (2, 2)
    again = run(g.relations.update(REL, evidence=[EvidenceInput(source_id="s2", quote="works there")]))
    assert again.source_count == 2
    quotes = sorted((e.source_id, e.quote) for e in _all(g.relations.evidence, REL))
    assert quotes == [("s1", None), ("s2", "works there")]


def test_created_relation_records_its_evidence():
    g = fresh_graph("ev")
    create_entities(g, "Person:Ada", "Company:Acme")
    rel = run(
        g.relations.create(
            "person:ada",
            "WORKS_AT",
            "company:acme",
            evidence=[EvidenceInput(source_id="m", quote="a", start_offset=1, end_offset=2, confidence=0.5)],
        )
    )
    assert rel.source_count == 1
    [ev] = _all(g.relations.evidence, rel.id)
    assert (ev.source_id, ev.source_version, ev.quote, ev.start_offset, ev.end_offset, ev.confidence) == (
        "m",
        "m:manual",
        "a",
        1,
        2,
        0.5,
    )


def test_deletes_cascade_to_evidence():
    g = fresh_graph("ev")
    run(g.insert.facts(FACTS, source_id="s1"))
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Bob"}]}, source_id="s1"))
    run(g.relations.delete(REL))
    assert len(_records(g)) == 3
    run(g.insert.facts(FACTS, source_id="s2"))
    run(g.entities.delete("person:ada"))
    remaining = {(r["target_id"], r["source_id"]) for r in _records(g)}
    assert remaining == {("company:acme", "s1"), ("company:acme", "s2"), ("person:bob", "s1")}


def test_evidence_for_another_source_keeps_its_own_version():
    g = fresh_graph("ev")
    facts = Extraction.model_validate(
        {
            "entities": [{"type": "Person", "name": "A"}, {"type": "Person", "name": "B"}],
            "relations": [{"from_entity": "person:a", "type": "KNOWS", "to_entity": "person:b"}],
        }
    )
    facts.relations[0].evidence = [
        EvidenceInput(source_id="doc1", quote="other"),
        EvidenceInput(source_id="src1", quote="own"),
    ]
    res = run(g.insert.facts(facts, source_id="src1"))
    rid = res.relations[0].id
    by_quote = {e.quote: e for e in run(g.relations.evidence(rid)).items}
    assert by_quote["other"].source_version == "doc1:manual"
    assert by_quote["own"].source_version == res.source_version
    plain = run(g.insert.facts(facts))
    assert plain.relations[0].source_count == 2
    items = run(g.relations.evidence(rid)).items
    assert [e.source_version for e in items if e.source_id == "doc1"] == ["doc1:manual"]


def test_evidence_of_unknown_object_raises():
    g = fresh_graph("ev")
    with pytest.raises(NotFoundError):
        run(g.entities.evidence("person:nobody"))
    with pytest.raises(NotFoundError):
        run(g.relations.evidence("relation:nothing"))
    run(g.entities.create("Ada", "Person"))
    assert run(g.entities.evidence("person:ada")).items == []


def test_sync_client_lists_evidence():
    with SyncSelfGraph(store=make_store(), namespace=unique_ns("ev")) as g:
        g.insert.facts(FACTS, source_id="s1")
        page = g.entities.evidence("person:ada")
        assert [e.source_id for e in page.items] == ["s1"]
        assert page.next_cursor is None


@pytest.mark.skipif(not HYDRADB, reason="the per-document size limit this guards is HydraDB's")
def test_entity_from_300_sources_still_writes_on_hydradb():
    g = fresh_graph("ev")
    for i in range(300):
        res = run(g.insert.facts({"entities": [{"type": "Person", "name": "Ada"}]}, source_id=f"src-{i}"))
    assert res.entities[0].source_count == 300
    assert run(g.entities.get("person:ada")).source_count == 300
    page = run(g.entities.evidence("person:ada", limit=1000))
    assert len(page.items) == 300 and page.next_cursor is None


def test_relation_evidence_accepts_dicts_and_rejects_bad_offsets():
    g = fresh_graph("evdict")
    run(g.insert.facts(FACTS))
    rel = run(g.relations.update(REL, evidence=[{"source_id": "m", "start_offset": 0, "end_offset": 3}]))
    assert [(e.source_id, e.start_offset, e.end_offset) for e in run(g.relations.evidence(rel.id)).items] == [
        ("m", 0, 3)
    ]
    for bad, message in (
        ({"start_offset": -1}, "evidence start_offset cannot be negative, got -1"),
        ({"end_offset": -2}, "evidence end_offset cannot be negative, got -2"),
        ({"start_offset": 5, "end_offset": 2}, "evidence start_offset 5 is greater than end_offset 2"),
        ({"confidence": 1.5}, "evidence confidence must be between 0 and 1, got 1.5"),
        ({"confidence": -0.5}, "evidence confidence must be between 0 and 1, got -0.5"),
    ):
        with pytest.raises(ValidationError, match=f"^{message}$"):
            run(g.relations.create("person:ada", "KNOWS", "company:acme", evidence=[{"source_id": "m", **bad}]))
        with pytest.raises(ValidationError, match=f"^{message}$"):
            run(g.relations.update(REL, evidence=[EvidenceInput(source_id="m", **bad)]))
    with pytest.raises(ValidationError, match="^evidence confidence must be between 0 and 1, got 1.5$"):
        run(g.relations.update(REL, evidence=[EvidenceInput.model_construct(source_id="m", confidence=1.5)]))


def test_relation_evidence_for_the_inserted_source_replaces_the_bare_record():
    g = fresh_graph("ev")
    rel = dict(FACTS["relations"][0], evidence=[{"source_id": "doc", "quote": "Ada works at Acme"}])
    res = run(g.insert.facts({**FACTS, "relations": [rel]}, source_id="doc"))
    [ev] = run(g.relations.evidence(REL)).items
    assert (ev.source_id, ev.source_version, ev.quote) == ("doc", res.source_version, "Ada works at Acme")
    assert len(run(g.entities.evidence("person:ada")).items) == 1
    other = dict(rel, evidence=[{"source_id": "elsewhere", "quote": "q"}])
    run(g.insert.facts({**FACTS, "relations": [other]}, source_id="doc2"))
    assert sorted(e.source_id for e in run(g.relations.evidence(REL)).items) == ["doc", "doc2", "elsewhere"]
