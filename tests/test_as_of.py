import time
from datetime import datetime, timedelta, timezone

import pytest
from helpers import cli, create_entities, employment_graph, fresh_graph, mcp_session, run, utc, works_at

from selfgraph import EntityInput, Extraction, StoreError, ValidationError
from selfgraph.runtime import to_jsonable


def instant():
    time.sleep(0.01)
    stamp = datetime.now(timezone.utc)
    time.sleep(0.01)
    return stamp


class Names:
    def __init__(self):
        self.names = ["Ann"]

    async def extract(self, document):
        """Extract each listed name as a Person, whatever the text.

        @param document (ParsedDocument): the text.
        @return (Extraction): the entities.
        """
        return Extraction(entities=[EntityInput(type="Person", name=name) for name in self.names])


def graph():
    g = fresh_graph("asof")
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Ann"}, {"type": "Company", "name": "Acme"}]}))
    return g


def lines(g, as_of, query="Ann Acme Globex"):
    return run(g.retrieve(query, as_of=as_of)).context.splitlines()


def test_relations_read_as_the_revision_valid_then():
    g = graph()
    rel = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", properties={"role": "dev"}))
    assert to_jsonable(run(g.retrieve("Ann", as_of=None))) == to_jsonable(run(g.retrieve("Ann")))
    first = instant()
    run(g.relations.update(rel.id, set_properties={"role": "cto"}))
    assert "Ann -[WORKS_AT]-> Acme {role=dev}" in lines(g, first)
    assert "Ann -[WORKS_AT]-> Acme {role=cto}" in lines(g, instant())
    picked = run(g.retrieve("Ann", as_of=first)).subgraph.relations
    assert [(r.id, r.revision) for r in picked] == [(rel.id, 1)]


def test_invalidation_ends_validity_and_reassertion_restores_it():
    g = employment_graph("asof", contradiction="supersede")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    before = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    between = instant()
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    after = instant()

    def ids(as_of):
        return {r.id for r in run(g.retrieve("Ann", as_of=as_of)).subgraph.relations}

    assert ids(before) == {acme.id}
    assert ids(between) == {globex.id}
    assert ids(after) == {acme.id}


def test_entities_exist_from_when_they_were_stored():
    g = graph()
    first = instant()
    run(g.entities.create("Zed", "Person"))
    run(g.relations.create("person:ann", "KNOWS", "person:zed"))
    seeds = run(g.retrieve("Zed", as_of=first)).seeds
    assert seeds == []
    result = run(g.retrieve("Ann", as_of=first))
    assert [e.id for e in result.subgraph.entities] == ["person:ann"]
    assert result.subgraph.relations == []
    assert run(g.retrieve("Ann Zed", as_of=first - timedelta(days=1))).subgraph.entities == []


def test_event_time_decides_when_a_relation_takes_effect():
    g = graph()
    now = datetime.now(timezone.utc)
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time=now + timedelta(days=30)))
    assert run(g.retrieve("Ann", as_of=now + timedelta(days=1))).subgraph.relations == []
    assert len(run(g.retrieve("Ann", as_of=now + timedelta(days=31))).subgraph.relations) == 1


def test_backdated_facts_show_on_the_valid_time_axis():
    g = graph()
    run(g.insert.facts({"relations": [works_at("acme", 2020, properties={"role": "dev"})]}))
    [stored] = run(g.relations.list()).items
    run(g.relations.update(stored.id, set_properties={"role": "cto"}, event_time=utc(2022)))

    def at(year):
        return run(g.retrieve("Ann Acme", as_of=utc(year, 6)))

    assert "Ann -[WORKS_AT]-> Acme {role=dev}" in at(2021).context.splitlines()
    assert {e.id for e in at(2021).subgraph.entities} == {"person:ann", "company:acme"}
    assert "Ann -[WORKS_AT]-> Acme {role=cto}" in at(2023).context.splitlines()
    early = at(2019)
    assert (early.seeds, early.subgraph.entities, early.subgraph.relations, early.context) == ([], [], [], "")


