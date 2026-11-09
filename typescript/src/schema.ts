import { z } from "zod";

import { ValidationError } from "./errors.js";
import { canonicalId, entityId, normalizeRelType, normalizeText, relationId, slug } from "./ids.js";
import { casefold } from "./internal/casefold.js";
import { log } from "./internal/log.js";
import { pyRepr } from "./internal/py.js";
import {
  asInput,
  type InsertWarning,
  insertWarning,
  type JsonObject,
  optNumber,
  optString,
  type ParsedOntology,
} from "./models.js";
import { cleanText, getEntity, type RelationCap } from "./ops.js";
import type { GraphPrimitives } from "./protocols.js";
import { parseTime } from "./validate.js";

const PropertyTypeSchema = z.enum(["string", "integer", "float", "boolean", "datetime", "json"]);
export type PropertyType = z.infer<typeof PropertyTypeSchema>;
export const SCHEMA_MODES = ["off", "warn", "strict"] as const;
export type SchemaMode = (typeof SCHEMA_MODES)[number];
export const CONTRADICTION_MODES = ["off", "warn", "supersede"] as const;
export type ContradictionMode = (typeof CONTRADICTION_MODES)[number];

export const PropertySpec = z.strictObject({
  name: z.string(),
  type: PropertyTypeSchema.default("string"),
  required: z.boolean().default(false),
  description: optString,
});

export const EntityType = z.strictObject({
  name: z.string(),
  description: optString,
  aliases: z.array(z.string()).default([]),
  properties: z.array(PropertySpec).default([]),
  parent: optString,
});

export const RelationEndpoint = z.strictObject({
  types: z.array(z.string()).default([]),
  min_count: optNumber,
  max_count: optNumber,
});

export const RelationType = z.strictObject({
  type: z.string(),
  description: optString,
  aliases: z.array(z.string()).default([]),
  from: RelationEndpoint.default({ types: [], min_count: null, max_count: null }),
  to: RelationEndpoint.default({ types: [], min_count: null, max_count: null }),
  properties: z.array(PropertySpec).default([]),
});

const SchemaObject = z.strictObject({
  name: optString,
  version: optString,
  entities: z.array(EntityType).default([]),
  relations: z.array(RelationType).default([]),
});

export const Schema = SchemaObject.superRefine((schema, ctx) => {
  const problem = schemaProblem(schema);
  if (problem !== null) ctx.addIssue({ code: "custom", path: problem[0], message: problem[1] });
});

export type Schema = z.input<typeof Schema>;
export type ParsedSchema = z.output<typeof Schema>;
type ParsedEntityType = z.output<typeof EntityType>;
type ParsedRelationType = z.output<typeof RelationType>;
type ParsedPropertySpec = z.output<typeof PropertySpec>;
type ParsedEndpoint = z.output<typeof RelationEndpoint>;

const entityRef = (ent: { id: string | null; type: string; name: string }): string =>
  ent.id || entityId(ent.type, ent.name);

export interface SchemaSubject {
  entities: ReadonlyArray<{ id: string | null; type: string; name: string; properties: JsonObject }>;
  relations: ReadonlyArray<{
    id: string | null;
    from_entity: string;
    type: string;
    to_entity: string;
    properties: JsonObject;
  }>;
}

interface SchemaCheckOptions {
  graphTypes?: ReadonlyMap<string, string>;
  cardinality?: boolean;
  maxCount?: boolean;
}

/**
 * Coerce a schema argument: a parsed schema passes through, an object is validated, null stays null.
 *
 * @param value (Schema | ParsedSchema | null | undefined): the schema argument.
 * @return (ParsedSchema | null): the parsed schema, or null.
 */
export function asSchema(value: Schema | ParsedSchema | null | undefined): ParsedSchema | null {
  return asInput(Schema, value, "schema");
}

/**
 * Reject a mode name outside its allowed set.
 *
 * @param field (string): the option name, for the error.
 * @param mode (unknown): the mode.
 * @param modes (readonly string[]): the allowed modes, in the order the error lists them.
 */
export function requireMode(field: string, mode: unknown, modes: readonly string[]): void {
  if (!(modes as readonly unknown[]).includes(mode)) {
    throw new ValidationError(`${field} must be one of ${modes.join(", ")}, got ${pyRepr(mode)}`);
  }
}

