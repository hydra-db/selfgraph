import asyncio
from collections.abc import Awaitable

import pytest
from helpers import (
    AUTO_COMMIT,
    HYDRADB,
    KUZU,
    create_entities,
    employment_graph,
    fresh_graph,
    interrupt_write,
    new_graph,
    run,
    utc,
    works_at,
)

from selfgraph import ConflictError, KuzuStore, NotFoundError, Relation, SelfGraph, StoreError, TransientError


def seed(g):
    create_entities(g, "Person:Soham", "Company:HydraDB")


@pytest.mark.skipif(not KUZU, reason="fixed-size embedded buffer pool")
def test_relation_updates_fit_in_the_kuzu_buffer_pool(tmp_path):
    async def check():
        async with SelfGraph(KuzuStore(str(tmp_path / "graph.kuzu"), buffer_pool_size=64 * 1024**2)) as graph:
            await graph.insert.facts(
                {"entities": [{"type": "Person", "name": "Ann"}, {"type": "Company", "name": "Acme"}]}
            )
            relation = await graph.relations.create("person:ann", "WORKS_AT", "company:acme")
            for step in range(1, 513):
                await graph.relations.update(relation.id, set_properties={"step": step})
            history = await graph.relations.versions(relation.id, newest_first=False)
            assert [version.properties.get("step", 0) for version in history] == list(range(513))
            assert [version.revision for version in history if version.is_current] == [513]

    asyncio.run(check())


def test_create_and_versions():
    g = new_graph()
    seed(g)
    r = run(
        g.relations.create(
            "person:soham", "WORKS_AT", "company:hydradb", properties={"role": "Founder"}, event_time=utc(2026, 1, 10)
        )
    )
    assert r.revision == 1 and r.is_current
    assert r.from_entity == "person:soham" and r.to_entity == "company:hydradb"
    assert r.type == "WORKS_AT"
    assert r.event_time == utc(2026, 1, 10)

    r2 = run(g.relations.update(r.id, set_properties={"role": "CEO"}, event_time=utc(2026, 6, 1)))
    assert r2.revision == 2 and r2.is_current
    assert r2.properties == {"role": "CEO"}

    current = run(g.relations.get(r.id))
    assert current.revision == 2

    history = run(g.relations.versions(r.id))
    assert [v.revision for v in history] == [2, 1]
    assert history[-1].is_current is False
    oldest_first = run(g.relations.versions(r.id, newest_first=False))
    assert [v.revision for v in oldest_first] == [1, 2]


def test_relation_versions_distinguish_json_booleans_from_numbers():
    g = new_graph()
    seed(g)
    r = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", properties={"flags": [1]}))

    run(g.relations.update(r.id, set_properties={"flags": [1.0]}))
    run(g.relations.update(r.id, set_properties={"flags": [True]}))
    run(g.relations.update(r.id, set_properties={"flags": [True]}))
    latest, first = run(g.relations.versions(r.id))
    assert latest.revision == 2 and latest.properties["flags"][0] is True
    assert type(first.properties["flags"][0]) is int


def test_remove_properties_in_update():
    g = new_graph()
    seed(g)
    r = run(
        g.relations.create(
            "person:soham", "WORKS_AT", "company:hydradb", properties={"role": "Founder", "team": "core"}
        )
    )
    r2 = run(g.relations.update(r.id, remove_properties=["team"]))
    assert r2.properties == {"role": "Founder"}


def test_create_conflict_and_update_of_a_missing_relation():
    g = new_graph()
    seed(g)
    run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", id="relation:x"))
    with pytest.raises(ConflictError):
        run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", id="relation:x"))
    with pytest.raises(NotFoundError):
        run(g.relations.update("relation:nope", set_properties={"a": 1}))