def test_backdated_preferences_name_their_entities_and_decisions_need_visible_entities():
    g = fresh_graph("asof")
    t2020 = utc(2020)
    create_entities(g, "Person:Jane Q Doe", "Company:Acme", "Tool:Python", "Tool:Rust")
    rel = run(g.relations.create("person:jane-q-doe", "WORKS_AT", "company:acme", event_time=t2020))
    run(g.preferences.create("person:jane-q-doe", "tool", "tool:python", event_time=t2020))
    run(g.decisions.create("Pick Rust", steps=[rel.id], outcome_entity="tool:rust", event_time=t2020))
    result = run(g.retrieve("Jane", as_of=utc(2021)))
    assert "Jane Q Doe prefers Python (tool)" in result.context.splitlines()
    assert "tool:python" not in result.context
    assert result.subgraph.decisions == []
    assert [d.title for d in run(g.retrieve("Jane")).subgraph.decisions] == ["Pick Rust"]


def test_preferences_and_decisions_are_read_as_of():
    g = graph()
    rel = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    pref = run(g.preferences.create("person:ann", "employer", "company:acme", strength=0.5))
    first = instant()
    run(g.preferences.update(pref.id, strength=0.9))
    run(g.decisions.create("Join Acme", steps=[rel.id], actor_entity="person:ann"))
    early = run(g.retrieve("Ann", as_of=first))
    assert [p.strength for p in early.subgraph.preferences] == [0.5]
    assert early.subgraph.decisions == []
    late = run(g.retrieve("Ann", as_of=instant()))
    assert [p.strength for p in late.subgraph.preferences] == [0.9]
    assert [d.title for d in late.subgraph.decisions] == ["Join Acme"]


def test_passages_need_their_source_stored_and_its_event_time_reached():
    g = graph()
    first = instant()
    run(g.insert.text("Ann works at Acme.", source_id="note"))
    assert "Ann works at Acme." not in lines(g, first)
    assert "Ann works at Acme." in lines(g, instant())
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time=utc(2020)))
    run(g.insert.text("Ann joined Acme.", source_id="dated", event_time=utc(2020)))
    assert "Ann joined Acme." in lines(g, utc(2021))
    assert "Ann joined Acme." not in lines(g, utc(2019))


def test_as_of_parsing_on_every_surface(capsys):
    g = graph()
    with pytest.raises(ValidationError, match="as_of must be a datetime, got int"):
        run(g.retrieve("Ann", as_of=5))
    with pytest.raises(ValidationError, match="invalid as_of: 'soon' is not an ISO 8601"):
        run(g.retrieve("Ann", as_of="soon"))
    assert run(g.retrieve("Ann", as_of="2024-01-01")) == run(g.retrieve("Ann", as_of=utc(2024)))
    naive = run(g.retrieve("Ann", as_of=datetime(2024, 1, 1)))
    assert naive == run(g.retrieve("Ann", as_of=utc(2024)))
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    past = "2000-01-01T00:00:00+00:00"
    for as_of in (past, "2000-01-01T00:00:00", "2000-01-01", "2000-01-01T00:00:00Z"):
        assert cli(g, ["retrieve", "Ann", "--as-of", as_of], capsys)["subgraph"]["entities"] == []

    with mcp_session("asof-mcp") as srv:
        run(srv.insert_facts({"entities": [{"type": "Person", "name": "Ann"}]}))
        assert run(srv.retrieve("Ann"))["subgraph"]["entities"] != []
        for as_of in (past, "2000-01-01T00:00:00", "2000-01-01T00:00:00Z"):
            assert run(srv.retrieve("Ann", as_of=as_of))["subgraph"]["entities"] == []
        with pytest.raises(ValidationError, match="invalid as_of"):
            run(srv.retrieve("Ann", as_of="yesterday"))
    run(g.close())
    with pytest.raises(StoreError):
        run(g.retrieve("Ann", as_of=datetime.now(timezone.utc)))


def test_the_highest_revision_in_effect_wins_even_when_backdated():
    g = graph()
    rel = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    run(g.relations.update(rel.id, set_properties={"title": "Dev"}, event_time=utc(2025)))
    assert "Ann -[WORKS_AT]-> Acme {title=Dev}" in lines(g, instant())
    assert "Ann -[WORKS_AT]-> Acme {title=Dev}" in lines(g, utc(2099))
    assert "Ann -[WORKS_AT]-> Acme {title=Dev}" in lines(g, utc(2025, 6))
    assert run(g.retrieve("Ann", as_of=utc(2024))).subgraph.relations == []


