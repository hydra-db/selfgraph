import json

import pytest
from helpers import FakeLLM, make_store, new_graph, run, store_settings, unique_ns

import selfgraph.mcp.server as srv
from selfgraph import EntityInput, Ontology, Schema, SyncSelfGraph, ValidationError
from selfgraph.models import suggest_key
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


def warnings(spec, ont):
    return validate_against_schema(Ontology.model_validate(ont), Schema.model_validate(spec))


def codes(spec, ont):
    return [w.code for w in warnings(spec, ont)]


def test_parse_fills_defaults_and_keeps_aliases():
    schema = Schema.model_validate(SPEC)
    prop = schema.entities[0].properties[0]
    assert (prop.name, prop.type, prop.required) == ("age", "integer", True)
    assert schema.entities[1].parent == "Person"
    assert schema.relations[0].from_.types == ["Person"]
    assert schema.relations[0].from_.max_count == 1


def test_as_schema_passthrough_and_null():
    parsed = Schema.model_validate(SPEC)
    assert as_schema(parsed) is parsed
    assert as_schema(SPEC) == parsed
    assert as_schema(None) is None


def test_clean_ontology_through_aliases_and_parent():
    assert (
        codes(
            SPEC,
            {
                "entities": [
                    {"id": "manager:m", "type": "Manager", "name": "M", "properties": {"age": 30}},
                    {"id": "org:o", "type": "org", "name": "O"},
                ],
                "relations": [{"from_entity": "manager:m", "type": "works at", "to_entity": "org:o"}],
            },
        )
        == []
    )


def test_unknown_entity_type_message():
    got = warnings(SPEC, {"entities": [{"id": "thing:x", "type": "Alien", "name": "X"}]})
    assert [(w.code, w.message) for w in got] == [("unknown_entity_type", "entity thing:x has unknown type 'Alien'")]


def test_missing_required_then_type_mismatch_order():
    assert codes(
        SPEC,
        {
            "entities": [
                {"id": "person:p", "type": "Person", "name": "P", "properties": {"score": "high"}},
                {"id": "company:c", "type": "Company", "name": "C", "properties": {"founded": 5}},
            ],
        },
    ) == ["missing_required_property", "property_type_mismatch", "property_type_mismatch"]


def test_unknown_relation_type():
    assert codes(
        SPEC,
        {
            "entities": [{"id": "person:p", "type": "Person", "name": "P", "properties": {"age": 1}}],
            "relations": [{"from_entity": "person:p", "type": "LIKES", "to_entity": "person:p"}],
        },
    ) == ["unknown_relation_type"]


def test_endpoint_type_violation():
    assert codes(
        SPEC,
        {
            "entities": [{"id": "company:c", "type": "Company", "name": "C"}],
            "relations": [{"from_entity": "company:c", "type": "WORKS_AT", "to_entity": "company:c"}],
        },
    ) == ["endpoint_type_violation"]


def test_cardinality_above_max():
    assert codes(
        SPEC,
        {
            "entities": [
                {"id": "person:p", "type": "Person", "name": "P", "properties": {"age": 1}},
                {"id": "company:c", "type": "Company", "name": "C"},
            ],
            "relations": [
                {"id": "relation:a", "from_entity": "person:p", "type": "WORKS_AT", "to_entity": "company:c"},
                {"id": "relation:b", "from_entity": "person:p", "type": "WORKS_AT", "to_entity": "company:c"},
            ],
        },
    ) == ["cardinality_violation"]


def test_cardinality_below_min():
    got = warnings(
        {
            "entities": [{"name": "Person"}, {"name": "Company"}],
            "relations": [
                {"type": "WORKS_AT", "from": {"types": ["Person"], "min_count": 2}, "to": {"types": ["Company"]}}
            ],
        },
        {
            "entities": [
                {"id": "person:p", "type": "Person", "name": "P"},
                {"id": "company:c", "type": "Company", "name": "C"},
            ],
            "relations": [{"from_entity": "person:p", "type": "WORKS_AT", "to_entity": "company:c"}],
        },
    )
    assert [w.code for w in got] == ["cardinality_violation"]
    assert "below min 2" in got[0].message


