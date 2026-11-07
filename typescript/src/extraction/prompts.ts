import { PromptTemplateError } from "../errors.js";
import { pyRepr } from "../internal/py.js";
import type { ExtractionInstructions, ExtractionPrompts, PromptTemplate } from "../models.js";

export type ObjectType = "entities" | "relations" | "preferences" | "decisions";

const ENTITY_SYSTEM =
  "You extract entities for a knowledge graph. An entity is a distinct real-world " +
  "thing: a person, company, product, place, concept, or document. For each entity " +
  "return a concise canonical name and a short Type (e.g. Person, Company, Product). " +
  "Do not invent entities that are not supported by the text.";
const ENTITY_USER = 'Extract every entity from the text below.\n{instructions}\n\nText:\n"""\n{text}\n"""';

const RELATION_SYSTEM =
  "You extract directed relationships between entities for a knowledge graph. " +
  "Use SCREAMING_SNAKE_CASE relationship types (e.g. WORKS_AT, FOUNDED, REQUIRES). " +
  "Reference entities by the same names used in the text. Capture an event_time only " +
  "when the text states when the relationship held. " +
  "Connect entities directly to each other when the text relates them; do not route " +
  "every relationship through one central entity, since a hub-and-spoke shape hides " +
  "the connections between the others and makes the graph hard to traverse.";
const RELATION_USER =
  "Extract every relationship from the text below as (from, TYPE, to) triples.\n" +
  '{instructions}\n\nText:\n"""\n{text}\n"""';

const PREFERENCE_SYSTEM =
  "You extract preferences and disinterests from text. A preference records that a " +
  "subject prefers (kind='preference') or avoids (kind='disinterest') a value entity, " +
  "for some key (the dimension, e.g. 'database'). Only extract preferences that are " +
  "explicitly supported by the text.";
const PREFERENCE_USER =
  'Extract every preference or disinterest from the text below.\n{instructions}\n\nText:\n"""\n{text}\n"""';

const DECISION_SYSTEM =
  "You extract decision traces. A decision records that an actor decided something, " +
  "the ordered relationships that justify it (as (from, TYPE, to) step triples), the " +
  "outcome entity, the alternatives considered, and a short rationale. Only extract a " +
  "decision when the text makes an explicit decision with a reason.";
const DECISION_USER =
  "Extract every decision from the text below, with its ordered justifying steps.\n" +
  '{instructions}\n\nText:\n"""\n{text}\n"""';

export const DEFAULT_PROMPTS: Readonly<Record<ObjectType, PromptTemplate>> = Object.freeze({
  entities: { system: ENTITY_SYSTEM, user: ENTITY_USER, version: "entities-v1" },
  relations: { system: RELATION_SYSTEM, user: RELATION_USER, version: "relations-v1" },
  preferences: { system: PREFERENCE_SYSTEM, user: PREFERENCE_USER, version: "preferences-v1" },
  decisions: { system: DECISION_SYSTEM, user: DECISION_USER, version: "decisions-v1" },
});

/**
 * Resolve the template for an object type: per-call over client over default.
 *
 * @param objectType (ObjectType): the object type.
 * @param clientPrompts (ExtractionPrompts | null | undefined): client-level overrides.
 * @param callPrompts (ExtractionPrompts | null | undefined): per-call overrides.
 * @return (PromptTemplate): the resolved template.
 */
export function effectivePrompt(
  objectType: ObjectType,
  clientPrompts: ExtractionPrompts | null | undefined,
  callPrompts: ExtractionPrompts | null | undefined,
): PromptTemplate {
  for (const source of [callPrompts, clientPrompts, DEFAULT_PROMPTS]) {
    const template = source?.[objectType];
    if (template) return template;
  }
  throw new PromptTemplateError(`no prompt template for ${pyRepr(objectType)}`);
}

/**
 * Per-call instructions replace client instructions for that call.
 *
 * @param objectType (ObjectType): the object type.
 * @param clientInstructions (ExtractionInstructions | null | undefined): client-level instructions.
 * @param callInstructions (ExtractionInstructions | null | undefined): per-call instructions.
 * @return (string | null): the resolved instruction text, if any.
 */
export function effectiveInstruction(
  objectType: ObjectType,
  clientInstructions: ExtractionInstructions | null | undefined,
  callInstructions: ExtractionInstructions | null | undefined,
): string | null {
  for (const source of [callInstructions, clientInstructions]) {
    const value = source?.[objectType];
    if (value != null) return value;
  }
  return null;
}

/**
 * Render a template to its [system, user] messages, throwing if {text} is missing.
 *
 * @param template (PromptTemplate): the template.
 * @param text (string): the document text substituted for {text}.
 * @param instructions (string | null): extra instructions substituted or appended.
 * @return ([string, string]): the [system, user] pair.
 */
export function render(template: PromptTemplate, text: string, instructions: string | null): [string, string] {
  if (!template.user.includes("{text}")) {
    throw new PromptTemplateError(`prompt ${pyRepr(template.version)} is missing required variable {text}`);
  }
  const extra = instructions || "";
  let user = template.user.split("{text}").join(text);
  if (user.includes("{instructions}")) user = user.split("{instructions}").join(extra);
  else if (extra) user = `${user}\n\nAdditional instructions:\n${extra}`;
  return [template.system, user];
}