def test_known_at_reads_what_the_graph_held_before_a_backdated_correction():
    g = employment_graph("asof", contradiction="supersede")
    acme = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time=utc(2024)))
    learned = instant()
    globex = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time=utc(2025)))

    def held(**at):
        return run(g.retrieve("Ann", **at)).subgraph.relations

    assert [r.id for r in held(as_of=utc(2025, 6))] == [globex.id]
    [then] = held(as_of=utc(2025, 6), known_at=learned)
    assert (then.id, then.is_current, then.invalidated_at, then.invalidated_known_at) == (acme.id, True, None, None)
    assert [r.id for r in held(known_at=learned)] == [acme.id]
    assert [r.id for r in held(known_at=instant())] == [globex.id]
    [old] = held(as_of=utc(2024, 6))
    assert (old.id, old.is_current, old.invalidated_by) == (acme.id, False, globex.id)
    assert old.invalidated_known_at > learned


def test_known_at_leaves_out_what_was_written_later():
    g = graph()
    rel = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    learned = instant()
    run(g.relations.certify(rel.id, by="ops"))
    run(g.entities.create("Zed", "Person"))
    run(g.decisions.create("Join Acme", steps=[rel.id], actor_entity="person:ann", event_time=utc(2020)))
    run(g.relations.update(rel.id, set_properties={"role": "cto"}, event_time=utc(2020)))
    then = run(g.retrieve("Ann Acme Zed", as_of=utc(2099), known_at=learned))
    assert {e.id for e in then.subgraph.entities} == {"person:ann", "company:acme"}
    assert then.subgraph.decisions == []
    assert [(r.revision, r.is_current, r.certified_at, r.properties) for r in then.subgraph.relations] == [
        (1, True, None, {})
    ]
    assert "[certified]" not in then.context
    later = run(g.retrieve("Ann Acme Zed", as_of=utc(2099)))
    assert "person:zed" in {e.id for e in later.subgraph.entities}
    assert [d.title for d in later.subgraph.decisions] == ["Join Acme"]
    assert [r.revision for r in later.subgraph.relations] == [2]
    assert run(g.check_answerable("Zed", known_at=learned)).verdict == "not_answerable"
    assert run(g.check_answerable("Zed", known_at=instant())).verdict == "answerable"


def test_known_at_quotes_the_source_version_the_graph_held():
    g = graph()
    run(g.insert.text("Ann works at Acme in Berlin.", source_id="note"))
    learned = instant()
    run(g.insert.text("Ann works at Acme in Paris.", source_id="note", replace_source=True))

    def passages(**at):
        return run(g.retrieve("Ann Acme Berlin Paris", **at)).context

    assert "Ann works at Acme in Berlin." in passages(as_of=utc(2099), known_at=learned)
    assert "Ann works at Acme in Paris." not in passages(as_of=utc(2099), known_at=learned)
    assert "Ann works at Acme in Paris." in passages(as_of=utc(2099))
    assert "Ann works at Acme in Berlin." not in passages(as_of=utc(2099))


def test_known_at_on_every_surface(capsys):
    g = employment_graph("asof", contradiction="supersede")
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time=utc(2024)))
    learned = instant()
    run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time=utc(2025)))
    with pytest.raises(ValidationError, match="invalid known_at: 'soon' is not an ISO 8601"):
        run(g.retrieve("Ann", known_at="soon"))
    stamp = learned.isoformat()
    out = cli(g, ["retrieve", "Ann", "--known-at", stamp], capsys)
    assert [r["to_entity"] for r in out["subgraph"]["relations"]] == ["company:acme"]
    out = cli(g, ["check-answerable", "Ann", "Globex", "--known-at", stamp, "--as-of", "2025-06-01"], capsys)
    assert (out["verdict"], out["missing"]) == ("partial", ["globex"])

    with mcp_session("asof-mcp") as srv:
        run(srv.insert_facts({"entities": [{"type": "Person", "name": "Ann"}]}))
        learned = instant().isoformat()
        run(srv.insert_facts({"entities": [{"type": "Person", "name": "Zed"}]}))
        assert run(srv.retrieve("Zed", known_at=learned))["subgraph"]["entities"] == []
        assert run(srv.retrieve("Zed"))["subgraph"]["entities"] != []
        assert run(srv.check_answerable("Zed", known_at=learned))["verdict"] == "not_answerable"
        with pytest.raises(ValidationError, match="invalid known_at"):
            run(srv.retrieve("Ann", known_at="yesterday"))


