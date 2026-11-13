import re

import pytest
from helpers import (
    ANN_ACME_GLOBEX,
    cli,
    extracting_llm,
    fresh_graph,
    json_file,
    mcp_session,
    new_graph,
    run,
    utc,
    works_at,
)

from selfgraph import ConflictError, NotFoundError, ValidationError, ids
from selfgraph.runtime import settings_from_env

SPEC = {
    "entities": [{"name": "Person"}, {"name": "Company"}],
    "relations": [
        {"type": "WORKS_AT", "aliases": ["employed by"], "from": {"types": ["Person"], "max_count": 1}},
        {"type": "CEO_OF", "to": {"max_count": 1}},
        {"type": "KNOWS"},
    ],
}
PEOPLE = [*ANN_ACME_GLOBEX, {"type": "Person", "name": "Bob"}, {"type": "Company", "name": "Initech"}]
ACME = ids.relation_id("person:ann", "WORKS_AT", "company:acme")
GLOBEX = ids.relation_id("person:ann", "WORKS_AT", "company:globex")


def graph(**kwargs):
    g = fresh_graph("contra", schema=SPEC, **kwargs)
    run(g.insert.facts({"entities": PEOPLE}))
    return g


async def collect(items):
    return [r.id async for r in items]


def insert(g, *relations, **kwargs):
    return run(g.insert.facts({"relations": list(relations)}, **kwargs))


@pytest.mark.parametrize(
    ("first", "second"),
    [(("acme", 2020), ("globex", 2023)), (("globex", 2023), ("acme", 2020))],
    ids=["newer-fact", "older-fact"],
)
def test_warn_keeps_both_and_names_the_conflicting_relation(first, second):
    g = graph()
    insert(g, works_at(*first))
    result = insert(g, works_at(*second))
    new, old = (ids.relation_id("person:ann", "WORKS_AT", f"company:{c}") for c, _ in (second, first))
    assert [(w.code, w.message) for w in result.warnings] == [
        (
            "contradiction",
            f"relation {new} contradicts current WORKS_AT relation(s) {old} at from entity person:ann (max_count 1)",
        )
    ]
    assert {r.id for r in run(g.relations.list()).items} == {ACME, GLOBEX}


def test_off_skips_max_count_checks_and_in_batch_conflicts_warn_once_in_any_schema_mode():
    g = graph(contradiction="off")
    insert(g, works_at("acme", 2020))
    assert insert(g, works_at("globex", 2023)).warnings == []
    assert insert(g, works_at("acme"), works_at("globex", 2024)).warnings == []
    assert len(run(g.relations.list()).items) == 2
    for mode in ("warn", "off"):
        g = graph(schema_mode=mode)
        assert [w.code for w in insert(g, works_at("acme"), works_at("globex")).warnings] == ["contradiction"]
        assert {r.id for r in run(g.relations.list()).items} == {ACME, GLOBEX}


def test_supersede_retires_the_older_relation_in_place():
    g = graph(contradiction="supersede")
    insert(g, works_at("acme", 2020))
    result = insert(g, works_at("globex", 2023))
    assert [(w.code, w.message) for w in result.warnings] == [
        (
            "relation_superseded",
            f"relation {ACME} was superseded by {GLOBEX}, a newer WORKS_AT relation at from entity person:ann "
            "(max_count 1)",
        )
    ]
    assert run(g.relations.get(ACME)) is None
    [old] = run(g.relations.versions(ACME))
    assert (old.revision, old.is_current, old.invalidated_at, old.invalidated_by) == (1, False, utc(2023), GLOBEX)
    assert run(g.relations.get(GLOBEX)).invalidated_at is None
    assert [r.id for r in run(g.relations.list()).items] == [GLOBEX]
    listed = run(g.relations.list(include_invalidated=True)).items
    assert sorted((r.id, r.is_current) for r in listed) == sorted([(ACME, False), (GLOBEX, True)])
    assert run(collect(g.relations.iterate(include_invalidated=True))) == [r.id for r in listed]


def test_supersede_resolves_conflicts_within_a_batch_in_input_order():
    g = graph(contradiction="supersede")
    result = insert(g, works_at("acme", 2020), works_at("globex", 2023))
    assert [(r.id, r.is_current, r.invalidated_by) for r in result.relations] == [
        (ACME, False, GLOBEX),
        (GLOBEX, True, None),
    ]
    assert [w.code for w in result.warnings] == ["relation_superseded"]
    assert [r.id for r in run(g.relations.list()).items] == [GLOBEX]


