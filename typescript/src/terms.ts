import { comparePy, cpLen } from "./internal/py.js";
import type { TermMatch } from "./models.js";
import type { ParsedSchema } from "./schema.js";

export type Tokenize = (text: string) => Set<string>;

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
 * Find the schema terms a question names: a term matches when every word of one surface form is in the question.
 *
 * Entity types, relation types, and definitions are matched by name, alias, and synonym, ignoring case and a plain
 * plural ending. A term is listed once, by the first form that matches.
 *
 * @param tokens (ReadonlySet<string>): the question's content tokens.
 * @param schema (ParsedSchema | null): the schema, or null for no terms.
 * @param tokenize (Tokenize): splits text into content tokens.
 * @return (TermMatch[]): the matched terms, in schema order.
 */
export function matchTerms(tokens: ReadonlySet<string>, schema: ParsedSchema | null, tokenize: Tokenize): TermMatch[] {
  if (schema === null || !tokens.size) return [];
  const stems = new Set([...tokens].map(stem));
  const found: TermMatch[] = [];

  const consider = (term: string, kind: TermMatch["kind"], names: readonly string[], certified: boolean): void => {
    for (const form of forms(names)) {
      const words = new Set([...tokenize(form)].map(stem));
      if (words.size && [...words].every((w) => stems.has(w))) {
        const hit = [...tokens].filter((t) => words.has(stem(t))).sort(comparePy);
        found.push({ term, kind, matched: form, tokens: hit, certified });
        return;
      }
    }
  };

  for (const entity of schema.entities) {
    consider(entity.name, "entity", [entity.name, ...entity.aliases, ...entity.synonyms], entity.certified);
    for (const definition of entity.definitions) {
      consider(definition.name, "definition", [definition.name, ...definition.synonyms], definition.certified);
    }
  }
  for (const relation of schema.relations) {
    const names = [relation.type, ...relation.aliases, ...relation.synonyms];
    consider(relation.type, "relation", names, relation.certified);
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
  for (const match of matchTerms(tokens, schema, tokenize)) {
    const name = match.kind === "entity" ? match.term : match.kind === "definition" ? owner.get(match.term) : null;
    if (name != null) for (const token of tokenize(name)) out.add(token);
  }
  return out;
}
