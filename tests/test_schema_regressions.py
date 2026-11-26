import asyncio

import pytest
from helpers import make_store

from selfgraph import Schema, SelfGraph, ValidationError
from selfgraph.errors import HINTS
from selfgraph.ids import entity_id, normalize_rel_type


def test_306_schema_rejects_empty_normalized_relation_types():
    async def check():
        async with SelfGraph(make_store()) as graph:
            assert (await graph.entities.list()).items == []
            for value in ("!!!", "___", " - / ", "💥"):
                with pytest.raises(ValidationError) as normalized:
                    normalize_rel_type(value)
                with pytest.raises(ValidationError) as schema:
                    Schema(relations=[{"type": value}])
                assert str(schema.value) == str(normalized.value)
                assert schema.value.code == normalized.value.code == "invalid_argument"
                assert schema.value.field == "relations[0].type"
                assert schema.value.hint == HINTS["invalid_argument"]
            assert Schema(relations=[{"type": "works at"}]).relations[0].type == "works at"

    asyncio.run(check())


def test_307_from_tables_rejects_a_non_list_columns_value():
    for value, name in [(5, "number"), (True, "boolean"), (1.5, "number"), ("abc", "string")]:
        with pytest.raises(ValidationError) as exc:
            Schema.from_tables([{"name": "orders", "columns": value}])
        assert (exc.value.code, exc.value.field) == ("invalid_argument", "columns")
        assert str(exc.value) == f"tables[0].columns must be a list of column mappings, got {name}"


def test_309_from_tables_distinguishes_schema_qualified_names():
    async def check():
        schema = Schema.from_tables(
            [
                {"name": "sales.users", "columns": [{"name": "support_id", "references": "support.users"}]},
                {"name": "support.users", "columns": [{"name": "sales_id", "references": "sales.users"}]},
                {"name": "sales.orders", "columns": [{"name": "user_id", "references": "sales.users"}]},
            ]
        )
        assert [entity.name for entity in schema.entities] == ["SalesUser", "SupportUser", "Order"]
        assert [entity.mappings[0].table for entity in schema.entities] == [
            "sales.users",
            "support.users",
            "sales.orders",
        ]
        assert [(rel.from_.types, rel.to.types) for rel in schema.relations] == [
            (["SalesUser"], ["SupportUser"]),
            (["SupportUser"], ["SalesUser"]),
            (["Order"], ["SalesUser"]),
        ]
        async with SelfGraph(make_store(), schema=schema, schema_mode="strict") as graph:
            result = await graph.insert.facts(
                {
                    "entities": [{"type": entity.name, "name": "Ann"} for entity in schema.entities[:2]],
                    "relations": [
                        {
                            "from_entity": entity_id("SalesUser", "Ann"),
                            "type": "HAS_SUPPORT",
                            "to_entity": entity_id("SupportUser", "Ann"),
                        }
                    ],
                }
            )
            assert not result.warnings
            assert len((await graph.entities.list()).items) == 2
            assert len((await graph.relations.list()).items) == 1

    asyncio.run(check())
