import pytest

from selfgraph import ids
from selfgraph.errors import ValidationError


def test_entity_id_lowercases_and_hyphenates():
    assert ids.entity_id("Person", "Soham") == "person:soham"
    assert ids.entity_id("Company", "Hydra DB") == "company:hydra-db"
    assert ids.entity_id("Graph Database", "New  York") == "graph-database:new-york"


def test_derived_ids_are_deterministic():
    a = ids.relation_id("person:soham", "WORKS_AT", "company:hydradb")
    b = ids.relation_id("person:soham", "WORKS_AT", "company:hydradb")
    assert a == b
    assert a.startswith("relation:")
    assert a != ids.relation_id("company:hydradb", "WORKS_AT", "person:soham")


def test_preference_and_decision_ids():
    p = ids.preference_id("person:soham", "preference", "database", "company:hydradb")
    assert p.startswith("preference:")
    assert p != ids.preference_id("person:soham", "disinterest", "database", "company:hydradb")

    d = ids.decision_id("team:core", "Select db")
    assert d.startswith("decision:")
    assert d == ids.decision_id("team:core", "Select db")
    assert d != ids.decision_id(None, "Select db")


def test_hash_no_delimiter_collision():
    assert ids.relation_id("a", "bc", "x") != ids.relation_id("ab", "c", "x")


def test_quote_label():
    assert ids.quote_label("Person") == "Person"
    assert ids.quote_label("WORKS_AT") == "WORKS_AT"
    assert ids.quote_label("Graph Database") == "`Graph Database`"
    assert ids.quote_label("we`ird") == "`we``ird`"


def test_decision_id_rejects_empty_actor():
    assert ids.decision_id(None, "t")
    with pytest.raises(ValidationError):
        ids.decision_id("", "t")