/**
 * Reject a schema mode other than off, warn, or strict.
 *
 * @param mode (unknown): the schema mode.
 */
export function requireSchemaMode(mode: unknown): void {
  requireMode("schema_mode", mode, SCHEMA_MODES);
}

/**
 * Reject strict schema mode when no schema is set, since there is nothing to be strict about.
 *
 * @param mode (unknown): the schema mode.
 * @param schema (unknown): the schema, a schema source, or null.
 */
export function requireSchemaForMode(mode: unknown, schema: unknown): void {
  if (mode === "strict" && schema == null) throw new ValidationError("schema_mode 'strict' needs a schema");
}

/**
 * Reject a contradiction mode other than off, warn, or supersede.
 *
 * @param mode (unknown): the contradiction mode.
 */
export function requireContradictionMode(mode: unknown): void {
  requireMode("contradiction", mode, CONTRADICTION_MODES);
}

/**
 * Collect the max_count limits a contradiction check enforces, keyed by normalized relation type and alias.
 *
 * @param schema (ParsedSchema | null): the active schema.
 * @return (Map<string, RelationCap>): each constrained type's canonical type, stored type names, and limits.
 */
export function contradictionCaps(schema: ParsedSchema | null): Map<string, RelationCap> {
  const caps = new Map<string, RelationCap>();
  for (const relation of schema?.relations ?? []) {
    const limits: Array<[string, number]> = [];
    for (const side of ["from", "to"] as const) {
      const max = relation[side].max_count;
      if (max !== null) limits.push([side, max]);
    }
    const canonical = normalizeRelType(relation.type);
    const names = [...new Set([canonical, ...relation.aliases.map(normalizeRelType)])];
    for (const name of names) {
      if (limits.length) caps.set(name, { canonical, types: names, limits });
      else caps.delete(name);
    }
  }
  return caps;
}

/**
 * Map each entity type name and alias to its type.
 *
 * @param schema (ParsedSchema): the schema.
 * @return (Map<string, ParsedEntityType>): name and alias to type.
 */
export function entityIndex(schema: ParsedSchema): Map<string, ParsedEntityType> {
  const index = new Map<string, ParsedEntityType>();
  for (const entity of schema.entities) {
    index.set(entity.name, entity);
    for (const alias of entity.aliases) index.set(alias, entity);
  }
  return index;
}

/**
 * Find the first inconsistency in a schema: a duplicate type, an unknown or cyclic parent, or a bad count.
 *
 * Entity type names are compared ignoring case and relation types after normalization. A max_count must be at least
 * 1, a min_count at least 0, and a min_count no greater than the max_count on the same side.
 *
 * @param schema (z.output<typeof SchemaObject>): the schema.
 * @return ([Array<string | number>, string] | null): the path and message of the first problem, or null.
 */
function schemaProblem(schema: z.output<typeof SchemaObject>): [Array<string | number>, string] | null {
  const names = new Set<string>();
  for (const [i, entity] of schema.entities.entries()) {
    if (names.has(casefold(entity.name))) {
      return [["entities", i, "name"], `duplicate entity type ${pyRepr(entity.name)}`];
    }
    names.add(casefold(entity.name));
  }
  const index = entityIndex(schema);
  for (const [i, entity] of schema.entities.entries()) {
    if (entity.parent == null) continue;
    let current = index.get(entity.parent);
    if (current === undefined) return [["entities", i, "parent"], `unknown type ${pyRepr(entity.parent)}`];
    const chain = [entity.name];
    const seen = new Set([entity.name]);
    while (current !== undefined) {
      chain.push(current.name);
      if (current.name === entity.name) {
        return [["entities", i, "parent"], `parent cycle ${chain.map((n) => pyRepr(n)).join(" -> ")}`];
      }
      if (seen.has(current.name)) break;
      seen.add(current.name);
      current = current.parent == null ? undefined : index.get(current.parent);
    }
  }
  const types = new Set<string>();
  for (const [i, relation] of schema.relations.entries()) {
    let rtype: string | null = null;
    try {
      rtype = normalizeRelType(relation.type);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
    }
    if (rtype !== null && types.has(rtype)) {
      return [["relations", i, "type"], `duplicate relation type ${pyRepr(relation.type)}`];
    }
    if (rtype !== null) types.add(rtype);
    for (const side of ["from", "to"] as const) {
      const { min_count: min, max_count: max } = relation[side];
      if (max != null && max < 1) return [["relations", i, side, "max_count"], "must be >= 1"];
      if (min != null && min < 0) return [["relations", i, side, "min_count"], "must be >= 0"];
      if (min != null && max != null && min > max) {
        return [["relations", i, side, "min_count"], `min_count ${min} is greater than max_count ${max}`];
      }
    }
  }
  return null;
}

