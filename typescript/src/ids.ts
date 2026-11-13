import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";

import { ValidationError } from "./errors.js";
import { cpLen, PY_WORD_CLASS, PY_WS_CLASS, pyCollapseWs, pyRepr, pySplit, pyStrip, utf8 } from "./internal/py.js";
import type { Evidence } from "./models.js";
import { requireStr } from "./validate.js";

const ID_PREFIXES = [
  "relation",
  "preference",
  "decision",
  "profile",
  "source",
  "sv",
  "evidence",
  "entitymerge",
] as const;

export const RESERVED_ID_PREFIXES: ReadonlySet<string> = new Set(ID_PREFIXES);

const tagged = (prefix: (typeof ID_PREFIXES)[number], rest: string): string => `${prefix}:${rest}`;

const PUNCT = new RegExp(`[^${PY_WORD_CLASS}${PY_WS_CLASS}]+`, "gu");
const NON_IDENT = new RegExp(`[^${PY_WORD_CLASS}]+`, "gu");
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;
const ENTITY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "llc",
  "llp",
  "lp",
  "plc",
  "group",
  "holdings",
  "gmbh",
  "ag",
  "sa",
  "nv",
  "the",
]);
const ORG_TYPES = new Set([
  "company",
  "organization",
  "organisation",
  "org",
  "corporation",
  "corp",
  "business",
  "firm",
  "institution",
  "agency",
  "employer",
  "vendor",
  "bank",
]);

/**
 * A stable 24-hex-char digest of the parts, order-sensitive, over a tagged length-prefixed encoding.
 *
 * @param parts (Array<string | null | undefined>): the parts to hash; null is distinct from the empty string.
 * @return (string): a 24-hex-char digest.
 */
function hashParts(...parts: Array<string | null | undefined>): string {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (part === null || part === undefined) {
      chunks.push(utf8("N\x00"));
      continue;
    }
    chunks.push(utf8(`S${cpLen(part)}\x00`), utf8(part), utf8("\x00"));
  }
  return bytesToHex(blake2b(concatBytes(...chunks), { dkLen: 12 }));
}

/**
 * NFC-normalize text so an id, its stored field, and a filter argument share one byte form.
 *
 * @param value (string): the text.
 * @return (string): the NFC-normalized text.
 */
export function normalizeText(value: string): string {
  return value.normalize("NFC");
}

/**
 * Lowercase text and turn runs of whitespace into single hyphens.
 *
 * @param text (string): the text to slugify.
 * @return (string): the slugified text.
 */
export function slug(text: string): string {
  return pyCollapseWs(pyStrip(text).toLowerCase(), "-");
}

function canonicalName(type: string, rawName: string): string {
  const name = normalizeText(rawName);
  let words = pySplit(pyStrip(name).toLowerCase().replace(PUNCT, " "));
  if (ORG_TYPES.has(slug(type))) {
    if (words.length > 0 && words[0] === "the") words = words.slice(1);
    while (words.length > 1 && ENTITY_SUFFIXES.has(words[words.length - 1]!)) words = words.slice(0, -1);
  }
  return words.length > 0 ? words.join("-") : slug(name);
}

/**
 * Derive an entity id "<type>:<canonical-name>", dropping punctuation and, for organisation-like types, a leading article and trailing corporate suffixes.
 *
 * @param type (string): the entity type.
 * @param name (string): the entity name.
 * @return (string): the derived entity id.
 */
export function entityId(type: string, name: string): string {
  requireStr("entity type", type);
  requireStr("entity name", name);
  const t = normalizeText(type);
  return `${slug(t)}:${canonicalName(t, name)}`;
}

/**
 * Canonicalise an entity id without validating it.
 *
 * @param eid (T): the entity id as given; text without a colon, or a non-string, is returned as is.
 * @return (T): the type prefix and the name part, each NFC-normalized and slugified.
 */
export function canonicalId<T>(eid: T): T {
  if (typeof eid !== "string" || !eid.includes(":")) return eid;
  const at = eid.indexOf(":");
  return `${slug(normalizeText(eid.slice(0, at)))}:${slug(normalizeText(eid.slice(at + 1)))}` as T;
}

/**
 * Reject an entity id that is not "type:name" with a non-empty type and name.
 *
 * @param eid (string): the entity id.
 * @return (void): nothing; throws ValidationError on a malformed id.
 */
export function requireEntityShape(eid: string): void {
  const sep = eid.indexOf(":");
  if (sep < 0) throw new ValidationError(`entity id must be 'type:name', e.g. 'person:jane', got ${pyRepr(eid)}`);
  if (!pyStrip(eid.slice(0, sep)) || !pyStrip(eid.slice(sep + 1))) {
    throw new ValidationError(`entity id must be 'type:name' with a non-empty prefix and name, got ${pyRepr(eid)}`);
  }
}

/**
 * Canonicalise an explicit entity id the way entityId shapes a derived one, so case and spacing variants match.
 *
 * @param eid (unknown): the entity id as given.
 * @return (string): the type prefix and the name part, each NFC-normalized and slugified; throws ValidationError when
 *   it is not a "type:name" string with a non-empty type and name.
 */
export function canonicalEntityId(eid: unknown): string {
  requireStr("entity id", eid);
  const canonical = canonicalId(eid);
  requireEntityShape(canonical);
  return canonical;
}

/**
 * Canonicalise a relation type to UPPER_SNAKE so case, spacing, and camelCase variants collapse.
 *
 * @param type (string): the raw relation type.
 * @return (string): the canonical relation type.
 */
