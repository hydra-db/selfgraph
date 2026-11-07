import { z } from "zod";

import { ValidationError } from "./errors.js";
import { entityId, normalizeRelType } from "./ids.js";
import { pyRepr } from "./internal/py.js";
import {
  type InsertWarning,
  insertWarning,
  optNumber,
  optString,
  type ParsedOntology,
  parseOrThrow,
} from "./models.js";

const PropertyTypeSchema = z.enum(["string", "integer", "float", "boolean", "datetime", "json"]);
export type PropertyType = z.infer<typeof PropertyTypeSchema>;
export const SCHEMA_MODES = ["off", "warn", "strict"] as const;
export type SchemaMode = (typeof SCHEMA_MODES)[number];

export const PropertySpec = z.object({
  name: z.string(),
  type: PropertyTypeSchema.default("string"),
  required: z.boolean().default(false),
  description: optString,
});

export const EntityType = z.object({
  name: z.string(),
  description: optString,
  aliases: z.array(z.string()).default([]),
  properties: z.array(PropertySpec).default([]),
  parent: optString,
});

export const RelationEndpoint = z.object({
  types: z.array(z.string()).default([]),
  min_count: optNumber,
  max_count: optNumber,
});

export const RelationType = z.object({
  type: z.string(),
  description: optString,
  aliases: z.array(z.string()).default([]),
  from: RelationEndpoint.default({ types: [], min_count: null, max_count: null }),
  to: RelationEndpoint.default({ types: [], min_count: null, max_count: null }),
  properties: z.array(PropertySpec).default([]),
});

export const Schema = z.object({
  name: optString,
  version: optString,
  entities: z.array(EntityType).default([]),
  relations: z.array(RelationType).default([]),
});

export type Schema = z.input<typeof Schema>;
export type ParsedSchema = z.output<typeof Schema>;
type ParsedEntityType = z.output<typeof EntityType>;
type ParsedRelationType = z.output<typeof RelationType>;
type ParsedPropertySpec = z.output<typeof PropertySpec>;
type ParsedEndpoint = z.output<typeof RelationEndpoint>;

/**
 * Coerce a schema argument: a parsed schema passes through, an object is validated, null stays null.
 *
 * @param value (Schema | ParsedSchema | null | undefined): the schema argument.
 * @return (ParsedSchema | null): the parsed schema, or null.
 */
export function asSchema(value: Schema | ParsedSchema | null | undefined): ParsedSchema | null {
  if (value === null || value === undefined) return null;
  return parseOrThrow(Schema, value, "schema");
}

/**
 * Reject a schema mode other than off, warn, or strict.
 *
 * @param mode (unknown): the schema mode.
 */
export function requireSchemaMode(mode: unknown): void {
  if (!(SCHEMA_MODES as readonly unknown[]).includes(mode)) {
    throw new ValidationError(`schema_mode must be one of ${SCHEMA_MODES.join(", ")}, got ${pyRepr(mode)}`);
  }
}

/**
 * Map each entity type name and alias to its type.
 *
 * @param schema (ParsedSchema): the schema.
 * @return (Map<string, ParsedEntityType>): name and alias to type.
 */
function entityIndex(schema: ParsedSchema): Map<string, ParsedEntityType> {
  const index = new Map<string, ParsedEntityType>();
  for (const entity of schema.entities) {
    index.set(entity.name, entity);
    for (const alias of entity.aliases) index.set(alias, entity);
  }
  return index;
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
 * Report whether an entity type is the target or descends from it through declared parents.
 *
 * @param entity (ParsedEntityType): the starting type.
 * @param target (string): the ancestor type name to reach.
 * @param index (Map<string, ParsedEntityType>): the entity type index.
 * @return (boolean): true when entity is or descends from target.
 */
function isA(entity: ParsedEntityType, target: string, index: Map<string, ParsedEntityType>): boolean {
  const seen = new Set<string>();
  let current: ParsedEntityType | undefined = entity;
  while (current !== undefined && !seen.has(current.name)) {
    if (current.name === target) return true;
    seen.add(current.name);
    current = current.parent !== null ? index.get(current.parent) : undefined;
  }
  return false;
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
  if (expected === "string" || expected === "datetime") return typeof value === "string";
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
 * @param ontology (ParsedOntology): the ontology to check.
 * @param schema (ParsedSchema): the schema to check against.
 * @return (InsertWarning[]): the warnings, entities first then relations then cardinality.
 */
export function validateAgainstSchema(ontology: ParsedOntology, schema: ParsedSchema): InsertWarning[] {
  const entities = entityIndex(schema);
  const relations = relationIndex(schema);
  const warnings: InsertWarning[] = [];

  const typeOfId = new Map<string, ParsedEntityType>();
  for (const ent of ontology.entities) {
    const matched = entities.get(ent.type);
    const ref = ent.id || `${ent.type}:${ent.name}`;
    if (matched === undefined) {
      if (entities.size)
        warnings.push(insertWarning("unknown_entity_type", `entity ${ref} has unknown type ${pyRepr(ent.type)}`));
    } else {
      typeOfId.set(ent.id || entityId(ent.type, ent.name), matched);
      warnings.push(...checkProperties("entity", ref, ent.properties, matched.properties));
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
    const sides: Array<[string, ParsedEndpoint, string]> = [
      ["from", matched.from, rel.from_entity],
      ["to", matched.to, rel.to_entity],
    ];
    for (const [side, endpoint, eid] of sides) {
      const endType = typeOfId.get(eid);
      const mismatch = endType !== undefined && !endpoint.types.some((t) => isA(endType, t, entities));
      if (endpoint.types.length && mismatch) {
        warnings.push(
          insertWarning(
            "endpoint_type_violation",
            `relation ${ref} ${side} entity ${eid} is not one of ${pyRepr(endpoint.types)}`,
          ),
        );
      }
      const key = `${rtype}\x1f${side}\x1f${eid}`;
      const existing = counts.get(key);
      if (existing) existing.n += 1;
      else counts.set(key, { rtype, side, eid, n: 1 });
    }
    warnings.push(...checkProperties("relation", ref, rel.properties, matched.properties));
  }

  for (const relation of schema.relations) {
    const rtype = normalizeRelType(relation.type);
    for (const [side, endpoint] of [
      ["from", relation.from],
      ["to", relation.to],
    ] as Array<[string, ParsedEndpoint]>) {
      if (endpoint.min_count === null && endpoint.max_count === null) continue;
      for (const { rtype: ctype, side: cside, eid, n } of counts.values()) {
        if (ctype !== rtype || cside !== side) continue;
        if (endpoint.min_count !== null && n < endpoint.min_count) {
          warnings.push(
            insertWarning(
              "cardinality_violation",
              `${eid} has ${n} ${rtype} (${side}) in this insert, below min ${endpoint.min_count}`,
            ),
          );
        }
        if (endpoint.max_count !== null && n > endpoint.max_count) {
          warnings.push(
            insertWarning(
              "cardinality_violation",
              `${eid} has ${n} ${rtype} (${side}) in this insert, above max ${endpoint.max_count}`,
            ),
          );
        }
      }
    }
  }
  return warnings;
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
