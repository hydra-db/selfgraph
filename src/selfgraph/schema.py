import logging
from collections.abc import Iterator, Mapping
from typing import Any, ClassVar, Literal, get_args

from pydantic import Field

from . import _ops
from .errors import ValidationError
from .ids import entity_id, normalize_rel_type
from .models import InputModel, InsertWarning, Ontology, as_input

__all__ = [
    "PropertyType",
    "PropertySpec",
    "EntityType",
    "RelationEndpoint",
    "RelationType",
    "Schema",
    "SchemaMode",
    "as_schema",
    "require_schema_mode",
    "validate_against_schema",
    "enforce_schema",
    "log_schema_warnings",
    "render_schema_catalog",
]

PropertyType = Literal["string", "integer", "float", "boolean", "datetime", "json"]
SchemaMode = Literal["off", "warn", "strict"]

_log = logging.getLogger("selfgraph")


class PropertySpec(InputModel):
    input_label: ClassVar[str] = "property"

    name: str
    type: PropertyType = "string"
    required: bool = False
    description: str | None = None


class EntityType(InputModel):
    input_label: ClassVar[str] = "entity type"

    name: str
    description: str | None = None
    aliases: list[str] = Field(default_factory=list)
    properties: list[PropertySpec] = Field(default_factory=list)
    parent: str | None = None


class RelationEndpoint(InputModel):
    input_label: ClassVar[str] = "relation endpoint"

    types: list[str] = Field(default_factory=list)
    min_count: int | None = None
    max_count: int | None = None


class RelationType(InputModel):
    input_label: ClassVar[str] = "relation type"

    type: str
    description: str | None = None
    aliases: list[str] = Field(default_factory=list)
    from_: RelationEndpoint = Field(default_factory=RelationEndpoint, alias="from")
    to: RelationEndpoint = Field(default_factory=RelationEndpoint)
    properties: list[PropertySpec] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class Schema(InputModel):
    input_label: ClassVar[str] = "schema"

    name: str | None = None
    version: str | None = None
    entities: list[EntityType] = Field(default_factory=list)
    relations: list[RelationType] = Field(default_factory=list)


def as_schema(value: "Schema | Mapping | None") -> "Schema | None":
    """Coerce a schema argument: a Schema passes through, a mapping is validated, None stays None.

    @param value (Schema | Mapping | None): the schema argument.
    @return (Schema | None): the schema, or None.
    """
    return as_input(Schema, value, "schema")


def require_schema_mode(mode: object) -> None:
    """Reject a schema mode other than off, warn, or strict.

    @param mode (object): the schema mode.
    """
    if mode not in get_args(SchemaMode):
        raise ValidationError(f"schema_mode must be one of {', '.join(get_args(SchemaMode))}, got {mode!r}")


def _entity_index(schema: Schema) -> dict[str, EntityType]:
    """Map each entity type name and alias to its EntityType.

    @param schema (Schema): the schema.
    @return (dict[str, EntityType]): name and alias to type.
    """
    index: dict[str, EntityType] = {}
    for entity in schema.entities:
        index[entity.name] = entity
        for alias in entity.aliases:
            index[alias] = entity
    return index


def _relation_index(schema: Schema) -> dict[str, RelationType]:
    """Map each normalized relation type and alias to its RelationType.

    @param schema (Schema): the schema.
    @return (dict[str, RelationType]): normalized type and alias to type.
    """
    index: dict[str, RelationType] = {}
    for relation in schema.relations:
        index[normalize_rel_type(relation.type)] = relation
        for alias in relation.aliases:
            index[normalize_rel_type(alias)] = relation
    return index


def _lineage(entity: EntityType, index: dict[str, EntityType]) -> Iterator[EntityType]:
    """Yield an entity type and then each declared ancestor, stopping at a missing parent or a cycle.

    @param entity (EntityType): the starting type.
    @param index (dict[str, EntityType]): the entity type index.
    @return (Iterator[EntityType]): the type, then its parent chain.
    """
    seen: set[str] = set()
    current: EntityType | None = entity
    while current is not None and current.name not in seen:
        yield current
        seen.add(current.name)
        current = index.get(current.parent) if current.parent is not None else None


