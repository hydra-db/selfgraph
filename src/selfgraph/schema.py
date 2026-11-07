from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, Field

from .ids import entity_id, normalize_rel_type
from .models import InsertWarning, Ontology

__all__ = [
    "PropertyType",
    "PropertySpec",
    "EntityType",
    "RelationEndpoint",
    "RelationType",
    "Schema",
    "SchemaMode",
    "as_schema",
    "validate_against_schema",
    "render_schema_catalog",
]

PropertyType = Literal["string", "integer", "float", "boolean", "datetime", "json"]
SchemaMode = Literal["off", "warn", "strict"]


class PropertySpec(BaseModel):
    name: str
    type: PropertyType = "string"
    required: bool = False
    description: str | None = None


class EntityType(BaseModel):
    name: str
    description: str | None = None
    aliases: list[str] = Field(default_factory=list)
    properties: list[PropertySpec] = Field(default_factory=list)
    parent: str | None = None


class RelationEndpoint(BaseModel):
    types: list[str] = Field(default_factory=list)
    min_count: int | None = None
    max_count: int | None = None


class RelationType(BaseModel):
    type: str
    description: str | None = None
    aliases: list[str] = Field(default_factory=list)
    from_: RelationEndpoint = Field(default_factory=RelationEndpoint, alias="from")
    to: RelationEndpoint = Field(default_factory=RelationEndpoint)
    properties: list[PropertySpec] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class Schema(BaseModel):
    name: str | None = None
    version: str | None = None
    entities: list[EntityType] = Field(default_factory=list)
    relations: list[RelationType] = Field(default_factory=list)


def as_schema(value: "Schema | Mapping | None") -> "Schema | None":
    """Coerce a schema argument: a Schema passes through, a mapping is validated, None stays None.

    @param value (Schema | Mapping | None): the schema argument.
    @return (Schema | None): the schema, or None.
    """
    if value is None or isinstance(value, Schema):
        return value
    return Schema.model_validate(value)


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


def _is_a(entity: EntityType, target: str, index: dict[str, EntityType]) -> bool:
    """Report whether an entity type is the target or descends from it through declared parents.

    @param entity (EntityType): the starting type.
    @param target (str): the ancestor type name to reach.
    @param index (dict[str, EntityType]): the entity type index.
    @return (bool): true when entity is or descends from target.
    """
    seen: set[str] = set()
    current: EntityType | None = entity
    while current is not None and current.name not in seen:
        if current.name == target:
            return True
        seen.add(current.name)
        current = index.get(current.parent) if current.parent is not None else None
    return False


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


def validate_against_schema(ontology: Ontology, schema: Schema) -> list[InsertWarning]:
    """Check an ontology against a schema and return advisory warnings in a stable order.

    @param ontology (Ontology): the ontology to check.
    @param schema (Schema): the schema to check against.
    @return (list[InsertWarning]): the warnings, entities first then relations then cardinality.
    """
    entities = _entity_index(schema)
    relations = _relation_index(schema)
    warnings: list[InsertWarning] = []

    type_of_id: dict[str, EntityType] = {}
    for ent in ontology.entities:
        matched = entities.get(ent.type)
        ref = ent.id or f"{ent.type}:{ent.name}"
        if matched is None:
            if entities:
                warnings.append(
                    InsertWarning(code="unknown_entity_type", message=f"entity {ref} has unknown type {ent.type!r}")
                )
        else:
            type_of_id[ent.id or entity_id(ent.type, ent.name)] = matched
            warnings.extend(_check_properties("entity", ref, ent.properties, matched.properties))

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
        for side, endpoint, eid in (("from", matched.from_, rel.from_entity), ("to", matched.to, rel.to_entity)):
            end_type = type_of_id.get(eid)
            mismatch = end_type is not None and not any(_is_a(end_type, t, entities) for t in endpoint.types)
            if endpoint.types and mismatch:
                warnings.append(
                    InsertWarning(
                        code="endpoint_type_violation",
                        message=f"relation {ref} {side} entity {eid} is not one of {endpoint.types}",
                    )
                )
            counts[(rtype, side, eid)] = counts.get((rtype, side, eid), 0) + 1
        warnings.extend(_check_properties("relation", ref, rel.properties, matched.properties))

    for relation in schema.relations:
        rtype = normalize_rel_type(relation.type)
        for side, endpoint in (("from", relation.from_), ("to", relation.to)):
            if endpoint.min_count is None and endpoint.max_count is None:
                continue
            for (ctype, cside, eid), n in counts.items():
                if ctype != rtype or cside != side:
                    continue
                if endpoint.min_count is not None and n < endpoint.min_count:
                    warnings.append(
                        InsertWarning(
                            code="cardinality_violation",
                            message=f"{eid} has {n} {rtype} ({side}) in this insert, below min {endpoint.min_count}",
                        )
                    )
                if endpoint.max_count is not None and n > endpoint.max_count:
                    warnings.append(
                        InsertWarning(
                            code="cardinality_violation",
                            message=f"{eid} has {n} {rtype} ({side}) in this insert, above max {endpoint.max_count}",
                        )
                    )
    return warnings


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
