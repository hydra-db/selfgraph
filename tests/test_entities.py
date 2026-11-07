import pytest
from helpers import new_graph, run

from selfgraph import ConflictError, NotFoundError, ValidationError


def test_create_get_update_delete():
    g = new_graph()
    e = run(g.entities.create("HydraDB", "Company", id="company:hydradb"))
    assert e.id == "company:hydradb"
    assert e.name == "HydraDB" and e.type == "Company"
    assert e.created_at == e.updated_at

    got = run(g.entities.get("company:hydradb"))
    assert got.name == "HydraDB"

    updated = run(g.entities.update(e.id, aliases=["Hydra DB"], properties={"stage": "seed"}))
    assert updated.aliases == ["Hydra DB"]
    assert updated.properties == {"stage": "seed"}
    assert updated.updated_at >= updated.created_at

    dr = run(g.entities.delete(e.id))
    assert dr.deleted_entities == 1
    assert run(g.entities.get(e.id)) is None


def test_auto_id_derivation():
    g = new_graph()
    e = run(g.entities.create("Soham", "Person"))
    assert e.id == "person:soham"


def test_create_conflict():
    g = new_graph()
    run(g.entities.create("X", "Thing", id="thing:x"))
    with pytest.raises(ConflictError):
        run(g.entities.create("X", "Thing", id="thing:x"))


def test_get_unknown_returns_none():
    g = new_graph()
    assert run(g.entities.get("nope")) is None


def test_update_delete_unknown_raises():
    g = new_graph()
    with pytest.raises(NotFoundError):
        run(g.entities.update("nope", name="Y"))
    with pytest.raises(NotFoundError):
        run(g.entities.delete("nope"))


def test_list_filters_and_pagination():
    g = new_graph()
    for i in range(3):
        run(g.entities.create(f"P{i}", "Person", id=f"person:p{i}"))
    run(g.entities.create("Co", "Company", id="company:co"))

    page = run(g.entities.list(type="Person", limit=2))
    assert len(page.items) == 2
    assert page.next_cursor is not None
    page2 = run(g.entities.list(type="Person", cursor=page.next_cursor, limit=2))
    assert len(page2.items) == 1
    assert page2.next_cursor is None

    by_name = run(g.entities.list(name="Co"))
    assert [e.id for e in by_name.items] == ["company:co"]


def test_empty_type_is_rejected():
    g = new_graph()
    with pytest.raises(ValidationError):
        run(g.entities.create("NoType", ""))