def test_supersede_writes_an_older_fact_as_already_invalidated():
    g = graph(contradiction="supersede")
    insert(g, works_at("globex", 2023))
    result = insert(g, works_at("acme", 2020))
    assert [(w.code, w.message) for w in result.warnings] == [
        (
            "contradiction_out_of_order",
            f"relation {ACME} is older than current WORKS_AT relation {GLOBEX} at from entity person:ann, "
            f"so {GLOBEX} stays current",
        )
    ]
    [rel] = result.relations
    assert (rel.is_current, rel.invalidated_at, rel.invalidated_by) == (False, utc(2023), GLOBEX)
    assert [r.id for r in run(g.relations.list()).items] == [GLOBEX]
    assert [r.id for r in run(g.relations.list(include_invalidated=True)).items] == sorted([ACME, GLOBEX])
    assert [(r.id, r.is_current) for r in insert(g, works_at("acme", 2020)).relations] == [(ACME, False)]

    def valid(year):
        return {r.id for r in run(g.retrieve("Ann", as_of=utc(year))).subgraph.relations}

    assert (valid(2019), valid(2021), valid(2024)) == (set(), {ACME}, {GLOBEX})
    late = run(g.relations.create("person:ann", "WORKS_AT", "company:initech", event_time=utc(2022)))
    assert (late.is_current, late.invalidated_by) == (False, GLOBEX)


def test_create_without_event_time_supersedes_from_its_creation_time(capsys):
    g = graph(contradiction="supersede")
    insert(g, works_at("acme", 2020))
    rel = run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    assert (rel.event_time, rel.is_current) == (None, True)
    assert run(g.relations.versions(ACME))[0].invalidated_at == rel.created_at
    printed = cli(g, ["relation", "create", "person:ann", "WORKS_AT", "company:initech"], capsys)
    assert run(g.relations.versions(GLOBEX))[0].invalidated_by == printed["id"]


def test_aliases_and_the_to_side_are_constrained():
    g = graph(contradiction="supersede")
    insert(g, works_at("acme", 2020))
    insert(g, {"from_entity": "person:ann", "type": "employed by", "to_entity": "company:globex"})
    assert run(g.relations.get(ACME)) is None
    insert(g, {"from_entity": "person:ann", "type": "CEO_OF", "to_entity": "company:acme"})
    insert(g, {"from_entity": "person:bob", "type": "CEO_OF", "to_entity": "company:acme"})
    assert run(g.relations.get(ids.relation_id("person:ann", "CEO_OF", "company:acme"))) is None
    insert(g, {"from_entity": "person:ann", "type": "KNOWS", "to_entity": "person:bob"})
    assert insert(g, {"from_entity": "person:ann", "type": "KNOWS", "to_entity": "company:acme"}).warnings == []


def test_restating_history_is_idempotent_and_a_newer_reassertion_supersedes_back():
    g = graph(contradiction="supersede")
    insert(g, works_at("acme", 2020))
    insert(g, works_at("globex", 2023))
    for _ in range(2):
        [rel] = insert(g, works_at("acme", 2020)).relations
        assert (rel.revision, rel.is_current, rel.invalidated_by) == (1, False, GLOBEX)
    [changed] = insert(g, works_at("acme", 2020, properties={"role": "dev"})).relations
    assert (changed.revision, changed.is_current, changed.invalidated_at) == (2, False, utc(2023))
    assert [r.id for r in run(g.relations.list()).items] == [GLOBEX]
    [rel] = insert(g, works_at("acme", 2024, properties={"role": "cto"})).relations
    assert (rel.revision, rel.is_current, rel.invalidated_at, rel.properties) == (3, True, None, {"role": "cto"})
    assert [v.revision for v in run(g.relations.versions(ACME))] == [3, 2, 1]
    assert run(g.relations.get(GLOBEX)) is None
    assert run(g.relations.versions(GLOBEX))[0].invalidated_by == ACME


