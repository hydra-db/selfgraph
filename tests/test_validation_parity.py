import pytest
from helpers import KUZU, make_store, run

from selfgraph import KuzuStore, SelfGraph, SyncSelfGraph
from selfgraph.errors import HINTS, ValidationError


@pytest.mark.parametrize("value", ["false", 0, 1])
@pytest.mark.parametrize(
    ("schema", "field"),
    [
        ({"entities": [{"name": "T", "certified": None}]}, "entities[0].certified"),
        (
            {"entities": [{"name": "T", "properties": [{"name": "p", "required": None}]}]},
            "entities[0].properties[0].required",
        ),
        (
            {"entities": [{"name": "T", "definitions": [{"name": "d", "expression": "x", "certified": None}]}]},
            "entities[0].definitions[0].certified",
        ),
        ({"relations": [{"type": "R", "certified": None}]}, "relations[0].certified"),
    ],
)
def test_376_schema_rejects_coerced_booleans(schema, field, value):
    import copy

    schema = copy.deepcopy(schema)
    target = schema["entities"][0] if "entities" in schema else schema["relations"][0]
    if "properties" in target:
        target = target["properties"][0]
    if "definitions" in target:
        target = target["definitions"][0]
    target[field.rsplit(".", 1)[1]] = value
    store = make_store()
    try:
        run(store.initialize())
        with pytest.raises(ValidationError) as exc:
            SelfGraph(store, schema=schema)
        assert (exc.value.code, exc.value.field, exc.value.hint) == (
            "invalid_argument",
            field,
            HINTS["invalid_argument"],
        )
        assert str(exc.value) == f"invalid schema: {field}: expected boolean"
    finally:
        run(store.close())


@pytest.mark.parametrize("offset", ["start_offset", "end_offset"])
@pytest.mark.parametrize("value", ["2", True, False])
def test_376_evidence_rejects_coerced_offsets(offset, value):
    with SyncSelfGraph(make_store()) as graph:
        field = f"relations[0].evidence[0].{offset}"
        with pytest.raises(ValidationError) as exc:
            graph.insert.facts(
                {
                    "entities": [{"type": "T", "name": "a"}, {"type": "T", "name": "b"}],
                    "relations": [
                        {
                            "from_entity": "t:a",
                            "type": "R",
                            "to_entity": "t:b",
                            "evidence": [{"source_id": "s", offset: value}],
                        }
                    ],
                }
            )
        assert (exc.value.code, exc.value.field, exc.value.hint) == (
            "invalid_argument",
            field,
            HINTS["invalid_argument"],
        )
        assert str(exc.value) == f"invalid facts: {field}: expected number"


@pytest.mark.parametrize(
    ("call", "key", "message"),
    [
        (
            lambda g: SelfGraph(g.store, namespce="x"),
            "namespce",
            "unknown option 'namespce' for SelfGraph; did you mean 'namespace'?",
        ),
        (
            lambda g: g.retrieve("x", stratgy="bfs"),
            "stratgy",
            "unknown option 'stratgy' for retrieve; did you mean 'strategy'?",
        ),
        (
            lambda g: g.insert.facts({}, sourse_id="s"),
            "sourse_id",
            "unknown option 'sourse_id' for insert.facts; did you mean 'source_id'? (valid options: source_id, event_time, schema, schema_mode, resolver, contradiction)",
        ),
        (
            lambda g: g.entities.create("A", "T", evidence=[]),
            "evidence",
            "unknown option 'evidence' for entities.create (valid options: id, aliases, external_ids, properties)",
        ),
        (
            lambda g: g.entities.list(limt=5),
            "limt",
            "unknown option 'limt' for entities.list; did you mean 'limit'? (valid options: type, name, cursor, limit)",
        ),
        (
            lambda g: g.maintenance.prune(apply=True),
            "apply",
            "unknown option 'apply' for maintenance.prune (valid options: min_relevance, older_than, types, relation_types, include_certified, dry_run)",
        ),
    ],
)
def test_399_unknown_options_are_coded(call, key, message):
    with SyncSelfGraph(make_store()) as graph:
        with pytest.raises(ValidationError) as exc:
            call(graph)
        assert (exc.value.code, exc.value.field, exc.value.hint) == ("unknown_key", key, HINTS["unknown_key"])
        assert str(exc.value) == message


@pytest.mark.skipif(not KUZU, reason="KuzuStore option validation is backend specific")
def test_399_unknown_store_option_is_coded():
    with pytest.raises(ValidationError) as exc:
        KuzuStore(":memory:", max_db_sise=1)
    assert (exc.value.code, exc.value.field, exc.value.hint) == ("unknown_key", "max_db_sise", HINTS["unknown_key"])
    assert str(exc.value) == (
        "unknown option 'max_db_sise' for KuzuStore; did you mean 'max_db_size'? "
        "(valid options: buffer_pool_size, max_db_size, compression, read_only)"
    )


@pytest.mark.parametrize(("value", "rendered"), [(10**400, "inf"), (-(10**400), "-inf"), (2.0, "2")])
def test_330_range_errors_render_numbers_like_typescript(value, rendered):
    with SyncSelfGraph(make_store()) as graph:
        a = graph.entities.create("a", "T")
        b = graph.entities.create("b", "T")
        with pytest.raises(ValidationError) as exc:
            graph.preferences.create(a.id, "k", b.id, strength=value)
        assert str(exc.value) == f"preference strength must be between 0 and 1, got {rendered}"