def test_known_at_keeps_passages_through_reinserts_and_replacement_history():
    g = graph()
    run(g.insert.text("Ann works at Acme in Berlin.", source_id="note"))
    first = instant()
    run(g.insert.text("Ann works at Acme in Berlin.", source_id="note"))
    run(g.insert.text("Ann works at Acme in Paris.", source_id="note", replace_source=True))
    replaced = instant()
    run(g.insert.text("Ann works at Acme in Berlin.", source_id="note", replace_source=True))

    def quoted(known):
        context = run(g.retrieve("Ann Acme Berlin Paris", as_of=utc(2099), known_at=known)).context.splitlines()
        return [line for line in ("Ann works at Acme in Berlin.", "Ann works at Acme in Paris.") if line in context]

    assert quoted(first) == ["Ann works at Acme in Berlin."]
    assert quoted(replaced) == ["Ann works at Acme in Paris."]
    assert quoted(instant()) == ["Ann works at Acme in Berlin."]


def test_restored_source_stays_replaced_before_its_restore():
    g = graph()
    run(g.insert.text("Ann works at Acme in Berlin.", source_id="note", event_time=utc(2020)))
    run(g.insert.text("Ann works at Acme in Paris.", source_id="note", event_time=utc(2021), replace_source=True))
    before = instant()
    run(g.insert.text("Ann works at Acme in Berlin.", source_id="note", replace_source=True))
    
    def passages(**at):
        return run(g.retrieve("Ann Acme Berlin Paris", **at)).context
        
        assert "Ann works at Acme in Berlin." not in passages(as_of=utc(2022))
        assert "Ann works at Acme in Paris." in passages(as_of=utc(2022))
        assert "Ann works at Acme in Berlin." not in passages(as_of=utc(2022), known_at=before)
        assert "Ann works at Acme in Berlin." not in passages(as_of=utc(2022), known_at=instant())
        assert "Ann works at Acme in Berlin." in passages(as_of=utc(2020, 6))
        assert "Ann works at Acme in Berlin." in passages(as_of=utc(2099))
        
        
        def test_known_at_shows_the_certification_in_force_then():
    g = graph()
    rel = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    first = run(g.relations.certify(rel.id, by="alice"))
    assert run(g.relations.certify(rel.id, by="alice")).certified_at == first.certified_at
    alice = instant()
    run(g.relations.certify(rel.id, by="bob"))
    bob = instant()
    run(g.relations.uncertify(rel.id))

    def held(known):
        [r] = run(g.retrieve("Ann", known_at=known)).subgraph.relations
        return r.certified_by, [(c.by, c.until is None) for c in r.certifications]

    assert held(alice) == ("alice", [("alice", True)])
    assert held(bob) == ("bob", [("alice", False), ("bob", True)])
    assert held(instant()) == (None, [("alice", False), ("bob", False)])


def test_known_at_counts_only_the_sources_recorded_by_then():
    g = graph()
    run(g.insert.facts({"relations": [works_at("acme")]}, source_id="one"))
    [written] = run(g.relations.list()).items
    assert [r.source_count for r in run(g.retrieve("Ann", known_at=written.created_at)).subgraph.relations] == [1]
    learned = instant()
    run(g.insert.facts({"relations": [works_at("acme")]}, source_id="two"))
    assert [r.source_count for r in run(g.retrieve("Ann")).subgraph.relations] == [2]
    assert [r.source_count for r in run(g.retrieve("Ann", known_at=learned)).subgraph.relations] == [1]


def test_reinserting_the_same_text_keeps_the_version_as_first_stored():
    g = graph()
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time=utc(2020)))
    run(g.insert.text("Ann joined Acme.", source_id="dated", event_time=utc(2020)))
    run(g.insert.text("Ann joined Acme.", source_id="dated", event_time=utc(2024)))
    assert "Ann joined Acme." in lines(g, utc(2021))


def test_known_at_quotes_a_passage_only_once_its_evidence_was_recorded():
    names = Names()
    g = fresh_graph("asof", extractor=names)
    run(g.entities.create("Bob", "Person"))
    run(g.insert.text("Ann met Bob.", source_id="note"))
    learned = instant()
    names.names = ["Ann", "Bob"]
    run(g.insert.text("Ann met Bob.", source_id="note"))
    assert "Ann met Bob." in run(g.retrieve("Bob")).context
    assert "Ann met Bob." not in run(g.retrieve("Bob", known_at=learned)).context
