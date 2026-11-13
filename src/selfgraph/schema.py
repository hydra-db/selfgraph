import logging
from collections.abc import Iterable, Iterator, Mapping, Sequence
from typing import Any, ClassVar, Literal, get_args

from pydantic import Field, model_validator

from . import _ops
from .errors import ValidationError
from .ids import _canonical_id, entity_id, normalize_rel_type, normalize_text, relation_id, slug
from .models import Extraction, InputModel, InsertWarning, TopInputModel, as_input

__all__ = [
    "PropertyType",
    "PropertySpec",
    "TermMapping",
    "Definition",
    "EntityType",
    "RelationEndpoint",
    "RelationType",
    "Schema",
    "SchemaMode",
    "ContradictionMode",
    "as_schema",
    "require_schema_mode",
    "require_contradiction_mode",
    "require_schema_for_mode",
    "contradiction_caps",
    "validate_against_schema",
    "enforce_schema",
    "drop_off_schema",
    "log_schema_warnings",
    "render_schema_catalog",
]

PropertyType = Literal["string", "integer", "float", "boolean", "datetime", "json"]
SchemaMode = Literal["off", "warn", "strict"]
ContradictionMode = Literal["off", "warn", "supersede", "llm"]

_log = logging.getLogger("selfgraph")


class PropertySpec(InputModel):
    input_label: ClassVar[str] = "property"

    name: str
    type: PropertyType = "string"
    required: bool = False
    description: str | None = None


class TermMapping(InputModel):
    input_label: ClassVar[str] = "mapping"

    source: str | None = None
    table: str | None = None
    column: str | None = None


class Definition(InputModel):
    input_label: ClassVar[str] = "definition"

    name: str
    expression: str
    description: str | None = None
    synonyms: list[str] = Field(default_factory=list)
    certified: bool = False


