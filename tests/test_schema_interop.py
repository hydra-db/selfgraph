import logging

import pytest
from helpers import cli, fresh_graph, json_file, mcp_session, run

from selfgraph import Schema, ValidationError
from selfgraph._neo4j_schema import to_neo4j

NEO4J = {
    "node_types": [
        {
            "label": "Person",
            "description": "A human",
            "properties": [
                {"name": "name", "type": "STRING", "description": "full name"},
                {"name": "born", "type": "DATE", "description": ""},
                {"name": "home", "type": "POINT", "description": ""},
            ],
            "additional_properties": False,
        },
        "Company",
        {"label": "City", "properties": [{"name": "pop", "type": "INTEGER", "required": True}]},
    ],
    "relationship_types": [
        {"label": "WORKS_FOR", "description": "employment", "properties": [{"name": "since", "type": "FLOAT"}]},
        {"label": "KNOWS"},
    ],
    "patterns": [
        ["Person", "WORKS_FOR", "Company"],
        {"source": "Person", "relationship": "LIVES_IN", "target": "City"},
        ["Company", "LIVES_IN", "City"],
        ["Person", "KNOWS", "Person"],
    ],
    "constraints": [
        {"type": "EXISTENCE", "property_names": ["name"], "node_type": "Person"},
        {"type": "UNIQUENESS", "property_names": ["name"], "node_type": "Person"},
        {"type": "KEY", "property_name": "since", "relationship_type": "WORKS_FOR"},
    ],
    "additional_node_types": False,
    "indexes": [],
}

CANONICAL = {
    "node_types": [
        {
            "label": "Person",
            "description": "A human",
            "aliases": ["Human"],
            "properties": [
                {"name": "name", "type": "STRING", "description": "full name"},
                {"name": "born", "type": "ZONED_DATETIME", "description": ""},
                {"name": "age", "type": "INTEGER", "description": ""},
                {"name": "score", "type": "FLOAT", "description": ""},
                {"name": "active", "type": "BOOLEAN", "description": ""},
            ],
        },
        {"label": "Company", "description": "", "properties": []},
    ],
    "relationship_types": [
        {
            "label": "WORKS_FOR",
            "description": "",
            "properties": [{"name": "role", "type": "STRING", "description": ""}],
        },
        {"label": "KNOWS", "description": "", "properties": []},
    ],
    "patterns": [
        ["Person", "WORKS_FOR", "Company"],
        ["Person", "WORKS_FOR", "Person"],
        ["Person", "KNOWS", "Person"],
    ],
    "constraints": [
        {"type": "EXISTENCE", "property_names": ["name"], "node_type": "Person"},
        {"type": "EXISTENCE", "property_names": ["role"], "relationship_type": "WORKS_FOR"},
    ],
}


def test_neo4j_ontology_maps_types_patterns_and_constraints(caplog):
    with caplog.at_level(logging.WARNING, logger="selfgraph"):
        schema = Schema.from_neo4j_ontology(NEO4J)
    person, company, city = schema.entities
    assert (person.name, person.description) == ("Person", "A human")
    assert [(p.name, p.type, p.required, p.description) for p in person.properties] == [
        ("name", "string", True, "full name"),
        ("born", "datetime", False, None),
        ("home", "json", False, None),
    ]
    assert (company.name, company.properties) == ("Company", [])
    assert [(p.name, p.type, p.required) for p in city.properties] == [("pop", "integer", True)]
    works, knows, lives = schema.relations
    assert (works.type, works.description, works.from_.types, works.to.types) == (
        "WORKS_FOR",
        "employment",
        ["Person"],
        ["Company"],
    )
    assert [(p.name, p.type, p.required) for p in works.properties] == [("since", "float", True)]
    assert (knows.from_.types, knows.to.types) == (["Person"], ["Person"])
    assert (lives.type, lives.from_.types, lives.to.types) == ("LIVES_IN", ["Person", "Company"], ["City"])
    assert "Person.home type POINT maps to json" in caplog.text
    dropped = [r.getMessage() for r in caplog.records if "dropped" in r.getMessage()]
    assert len(dropped) == 1
    for key in (
        "additional_node_types",
        "indexes",
        "Person.additional_properties",
        "constraints[1] UNIQUENESS on Person(name)",
        "constraints[2] KEY uniqueness on WORKS_FOR(since)",
    ):
        assert key in dropped[0]


