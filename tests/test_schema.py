import pytest
from helpers import (
    FakeLLM,
    fresh_graph,
    json_file,
    kuzu_main,
    mcp_session,
    new_graph,
    run,
    store_settings,
)

import selfgraph.mcp.server as srv
from selfgraph import EntityInput, Extraction, Schema, ValidationError, ids
from selfgraph.models import as_input, suggest_key
from selfgraph.runtime import build_graph, settings_from_env
from selfgraph.schema import as_schema, render_schema_catalog, validate_against_schema

TYPES_SPEC = {
    "entities": [
        {
            "name": "Thing",
            "properties": [
                {"name": "b", "type": "boolean"},
                {"name": "j", "type": "json"},
                {"name": "f", "type": "float"},
                {"name": "i", "type": "integer"},
                {"name": "s", "type": "string"},
            ],
        }
    ],
}

SPEC = {
    "name": "test",
    "entities": [
        {
            "name": "Person",
            "description": "a human",
            "aliases": ["user"],
            "properties": [{"name": "age", "type": "integer", "required": True}, {"name": "score", "type": "float"}],
        },
        {"name": "Manager", "parent": "Person"},
        {"name": "Company", "aliases": ["org"], "properties": [{"name": "founded", "type": "datetime"}]},
    ],
    "relations": [
        {
            "type": "WORKS_AT",
            "from": {"types": ["Person"], "max_count": 1},
            "to": {"types": ["Company"], "min_count": 1},
        },
        {"type": "KNOWS", "aliases": ["is friends with"], "from": {"types": ["Person"]}, "to": {"types": ["Person"]}},
    ],
}


def warnings(spec, facts):
    return validate_against_schema(Extraction.model_validate(facts), Schema.model_validate(spec))


def codes(spec, facts):
    return [w.code for w in warnings(spec, facts)]


def test_parse_fills_defaults_and_as_schema_passes_through():
    parsed = Schema.model_validate(SPEC)
    prop = parsed.entities[0].properties[0]
    assert (prop.name, prop.type, prop.required) == ("age", "integer", True)
    assert parsed.entities[1].parent == "Person"
    assert (parsed.relations[0].from_.types, parsed.relations[0].from_.max_count) == (["Person"], 1)
    assert as_schema(parsed) is parsed
    assert as_schema(SPEC) == parsed
    assert as_schema(None) is None


def _e(eid, type_, **props):
    return {"id": eid, "type": type_, "name": eid.split(":")[1].upper(), **({"properties": props} if props else {})}


def _o(*entities, rels=()):
    return {
        "entities": list(entities),
        "relations": [dict(zip(("from_entity", "type", "to_entity", "id"), rel, strict=False)) for rel in rels],
    }


PERSON_P = _e("person:p", "Person", age=1)
COMPANY_C = _e("company:c", "Company")
ANY_ENDS = {"entities": [{"name": "Person"}, {"name": "Company"}], "relations": [{"type": "RELATES_TO"}]}


@pytest.mark.parametrize(
    ("spec", "facts", "expected"),
    [
        (
            SPEC,
            _o(_e("manager:m", "Manager", age=30), _e("org:o", "org"), rels=[("manager:m", "works at", "org:o")]),
            [],
        ),
        (
            SPEC,
            _o(_e("person:p", "Person", score="high"), _e("company:c", "Company", founded=5)),
            ["missing_required_property", "property_type_mismatch", "property_type_mismatch"],
        ),
        (SPEC, _o(PERSON_P, rels=[("person:p", "LIKES", "person:p")]), ["unknown_relation_type"]),
        (SPEC, _o(COMPANY_C, rels=[("company:c", "WORKS_AT", "company:c")]), ["endpoint_type_violation"]),
        (
            SPEC,
            _o(PERSON_P, COMPANY_C, rels=[("person:p", "WORKS_AT", "company:c", f"relation:{x}") for x in "ab"]),
            ["cardinality_violation"],
        ),
        ({}, _o(_e("thing:x", "Whatever"), rels=[("thing:x", "ANYTHING", "thing:x")]), []),
        (ANY_ENDS, _o(PERSON_P, COMPANY_C, rels=[("person:p", "RELATES_TO", "company:c")]), []),
        (
            TYPES_SPEC,
            _o(
                _e("thing:a", "Thing", b=True, j={"x": [1, 2]}, f=3, i=7, s="hi"),
                _e("thing:b", "Thing", b=None, i=None),
            ),
            [],
        ),
        (TYPES_SPEC, _o(_e("thing:x", "Thing", b="yes", f="big", i=True, s=5, j=42)), ["property_type_mismatch"] * 4),
    ],
    ids=[
        "aliases-and-parent",
        "required-then-type-order",
        "unknown-relation",
        "endpoint-type",
        "above-max",
        "empty-schema",
        "empty-endpoint",
        "valid-property-types",
        "bad-property-types",
    ],
)
def test_validation_codes(spec, facts, expected):
    assert codes(spec, facts) == expected