def test_empty_schema_checks_nothing():
    assert (
        codes(
            {},
            {
                "entities": [{"id": "thing:x", "type": "Whatever", "name": "X"}],
                "relations": [{"from_entity": "thing:x", "type": "ANYTHING", "to_entity": "thing:x"}],
            },
        )
        == []
    )


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


def test_insert_warn_writes_strict_rejects_off_silent():
    g = new_graph()
    schema = {
        "entities": [{"name": "Person", "properties": [{"name": "age", "type": "integer", "required": True}]}],
        "relations": [{"type": "KNOWS", "from": {"types": ["Person"]}, "to": {"types": ["Person"]}}],
    }
    ontology = {
        "entities": [{"id": "person:schemaguy", "type": "Person", "name": "Schema Guy"}],
        "relations": [{"from_entity": "person:schemaguy", "type": "LIKES", "to_entity": "person:schemaguy"}],
    }
    warned = run(g.insert.ontology(ontology, schema=schema))
    assert [w.code for w in warned.warnings] == ["missing_required_property", "unknown_relation_type"]
    assert run(g.entities.get("person:schemaguy")) is not None

    with pytest.raises(ValidationError):
        run(g.insert.ontology(ontology, schema=schema, schema_mode="strict"))

    quiet = run(g.insert.ontology(ontology, schema=schema, schema_mode="off"))
    assert quiet.warnings == []


def test_property_types_accept_valid_values_floats_ints_and_none():
    assert (
        codes(
            TYPES_SPEC,
            {
                "entities": [
                    {
                        "id": "thing:a",
                        "type": "Thing",
                        "name": "A",
                        "properties": {"b": True, "j": {"x": [1, 2]}, "f": 3, "i": 7, "s": "hi"},
                    },
                    {"id": "thing:b", "type": "Thing", "name": "B", "properties": {"b": None, "i": None}},
                ]
            },
        )
        == []
    )


def test_property_type_mismatches_reject_bad_types_and_bool_as_integer():
    got = codes(
        TYPES_SPEC,
        {
            "entities": [
                {
                    "id": "thing:x",
                    "type": "Thing",
                    "name": "X",
                    "properties": {"b": "yes", "f": "big", "i": True, "s": 5, "j": 42},
                }
            ]
        },
    )
    assert got == ["property_type_mismatch"] * 4


def test_empty_endpoint_accepts_any_entity_type():
    assert (
        codes(
            {"entities": [{"name": "Person"}, {"name": "Company"}], "relations": [{"type": "RELATES_TO"}]},
            {
                "entities": [
                    {"id": "person:p", "type": "Person", "name": "P"},
                    {"id": "company:c", "type": "Company", "name": "C"},
                ],
                "relations": [{"from_entity": "person:p", "type": "RELATES_TO", "to_entity": "company:c"}],
            },
        )
        == []
    )


def test_graph_level_schema_exposed_and_overridden_per_insert():
    schema = {"entities": [{"name": "Person", "properties": [{"name": "age", "type": "integer", "required": True}]}]}
    g = new_graph(schema=schema)
    assert g.schema is not None and g.schema.entities[0].name == "Person"
    ontology = {"entities": [{"id": "person:p", "type": "Person", "name": "P"}]}
    assert [w.code for w in run(g.insert.ontology(ontology)).warnings] == ["missing_required_property"]
    assert run(g.insert.ontology(ontology, schema_mode="off")).warnings == []
    strict = new_graph(schema=schema, schema_mode="strict")
    with pytest.raises(ValidationError):
        run(strict.insert.ontology(ontology))


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
        run(g.insert.ontology({"entities": []}, schema=SPEC, schema_mode="loud"))