def test_list_filters():
    g = new_graph()
    seed(g)
    create_entities(g, "Company:Neo4j")
    run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    run(g.relations.create("person:soham", "LIKES", "company:neo4j"))

    by_type = run(g.relations.list(type="WORKS_AT"))
    assert len(by_type.items) == 1 and by_type.items[0].type == "WORKS_AT"

    by_to = run(g.relations.list(to_entity="company:neo4j"))
    assert len(by_to.items) == 1 and by_to.items[0].to_entity == "company:neo4j"

    by_from = run(g.relations.list(from_entity="person:soham"))
    assert len(by_from.items) == 2


def test_a_type_with_a_digit_before_a_letter_reads_back_and_reinserts():
    g = new_graph()
    create_entities(g, "Thing:App", "Thing:Cluster")
    rel = run(g.relations.create("thing:app", "uses k8s", "thing:cluster"))
    assert rel.type == "USES_K8_S"
    assert [r.id for r in run(g.relations.list(type=rel.type)).items] == [rel.id]
    facts = {"relations": [{"from_entity": "thing:app", "type": "uses k8s", "to_entity": "thing:cluster"}]}
    assert [r.id for r in run(g.insert.facts(facts)).relations] == [rel.id]


def test_multiple_relations_same_endpoints():
    g = new_graph()
    seed(g)
    r1 = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    r2 = run(g.relations.create("person:soham", "FOUNDED", "company:hydradb"))
    assert r1.id != r2.id
    both = run(g.relations.list(from_entity="person:soham"))
    assert {x.type for x in both.items} == {"WORKS_AT", "FOUNDED"}


def test_the_type_filter_follows_schema_relation_aliases():
    schema = {
        "entities": [{"name": "Person"}, {"name": "Company"}],
        "relations": [
            {"type": "WORKS_AT", "aliases": ["employed_by", "works at"]},
            {"type": "LIKES", "aliases": ["fond of"]},
        ],
    }
    g = fresh_graph("rel", schema=schema)
    seed(g)
    create_entities(g, "Company:Neo4j")
    r1 = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    run(g.relations.create("person:soham", "LIKES", "company:neo4j"))

    for alias in ("employed_by", "works at", "WORKS_AT", "EMPLOYED_BY"):
        res = run(g.relations.list(type=alias))
        assert [r.id for r in res.items] == [r1.id]

    async def collect():
        return [r.id async for r in g.relations.iterate(type="employed_by")]

    assert run(collect()) == [r1.id]


def test_whole_number_floats_are_stored_and_read_as_ints_like_typescript():
    g = new_graph()
    create_entities(g, "Person:Ann", "Company:Acme")
    props = {"weight": 2.0, "ratio": 0.5, "zero": -0.0, "big": 1e16, "nested": {"level": 3.0, "list": [1.0, 1.5]}}
    created = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", properties=props))
    expected = {"weight": 2, "ratio": 0.5, "zero": -0.0, "big": 1e16, "nested": {"level": 3, "list": [1, 1.5]}}
    for rel in (created, run(g.relations.get(created.id))):
        assert rel.properties == expected
        assert type(rel.properties["weight"]) is int and type(rel.properties["nested"]["list"][0]) is int
        assert type(rel.properties["zero"]) is float and type(rel.properties["big"]) is float
    assert "weight=2," in run(g.retrieve("Ann")).context
    assert run(g.relations.update(created.id, set_properties={"weight": 2})).revision == created.revision
    facts = {
        "entities": [{"type": "Person", "name": "Bo", "properties": {"age": 30.0}}],
        "preferences": [
            {
                "subject_entity": "person:ann",
                "key": "employer",
                "value_entity": "company:acme",
                "properties": {"n": 1.0},
            }
        ],
    }
    run(g.insert.facts(facts))
    assert type(run(g.entities.get("person:bo")).properties["age"]) is int
    assert type(run(g.preferences.list("person:ann")).items[0].properties["n"]) is int


@pytest.mark.skipif(not HYDRADB, reason="the Bolt message limit is HydraDB's")
def test_an_update_over_the_hydradb_message_limit_keeps_the_current_version():
    g = new_graph()
    seed(g)
    rel = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb"))
    with pytest.raises(StoreError, match="Bolt message"):
        run(g.relations.update(rel.id, set_properties={"blob": "x" * 1_100_000}))
    current = run(g.relations.get(rel.id))
    assert (current.revision, current.properties) == (1, {})


