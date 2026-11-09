import re

import pytest
from helpers import create_entities, fresh_graph, new_graph, run, utc

from selfgraph import ConflictError, NotFoundError, ValidationError
from selfgraph.resources._common import encode_cursor


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
    with pytest.raises(NotFoundError):
        run(g.entities.update(e.id, name="Y"))
    with pytest.raises(NotFoundError):
        run(g.entities.delete(e.id))


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


def test_update_rejects_unknown_options_and_type_changes_but_keeps_a_case_only_type():
    g = fresh_graph("ent")
    run(g.entities.create("Jane Doe", "Person"))
    with pytest.raises(
        ValidationError, match=r"^unknown option 'nmae' for entities.update; did you mean 'name'\? \(valid options: "
    ):
        run(g.entities.update("person:jane-doe", nmae="Jane"))
    with pytest.raises(ValidationError, match=r"^type is part of the id 'person:jane-doe'; create a new entity"):
        run(g.entities.update("person:jane-doe", type="Human"))
    assert run(g.entities.update("person:jane-doe", type="person")).type == "Person"
    assert run(g.entities.update("person:jane-doe", type=" PERSON ")).type == "Person"
    run(g.entities.create("Bob", "person"))
    s = new_graph(namespace=g.namespace, schema={"entities": [{"name": "Person"}]})
    assert run(s.entities.update("person:bob", type="PERSON")).type == "Person"


def test_explicit_ids_are_canonical_on_every_input_path():
    g = new_graph()
    t = run(g.entities.create("X", "T", id="T:X"))
    assert t.id == "t:x"
    with pytest.raises(ConflictError):
        run(g.entities.create("X", "T", id="t:X"))
    assert run(g.entities.get("T:x")).id == "t:x"
    assert run(g.entities.update("T:X", properties={"k": 1})).properties == {"k": 1}
    assert run(g.entities.evidence("T:X")).items == []
    assert run(g.entities.merges("T:X")).items == []
    run(g.entities.create("Y", "T", id="t:y"))
    rel = run(g.relations.create("T:X", "KNOWS", "T:Y"))
    assert (rel.from_entity, rel.to_entity) == ("t:x", "t:y")
    assert [r.id for r in run(g.relations.list(from_entity="T:X")).items] == [rel.id]
    pref = run(g.preferences.create("T:X", "likes", "T:Y", about_entity="T:Y"))
    assert (pref.subject_entity, pref.value_entity, pref.about_entity) == ("t:x", "t:y", "t:y")
    assert [p.id for p in run(g.preferences.list(subject_entity="T:X")).items] == [pref.id]
    dec = run(g.decisions.create("Pick", steps=[rel.id], actor_entity="T:X", alternative_entities=["T:Y"]))
    assert (dec.actor_entity, dec.alternative_entities) == ("t:x", ["t:y"])
    assert [d.id for d in run(g.decisions.list(actor_entity="T:X")).items] == [dec.id]
    res = run(
        g.insert.ontology(
            {
                "entities": [{"id": "Person:Jane Doe", "type": "Person", "name": "Jane Doe"}],
                "relations": [{"from_entity": "PERSON:Jane Doe", "type": "KNOWS", "to_entity": "T:X"}],
            }
        )
    )
    assert [e.id for e in res.entities] == ["person:jane-doe"]
    assert [(r.from_entity, r.to_entity) for r in res.relations] == [("person:jane-doe", "t:x")]
    assert run(g.entities.delete("T:X")).deleted_entities == 1
    assert run(g.entities.get("t:x")) is None