export function normalizeRelType(type: string): string {
  requireStr("relation type", type);
  const split = pyStrip(normalizeText(type)).replace(CAMEL, "_");
  const normalized = pyStrip(split.toLowerCase().replace(NON_IDENT, "_"), "_").toUpperCase();
  if (!normalized) {
    throw new ValidationError("relation type cannot be empty; use a verb phrase, e.g. 'works at' or 'WORKS_AT'");
  }
  return normalized;
}

/**
 * A hash of the source entity, the normalized type, and the target entity.
 *
 * @param fromEntity (string): the source entity id.
 * @param type (string): the relationship type.
 * @param toEntity (string): the target entity id.
 * @return (string): the derived relation id.
 */
export function relationId(fromEntity: string, type: string, toEntity: string): string {
  requireStr("from_entity", fromEntity);
  requireStr("to_entity", toEntity);
  return tagged("relation", hashParts(fromEntity, normalizeRelType(type), toEntity));
}

/**
 * A hash of the subject, stance, NFC key, and value entity.
 *
 * @param subjectEntity (string): the subject entity id.
 * @param stance (string): the preference stance.
 * @param key (string): the preference dimension key.
 * @param valueEntity (string): the value entity id.
 * @return (string): the derived preference id.
 */
export function preferenceId(subjectEntity: string, stance: string, key: string, valueEntity: string): string {
  requireStr("subject_entity", subjectEntity);
  requireStr("preference stance", stance);
  requireStr("preference key", key);
  requireStr("value_entity", valueEntity);
  return tagged("preference", hashParts(subjectEntity, stance, normalizeText(key), valueEntity));
}

/**
 * A hash of the actor entity and the NFC title.
 *
 * @param actorEntity (string | null | undefined): the actor entity id, if any.
 * @param title (string): the decision title.
 * @return (string): the derived decision id.
 */
export function decisionId(actorEntity: string | null | undefined, title: string): string {
  if (actorEntity != null) requireStr("actor_entity", actorEntity);
  requireStr("decision title", title);
  return tagged("decision", hashParts(actorEntity ?? null, normalizeText(title)));
}

/**
 * The profile node id for a subject; one profile per entity.
 *
 * @param subjectEntity (string): the subject entity id.
 * @return (string): the profile node id.
 */
export function profileId(subjectEntity: string): string {
  requireStr("subject_entity", subjectEntity);
  return tagged("profile", subjectEntity);
}

/**
 * The internal source node id, namespaced so it never collides with an entity id.
 *
 * @param sourceId (string): the caller's source id.
 * @return (string): the source node id.
 */
export function sourceNodeId(sourceId: string): string {
  requireStr("source_id", sourceId);
  return tagged("source", sourceId);
}

/**
 * A content-addressed id for a version of a source, so re-inserting the same content reuses one version.
 *
 * @param sourceId (string): the source id.
 * @param contentHashHex (string): a digest of the source content.
 * @return (string): the source version id.
 */
export function sourceVersionId(sourceId: string, contentHashHex: string): string {
  requireStr("source_id", sourceId);
  return tagged("sv", hashParts(sourceId, contentHashHex));
}

/**
 * A stable digest of raw source content.
 *
 * @param content (Uint8Array): the raw source content.
 * @return (string): a 24-hex-char digest.
 */
export function contentHash(content: Uint8Array): string {
  return bytesToHex(blake2b(content, { dkLen: 12 }));
}

/**
 * The id of chunk `index` within a source version.
 *
 * @param sourceVersion (string): the source version id.
 * @param index (number): the chunk index.
 * @return (string): the chunk id.
 */
export function chunkId(sourceVersion: string, index: number): string {
  return `${sourceVersion}:chunk:${index}`;
}

/**
 * The id of one evidence record: a hash of the fact it supports and where in which source it was seen.
 *
 * @param targetId (string): the id of the entity or relation the evidence supports.
 * @param ev (Evidence): the evidence.
 * @return (string): the evidence id.
 */
export function evidenceId(targetId: string, ev: Evidence): string {
  const offset = (o: number | null): string | null => (o === null ? null : String(o));
  return tagged(
    "evidence",
    hashParts(
      targetId,
      ev.source_id,
      ev.source_version,
      ev.chunk_id,
      ev.quote,
      offset(ev.start_offset),
      offset(ev.end_offset),
    ),
  );
}

/**
 * The id of the record of one entity merge: a hash of the surviving and the absorbed entity ids.
 *
 * @param survivorId (string): the id of the entity that absorbed the other.
 * @param absorbedId (string): the id the absorbed entity would have had.
 * @return (string): the derived merge record id.
 */
export function entityMergeId(survivorId: string, absorbedId: string): string {
  requireStr("survivor_id", survivorId);
  requireStr("absorbed_id", absorbedId);
  return tagged("entitymerge", hashParts(survivorId, absorbedId));
}

/**
 * The id of a decision step node: the trace id, then ":step:" and the step's order.
 *
 * @param traceId (string): the decision trace id.
 * @param order (number): the step's position in the trace.
 * @return (string): the step node id.
 */
export function stepId(traceId: string, order: number): string {
  return `${traceId}:step:${order}`;
}

/**
 * The decision trace id a step node id belongs to.
 *
 * @param id (string): the step node id.
 * @return (string): the trace id.
 */
export function traceOfStep(id: string): string {
  const i = id.lastIndexOf(":step:");
  return i >= 0 ? id.slice(0, i) : id;
}