@pytest.mark.skipif(not HYDRADB, reason="the Bolt message limit is HydraDB's")
def test_an_update_whose_edge_row_is_over_the_hydradb_limit_keeps_the_current_version():
    g = new_graph()
    seed(g)
    rel = run(g.relations.create("person:soham", "LINKS_" + "X" * 20_000, "company:hydradb"))
    with pytest.raises(StoreError, match="Bolt message"):
        run(g.relations.update(rel.id, set_properties={"blob": "x" * 1_010_000}))
    current = run(g.relations.get(rel.id))
    assert (current.revision, current.properties) == (1, {})


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({"set_properties": {"role": "manager"}}, {"role": "manager"}),
        ({"set_properties": {"role": "engineer"}}, {"role": "engineer"}),
        ({"set_properties": {"team": "core"}}, {"role": "engineer", "team": "core"}),
        ({"remove_properties": ["role"]}, {}),
    ],
)
def test_an_update_completes_a_relation_an_interrupted_update_left_without_a_current_version(
    monkeypatch, changes, expected
):
    g = fresh_graph("interrupted-update")
    seed(g)
    rel = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", properties={"role": "engineer"}))
    interrupt_write(g, g.relations.update(rel.id, set_properties={"role": "cto"}), monkeypatch)
    assert run(g.relations.get(rel.id)) is None
    assert [(v.revision, v.is_current) for v in run(g.relations.versions(rel.id))] == [(1, False)]

    updated = run(g.relations.update(rel.id, **changes))

    assert (updated.revision, updated.is_current, updated.properties) == (2, True, expected)
    assert run(g.relations.get(rel.id)) == updated
    history = run(g.relations.versions(rel.id))
    assert [(v.revision, v.is_current, v.properties) for v in history] == [
        (2, True, expected),
        (1, False, {"role": "engineer"}),
    ]
    assert [r.id for r in run(g.relations.list(from_entity="person:soham")).items] == [rel.id]


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
@pytest.mark.parametrize("by", ["update", "insert", "recovery"])
def test_an_update_waits_for_a_write_still_running_in_its_transaction_and_completes_it_once_interrupted(
    monkeypatch, by
):
    monkeypatch.setattr("selfgraph.client._TX_RETRY_BASE_DELAY", 0)
    g = fresh_graph("live-write")
    seed(g)
    rel = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", properties={"role": "engineer"}))
    ends = rel.model_dump(include={"from_entity", "type", "to_entity"})
    if by == "recovery":
        interrupt_write(g, g.relations.update(rel.id, set_properties={"role": "lead"}), monkeypatch)
    write = (
        g.insert.facts({"relations": [{**ends, "properties": {"role": "cto"}}]})
        if by == "insert"
        else g.relations.update(rel.id, set_properties={"role": "cto"})
    )

    async def concurrent() -> None:
        with pytest.raises(TransientError) as caught:
            await g.relations.update(rel.id, set_properties={"team": "core"})
        assert "concurrent write" in str(caught.value.__cause__)
        with pytest.raises(TransientError) as caught:
            await g.insert.facts({"relations": [{**ends, "properties": {"team": "core"}}]})
        assert "concurrent write" in str(caught.value.__cause__)
        assert [(v.revision, v.is_current) for v in await g.relations.versions(rel.id)] == [(1, False)]

    interrupt_write(
        g, write, monkeypatch, method="create_edges" if by == "insert" else "create_edge", while_stuck=concurrent
    )
    updated = run(g.relations.update(rel.id, set_properties={"team": "core"}))

    assert (updated.revision, updated.is_current, updated.properties) == (2, True, {"role": "engineer", "team": "core"})
    assert [(v.revision, v.is_current) for v in run(g.relations.versions(rel.id))] == [(2, True), (1, False)]


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
def test_the_first_of_two_updates_of_a_relation_left_without_a_current_version_completes_it(monkeypatch):
    g = fresh_graph("first-recoverer")
    seed(g)
    rel = run(g.relations.create("person:soham", "WORKS_AT", "company:hydradb", properties={"role": "engineer"}))
    interrupt_write(g, g.relations.update(rel.id, set_properties={"role": "cto"}), monkeypatch)
    go: list[asyncio.Event] = []
    original = g.store.lock_node

    async def gated(*args: object) -> None:
        if len(go) < 2:
            go.append(asyncio.Event())
            await go[-1].wait()
        await original(*args)

    async def holding(update: Awaitable[Relation], held: int) -> asyncio.Future:
        task = asyncio.ensure_future(update)
        while len(go) < held and not task.done():
            await asyncio.sleep(0.01)
        assert not task.done(), task.exception()
        return task

    async def two_updates() -> tuple:
        async with g.store.transaction():
            first = await holding(g.relations.update(rel.id, set_properties={"team": "core"}), 1)
            second = await holding(g.relations.update(rel.id, set_properties={"level": 3}), 2)
            go[0].set()
            done = await first
            go[1].set()
            return done, await second

    monkeypatch.setattr(g.store, "lock_node", gated)
    first, second = run(two_updates())

    assert (first.revision, first.properties) == (2, {"role": "engineer", "team": "core"})
    assert (second.revision, second.properties) == (3, {"role": "engineer", "team": "core", "level": 3})
    history = run(g.relations.versions(rel.id))
    assert [(v.revision, v.is_current) for v in history] == [(3, True), (2, False), (1, False)]


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
@pytest.mark.parametrize(
    ("contradiction", "properties", "expected"),
    [
        ("off", {"team": "core"}, {"role": "eng", "team": "core"}),
        ("supersede", {"role": "eng"}, {"role": "eng"}),
    ],
)
def test_an_insert_completes_a_relation_an_interrupted_update_left_without_a_current_version(
    monkeypatch, contradiction, properties, expected
):
    g = employment_graph("interrupted-insert", contradiction=contradiction)
    [rel] = run(g.insert.facts({"relations": [works_at("acme", 2024, properties={"role": "eng"})]})).relations
    interrupt_write(g, g.relations.update(rel.id, set_properties={"role": "cto"}), monkeypatch)

    [inserted] = run(g.insert.facts({"relations": [works_at("acme", properties=properties)]})).relations

    assert (inserted.revision, inserted.is_current, inserted.properties) == (2, True, expected)
    assert inserted.event_time == utc(2024)
    assert run(g.relations.get(rel.id)) == inserted
    assert [(v.revision, v.is_current) for v in run(g.relations.versions(rel.id))] == [(2, True), (1, False)]