/**
 * Map each normalized relation type and alias to its type.
 *
 * @param schema (ParsedSchema): the schema.
 * @return (Map<string, ParsedRelationType>): normalized type and alias to type.
 */
function relationIndex(schema: ParsedSchema): Map<string, ParsedRelationType> {
  const index = new Map<string, ParsedRelationType>();
  for (const relation of schema.relations) {
    index.set(normalizeRelType(relation.type), relation);
    for (const alias of relation.aliases) index.set(normalizeRelType(alias), relation);
  }
  return index;
}

/**
 * Rename an entity type written as a schema type name or alias, in any letter case, to the schema's type name.
 *
 * An exact match wins; otherwise the first schema name or alias that matches ignoring case, in schema order.
 *
 * @param etype (string): the cleaned entity type.
 * @param schema (ParsedSchema | null): the active schema.
 * @return (string): the schema type name for a name or alias, else the type unchanged.
 */
export function canonicalEntityType(etype: string, schema: ParsedSchema | null): string {
  if (schema === null) return etype;
  const index = entityIndex(schema);
  const folded = casefold(etype);
  const matched = index.get(etype) ?? [...index].find(([name]) => casefold(name) === folded)?.[1];
  return matched?.name ?? etype;
}

/**
 * Rewrite an explicit entity id whose prefix is another name or alias of its own schema type to the canonical id. For an entity typed Company or org, where org is an alias of Company, the id org:acme becomes company:acme. A prefix that names a different type is left as is, so the id check rejects it.
 *
 * @param eid (T): the explicit entity id as given.
 * @param etype (string): the cleaned entity type as given.
 * @param schema (ParsedSchema | null): the active schema.
 * @return (T): the canonical entity id, or eid canonicalized but otherwise unchanged.
 */
export function canonicalEntityRef<T>(eid: T, etype: string, schema: ParsedSchema | null): T {
  const id = canonicalId(eid);
  if (schema === null || typeof id !== "string" || !id.includes(":")) return id;
  const canonical = canonicalEntityType(etype, schema);
  const forms = [etype, canonical, ...(entityIndex(schema).get(canonical)?.aliases ?? [])];
  const at = id.indexOf(":");
  const prefix = id.slice(0, at);
  const target = slug(normalizeText(canonical));
  if (prefix !== target && forms.some((form) => slug(normalizeText(form)) === prefix)) {
    return `${target}:${id.slice(at + 1)}` as T;
  }
  return id;
}

/**
 * Rename a relation type written as a schema alias to the schema's normalized type.
 *
 * @param rtype (string): the relation type.
 * @param schema (ParsedSchema | null): the active schema.
 * @return (string): the normalized schema type for an alias, else the type unchanged.
 */
export function canonicalRelationType(rtype: string, schema: ParsedSchema | null): string {
  const matched = schema === null ? undefined : relationIndex(schema).get(normalizeRelType(rtype));
  if (matched === undefined || normalizeRelType(matched.type) === normalizeRelType(rtype)) return rtype;
  return normalizeRelType(matched.type);
}

/**
 * Rename entity and relation types written as schema aliases to the schema names before ids are derived. References elsewhere in the ontology to an entity's derived id under any name or alias of its schema type (such as org:acme for an entity typed Company or org) follow the canonical id, and so do references to a renamed relation's derived id. An explicit entity id in such an alias form is rewritten the same way.
 *
 * @param ontology (ParsedOntology): the ontology.
 * @param schema (ParsedSchema | null): the active schema.
 * @return (ParsedOntology): the ontology with canonical types.
 */
