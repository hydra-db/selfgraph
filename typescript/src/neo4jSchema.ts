import { ValidationError } from "./errors.js";
import { log } from "./internal/log.js";
import { isPlainObject, pyRepr, pyStrip } from "./internal/py.js";
import { asSchema, type ParsedSchema, type PropertyType, type Schema } from "./schema.js";
import { typeName } from "./validate.js";

type Obj = Record<string, unknown>;

interface TypeBody {
  label: string;
  description: string | null;
  aliases: unknown[];
  properties: Array<{ name: string; type: PropertyType; required: boolean; description: string | null }>;
}

const IMPORT_TYPES: Record<string, PropertyType> = {
  STRING: "string",
  INTEGER: "integer",
  FLOAT: "float",
  BOOLEAN: "boolean",
  DATE: "datetime",
  LOCAL_DATETIME: "datetime",
  ZONED_DATETIME: "datetime",
};
const EXPORT_TYPES: Record<PropertyType, string> = {
  string: "STRING",
  integer: "INTEGER",
  float: "FLOAT",
  boolean: "BOOLEAN",
  datetime: "ZONED_DATETIME",
  json: "STRING",
};
const TOP_KEYS = ["node_types", "relationship_types", "patterns", "constraints"];
const TYPE_KEYS = ["label", "description", "aliases", "properties"];
const PROPERTY_KEYS = ["name", "type", "description", "required"];
const REQUIRED_KINDS = ["EXISTENCE", "KEY"];
const CAMEL_KEYS: Readonly<Record<string, string>> = {
  nodeTypes: "node_types",
  relationshipTypes: "relationship_types",
  nodeType: "node_type",
  relationshipType: "relationship_type",
  propertyNames: "property_names",
  propertyName: "property_name",
};

/**
 * Require a JSON object, reading each camelCase key as its snake_case form; the snake_case key wins a clash.
 *
 * @param value (unknown): the value.
 * @param where (string): its location, for the error message.
 * @return (Obj): the value with snake_case keys.
 */
function mapping(value: unknown, where: string): Obj {
  if (!isPlainObject(value)) throw new ValidationError(`${where} must be an object, got ${typeName(value)}`);
  const out: Obj = {};
  for (const [key, item] of Object.entries(value)) if (Object.hasOwn(CAMEL_KEYS, key)) out[CAMEL_KEYS[key]!] = item;
  for (const [key, item] of Object.entries(value)) if (!Object.hasOwn(CAMEL_KEYS, key)) out[key] = item;
  return out;
}

/**
 * Read an optional JSON array.
 *
 * @param data (Obj): the object holding it.
 * @param key (string): the array key.
 * @param where (string): the object's location, for the error message.
 * @return (unknown[]): the items, empty when the key is absent or null.
 */