def _property_specs(entity: EntityType, index: dict[str, EntityType]) -> list[PropertySpec]:
    """Collect an entity type's property specs with those inherited through parents, the nearest declaration winning.

    @param entity (EntityType): the type.
    @param index (dict[str, EntityType]): the entity type index.
    @return (list[PropertySpec]): own specs first, then each ancestor's specs not already declared.
    """
    specs: dict[str, PropertySpec] = {}
    for current in _lineage(entity, index):
        for spec in current.properties:
            specs.setdefault(spec.name, spec)
    return list(specs.values())


def _type_ok(value: object, expected: PropertyType) -> bool:
    """Report whether a JSON property value loosely matches a declared property type.

    @param value (object): the property value.
    @param expected (PropertyType): the declared type.
    @return (bool): true when the value is acceptable.
    """
    if value is None or expected == "json":
        return True
    if expected == "string" or expected == "datetime":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "float":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def _check_properties(
    kind: str, ref: str, properties: dict[str, object], specs: list[PropertySpec]
) -> list[InsertWarning]:
    """Check an instance's properties against its declared property specs.

    @param kind (str): the object kind for messages.
    @param ref (str): the instance identifier for messages.
    @param properties (dict[str, object]): the instance properties.
    @param specs (list[PropertySpec]): the declared specs.
    @return (list[InsertWarning]): the warnings.
    """
    warnings: list[InsertWarning] = []
    for spec in specs:
        if spec.required and spec.name not in properties:
            warnings.append(
                InsertWarning(
                    code="missing_required_property",
                    message=f"{kind} {ref} is missing required property {spec.name!r}",
                )
            )
    for spec in specs:
        if spec.name in properties and not _type_ok(properties[spec.name], spec.type):
            warnings.append(
                InsertWarning(
                    code="property_type_mismatch",
                    message=f"{kind} {ref} property {spec.name!r} should be {spec.type}",
                )
            )
    return warnings


def validate_against_schema(
    ontology: Ontology,
    schema: Schema,
    *,
    graph_types: Mapping[str, str] | None = None,
    cardinality: bool = True,
) -> list[InsertWarning]:
    """Check an ontology against a schema and return advisory warnings in a stable order.

    @param ontology (Ontology): the ontology to check.
    @param schema (Schema): the schema to check against.
    @param graph_types (Mapping[str, str] | None): the stored type of each relation endpoint outside the ontology.
    @param cardinality (bool): whether to count relations per endpoint against min_count and max_count.
    @return (list[InsertWarning]): the warnings, entities first then relations then cardinality.
    """
    entities = _entity_index(schema)
    relations = _relation_index(schema)
    warnings: list[InsertWarning] = []

    type_of_id: dict[str, EntityType] = {}
    for eid, etype in (graph_types or {}).items():
        if etype in entities:
            type_of_id[eid] = entities[etype]
    for ent in ontology.entities:
        matched = entities.get(ent.type)
        eid = ent.id or entity_id(ent.type, ent.name)
        ref = ent.id or f"{ent.type}:{ent.name}"
        if matched is None:
            if entities:
                warnings.append(
                    InsertWarning(code="unknown_entity_type", message=f"entity {ref} has unknown type {ent.type!r}")
                )
        else:
            type_of_id[eid] = matched
            warnings.extend(_check_properties("entity", ref, ent.properties, _property_specs(matched, entities)))

    counts: dict[tuple[str, str, str], int] = {}
    for rel in ontology.relations:
        rtype = normalize_rel_type(rel.type)
        matched = relations.get(rtype)
        ref = rel.id or f"{rel.from_entity} -{rtype}-> {rel.to_entity}"
        if matched is None:
            if relations:
                warnings.append(
                    InsertWarning(code="unknown_relation_type", message=f"relation {ref} has unknown type {rtype!r}")
                )
            continue
        canonical = normalize_rel_type(matched.type)
        for side, endpoint, eid in (("from", matched.from_, rel.from_entity), ("to", matched.to, rel.to_entity)):
            end_type = type_of_id.get(eid)
            mismatch = end_type is not None and not any(t.name in endpoint.types for t in _lineage(end_type, entities))
            if endpoint.types and mismatch:
                warnings.append(
                    InsertWarning(
                        code="endpoint_type_violation",
                        message=f"relation {ref} {side} entity {eid} is not one of {endpoint.types}",
                    )
                )
            counts[(canonical, side, eid)] = counts.get((canonical, side, eid), 0) + 1
        warnings.extend(_check_properties("relation", ref, rel.properties, matched.properties))

    for relation in schema.relations if cardinality else ():
        rtype = normalize_rel_type(relation.type)
        for side, endpoint in (("from", relation.from_), ("to", relation.to)):
            if endpoint.min_count is None and endpoint.max_count is None:
                continue
            for (ctype, cside, eid), n in counts.items():
                if ctype != rtype or cside != side:
                    continue
                low, high = endpoint.min_count, endpoint.max_count
                for bound, limit, broken in (
                    ("below min", low, low is not None and n < low),
                    ("above max", high, high is not None and n > high),
                ):
                    if broken:
                        warnings.append(
                            InsertWarning(
                                code="cardinality_violation",
                                message=f"{eid} has {n} {rtype} ({side}) in this insert, {bound} {limit}",
                            )
                        )
    return warnings