def test_create_reasserts_a_retired_relation_with_a_warning_and_conflicts_on_a_current_one(caplog):
    g = graph(contradiction="supersede")
    insert(g, works_at("acme", 2020, properties={"role": "dev"}))
    insert(g, works_at("globex", 2023))
    with pytest.raises(ConflictError):
        run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    with caplog.at_level("WARNING", logger="selfgraph"):
        rel = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2025-01-01"))
    assert (rel.revision, rel.is_current, rel.properties, rel.event_time) == (2, True, {}, utc(2025))
    assert run(g.relations.versions(GLOBEX))[0].invalidated_at == utc(2025)
    assert (
        f"schema warning [relation_reasserted]: relation {ACME} was invalidated by {GLOBEX} at 2023-01-01T00:00:00Z "
        "(revision 1); reasserted as revision 2 with exactly the given properties"
    ) in [r.getMessage() for r in caplog.records]


def test_create_warns_on_the_logger_and_honors_a_per_call_mode(caplog):
    g = graph(contradiction="off")
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time=utc(2020)))
    with caplog.at_level("WARNING", logger="selfgraph"):
        run(g.relations.create("person:ann", "WORKS_AT", "company:globex", contradiction="warn"))
    assert [r.getMessage() for r in caplog.records] == [
        f"schema warning [contradiction]: relation {GLOBEX} contradicts current WORKS_AT relation(s) {ACME} "
        "at from entity person:ann (max_count 1)"
    ]
    run(g.relations.delete(GLOBEX))
    run(g.relations.create("person:ann", "WORKS_AT", "company:globex", contradiction="supersede"))
    assert run(g.relations.get(ACME)) is None


def test_modes_are_validated():
    with pytest.raises(ValidationError, match="contradiction must be one of off, warn, supersede"):
        new_graph(contradiction="newest")
    g = graph()
    with pytest.raises(ValidationError, match="contradiction must be one of"):
        insert(g, works_at("acme"), contradiction="yes")
    with pytest.raises(ValidationError, match="contradiction must be one of"):
        run(g.relations.create("person:ann", "WORKS_AT", "company:acme", contradiction="yes"))