export function canonicalizeTypes(ontology: ParsedOntology, schema: ParsedSchema | null): ParsedOntology {
  if (schema === null) return ontology;
  const forms = new Map(schema.entities.map((t) => [t.name, [t.name, ...t.aliases]]));
  let moved = new Map<string, string>();
  const entities = ontology.entities.map((ent) => {
    const etype = cleanText(ent.type);
    const canonical = canonicalEntityType(etype, schema);
    const next = canonical === etype ? ent : { ...ent, type: canonical };
    if (!ent.id) {
      const name = cleanText(ent.name);
      const target = entityId(canonical, name);
      for (const form of [etype, ...(forms.get(canonical) ?? [])]) {
        const alt = entityId(form, name);
        if (alt !== target && !moved.has(alt)) moved.set(alt, target);
      }
      return next;
    }
    const target = canonicalEntityRef(ent.id, etype, schema);
    if (target === ent.id) return next;
    if (!moved.has(ent.id)) moved.set(ent.id, target);
    return { ...next, id: target };
  });
  if (moved.size) {
    const kept = new Set(entities.map((ent) => ent.id || entityId(cleanText(ent.type), cleanText(ent.name))));
    moved = new Map([...moved].filter(([old]) => !kept.has(old)));
  }
  const m = <T extends string | null>(eid: T): T => (eid === null ? eid : ((moved.get(eid) ?? eid) as T));
  const steps = new Map<string, string>();
  const relations = ontology.relations.map((rel) => {
    const rtype = canonicalRelationType(rel.type, schema);
    const next = { ...rel, type: rtype, from_entity: m(rel.from_entity), to_entity: m(rel.to_entity) };
    if (!rel.id && (rtype !== rel.type || next.from_entity !== rel.from_entity || next.to_entity !== rel.to_entity)) {
      steps.set(
        relationId(rel.from_entity, rel.type, rel.to_entity),
        relationId(next.from_entity, rtype, next.to_entity),
      );
    }
    return next;
  });
  const preferences = ontology.preferences.map((p) => ({
    ...p,
    subject_entity: m(p.subject_entity),
    value_entity: m(p.value_entity),
    about_entity: m(p.about_entity),
  }));
  const decisions = ontology.decisions.map((d) => ({
    ...d,
    actor_entity: m(d.actor_entity),
    outcome_entity: m(d.outcome_entity),
    alternative_entities: d.alternative_entities.map(m),
    steps: d.steps.map((s) => steps.get(s) ?? s),
  }));
  return { ...ontology, entities, relations, preferences, decisions };
}

/**
 * Yield an entity type and then each declared ancestor, stopping at a missing parent or a cycle.
 *
 * @param entity (ParsedEntityType): the starting type.
 * @param index (Map<string, ParsedEntityType>): the entity type index.
 * @return (Generator<ParsedEntityType>): the type, then its parent chain.
 */
export function* lineage(entity: ParsedEntityType, index: Map<string, ParsedEntityType>): Generator<ParsedEntityType> {
  const seen = new Set<string>();
  let current: ParsedEntityType | undefined = entity;
  while (current !== undefined && !seen.has(current.name)) {
    yield current;
    seen.add(current.name);
    current = current.parent !== null ? index.get(current.parent) : undefined;
  }
}

/**
 * Collect an entity type's property specs with those inherited through parents, the nearest declaration winning.
 *
 * @param entity (ParsedEntityType): the type.
 * @param index (Map<string, ParsedEntityType>): the entity type index.
 * @return (ParsedPropertySpec[]): own specs first, then each ancestor's specs not already declared.
 */
function propertySpecs(entity: ParsedEntityType, index: Map<string, ParsedEntityType>): ParsedPropertySpec[] {
  const specs = new Map<string, ParsedPropertySpec>();
  for (const current of lineage(entity, index)) {
    for (const spec of current.properties) if (!specs.has(spec.name)) specs.set(spec.name, spec);
  }
  return [...specs.values()];
}

/**
 * Report whether a JSON property value loosely matches a declared property type.
 *
 * @param value (unknown): the property value.
 * @param expected (PropertyType): the declared type.
 * @return (boolean): true when the value is acceptable.
 */