def test_property_values_and_keys_are_checked_and_null_clears_a_key():
    g = fresh_graph("ent")
    e = run(g.entities.create("Ann", "Person", properties={"m": 1, "gone": None}))
    assert e.properties == {"m": 1}
    e = run(g.entities.update(e.id, properties={"m": None, "n": 2}))
    assert e.properties == {"n": 2}
    run(g.entities.create("Acme", "Company"))
    rel = run(g.relations.create(e.id, "WORKS_AT", "company:acme", properties={"a": 1, "b": None}))
    assert rel.properties == {"a": 1}
    rel = run(g.relations.update(rel.id, set_properties={"a": None, "c": 3}))
    assert (rel.properties, rel.revision) == ({"c": 3}, 2)
    assert run(g.relations.update(rel.id, remove_properties=["x"])).revision == 2
    pref = run(g.preferences.create(e.id, "employer", "company:acme", properties={"x": 1, "y": None}))
    assert pref.properties == {"x": 1}
    assert run(g.preferences.update(pref.id, properties={"x": None})).properties == {}

    assert run(g.entities.create("Max", "Person", properties={"n": 2**53 - 1})).properties == {"n": 2**53 - 1}
    with pytest.raises(
        ValidationError, match=r"integer 9007199254740993 is outside the safe range; store it as a string"
    ):
        run(g.entities.create("Bob", "Person", properties={"n": 2**53 + 1}))
    with pytest.raises(ValidationError, match="outside the safe range"):
        run(g.entities.update("person:ann", properties={"deep": [-(2**60)]}))
    with pytest.raises(ValidationError, match="outside the safe range"):
        run(g.insert.text("Ann met Bob.", source_id="s", metadata={"n": 2**64}))
    with pytest.raises(ValidationError, match="cannot hold datetime values; use an ISO 8601 string"):
        run(g.entities.create("Cy", "Person", properties={"at": utc(2024)}))
    with pytest.raises(ValidationError, match="cannot hold datetime values"):
        run(g.relations.create("person:ann", "R", "person:ann", properties={"at": utc(2024)}))

    for bad in ({"": 1}, {"  ": 2}):
        with pytest.raises(ValidationError, match="properties keys cannot be empty or whitespace"):
            run(g.entities.create("A", "T", properties=bad))
    with pytest.raises(ValidationError, match="properties keys cannot be empty"):
        bad_rel = {"from_entity": e.id, "type": "R", "to_entity": e.id, "properties": {" ": 1}}
        run(g.insert.ontology({"relations": [bad_rel]}))
    with pytest.raises(ValidationError, match="set_properties keys cannot be empty"):
        run(g.relations.update(rel.id, set_properties={"": 1}))
    with pytest.raises(ValidationError, match="metadata keys cannot be empty"):
        run(g.insert.text("A met B.", source_id="s", metadata={" ": "x"}))
    assert run(g.entities.get(e.id)).properties == {"n": 2}


def test_entity_types_and_ids_are_validated():
    g = fresh_graph("ent")
    with pytest.raises(ValidationError, match="entity type 'Per:son' cannot contain ':'"):
        run(g.entities.create("A", "Per:son"))
    with pytest.raises(ValidationError, match="cannot contain ':'"):
        run(g.insert.ontology({"entities": [{"type": "Per:son", "name": "A"}]}))
    with pytest.raises(ValidationError, match="can only contain letters, digits, spaces"):
        run(g.entities.create("X", "bad type!"))
    with pytest.raises(ValidationError):
        run(g.entities.create("NoType", ""))
    assert run(g.entities.create("Zoë", "Café Owner_v2.1-b")).type == "Café Owner_v2.1-b"
    calls = (
        g.entities.get,
        g.entities.delete,
        g.entities.evidence,
        g.entities.merges,
        lambda eid: g.entities.update(eid, name="X"),
    )
    for call in calls:
        with pytest.raises(
            ValidationError, match=r"^entity id must be 'type:name', e.g. 'person:jane', got 'nocolon'$"
        ):
            run(call("nocolon"))


def test_the_type_filter_ignores_case_and_follows_schema_aliases():
    g = fresh_graph("ent")
    create_entities(g, "Person:Ann", "PERSON:Bob", "human:Cy", "Company:Acme")
    assert [e.id for e in run(g.entities.list(type="person")).items] == ["person:ann", "person:bob"]
    first = run(g.entities.list(type="pErSoN", limit=1))
    assert [e.id for e in first.items] == ["person:ann"]
    assert [e.id for e in run(g.entities.list(type="pErSoN", cursor=first.next_cursor, limit=1)).items] == [
        "person:bob"
    ]
    assert run(g.entities.list(type="Person", name="ann")).items == []
    schema = {"entities": [{"name": "Person", "aliases": ["Human"]}, {"name": "Company"}]}
    s = new_graph(namespace=g.namespace, schema=schema)
    expected = ["human:cy", "person:ann", "person:bob"]
    for given in ("person", "HUMAN"):
        assert [e.id for e in run(s.entities.list(type=given)).items] == expected