def test_settings_cli_and_mcp_carry_the_mode(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("SELFGRAPH_CONTRADICTION", "supersede")
    assert settings_from_env().contradiction == "supersede"
    g = graph()
    cli(g, ["--contradiction", "off", "relation", "list"], capsys)
    path = json_file(tmp_path, "o.json", {"relations": [works_at("acme", 2020), works_at("globex", 2023)]})
    printed = cli(g, ["insert", "facts", path, "--contradiction", "supersede"], capsys)
    assert [w["code"] for w in printed["warnings"]] == ["relation_superseded"]
    assert len(cli(g, ["relation", "list", "--include-invalidated"], capsys)["items"]) == 2

    with mcp_session("contra-mcp", schema=SPEC) as srv:
        run(srv.insert_facts({"entities": PEOPLE, "relations": [works_at("acme", 2020)]}))
        run(srv.create_relation("person:ann", "WORKS_AT", "company:globex", contradiction="supersede"))
        assert len(run(srv.list_relations())["items"]) == 1
        assert len(run(srv.list_relations(include_invalidated=True))["items"]) == 2


def test_decision_steps_may_name_a_retired_relation():
    g = graph(contradiction="supersede")
    insert(g, works_at("acme", 2020), works_at("globex", 2023))
    decision = {"title": "Joined Acme", "actor_entity": "person:ann", "steps": [ACME]}
    [dec] = run(g.insert.facts({"decisions": [decision]}, contradiction="off")).decisions
    assert [(s.relation_id, s.to_entity) for s in dec.steps] == [(ACME, "company:acme")]
    created = run(g.decisions.create("Left Acme", steps=[ACME, GLOBEX], actor_entity="person:ann"))
    assert [s.relation_id for s in created.steps] == [ACME, GLOBEX]
    with pytest.raises(ValidationError, match="decision step references unknown relation 'relation:ghost'"):
        run(g.insert.facts({"decisions": [{**decision, "steps": ["relation:ghost"]}]}))
    with pytest.raises(ValidationError, match="decision step references unknown relation 'relation:ghost'"):
        run(g.decisions.create("Joined Acme", steps=["relation:ghost"], actor_entity="person:ann"))


def test_reads_and_updates_of_a_retired_relation_name_who_retired_it(capsys):
    g = graph()
    insert(g, works_at("acme", 2020))
    insert(g, works_at("globex", 2023), contradiction="supersede")
    assert run(g.relations.get(ACME)) is None
    why = f"relation {ACME} was invalidated by {GLOBEX} at 2023-01-01T00:00:00Z; use relation versions"
    with pytest.raises(NotFoundError, match=re.escape(why)):
        cli(g, ["relation", "get", ACME], capsys)
    expected = f"relation {ACME} was invalidated by {GLOBEX} at 2023-01-01T00:00:00Z; create it again"
    with pytest.raises(ValidationError, match=re.escape(expected)):
        run(g.relations.update(ACME, set_properties={"x": 1}))
    with pytest.raises(NotFoundError, match="'relation:ghost' does not exist"):
        cli(g, ["relation", "get", "relation:ghost"], capsys)
    with pytest.raises(NotFoundError, match="'relation:ghost' does not exist"):
        cli(g, ["relation", "versions", "relation:ghost"], capsys)
    with pytest.raises(NotFoundError, match="'preference:ghost' does not exist"):
        run(g.preferences.versions("preference:ghost"))
    with mcp_session("contra-get", schema=SPEC, contradiction="supersede") as srv:
        run(srv.insert_facts({"entities": PEOPLE, "relations": [works_at("acme", 2020), works_at("globex", 2023)]}))
        with pytest.raises(NotFoundError, match=re.escape(f"relation {ACME} was invalidated by {GLOBEX}")):
            run(srv.get_relation(ACME))
        assert run(srv.get_relation("relation:ghost")) is None
        for versions, ghost in (
            (srv.relation_versions, "relation:ghost"),
            (srv.preference_versions, "preference:ghost"),
        ):
            with pytest.raises(NotFoundError, match="does not exist"):
                run(versions(ghost))
        created = run(srv.create_relation("person:ann", "WORKS_AT", "company:initech"))
        assert [r["id"] for r in run(srv.list_relations())["items"]] == [created["id"]]
    assert run(g.relations.delete(ACME)).deleted_relation_versions == 1
    with pytest.raises(NotFoundError, match="does not exist"):
        run(g.relations.versions(ACME))


def test_strict_schema_rejects_a_max_count_conflict_unless_superseding_or_off():
    g = graph(schema_mode="strict")
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    with pytest.raises(ValidationError, match="would exceed max_count 1 for WORKS_AT at from entity person:ann"):
        run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    with pytest.raises(ValidationError, match=f"relation {GLOBEX} would exceed max_count 1"):
        insert(g, works_at("globex"))
    assert [r.id for r in run(g.relations.list()).items] == [ACME]
    g = graph(schema_mode="strict", contradiction="off")
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    run(g.relations.create("person:ann", "WORKS_AT", "company:globex"))
    assert insert(g, works_at("acme"), works_at("initech")).warnings == []
    assert len(run(g.relations.list()).items) == 3
    g = graph(schema_mode="strict", contradiction="supersede")
    with pytest.raises(ValidationError, match="above max 1"):
        insert(g, works_at("acme"), works_at("globex"))
    assert run(g.relations.list()).items == []
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    assert run(g.relations.create("person:ann", "WORKS_AT", "company:globex")).is_current
    insert(g, works_at("initech"))
    assert [r.to_entity for r in run(g.relations.list()).items] == ["company:initech"]


def test_within_batch_conflicts_survive_aliases_case_and_extraction():
    spec = {**SPEC, "entities": [{"name": "Person", "aliases": ["Human"]}, {"name": "Company"}]}
    variants = [
        [("Person", "Ann", "WORKS_AT"), ("Person", "Ann", "employed by")],
        [("Human", "Ann", "WORKS_AT"), ("Person", "Ann", "WORKS_AT")],
        [("person", "Ann", "works at"), ("PERSON", "Ann", "WORKS_AT")],
    ]
    for (t1, n1, r1), (t2, n2, r2) in variants:
        g = fresh_graph("contra", schema=spec)
        companies = [{"type": "Company", "name": "Acme"}, {"type": "Company", "name": "Globex"}]
        ents = [{"type": t1, "name": n1}, {"type": t2, "name": n2}, *companies]
        rels = [
            {"from_entity": ids.entity_id(t1, n1), "type": r1, "to_entity": "company:acme"},
            {"from_entity": ids.entity_id(t2, n2), "type": r2, "to_entity": "company:globex"},
        ]
        result = run(g.insert.facts({"entities": ents, "relations": rels}))
        assert [w.code for w in result.warnings] == ["contradiction"], (t1, t2)
    llm = extracting_llm(
        [("person", "Ann"), ("company", "Acme"), ("company", "Globex")],
        [("Ann", "works at", "Acme"), ("Ann", "WORKS_AT", "Globex")],
    )
    result = run(fresh_graph("contra", schema=spec, llm=llm).insert.text("Ann works at Acme and at Globex."))
    assert [w.code for w in result.warnings] == ["contradiction"]


def test_surface_variants_that_share_an_id_are_one_relation_not_a_conflict():
    g = fresh_graph("contra", schema=SPEC)
    ents = [
        {"type": "Person", "name": "Ann"},
        {"type": "Company", "name": "Acme Corp"},
        {"type": "Company", "name": "Acme Inc"},
    ]
    result = run(g.insert.facts({"entities": ents, "relations": [works_at("acme"), works_at("acme")]}))
    assert result.warnings == [] and {r.id for r in result.relations} == {ACME}


def test_a_child_type_with_the_same_name_is_a_different_entity_without_resolution():
    spec = {**SPEC, "entities": [*SPEC["entities"], {"name": "Manager", "parent": "Person"}]}
    ents = [*PEOPLE, {"type": "Manager", "name": "Ann"}]
    rels = [works_at("acme"), {**works_at("globex"), "from_entity": "manager:ann"}]
    exact = run(fresh_graph("contra", schema=spec).insert.facts({"entities": ents, "relations": rels}))
    assert exact.warnings == []
    g = fresh_graph("contra", schema=spec, resolver="default")
    run(g.insert.facts({"entities": PEOPLE, "relations": [works_at("acme")]}))
    merged = run(g.insert.facts({"entities": [{"type": "Manager", "name": "Ann"}], "relations": rels[1:]}))
    assert [w.code for w in merged.warnings] == ["entity_merged", "contradiction"]


def test_equal_effective_times_are_not_out_of_order():
    at = utc(2024)
    g = graph(contradiction="supersede")
    insert(g, works_at("acme", 2024))
    result = insert(g, works_at("globex", 2024))
    assert [w.code for w in result.warnings] == ["relation_superseded"]
    assert result.relations[0].is_current
    g = graph(contradiction="supersede")
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time=at))
    assert run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time=at)).is_current
    g = graph(contradiction="supersede")
    first = run(g.relations.create("person:ann", "WORKS_AT", "company:acme"))
    later = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time=first.created_at))
    assert later.is_current and run(g.relations.get(ACME)) is None


