import { z } from "zod";

import { ValidationError } from "./errors.js";
import { entityId, normalizeRelType } from "./ids.js";
import { pyRepr } from "./internal/py.js";
import { asInput, type InsertWarning, insertWarning, type JsonObject, optNumber, optString } from "./models.js";
import { getEntity } from "./ops.js";
import type { GraphPrimitives } from "./protocols.js";

const PropertyTypeSchema = z.enum(["string", "integer", "float", "boolean", "datetime", "json"]);
export type PropertyType = z.infer<typeof PropertyTypeSchema>;
export const SCHEMA_MODES = ["off", "warn", "strict"] as const;
export type SchemaMode = (typeof SCHEMA_MODES)[number];

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

export const Schema = z.strictObject({
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

export interface SchemaCheckOptions {
  graphTypes?: ReadonlyMap<string, string>;
  cardinality?: boolean;
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
 * Yield an entity type and then each declared ancestor, stopping at a missing parent or a cycle.
 *
 * @param entity (ParsedEntityType): the starting type.
 * @param index (Map<string, ParsedEntityType>): the entity type index.
 * @return (Generator<ParsedEntityType>): the type, then its parent chain.
 */
function* lineage(entity: ParsedEntityType, index: Map<string, ParsedEntityType>): Generator<ParsedEntityType> {
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
 * @param ontology (SchemaSubject): the ontology to check.
 * @param schema (ParsedSchema): the schema to check against.
 * @param options (SchemaCheckOptions): the stored type of each relation endpoint outside the ontology, and whether to count relations per endpoint against min_count and max_count (default true).
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
  for (const [eid, etype] of options.graphTypes ?? []) {
    const matched = entities.get(etype);
    if (matched !== undefined) typeOfId.set(eid, matched);
  }
  for (const ent of ontology.entities) {
    const matched = entities.get(ent.type);
    const ref = ent.id || `${ent.type}:${ent.name}`;
    if (matched === undefined) {
      if (entities.size)
        warnings.push(insertWarning("unknown_entity_type", `entity ${ref} has unknown type ${pyRepr(ent.type)}`));
    } else {
      typeOfId.set(ent.id || entityId(ent.type, ent.name), matched);
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
      const mismatch =
        endType !== undefined && ![...lineage(endType, entities)].some((t) => endpoint.types.includes(t.name));
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
    for (const [side, endpoint] of [
      ["from", relation.from],
      ["to", relation.to],
    ] as Array<[string, ParsedEndpoint]>) {
      if (endpoint.min_count === null && endpoint.max_count === null) continue;
      for (const { rtype: ctype, side: cside, eid, n } of counts.values()) {
        if (ctype !== rtype || cside !== side) continue;
        const { min_count: low, max_count: high } = endpoint;
        const bounds: Array<[string, number | null, boolean]> = [
          ["below min", low, low !== null && n < low],
          ["above max", high, high !== null && n > high],
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
 * @return (InsertWarning[]): the warnings, empty when off or clean.
 */
export async function enforceSchema(
  runner: GraphPrimitives,
  ns: string,
  ontology: SchemaSubject,
  schema: ParsedSchema | null,
  mode: SchemaMode,
  cardinality = true,
): Promise<InsertWarning[]> {
  if (schema === null || mode === "off") return [];
  const local = new Set(ontology.entities.map((ent) => ent.id || entityId(ent.type, ent.name)));
  const graphTypes = new Map<string, string>();
  for (const rel of ontology.relations) {
    for (const eid of [rel.from_entity, rel.to_entity]) {
      if (local.has(eid) || graphTypes.has(eid)) continue;
      const stored = await getEntity(runner, ns, eid);
      if (stored !== null) graphTypes.set(eid, stored.type);
    }
  }
  const warnings = validateAgainstSchema(ontology, schema, { graphTypes, cardinality });
  if (mode === "strict" && warnings.length) throw new ValidationError(warnings.map((w) => w.message).join("; "));
  return warnings;
}

/**
 * Report schema warnings for a write that has no result to carry them, on stderr so stdout stays clean.
 *
 * @param warnings (readonly InsertWarning[]): the warnings.
 */
export function warnSchema(warnings: readonly InsertWarning[]): void {
  for (const w of warnings) console.warn(`selfgraph: schema warning [${w.code}]: ${w.message}`);
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