class EntityType(InputModel):
    input_label: ClassVar[str] = "entity type"

    name: str
    description: str | None = None
    aliases: list[str] = Field(default_factory=list)
    synonyms: list[str] = Field(default_factory=list)
    properties: list[PropertySpec] = Field(default_factory=list)
    parent: str | None = None
    mappings: list[TermMapping] = Field(default_factory=list)
    definitions: list[Definition] = Field(default_factory=list)
    certified: bool = False


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
    synonyms: list[str] = Field(default_factory=list)
    certified: bool = False
    from_: RelationEndpoint = Field(default_factory=RelationEndpoint, alias="from")
    to: RelationEndpoint = Field(default_factory=RelationEndpoint)
    properties: list[PropertySpec] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class Schema(TopInputModel):
    input_label: ClassVar[str] = "schema"

    name: str | None = None
    version: str | None = None
    entities: list[EntityType] = Field(default_factory=list)
    relations: list[RelationType] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_consistency(self) -> "Schema":
        """Reject a schema whose types contradict each other, naming the first problem by its path.

        Entity type names are compared ignoring case and relation types after normalization. A max_count must be
        at least 1, a min_count at least 0, and a min_count no greater than the max_count on the same side.

        @return (Schema): the schema; raises ValueError on a duplicate name, an unknown or cyclic parent, or an
            impossible endpoint count.
        """
        names: set[str] = set()
        for i, entity in enumerate(self.entities):
            if entity.name.casefold() in names:
                raise ValueError(f"entities[{i}].name: duplicate entity type {entity.name!r}")
            names.add(entity.name.casefold())
        index = _entity_index(self)
        for i, entity in enumerate(self.entities):
            if entity.parent is None:
                continue
            if entity.parent not in index:
                raise ValueError(f"entities[{i}].parent: unknown type {entity.parent!r}")
            chain, seen = [entity.name], {entity.name}
            current: EntityType | None = index[entity.parent]
            while current is not None:
                chain.append(current.name)
                if current.name == entity.name:
                    raise ValueError(f"entities[{i}].parent: parent cycle " + " -> ".join(repr(n) for n in chain))
                if current.name in seen:
                    break
                seen.add(current.name)
                current = index.get(current.parent) if current.parent is not None else None
        types: set[str] = set()
        for i, relation in enumerate(self.relations):
            try:
                rtype = normalize_rel_type(relation.type)
            except ValidationError:
                rtype = None
            if rtype in types:
                raise ValueError(f"relations[{i}].type: duplicate relation type {relation.type!r}")
            if rtype is not None:
                types.add(rtype)
            for side, end in (("from", relation.from_), ("to", relation.to)):
                at = f"relations[{i}].{side}"
                if end.max_count is not None and end.max_count < 1:
                    raise ValueError(f"{at}.max_count: must be >= 1")
                if end.min_count is not None and end.min_count < 0:
                    raise ValueError(f"{at}.min_count: must be >= 0")
                if end.min_count is not None and end.max_count is not None and end.min_count > end.max_count:
                    raise ValueError(
                        f"{at}.min_count: min_count {end.min_count} is greater than max_count {end.max_count}"
                    )
        return self

    @classmethod
    def from_tables(cls, tables: Sequence[Mapping[str, Any]], *, name: str | None = None) -> "Schema":
        """Draft a schema from relational table metadata: no rows are read and nothing is certified.

        Each table becomes an entity type named in singular PascalCase, with the table name as a synonym and a
        mapping to the table. A column becomes a property mapped to the nearest SelfGraph type, required when it
        is not nullable. A column that references another table becomes a relation type HAS_<COLUMN> from this
        table's type to the referenced one, with a max_count of 1 on the from side.

        @param tables (Sequence[Mapping[str, Any]]): each table's name, optional description, and columns; a
            column holds a name and optional type, nullable, description, and references (a table name).
        @param name (str | None): the schema name.
        @return (Schema): the draft schema.
        """
        from ._tables import from_tables

        return as_input(cls, from_tables(tables, name), "schema")

    @classmethod
    def from_neo4j_ontology(cls, data: Mapping[str, Any]) -> "Schema":
        """Build a schema from a Neo4j graph schema JSON object, as written by neo4j-graphrag's SchemaBuilder.

        Node types become entity types, relationship types become relation types, patterns become endpoint
        types, and EXISTENCE or KEY constraints mark properties required. Property types map to the nearest
        SelfGraph type, or json with a warning. What SelfGraph does not model (uniqueness, additional_*
        flags, indexes, and any other key) is dropped and listed in one warning on the selfgraph logger.

        @param data (Mapping[str, Any]): node_types, relationship_types, patterns, and constraints.
        @return (Schema): the schema.
        """
        from ._neo4j_schema import from_neo4j

        return as_input(cls, from_neo4j(data), "schema")

    def to_neo4j_ontology(self) -> dict[str, Any]:
        """Render this schema as a Neo4j graph schema JSON object, the format neo4j-graphrag reads.

        Required properties become EXISTENCE constraints and endpoint types become every source and target
        pattern. Fields with no Neo4j counterpart (name, version, parent, cardinality, json types, one-sided
        endpoints) are listed in one warning on the selfgraph logger.

        @return (dict[str, Any]): node_types, relationship_types, patterns, and constraints.
        """
        from ._neo4j_schema import to_neo4j

        return to_neo4j(self)


def as_schema(value: "Schema | Mapping | None") -> "Schema | None":
    """Coerce a schema argument: a Schema passes through, a mapping is validated, None stays None.

    @param value (Schema | Mapping | None): the schema argument.
    @return (Schema | None): the schema, or None.
    """
    return as_input(Schema, value, "schema")


def _require_mode(field: str, mode: object, modes: tuple[str, ...]) -> None:
    """Reject a mode name outside its allowed set.

    @param field (str): the option name, for the error.
    @param mode (object): the mode.
    @param modes (tuple[str, ...]): the allowed modes, in the order the error lists them.
    """
    if mode not in modes:
        raise ValidationError(f"{field} must be one of {', '.join(modes)}, got {mode!r}")


def require_schema_mode(mode: object) -> None:
    """Reject a schema mode other than off, warn, or strict.

    @param mode (object): the schema mode.
    """
    _require_mode("schema_mode", mode, get_args(SchemaMode))


def require_schema_for_mode(mode: object, schema: object) -> None:
    """Reject strict schema mode when no schema is set, since there is nothing to be strict about.

    @param mode (object): the schema mode.
    @param schema (object): the schema, a schema source, or None.
    """
    if mode == "strict" and schema is None:
        raise ValidationError("schema_mode 'strict' needs a schema")


def require_contradiction_mode(mode: object) -> None:
    """Reject a contradiction mode other than off, warn, supersede, or llm.

    @param mode (object): the contradiction mode.
    """
    _require_mode("contradiction", mode, get_args(ContradictionMode))