def test_a_supersede_reinsert_enforces_the_cap_on_existing_duplicates():
    g = graph()
    insert(g, works_at("acme"))
    insert(g, works_at("globex"))
    assert {r.id for r in run(g.relations.list()).items} == {ACME, GLOBEX}
    res = insert(g, works_at("acme", properties={"r": 1}), contradiction="supersede")
    assert [w.code for w in res.warnings] == ["relation_superseded"]
    assert [r.id for r in run(g.relations.list()).items] == [ACME]


@pytest.mark.parametrize("order", [1, -1], ids=["input-order", "reversed"])
def test_a_supersede_rerun_keeps_the_newest_fact_and_warns_once(order):
    g = graph()
    rels = [works_at("acme", 2020), works_at("globex", 2021)][::order]
    insert(g, *rels)
    res = insert(g, *rels, contradiction="supersede")
    assert [w.code for w in res.warnings] == ["relation_superseded" if order == 1 else "contradiction_out_of_order"]
    assert [r.id for r in run(g.relations.list()).items] == [GLOBEX]
    [old] = run(g.relations.versions(ACME))
    assert (old.is_current, old.invalidated_by, old.invalidated_at) == (False, GLOBEX, utc(2021))


def test_a_retired_fact_is_invalidated_by_the_next_newer_one():
    rels = [works_at("acme", 2019), works_at("initech", 2020), works_at("globex", 2022)]
    initech = ids.relation_id("person:ann", "WORKS_AT", "company:initech")
    warned = graph()
    insert(warned, *rels)
    insert(warned, *rels, contradiction="supersede")
    late = graph(contradiction="supersede")
    for rel in (rels[1], rels[2], rels[0]):
        insert(late, rel)
    for g in (warned, late):
        acme, mid = (run(g.relations.versions(rid))[0] for rid in (ACME, initech))
        assert (acme.invalidated_by, acme.invalidated_at) == (initech, utc(2020))
        assert (mid.invalidated_by, mid.invalidated_at) == (GLOBEX, utc(2022))

        def valid(year, month=1, g=g):
            return {r.id for r in run(g.retrieve("Ann", as_of=utc(year, month))).subgraph.relations}

        assert (valid(2019, 6), valid(2020, 6), valid(2023)) == ({ACME}, {initech}, {GLOBEX})
