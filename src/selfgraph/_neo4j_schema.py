from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from .errors import ValidationError

if TYPE_CHECKING:
    from .schema import Schema

_log = logging.getLogger("selfgraph")

IMPORT_TYPES = {
    "STRING": "string",
    "INTEGER": "integer",
    "FLOAT": "float",
    "BOOLEAN": "boolean",
    "DATE": "datetime",
    "LOCAL_DATETIME": "datetime",
    "ZONED_DATETIME": "datetime",
}
EXPORT_TYPES = {
    "string": "STRING",
    "integer": "INTEGER",
    "float": "FLOAT",
    "boolean": "BOOLEAN",
    "datetime": "ZONED_DATETIME",
    "json": "STRING",
}
_TOP_KEYS = ("node_types", "relationship_types", "patterns", "constraints")
_TYPE_KEYS = ("label", "description", "aliases", "properties")
_PROPERTY_KEYS = ("name", "type", "description", "required")
_REQUIRED_KINDS = ("EXISTENCE", "KEY")
_CAMEL_KEYS = {
    "nodeTypes": "node_types",
    "relationshipTypes": "relationship_types",
    "nodeType": "node_type",
    "relationshipType": "relationship_type",
    "propertyNames": "property_names",
    "propertyName": "property_name",
}


def _mapping(value: Any, where: str) -> Mapping[str, Any]:
    """Require a JSON object, reading each camelCase key as its snake_case form; the snake_case key wins a clash.

    @param value (Any): the value.
    @param where (str): its location, for the error message.
    @return (Mapping[str, Any]): the value with snake_case keys.
    """
    if not isinstance(value, Mapping):
        raise ValidationError(f"{where} must be an object, got {type(value).__name__}")
    out = {_CAMEL_KEYS[k]: v for k, v in value.items() if k in _CAMEL_KEYS}
    out.update((k, v) for k, v in value.items() if k not in _CAMEL_KEYS)
    return out


def _items(data: Mapping[str, Any], key: str, where: str) -> list[Any]:
    """Read an optional JSON array.

    @param data (Mapping[str, Any]): the object holding it.
    @param key (str): the array key.
    @param where (str): the object's location, for the error message.
    @return (list[Any]): the items, empty when the key is absent or null.
    """
    value = data.get(key)
    if value is None:
        return []
    if isinstance(value, str) or not isinstance(value, list | tuple):
        raise ValidationError(f"{where}.{key} must be a list, got {type(value).__name__}")
    return list(value)


