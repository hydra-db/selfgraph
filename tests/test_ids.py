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
    assert ids.relation_id("a", "bc", "x") != ids.relation_id("ab", "c", "x")


def test_preference_and_decision_ids():
    p = ids.preference_id("person:soham", "preference", "database", "company:hydradb")
    assert p.startswith("preference:")
    assert p != ids.preference_id("person:soham", "disinterest", "database", "company:hydradb")

    d = ids.decision_id("team:core", "Select db")
    assert d.startswith("decision:")
    assert d == ids.decision_id("team:core", "Select db")
    assert d != ids.decision_id(None, "Select db")
    with pytest.raises(ValidationError):
        ids.decision_id("", "t")


def test_quote_label():
    assert ids.quote_label("Person") == "Person"
    assert ids.quote_label("WORKS_AT") == "WORKS_AT"
    assert ids.quote_label("Graph Database") == "`Graph Database`"
    assert ids.quote_label("we`ird") == "`we``ird`"


def test_explicit_entity_ids_are_canonicalized_like_derived_ones():
    assert ids.canonical_entity_id("T:X") == "t:x"
    assert ids.canonical_entity_id(" Person : Jane  Doe ") == "person:jane-doe"
    assert ids.canonical_entity_id("Person:Café") == ids.entity_id("Person", "Café")
    assert ids.canonical_entity_id(ids.entity_id("Big Company", "Acme, Inc.")) == "big-company:acme-inc"
    assert ids.canonical_entity_id("doc:a:B") == "doc:a:b"
    for bad in ("jane", "person:", "person: ", ":x", None):
        with pytest.raises(ValidationError, match="entity id must"):
            ids.canonical_entity_id(bad)


def test_relation_types_split_camel_case():
    assert ids.normalize_rel_type("worksAt") == "WORKS_AT"
    assert ids.normalize_rel_type("WorksAt") == "WORKS_AT"
    assert ids.normalize_rel_type("HTTPServer") == "HTTP_SERVER"
    assert ids.normalize_rel_type("WORKS_AT") == "WORKS_AT"
    assert ids.normalize_rel_type("works at") == "WORKS_AT"
    assert ids.relation_id("a:b", "worksAt", "c:d") == ids.relation_id("a:b", "WORKS_AT", "c:d")
