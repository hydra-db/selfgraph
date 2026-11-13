from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from .errors import ValidationError
from .terms import _spaced, stem

__all__ = ["from_tables"]

_TYPES = (
    (("bool",), "boolean"),
    (("json",), "json"),
    (("date", "time"), "datetime"),
    (("int", "serial"), "integer"),
    (("float", "double", "real", "numeric", "decimal", "money"), "float"),
)


def _words(name: str) -> list[str]:
    """Split a table or column name into lowercase words, dropping any schema qualifier.

    @param name (str): the name, such as sales.invoice_lines or InvoiceLines.
    @return (list[str]): the words.
    """
    return [w.lower() for w in re.findall(r"[^\W_]+", _spaced(name.rsplit(".", 1)[-1]))]


def _type_name(table: str) -> str:
    """Name the entity type for a table: its words in PascalCase with the last one singular.

    @param table (str): the table name.
    @return (str): the entity type name.
    """
    words = _words(table)
    if not words:
        raise ValidationError(f"tables: table name {table!r} has no letters or digits")
    words[-1] = stem(words[-1])
    return "".join(w.capitalize() for w in words)


def _property_type(sql_type: Any) -> str:
    """Map a SQL column type to the nearest SelfGraph property type.

    @param sql_type (Any): the column type text, or None.
    @return (str): the property type, string when nothing closer fits.
    """
    text = str(sql_type or "").lower()
    for needles, mapped in _TYPES:
        if any(n in text for n in needles):
            return mapped
    return "string"


def from_tables(tables: Sequence[Mapping[str, Any]], name: str | None = None) -> dict[str, Any]:
    """Draft a schema mapping from table metadata, as Schema.from_tables describes.

    @param tables (Sequence[Mapping[str, Any]]): each table's name, optional description, and columns.
    @param name (str | None): the schema name.
    @return (dict[str, Any]): the schema as a mapping, ready to validate.
    """
    if isinstance(tables, str | Mapping) or not isinstance(tables, Sequence):
        raise ValidationError(f"tables must be a list of table mappings, got {type(tables).__name__}")
    names: dict[str, str] = {}
    for i, table in enumerate(tables):
        if not isinstance(table, Mapping) or not isinstance(table.get("name"), str):
            raise ValidationError(f"tables[{i}]: each table needs a name")
        names[table["name"]] = _type_name(table["name"])
        names.setdefault(table["name"].rsplit(".", 1)[-1], names[table["name"]])
    entities: list[dict[str, Any]] = []
    relations: dict[str, dict[str, Any]] = {}
    for i, table in enumerate(tables):
        etype = names[table["name"]]
        phrase = " ".join(_words(table["name"]))
        properties = []
        for j, column in enumerate(table.get("columns") or ()):
            if not isinstance(column, Mapping) or not isinstance(column.get("name"), str):
                raise ValidationError(f"tables[{i}].columns[{j}]: each column needs a name")
            target = column.get("references")
            if target is not None:
                if target not in names:
                    raise ValidationError(f"tables[{i}].columns[{j}].references: unknown table {target!r}")
                own = [w for w in _words(column["name"]) if w != "id"] or _words(target)
                rtype = "HAS_" + "_".join(own).upper()
                relation = relations.setdefault(
                    rtype, {"type": rtype, "from": {"types": [], "max_count": 1}, "to": {"types": []}}
                )
                for side, value in (("from", etype), ("to", names[target])):
                    if value not in relation[side]["types"]:
                        relation[side]["types"].append(value)
                continue
            properties.append(
                {
                    "name": column["name"],
                    "type": _property_type(column.get("type")),
                    "required": column.get("nullable") is False,
                    "description": column.get("description"),
                }
            )
        entities.append(
            {
                "name": etype,
                "description": table.get("description"),
                "synonyms": list(dict.fromkeys([phrase, " ".join(_words(etype))])),
                "properties": properties,
                "mappings": [{"table": table["name"]}],
            }
        )
    return {"name": name, "entities": entities, "relations": list(relations.values())}