def test_render_catalog():
    entities, relations = render_schema_catalog(Schema.model_validate(SPEC))
    assert entities == (
        "Extract entities using these known types where they fit:\n"
        "- Person: a human. aliases: user\n"
        "- Manager: no description\n"
        "- Company: no description. aliases: org"
    )
    assert relations == "Known relationship types:\n- WORKS_AT (Person -> Company)\n- KNOWS (Person -> Person)"
    assert render_schema_catalog(Schema.model_validate({})) == ("", "")


def test_insert_schema_modes_per_graph_and_per_call():
    g = new_graph()
    schema = {
        "entities": [{"name": "Person", "properties": [{"name": "age", "type": "integer", "required": True}]}],
        "relations": [{"type": "KNOWS", "from": {"types": ["Person"]}, "to": {"types": ["Person"]}}],
    }
    facts = {
        "entities": [{"id": "person:schemaguy", "type": "Person", "name": "Schema Guy"}],
        "relations": [{"from_entity": "person:schemaguy", "type": "LIKES", "to_entity": "person:schemaguy"}],
    }
    warned_codes = ["missing_required_property", "unknown_relation_type"]
    assert [w.code for w in run(g.insert.facts(facts, schema=schema)).warnings] == warned_codes
    assert run(g.entities.get("person:schemaguy")) is not None

    with pytest.raises(ValidationError):
        run(g.insert.facts(facts, schema=schema, schema_mode="strict"))

    quiet = run(g.insert.facts(facts, schema=schema, schema_mode="off"))
    assert quiet.warnings == []

    graph_level = new_graph(schema=schema)
    assert graph_level.schema == Schema.model_validate(schema)
    assert [w.code for w in run(graph_level.insert.facts(facts)).warnings] == warned_codes
    assert run(graph_level.insert.facts(facts, schema_mode="off")).warnings == []
    strict = new_graph(schema=schema, schema_mode="strict")
    with pytest.raises(ValidationError):
        run(strict.insert.facts(facts))


def test_schema_catalog_injected_into_extraction_prompt():
    llm = FakeLLM()
    g = new_graph(llm=llm, schema=SPEC)
    run(g.insert.text("Jane manages Acme."))
    prompts = "\n".join(system + user for _name, system, user in llm.calls)
    assert "Extract entities using these known types" in prompts
    assert "Known relationship types:" in prompts


def test_invalid_schema_and_mode_raise_validation_error():
    with pytest.raises(ValidationError, match="invalid schema"):
        as_schema({"entities": [{"description": "no name"}]})
    with pytest.raises(ValidationError, match="schema_mode"):
        new_graph(schema_mode="loud")
    g = new_graph()
    with pytest.raises(ValidationError, match="schema_mode"):
        run(g.insert.facts({"entities": []}, schema=SPEC, schema_mode="loud"))


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        ({"entities": [{"name": "Person"}, {"name": "person"}]}, "entities[1].name: duplicate entity type 'person'"),
        ({"entities": [{"name": "A"}, {"name": "B", "parent": "X"}]}, "entities[1].parent: unknown type 'X'"),
        (
            {"entities": [{"name": "A", "parent": "B"}, {"name": "B", "parent": "A"}]},
            "entities[0].parent: parent cycle 'A' -> 'B' -> 'A'",
        ),
        ({"entities": [{"name": "A", "parent": "A"}]}, "entities[0].parent: parent cycle 'A' -> 'A'"),
        (
            {"relations": [{"type": "WORKS_AT"}, {"type": "works at"}]},
            "relations[1].type: duplicate relation type 'works at'",
        ),
        ({"relations": [{"type": "R", "from": {"max_count": 0}}]}, "relations[0].from.max_count: must be >= 1"),
        ({"relations": [{"type": "R", "to": {"min_count": -1}}]}, "relations[0].to.min_count: must be >= 0"),
        (
            {"relations": [{"type": "R", "from": {"min_count": 2, "max_count": 1}}]},
            "relations[0].from.min_count: min_count 2 is greater than max_count 1",
        ),
    ],
)
def test_inconsistent_schemas_are_rejected_with_a_path(spec, message):
    with pytest.raises(ValidationError) as err:
        as_schema(spec)
    assert str(err.value) == f"invalid schema: {message}"
    with pytest.raises(ValidationError) as direct:
        Schema(**spec)
    assert str(direct.value) == f"invalid schema: {message}"