function typeOk(value: unknown, expected: PropertyType): boolean {
  if (value === null || value === undefined || expected === "json") return true;
  if (expected === "datetime") {
    if (typeof value !== "string") return false;
    try {
      parseTime(value, "value");
      return true;
    } catch {
      return false;
    }
  }
  if (expected === "string") return typeof value === "string";
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "float") return typeof value === "number";
  return true;
}

/**
 * Check an instance's properties against its declared property specs.
 *
 * @param kind (string): the object kind for messages.
 * @param ref (string): the instance identifier for messages.
 * @param properties (Record<string, unknown>): the instance properties.
 * @param specs (readonly ParsedPropertySpec[]): the declared specs.
 * @return (InsertWarning[]): the warnings.
 */
function checkProperties(
  kind: string,
  ref: string,
  properties: Record<string, unknown>,
  specs: readonly ParsedPropertySpec[],
): InsertWarning[] {
  const warnings: InsertWarning[] = [];
  for (const spec of specs) {
    if (spec.required && !(spec.name in properties)) {
      warnings.push(
        insertWarning("missing_required_property", `${kind} ${ref} is missing required property ${pyRepr(spec.name)}`),
      );
    }
  }
  for (const spec of specs) {
    if (spec.name in properties && !typeOk(properties[spec.name], spec.type)) {
      warnings.push(
        insertWarning("property_type_mismatch", `${kind} ${ref} property ${pyRepr(spec.name)} should be ${spec.type}`),
      );
    }
  }
  return warnings;
}

/**
 * Check an ontology against a schema and return advisory warnings in a stable order.
 *
 * @param ontology (SchemaSubject): the ontology to check.
 * @param schema (ParsedSchema): the schema to check against.
 * @param options (SchemaCheckOptions): the stored type of each relation endpoint outside the ontology, whether to count relations per endpoint against min_count and max_count (default true), and whether to report counts above max_count, which a contradiction check reports instead (default true).
 * @return (InsertWarning[]): the warnings, entities first then relations then cardinality.
 */
export function validateAgainstSchema(
  ontology: SchemaSubject,
  schema: ParsedSchema,
  options: SchemaCheckOptions = {},
): InsertWarning[] {
  const entities = entityIndex(schema);
  const relations = relationIndex(schema);
  const warnings: InsertWarning[] = [];

  const typeOfId = new Map<string, ParsedEntityType>();
  const rawTypeOfId = new Map<string, string>(options.graphTypes ?? []);
  for (const [eid, etype] of rawTypeOfId) {
    const matched = entities.get(etype);
    if (matched !== undefined) typeOfId.set(eid, matched);
  }
  for (const ent of ontology.entities) {
    const matched = entities.get(ent.type);
    const ref = entityRef(ent);
    rawTypeOfId.set(ref, ent.type);
    if (matched === undefined) {
      if (entities.size)
        warnings.push(insertWarning("unknown_entity_type", `entity ${ref} has unknown type ${pyRepr(ent.type)}`));
    } else {
      typeOfId.set(ref, matched);
      warnings.push(...checkProperties("entity", ref, ent.properties, propertySpecs(matched, entities)));
    }
  }

  const counts = new Map<string, { rtype: string; side: string; eid: string; n: number }>();
  for (const rel of ontology.relations) {
    const rtype = normalizeRelType(rel.type);
    const matched = relations.get(rtype);
    const ref = rel.id || `${rel.from_entity} -${rtype}-> ${rel.to_entity}`;
    if (matched === undefined) {
      if (relations.size)
        warnings.push(insertWarning("unknown_relation_type", `relation ${ref} has unknown type ${pyRepr(rtype)}`));
      continue;
    }
    const canonical = normalizeRelType(matched.type);
    const sides: Array<[string, ParsedEndpoint, string]> = [
      ["from", matched.from, rel.from_entity],
      ["to", matched.to, rel.to_entity],
    ];
    for (const [side, endpoint, eid] of sides) {
      const endType = typeOfId.get(eid);
      const rawType = rawTypeOfId.get(eid);
      const mismatch =
        endType !== undefined
          ? ![...lineage(endType, entities)].some((t) => endpoint.types.includes(t.name))
          : rawType !== undefined && !endpoint.types.includes(rawType);
      if (endpoint.types.length && mismatch) {
        warnings.push(
          insertWarning(
            "endpoint_type_violation",
            `relation ${ref} ${side} entity ${eid} is not one of ${pyRepr(endpoint.types)}`,
          ),
        );
      }
      const key = `${canonical}\x1f${side}\x1f${eid}`;
      const existing = counts.get(key);
      if (existing) existing.n += 1;
      else counts.set(key, { rtype: canonical, side, eid, n: 1 });
    }
    warnings.push(...checkProperties("relation", ref, rel.properties, matched.properties));
  }

  for (const relation of options.cardinality === false ? [] : schema.relations) {
    const rtype = normalizeRelType(relation.type);
    for (const side of ["from", "to"] as const) {
      const { min_count: low, max_count: high } = relation[side];
      if (low === null && high === null) continue;
      for (const { rtype: ctype, side: cside, eid, n } of counts.values()) {
        if (ctype !== rtype || cside !== side) continue;
        const bounds: Array<[string, number | null, boolean]> = [
          ["below min", low, low !== null && n < low],
          ["above max", high, options.maxCount !== false && high !== null && n > high],
        ];
        for (const [bound, limit, broken] of bounds) {
          if (broken) {
            warnings.push(
              insertWarning(
                "cardinality_violation",
                `${eid} has ${n} ${rtype} (${side}) in this insert, ${bound} ${limit}`,
              ),
            );
          }
        }
      }
    }
  }
  return warnings;
}

