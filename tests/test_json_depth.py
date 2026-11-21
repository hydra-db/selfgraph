import json

import pytest
from helpers import cli_error, kuzu_main

from selfgraph.errors import ValidationError
from selfgraph.runtime import parse_json, read_json

DEEP = "[" * 100000 + "]" * 100000
ARGV_DEEP = "[" * 200 + "]" * 200
MESSAGE = "invalid JSON in --prop: too deeply nested; keep it under 64 levels"
FLAG_MESSAGE = "invalid JSON: too deeply nested; keep it under 64 levels"


def test_parse_json_reports_a_deep_document_as_invalid_json():
    with pytest.raises(ValidationError) as raised:
        parse_json(DEEP, " in --prop", "k")
    assert str(raised.value) == MESSAGE
    assert (raised.value.code, raised.value.field) == ("invalid_argument", "k")


def test_parse_json_counts_brackets_only_outside_strings():
    deep_string = json.dumps({"value": "[" * 100000})
    assert parse_json(deep_string) == {"value": "[" * 100000}
    with pytest.raises(ValidationError) as raised:
        parse_json("[" * 65, " in --schema", "schema")
    assert str(raised.value) == "invalid JSON in --schema: too deeply nested; keep it under 64 levels"


def test_read_json_names_the_path_for_a_deep_file(tmp_path):
    path = tmp_path / "facts.json"
    path.write_text(DEEP, encoding="utf-8")
    with pytest.raises(ValidationError) as raised:
        read_json(str(path))
    assert f"invalid JSON in {str(path)!r}: too deeply nested" in str(raised.value)
    assert raised.value.field == "path"


def test_a_deep_prop_flag_exits_2_without_falling_back_to_text(capsys, tmp_path):
    assert kuzu_main(tmp_path, "entity", "create", "--name", "A", "--type", "T", "--prop", f"k={ARGV_DEEP}") == 2
    assert capsys.readouterr().err == cli_error("invalid_argument", FLAG_MESSAGE, "selfgraph entity create", "k")


def test_a_deep_facts_file_exits_2_with_the_path(capsys, tmp_path):
    path = tmp_path / "facts.json"
    path.write_text(DEEP, encoding="utf-8")
    assert kuzu_main(tmp_path, "insert", "facts", str(path)) == 2
    assert "field: path" in capsys.readouterr().err


def test_a_deep_evidence_flag_exits_2_without_falling_back(capsys, tmp_path):
    cli = ["relation", "create", "t:a", "KNOWS", "t:b", "--evidence", DEEP]
    assert kuzu_main(tmp_path, *cli) == 2
    assert "error[invalid_argument]: invalid JSON in --evidence: too deeply nested" in capsys.readouterr().err