def test_models_built_directly_raise_the_sdk_validation_error():
    with pytest.raises(ValidationError) as err:
        Extraction(entities=[{"type": "Person"}])
    assert str(err.value) == "invalid facts: entities[0].name: field required"
    assert Schema(entities=[{"name": "Person"}, {"name": "Manager", "parent": "Person"}]).entities[1].parent == "Person"


def test_settings_load_schema_from_file_or_object(tmp_path, monkeypatch):
    monkeypatch.setenv("SELFGRAPH_SCHEMA", json_file(tmp_path, "schema.json", SPEC))
    monkeypatch.setenv("SELFGRAPH_SCHEMA_MODE", "strict")
    g = build_graph(settings_from_env(**vars(store_settings())))
    assert g.schema == Schema.model_validate(SPEC)
    with pytest.raises(ValidationError):
        run(g.insert.facts({"entities": [{"type": "Robot", "name": "R2"}]}))
    assert build_graph(store_settings(schema=SPEC)).schema == Schema.model_validate(SPEC)
    with pytest.raises(ValidationError, match="cannot read"):
        build_graph(store_settings(schema=str(tmp_path / "missing.json")))


def test_mcp_get_schema_tool():
    with mcp_session(schema=SPEC):
        assert run(srv.get_schema())["relations"][0]["from"]["types"] == ["Person"]
    with mcp_session():
        assert run(srv.get_schema()) is None


WRITE_SPEC = {
    "entities": [
        {"name": "Person", "properties": [{"name": "age", "type": "integer", "required": True}]},
        {"name": "Manager", "parent": "Person"},
        {"name": "Company"},
    ],
    "relations": [
        {
            "type": "WORKS_AT",
            "aliases": ["employed by"],
            "from": {"types": ["Person"], "max_count": 1},
            "to": {"types": ["Company"]},
            "properties": [{"name": "since", "type": "integer"}],
        }
    ],
}
MIN_SPEC = {
    "entities": [{"name": "Person"}, {"name": "Company"}],
    "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"], "min_count": 2}, "to": {"types": ["Company"]}}],
}
AGED_P = PERSON_P


@pytest.mark.parametrize(
    ("spec", "facts", "expected"),
    [
        (
            MIN_SPEC,
            _o(_e("person:p", "Person"), COMPANY_C, rels=[("person:p", "WORKS_AT", "company:c")]),
            ["person:p has 1 WORKS_AT (from) in this insert, below min 2"],
        ),
        (WRITE_SPEC, _o(_e("manager:m", "Manager")), ["entity manager:m is missing required property 'age'"]),
        (
            WRITE_SPEC,
            _o(
                AGED_P,
                _e("company:a", "Company"),
                _e("company:b", "Company"),
                rels=[("person:p", "WORKS_AT", "company:a"), ("person:p", "employed by", "company:b")],
            ),
            ["person:p has 2 WORKS_AT (from) in this insert, above max 1"],
        ),
        (
            WRITE_SPEC,
            _o(AGED_P, _e("tool:t", "Tool"), rels=[("person:p", "WORKS_AT", "tool:t")]),
            [
                "entity tool:t has unknown type 'Tool'",
                "relation person:p -WORKS_AT-> tool:t to entity tool:t is not one of ['Company']",
            ],
        ),
        (
            SPEC,
            {"entities": [_e("thing:x", "Alien"), {"type": "Alien", "name": "Z"}, {"type": "Person", "name": "A"}]},
            [
                "entity thing:x has unknown type 'Alien'",
                "entity alien:z has unknown type 'Alien'",
                "entity person:a is missing required property 'age'",
            ],
        ),
    ],
    ids=["below-min", "inherited-required", "alias-cardinality", "undeclared-endpoint", "given-or-canonical-ids"],
)
def test_validation_messages(spec, facts, expected):
    assert [w.message for w in warnings(spec, facts)] == expected