def contradiction_caps(schema: Schema | None) -> dict[str, _ops.RelationCap]:
    """Collect the max_count limits a contradiction check enforces, keyed by normalized relation type and alias.

    @param schema (Schema | None): the active schema.
    @return (dict[str, RelationCap]): each constrained type's canonical type, stored type names, and limits.
    """
    caps: dict[str, _ops.RelationCap] = {}
    for relation in schema.relations if schema is not None else ():
        limits = tuple(
            (side, endpoint.max_count)
            for side, endpoint in (("from", relation.from_), ("to", relation.to))
            if endpoint.max_count is not None
        )
        canonical = normalize_rel_type(relation.type)
        names = tuple(dict.fromkeys([canonical, *(normalize_rel_type(a) for a in relation.aliases)]))
        for name in names:
            if limits:
                caps[name] = _ops.RelationCap(canonical, names, limits)
            else:
                caps.pop(name, None)
    return caps


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


def canonical_entity_type(etype: str, schema: Schema | None) -> str:
    """Rename an entity type written as a schema type name or alias, in any letter case, to the schema's type name.

    An exact match wins; otherwise the first schema name or alias that matches ignoring case, in schema order.

    @param etype (str): the cleaned entity type.
    @param schema (Schema | None): the active schema.
    @return (str): the schema type name for a name or alias, else the type unchanged.
    """
    if schema is None:
        return etype
    index = _entity_index(schema)
    folded = etype.casefold()
    matched = index.get(etype) or next((t for name, t in index.items() if name.casefold() == folded), None)
    return etype if matched is None else matched.name


def canonical_entity_ref(eid: Any, etype: str, schema: Schema | None) -> Any:
    """Rewrite an explicit entity id whose prefix is another name or alias of its own schema type to the canonical id.

    For an entity typed Company or org, where org is an alias of Company, the id org:acme becomes company:acme. A
    prefix that names a different type is left as is, so the id check rejects it.

    @param eid (Any): the explicit entity id as given.
    @param etype (str): the cleaned entity type as given.
    @param schema (Schema | None): the active schema.
    @return (Any): the canonical entity id, or eid canonicalized but otherwise unchanged.
    """
    eid = _canonical_id(eid)
    if schema is None or not isinstance(eid, str) or ":" not in eid:
        return eid
    canonical = canonical_entity_type(etype, schema)
    matched = _entity_index(schema).get(canonical)
    forms = {etype, canonical, *(matched.aliases if matched is not None else ())}
    prefix, name = eid.split(":", 1)
    target = slug(normalize_text(canonical))
    if prefix != target and prefix in {slug(normalize_text(form)) for form in forms}:
        return f"{target}:{name}"
    return eid


def canonical_relation_type(rtype: str, schema: Schema | None) -> str:
    """Rename a relation type written as a schema alias to the schema's normalized type.

    @param rtype (str): the relation type.
    @param schema (Schema | None): the active schema.
    @return (str): the normalized schema type for an alias, else the type unchanged.
    """
    given = normalize_rel_type(rtype)
    matched = _relation_index(schema).get(given) if schema is not None else None
    return rtype if matched is None or normalize_rel_type(matched.type) == given else normalize_rel_type(matched.type)