def test_an_explicit_id_must_carry_the_entity_type():
    g = fresh_graph("ent")
    message = "id 'company:x' does not match type 'Person' (expected prefix 'person:')"
    with pytest.raises(ValidationError, match=re.escape(message)):
        run(g.entities.create("X", "Person", id="company:x"))
    with pytest.raises(ValidationError, match=re.escape("id 'company:zzz' does not match type 'Person'")):
        run(g.insert.ontology({"entities": [{"id": "company:zzz", "type": "Person", "name": "Z"}]}))
    assert run(g.entities.create("X", "Big Co", id="Big Co:x")).id == "big-co:x"
    s = fresh_graph("ent", schema={"entities": [{"name": "Company", "aliases": ["org"]}]})
    assert run(s.entities.create("Acme", "org", id="company:acme")).type == "Company"
    assert run(s.entities.create("Beta", "Company", id="ORG:Beta")).id == "company:beta"
    result = run(
        s.insert.ontology(
            {
                "entities": [
                    {"id": "org:acme", "type": "org", "name": "Acme"},
                    {"id": "org:gamma", "type": "Company", "name": "Gamma"},
                ],
                "relations": [{"from_entity": "org:gamma", "type": "OWNS", "to_entity": "org:acme"}],
            }
        )
    )
    assert sorted(e.id for e in result.entities) == ["company:acme", "company:gamma"]
    assert result.relations[0].from_entity == "company:gamma" and result.relations[0].to_entity == "company:acme"
    with pytest.raises(ValidationError, match=re.escape("(expected prefix 'company:')")):
        run(s.insert.ontology({"entities": [{"id": "person:acme", "type": "org", "name": "Acme"}]}))
    with pytest.raises(ValidationError, match=re.escape("(expected prefix 'company:')")):
        run(s.entities.create("Acme", "org", id="person:acme"))


def test_aliases_are_trimmed_and_an_alias_equal_to_the_name_is_dropped():
    g = fresh_graph("ent")
    e = run(g.entities.create("Jane Doe", "Person", aliases=["jane doe", " JANE DOE ", "JD"]))
    assert e.aliases == ["JD"]
    assert run(g.entities.update(e.id, aliases=["Jane Doe", "Janie"])).aliases == ["JD", "Janie"]
    assert run(g.entities.update(e.id, name="JD")).aliases == ["Janie"]
    ent = run(g.entities.create("Ann", "Person", aliases=[" Other", "Other ", "\u0041nnie\u0301 ", "  ", " ann "]))
    assert ent.aliases == ["Other", "Annié"]
    assert run(g.entities.update(ent.id, aliases=[" More "], remove_aliases=[" Other "])).aliases == ["Annié", "More"]


@pytest.mark.parametrize("kind", ["entities", "relations", "preferences", "decisions"])
def test_iterate_survives_deletes_between_pages(kind):
    g = fresh_graph("ent")
    create_entities(g, *(f"T:{c}" for c in "abcdefg"), "Hub:Hub")
    for c in "abcdefg":
        if kind == "relations":
            run(g.relations.create("hub:hub", "LINKS", f"t:{c}"))
        elif kind == "preferences":
            run(g.preferences.create("hub:hub", f"k{c}", f"t:{c}"))
        elif kind == "decisions":
            run(g.decisions.create(f"Decide {c}"))
    resource = getattr(g, kind)

    async def drain():
        seen = []
        async for item in resource.iterate(limit=2):
            seen.append(item.id)
            if kind != "entities" or item.id.startswith("t:"):
                await resource.delete(item.id)
        return seen

    seen = run(drain())
    assert len(seen) == len(set(seen)) == (8 if kind == "entities" else 7)
    assert run(resource.list()).items == ([] if kind != "entities" else [run(g.entities.get("hub:hub"))])


def test_every_list_rejects_a_cursor_it_did_not_write():
    g = fresh_graph("cur")
    create_entities(g, "Person:Ann", "Person:Bob", "Person:Cy")
    rel = run(g.relations.create("person:ann", "KNOWS", "person:bob"))
    page = run(g.entities.list(limit=1))
    assert [e.id for e in run(g.entities.list(cursor=page.next_cursor)).items] == ["person:bob", "person:cy"]
    offset, decision_key = encode_cursor(1), encode_cursor("decision:x")
    lists = (
        (lambda c: g.entities.list(cursor=c), offset),
        (lambda c: g.entities.evidence("person:ann", cursor=c), page.next_cursor),
        (lambda c: g.entities.merges("person:ann", cursor=c), page.next_cursor),
        (lambda c: g.relations.list(cursor=c), decision_key),
        (lambda c: g.relations.evidence(rel.id, cursor=c), decision_key),
        (lambda c: g.decisions.list(cursor=c), page.next_cursor),
        (lambda c: g.preferences.list(cursor=c), decision_key),
    )
    for list_fn, foreign in lists:
        for bad in ("", "AAAA", "garbage", "MQ", "MQ==\n", "cGVyc29uOmFubg", foreign):
            with pytest.raises(ValidationError, match="^invalid cursor "):
                run(list_fn(bad))
