import sys
import unicodedata

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


@pytest.mark.parametrize(
    ("raw", "canonical"),
    [
        (" Person : Jane  Doe ", "person:jane-doe"),
        ("Person:Cafe\u0301", "person:café"),
        (" Doc : V1.2 ", "doc:v1.2"),
    ],
)
def test_fact_id_helpers_canonicalize_entity_references(raw, canonical):
    assert ids.relation_id(raw, "worksAt", raw) == ids.relation_id(canonical, "WORKS_AT", canonical)
    assert ids.preference_id(raw, "preference", "k", raw) == ids.preference_id(canonical, "preference", "k", canonical)
    assert ids.decision_id(raw, "Pick") == ids.decision_id(canonical, "Pick")
    assert ids.profile_id(raw) == ids.profile_id(canonical)


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


def test_a_normalized_relation_type_normalizes_to_itself():
    assert ids.normalize_rel_type("uses k8s") == ids.normalize_rel_type("USES_K8S") == "USES_K8_S"
    assert ids.normalize_rel_type("has 3d model") == "HAS_3_D_MODEL"
    assert ids.normalize_rel_type("Has2FA") == "HAS2_FA"
    for raw in ["uses k8s", "has 2fa", "isPartOf2Things", "x2ß", "ß\u0307", "56İ", "OAuth2Token", "élève de"]:
        once = ids.normalize_rel_type(raw)
        assert ids.normalize_rel_type(once) == once, raw
        assert ids.relation_id("a:b", raw, "c:d") == ids.relation_id("a:b", once, "c:d")


def test_combining_marks_stay_in_derived_ids():
    names = ["राम", "रीमा", "रोम", "กิน", "กัน", "কাল", "কুল", "கவி", "கவு", "דָּוִד", "דּוֹד"]
    derived = [ids.entity_id("Person", name) for name in names]
    assert derived == [f"person:{name}" for name in names]
    assert ids.entity_id("City", "दिल्ली, भारत") == "city:दिल्ली-भारत"
    assert ids.entity_id("Company", "टाटा लिमिटेड Ltd") == "company:टाटा-लिमिटेड"
    assert ids.normalize_rel_type("पिता") == "पिता" != ids.normalize_rel_type("पोता")
    assert ids.normalize_rel_type("काम करता है!") == "काम_करता_है"
    assert ids.relation_id("a:b", "पिता", "c:d") != ids.relation_id("a:b", "पोता", "c:d")


@pytest.mark.parametrize(
    ("type", "name"),
    [
        ("Person", "İ\u0327"),
        ("İ\u0327", "Ada"),
        ("Company", "İ\u0327stanbul Holdings Ltd"),
    ],
)
def test_a_derived_id_with_a_lowercased_dotted_capital_i_canonicalizes_to_itself(type, name):
    eid = ids.entity_id(type, name)
    assert unicodedata.is_normalized("NFC", eid)
    assert ids.canonical_entity_id(eid) == eid
    assert ids.canonical_entity_id(eid.upper()) == eid
    assert ids.slug(ids.slug(type)) == ids.slug(type)


def test_names_without_combining_marks_keep_their_ids():
    assert ids.entity_id("Person", "Zoe\u0308 A\u030angstro\u0308m") == ids.entity_id("Person", "Zoë Ångström")
    assert ids.entity_id("Person", "Bob \U0001f600") == "person:bob"
    assert ids.entity_id("Person", "Bob \u2764\ufe0f") == "person:bob"
    assert ids.entity_id("Thing", "1\ufe0f\u20e3 first") == "thing:1-first"
    assert ids.entity_id("Language", "C++") == "language:c"
    assert ids.entity_id("Company", "Acme, Inc.") == "company:acme"
    assert ids.normalize_rel_type("Works-At!!") == "WORKS_AT"


def test_combining_marks_follow_one_pinned_table():
    assert [ids._is_mark(ch) for ch in "\u093e\u0301\u0e34\U0001e94a"] == [True] * 4
    assert [ids._is_mark(ch) for ch in "a \ufe0f\u20e3\U000e0100\u200d"] == [False] * 6
    assert ids.entity_id("Person", "\u0628\u0898\u062a") == "person:\u0628\u0898\u062a"
    assert ids.entity_id("Person", "\u0628\u0897\u062a") == "person:\u0628-\u062a"
    if unicodedata.unidata_version != "15.0.0":
        pytest.skip("the table is checked against the Unicode 15.0 data of Python 3.12")
    marks = {
        cp
        for cp in range(sys.maxunicode + 1)
        if unicodedata.category(chr(cp)) in ("Mn", "Mc") and not (0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF)
    }
    assert {cp for cp in range(sys.maxunicode + 1) if ids._is_mark(chr(cp))} == marks


def test_format_characters_inside_a_name_do_not_split_it():
    names = ["Ac\u200bme", "Ac\u200dme", "Ac\u00adme", "Ac\u2060me", "Ac\ufeffme", "\ufeffAcme", "Acme\u200f"]
    assert [ids.entity_id("Person", name) for name in names] == ["person:acme"] * len(names)
    assert ids.entity_id("Company", "Acme\u200b Inc\u00ad.") == "company:acme"
    assert ids.entity_id("Person", "Jane\u200b Doe") == "person:jane-doe"


def test_format_characters_follow_one_pinned_table():
    assert [ids._FORMAT.match(ch) is not None for ch in "\u00ad\u200b\u2060\ufeff\U000e0001"] == [True] * 5
    assert [ids._FORMAT.match(ch) is not None for ch in "a \u0301\ufe0f\u3000"] == [False] * 5
    if unicodedata.unidata_version != "15.0.0":
        pytest.skip("the table is checked against the Unicode 15.0 data of Python 3.12")
    formats = {cp for cp in range(sys.maxunicode + 1) if unicodedata.category(chr(cp)) == "Cf"}
    assert {cp for cp in range(sys.maxunicode + 1) if ids._FORMAT.match(chr(cp))} == formats


def test_require_identifier_accepts_plain_identifiers():
    for name in ("id", "sid", "index", "external_ids", "name", "k_Entity_1"):
        assert ids.require_identifier(name) == name


def test_require_identifier_rejects_injection_and_non_identifiers():
    for bad in ("id` RETURN 1 //", "a`b", "a b", "1name", "na.me", "", "n`) DETACH DELETE (m"):
        with pytest.raises(ValidationError):
            ids.require_identifier(bad)


@pytest.mark.parametrize("bad_type", [":a", "a:b", "Person:"])
def test_entity_type_colons_rejected(bad_type):
    with pytest.raises(ValidationError) as caught:
        ids.entity_id(bad_type, "X")
    assert caught.value.code == "invalid_argument"
    assert caught.value.field == "type"
    assert (
        str(caught.value)
        == f"entity type {bad_type!r} cannot contain ':', which separates an entity id's type and name"
    )