def test_settings_load_schema_from_file_or_object(tmp_path, monkeypatch):
    path = tmp_path / "schema.json"
    path.write_text(json.dumps(SPEC), encoding="utf-8")
    monkeypatch.setenv("SELFGRAPH_SCHEMA", str(path))
    monkeypatch.setenv("SELFGRAPH_SCHEMA_MODE", "strict")
    g = build_graph(settings_from_env(**vars(store_settings())))
    assert g.schema == Schema.model_validate(SPEC)
    with pytest.raises(ValidationError):
        run(g.insert.ontology({"entities": [{"type": "Robot", "name": "R2"}]}))
    assert build_graph(store_settings(schema=SPEC)).schema == Schema.model_validate(SPEC)
    with pytest.raises(ValidationError, match="cannot read"):
        build_graph(store_settings(schema=str(tmp_path / "missing.json")))


def test_mcp_get_schema_tool():
    srv.configure(store_settings(schema=SPEC))
    got = run(srv.get_schema())
    assert got["relations"][0]["from"]["types"] == ["Person"]
    run(srv.close())
    srv.configure(store_settings())
    assert run(srv.get_schema()) is None
    run(srv.close())


def test_sync_graph_exposes_schema():
    g = SyncSelfGraph(store=make_store(), schema=SPEC)
    try:
        assert g.schema == Schema.model_validate(SPEC)
    finally:
        g.close()


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


def schema_graph(mode):
    return new_graph(schema=WRITE_SPEC, schema_mode=mode, namespace=unique_ns(f"schema-{mode}"))


def test_required_properties_are_inherited_through_parents():
    got = warnings(WRITE_SPEC, {"entities": [{"id": "manager:m", "type": "Manager", "name": "M"}]})
    assert [w.message for w in got] == ["entity manager:m is missing required property 'age'"]


def test_relation_aliases_count_toward_the_canonical_type_for_cardinality():
    got = warnings(
        WRITE_SPEC,
        {
            "entities": [
                {"id": "person:p", "type": "Person", "name": "P", "properties": {"age": 1}},
                {"id": "company:a", "type": "Company", "name": "A"},
                {"id": "company:b", "type": "Company", "name": "B"},
            ],
            "relations": [
                {"from_entity": "person:p", "type": "WORKS_AT", "to_entity": "company:a"},
                {"from_entity": "person:p", "type": "employed by", "to_entity": "company:b"},
            ],
        },
    )
    assert [w.message for w in got] == ["person:p has 2 WORKS_AT (from) in this insert, above max 1"]


def test_insert_checks_endpoint_types_of_entities_already_in_the_graph():
    g = schema_graph("warn")
    run(g.entities.create("Acme", "Company"))
    result = run(
        g.insert.ontology(
            {
                "entities": [{"type": "Company", "name": "Beta"}],
                "relations": [{"from_entity": "company:acme", "type": "WORKS_AT", "to_entity": "company:beta"}],
            }
        )
    )
    assert [w.message for w in result.warnings] == [
        "relation company:acme -WORKS_AT-> company:beta from entity company:acme is not one of ['Person']"
    ]


def test_strict_rejects_entity_create_and_update_before_writing():
    g = schema_graph("strict")
    with pytest.raises(ValidationError, match=r"^entity Robot:R2 has unknown type 'Robot'$"):
        run(g.entities.create("R2", "Robot"))
    assert run(g.entities.get("robot:r2")) is None
    with pytest.raises(ValidationError, match=r"^entity Person:Jane is missing required property 'age'$"):
        run(g.entities.create("Jane", "Person"))
    with pytest.raises(ValidationError, match="property 'age' should be integer"):
        run(g.entities.create("Jane", "Person", properties={"age": "old"}))
    jane = run(g.entities.create("Jane", "Person", properties={"age": 30}))
    with pytest.raises(ValidationError, match=r"^entity person:jane is missing required property 'age'$"):
        run(g.entities.update(jane.id, remove_properties=["age"]))
    run(g.entities.create("Acme", "Company"))
    with pytest.raises(ValidationError, match=r"^entity company:acme is missing required property 'age'$"):
        run(g.entities.update("company:acme", type="Manager"))
    assert run(g.entities.get(jane.id)).properties == {"age": 30}
    assert run(g.entities.get("company:acme")).type == "Company"


