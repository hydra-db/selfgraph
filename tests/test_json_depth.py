import json

import pytest

from selfgraph.errors import ValidationError
from selfgraph.models import CypherResult, EntityInput, PreferenceInput, RelationInput
from selfgraph.runtime import parse_json, read_json


def nested(levels: int) -> str:
    return "[" * levels + "]" * levels


def test_a_document_past_the_depth_limit_raises_instead_of_returning_a_value():
    with pytest.raises(ValidationError) as raised:
        parse_json(nested(130))
    assert raised.value.code == "invalid_argument"
    assert "nested too deeply" in str(raised.value)


def test_the_depth_limit_matches_the_typed_api():
    """The boundary is the one require_clean_json already enforces: 65 accepted, 66 rejected."""
    assert parse_json(nested(65)) == json.loads(nested(65))
    with pytest.raises(ValidationError):
        parse_json(nested(66))


def test_the_field_is_named_when_the_caller_knows_it():
    with pytest.raises(ValidationError) as raised:
        parse_json(nested(130), " in --prop", "k")
    assert raised.value.field == "k"
    assert str(raised.value).startswith("invalid JSON in --prop: nested too deeply")


def test_a_deep_file_names_its_path(tmp_path):
    path = tmp_path / "facts.json"
    path.write_text(nested(130), encoding="utf-8")
    with pytest.raises(ValidationError) as raised:
        read_json(str(path))
    assert raised.value.field == "path"
    assert f"invalid JSON in {str(path)!r}: nested too deeply" in str(raised.value)


@pytest.mark.parametrize("kind", ["dict", "list"])
def test_a_property_deeper_than_the_validator_can_recurse_is_a_coded_error(kind):
    value = 1
    for _ in range(1000):
        value = {"a": value} if kind == "dict" else [value]
    builds = (
        (lambda: EntityInput(type="T", name="n", properties={"p": value}), "entity property and external id"),
        (
            lambda: RelationInput(from_entity="t:a", type="R", to_entity="t:b", properties={"p": value}),
            "relation property",
        ),
        (
            lambda: PreferenceInput(subject_entity="t:a", key="k", value_entity="t:b", properties={"p": value}),
            "preference property",
        ),
    )
    for build, label in builds:
        with pytest.raises(ValidationError) as raised:
            build()
        assert raised.value.code == "invalid_argument"
        assert str(raised.value) == f"{label} is nested too deeply; keep it under 64 levels"


@pytest.mark.parametrize("depth", [253, 254, 255])
@pytest.mark.parametrize("kind", ["list", "dict", "tuple", "mixed"])
def test_result_nesting_boundary(depth, kind):
    value = 1
    for index in range(depth):
        shape = index % 3 if kind == "mixed" else {"list": 0, "dict": 1, "tuple": 2}[kind]
        value = [value] if shape == 0 else {"x": value} if shape == 1 else (value,)
    rows = [{"x": value}]
    if depth <= 254:
        assert CypherResult._result_depth(rows) is rows
        assert CypherResult(rows=rows).rows == rows
    else:
        with pytest.raises(ValidationError, match="maximum nesting depth of 254") as caught:
            CypherResult(rows=rows)
        assert caught.value.code == "invalid_argument"
        assert caught.value.field == "rows"


@pytest.mark.parametrize("value", [None, [], {}, [1, {"a": (None, "x")}], object()])
def test_result_depth_preserves_cell_identity(value):
    rows = [{"x": value}]
    assert CypherResult._result_depth(rows) is rows
    assert CypherResult(rows=rows).rows[0]["x"] is value


@pytest.mark.parametrize("kind", [list, dict])
def test_cyclic_result_is_rejected(kind):
    value = kind()
    if isinstance(value, list):
        value.append(value)
    else:
        value["self"] = value
    with pytest.raises(ValidationError, match="maximum nesting depth of 254"):
        CypherResult(rows=[{"x": value}])