def canonicalize_types(facts: Extraction, schema: Schema | None) -> Extraction:
    """Rename entity and relation types written as schema aliases to the schema names before ids are derived.

    References elsewhere in the facts to an entity's derived id under any name or alias of its schema type (such
    as org:acme for an entity typed Company or org) follow the canonical id, and so do references to a renamed
    relation's derived id. An explicit entity id in such an alias form is rewritten the same way.

    @param facts (Extraction): the facts.
    @param schema (Schema | None): the active schema.
    @return (Extraction): the facts with canonical types.
    """
    if schema is None:
        return facts
    forms = {t.name: [t.name, *t.aliases] for t in schema.entities}
    moved: dict[str, str] = {}
    entities = []
    for ent in facts.entities:
        etype = _ops._clean_text(ent.type)
        canonical = canonical_entity_type(etype, schema)
        update: dict[str, Any] = {} if canonical == etype else {"type": canonical}
        if ent.id is None:
            name = _ops._clean_text(ent.name)
            target = entity_id(canonical, name)
            for form in (etype, *forms.get(canonical, ())):
                alt = entity_id(form, name)
                if alt != target and alt not in moved:
                    moved[alt] = target
        else:
            target = canonical_entity_ref(ent.id, etype, schema)
            if target != ent.id:
                moved.setdefault(ent.id, target)
                update["id"] = target
        entities.append(ent.model_copy(update=update) if update else ent)
    if moved:
        kept = {ent.id or entity_id(_ops._clean_text(ent.type), _ops._clean_text(ent.name)) for ent in entities}
        moved = {old: new for old, new in moved.items() if old not in kept}

    def m(eid: str | None) -> str | None:
        return moved.get(eid, eid) if eid is not None else None

    steps: dict[str, str] = {}
    relations = []
    for rel in facts.relations:
        rtype = canonical_relation_type(rel.type, schema)
        new = rel.model_copy(update={"type": rtype, "from_entity": m(rel.from_entity), "to_entity": m(rel.to_entity)})
        if rel.id is None and (
            rtype != rel.type or (new.from_entity, new.to_entity) != (rel.from_entity, rel.to_entity)
        ):
            steps[relation_id(rel.from_entity, rel.type, rel.to_entity)] = relation_id(
                new.from_entity, rtype, new.to_entity
            )
        relations.append(new)
    preferences = [
        p.model_copy(
            update={
                "subject_entity": m(p.subject_entity),
                "value_entity": m(p.value_entity),
                "about_entity": m(p.about_entity),
            }
        )
        for p in facts.preferences
    ]
    decisions = [
        d.model_copy(
            update={
                "actor_entity": m(d.actor_entity),
                "outcome_entity": m(d.outcome_entity),
                "alternative_entities": [m(a) for a in d.alternative_entities],
                "steps": [steps.get(s, s) for s in d.steps],
            }
        )
        for d in facts.decisions
    ]
    return facts.model_copy(
        update={"entities": entities, "relations": relations, "preferences": preferences, "decisions": decisions}
    )


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
    if expected == "datetime":
        return isinstance(value, str) and _is_iso_time(value)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "float":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def _is_iso_time(text: str) -> bool:
    """Report whether text is an ISO 8601 date or time, as the time flags and parameters accept it.

    @param text (str): the text.
    @return (bool): True when it parses.
    """
    try:
        _ops.parse_time(text, "value")
    except ValidationError:
        return False
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
    facts: Extraction,
    schema: Schema,
    *,
    graph_types: Mapping[str, str] | None = None,
    cardinality: bool = True,
    max_count: bool = True,
) -> list[InsertWarning]:
    """Check facts against a schema and return advisory warnings in a stable order.

    @param facts (Extraction): the facts to check.
    @param schema (Schema): the schema to check against.
    @param graph_types (Mapping[str, str] | None): the stored type of each relation endpoint outside the facts.
    @param cardinality (bool): whether to count relations per endpoint against min_count and max_count.
    @param max_count (bool): whether to report counts above max_count, which a contradiction check reports instead.
    @return (list[InsertWarning]): the warnings, entities first then relations then cardinality.
    """
    entities = _entity_index(schema)
    relations = _relation_index(schema)
    warnings: list[InsertWarning] = []

    type_of_id: dict[str, EntityType] = {}
    raw_type_of_id: dict[str, str] = dict(graph_types or {})
    for eid, etype in raw_type_of_id.items():
        if etype in entities:
            type_of_id[eid] = entities[etype]
    for ent in facts.entities:
        matched = entities.get(ent.type)
        ref = eid = ent.id or entity_id(ent.type, ent.name)
        raw_type_of_id[eid] = ent.type
        if matched is None:
            if entities:
                warnings.append(
                    InsertWarning(code="unknown_entity_type", message=f"entity {ref} has unknown type {ent.type!r}")
                )
        else:
            type_of_id[eid] = matched
            warnings.extend(_check_properties("entity", ref, ent.properties, _property_specs(matched, entities)))

    counts: dict[tuple[str, str, str], int] = {}
    for rel in facts.relations:
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
            if end_type is not None:
                mismatch = not any(t.name in endpoint.types for t in _lineage(end_type, entities))
            else:
                mismatch = eid in raw_type_of_id and raw_type_of_id[eid] not in endpoint.types
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
                    ("above max", high, max_count and high is not None and n > high),
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
    facts: Extraction,
    schema: Schema | None,
    mode: SchemaMode,
    *,
    cardinality: bool = True,
    max_count: bool = True,
    before: Extraction | None = None,
) -> list[InsertWarning]:
    """Check a pending write against the schema, looking up stored endpoint types, and apply the schema mode.

    With before, the stored state an update starts from, only the warnings the update introduces count: a
    violation the stored state already had neither raises in strict mode nor is reported in warn mode.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param facts (Extraction): the state about to be written.
    @param schema (Schema | None): the active schema.
    @param mode (SchemaMode): off skips the check, warn returns the warnings, strict raises on any.
    @param cardinality (bool): whether to count relations per endpoint against min_count and max_count.
    @param max_count (bool): whether to report counts above max_count, which a contradiction check reports instead.
    @param before (Extraction | None): the stored state an update replaces, or None for a new write.
    @return (list[InsertWarning]): the warnings, empty when off or clean.
    """
    if schema is None or mode == "off":
        return []

    async def check(subject: Extraction) -> list[InsertWarning]:
        return validate_against_schema(
            subject,
            schema,
            graph_types=await _stored_types(runner, ns, subject),
            cardinality=cardinality,
            max_count=max_count,
        )

    warnings = await check(facts)
    if before is not None and warnings:
        known = {(w.code, w.message) for w in await check(before)}
        warnings = [w for w in warnings if (w.code, w.message) not in known]
    if mode == "strict" and warnings:
        raise ValidationError("; ".join(w.message for w in warnings))
    return warnings