/**
 * Check a pending write against the schema, looking up stored endpoint types, and apply the schema mode.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param ontology (SchemaSubject): the state about to be written.
 * @param schema (ParsedSchema | null): the active schema.
 * @param mode (SchemaMode): off skips the check, warn returns the warnings, strict throws on any.
 * @param cardinality (boolean): whether to count relations per endpoint against min_count and max_count.
 * @param maxCount (boolean): whether to report counts above max_count, which a contradiction check reports instead.
 * @param before (SchemaSubject | null): the stored state an update replaces, or null for a new write; only the warnings the update introduces then count, in both warn and strict mode.
 * @return (InsertWarning[]): the warnings, empty when off or clean.
 */
export async function enforceSchema(
  runner: GraphPrimitives,
  ns: string,
  ontology: SchemaSubject,
  schema: ParsedSchema | null,
  mode: SchemaMode,
  cardinality = true,
  maxCount = true,
  before: SchemaSubject | null = null,
): Promise<InsertWarning[]> {
  if (schema === null || mode === "off") return [];
  const check = async (subject: SchemaSubject): Promise<InsertWarning[]> => {
    const graphTypes = await storedTypes(runner, ns, subject);
    return validateAgainstSchema(subject, schema, { graphTypes, cardinality, maxCount });
  };
  let warnings = await check(ontology);
  if (before !== null && warnings.length) {
    const known = new Set((await check(before)).map((w) => JSON.stringify([w.code, w.message])));
    warnings = warnings.filter((w) => !known.has(JSON.stringify([w.code, w.message])));
  }
  if (mode === "strict" && warnings.length) throw new ValidationError(warnings.map((w) => w.message).join("; "));
  return warnings;
}

/**
 * Look up the stored type of every relation endpoint the ontology does not define.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param ontology (SchemaSubject): the pending write.
 * @return (Map<string, string>): each stored endpoint's type by entity id.
 */
async function storedTypes(runner: GraphPrimitives, ns: string, ontology: SchemaSubject): Promise<Map<string, string>> {
  const local = new Set(ontology.entities.map(entityRef));
  const graphTypes = new Map<string, string>();
  for (const rel of ontology.relations) {
    for (const eid of [rel.from_entity, rel.to_entity]) {
      if (local.has(eid) || graphTypes.has(eid)) continue;
      const stored = await getEntity(runner, ns, eid);
      if (stored !== null) graphTypes.set(eid, stored.type);
    }
  }
  return graphTypes;
}

