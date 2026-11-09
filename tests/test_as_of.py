import time
from datetime import datetime, timedelta, timezone

import pytest
from helpers import cli, create_entities, employment_graph, fresh_graph, mcp_session, run, utc, works_at

from selfgraph import StoreError, ValidationError
from selfgraph.runtime import to_jsonable


def instant():
    time.sleep(0.01)
    stamp = datetime.now(timezone.utc)
    time.sleep(0.01)
    return stamp


def graph():
    g = fresh_graph("asof")
    run(g.insert.ontology({"entities": [{"type": "Person", "name": "Ann"}, {"type": "Company", "name": "Acme"}]}))
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
    run(g.insert.ontology({"relations": [works_at("acme", 2020, properties={"role": "dev"})]}))
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
        run(srv.insert_ontology({"entities": [{"type": "Person", "name": "Ann"}]}))
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