def test_round_trip_preserves_the_mapped_subset_and_camel_case_keys_read(caplog):
    with caplog.at_level(logging.WARNING, logger="selfgraph"):
        schema = Schema.from_neo4j_ontology(CANONICAL)
        assert schema.to_neo4j_ontology() == CANONICAL
    assert Schema.from_neo4j_ontology(schema.to_neo4j_ontology()) == schema
    camel = {
        "nodeTypes": [{"label": "Person", "properties": [{"name": "age", "type": "INTEGER"}]}],
        "relationshipTypes": [{"label": "KNOWS"}],
        "patterns": [["Person", "KNOWS", "Person"]],
        "constraints": [{"type": "EXISTENCE", "nodeType": "Person", "propertyNames": ["age"]}],
    }
    with caplog.at_level(logging.WARNING, logger="selfgraph"):
        schema = Schema.from_neo4j_ontology(camel)
    assert caplog.text == ""
    assert [e.name for e in schema.entities] == ["Person"] and schema.entities[0].properties[0].required
    assert [(r.type, r.from_.types, r.to.types) for r in schema.relations] == [("KNOWS", ["Person"], ["Person"])]


def test_export_warns_about_fields_without_a_neo4j_counterpart(caplog):
    schema = Schema.model_validate(
        {
            "name": "s",
            "entities": [
                {"name": "Person", "parent": "Agent", "properties": [{"name": "blob", "type": "json"}]},
                {"name": "Agent"},
            ],
            "relations": [{"type": "OWNS", "from": {"types": ["Person"], "max_count": 1}}],
        }
    )
    with caplog.at_level(logging.WARNING, logger="selfgraph"):
        out = schema.to_neo4j_ontology()
    assert out["patterns"] == [] and out["node_types"][0]["properties"][0]["type"] == "STRING"
    for key in ("name", "Person.parent", "Person.blob json type", "OWNS endpoint types on one side only", "OWNS.from"):
        assert key in caplog.text


def test_invalid_neo4j_ontology_and_schema_objects_raise():
    assert to_neo4j({"entities": [{"name": "Person"}]})["node_types"][0]["label"] == "Person"
    for bad in (None, [], {"entity_types": []}):
        with pytest.raises(ValidationError):
            to_neo4j(bad)
    for bad in (
        [],
        {"node_types": "Person"},
        {"node_types": [{"description": "no label"}]},
        {"node_types": [{"label": "P", "properties": [{"type": "STRING"}]}]},
        {"patterns": [["A", "R"]]},
        {"node_types": [{"label": "P", "aliases": "x"}]},
    ):
        with pytest.raises(ValidationError):
            Schema.from_neo4j_ontology(bad)


def test_cli_and_mcp_convert_schemas(capsys, tmp_path):
    g = fresh_graph("si")
    imported = cli(g, ["schema", "import", "--from", "neo4j", json_file(tmp_path, "neo.json", CANONICAL)], capsys)
    assert [e["name"] for e in imported["entities"]] == ["Person", "Company"]

    ours = json_file(tmp_path, "schema.json", imported)
    with_schema = fresh_graph("si", schema=Schema.model_validate(imported))
    assert cli(with_schema, ["schema", "export", "--to", "neo4j"], capsys) == CANONICAL
    with pytest.raises(ValidationError):
        cli(g, ["schema", "export", "--to", "neo4j"], capsys)
    assert cli(g, ["schema"], capsys) is None

    with mcp_session("si", schema=ours) as srv:
        assert run(srv.get_schema(format="neo4j")) == CANONICAL
        assert run(srv.get_schema())["entities"][0]["name"] == "Person"