/**
 * Drop the extracted entities and relations a schema rejects, and whatever references a dropped one.
 *
 * Strict mode applies this to extracted data, so one off-schema guess by the extractor does not fail the insert.
 *
 * @param runner (GraphPrimitives): the graph runner.
 * @param ns (string): the namespace.
 * @param ontology (ParsedOntology): the extracted ontology, with canonical types.
 * @param schema (ParsedSchema | null): the active schema.
 * @return ([ParsedOntology, InsertWarning[]]): the kept ontology and a "dropped_off_schema" warning per drop.
 */
export async function dropOffSchema(
  runner: GraphPrimitives,
  ns: string,
  ontology: ParsedOntology,
  schema: ParsedSchema | null,
): Promise<[ParsedOntology, InsertWarning[]]> {
  if (schema === null) return [ontology, []];
  const warnings: InsertWarning[] = [];
  const dropped = new Set<string>();
  const keep = (kind: string, id: string, reasons: string[]): boolean => {
    if (reasons.length) {
      dropped.add(id);
      warnings.push(insertWarning("dropped_off_schema", `dropped extracted ${kind} ${id}: ${reasons.join("; ")}`));
    }
    return !reasons.length;
  };
  const lost = (refs: ReadonlyArray<string | null>): string[] =>
    [...new Set(refs)].filter((ref) => ref !== null && dropped.has(ref)).map((ref) => `${ref} was dropped`);
  const messages = (found: InsertWarning[]): string[] => found.map((w) => w.message);

  const entities = ontology.entities.filter((ent) =>
    keep(
      "entity",
      entityRef(ent),
      messages(validateAgainstSchema({ entities: [ent], relations: [] }, schema, { cardinality: false })),
    ),
  );
  const byId = new Map(entities.map((ent) => [entityRef(ent), ent]));
  const graphTypes = await storedTypes(runner, ns, ontology);
  const relations = ontology.relations.filter((rel) => {
    const ends = [rel.from_entity, rel.to_entity].flatMap((e) => byId.get(e) ?? []);
    const found = validateAgainstSchema({ entities: ends, relations: [rel] }, schema, {
      graphTypes,
      cardinality: false,
    });
    const gone = lost([rel.from_entity, rel.to_entity]);
    const rid = rel.id || relationId(rel.from_entity, rel.type, rel.to_entity);
    return keep("relation", rid, gone.length ? gone : messages(found));
  });
  const preferences = ontology.preferences.filter((p) =>
    keep("preference", p.id || p.key, lost([p.subject_entity, p.value_entity, p.about_entity])),
  );
  const decisions = ontology.decisions.filter((d) =>
    keep("decision", d.id || d.title, lost([d.actor_entity, d.outcome_entity, ...d.alternative_entities, ...d.steps])),
  );
  return [{ ...ontology, entities, relations, preferences, decisions }, warnings];
}

/**
 * Report schema warnings for a write that has no result to carry them, on stderr so stdout stays clean.
 *
 * @param warnings (readonly InsertWarning[]): the warnings.
 */
export function warnSchema(warnings: readonly InsertWarning[]): void {
  for (const w of warnings) log(`schema warning [${w.code}]: ${w.message}`);
}

/**
 * Render the entity and relation catalogs as compact guidance blocks for extraction prompts.
 *
 * @param schema (ParsedSchema): the schema.
 * @return ([string, string]): the entity block and relation block, empty when there is nothing to list.
 */
export function renderSchemaCatalog(schema: ParsedSchema): [string, string] {
  const entityLines = schema.entities.map((entity) => {
    const suffix = entity.aliases.length ? `. aliases: ${entity.aliases.join(", ")}` : "";
    return `- ${entity.name}: ${entity.description || "no description"}${suffix}`;
  });
  const relationLines = schema.relations.map((relation) => {
    const froms = relation.from.types.join("/") || "any";
    const tos = relation.to.types.join("/") || "any";
    return `- ${normalizeRelType(relation.type)} (${froms} -> ${tos})`;
  });
  const entityBlock = entityLines.length
    ? `Extract entities using these known types where they fit:\n${entityLines.join("\n")}`
    : "";
  const relationBlock = relationLines.length ? `Known relationship types:\n${relationLines.join("\n")}` : "";
  return [entityBlock, relationBlock];
}