def test_datetime_properties_must_be_iso_8601():
    spec = {"entities": [{"name": "Event", "properties": [{"name": "at", "type": "datetime"}]}]}

    def check(value):
        return codes(spec, {"entities": [{"type": "Event", "name": "E", "properties": {"at": value}}]})

    assert [check(v) for v in ("2024-01-02", "2024-01-02T03:04:05Z", "2024-01-02T03:04:05+05:30")] == [[], [], []]
    assert [check(v) for v in ("yesterday", "", "2024-13-01", 5)] == [["property_type_mismatch"]] * 4


def schema_graph(mode):
    return fresh_graph(f"schema-{mode}", schema=WRITE_SPEC, schema_mode=mode)


def test_strict_rejects_writes_before_touching_the_graph():
    g = schema_graph("strict")
    with pytest.raises(ValidationError, match=r"^entity robot:r2 has unknown type 'Robot'$"):
        run(g.entities.create("R2", "Robot"))
    assert run(g.entities.get("robot:r2")) is None
    with pytest.raises(ValidationError, match=r"^entity person:jane is missing required property 'age'$"):
        run(g.entities.create("Jane", "Person"))
    with pytest.raises(ValidationError, match="property 'age' should be integer"):
        run(g.entities.create("Jane", "Person", properties={"age": "old"}))
    jane = run(g.entities.create("Jane", "Person", properties={"age": 30}))
    with pytest.raises(ValidationError, match=r"^entity person:jane is missing required property 'age'$"):
        run(g.entities.update(jane.id, remove_properties=["age"]))
    with pytest.raises(ValidationError, match="missing required property 'age'"):
        run(g.entities.create("Jane", "Person"))
    assert run(g.entities.get(jane.id)).properties == {"age": 30}

    run(g.entities.create("Acme", "Company"))
    run(g.insert.facts({"entities": [{"id": "tool:t", "type": "Tool", "name": "T"}]}, schema_mode="off"))
    with pytest.raises(ValidationError, match="from entity company:acme is not one of \\['Person'\\]"):
        run(g.relations.create("company:acme", "WORKS_AT", "person:jane"))
    with pytest.raises(ValidationError, match="to entity tool:t is not one of \\['Company'\\]"):
        run(g.relations.create("person:jane", "WORKS_AT", "tool:t"))
    with pytest.raises(ValidationError, match="has unknown type 'LIKES'"):
        run(g.relations.create("person:jane", "LIKES", "company:acme"))
    assert run(g.relations.list()).items == []
    rel = run(g.relations.create("person:jane", "employed by", "company:acme", properties={"since": 2020}))
    with pytest.raises(ValidationError, match=f"^relation {rel.id} property 'since' should be integer$"):
        run(g.relations.update(rel.id, set_properties={"since": "2020"}))
    with pytest.raises(ValidationError, match=f"^relation {rel.id} property 'since' should be integer$"):
        run(g.relations.create("person:jane", "WORKS_AT", "company:acme", id=rel.id, properties={"since": "x"}))
    assert [r.revision for r in run(g.relations.versions(rel.id))] == [1]


