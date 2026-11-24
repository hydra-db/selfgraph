from __future__ import annotations

import asyncio

import pytest
from helpers import FALKORDB, HYDRADB, KUZU, fresh_graph, run

from selfgraph import ValidationError

SERVER_CYPHER = not (HYDRADB or KUZU or FALKORDB)
concurrent_only = pytest.mark.skipif(
    not SERVER_CYPHER, reason="only a server Cypher store runs write transactions concurrently"
)

TO_CAP = {
    "entities": [{"name": "Person"}, {"name": "Company"}],
    "relations": [{"type": "WORKS_AT", "to": {"types": ["Company"], "max_count": 1}}],
}
FROM_CAP = {
    "entities": [{"name": "Person"}, {"name": "Company"}],
    "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"], "max_count": 1}}],
}
BOTH_CAP = {
    "entities": [{"name": "Person"}, {"name": "Company"}],
    "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"], "max_count": 1}, "to": {"max_count": 1}}],
}

PEOPLE = [f"person:p{i}" for i in range(4)]


def _seed(schema: dict, prefix: str, **kwargs):
    g = fresh_graph(prefix, schema=schema, **{"contradiction": "supersede", **kwargs})
    run(
        g.insert.facts(
            {
                "entities": [
                    {"type": "Company", "name": "Acme", "id": "company:acme"},
                    *({"type": "Person", "name": f"P{i}", "id": PEOPLE[i]} for i in range(len(PEOPLE))),
                ]
            }
        )
    )
    return g


def _current_into(g, target: str) -> list[str]:
    return [r.id for r in run(g.relations.list()).items if r.to_entity == target]


def _current_from(g, source: str) -> list[str]:
    return [r.id for r in run(g.relations.list()).items if r.from_entity == source]


@concurrent_only
def test_to_side_max_count_holds_under_concurrent_supersede():
    g = _seed(TO_CAP, "to-supersede")

    async def writers():
        return await asyncio.gather(
            *(g.relations.create(p, "WORKS_AT", "company:acme", id=f"relation:{i}") for i, p in enumerate(PEOPLE)),
            return_exceptions=True,
        )

    run(writers())
    current = _current_into(g, "company:acme")
    assert len(current) == 1, f"to-side max_count 1 left {current} current under concurrent supersede"
    run(g.close())


@concurrent_only
def test_to_side_max_count_rejects_surplus_under_concurrent_strict():
    g = _seed(TO_CAP, "to-strict", contradiction="warn", schema_mode="strict")

    async def writers():
        return await asyncio.gather(
            *(g.relations.create(p, "WORKS_AT", "company:acme", id=f"relation:{i}") for i, p in enumerate(PEOPLE)),
            return_exceptions=True,
        )

    results = run(writers())
    ok = [r for r in results if not isinstance(r, Exception)]
    rejected = [r for r in results if isinstance(r, Exception)]
    current = _current_into(g, "company:acme")
    assert len(current) == 1, f"to-side max_count 1 left {current} current under concurrent strict"
    assert len(ok) == 1, f"strict mode let {len(ok)} writers succeed at a max_count 1 target"
    assert rejected and all(isinstance(r, ValidationError) for r in rejected), rejected
    run(g.close())


@concurrent_only
def test_to_side_max_count_holds_under_concurrent_insert_facts():
    g = _seed(TO_CAP, "to-insert")

    async def writers():
        return await asyncio.gather(
            *(
                g.insert.facts({"relations": [{"from_entity": p, "type": "WORKS_AT", "to_entity": "company:acme"}]})
                for p in PEOPLE
            ),
            return_exceptions=True,
        )

    run(writers())
    current = _current_into(g, "company:acme")
    assert len(current) == 1, f"to-side max_count 1 left {current} current under concurrent insert.facts"
    run(g.close())


@concurrent_only
def test_from_side_max_count_holds_under_concurrent_supersede():
    g = _seed(FROM_CAP, "from-supersede")
    companies = [f"company:c{i}" for i in range(4)]
    run(g.insert.facts({"entities": [{"type": "Company", "name": f"C{i}", "id": c} for i, c in enumerate(companies)]}))

    async def writers():
        return await asyncio.gather(
            *(g.relations.create("person:p0", "WORKS_AT", c, id=f"relation:{i}") for i, c in enumerate(companies)),
            return_exceptions=True,
        )

    run(writers())
    current = _current_from(g, "person:p0")
    assert len(current) == 1, f"from-side max_count 1 left {current} current under concurrent supersede"
    run(g.close())


@concurrent_only
def test_both_endpoints_capped_hold_under_concurrent_supersede():
    g = _seed(BOTH_CAP, "both-supersede")

    async def writers():
        return await asyncio.gather(
            *(g.relations.create(p, "WORKS_AT", "company:acme", id=f"relation:{i}") for i, p in enumerate(PEOPLE)),
            return_exceptions=True,
        )

    run(writers())
    current = _current_into(g, "company:acme")
    assert len(current) == 1, f"to-side of a both-capped relation left {current} current"
    run(g.close())