function items(data: Obj, key: string, where: string): unknown[] {
  const value = data[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${where}.${key} must be a list, got ${typeName(value)}`);
  return [...value];
}

/**
 * Require a non-empty string.
 *
 * @param value (unknown): the value.
 * @param where (string): its location, for the error message.
 * @return (string): the string.
 */
function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !pyStrip(value)) {
    throw new ValidationError(`${where} must be a non-empty string, got ${pyRepr(value ?? null)}`);
  }
  return value;
}

/**
 * Record the keys of an object that SelfGraph does not model.
 *
 * @param data (Obj): the object.
 * @param known (string[]): the keys that are mapped.
 * @param where (string): the object's location, prefixed to each dropped key.
 * @param dropped (string[]): the running list of dropped keys, extended in place.
 */
function extra(data: Obj, known: string[], where: string, dropped: string[]): void {
  for (const key of Object.keys(data)) if (!known.includes(key)) dropped.push(`${where}${key}`);
}

/**
 * Map one Neo4j node or relationship type to a SelfGraph type body, keyed by label.
 *
 * @param raw (unknown): the node or relationship type, or a bare label string.
 * @param where (string): its location, for messages.
 * @param dropped (string[]): the running list of dropped keys.
 * @return (TypeBody): label, description, aliases, and properties in SelfGraph form.
 */
function importType(raw: unknown, where: string, dropped: string[]): TypeBody {
  const data = mapping(typeof raw === "string" ? { label: raw } : raw, where);
  const label = text(data.label, `${where}.label`);
  extra(data, TYPE_KEYS, `${label}.`, dropped);
  const properties = items(data, "properties", label).map((rawProp, i) => {
    const prop = mapping(rawProp, `${label}.properties[${i}]`);
    const name = text(prop.name, `${label}.properties[${i}].name`);
    extra(prop, PROPERTY_KEYS, `${label}.${name}.`, dropped);
    const neoType = prop.type === undefined ? "STRING" : prop.type;
    let mapped = typeof neoType === "string" && Object.hasOwn(IMPORT_TYPES, neoType) ? IMPORT_TYPES[neoType] : null;
    if (mapped === null) {
      log(`neo4j ontology: ${label}.${name} type ${String(neoType)} maps to json`);
      mapped = "json";
    }
    return {
      name,
      type: mapped,
      required: prop.required === true,
      description: (prop.description as string) || null,
    };
  });
  return {
    label,
    description: (data.description as string) || null,
    aliases: items(data, "aliases", label),
    properties,
  };
}

/**
 * Read one pattern as (source, relationship, target), from a 3-item list or a source/relationship/target object.
 *
 * @param raw (unknown): the pattern.
 * @param where (string): its location, for the error message.
 * @return ([string, string, string]): the source label, relationship label, and target label.
 */
function pattern(raw: unknown, where: string): [string, string, string] {
  let parts: unknown[];
  if (isPlainObject(raw)) parts = [raw.source, raw.relationship, raw.target];
  else if (Array.isArray(raw) && raw.length === 3) parts = raw;
  else throw new ValidationError(`${where} must be [source, relationship, target] or an object with those keys`);
  return parts.map((p) => text(p, where)) as [string, string, string];
}

/**
 * Apply one Neo4j constraint: EXISTENCE and KEY mark properties required; uniqueness is not modeled.
 *
 * @param types (Map<string, TypeBody>): node or relationship type bodies by label.
 * @param constraint (Obj): the constraint.
 * @param where (string): its location, for messages.
 * @param dropped (string[]): the running list of dropped keys.
 */
function applyConstraint(types: Map<string, TypeBody>, constraint: Obj, where: string, dropped: string[]): void {
  const kind = constraint.type;
  const label = constraint.node_type || constraint.relationship_type;
  let names = [...((constraint.property_names as unknown[] | undefined) ?? [])];
  if (!names.length && constraint.property_name) names = [constraint.property_name];
  const scope = `${String(label)}(${names.map(String).join(", ")})`;
  if (!REQUIRED_KINDS.includes(kind as string)) {
    dropped.push(`${where} ${String(kind)} on ${scope}`);
    return;
  }
  if (kind === "KEY") dropped.push(`${where} KEY uniqueness on ${scope}`);
  const body = typeof label === "string" ? types.get(label) : undefined;
  for (const name of names) {
    const spec = body?.properties.find((p) => p.name === name);
    if (spec === undefined) dropped.push(`${where} ${String(kind)} on undeclared ${String(label)}.${String(name)}`);
    else spec.required = true;
  }
}

/**
 * Build a schema from a Neo4j graph schema JSON object, as written by neo4j-graphrag's SchemaBuilder.
 *
 * Node types become entity types, relationship types become relation types, patterns become endpoint types, and EXISTENCE or KEY constraints mark properties required. Property types map to the nearest SelfGraph type, or json with a warning. What SelfGraph does not model (uniqueness, additional_* flags, indexes, and any other key) is dropped and listed in one warning on stderr.
 *
 * @param data (unknown): node_types, relationship_types, patterns, and constraints.
 * @return (ParsedSchema): the schema.
 */
export function fromNeo4jOntology(data: unknown): ParsedSchema {
  const top = mapping(data, "neo4j ontology");
  const dropped: string[] = [];
  extra(top, TOP_KEYS, "", dropped);
  const nodes = new Map<string, TypeBody>();
  items(top, "node_types", "neo4j ontology").forEach((raw, i) => {
    const body = importType(raw, `node_types[${i}]`, dropped);
    nodes.set(body.label, body);
  });
  const rels = new Map<string, TypeBody>();
  items(top, "relationship_types", "neo4j ontology").forEach((raw, i) => {
    const body = importType(raw, `relationship_types[${i}]`, dropped);
    rels.set(body.label, body);
  });
  const ends = new Map<string, [string[], string[]]>();
  const pairs = new Map<string, Set<string>>();
  items(top, "patterns", "neo4j ontology").forEach((raw, i) => {
    const [source, rel, target] = pattern(raw, `patterns[${i}]`);
    if (!rels.has(rel)) rels.set(rel, { label: rel, description: null, aliases: [], properties: [] });
    const [froms, tos] = ends.get(rel) ?? [[], []];
    if (!froms.includes(source)) froms.push(source);
    if (!tos.includes(target)) tos.push(target);
    ends.set(rel, [froms, tos]);
    pairs.set(rel, (pairs.get(rel) ?? new Set()).add(JSON.stringify([source, target])));
  });
  for (const [rel, [froms, tos]] of ends) {
    if (pairs.get(rel)!.size < froms.length * tos.length) {
      dropped.push(`patterns for ${rel} widened to every source and target pair`);
    }
  }
  items(top, "constraints", "neo4j ontology").forEach((raw, i) => {
    const constraint = mapping(raw, `constraints[${i}]`);
    applyConstraint(constraint.node_type ? nodes : rels, constraint, `constraints[${i}]`, dropped);
  });
  if (dropped.length) {
    log(`neo4j ontology: dropped what SelfGraph does not model: ${dropped.join(", ")}`);
  }
  return asSchema({
    entities: [...nodes.values()].map((b) => ({
      name: b.label,
      description: b.description,
      aliases: b.aliases as string[],
      properties: b.properties,
    })),
    relations: [...rels.entries()].map(([label, b]) => {
      const [froms, tos] = ends.get(label) ?? [[], []];
      return {
        type: label,
        description: b.description,
        aliases: b.aliases as string[],
        from: { types: froms },
        to: { types: tos },
        properties: b.properties,
      };
    }),
  })!;
}

type Spec = ParsedSchema["entities"][number]["properties"][number];

/**
 * Render one SelfGraph entity or relation type as a Neo4j node or relationship type.
 *
 * @param label (string): the type name.
 * @param description (string | null): the description.
 * @param aliases (string[]): alternate names, kept as an extra aliases key when present.
 * @param properties (Spec[]): the property specs.
 * @return (Obj): the Neo4j type.
 */
function exportType(label: string, description: string | null, aliases: string[], properties: Spec[]): Obj {
  const out: Obj = { label, description: description || "" };
  if (aliases.length) out.aliases = [...aliases];
  out.properties = properties.map((p) => ({
    name: p.name,
    type: EXPORT_TYPES[p.type],
    description: p.description || "",
  }));
  return out;
}

/**
 * Render the required properties of a type as Neo4j EXISTENCE constraints.
 *
 * @param properties (Spec[]): the property specs.
 * @param scope ("node_type" | "relationship_type"): the constraint scope key.
 * @param label (string): the type name.
 * @return (Obj[]): one constraint per required property.
 */
function existence(properties: Spec[], scope: "node_type" | "relationship_type", label: string): Obj[] {
  return properties
    .filter((p) => p.required)
    .map((p) => ({ type: "EXISTENCE", property_names: [p.name], [scope]: label }));
}

/**
 * Render a schema as a Neo4j graph schema JSON object, the format neo4j-graphrag reads.
 *
 * Required properties become EXISTENCE constraints and endpoint types become every source and target pattern. Fields with no Neo4j counterpart (name, version, parent, cardinality, json types, one-sided endpoints) are listed in one warning on stderr.
 *
 * @param raw (Schema | ParsedSchema): the schema, parsed here; an invalid one throws ValidationError.
 * @return (Obj): node_types, relationship_types, patterns, and constraints.
 */
export function toNeo4jOntology(raw: Schema | ParsedSchema): Obj {
  mapping(raw, "schema");
  const schema = asSchema(raw)!;
  const dropped = (["name", "version"] as const).filter((key) => schema[key] != null) as string[];
  const nodes: Obj[] = [];
  const rels: Obj[] = [];
  const patterns: string[][] = [];
  const constraints: Obj[] = [];
  const jsonTyped = (label: string, properties: Spec[]) =>
    properties.filter((p) => p.type === "json").map((p) => `${label}.${p.name} json type (exported as STRING)`);
  for (const e of schema.entities) {
    nodes.push(exportType(e.name, e.description, e.aliases, e.properties));
    constraints.push(...existence(e.properties, "node_type", e.name));
    if (e.parent != null) dropped.push(`${e.name}.parent`);
    dropped.push(...jsonTyped(e.name, e.properties));
  }
  for (const r of schema.relations) {
    rels.push(exportType(r.type, r.description, r.aliases, r.properties));
    constraints.push(...existence(r.properties, "relationship_type", r.type));
    for (const source of r.from.types) for (const target of r.to.types) patterns.push([source, r.type, target]);
    if (Boolean(r.from.types.length) !== Boolean(r.to.types.length)) {
      dropped.push(`${r.type} endpoint types on one side only`);
    }
    for (const side of ["from", "to"] as const) {
      if (r[side].min_count != null || r[side].max_count != null) dropped.push(`${r.type}.${side} cardinality`);
    }
    dropped.push(...jsonTyped(r.type, r.properties));
  }
  if (dropped.length) log(`neo4j ontology: no Neo4j counterpart for: ${dropped.join(", ")}`);
  return { node_types: nodes, relationship_types: rels, patterns, constraints };
}
