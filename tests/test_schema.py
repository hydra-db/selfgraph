import json

import pytest
from helpers import FakeLLM, new_graph, run, store_settings

import selfgraph.mcp.server as srv
from selfgraph import Ontology, Schema, ValidationError
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


def codes(schema, ont):
    return [w.code for w in validate_against_schema(Ontology.model_validate(ont), schema)]


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
    schema = Schema.model_validate(SPEC)
    assert (
        codes(
            schema,
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
    schema = Schema.model_validate(SPEC)
    warnings = validate_against_schema(
        Ontology.model_validate({"entities": [{"id": "thing:x", "type": "Alien", "name": "X"}]}), schema
    )
    assert len(warnings) == 1
    assert warnings[0].code == "unknown_entity_type"
    assert warnings[0].message == "entity thing:x has unknown type 'Alien'"


def test_missing_required_then_type_mismatch_order():
    schema = Schema.model_validate(SPEC)
    assert codes(
        schema,
        {
            "entities": [
                {"id": "person:p", "type": "Person", "name": "P", "properties": {"score": "high"}},
                {"id": "company:c", "type": "Company", "name": "C", "properties": {"founded": 5}},
            ],
        },
    ) == ["missing_required_property", "property_type_mismatch", "property_type_mismatch"]


def test_unknown_relation_type():
    schema = Schema.model_validate(SPEC)
    assert codes(
        schema,
        {
            "entities": [{"id": "person:p", "type": "Person", "name": "P", "properties": {"age": 1}}],
            "relations": [{"from_entity": "person:p", "type": "LIKES", "to_entity": "person:p"}],
        },
    ) == ["unknown_relation_type"]


def test_endpoint_type_violation():
    schema = Schema.model_validate(SPEC)
    assert codes(
        schema,
        {
            "entities": [{"id": "company:c", "type": "Company", "name": "C"}],
            "relations": [{"from_entity": "company:c", "type": "WORKS_AT", "to_entity": "company:c"}],
        },
    ) == ["endpoint_type_violation"]


def test_cardinality_above_max():
    schema = Schema.model_validate(SPEC)
    assert codes(
        schema,
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
    schema = Schema.model_validate(
        {
            "entities": [{"name": "Person"}, {"name": "Company"}],
            "relations": [
                {"type": "WORKS_AT", "from": {"types": ["Person"], "min_count": 2}, "to": {"types": ["Company"]}}
            ],
        }
    )
    warnings = validate_against_schema(
        Ontology.model_validate(
            {
                "entities": [
                    {"id": "person:p", "type": "Person", "name": "P"},
                    {"id": "company:c", "type": "Company", "name": "C"},
                ],
                "relations": [{"from_entity": "person:p", "type": "WORKS_AT", "to_entity": "company:c"}],
            }
        ),
        schema,
    )
    assert [w.code for w in warnings] == ["cardinality_violation"]
    assert "below min 2" in warnings[0].message


def test_empty_schema_checks_nothing():
    schema = Schema.model_validate({})
    assert (
        codes(
            schema,
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
    schema = Schema.model_validate(TYPES_SPEC)
    assert (
        codes(
            schema,
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
    schema = Schema.model_validate(TYPES_SPEC)
    warnings = validate_against_schema(
        Ontology.model_validate(
            {
                "entities": [
                    {
                        "id": "thing:x",
                        "type": "Thing",
                        "name": "X",
                        "properties": {"b": "yes", "f": "big", "i": True, "s": 5, "j": 42},
                    }
                ]
            }
        ),
        schema,
    )
    assert [w.code for w in warnings] == ["property_type_mismatch"] * 4


def test_empty_endpoint_accepts_any_entity_type():
    schema = Schema.model_validate(
        {"entities": [{"name": "Person"}, {"name": "Company"}], "relations": [{"type": "RELATES_TO"}]}
    )
    assert (
        codes(
            schema,
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