def _text(value: Any, where: str) -> str:
    """Require a non-empty string.

    @param value (Any): the value.
    @param where (str): its location, for the error message.
    @return (str): the string.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{where} must be a non-empty string, got {value!r}")
    return value


def _extra(data: Mapping[str, Any], known: tuple[str, ...], where: str, dropped: list[str]) -> None:
    """Record the keys of an object that SelfGraph does not model.

    @param data (Mapping[str, Any]): the object.
    @param known (tuple[str, ...]): the keys that are mapped.
    @param where (str): the object's location, prefixed to each dropped key.
    @param dropped (list[str]): the running list of dropped keys.
    @return (None): nothing; dropped is extended in place.
    """
    dropped.extend(f"{where}{key}" for key in data if key not in known)


def _import_type(data: Mapping[str, Any], where: str, dropped: list[str]) -> dict[str, Any]:
    """Map one Neo4j node or relationship type to a SelfGraph type body, keyed by label.

    @param data (Mapping[str, Any]): the node or relationship type, or a bare label string.
    @param where (str): its location, for messages.
    @param dropped (list[str]): the running list of dropped keys.
    @return (dict[str, Any]): label, description, aliases, and properties in SelfGraph form.
    """
    if isinstance(data, str):
        data = {"label": data}
    data = _mapping(data, where)
    label = _text(data.get("label"), f"{where}.label")
    _extra(data, _TYPE_KEYS, f"{label}.", dropped)
    properties = []
    for i, raw in enumerate(_items(data, "properties", label)):
        prop = _mapping(raw, f"{label}.properties[{i}]")
        name = _text(prop.get("name"), f"{label}.properties[{i}].name")
        _extra(prop, _PROPERTY_KEYS, f"{label}.{name}.", dropped)
        neo_type = prop.get("type", "STRING")
        mapped = IMPORT_TYPES.get(neo_type) if isinstance(neo_type, str) else None
        if mapped is None:
            _log.warning("neo4j ontology: %s.%s type %s maps to json", label, name, neo_type)
            mapped = "json"
        properties.append(
            {
                "name": name,
                "type": mapped,
                "required": prop.get("required") is True,
                "description": prop.get("description") or None,
            }
        )
    return {
        "label": label,
        "description": data.get("description") or None,
        "aliases": _items(data, "aliases", label),
        "properties": properties,
    }


def _pattern(raw: Any, where: str) -> tuple[str, str, str]:
    """Read one pattern as (source, relationship, target), from a 3-item list or a source/relationship/target object.

    @param raw (Any): the pattern.
    @param where (str): its location, for the error message.
    @return (tuple[str, str, str]): the source label, relationship label, and target label.
    """
    if isinstance(raw, Mapping):
        parts = [raw.get("source"), raw.get("relationship"), raw.get("target")]
    elif isinstance(raw, list | tuple) and len(raw) == 3:
        parts = list(raw)
    else:
        raise ValidationError(f"{where} must be [source, relationship, target] or an object with those keys")
    return tuple(_text(p, where) for p in parts)  # type: ignore[return-value]


def _require(types: dict[str, dict[str, Any]], constraint: Mapping[str, Any], where: str, dropped: list[str]) -> None:
    """Apply one Neo4j constraint: EXISTENCE and KEY mark properties required; uniqueness is not modeled.

    @param types (dict[str, dict[str, Any]]): node or relationship type bodies by label.
    @param constraint (Mapping[str, Any]): the constraint.
    @param where (str): its location, for messages.
    @param dropped (list[str]): the running list of dropped keys.
    @return (None): nothing; the matching property specs are updated in place.
    """
    kind = constraint.get("type")
    label = constraint.get("node_type") or constraint.get("relationship_type")
    names = list(constraint.get("property_names") or [])
    if not names and constraint.get("property_name"):
        names = [constraint["property_name"]]
    scope = f"{label}({', '.join(map(str, names))})"
    if kind not in _REQUIRED_KINDS:
        dropped.append(f"{where} {kind} on {scope}")
        return
    if kind == "KEY":
        dropped.append(f"{where} KEY uniqueness on {scope}")
    body = types.get(label) if isinstance(label, str) else None
    for name in names:
        spec = next((p for p in body["properties"] if p["name"] == name), None) if body else None
        if spec is None:
            dropped.append(f"{where} {kind} on undeclared {label}.{name}")
        else:
            spec["required"] = True


def from_neo4j(data: Mapping[str, Any]) -> dict[str, Any]:
    """Map a Neo4j graph schema JSON object to the fields of a SelfGraph schema.

    @param data (Mapping[str, Any]): node_types, relationship_types, patterns, and constraints.
    @return (dict[str, Any]): entities and relations, ready for Schema.model_validate.
    """
    data = _mapping(data, "neo4j ontology")
    dropped: list[str] = []
    _extra(data, _TOP_KEYS, "", dropped)
    nodes: dict[str, dict[str, Any]] = {}
    for i, raw in enumerate(_items(data, "node_types", "neo4j ontology")):
        body = _import_type(raw, f"node_types[{i}]", dropped)
        nodes[body["label"]] = body
    rels: dict[str, dict[str, Any]] = {}
    for i, raw in enumerate(_items(data, "relationship_types", "neo4j ontology")):
        body = _import_type(raw, f"relationship_types[{i}]", dropped)
        rels[body["label"]] = body
    ends: dict[str, tuple[list[str], list[str]]] = {}
    pairs: dict[str, set[tuple[str, str]]] = {}
    for i, raw in enumerate(_items(data, "patterns", "neo4j ontology")):
        source, rel, target = _pattern(raw, f"patterns[{i}]")
        rels.setdefault(rel, {"label": rel, "description": None, "aliases": [], "properties": []})
        froms, tos = ends.setdefault(rel, ([], []))
        froms.extend([source] if source not in froms else [])
        tos.extend([target] if target not in tos else [])
        pairs.setdefault(rel, set()).add((source, target))
    for rel, (froms, tos) in ends.items():
        if len(pairs[rel]) < len(froms) * len(tos):
            dropped.append(f"patterns for {rel} widened to every source and target pair")
    for i, raw in enumerate(_items(data, "constraints", "neo4j ontology")):
        constraint = _mapping(raw, f"constraints[{i}]")
        _require(nodes if constraint.get("node_type") else rels, constraint, f"constraints[{i}]", dropped)
    if dropped:
        _log.warning("neo4j ontology: dropped what SelfGraph does not model: %s", ", ".join(dropped))
    entities = [
        {"name": b["label"], "description": b["description"], "aliases": b["aliases"], "properties": b["properties"]}
        for b in nodes.values()
    ]
    relations = []
    for label, b in rels.items():
        froms, tos = ends.get(label, ([], []))
        relations.append(
            {
                "type": label,
                "description": b["description"],
                "aliases": b["aliases"],
                "from": {"types": froms},
                "to": {"types": tos},
                "properties": b["properties"],
            }
        )
    return {"entities": entities, "relations": relations}


def _export_type(label: str, spec: Any, scope: str, constraints: list, dropped: list[str]) -> dict[str, Any]:
    """Render one SelfGraph entity or relation type as a Neo4j type, collecting its EXISTENCE constraints.

    @param label (str): the type name.
    @param spec (Any): the EntityType or RelationType; aliases are kept as an extra aliases key when present.
    @param scope (str): "node_type" or "relationship_type".
    @param constraints (list): the running constraints, extended with one per required property.
    @param dropped (list[str]): the running list of dropped fields, extended with each json-typed property.
    @return (dict[str, Any]): the Neo4j type.
    """
    out: dict[str, Any] = {"label": label, "description": spec.description or ""}
    if spec.aliases:
        out["aliases"] = list(spec.aliases)
    out["properties"] = [
        {"name": p.name, "type": EXPORT_TYPES[p.type], "description": p.description or ""} for p in spec.properties
    ]
    constraints.extend(
        {"type": "EXISTENCE", "property_names": [p.name], scope: label} for p in spec.properties if p.required
    )
    dropped.extend(f"{label}.{p.name} json type (exported as STRING)" for p in spec.properties if p.type == "json")
    return out


def to_neo4j(schema: Schema | Mapping[str, Any]) -> dict[str, Any]:
    """Render a SelfGraph schema, or a raw schema object, as a Neo4j graph schema JSON object.

    @param schema (Schema | Mapping[str, Any]): the schema, or a raw object that is parsed (ValidationError if invalid).
    @return (dict[str, Any]): node_types, relationship_types, patterns, and constraints.
    """
    from .schema import Schema, as_schema

    if not isinstance(schema, Schema):
        _mapping(schema, "schema")
        schema = as_schema(schema)
    dropped: list[str] = [key for key in ("name", "version") if getattr(schema, key) is not None]
    nodes, rels, patterns, constraints = [], [], [], []
    for e in schema.entities:
        if e.parent is not None:
            dropped.append(f"{e.name}.parent")
        nodes.append(_export_type(e.name, e, "node_type", constraints, dropped))
    for r in schema.relations:
        patterns.extend([source, r.type, target] for source in r.from_.types for target in r.to.types)
        if bool(r.from_.types) != bool(r.to.types):
            dropped.append(f"{r.type} endpoint types on one side only")
        for side, end in (("from", r.from_), ("to", r.to)):
            if end.min_count is not None or end.max_count is not None:
                dropped.append(f"{r.type}.{side} cardinality")
        rels.append(_export_type(r.type, r, "relationship_type", constraints, dropped))
    if dropped:
        _log.warning("neo4j ontology: no Neo4j counterpart for: %s", ", ".join(dropped))
    return {"node_types": nodes, "relationship_types": rels, "patterns": patterns, "constraints": constraints}