@pytest.mark.skipif(not AUTO_COMMIT, reason="only an auto-commit store leaves the gap between retire and create")
def test_an_update_of_a_certified_relation_left_without_a_current_version_settles_its_endpoints_again(monkeypatch):
    g = employment_graph("interrupted-certified", contradiction="supersede")
    old = run(g.insert.facts({"relations": [works_at("acme", 2024)]})).relations[0]
    run(g.relations.certify(old.id, by="hr"))
    newer = run(g.insert.facts({"relations": [works_at("globex", 2025)]})).relations[0]
    interrupt_write(g, g.relations.update(old.id, set_properties={"role": "cto"}), monkeypatch)
    assert run(g.relations.get(old.id)) is None

    updated = run(g.relations.update(old.id, set_properties={"role": "cto"}))

    assert (updated.revision, updated.is_current, updated.invalidated_by) == (2, False, newer.id)
    assert (updated.certified_at, updated.certified_by, updated.certifications) == (None, None, [])
    assert [r.id for r in run(g.relations.list(from_entity="person:ann")).items] == [newer.id]
    [second, first] = run(g.relations.versions(old.id))
    assert (first.revision, first.is_current, first.certified_at) == (1, False, None)
    assert [(c.by, c.until is not None) for c in first.certifications] == [("hr", True)]
    assert second.properties == {"role": "cto"}
