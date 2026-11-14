import { ValidationError } from "./errors.js";
import { normalizeRelType } from "./ids.js";
import { casefold } from "./internal/casefold.js";
import { dumps } from "./internal/json.js";
import { log } from "./internal/log.js";
import { comparePy, pyFloatRepr, pyStrip } from "./internal/py.js";
import type { DecisionTrace, Entity, JsonObject, Preference, Relation } from "./models.js";
import { asSchema, type ParsedSchema, type Schema } from "./schema.js";

type Obj = Record<string, unknown>;

export const OSSIE_VERSION = "0.3.0.dev0";
const OSSIE_TYPES: Record<string, string> = {
  string: "String",
  integer: "Integer",
  float: "Float",
  boolean: "Boolean",
  datetime: "DateTime",
  json: "String",
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: file names must not hold control characters
const UNSAFE = /[\\/:*?"<>|#^[\]\x00-\x1f]/g;

/**
 * Compare string tuples element by element in Python order.
 *
 * @param a (readonly string[]): the first tuple.
 * @param b (readonly string[]): the second tuple.
 * @return (number): negative, zero, or positive.
 */
function compareTuples(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) {
    const c = comparePy(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Log the set fields of a schema term that an Ossie document has no place for.
 *
 * @param kind (string): the term's kind, such as "entity type".
 * @param name (string): the term's name.
 * @param fields (Record<string, unknown>): each field's description with its value; only set ones are logged.
 * @return (void): nothing.
 */
function leftOut(kind: string, name: string, fields: Record<string, unknown>): void {
  const lost = Object.entries(fields)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
    .map(([field]) => field);
  if (lost.length) log(`ossie export: the ${lost.join(", ")} of ${kind} ${name} are left out`);
}

/**
 * Render a schema as an Apache Ossie ontology document (spec 0.3.0.dev0).
 *
 * Each entity type becomes an EntityType concept that extends its parent. Each property becomes a ManyToOne relationship to the matching built-in value type. Each relation type becomes a relationship under every one of its from types, one per to type (Any when it lists none), named by its type plus the to type when there are several; it is ManyToOne when from max_count is 1 and OneToOne when to max_count is 1 too. A relation type with no from types is left out, as Ossie declares a relationship under a concept. Relation properties, aliases, synonyms, definitions, mappings, certified flags, required flags, and min counts have no Ossie form and are left out too; each omission is logged.
 *
 * @param raw (Schema | ParsedSchema): the schema.
 * @return (Obj): the Ossie document; JSON is valid YAML, so it can be written as either.
 */
export function toOssie(raw: Schema | ParsedSchema): Obj {
  const schema = asSchema(raw)!;
  if (!schema.entities.length) {
    throw new ValidationError("an Ossie ontology needs at least one concept; the schema declares no entity types");
  }
  const concepts = new Map<string, Obj & { relationships: Obj[] }>();
  for (const entity of schema.entities) {
    const concept: Obj = { concept: entity.name, type: "EntityType" };
    if (entity.description) concept.description = entity.description;
    if (entity.parent) concept.extends = [entity.parent];
    concept.relationships = entity.properties.map((prop) => ({
      name: prop.name,
      ...(prop.description ? { description: prop.description } : {}),
      roles: [{ concept: OSSIE_TYPES[prop.type] }],
      multiplicity: "ManyToOne",
      verbalizes: [`{${entity.name}} has ${prop.name} {${OSSIE_TYPES[prop.type]}}`],
    }));
    concepts.set(entity.name, concept as Obj & { relationships: Obj[] });
    leftOut("entity type", entity.name, {
      aliases: entity.aliases,
      synonyms: entity.synonyms,
      mappings: entity.mappings,
      definitions: entity.definitions,
      "certified flag": entity.certified,
      "required flags": entity.properties.some((p) => p.required),
    });
  }
  for (const relation of schema.relations) {
    const rtype = normalizeRelType(relation.type);
    if (!relation.from.types.length) {
      log(`ossie export: relation ${rtype} has no from types, so it is left out`);
      continue;
    }
    leftOut("relation", rtype, {
      properties: relation.properties,
      aliases: relation.aliases,
      synonyms: relation.synonyms,
      "certified flag": relation.certified,
      "min counts": relation.from.min_count != null || relation.to.min_count != null,
    });
    const words = rtype.toLowerCase().replaceAll("_", " ");
    const targets = relation.to.types.length ? relation.to.types : ["Any"];
    const multiplicity: Obj = {};
    if (relation.from.max_count === 1) {
      multiplicity.multiplicity = relation.to.max_count === 1 ? "OneToOne" : "ManyToOne";
    }
    for (const source of relation.from.types) {
      for (const target of targets) {
        const role: Obj = { concept: target };
        let placeholder = target;
        if (target === source) {
          role.name = "other";
          placeholder = `${target}:other`;
        }
        if (!concepts.has(source)) concepts.set(source, { concept: source, type: "EntityType", relationships: [] });
        concepts.get(source)!.relationships.push({
          name: targets.length === 1 ? rtype : `${rtype}_${target}`,
          ...(relation.description ? { description: relation.description } : {}),
          roles: [role],
          ...multiplicity,
          verbalizes: [`{${source}} ${words} {${placeholder}}`],
        });
      }
    }
  }
  const ontology: Obj[] = [];
  for (const concept of concepts.values()) {
    const out: Obj = { ...concept };
    if (!concept.relationships.length) delete out.relationships;
    ontology.push(out);
  }
  return { version: OSSIE_VERSION, name: schema.name || "selfgraph", ontology };
}

/**
 * Make a note file name from text, replacing the characters file systems or Obsidian links reject.
 *
 * @param text (string): the name.
 * @return (string): the file name without extension, or "" when nothing usable is left.
 */
function stem(text: string): string {
  return pyStrip(pyStrip(pyStrip(text.replace(UNSAFE, "-")), "."));
}

/**
 * Pick the first file name not taken yet, ignoring case, numbering the last option when all are taken.
 *
 * @param options (string[]): the candidate file names, best first.
 * @param taken (Set<string>): the casefolded names already used, updated in place.
 * @return (string): the chosen file name.
 */
function claim(options: string[], taken: Set<string>): string {
  let chosen = options.find((s) => s && !taken.has(casefold(s)));
  for (let n = 2; chosen === undefined; n++) {
    const candidate = `${options[options.length - 1] || "note"} ${n}`;
    if (!taken.has(casefold(candidate))) chosen = candidate;
  }
  taken.add(casefold(chosen));
  return chosen;
}

/**
 * Format properties as one JSON object, or nothing when there are none.
 *
 * @param properties (JsonObject): the properties.
 * @return (string): " " plus the JSON object, or "".
 */
function propsText(properties: JsonObject): string {
  return Object.keys(properties).length ? ` ${dumps(properties)}` : "";
}

/**
 * Render a graph as an Obsidian vault: one Markdown note per entity and one per decision.
 *
 * An entity note is named after the entity, then after its name and type, then its id, when names collide ignoring case; it has the id, type, and aliases as front matter, then its properties, its outgoing relations and preferences as wiki links, and its decisions. Obsidian derives backlinks, so incoming links are not repeated. Decision notes go in decisions/. Values are written as JSON, which is valid YAML.
 *
 * @param entities (Entity[]): the entities, in id order.
 * @param relations (Relation[]): the current relations.
 * @param preferences (Preference[]): the current preferences.
 * @param decisions (DecisionTrace[]): the decisions.
 * @return (Record<string, string>): each note's path relative to the vault, with its Markdown.
 */
export function obsidianVault(
  entities: Entity[],
  relations: Relation[],
  preferences: Preference[],
  decisions: DecisionTrace[],
): Record<string, string> {
  const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => comparePy(a.id, b.id));
  let taken = new Set<string>();
  const stems = new Map<string, string>();
  for (const e of byId(entities))
    stems.set(e.id, claim([stem(e.name), stem(`${e.name} (${e.type})`), stem(e.id)], taken));
  const link = (eid: string): string => (stems.has(eid) ? `[[${stems.get(eid)}]]` : eid);
  const outgoing = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, line: string) => map.set(key, [...(map.get(key) ?? []), line]);
  const sortedRelations = [...relations].sort((a, b) =>
    compareTuples([a.from_entity, a.type, a.to_entity, a.id], [b.from_entity, b.type, b.to_entity, b.id]),
  );
  for (const r of sortedRelations)
    add(outgoing, r.from_entity, `- ${r.type} ${link(r.to_entity)}${propsText(r.properties)}`);
  const sortedPreferences = [...preferences].sort((a, b) =>
    compareTuples([a.subject_entity, a.key, a.id], [b.subject_entity, b.key, b.id]),
  );
  for (const p of sortedPreferences) {
    const verb = p.stance === "preference" ? "prefers" : "avoids";
    const strength = p.strength === null ? "" : ` (strength ${pyFloatRepr(p.strength)})`;
    add(outgoing, p.subject_entity, `- ${verb} ${link(p.value_entity)} for ${p.key}${strength}`);
  }
  taken = new Set<string>();
  const decisionStems = new Map<string, string>();
  for (const d of byId(decisions)) decisionStems.set(d.id, claim([stem(d.title), stem(d.id)], taken));
  const made = new Map<string, string[]>();
  for (const d of decisions) {
    if (d.actor_entity) add(made, d.actor_entity, `- [[decisions/${decisionStems.get(d.id)}]]`);
  }
  const vault: Record<string, string> = {};
  for (const e of byId(entities)) {
    const lines = ["---", `id: ${dumps(e.id)}`, `type: ${dumps(e.type)}`];
    if (e.aliases.length) lines.push(`aliases: ${dumps(e.aliases)}`);
    lines.push("---", `# ${e.name}`);
    const properties = Object.entries(e.properties)
      .sort(([a], [b]) => comparePy(a, b))
      .map(([k, v]) => `- ${k}: ${dumps(v)}`);
    const sections: Array<[string, string[]]> = [
      ["Properties", properties],
      ["Links", outgoing.get(e.id) ?? []],
      ["Decisions", [...(made.get(e.id) ?? [])].sort(comparePy)],
    ];
    for (const [title, body] of sections) if (body.length) lines.push("", `## ${title}`, ...body);
    vault[`${stems.get(e.id)}.md`] = `${lines.join("\n")}\n`;
  }
  for (const d of byId(decisions)) {
    const lines = ["---", `id: ${dumps(d.id)}`, `status: ${dumps(d.status)}`, "---", `# ${d.title}`];
    const facts: Array<[string, string]> = [];
    for (const [label, eid] of [
      ["Actor", d.actor_entity],
      ["Outcome", d.outcome_entity],
    ] as const) {
      if (eid) facts.push([label, link(eid)]);
    }
    if (d.alternative_entities.length) facts.push(["Alternatives", d.alternative_entities.map(link).join(", ")]);
    for (const [label, text] of [
      ["Summary", d.summary],
      ["Rationale", d.rationale],
    ] as const) {
      if (text) facts.push([label, text]);
    }
    if (facts.length) lines.push("", ...facts.map(([label, text]) => `- ${label}: ${text}`));
    if (d.steps.length) {
      const ordered = [...d.steps].sort((a, b) => a.order - b.order);
      const steps = ordered.map(
        (s, i) => `${i + 1}. ${link(s.from_entity)} to ${link(s.to_entity)} (${s.relation_id})`,
      );
      lines.push("", "## Steps", ...steps);
    }
    vault[`decisions/${decisionStems.get(d.id)}.md`] = `${lines.join("\n")}\n`;
  }
  return vault;
}
