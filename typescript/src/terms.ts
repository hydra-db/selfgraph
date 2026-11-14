import { normalizeRelType } from "./ids.js";
import { cpLen } from "./internal/py.js";
import { canonicalEntityType, canonicalRelationType, entityIndex, lineage, type ParsedSchema } from "./schema.js";

export type Tokenize = (text: string) => Set<string>;

export type SchemaTermKind = "type" | "definition" | "relation";

/**
 * Strip a plain plural ending so "customers" and "customer" compare equal.
 *
 * @param token (string): a casefolded token.
 * @return (string): the token without a trailing plural s.
 */
export function stem(token: string): string {
  if (token.endsWith("ies") && cpLen(token) > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("ss") && cpLen(token) > 3) return token.slice(0, -1);
  return token;
}

/**
 * Put spaces at camel-case and underscore boundaries, so InvoiceLine and WORKS_AT read as words.
 *
 * @param name (string): the type name.
 * @return (string): the name as space-separated words.
 */
export function spaced(name: string): string {
  return name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ").replaceAll("_", " ");
}

/**
 * List the distinct surface forms of a term, each also split into words.
 *
 * @param names (readonly string[]): the name, aliases, and synonyms.
 * @return (string[]): the forms, in order.
 */
function forms(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((name) => [name, spaced(name)]))];
}

/**
 * List the terms the stored graph holds instances of, by kind, so a schema term alone never grounds a question.
 *
 * A type is held when an entity of it or of a subtype is stored, a definition when its entity type is held, and a relation type when a relation of it is stored. The stored types themselves are held too.
 *
 * @param schema (ParsedSchema | null): the schema, or null for the stored types only.
 * @param entityTypes (Iterable<string>): the stored entities' types.
 * @param relationTypes (Iterable<string>): the stored relations' types.
 * @return (Record<SchemaTermKind, Set<string>>): for "type", "definition", and "relation", the held term names.
 */
export function groundedTerms(
  schema: ParsedSchema | null,
  entityTypes: Iterable<string>,
  relationTypes: Iterable<string>,
): Record<SchemaTermKind, Set<string>> {
  const types = new Set(entityTypes);
  const rels = new Set(relationTypes);
  const held: Record<SchemaTermKind, Set<string>> = {
    type: new Set(types),
    definition: new Set(),
    relation: new Set(rels),
  };
  if (schema === null) return held;
  const index = entityIndex(schema);
  for (const etype of types) {
    const entity = index.get(canonicalEntityType(etype, schema));
    if (entity !== undefined) for (const t of lineage(entity, index)) held.type.add(t.name);
  }
  for (const e of schema.entities)
    if (held.type.has(e.name)) for (const d of e.definitions) held.definition.add(d.name);
  const stored = new Set([...rels].map((t) => normalizeRelType(canonicalRelationType(t, schema))));
  for (const r of schema.relations) if (stored.has(normalizeRelType(r.type))) held.relation.add(r.type);
  return held;
}

/**
 * Map every surface form of the schema's terms, by kind, to the term it names and whether it is certified.
 *
 * Entity types and relation types are named by name, alias, and synonym, and definitions by name and synonym; each form is also listed split into words, so InvoiceLine reads as "Invoice Line".
 *
 * @param schema (ParsedSchema | null): the schema, or null for no terms.
 * @return (Record<SchemaTermKind, Map<string, readonly [string, boolean]>>): for "type", "definition", and "relation", each form's term and certified flag.
 */
export function schemaForms(
  schema: ParsedSchema | null,
): Record<SchemaTermKind, Map<string, readonly [string, boolean]>> {
  const found: Record<SchemaTermKind, Map<string, readonly [string, boolean]>> = {
    type: new Map(),
    definition: new Map(),
    relation: new Map(),
  };
  if (schema === null) return found;
  const note = (kind: SchemaTermKind, term: string, names: readonly string[], certified: boolean): void => {
    for (const form of forms(names)) if (!found[kind].has(form)) found[kind].set(form, [term, certified]);
  };
  for (const entity of schema.entities) {
    note("type", entity.name, [entity.name, ...entity.aliases, ...entity.synonyms], entity.certified);
    for (const definition of entity.definitions) {
      note("definition", definition.name, [definition.name, ...definition.synonyms], definition.certified);
    }
  }
  for (const relation of schema.relations) {
    note("relation", relation.type, [relation.type, ...relation.aliases, ...relation.synonyms], relation.certified);
  }
  return found;
}

/**
 * Add the words of each entity type a question names by alias or synonym, so seeding finds entities of that type.
 *
 * A definition adds the words of the entity type it belongs to.
 *
 * @param tokens (ReadonlySet<string>): the question's content tokens.
 * @param schema (ParsedSchema | null): the schema, or null for no expansion.
 * @param tokenize (Tokenize): splits text into content tokens.
 * @return (Set<string>): the tokens with the matched type names added.
 */
export function expandTokens(
  tokens: ReadonlySet<string>,
  schema: ParsedSchema | null,
  tokenize: Tokenize,
): Set<string> {
  const out = new Set(tokens);
  if (schema === null) return out;
  const owner = new Map(schema.entities.flatMap((e) => e.definitions.map((d) => [d.name, e.name] as const)));
  const stems = new Set([...tokens].map(stem));
  const found = schemaForms(schema);
  for (const kind of ["type", "definition"] as const) {
    for (const [form, [term]] of found[kind]) {
      const words = [...tokenize(form)].map(stem);
      if (!words.length || !words.every((w) => stems.has(w))) continue;
      const name = kind === "type" ? term : owner.get(term)!;
      for (const token of tokenize(name)) out.add(token);
    }
  }
  return out;
}