async def _stored_types(runner: Any, ns: str, facts: Extraction) -> dict[str, str]:
    """Look up the stored type of every relation endpoint the facts do not define.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param facts (Extraction): the pending write.
    @return (dict[str, str]): each stored endpoint's type by entity id.
    """
    local = {ent.id or entity_id(ent.type, ent.name) for ent in facts.entities}
    graph_types: dict[str, str] = {}
    for rel in facts.relations:
        for eid in (rel.from_entity, rel.to_entity):
            if eid not in local and eid not in graph_types:
                stored = await _ops.get_entity(runner, ns, eid)
                if stored is not None:
                    graph_types[eid] = stored.type
    return graph_types


async def drop_off_schema(
    runner: Any, ns: str, facts: Extraction, schema: Schema | None
) -> tuple[Extraction, list[InsertWarning]]:
    """Drop the extracted entities and relations a schema rejects, and whatever references a dropped one.

    Strict mode applies this to extracted data, so one off-schema guess by the extractor does not fail the insert.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param facts (Extraction): the extracted facts, with canonical types.
    @param schema (Schema | None): the active schema.
    @return (tuple[Extraction, list[InsertWarning]]): the kept facts and a "dropped_off_schema" warning per drop.
    """
    if schema is None:
        return facts, []
    warnings: list[InsertWarning] = []
    dropped: set[str] = set()

    def keep(kind: str, oid: str, reasons: list[str]) -> bool:
        if reasons:
            dropped.add(oid)
            message = f"dropped extracted {kind} {oid}: {'; '.join(reasons)}"
            warnings.append(InsertWarning(code="dropped_off_schema", message=message))
        return not reasons

    def lost(refs: Iterable[str | None]) -> list[str]:
        return [f"{ref} was dropped" for ref in dict.fromkeys(refs) if ref in dropped]

    entities = [
        ent
        for ent in facts.entities
        if keep(
            "entity",
            ent.id or entity_id(ent.type, ent.name),
            [w.message for w in validate_against_schema(Extraction(entities=[ent]), schema, cardinality=False)],
        )
    ]
    by_id = {ent.id or entity_id(ent.type, ent.name): ent for ent in entities}
    graph_types = await _stored_types(runner, ns, facts)
    relations = []
    for rel in facts.relations:
        ends = [by_id[e] for e in (rel.from_entity, rel.to_entity) if e in by_id]
        found = validate_against_schema(
            Extraction(entities=ends, relations=[rel]), schema, graph_types=graph_types, cardinality=False
        )
        rid = rel.id or relation_id(rel.from_entity, rel.type, rel.to_entity)
        if keep("relation", rid, lost([rel.from_entity, rel.to_entity]) or [w.message for w in found]):
            relations.append(rel)
    preferences = [
        p
        for p in facts.preferences
        if keep("preference", p.id or p.key, lost([p.subject_entity, p.value_entity, p.about_entity]))
    ]
    decisions = [
        d
        for d in facts.decisions
        if keep(
            "decision",
            d.id or d.title,
            lost([d.actor_entity, d.outcome_entity, *d.alternative_entities, *d.steps]),
        )
    ]
    update = {"entities": entities, "relations": relations, "preferences": preferences, "decisions": decisions}
    return facts.model_copy(update=update), warnings


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