def test_strict_rejects_relation_create_and_update_before_writing():
    g = schema_graph("strict")
    run(g.entities.create("Jane", "Person", properties={"age": 30}))
    run(g.entities.create("Acme", "Company"))
    with pytest.raises(ValidationError, match="from entity company:acme is not one of \\['Person'\\]"):
        run(g.relations.create("company:acme", "WORKS_AT", "person:jane"))
    with pytest.raises(ValidationError, match="has unknown type 'LIKES'"):
        run(g.relations.create("person:jane", "LIKES", "company:acme"))
    assert run(g.relations.list()).items == []
    rel = run(g.relations.create("person:jane", "employed by", "company:acme", properties={"since": 2020}))
    with pytest.raises(ValidationError, match=f"^relation {rel.id} property 'since' should be integer$"):
        run(g.relations.update(rel.id, set_properties={"since": "2020"}))
    assert [r.revision for r in run(g.relations.versions(rel.id))] == [1]


def test_warn_mode_writes_and_logs_each_violation(caplog):
    g = schema_graph("warn")
    with caplog.at_level("WARNING", logger="selfgraph"):
        run(g.entities.create("R2", "Robot"))
        run(g.entities.update("robot:r2", properties={"x": 1}))
        run(g.relations.create("robot:r2", "WORKS_AT", "robot:r2"))
    assert run(g.entities.get("robot:r2")).properties == {"x": 1}
    assert [r.getMessage() for r in caplog.records] == [
        "schema warning [unknown_entity_type]: entity Robot:R2 has unknown type 'Robot'",
        "schema warning [unknown_entity_type]: entity robot:r2 has unknown type 'Robot'",
    ]


def test_off_mode_skips_write_checks(caplog):
    g = schema_graph("off")
    with caplog.at_level("WARNING", logger="selfgraph"):
        run(g.entities.create("R2", "Robot"))
        run(g.entities.update("robot:r2", type="Alien"))
    assert run(g.entities.get("robot:r2")).type == "Alien"
    assert caplog.records == []


@pytest.mark.parametrize(
    ("build", "message"),
    [
        (
            lambda: Ontology.model_validate({"entites": []}),
            "unknown key 'entites' in ontology; did you mean 'entities'?",
        ),
        (
            lambda: Ontology.model_validate({"entities": [{"type": "Person", "nmae": "Jane"}]}),
            "unknown key 'nmae' in ontology.entities[0]; did you mean 'name'?",
        ),
        (
            lambda: Ontology.model_validate(
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
            "unknown key 'qoute' in ontology.relations[0].evidence[0]; did you mean 'quote'?",
        ),
        (lambda: as_schema({"entity_types": []}), "unknown key 'entity_types' in schema"),
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
    ],
)
def test_unknown_keys_are_rejected_with_location_and_suggestion(build, message):
    with pytest.raises(ValidationError) as exc:
        build()
    assert str(exc.value) == message


def test_insert_text_rejects_unknown_instruction_keys():
    g = new_graph()
    with pytest.raises(ValidationError, match="unknown key 'relatoins' in instructions; did you mean 'relations'"):
        run(g.insert.text("Jane met Bob.", instructions={"relatoins": "x"}))


def test_suggest_key_needs_distance_two_and_breaks_ties_by_order():
    assert suggest_key("nmae", ["id", "type", "name"]) == "name"
    assert suggest_key("ab", ["ax", "ay"]) == "ax"
    assert suggest_key("x", ["id"]) is None
    assert suggest_key("entity_types", ["name", "version", "entities", "relations"]) is None