def test_warn_mode_writes_and_logs_each_violation_and_off_mode_is_silent(caplog):
    g = schema_graph("warn")
    run(g.entities.create("Acme", "Company"))
    result = run(
        g.insert.facts(
            {
                "entities": [{"type": "Company", "name": "Beta"}],
                "relations": [{"from_entity": "company:acme", "type": "WORKS_AT", "to_entity": "company:beta"}],
            }
        )
    )
    assert [w.message for w in result.warnings] == [
        "relation company:acme -WORKS_AT-> company:beta from entity company:acme is not one of ['Person']"
    ]
    with caplog.at_level("WARNING", logger="selfgraph"):
        run(g.entities.create("R2", "Robot"))
        run(g.entities.update("robot:r2", properties={"x": 1}))
        run(g.relations.create("robot:r2", "WORKS_AT", "robot:r2"))
        off = schema_graph("off")
        run(off.entities.create("R3", "Robot"))
        run(off.entities.update("robot:r3", type="ROBOT"))
    assert run(g.entities.get("robot:r2")).properties == {"x": 1}
    assert run(off.entities.get("robot:r3")).type == "Robot"
    assert [r.getMessage() for r in caplog.records] == [
        "schema warning [unknown_entity_type]: entity robot:r2 has unknown type 'Robot'",
        "schema warning [endpoint_type_violation]: relation robot:r2 -WORKS_AT-> robot:r2 from entity robot:r2 "
        "is not one of ['Person']",
        "schema warning [endpoint_type_violation]: relation robot:r2 -WORKS_AT-> robot:r2 to entity robot:r2 "
        "is not one of ['Company']",
    ]


def test_an_update_fails_or_warns_only_for_violations_it_introduces(caplog):
    g = fresh_graph("schema-before")
    run(g.entities.create("Jane", "Person", properties={"nick": "J"}))
    run(g.entities.create("Acme", "Company"))
    rel = run(g.relations.create("person:jane", "WORKS_AT", "company:acme", properties={"since": "2020"}))
    strict = new_graph(namespace=g.namespace, schema=WRITE_SPEC, schema_mode="strict")
    renamed = run(strict.entities.update("person:jane", name="Janet", remove_properties=["nick"]))
    assert (renamed.name, renamed.properties) == ("Janet", {})
    assert run(strict.relations.update(rel.id, set_properties={"note": "x"})).revision == 2
    with pytest.raises(ValidationError, match=r"^entity person:jane property 'age' should be integer$"):
        run(strict.entities.update("person:jane", properties={"age": "old"}))
    warn = new_graph(namespace=g.namespace, schema=WRITE_SPEC, schema_mode="warn")
    with caplog.at_level("WARNING", logger="selfgraph"):
        run(warn.entities.update("person:jane", properties={"x": 1}))
        run(warn.entities.update("person:jane", properties={"age": "old"}))
    assert [r.getMessage() for r in caplog.records] == [
        "schema warning [property_type_mismatch]: entity person:jane property 'age' should be integer"
    ]


def test_strict_mode_needs_a_schema(tmp_path, capsys):
    g = new_graph()
    for call in (
        lambda: new_graph(schema_mode="strict"),
        lambda: run(g.insert.facts({"entities": []}, schema_mode="strict")),
        lambda: run(g.insert.text("Jane met Bob.", schema_mode="strict")),
        lambda: srv.run_stdio(store_settings(schema_mode="strict")),
    ):
        with pytest.raises(ValidationError, match="^schema_mode 'strict' needs a schema$"):
            call()
    assert kuzu_main(tmp_path, "--schema-mode", "strict", "entity", "list") == 2
    assert capsys.readouterr().err == "error: schema_mode 'strict' needs a schema\n"