async def enforce_schema(
    runner: Any,
    ns: str,
    ontology: Ontology,
    schema: Schema | None,
    mode: SchemaMode,
    *,
    cardinality: bool = True,
) -> list[InsertWarning]:
    """Check a pending write against the schema, looking up stored endpoint types, and apply the schema mode.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ontology (Ontology): the state about to be written.
    @param schema (Schema | None): the active schema.
    @param mode (SchemaMode): off skips the check, warn returns the warnings, strict raises on any.
    @param cardinality (bool): whether to count relations per endpoint against min_count and max_count.
    @return (list[InsertWarning]): the warnings, empty when off or clean.
    """
    if schema is None or mode == "off":
        return []
    local = {ent.id or entity_id(ent.type, ent.name) for ent in ontology.entities}
    graph_types: dict[str, str] = {}
    for rel in ontology.relations:
        for eid in (rel.from_entity, rel.to_entity):
            if eid not in local and eid not in graph_types:
                stored = await _ops.get_entity(runner, ns, eid)
                if stored is not None:
                    graph_types[eid] = stored.type
    warnings = validate_against_schema(ontology, schema, graph_types=graph_types, cardinality=cardinality)
    if mode == "strict" and warnings:
        raise ValidationError("; ".join(w.message for w in warnings))
    return warnings


def log_schema_warnings(warnings: list[InsertWarning]) -> None:
    """Log schema warnings for a write that has no result to carry them, on the selfgraph logger.

    @param warnings (list[InsertWarning]): the warnings.
    """
    for w in warnings:
        _log.warning("schema warning [%s]: %s", w.code, w.message)


def render_schema_catalog(schema: Schema) -> tuple[str, str]:
    """Render the entity and relation catalogs as compact guidance blocks for extraction prompts.

    @param schema (Schema): the schema.
    @return (tuple[str, str]): the entity block and relation block, empty when there is nothing to list.
    """
    entity_lines = []
    for entity in schema.entities:
        suffix = f". aliases: {', '.join(entity.aliases)}" if entity.aliases else ""
        desc = entity.description or "no description"
        entity_lines.append(f"- {entity.name}: {desc}{suffix}")
    relation_lines = []
    for relation in schema.relations:
        froms = "/".join(relation.from_.types) or "any"
        tos = "/".join(relation.to.types) or "any"
        relation_lines.append(f"- {normalize_rel_type(relation.type)} ({froms} -> {tos})")
    entity_block = ""
    if entity_lines:
        entity_block = "Extract entities using these known types where they fit:\n" + "\n".join(entity_lines)
    relation_block = ""
    if relation_lines:
        relation_block = "Known relationship types:\n" + "\n".join(relation_lines)
    return entity_block, relation_block