@pytest.mark.parametrize(
    ("build", "message"),
    [
        (
            lambda: Extraction.model_validate({"entites": []}),
            "unknown key 'entites' in facts; did you mean 'entities'?",
        ),
        (
            lambda: Extraction.model_validate({"entities": [{"type": "Person", "nmae": "Jane"}]}),
            "unknown key 'nmae' in facts.entities[0]; did you mean 'name'? "
            "(valid keys: id, type, name, aliases, external_ids, properties)",
        ),
        (
            lambda: Extraction.model_validate(
                {
                    "relations": [
                        {
                            "from_entity": "a",
                            "type": "X",
                            "to_entity": "b",
                            "evidence": [{"source_id": "s", "qoute": "q"}],
                        }
                    ]
                }
            ),
            "unknown key 'qoute' in facts.relations[0].evidence[0]; did you mean 'quote'?",
        ),
        (lambda: as_schema({"entity_types": []}), "unknown key 'entity_types' in schema; did you mean 'entities'?"),
        (lambda: as_schema({"edges": []}), "unknown key 'edges' in schema; did you mean 'relations'?"),
        (
            lambda: as_schema({"relations": [{"type": "X", "from": {"type": ["A"]}}]}),
            "unknown key 'type' in schema.relations[0].from; did you mean 'types'?",
        ),
        (
            lambda: new_graph(instructions={"entites": "x"}),
            "unknown key 'entites' in instructions; did you mean 'entities'?",
        ),
        (
            lambda: new_graph(prompts={"entities": {"system": "s", "user": "{text}", "versoin": "1"}}),
            "unknown key 'versoin' in prompts.entities; did you mean 'version'?",
        ),
        (lambda: EntityInput(type="T", name="n", zz=1), "unknown key 'zz' in entity"),
        (
            lambda: run(new_graph().insert.text("Jane met Bob.", instructions={"relatoins": "x"})),
            "unknown key 'relatoins' in instructions; did you mean 'relations'?",
        ),
        (
            lambda: as_input(Extraction, {"entities": [{"type": "P", "name": 3}, {"type": "P"}]}, "facts"),
            "invalid facts:\n  entities[0].name: expected string\n  entities[1].name: field required",
        ),
    ],
)
def test_unknown_keys_and_bad_fields_are_rejected_with_location_and_suggestion(build, message):
    with pytest.raises(ValidationError) as exc:
        build()
    got = str(exc.value)
    assert (got if "(valid keys:" in message else got.partition(" (valid keys: ")[0]) == message


def test_suggest_key_needs_distance_two_and_breaks_ties_by_order():
    assert suggest_key("nmae", ["id", "type", "name"]) == "name"
    assert suggest_key("ab", ["ax", "ay"]) == "ax"
    assert suggest_key("x", ["id"]) is None
    assert suggest_key("entity_types", ["name", "version", "entities", "relations"]) == "entities"
    assert suggest_key("relationship_types", ["name", "version", "entities", "relations"]) == "relations"
    assert suggest_key("nodes", ["id", "type"]) is None
    assert suggest_key("properties", ["id", "set_properties", "remove_properties"]) == "set_properties"


def test_schema_aliases_and_case_canonicalize_types_before_ids_are_derived():
    spec = {
        "entities": [{"name": "Person", "aliases": ["Human"]}, {"name": "Company"}],
        "relations": [{"type": "WORKS_AT", "aliases": ["employed by"]}],
    }
    g = fresh_graph("canon", schema=spec)
    res = run(
        g.insert.facts(
            {
                "entities": [{"type": "Human", "name": "Ann"}, {"type": "COMPANY", "name": "Acme"}],
                "relations": [{"from_entity": "human:ann", "type": "employed by", "to_entity": "company:acme"}],
                "decisions": [
                    {
                        "title": "Join",
                        "actor_entity": "human:ann",
                        "steps": [ids.relation_id("human:ann", "EMPLOYED_BY", "company:acme")],
                    }
                ],
            }
        )
    )
    assert [(e.id, e.type) for e in res.entities] == [("person:ann", "Person"), ("company:acme", "Company")]
    assert [(r.id, r.type) for r in res.relations] == [
        (ids.relation_id("person:ann", "WORKS_AT", "company:acme"), "WORKS_AT")
    ]
    assert res.decisions[0].actor_entity == "person:ann"
    assert res.warnings == []
    assert run(g.entities.create("Bea", "person")).id == "person:bea"
    assert run(g.relations.create("person:bea", "works at", "company:acme")).type == "WORKS_AT"

    g = fresh_graph("sch", schema=SPEC)
    res = run(
        g.insert.facts(
            {
                "entities": [{"type": "org", "name": "Acme"}, {"type": "Company", "name": "Globex"}],
                "relations": [
                    {"from_entity": "company:acme", "type": "PARTNERS", "to_entity": "org:globex"},
                    {"from_entity": "org:acme", "type": "SUES", "to_entity": "company:globex"},
                ],
            }
        )
    )
    assert [e.id for e in res.entities] == ["company:acme", "company:globex"]
    assert [(r.from_entity, r.to_entity) for r in res.relations] == [("company:acme", "company:globex")] * 2
