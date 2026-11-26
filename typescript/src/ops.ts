import { AsyncLocalStorage } from "node:async_hooks";

import { ConflictError, NotFoundError, TransientError, ValidationError } from "./errors.js";
import * as ids from "./ids.js";
import { casefold } from "./internal/casefold.js";
import { dumps, loads } from "./internal/json.js";
import { comparePy, deepEqual, isPlainObject, pyRepr, pyStrip, utf8 } from "./internal/py.js";
import { epochMicros, fromIso, jsonIso, toIso } from "./internal/time.js";
import { ALNUM_CLASS, lower } from "./internal/unicode.js";
import {
  childEdgeId,
  EDGE_TYPES,
  L_ENTITY,
  L_EVIDENCE,
  L_MERGE,
  L_MERGE_ENTRY,
  L_PROFILE,
  L_SOURCE,
  L_SOURCE_VERSION,
  L_STEP,
  L_TRACE,
  LABELS,
  PREFERENCE_EDGE_TYPES,
  preferenceEdgeType,
  preferenceStanceOf,
  R_CONSIDERED,
  R_FROM,
  R_HAS_PROFILE,
  R_HAS_STEP,
  R_HAS_VERSION,
  R_MADE_DECISION,
  R_RESULTED_IN,
  R_TO,
} from "./labels.js";
import {
  DEFAULT_STANCE,
  type DecisionStep,
  type DecisionTrace,
  type DeleteResult,
  type Entity,
  type Evidence,
  type InsertWarning,
  insertWarning,
  type JsonObject,
  type ParsedEntityInput,
  type ParsedEvidenceInput,
  type ParsedExtraction,
  type ParsedPreferenceInput,
  type ParsedRelationInput,
  type Preference,
  type Relation,
  Stance,
  Status,
} from "./models.js";
import type {
  EdgeRow,
  EdgeWrite,
  GraphPrimitives,
  MatchEdgesOptions,
  MatchNodesOptions,
  NodeRow,
  Props,
} from "./protocols.js";
import { type SchemaSubject, warnSchema } from "./schema.js";
import {
  ABOUT_DROPPED,
  decodeEntity,
  decodeEvidence,
  decodePreference,
  decodeRelation,
  decodeTrace,
  encodeEntityProps,
  encodeEvidenceProps,
  encodePreferenceProps,
  encodeRelationProps,
  encodeTraceProps,
  evidenceOf,
} from "./serde.js";
import {
  checkOptions,
  hasControl,
  hasSurrogate,
  keysOf,
  parseTime,
  requireDatetime,
  requireInt,
  requireJsonMapping,
  requireList,
  requireOptionalText,
  requireStr,
  requireStrMapping,
  requireUnit,
  suggestKey,
  typeName,
} from "./validate.js";

type Runner = GraphPrimitives;
export type SchemaCheck = (runner: Runner, subject: SchemaSubject, before?: SchemaSubject) => Promise<void>;

export const NO_DELETES: Readonly<DeleteResult> = Object.freeze({
  deleted_entities: 0,
  deleted_relation_versions: 0,
  deleted_decisions: 0,
  deleted_preference_versions: 0,
  restored_relations: 0,
});

const RESERVED_LABELS = new Set(LABELS.map(lower));
const TYPE_CHAR = new RegExp(`[${ALNUM_CLASS} _.-]`, "u");
const ENTITY_UPDATE_FIELDS = keysOf<UpdateEntityFields>({
  type: true,
  name: true,
  aliases: true,
  external_ids: true,
  properties: true,
  remove_aliases: true,
  remove_properties: true,
});
const DECISION_UPDATE_FIELDS = keysOf<UpdateTraceFields>({
  title: true,
  steps: true,
  actor_entity: true,
  summary: true,
  rationale: true,
  outcome_entity: true,
  alternative_entities: true,
  status: true,
  event_time: true,
  clear: true,
});
export const PREFERENCE_CLEARABLE = ["strength", "about_entity", "event_time"] as const;
export const DECISION_CLEARABLE = [
  "actor_entity",
  "summary",
  "rationale",
  "outcome_entity",
  "alternative_entities",
  "steps",
  "event_time",
] as const;
const LIST_FIELDS: readonly string[] = ["alternative_entities", "steps"];
const STANCES: readonly Stance[] = [...Stance.options].sort();
const STATUSES: readonly Status[] = [...Status.options].sort();
const MAX_ID_BYTES = 1024;

export const cleanText = (s: string): string => pyStrip(ids.normalizeText(s));

/**
 * The key entity type filters compare on: the cleaned type, through canonical when given, case-folded.
 *
 * @param etype (string): the entity type.
 * @param canonical ((type: string) => string | undefined): maps a type to its schema type name, or undefined for no schema.
 * @return (string): the comparison key.
 */
export function entityTypeKey(etype: string, canonical?: (type: string) => string): string {
  const clean = cleanText(etype);
  return casefold(canonical ? canonical(clean) : clean);
}

const idOf = (props: Props): string => props.id as string;

/**
 * Reject a relation type that names one of SelfGraph's internal edge types.
 *
 * @param rtype (string): the normalized relation type.
 * @param given (string): the type as the caller wrote it, for the message.
 */
export function rejectReservedRelType(rtype: string, given: string): void {
  if (EDGE_TYPES.has(rtype)) {
    throw new ValidationError(`relation type ${pyRepr(given)} is reserved for internal use; choose another type`);
  }
}

/**
 * Reject an id whose UTF-8 encoding exceeds the storable id size.
 *
 * @param kind (string): the object kind, for the message.
 * @param oid (string): the id.
 */
function requireIdSize(kind: string, oid: string): void {
  const size = utf8(oid).length;
  if (size > MAX_ID_BYTES) {
    throw new ValidationError(`${kind} id is too long (${size} bytes); keep ids under ${MAX_ID_BYTES} bytes`);
  }
}

/**
 * Reject an entity id whose type prefix is not the id form of the entity's type.
 *
 * @param eid (string): the canonical entity id.
 * @param type (string): the entity type, after schema alias canonicalization.
 * @return (void): nothing; throws ValidationError when the prefix and the type differ.
 */
function requireIdMatchesType(eid: string, type: string): void {
  const expected = ids.slug(type);
  if (eid.slice(0, eid.indexOf(":")) !== expected) {
    throw new ValidationError(`id ${pyRepr(eid)} does not match type ${pyRepr(type)} (expected prefix '${expected}:')`);
  }
}

/**
 * Validate an entity's type, name, and resolved id before writing.
 *
 * @param eid (unknown): the resolved entity id.
 * @param type (unknown): the entity type, used as a backend label.
 * @param name (unknown): the entity name.
 */
export function validateEntityIdentity(eid: unknown, type: unknown, name: unknown): void {
  if (typeof eid !== "string") throw new ValidationError(`entity id must be a string, got ${typeName(eid)}`);
  if (typeof type !== "string" || typeof name !== "string" || !pyStrip(type) || !pyStrip(name)) {
    throw new ValidationError(
      "entity type and name cannot be empty; an entity needs both, e.g. type='Person', name='Jane Doe'",
    );
  }
  if (RESERVED_LABELS.has(lower(pyStrip(type)))) {
    throw new ValidationError(`entity type ${pyRepr(type)} is reserved for internal use; choose another type`);
  }
  if (type.includes("`")) throw new ValidationError("entity type cannot contain a backtick");
  ids.rejectTypeColon(type);
  if (hasControl(name) || hasControl(type)) {
    throw new ValidationError("entity type and name cannot contain control or surrogate characters");
  }
  if (![...type].every((ch) => TYPE_CHAR.test(ch) || ids.isMark(ch))) {
    throw new ValidationError(
      `entity type ${pyRepr(type)} can only contain letters, digits, spaces, '_', '-', and '.'`,
    );
  }
  if (hasControl(eid)) throw new ValidationError("entity id cannot contain control or surrogate characters");
  ids.requireEntityShape(eid);
  const prefix = eid.slice(0, eid.indexOf(":"));
  if (ids.RESERVED_ID_PREFIXES.has(lower(prefix))) {
    throw new ValidationError(`entity id prefix ${pyRepr(prefix)} is reserved for internal use`);
  }
  requireIdSize("entity", eid);
}

export function validateStrength(strength: unknown): void {
  if (strength != null) requireUnit("preference strength", strength);
}

/**
 * Validate a caller-chosen relation, preference, or decision id, which must carry its own kind as prefix.
 *
 * @param kind (string): the object kind and required id prefix.
 * @param oid (unknown): the id, or null to skip the check.
 */
export function validateOwnId(kind: string, oid: unknown): void {
  if (oid == null) return;
  if (typeof oid !== "string") throw new ValidationError(`${kind} id must be a string, got ${typeName(oid)}`);
  if (!oid) throw new ValidationError(`${kind} id cannot be empty`);
  if (hasControl(oid)) throw new ValidationError(`${kind} id cannot contain control or surrogate characters`);
  requireIdSize(kind, oid);
  const sep = oid.indexOf(":");
  const prefix = sep >= 0 ? lower(oid.slice(0, sep)) : "";
  if (prefix !== kind) throw new ValidationError(`${kind} id must start with '${kind}:', got ${pyRepr(oid)}`);
  if (!pyStrip(oid.slice(sep + 1))) {
    throw new ValidationError(`${kind} id must have a non-empty name after '${kind}:', got ${pyRepr(oid)}`);
  }
}

/**
 * Reject an update that names no field to change.
 *
 * @param changes (T): the fields the update sets or clears.
 * @return (T): the same fields.
 */
export function requireChanges<T extends object>(changes: T): T {
  if (!Object.values(changes).some((v) => v !== undefined)) {
    throw new ValidationError("nothing to update; pass at least one field to change");
  }
  return changes;
}

/**
 * Validate the fields an update clears: each must be clearable and not also given a value.
 *
 * @param method (string): the update method, for the error.
 * @param clear (unknown): the field names to clear.
 * @param allowed (readonly string[]): the fields this update can clear.
 * @param given (Record<string, unknown>): the values the update sets, by field.
 * @return (Set<string>): the fields to clear.
 */
function requireClear(
  method: string,
  clear: unknown,
  allowed: readonly string[],
  given: Record<string, unknown>,
): Set<string> {
  requireList("clear", clear);
  for (const key of clear) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`${method} cannot clear ${pyRepr(key)}; clearable fields: ${allowed.join(", ")}`);
    }
    if (given[key] != null) throw new ValidationError(`${method} cannot both set and clear ${pyRepr(key)}`);
  }
  return new Set(clear);
}

function requireChoice<T extends string>(field: string, value: unknown, choices: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${pyRepr(choices)}, got ${pyRepr(value)}`);
  }
}

export function canonProps(props: Props | null | undefined): JsonObject {
  if (!props || Object.keys(props).length === 0) return {};
  return loads(dumps(props), {});
}

/**
 * Apply property changes over stored properties, where a null value removes its key.
 *
 * @param base (JsonObject | null): the stored properties, or null for a new object.
 * @param changes (Props | null | undefined): the caller's properties; null values clear keys.
 * @param removed (readonly string[]): further keys to drop.
 * @return (JsonObject): the merged properties, with no null-valued key from the changes.
 */
export function mergeProps(
  base: JsonObject | null,
  changes: Props | null | undefined,
  removed: readonly string[] = [],
): JsonObject {
  const merged: JsonObject = { ...base, ...canonProps(changes) };
  for (const [key, value] of Object.entries(changes ?? {})) if (value === null) delete merged[key];
  for (const key of removed) delete merged[key];
  return merged;
}

function requireCleanEvidence(ev: unknown): void {
  if (!isPlainObject(ev)) throw new ValidationError(`evidence must be EvidenceInput objects, got a ${typeName(ev)}`);
  requireStr("evidence source_id", ev.source_id);
  requireOptionalText("evidence chunk_id", ev.chunk_id);
  if (ev.quote != null) {
    if (typeof ev.quote !== "string")
      throw new ValidationError(`evidence quote must be a string, got ${typeName(ev.quote)}`);
    if (hasSurrogate(ev.quote))
      throw new ValidationError("evidence quote cannot contain unpaired surrogate characters");
  }
  if (ev.confidence != null) requireUnit("evidence confidence", ev.confidence, true);
  for (const [name, offset] of [
    ["evidence start_offset", ev.start_offset],
    ["evidence end_offset", ev.end_offset],
  ] as const) {
    if (offset == null) continue;
    requireInt(name, offset);
    if (offset < 0) throw new ValidationError(`${name} cannot be negative, got ${offset}`);
  }
  if (ev.start_offset != null && ev.end_offset != null && ev.start_offset > ev.end_offset) {
    throw new ValidationError(`evidence start_offset ${ev.start_offset} is greater than end_offset ${ev.end_offset}`);
  }
}

/**
 * Turn caller-supplied evidence inputs into stored evidence.
 *
 * @param inputs (readonly ParsedEvidenceInput[]): the evidence to convert.
 * @param sourceId (string | null): the source being inserted; only evidence citing it takes sourceVersion.
 * @param sourceVersion (string | null): the inserted source's version; other evidence gets "<source_id>:manual".
 * @return (Evidence[]): the stored evidence.
 */
export function evidenceFromInputs(
  inputs: readonly ParsedEvidenceInput[],
  sourceId: string | null = null,
  sourceVersion: string | null = null,
): Evidence[] {
  if (!Array.isArray(inputs)) {
    throw new ValidationError(`evidence must be a list of Evidence objects, got ${typeName(inputs)}`);
  }
  return inputs.map((ev) => {
    requireCleanEvidence(ev);
    return evidenceOf({
      source_id: ev.source_id,
      source_version: sourceVersion && ev.source_id === sourceId ? sourceVersion : `${ev.source_id}:manual`,
      chunk_id: ev.chunk_id,
      quote: ev.quote,
      start_offset: ev.start_offset,
      end_offset: ev.end_offset,
      confidence: ev.confidence,
    });
  });
}

/**
 * The evidence an inserted relation records: its own, plus the source-level one unless it cites that version.
 *
 * @param inputs (readonly ParsedEvidenceInput[]): the relation's explicit evidence.
 * @param base (readonly Evidence[]): the insert's source-level evidence, empty without a source.
 * @param sourceId (string | null): the inserted source, if any.
 * @param sourceVersion (string | null): the inserted source's version, if any.
 * @return (Evidence[]): the evidence to record for the relation.
 */
export function relationEvidence(
  inputs: readonly ParsedEvidenceInput[],
  base: readonly Evidence[],
  sourceId: string | null,
  sourceVersion: string | null,
): Evidence[] {
  const own = evidenceFromInputs(inputs, sourceId, sourceVersion);
  const cited = sourceVersion !== null && own.some((ev) => ev.source_version === sourceVersion);
  return cited ? own : [...base, ...own];
}

export const dedupList = (items: readonly string[]): string[] => [...new Set(items)];

/**
 * Keep one item per id: the last write wins, at the position the id first appeared.
 *
 * @param items (readonly T[]): models with an id.
 * @return (T[]): the deduplicated items.
 */
export const uniqueById = <T extends { id: string }>(items: readonly T[]): T[] => [
  ...new Map(items.map((item) => [item.id, item] as const)).values(),
];

/**
 * Dedup an entity's aliases after cleaning each like a name, dropping blank ones and any equal to the name.
 *
 * @param name (string): the entity name.
 * @param items (readonly string[]): the aliases.
 * @return (string[]): the trimmed, NFC-normalized aliases, order preserved, without duplicates, blanks, or the name itself ignoring case.
 */
export function aliasList(name: string, items: readonly string[]): string[] {
  const own = casefold(cleanText(name));
  return dedupList(items.map(cleanText)).filter((a) => a && casefold(a) !== own);
}

const PAGE = 500;
const BATCH = 1000;
const RELATION_ID_BATCH = 256;
const EXISTS_BATCH = 256;

/**
 * Call a skip/limit list function page by page until it runs dry or reaches the cap.
 *
 * @param fetch ((skip: number, limit: number) => Promise<T[]>): the list call.
 * @param cap (number): the most rows to read.
 * @param page (number): the rows to read per call.
 * @return (T[]): every row read, in store order.
 */
export async function scan<T>(
  fetch: (skip: number, limit: number) => Promise<T[]>,
  cap = Number.POSITIVE_INFINITY,
  page = PAGE,
): Promise<T[]> {
  const out: T[] = [];
  while (out.length < cap) {
    const batch = await fetch(out.length, page);
    out.push(...batch);
    if (batch.length < page) break;
  }
  return out;
}

/**
 * Split a list into consecutive batches of at most size items.
 *
 * @param items (readonly T[]): the items to split.
 * @param size (number): the largest batch.
 * @return (T[][]): the batches, in order.
 */
export function batches<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Fetch the stored properties of many nodes of one label by id, a batch per query.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param label (string): the node label.
 * @param nodeIds (readonly string[]): the node ids.
 * @return (Map<string, Props>): each found node's properties by id.
 */
export async function nodesById(
  runner: Runner,
  ns: string,
  label: string,
  nodeIds: readonly string[],
): Promise<Map<string, Props>> {
  const found = new Map<string, Props>();
  for (const batch of batches(nodeIds)) {
    for (const props of await runner.matchNodes(ns, label, { any_of: { id: batch }, limit: batch.length })) {
      found.set(idOf(props), props);
    }
  }
  return found;
}

/**
 * Read every node of one label whose property is one of some values, a batch of values per paged query.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param label (string): the node label.
 * @param key (string): the property.
 * @param values (readonly string[]): the accepted values.
 * @param equals (Props | null): exact property matches every node must also have.
 * @return (Props[]): the node property maps.
 */
export async function nodesWhere(
  runner: Runner,
  ns: string,
  label: string,
  key: string,
  values: readonly string[],
  equals: Props | null = null,
): Promise<Props[]> {
  const rows: Props[] = [];
  for (const batch of batches(values)) {
    rows.push(...(await scan(nodeListing(runner, ns, label, { equals, any_of: { [key]: batch } }), Infinity, BATCH)));
  }
  return rows;
}

/**
 * Yield the pages of an id-ordered read, each resuming after the last id read, until it runs dry.
 *
 * @param fetch ((after: string | null, limit: number) => Promise<T[]>): the read, given the id to resume after (null to start) and the page size; it returns rows with an id, in id order.
 * @param page (number): the rows to read per call.
 * @return (AsyncGenerator<T[]>): each non-empty page, in id order.
 */
export async function* keyset<T extends { id?: unknown }>(
  fetch: (after: string | null, limit: number) => Promise<T[]>,
  page = PAGE,
): AsyncGenerator<T[]> {
  let after: string | null = null;
  for (;;) {
    const rows = await fetch(after, page);
    if (rows.length) yield rows;
    if (rows.length < page) return;
    after = rows[rows.length - 1]!.id as string;
  }
}

/**
 * A skip/limit node listing for scan, ordered by id.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param label (string): the node label.
 * @param filters (Pick<MatchNodesOptions, "equals" | "any_of">): the filters forwarded to matchNodes.
 * @return ((skip: number, limit: number) => Promise<Props[]>): the listing.
 */
export function nodeListing(
  runner: Runner,
  ns: string,
  label: string,
  filters: Pick<MatchNodesOptions, "equals" | "any_of">,
): (skip: number, limit: number) => Promise<Props[]> {
  return (skip, limit) => runner.matchNodes(ns, label, { ...filters, skip, limit });
}

/** The statement of an evidence row no merge rewrote (see evidenceVia). */
export const DIRECT = "";

/**
 * The statements that wrote one stored evidence row, as recorded in its via property.
 *
 * Each entry is DIRECT for a statement no merge rewrote, or the space-separated, sorted ids of the merges whose rewrite carried the statement onto the row's target. A row written before via was recorded counts as direct.
 *
 * @param props (Props): the stored evidence row.
 * @return (string[]): the row's statements.
 */
export function evidenceVia(props: Props): string[] {
  const via = props.via as string[] | null | undefined;
  return via?.length ? [...via] : [DIRECT];
}

/**
 * The via entry of a statement that the given merges rewrote, or DIRECT for none.
 *
 * @param mergeIds (Iterable<string>): the merge ids.
 * @return (string): the entry.
 */
export function viaOf(mergeIds: Iterable<string>): string {
  return [...new Set(mergeIds)].sort(comparePy).join(" ");
}

/**
 * Find which evidence records are not stored yet and how many distinct sources each target then holds.
 *
 * Records are looked up by id first; only a target missing a record is then read for the sources it already has.
 * The count is the distinct sources the target's evidence will hold, not an increment on the stored count, so a
 * write retried after one that stopped between the count and the evidence ends on the same number. A target with
 * no stored version has no stored evidence, so targets in newTargets skip both lookups.
 * Each record also lists the statements that wrote it (see evidenceVia), so an unmerge moves exactly the rows a
 * merge carried; a stored record that gains a statement is rewritten with its original created_at.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param items (ReadonlyArray<readonly [string, Evidence]>): (target id, evidence) pairs to record.
 * @param newTargets (ReadonlySet<string>): targets known to have no stored evidence.
 * @param via (ReadonlyArray<readonly string[]> | null): each item's statements, as viaOf gives them; null for all direct.
 * @return ([NodeRow[], Map<string, number>]): the records to write, and the source count of each target that gains a
 *   source.
 */
async function planEvidence(
  runner: Runner,
  ns: string,
  items: ReadonlyArray<readonly [string, Evidence]>,
  newTargets: ReadonlySet<string>,
  via: ReadonlyArray<readonly string[]> | null = null,
): Promise<[NodeRow[], Map<string, number>]> {
  const pending = new Map<string, readonly [string, Evidence, Set<string>]>();
  items.forEach(([target, ev], i) => {
    const evid = ids.evidenceId(target, ev);
    const entry = pending.get(evid) ?? ([target, ev, new Set<string>()] as const);
    for (const statement of via === null ? [DIRECT] : via[i]!) entry[2].add(statement);
    pending.set(evid, entry);
  });
  const known = [...pending].filter(([, [target]]) => !newTargets.has(target)).map(([evid]) => evid);
  const stored = await nodesById(runner, ns, L_EVIDENCE, known);
  const unstored = dedupList(known.filter((evid) => !stored.has(evid)).map((evid) => pending.get(evid)![0]));
  const sourcesOf = new Map<string, Set<string>>();
  for (const props of await nodesWhere(runner, ns, L_EVIDENCE, "target_id", unstored)) {
    const target = props.target_id as string;
    sourcesOf.set(target, (sourcesOf.get(target) ?? new Set<string>()).add(props.source_id as string));
  }
  const records: NodeRow[] = [];
  const counts = new Map<string, number>();
  for (const [evid, [target, ev, statements]] of pending) {
    const prior = stored.get(evid);
    if (prior !== undefined) {
      const held = evidenceVia(prior);
      const added = [...statements].filter((s) => !held.includes(s));
      if (added.length) records.push([evid, { ...prior, via: [...held, ...added] }]);
      continue;
    }
    const props = encodeEvidenceProps({ ns, id: evid, target_id: target, evidence: ev });
    if (statements.size !== 1 || !statements.has(DIRECT)) props.via = [...statements];
    records.push([evid, props]);
    const sources = sourcesOf.get(target) ?? new Set<string>();
    sourcesOf.set(target, sources);
    if (!sources.has(ev.source_id)) {
      sources.add(ev.source_id);
      counts.set(target, sources.size);
    }
  }
  return [records, counts];
}

/**
 * Write evidence records, each new one stamped with the write that recorded it, for known_at reads.
 *
 * A stored record rewritten with more statements keeps the created_at it already has.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param records (readonly NodeRow[]): the evidence ids and properties to write.
 * @param known (Date): the write's timestamp.
 * @return (Promise<void>): nothing.
 */
async function writeEvidence(runner: Runner, ns: string, records: readonly NodeRow[], known: Date): Promise<void> {
  if (!records.length) return;
  const stamp = toIso(known);
  await runner.upsertNodes(
    ns,
    L_EVIDENCE,
    records.map(([evid, props]) => [evid, { created_at: stamp, ...props }]),
  );
}

/**
 * Take and remove a target's new source count, so it applies to the first input naming the target.
 *
 * @param counts (Map<string, number>): the source count of each target that gained a source.
 * @param target (string): the entity or relation id.
 * @param stored (number): the count the target already has.
 * @return (number): the new count, or the stored one when the target gained no source or the count was taken.
 */
function takeCount(counts: Map<string, number>, target: string, stored: number): number {
  const n = counts.get(target) ?? stored;
  counts.delete(target);
  return n;
}

/**
 * List the evidence records supporting one entity or relation, ordered by evidence id.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param targetId (string): the entity or relation id.
 * @param kind ("entity" | "relation"): which object the id names, for validation and the not-found error.
 * @param skip (number): rows to skip.
 * @param limit (number): maximum rows.
 * @return (Evidence[]): the evidence; throws NotFoundError when the first page is empty and the target is unknown.
 */
export async function listEvidence(
  runner: Runner,
  ns: string,
  given: string,
  kind: "entity" | "relation",
  skip: number,
  limit: number,
): Promise<Evidence[]> {
  if (kind !== "entity") requireStr(`${kind} id`, given);
  const targetId = kind === "entity" ? ids.canonicalEntityId(given) : given;
  const rows = await runner.matchNodes(ns, L_EVIDENCE, { equals: { target_id: targetId }, skip, limit });
  if (!rows.length) {
    if (kind === "entity") {
      if (!(await runner.nodeExists(ns, L_ENTITY, targetId))) throw await missingEntity(runner, ns, targetId);
    } else if (!(await relationExists(runner, ns, targetId))) {
      throw new NotFoundError("Relation", targetId, undefined, { namespace: ns });
    }
  }
  return rows.map(decodeEvidence);
}

export async function deleteEvidence(runner: Runner, ns: string, targetId: string): Promise<void> {
  await runner.deleteNodesBy(ns, L_EVIDENCE, { target_id: targetId });
}

export const precheckNodes = (runner: Runner, ns: string, label: string, rows: readonly NodeRow[]): void =>
  runner.checkNodeWrites?.(ns, label, rows);

export const precheckEdges = (
  runner: Runner,
  ns: string,
  fromLabel: string,
  toLabel: string,
  rows: readonly EdgeWrite[],
): void => runner.checkEdgeWrites?.(ns, fromLabel, toLabel, rows);

async function entityKnown(runner: Runner, ns: string, eid: unknown, known: Set<string>): Promise<boolean> {
  if (typeof eid !== "string") throw new ValidationError(`entity reference must be a string id, got ${typeName(eid)}`);
  if (hasControl(eid)) throw new ValidationError("entity reference cannot contain control or surrogate characters");
  if (known.has(eid)) return true;
  const present = await runner.nodeExists(ns, L_ENTITY, eid);
  if (present) known.add(eid);
  return present;
}

/**
 * Tell whether an entity reference is a clean string id not yet known present.
 * @param eid (unknown): the entity reference.
 * @param known (Set<string>): entity ids known present.
 * @return (boolean): true when the store would be asked about it.
 */
const unchecked = (eid: unknown, known: Set<string>): eid is string =>
  typeof eid === "string" && !known.has(eid) && !hasControl(eid);

type NodesExist = NonNullable<Runner["nodesExist"]>;

/**
 * Ask the store once which unchecked endpoints of the next relations exist, adding the present ones to known.
 * @param probe (NodesExist): the store's nodesExist.
 * @param ns (string): the namespace.
 * @param relations (readonly ParsedRelationInput[]): the relations being validated.
 * @param start (number): the index of the first relation to look ahead from.
 * @param known (Set<string>): entity ids known present; updated in place.
 * @return ([number, NodesExist | null]): the index after the relations covered, and the probe to use next, or null
 */
async function prefetchEndpoints(
  probe: NodesExist,
  ns: string,
  relations: readonly ParsedRelationInput[],
  start: number,
  known: Set<string>,
): Promise<[number, NodesExist | null]> {
  const batch = new Set<string>();
  let end = start;
  while (end < relations.length && batch.size <= EXISTS_BATCH - 2) {
    for (const eid of [relations[end]!.from_entity, relations[end]!.to_entity]) {
      if (unchecked(eid, known)) batch.add(eid);
    }
    end += 1;
  }
  if (!batch.size) return [end, probe];
  let present: Set<string>;
  try {
    present = await probe(ns, L_ENTITY, [...batch]);
  } catch {
    return [end, null];
  }
  for (const eid of batch) if (present.has(eid)) known.add(eid);
  return [end, probe];
}

/**
 * Throw a ValidationError naming each relation endpoint that is neither in known nor in the graph.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param fromId (unknown): the source entity id.
 * @param toId (unknown): the destination entity id.
 * @param hint (string): the advice appended to the error.
 * @param known (Set<string>): entity ids that count as present.
 */
async function requireEndpoints(
  runner: Runner,
  ns: string,
  fromId: unknown,
  toId: unknown,
  hint: string,
  known: Set<string> = new Set(),
): Promise<void> {
  const missing: string[] = [];
  for (const [end, eid] of [
    ["from", fromId],
    ["to", toId],
  ] as const) {
    if (!(await entityKnown(runner, ns, eid, known))) missing.push(`${end}=${pyRepr(eid)}`);
  }
  if (missing.length) {
    throw new ValidationError(
      `relation endpoint${missing.length > 1 ? "s" : ""} not found (${missing.join(", ")}); ${hint}`,
      { code: "unknown_reference" },
    );
  }
}

async function requireEntity(
  runner: Runner,
  ns: string,
  eid: string | null | undefined,
  context: string,
  known: Set<string> = new Set(),
): Promise<void> {
  if (eid == null) return;
  if (!(await entityKnown(runner, ns, eid, known))) {
    throw new ValidationError(`${context} references unknown entity ${pyRepr(eid)}`, { code: "unknown_reference" });
  }
}

async function requirePreferenceRefs(
  runner: Runner,
  ns: string,
  pref: { value_entity: string; about_entity?: string | null },
  known?: Set<string>,
): Promise<void> {
  await requireEntity(runner, ns, pref.value_entity, "preference", known);
  await requireEntity(runner, ns, pref.about_entity, "preference about_entity", known);
}

async function requireTraceRefs(
  runner: Runner,
  ns: string,
  trace: { actor_entity: string | null; outcome_entity: string | null; alternative_entities: readonly string[] },
  known?: Set<string>,
): Promise<void> {
  await requireEntity(runner, ns, trace.actor_entity, "decision actor_entity", known);
  await requireEntity(runner, ns, trace.outcome_entity, "decision outcome_entity", known);
  for (const alt of trace.alternative_entities)
    await requireEntity(runner, ns, alt, "decision alternative_entity", known);
}

/**
 * Canonicalise every explicit entity id and entity reference in facts with canonicalEntityId.
 *
 * @param facts (ParsedExtraction): the facts.
 * @return (ParsedExtraction): a copy whose entity ids and references are canonical.
 */
function canonicalRefs(facts: ParsedExtraction): ParsedExtraction {
  const c = ids.canonicalId;
  return {
    ...facts,
    entities: facts.entities.map((e) => ({ ...e, id: c(e.id) })),
    relations: facts.relations.map((r) => ({ ...r, from_entity: c(r.from_entity), to_entity: c(r.to_entity) })),
    preferences: facts.preferences.map((p) => ({
      ...p,
      subject_entity: c(p.subject_entity),
      value_entity: c(p.value_entity),
      about_entity: c(p.about_entity),
    })),
    decisions: facts.decisions.map((d) => ({
      ...d,
      actor_entity: c(d.actor_entity),
      outcome_entity: c(d.outcome_entity),
      alternative_entities: Array.isArray(d.alternative_entities)
        ? d.alternative_entities.map(c)
        : d.alternative_entities,
    })),
  };
}

const SUGGEST_SCAN = 500;

/**
 * The error for an entity id that does not exist, suggesting the closest existing id of the same type.
 *
 * @param runner (Runner): the store.
 * @param ns (string): namespace.
 * @param eid (string): the missing entity id.
 * @return (Promise<NotFoundError>): the error, naming the namespace, and the suggestion when an id is close.
 */
export async function missingEntity(runner: Runner, ns: string, eid: string): Promise<NotFoundError> {
  const cut = eid.indexOf(":");
  const [kind, name] = cut < 0 ? [eid, ""] : [eid.slice(0, cut), eid.slice(cut + 1)];
  const chars = Array.from(name);
  const ids = new Set<string>();
  for (const stem of new Set([chars.slice(0, -2), chars.slice(0, 1), []].map((part) => `${kind}:${part.join("")}`))) {
    for (const row of await runner.matchNodes(ns, L_ENTITY, { id_gt: stem, limit: SUGGEST_SCAN })) {
      if ((row.id as string).startsWith(stem)) ids.add(row.id as string);
    }
  }
  const suggestion = suggestKey(eid, [...ids]);
  return new NotFoundError("Entity", eid, undefined, { namespace: ns, suggestion });
}

/**
 * Check every reference and value in facts before any write, so a bad one fails atomically.
 *
 * Explicit entity ids and entity references are canonicalized first (see canonicalEntityId), and entity identities checked, before the rewrite.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param given (ParsedExtraction): the facts to check.
 * @param rewrite ((facts: ParsedExtraction) => ParsedExtraction | undefined): applied after id canonicalization and before the reference checks, such as the schema's type alias canonicalization, so references in either form resolve.
 * @return (ParsedExtraction): the facts with canonical entity ids.
 */
export async function validateFacts(
  runner: Runner,
  ns: string,
  given: ParsedExtraction,
  rewrite?: (facts: ParsedExtraction) => ParsedExtraction,
): Promise<ParsedExtraction> {
  let facts = canonicalRefs(given);
  const idsOf = (o: ParsedExtraction) => o.entities.map((e) => e.id || ids.entityId(e.type, e.name));
  let entityIds = idsOf(facts);
  for (const [i, ent] of facts.entities.entries()) validateEntityIdentity(entityIds[i], ent.type, ent.name);
  if (rewrite) {
    facts = rewrite(facts);
    entityIds = idsOf(facts);
  }
  for (const [i, ent] of facts.entities.entries()) requireIdMatchesType(entityIds[i]!, ent.type);
  const entities = new Set(entityIds);
  const relations = new Set(facts.relations.map((r) => r.id || ids.relationId(r.from_entity, r.type, r.to_entity)));

  for (const item of [...facts.entities, ...facts.relations, ...facts.preferences]) {
    if (item.properties == null) throw new ValidationError("properties must be a mapping, got null");
    requireJsonMapping("properties", item.properties);
  }
  for (const ent of facts.entities) {
    requireStrMapping("external_ids", ent.external_ids);
    requireList("entity aliases", ent.aliases);
  }

  let probe = runner.nodesExist?.bind(runner) ?? null;
  let window = 0;
  for (const [at, rel] of facts.relations.entries()) {
    validateOwnId("relation", rel.id);
    requireDatetime("relation event_time", rel.event_time);
    rejectReservedRelType(ids.normalizeRelType(rel.type), rel.type);
    if (!Array.isArray(rel.evidence))
      throw new ValidationError(`relation evidence must be a list, got ${typeName(rel.evidence)}`);
    for (const ev of rel.evidence) requireCleanEvidence(ev);
    if (probe && at >= window && (unchecked(rel.from_entity, entities) || unchecked(rel.to_entity, entities))) {
      [window, probe] = await prefetchEndpoints(probe, ns, facts.relations, at, entities);
    }
    await requireEndpoints(
      runner,
      ns,
      rel.from_entity,
      rel.to_entity,
      "endpoints must be entity ids ('type:name') listed in these facts' entities or already in the graph. " +
        "Ids are canonicalized; compute one with entityId(type, name)",
      entities,
    );
  }

  for (const pref of facts.preferences) {
    validateOwnId("preference", pref.id);
    requireDatetime("preference event_time", pref.event_time);
    requireChoice("preference stance", pref.stance, STANCES);
    requireStr("preference key", pref.key);
    validateStrength(pref.strength);
    if (!(await entityKnown(runner, ns, pref.subject_entity, entities))) {
      throw new ValidationError(`preference references unknown subject entity ${pyRepr(pref.subject_entity)}`, {
        code: "unknown_reference",
      });
    }
    await requirePreferenceRefs(runner, ns, pref, entities);
  }

  for (const dec of facts.decisions) {
    validateOwnId("decision", dec.id);
    requireDatetime("decision event_time", dec.event_time);
    if (dec.status !== null) requireChoice("decision status", dec.status, STATUSES);
    requireStr("decision title", dec.title);
    requireOptionalText("decision summary", dec.summary);
    requireOptionalText("decision rationale", dec.rationale);
    requireList("decision steps", dec.steps);
    requireList("decision alternative_entities", dec.alternative_entities);
    for (const relId of dec.steps) {
      if (!relations.has(relId) && !(await relationExists(runner, ns, relId))) {
        throw new ValidationError(`decision step references unknown relation ${pyRepr(relId)}`, {
          code: "unknown_reference",
        });
      }
    }
    await requireTraceRefs(runner, ns, dec, entities);
  }
  return facts;
}

export async function getEntity(runner: Runner, ns: string, eid: string): Promise<Entity | null> {
  const props = await runner.getNode(ns, L_ENTITY, ids.canonicalEntityId(eid));
  return props ? decodeEntity(props) : null;
}

/** Keep explicitly written fields out of live merges' removal sets. */
export async function preserveEntityWrites(
  runner: Runner,
  ns: string,
  writes: Iterable<readonly [string, UpdateEntityFields]>,
): Promise<void> {
  const fieldsById = new Map<string, UpdateEntityFields[]>();
  for (const [eid, fields] of writes) {
    const group = fieldsById.get(eid) ?? [];
    group.push(fields);
    fieldsById.set(eid, group);
  }
  const rows = await nodesWhere(runner, ns, L_MERGE, "survivor_id", [...fieldsById.keys()]);
  for (const row of rows) {
    if (row.reverted_at != null) continue;
    const props = { ...row };
    for (const fields of fieldsById.get(row.survivor_id as string) ?? []) {
      for (const [key, values] of [
        ["aliases", (fields.aliases ?? []).map(cleanText)],
        ["properties", Object.keys(fields.properties ?? {})],
        ["external_ids", Object.keys(fields.external_ids ?? {})],
      ] as const) {
        const column = `added_${key}_json`;
        props[column] = dumps(loads<string[]>(props[column], []).filter((v) => !values.includes(v)));
      }
    }
    if (!deepEqual(props, row)) {
      await runner.lockNode(ns, L_MERGE, row.id as string);
      await runner.upsertNode(ns, L_MERGE, row.id as string, props);
    }
  }
}

async function lockNodes(runner: Runner, ns: string, label: string, ids: readonly string[]): Promise<void> {
  if (ids.length > 1 && runner.lockNodes) {
    await runner.lockNodes(ns, label, ids);
  } else {
    for (const id of ids) await runner.lockNode(ns, label, id);
  }
}

/**
 * Insert-semantics upsert of many entities: keep stored names, record new surface forms as aliases, merge the rest.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param ents (readonly ParsedEntityInput[]): the entities to upsert, in order.
 * @param evidence (Evidence[]): evidence recorded for every entity.
 * @param createdAt (Date): the timestamp for the created and updated fields.
 * @param schemaTypes (ReadonlySet<string>): the schema's entity type names, which a stored entity's type may adopt.
 * @param via (ReadonlyMap<string, Iterable<string>> | null): the statements behind each entity's evidence (see evidenceVia), by entity id; an entity not listed, or null, records direct statements.
 * @return (Entity[]): each input's stored entity, in input order.
 */
export async function upsertEntities(
  runner: Runner,
  ns: string,
  ents: readonly ParsedEntityInput[],
  evidence: Evidence[],
  createdAt: Date,
  schemaTypes: ReadonlySet<string> = new Set(),
  via: ReadonlyMap<string, Iterable<string>> | null = null,
): Promise<Entity[]> {
  const keyed = ents.map((ent) => {
    const etype = cleanText(ent.type);
    const ename = cleanText(ent.name);
    const eid = ent.id || ids.entityId(etype, ename);
    validateEntityIdentity(eid, etype, ename);
    return { eid, etype, ename, ent };
  });
  const eids = dedupList(keyed.map((k) => k.eid));
  await lockNodes(runner, ns, L_ENTITY, eids);
  const stored = new Map<string, Entity>();
  for (const [eid, props] of await nodesById(runner, ns, L_ENTITY, eids)) stored.set(eid, decodeEntity(props));
  const [records, counts] = await planEvidence(
    runner,
    ns,
    eids.flatMap((eid) => evidence.map((ev) => [eid, ev] as const)),
    new Set(eids.filter((eid) => !stored.has(eid))),
    via === null ? null : eids.flatMap((eid) => evidence.map(() => [...(via.get(eid) ?? [DIRECT])])),
  );

  const current = new Map(stored);
  const writes = new Map<string, Props>();
  const out: Entity[] = [];
  for (const { eid, etype: given, ename, ent } of keyed) {
    let etype = given;
    const prev = current.get(eid);
    const sources = takeCount(counts, eid, prev?.source_count ?? 0);
    let props: Props;
    if (prev === undefined) {
      props = encodeEntityProps({
        ns,
        id: eid,
        type: etype,
        name: ename,
        aliases: aliasList(ename, ent.aliases),
        external_ids: { ...ent.external_ids },
        properties: mergeProps(null, ent.properties),
        source_count: sources,
        created_at: createdAt,
        updated_at: createdAt,
      });
    } else {
      if (!schemaTypes.has(etype)) etype = prev.type;
      const aliases = aliasList(prev.name, [...prev.aliases, ...ent.aliases, ename]);
      const externalIds = { ...prev.external_ids, ...ent.external_ids };
      const properties = mergeProps(prev.properties, ent.properties);
      if (
        etype === prev.type &&
        deepEqual(aliases, prev.aliases) &&
        deepEqual(externalIds, prev.external_ids) &&
        deepEqual(properties, prev.properties) &&
        sources === prev.source_count
      ) {
        out.push(prev);
        continue;
      }
      props = encodeEntityProps({
        ns,
        id: eid,
        type: etype,
        name: prev.name,
        aliases,
        external_ids: externalIds,
        properties,
        source_count: sources,
        created_at: prev.created_at,
        updated_at: createdAt,
        relevance: prev.relevance,
        relevance_at: prev.relevance_at,
      });
    }
    writes.set(eid, props);
    current.set(eid, decodeEntity(props));
    out.push(current.get(eid)!);
  }

  precheckNodes(runner, ns, L_ENTITY, [...writes]);
  for (const [eid, props] of writes) {
    const before = stored.get(eid);
    if (before !== undefined && props.type !== before.type)
      await runner.removeNodeLabel(ns, L_ENTITY, eid, before.type);
  }
  const byType = new Map<string, NodeRow[]>();
  for (const [eid, props] of writes) {
    const rows = byType.get(props.type as string) ?? [];
    rows.push([eid, props]);
    byType.set(props.type as string, rows);
  }
  for (const [etype, rows] of byType) {
    if (runner.upsertNewNodes && rows.every(([eid]) => !stored.has(eid)))
      await runner.upsertNewNodes(ns, L_ENTITY, rows, { extra_label: etype });
    else await runner.upsertNodes(ns, L_ENTITY, rows, { extra_label: etype });
  }
  await writeEvidence(runner, ns, records, createdAt);
  return out;
}

export interface CreateEntityArgs {
  name: string;
  type: string;
  id?: string | null;
  aliases?: readonly string[] | null;
  external_ids?: Record<string, string> | null;
  properties?: JsonObject | null;
}

/**
 * Create one entity, failing if its id already exists.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (CreateEntityArgs): the entity fields.
 * @param schemaCheck (SchemaCheck | undefined): checks the entity against the schema before the write.
 * @return (Entity): the created entity.
 */
export async function createEntity(
  runner: Runner,
  ns: string,
  args: CreateEntityArgs,
  schemaCheck?: SchemaCheck,
): Promise<Entity> {
  requireStr("entity type", args.type);
  requireStr("entity name", args.name);
  const type = cleanText(args.type);
  const name = cleanText(args.name);
  const eid = ids.canonicalId(args.id) || ids.entityId(type, name);
  validateEntityIdentity(eid, type, name);
  requireIdMatchesType(eid, type);
  if (args.aliases != null) requireList("aliases", args.aliases);
  if (args.external_ids != null) requireStrMapping("external_ids", args.external_ids);
  requireJsonMapping("properties", args.properties);
  const properties = mergeProps(null, args.properties);
  await schemaCheck?.(runner, { entities: [{ id: args.id ? eid : null, type, name, properties }], relations: [] });
  await runner.lockNode(ns, L_ENTITY, eid);
  if (await runner.nodeExists(ns, L_ENTITY, eid)) throw new ConflictError("Entity", eid);
  const ts = new Date();
  const props = encodeEntityProps({
    ns,
    id: eid,
    type,
    name,
    aliases: aliasList(name, args.aliases ?? []),
    external_ids: { ...(args.external_ids ?? {}) },
    properties,
    source_count: 0,
    created_at: ts,
    updated_at: ts,
  });
  await runner.upsertNode(ns, L_ENTITY, eid, props, { extra_label: type });
  return decodeEntity(props);
}

export interface UpdateEntityFields {
  name?: string;
  type?: string;
  aliases?: readonly string[];
  external_ids?: Record<string, string>;
  properties?: JsonObject;
  remove_aliases?: readonly string[];
  remove_properties?: readonly string[];
}

/**
 * Update an entity: scalars (name, type) replace, collections (aliases, external_ids, properties) merge.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param eid (string): the entity id.
 * @param fields (UpdateEntityFields): the fields to change, plus remove_aliases and remove_properties.
 * @param schemaCheck (SchemaCheck | undefined): checks the resulting entity against the schema before the write, given the stored entity too so only violations the update introduces count.
 * @param removeExternalIds (readonly string[]): external id keys to drop, used by unmerge.
 * @return (Entity): the updated entity; throws ValidationError when no field is given.
 */
export async function updateEntity(
  runner: Runner,
  ns: string,
  given: string,
  fields: UpdateEntityFields,
  schemaCheck?: SchemaCheck,
  removeExternalIds: readonly string[] = [],
  schemaTypes: ReadonlySet<string> = new Set(),
): Promise<Entity> {
  checkOptions("entities.update", fields, ENTITY_UPDATE_FIELDS);
  requireChanges(fields ?? {});
  const eid = ids.canonicalEntityId(given);
  let existing = await getEntity(runner, ns, eid);
  if (existing === null) throw await missingEntity(runner, ns, eid);
  for (const key of ["aliases", "remove_aliases", "remove_properties"] as const) {
    if (fields[key] !== undefined) requireList(key, fields[key]);
  }
  if (fields.properties !== undefined) requireJsonMapping("properties", fields.properties);
  if (fields.external_ids !== undefined) requireStrMapping("external_ids", fields.external_ids);
  if (fields.type !== undefined) requireStr("entity type", fields.type);
  if (fields.name !== undefined) requireStr("entity name", fields.name);
  if (runner.lockRefreshesReads !== false && runner.lockAndGetNode) {
    const props = await runner.lockAndGetNode(ns, L_ENTITY, eid);
    existing = props ? decodeEntity(props) : null;
  } else {
    await runner.lockNode(ns, L_ENTITY, eid);
    if (runner.lockRefreshesReads !== false) existing = await getEntity(runner, ns, eid);
  }
  if (existing === null) throw new TransientError(`entity ${pyRepr(eid)} was changed concurrently; retry`);
  let type = fields.type !== undefined ? cleanText(fields.type) : existing.type;
  if (ids.slug(type) !== ids.slug(existing.type)) {
    throw new ValidationError(`type is part of the id ${pyRepr(eid)}; create a new entity to change its type`, {
      code: "immutable_identity",
      field: "type",
    });
  }
  if (!schemaTypes.has(type)) type = existing.type;
  const name = fields.name !== undefined ? cleanText(fields.name) : existing.name;
  validateEntityIdentity(eid, type, name);
  const removed = new Set((fields.remove_aliases ?? []).map(cleanText));
  const aliases = aliasList(name, [...existing.aliases, ...(fields.aliases ?? [])]).filter((a) => !removed.has(a));
  const properties = mergeProps(existing.properties, fields.properties, fields.remove_properties);
  const externalIds = { ...existing.external_ids, ...fields.external_ids };
  for (const key of removeExternalIds) delete externalIds[key];
  await schemaCheck?.(
    runner,
    { entities: [{ id: eid, type, name, properties }], relations: [] },
    {
      entities: [{ id: eid, type: existing.type, name: existing.name, properties: existing.properties }],
      relations: [],
    },
  );
  await preserveEntityWrites(runner, ns, [[eid, fields]]);
  if (
    type === existing.type &&
    name === existing.name &&
    deepEqual(aliases, existing.aliases) &&
    deepEqual(externalIds, existing.external_ids) &&
    deepEqual(properties, existing.properties)
  ) {
    return existing;
  }
  const props = encodeEntityProps({
    ns,
    id: eid,
    type,
    name,
    aliases,
    external_ids: externalIds,
    properties,
    source_count: existing.source_count,
    created_at: existing.created_at,
    updated_at: new Date(),
    relevance: existing.relevance,
    relevance_at: existing.relevance_at,
  });
  precheckNodes(runner, ns, L_ENTITY, [[eid, props]]);
  if (type !== existing.type) await runner.removeNodeLabel(ns, L_ENTITY, eid, existing.type);
  await runner.upsertNode(ns, L_ENTITY, eid, props, { extra_label: type });
  return decodeEntity(props);
}

/**
 * List entities, optionally filtered by type and exact name.
 *
 * The type filter ignores letter case, as entity ids do, and compares both sides after canonical (the schema's
 * alias canonicalization) when given. Stores match properties exactly, so a type filter reads entities in id order
 * and filters them here.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args ({ type?: string | null; name?: string | null; skip: number; limit: number; canonical?: (type: string) => string; after?: string | null }): the type filter, exact name filter, page, schema type canonicalizer, and the id to list after for keyset paging.
 * @return (Entity[]): the entities.
 */
export async function listEntities(
  runner: Runner,
  ns: string,
  args: {
    type?: string | null;
    name?: string | null;
    skip: number;
    limit: number;
    canonical?: (type: string) => string;
    after?: string | null;
  },
): Promise<Entity[]> {
  requireOptionalText("type filter", args.type);
  requireOptionalText("name filter", args.name);
  const equals: Props = {};
  if (args.name != null) equals.name = cleanText(args.name);
  if (args.type == null) {
    return (
      await runner.matchNodes(ns, L_ENTITY, { equals, skip: args.skip, limit: args.limit, id_gt: args.after })
    ).map(decodeEntity);
  }
  const key = (etype: string): string => entityTypeKey(etype, args.canonical);
  const wanted = key(args.type);
  const found: Props[] = [];
  let read = 0;
  while (found.length < args.skip + args.limit) {
    const rows = await runner.matchNodes(ns, L_ENTITY, { equals, skip: read, limit: BATCH, id_gt: args.after });
    read += rows.length;
    found.push(...rows.filter((r) => key(r.type as string) === wanted));
    if (rows.length < BATCH) break;
  }
  return found.slice(args.skip, args.skip + args.limit).map(decodeEntity);
}

/**
 * Delete a decision's steps no lookup can find, then its trace node, then the steps the lookup found.
 *
 * A cut-off delete then leaves either a trace the lookup still reaches through the steps it found, or a trace with no
 * steps that an actor or outcome lookup reaches.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param tid (string): the trace id.
 * @param found (ReadonlySet<string>): ids of the trace's steps the lookup that found it returned.
 * @return (boolean): true when a trace node or a found step was removed.
 */
export async function deleteTraceQuietly(
  runner: Runner,
  ns: string,
  tid: string,
  found: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const existed = await runner.nodeExists(ns, L_TRACE, tid);
  if (existed) {
    const steps = await runner.childNodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP);
    await runner.deleteNodes(
      ns,
      L_STEP,
      steps.map(idOf).filter((sid) => !found.has(sid)),
    );
    await runner.deleteNode(ns, L_TRACE, tid);
  }
  await runner.deleteNodes(ns, L_STEP, [...found].sort(comparePy));
  return existed || found.size > 0;
}

/**
 * Delete decision traces in id order, each with the ids of its steps a lookup found.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param traces (ReadonlyMap<string, ReadonlySet<string>>): each trace id and its found step ids.
 * @return (number): how many traces had a node or a found step removed.
 */
async function deleteTraces(
  runner: Runner,
  ns: string,
  traces: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<number> {
  let deleted = 0;
  for (const tid of [...traces.keys()].sort(comparePy)) {
    if (await deleteTraceQuietly(runner, ns, tid, traces.get(tid)!)) deleted += 1;
  }
  return deleted;
}

/**
 * Find decision traces that use any of some relations as one of their steps, with the steps that matched.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rids (readonly string[]): the relation ids.
 * @return (Map<string, Set<string>>): each owning trace id and the ids of its matching steps.
 */
export async function tracesTouchingRelations(
  runner: Runner,
  ns: string,
  rids: readonly string[],
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  for (const step of await nodesWhere(runner, ns, L_STEP, "relation_id", rids)) {
    const tid = ids.traceOfStep(idOf(step));
    found.set(tid, (found.get(tid) ?? new Set<string>()).add(idOf(step)));
  }
  return found;
}

/**
 * Find decision traces that reference any of some entities as actor, outcome, or step endpoint.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param eids (readonly string[]): the entity ids.
 * @return (Map<string, Set<string>>): each referencing trace id and the ids of its steps that matched, none when only
 *   the trace node does.
 */
async function tracesTouchingEntities(
  runner: Runner,
  ns: string,
  eids: readonly string[],
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  const lookups: Array<[string, string[]]> = [
    [L_TRACE, ["actor_entity", "outcome_entity"]],
    [L_STEP, ["from_entity", "to_entity"]],
  ];
  for (const [label, keys] of lookups) {
    for (const key of keys) {
      for (const node of await nodesWhere(runner, ns, label, key, eids)) {
        const tid = label === L_TRACE ? idOf(node) : ids.traceOfStep(idOf(node));
        const steps = found.get(tid) ?? new Set<string>();
        if (label === L_STEP) steps.add(idOf(node));
        found.set(tid, steps);
      }
    }
  }
  return found;
}

/**
 * Find decision traces that list any of some entities as a considered alternative.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param eids (readonly string[]): the entity ids.
 * @return (Map<string, Set<string>>): each trace id with the given entities it considered.
 */
async function tracesWithAlternatives(
  runner: Runner,
  ns: string,
  eids: readonly string[],
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  for (const edge of await edgesAt(
    runner,
    ns,
    { from_label: L_TRACE, to_label: L_ENTITY, type: R_CONSIDERED },
    "to_in",
    eids,
  )) {
    found.set(edge.from_id, (found.get(edge.from_id) ?? new Set<string>()).add(edge.to_id));
  }
  return found;
}

/**
 * Drop considered alternatives from a decision trace without deleting the trace.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param tid (string): the trace id.
 * @param eids (ReadonlySet<string>): the alternative entity ids to remove.
 */
async function pruneTraceAlternatives(
  runner: Runner,
  ns: string,
  tid: string,
  eids: ReadonlySet<string>,
): Promise<void> {
  const trace = await getTrace(runner, ns, tid);
  if (trace === null) return;
  const remaining = trace.alternative_entities.filter((a) => !eids.has(a));
  if (!deepEqual(remaining, trace.alternative_entities)) {
    await updateTrace(runner, ns, tid, { alternative_entities: remaining });
  }
}

/**
 * Point the steps of decision traces at the new ids of relations that moved, in trace id order.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param tids (Iterable<string>): the trace ids to rewrite.
 * @param moved (ReadonlyMap<string, string>): each moved relation id to its new id.
 */
export async function repointSteps(
  runner: Runner,
  ns: string,
  tids: Iterable<string>,
  moved: ReadonlyMap<string, string>,
): Promise<void> {
  for (const tid of [...tids].sort(comparePy)) {
    const trace = await getTrace(runner, ns, tid);
    if (trace === null) continue;
    await updateTrace(runner, ns, tid, { steps: trace.steps.map((s) => moved.get(s.relation_id) ?? s.relation_id) });
  }
}

/**
 * Delete an entity and everything attached to it, including the merge records it survived or was absorbed in.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param given (string): the entity id.
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @return (DeleteResult): counts of what was removed and restored.
 */
export async function deleteEntity(
  runner: Runner,
  ns: string,
  given: string,
  caps?: ReadonlyMap<string, RelationCap> | null,
): Promise<DeleteResult> {
  const eid = ids.canonicalEntityId(given);
  const counts = await deleteEntities(runner, ns, [eid], caps);
  if (!counts.deleted_entities) throw await missingEntity(runner, ns, eid);
  return counts;
}

/**
 * Read every version of the edges matching a filter and anchored at a list of endpoints, a batch per query.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param filter (Omit<MatchEdgesOptions, "from_in" | "to_in" | "skip" | "limit">): the edge filter.
 * @param side ("from_in" | "to_in"): which endpoint the ids anchor.
 * @param endpoints (readonly string[]): the endpoint ids.
 * @return (EdgeRow[]): the edge rows.
 */
export async function edgesAt(
  runner: Runner,
  ns: string,
  filter: Omit<MatchEdgesOptions, "from_in" | "to_in" | "skip" | "limit">,
  side: "from_in" | "to_in",
  endpoints: readonly string[],
): Promise<EdgeRow[]> {
  const rows: EdgeRow[] = [];
  for (const batch of batches(endpoints)) rows.push(...(await allEdges(runner, ns, { ...filter, [side]: batch })));
  return rows;
}

/**
 * Read every edge row matching a filter, page by page.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param filter (Omit<MatchEdgesOptions, "skip" | "limit">): the edge filter.
 * @param page (number): the rows to read per call.
 * @return (EdgeRow[]): the edge rows, in store order.
 */
function allEdges(
  runner: Runner,
  ns: string,
  filter: Omit<MatchEdgesOptions, "skip" | "limit">,
  page = BATCH,
): Promise<EdgeRow[]> {
  return scan((skip, limit) => runner.matchEdges(ns, { ...filter, skip, limit }), Infinity, page);
}

/**
 * Read the current preferences whose about_entity is one of some entities.
 *
 * One entity is matched by property; several read every current preference once and filter here.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param eids (ReadonlySet<string>): the entity ids.
 * @return (EdgeRow[]): the current preference edge rows.
 */
async function preferencesAbout(runner: Runner, ns: string, eids: ReadonlySet<string>): Promise<EdgeRow[]> {
  const equals = eids.size === 1 ? { about_entity: [...eids][0]! } : null;
  const rows = await allEdges(runner, ns, { from_label: L_PROFILE, current_only: true, equals });
  return equals ? rows : rows.filter((e) => eids.has(e.props.about_entity as string));
}

/**
 * Detach-delete every node of one label whose property is one of some values, a batch per query.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param label (string): the node label.
 * @param key (string): the property.
 * @param values (readonly string[]): the accepted values.
 */
async function deleteNodesWhere(
  runner: Runner,
  ns: string,
  label: string,
  key: string,
  values: readonly string[],
): Promise<void> {
  const doomed = (await nodesWhere(runner, ns, label, key, values)).map(idOf);
  for (const batch of batches(doomed)) await runner.deleteNodes(ns, label, batch);
}

/**
 * Count the preference versions a caller wrote, leaving out those only written to drop a deleted about_entity.
 *
 * @param edges (readonly EdgeRow[]): preference edge rows.
 * @return (number): how many rows were not written by an entity delete.
 */
function authoredVersions(edges: readonly EdgeRow[]): number {
  return edges.filter((edge) => edge.props[ABOUT_DROPPED] !== true).length;
}

/**
 * Delete many entities and everything attached to them, reading and deleting in batches.
 *
 * The result matches deleting them one by one: their relations with every version and the relations' evidence,
 * decisions that reference an entity or use one of those relations as a step, their profiles and the preferences
 * pointing at them, their evidence, and the merge records they survived or were absorbed in. A considered
 * alternative is dropped from a decision that is kept, and a kept preference about a deleted entity loses its
 * about_entity in a new version. Ids that are not stored are skipped.
 *
 * deleted_preference_versions counts the versions of each preference removed with its subject or value entity, once
 * per preference however many of its entities are deleted. A version written only to drop a deleted about_entity
 * is never counted, so the total is the same in any delete order, in one batch, and in a prune.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param given (readonly string[]): the canonical entity ids.
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @return (DeleteResult): counts of what was removed and restored.
 */
export async function deleteEntities(
  runner: Runner,
  ns: string,
  given: readonly string[],
  caps?: ReadonlyMap<string, RelationCap> | null,
): Promise<DeleteResult> {
  const counts = { ...NO_DELETES };
  const eids = [...(await nodesById(runner, ns, L_ENTITY, dedupList(given))).keys()];
  if (!eids.length) return counts;
  const doomed = new Set(eids);
  const seen = new Map<string, string>();
  const newest = new Map<string, EdgeRow>();
  for (const side of ["from_in", "to_in"] as const) {
    for (const edge of await edgesAt(runner, ns, { from_label: L_ENTITY, to_label: L_ENTITY }, side, eids)) {
      if (!isRelationType(edge.type)) continue;
      seen.set(JSON.stringify([idOf(edge.props), revisionOf(edge)]), idOf(edge.props));
      keepNewest(newest, edge);
    }
  }
  const rids = dedupList([...seen.values()]);
  counts.deleted_relation_versions = seen.size;
  const traces = await tracesTouchingEntities(runner, ns, eids);
  for (const [tid, steps] of await tracesTouchingRelations(runner, ns, rids)) {
    traces.set(tid, new Set([...(traces.get(tid) ?? []), ...steps]));
  }
  counts.deleted_decisions = await deleteTraces(runner, ns, traces);
  const alternatives = [...(await tracesWithAlternatives(runner, ns, eids))].sort(([a], [b]) => comparePy(a, b));
  for (const [tid, alts] of alternatives) {
    if (!traces.has(tid)) await pruneTraceAlternatives(runner, ns, tid, alts);
  }

  const profiles = [...(await nodesById(runner, ns, L_PROFILE, eids.map(ids.profileId))).keys()];
  const goneProfiles = new Set(profiles);
  counts.deleted_preference_versions = authoredVersions(
    await edgesAt(runner, ns, { from_label: L_PROFILE }, "from_in", profiles),
  );
  for (const pref of await preferencesAbout(runner, ns, doomed)) {
    if (!doomed.has(pref.to_id) && !goneProfiles.has(pref.from_id)) {
      await updatePreference(
        runner,
        ns,
        idOf(pref.props),
        { properties: null, remove_properties: [], clear: ["about_entity"] },
        true,
      );
    }
  }
  const valued = await edgesAt(runner, ns, { from_label: L_PROFILE, to_label: L_ENTITY }, "to_in", eids);
  counts.deleted_preference_versions += authoredVersions(
    valued.filter((edge) => PREFERENCE_EDGE_TYPES.includes(edge.type) && !goneProfiles.has(edge.from_id)),
  );
  for (const batch of batches(profiles)) await runner.deleteNodes(ns, L_PROFILE, batch);
  await deleteNodesWhere(runner, ns, L_EVIDENCE, "target_id", [...rids, ...eids]);
  for (const batch of batches(eids)) await runner.deleteNodes(ns, L_ENTITY, batch);
  for (const side of ["survivor_id", "absorbed_id"]) {
    const merges = (await nodesWhere(runner, ns, L_MERGE, side, eids)).map(idOf);
    await deleteNodesWhere(runner, ns, L_MERGE_ENTRY, "merge_id", merges);
    for (const batch of batches(merges)) await runner.deleteNodes(ns, L_MERGE, batch);
  }
  counts.deleted_entities = eids.length;
  counts.restored_relations = await resettleEndpoints(runner, ns, newest.values(), caps, new Date());
  return counts;
}

/**
 * Add one delete's counts into a running total.
 *
 * @param total (DeleteResult): the running counts, updated in place.
 * @param counts (DeleteResult): one delete's counts.
 */
export function addCounts(total: DeleteResult, counts: DeleteResult): void {
  for (const key of Object.keys(total) as Array<keyof DeleteResult>) total[key] += counts[key];
}

/**
 * Delete many relations with every version, skipping ids that are not stored.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rids (readonly string[]): the relation ids.
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @return (DeleteResult): counts of what was removed and restored.
 */
export async function deleteRelations(
  runner: Runner,
  ns: string,
  rids: readonly string[],
  caps?: ReadonlyMap<string, RelationCap> | null,
): Promise<DeleteResult> {
  const counts = { ...NO_DELETES };
  for (const rid of rids) {
    if (!(await relationExists(runner, ns, rid))) continue;
    addCounts(counts, await deleteRelation(runner, ns, rid, caps));
  }
  return counts;
}

const isRelationType = (rtype: string): boolean => !EDGE_TYPES.has(rtype);

type RelationEnds = Pick<Relation, "from_entity" | "type" | "to_entity">;

export const relationOf = (e: EdgeRow): Relation =>
  decodeRelation(e.props, { from_entity: e.from_id, to_entity: e.to_id, type: e.type });
const isPreferenceType = (rtype: string): boolean => preferenceStanceOf(rtype) !== null;

async function typedEdgeVersions(
  runner: Runner,
  ns: string,
  eid: string,
  keep: (t: string) => boolean,
): Promise<EdgeRow[]> {
  return (await runner.listEdgeVersions(ns, eid)).filter((e) => keep(e.type));
}

export async function getRelationCurrent(runner: Runner, ns: string, rid: string): Promise<Relation | null> {
  requireStr("relation id", rid);
  const edge = await runner.getCurrentEdge(ns, rid);
  return edge === null || !isRelationType(edge.type) ? null : relationOf(edge);
}

export async function relationExists(runner: Runner, ns: string, rid: string): Promise<boolean> {
  return (await typedEdgeVersions(runner, ns, rid, isRelationType)).length > 0;
}

export async function listRelationVersions(
  runner: Runner,
  ns: string,
  rid: string,
  newestFirst: boolean,
): Promise<Relation[]> {
  requireStr("relation id", rid);
  const rels = (await typedEdgeVersions(runner, ns, rid, isRelationType)).map(relationOf);
  if (newestFirst) rels.reverse();
  return rels;
}

interface ClaimState {
  active: number;
  seen: number;
}

interface Claim {
  readonly states: Map<string, ClaimState>;
  readonly key: string;
  readonly state: ClaimState;
  readonly contended: () => boolean;
}

const CLAIMS = new WeakMap<Runner, Map<string, ClaimState>>();
const HELD = new AsyncLocalStorage<Map<ClaimState, Claim>>();

/**
 * Hold the relations and preferences a write attempt claims until it ends, sharing an enclosing attempt's scope.
 *
 * @param write (() => Promise<T>): the write attempt.
 * @return (Promise<T>): the write's result; the claims taken inside are released when it settles.
 */
export async function withClaims<T>(write: () => Promise<T>): Promise<T> {
  if (HELD.getStore() !== undefined) return write();
  const held = new Map<ClaimState, Claim>();
  try {
    return await HELD.run(held, write);
  } finally {
    for (const { states, key, state } of held.values()) {
      state.active -= 1;
      if (!state.active) states.delete(key);
    }
  }
}

/**
 * Claim a relation or preference for the running write attempt, before it is read.
 *
 * On an auto-commit store the retire and the create are two statements, and writers that share an outer
 * transaction share its lock, so of the writes that find a record with no current version only the one that held
 * it first completes it, and only when no write found it current meanwhile.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param id (string): the relation or preference id.
 * @return (Claim): the record's holding attempts and times one found it current, and whether another may write it.
 */
function takeClaim(runner: Runner, ns: string, id: string): Claim {
  const held = HELD.getStore()!;
  const states = CLAIMS.get(runner) ?? new Map<string, ClaimState>();
  CLAIMS.set(runner, states);
  const key = JSON.stringify([ns, id]);
  const existing = states.get(key);
  const own = existing === undefined ? undefined : held.get(existing);
  if (own !== undefined) return own;
  const state = existing ?? { active: 0, seen: 0 };
  states.set(key, state);
  state.active += 1;
  const [first, seen] = [state.active === 1, state.seen];
  const claim = { states, key, state, contended: () => !first || state.seen !== seen };
  held.set(state, claim);
  return claim;
}

/**
 * Record that a write attempt found a record current, so it may retire that version before writing the next.
 *
 * @param claim (Claim): the attempt's claim on the record, from takeClaim.
 * @return (void): nothing.
 */
function foundCurrent(claim: Claim): void {
  claim.state.seen += 1;
}

/**
 * Throw TransientError when another write may be writing a relation or preference found with no current version.
 *
 * @param claim (Claim): the record's claim, from takeClaim.
 * @param id (string): the relation or preference id.
 * @param kind ("relation" | "preference"): the object kind, for the error.
 * @return (void): nothing; throws TransientError for a record another write may still be writing.
 */
function requireUnshared(claim: Claim, id: string, kind: "relation" | "preference"): void {
  if (claim.contended()) {
    throw new TransientError(`${kind} ${pyRepr(id)} has no current version right now (concurrent write); retry`);
  }
}

/**
 * Write a relation version as the current one, retiring the previous current version when there is one.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param ends (RelationEnds): the endpoints and type.
 * @param props (Props): the encoded version.
 * @param retire (Props | null): the changes that flip the existing current version first, or null when there is none.
 * @return (Relation): the written version.
 */
async function writeRelationVersion(
  runner: Runner,
  ns: string,
  ends: RelationEnds,
  props: Props,
  retire: Props | null,
): Promise<Relation> {
  if (retire !== null) {
    precheckEdges(runner, ns, L_ENTITY, L_ENTITY, [[ends.type, ends.from_entity, ends.to_entity, props]]);
    await runner.updateCurrentEdge(ns, idOf(props), { ...retire, is_current: false });
  }
  rejectReservedRelType(ends.type, ends.type);
  if (!(await runner.createEdge(ns, ends.type, L_ENTITY, ends.from_entity, L_ENTITY, ends.to_entity, props))) {
    const hint = "create the entities first, then reference them by id ('type:name')";
    await requireEndpoints(runner, ns, ends.from_entity, ends.to_entity, hint);
    throw new ValidationError(
      `relation endpoints not found (from=${pyRepr(ends.from_entity)}, to=${pyRepr(ends.to_entity)}); ${hint}`,
      { code: "unknown_reference" },
    );
  }
  return decodeRelation(props, ends);
}

const revisionOf = (e: EdgeRow): number => Math.trunc(Number(e.props.revision));

/**
 * Every stored version of a relation as an edge row, oldest first.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rid (string): the relation id.
 * @return (Promise<EdgeRow[]>): the versions, empty when the id names a different edge type.
 */
export async function relationEdges(runner: Runner, ns: string, rid: string): Promise<EdgeRow[]> {
  return (await typedEdgeVersions(runner, ns, rid, isRelationType)).sort((a, b) => revisionOf(a) - revisionOf(b));
}

/**
 * Keep an edge version by id when it has a higher revision than the one kept so far.
 *
 * @param found (Map<string, EdgeRow>): the newest edge row by id, updated in place.
 * @param edge (EdgeRow): the edge version.
 */
function keepNewest(found: Map<string, EdgeRow>, edge: EdgeRow): void {
  const kept = found.get(idOf(edge.props));
  if (kept === undefined || revisionOf(edge) > revisionOf(kept)) found.set(idOf(edge.props), edge);
}

/**
 * Pick the highest revision among edge versions.
 *
 * @param edges (readonly EdgeRow[]): the versions.
 * @return (EdgeRow | null): the newest version, or null when there is none.
 */
function newestEdge(edges: readonly EdgeRow[]): EdgeRow | null {
  let best: EdgeRow | null = null;
  for (const e of edges) if (best === null || revisionOf(e) > revisionOf(best)) best = e;
  return best;
}

/**
 * Reject a write that would change the endpoints or type of an existing relation.
 *
 * @param rid (string): the relation id.
 * @param stored (readonly [string, string, string]): the stored (from, type, to).
 * @param given (readonly [string, string, string]): the written (from, type, to).
 */
function requireSameEnds(
  rid: string,
  stored: readonly [string, string, string],
  given: readonly [string, string, string],
): void {
  if (stored.some((part, i) => part !== given[i])) {
    throw new ValidationError(
      `relation ${pyRepr(rid)} already exists with different endpoints/type; ` +
        "endpoints and type are immutable; create a new relation to change them",
      { code: "immutable_identity" },
    );
  }
}

/**
 * Describe which relation retired a relation and when, for errors about a relation that is not current.
 *
 * @param rel (Relation): the retired version.
 * @return (string): the description.
 */
export const invalidatedNote = (rel: Relation): string =>
  `relation ${rel.id} was invalidated by ${rel.invalidated_by} at ${jsonIso(rel.invalidated_at as Date)}`;

/**
 * Return the highest revision of a relation, current or not.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rid (string): the relation id.
 * @return (Relation | null): the newest version, or null when the relation does not exist.
 */
async function newestRelation(runner: Runner, ns: string, rid: string): Promise<Relation | null> {
  const edge = newestEdge(await typedEdgeVersions(runner, ns, rid, isRelationType));
  return edge === null ? null : relationOf(edge);
}

/**
 * Return the highest revision of a preference, current or not.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param pid (string): the preference id.
 * @return (Preference | null): the newest version, or null when the preference does not exist.
 */
async function newestPreference(runner: Runner, ns: string, pid: string): Promise<Preference | null> {
  const edge = newestEdge(await typedEdgeVersions(runner, ns, pid, isPreferenceType));
  return edge === null ? null : preferenceOf(edge);
}

/**
 * Fetch the current version of many relations, or the newest version of one that has no current version.
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param keyed (ReadonlyArray<readonly [string, Pick<ParsedRelationInput, "id" | "from_entity">]>): (relation id, input) pairs.
 * @param allIds (boolean): look up every id across all endpoints, since an explicit id can match a generated id.
 * @return (Map<string, EdgeRow>): each found relation's current edge row, else its newest edge row, by id.
 */
export async function currentRelations(
  runner: Runner,
  ns: string,
  keyed: ReadonlyArray<readonly [string, Pick<ParsedRelationInput, "id" | "from_entity">]>,
  allIds = false,
): Promise<Map<string, EdgeRow>> {
  const wanted = new Set(keyed.map(([rid]) => rid));
  const found = new Map<string, EdgeRow>();
  const ids = [...wanted];
  let versions: EdgeRow[] | null = null;
  if (runner.edgeVersions) {
    versions = [];
    for (const batch of batches(ids, RELATION_ID_BATCH)) {
      const rows = await runner.edgeVersions(ns, L_ENTITY, L_ENTITY, batch);
      if (rows === null) {
        versions = null;
        break;
      }
      for (const edge of rows) versions.push(edge);
    }
  }
  for (const currentOnly of [true, false]) {
    const pending = dedupList(keyed.filter(([rid]) => !found.has(rid)).map(([, rel]) => rel.from_entity));
    const filter = { from_label: L_ENTITY, to_label: L_ENTITY, current_only: currentOnly };
    const edges =
      versions === null
        ? await edgesAt(runner, ns, filter, "from_in", pending)
        : versions.filter((e) => Boolean(e.props.is_current) || !currentOnly);
    for (const edge of edges) {
      if (wanted.has(idOf(edge.props)) && isRelationType(edge.type)) keepNewest(found, edge);
    }
    for (const rid of found.keys()) wanted.delete(rid);
  }
  if (versions !== null) return found;
  const missing = dedupList(keyed.filter(([rid, rel]) => (allIds || rel.id) && !found.has(rid)).map(([rid]) => rid));
  for (const rid of missing) {
    const edge = newestEdge(await typedEdgeVersions(runner, ns, rid, isRelationType));
    if (edge !== null) found.set(rid, edge);
  }
  return found;
}

/**
 * Reject conflicting relation ids before the insert writes any facts or provenance.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): namespace.
 * @param relations (readonly ParsedRelationInput[]): the final canonical relations to write.
 * @return (Promise<void>): nothing; raises ValidationError if a relation id names different endpoints or types.
 */
export async function requireRelationIdentities(
  runner: Runner,
  ns: string,
  relations: readonly ParsedRelationInput[],
): Promise<void> {
  if (!relations.length) return;
  const keyed = relations.map((rel) => {
    const rtype = ids.normalizeRelType(rel.type);
    const rid = rel.id ?? ids.relationId(rel.from_entity, rtype, rel.to_entity);
    return [rid, rel, [rel.from_entity, rtype, rel.to_entity]] as const;
  });
  const stored = await currentRelations(
    runner,
    ns,
    keyed.map(([rid, rel]) => [rid, rel]),
    true,
  );
  const identities = new Map<string, readonly [string, string, string]>(
    [...stored].map(([rid, edge]) => [rid, [edge.from_id, edge.type, edge.to_id]]),
  );
  for (const [rid, , identity] of keyed) {
    const previous = identities.get(rid);
    if (previous === undefined) identities.set(rid, identity);
    else requireSameEnds(rid, previous, identity);
  }
}

export interface RelationCap {
  canonical: string;
  types: readonly string[];
  limits: ReadonlyArray<readonly [string, number]>;
}

/**
 * The time a relation, preference, or decision took effect: its event time, else its creation time.
 *
 * @param version (Relation | Preference | DecisionTrace): the version.
 * @return (Date): the effective time.
 */
export const effectiveTime = (version: Relation | Preference | DecisionTrace): Date =>
  version.event_time ?? version.created_at;

/**
 * Tell whether a write at an effective time brings a retired relation back as current.
 *
 * @param prev (Relation): the stored version.
 * @param effective (Date): the write's effective time.
 * @return (boolean): true when prev is retired and the write is not earlier than its invalidation.
 */
const reasserts = (prev: Relation, effective: Date): boolean =>
  !prev.is_current && (prev.invalidated_at === null || epochMicros(effective) >= epochMicros(prev.invalidated_at));

type Slot = readonly [string, string, string];
type Rank = readonly [number];

/**
 * Order a relation among others at one endpoint: by effective time, with ties left to the relation id.
 *
 * @param rel (Relation): the relation version.
 * @return (Rank): the sort key, newer last.
 */
const rankOf = (rel: Relation): Rank => [epochMicros(effectiveTime(rel))];

/**
 * When a relation's latest unbroken stretch of validity began; a reassertion after a retirement starts a new one.
 *
 * @param versions (readonly Relation[]): versions of one relation.
 * @return (Date): the start of the newest version's stretch.
 */
function runStart(versions: readonly Relation[]): Date {
  const ordered = [...versions].sort((a, b) => b.revision - a.revision);
  let start = effectiveTime(ordered[0]!);
  for (let i = 1; i < ordered.length; i++) {
    const older = ordered[i]!;
    const newer = ordered[i - 1]!;
    if (older.invalidated_at !== null && epochMicros(effectiveTime(newer)) >= epochMicros(older.invalidated_at)) break;
    if (epochMicros(effectiveTime(older)) < epochMicros(start)) start = effectiveTime(older);
  }
  return start;
}

/**
 * Compare two (rank, id) pairs, older first.
 *
 * @param a (readonly [Rank, string]): the first pair.
 * @param b (readonly [Rank, string]): the second pair.
 * @return (number): negative, zero, or positive.
 */
function compareRanked(a: readonly [Rank, string], b: readonly [Rank, string]): number {
  return a[0][0] - b[0][0] || comparePy(a[1], b[1]);
}

/**
 * List the constrained endpoint groups a relation belongs to, with each group's max_count.
 *
 * @param caps (ReadonlyMap<string, RelationCap>): the max_count limits by normalized relation type and alias.
 * @param rtype (string): the normalized relation type.
 * @param fromEntity (string): the source entity id.
 * @param toEntity (string): the destination entity id.
 * @return (Array<[Slot, number]>): ((canonical type, side, endpoint), max_count) pairs.
 */
export function capSlots(
  caps: ReadonlyMap<string, RelationCap>,
  rtype: string,
  fromEntity: string,
  toEntity: string,
): Array<[Slot, number]> {
  const cap = caps.get(rtype);
  if (cap === undefined) return [];
  return cap.limits.map(([side, limit]) => [[cap.canonical, side, side === "from" ? fromEntity : toEntity], limit]);
}

/**
 * The entity ids to lock before a relation write: every source, and every endpoint a max_count constrains.
 *
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @param ends (ReadonlyArray<readonly [string, string, string]>): each relation's (normalized type, source id, destination id).
 * @return (string[]): the entity ids to lock, in id order.
 */
function relationLockIds(
  caps: ReadonlyMap<string, RelationCap> | null | undefined,
  ends: ReadonlyArray<readonly [string, string, string]>,
): string[] {
  const targets = new Set<string>();
  for (const [rtype, fromEntity, toEntity] of ends) {
    targets.add(fromEntity);
    if (caps) for (const [[, , endpoint]] of capSlots(caps, rtype, fromEntity, toEntity)) targets.add(endpoint);
  }
  return [...targets].sort();
}

export class Contradictions {
  private readonly groups = new Map<string, Map<string, Rank>>();
  private readonly past = new Map<string, Map<string, Rank>>();
  private readonly ended = new Map<string, [string, Date]>();
  private readonly where = new Map<string, Set<string>>();
  private readonly times = new Map<string, Date>();
  private readonly order = new Map<string, number>();
  private readonly dirty = new Map<string, number>();
  private readonly certified = new Set<string>();
  private readonly versions = new Map<string, Relation[]>();
  private readonly starts = new Map<string, Date>();

  /**
   * Track the current relations at every endpoint a schema max_count constrains.
   *
   * @param caps (ReadonlyMap<string, RelationCap>): the max_count limits by normalized relation type and alias.
   * @param mode (string): "warn" keeps both relations of a conflict, "supersede" retires the older ones, "strict" throws ValidationError.
   * @param current (Iterable<Relation>): the stored current relations at the constrained endpoints.
   * @param history (Iterable<Relation>): the newest version of each relation a contradiction retired there.
   * @param versions (ReadonlyMap<string, readonly Relation[]>): every stored version of those relations by id.
   */
  constructor(
    private readonly caps: ReadonlyMap<string, RelationCap>,
    private readonly mode: string,
    current: Iterable<Relation>,
    history: Iterable<Relation> = [],
    versions: ReadonlyMap<string, readonly Relation[]> = new Map(),
  ) {
    for (const [rid, found] of versions) this.versions.set(rid, [...found]);
    for (const rel of history) {
      this.times.set(rel.id, effectiveTime(rel));
      if (rel.invalidated_by !== null && rel.invalidated_at !== null) {
        this.ended.set(rel.id, [rel.invalidated_by, rel.invalidated_at]);
      }
      for (const [slot] of capSlots(this.caps, rel.type, rel.from_entity, rel.to_entity)) {
        const key = JSON.stringify(slot);
        this.past.set(key, (this.past.get(key) ?? new Map<string, Rank>()).set(rel.id, this.rank(rel)));
      }
    }
    for (const rel of current) {
      if (rel.certified_at !== null) this.certified.add(rel.id);
      for (const [slot] of capSlots(this.caps, rel.type, rel.from_entity, rel.to_entity)) {
        this.seat(slot, rel.id, this.rank(rel), effectiveTime(rel));
      }
    }
  }

  /**
   * Order a relation by effective time, leaving ties to its id, and record when it began.
   *
   * @param version (Relation): the relation version.
   * @return (Rank): the sort key, newer last.
   */
  rank(version: Relation): Rank {
    const found = [...(this.versions.get(version.id) ?? []).filter((v) => v.revision < version.revision), version];
    this.versions.set(version.id, found);
    this.starts.set(version.id, runStart(found));
    return rankOf(version);
  }

  /**
   * Validity intervals of a relation by its recorded revisions and retirements.
   *
   * @param rid (string): the relation id.
   * @param retired (ReadonlyMap<string, [string, Date]> | undefined): pending retirements from the current settle run.
   * @return (Array<[Date, Date | null]>): list of [start, end] intervals where the relation was valid.
   */
  private factWindows(rid: string, retired?: ReadonlyMap<string, [string, Date]>): Array<[Date, Date | null]> {
    const versions = this.versions.get(rid);
    if (!versions || versions.length === 0) {
      const start = this.starts.get(rid);
      if (start === undefined) return [];
      const item = retired?.get(rid) ?? this.ended.get(rid);
      return [[start, item !== undefined ? item[1] : null]];
    }
    const item = retired?.get(rid) ?? this.ended.get(rid);
    let checkVersions = versions;
    if (item !== undefined) {
      const last = versions.at(-1)!;
      if (last.invalidated_at !== item[1] || last.invalidated_by !== item[0]) {
        checkVersions = [...versions.slice(0, -1), { ...last, invalidated_at: item[1], invalidated_by: item[0] }];
      }
    }
    const pointsMap = new Map<number, Date>();
    for (const v of checkVersions) {
      const eff = effectiveTime(v);
      pointsMap.set(epochMicros(eff), eff);
      if (v.invalidated_at != null) {
        pointsMap.set(epochMicros(v.invalidated_at), v.invalidated_at);
      }
    }
    const sortedPoints = [...pointsMap.entries()].sort(([a], [b]) => a - b).map(([, d]) => d);
    const windows: Array<[Date, Date | null]> = [];
    for (let i = 0; i < sortedPoints.length; i++) {
      const t = sortedPoints[i]!;
      if (versionAsOf(checkVersions, { valid: t, known: null }) !== null) {
        const end = i + 1 < sortedPoints.length ? sortedPoints[i + 1]! : null;
        if (windows.length > 0 && windows.at(-1)![1] !== null && epochMicros(windows.at(-1)![1]!) === epochMicros(t)) {
          windows.at(-1)![1] = end;
        } else {
          windows.push([t, end]);
        }
      }
    }
    return windows;
  }

  /**
   * When newer relations displaced an older one: the retiring relation and the earliest displacement time.
   *
   * @param newer (Array<[Rank, string]>): the newer relations' ranks and ids, oldest first.
   * @param limit (number): the endpoint's max_count.
   * @param old (string): the displaced relation's id.
   * @param windows (ReadonlyMap<string, Array<[Date, Date | null]>>): validity windows for relations at the endpoint.
   * @return ([string, Date]): the displacing relation id and the displacement time.
   */
  private displacedAt(
    newer: Array<[Rank, string]>,
    limit: number,
    old: string,
    windows: ReadonlyMap<string, Array<[Date, Date | null]>>,
  ): [string, Date] {
    const by = newer[limit - 1]![1];
    const effective = this.times.get(by)!;
    const since = this.starts.get(old);
    if (since === undefined || epochMicros(since) >= epochMicros(effective)) return [by, effective];

    const sinceUs = epochMicros(since);
    const effectiveUs = epochMicros(effective);

    const activeIds = new Set<string>();
    for (const [, rid] of newer) {
      const rWindows = windows.get(rid) ?? [];
      for (const [s, e] of rWindows) {
        if (epochMicros(s) <= sinceUs && (e === null || sinceUs < epochMicros(e))) {
          activeIds.add(rid);
          break;
        }
      }
    }

    if (activeIds.size >= limit) {
      const valid = newer.map(([, rid]) => rid).filter((rid) => activeIds.has(rid));
      return [valid[limit - 1]!, since];
    }

    const events = new Map<number, { time: Date; changes: Array<[number, string]> }>();
    for (const [, rid] of newer) {
      const rWindows = windows.get(rid) ?? [];
      for (const [s, e] of rWindows) {
        const sUs = epochMicros(s);
        if (sinceUs < sUs && sUs < effectiveUs) {
          let entry = events.get(sUs);
          if (!entry) {
            entry = { time: s, changes: [] };
            events.set(sUs, entry);
          }
          entry.changes.push([1, rid]);
        }
        if (e !== null) {
          const eUs = epochMicros(e);
          if (sinceUs < eUs && eUs < effectiveUs) {
            let entry = events.get(eUs);
            if (!entry) {
              entry = { time: e, changes: [] };
              events.set(eUs, entry);
            }
            entry.changes.push([-1, rid]);
          }
        }
      }
    }

    const sortedEvents = [...events.entries()].sort(([a], [b]) => a - b);
    for (const [, { time, changes }] of sortedEvents) {
      changes.sort(([kindA], [kindB]) => kindA - kindB);
      for (const [kind, rid] of changes) {
        if (kind === 1) {
          activeIds.add(rid);
        } else {
          activeIds.delete(rid);
        }
      }
      if (activeIds.size >= limit) {
        const valid = newer.map(([, rid]) => rid).filter((rid) => activeIds.has(rid));
        return [valid[limit - 1]!, time];
      }
    }

    return [by, effective];
  }

  /**
   * The earliest displacement of a retired relation across the endpoints its retiring relation shares with it.
   *
   * @param rid (string): the retired relation id.
   * @param by (string): the relation that retired it.
   * @param found ([string, Date]): the displacing relation id and time at the endpoint being settled.
   * @param key (string): the endpoint being settled, as JSON.
   * @param retired (ReadonlyMap<string, [string, Date]>): pending retirements from the current settle run.
   * @return ([string, Date]): the displacing relation id and the earliest displacement time.
   */
  private sharedDisplacement(
    rid: string,
    by: string,
    found: [string, Date],
    key: string,
    retired: ReadonlyMap<string, [string, Date]>,
  ): [string, Date] {
    const version = this.versions.get(rid)!.at(-1)!;
    for (const [slot, limit] of capSlots(this.caps, version.type, version.from_entity, version.to_entity)) {
      const other = JSON.stringify(slot);
      const facts = new Map([...(this.past.get(other) ?? []), ...(this.groups.get(other) ?? [])]);
      if (other === key || !facts.has(by)) continue;
      const newer = this.newer(facts, rid);
      if (newer.length < limit) continue;
      const windows = new Map([...facts.keys()].map((fact) => [fact, this.factWindows(fact, retired)]));
      const displaced = this.displacedAt(newer, limit, rid, windows);
      if (epochMicros(displaced[1]) < epochMicros(found[1])) found = displaced;
    }
    return found;
  }

  private seat(slot: Slot, rid: string, rank: Rank, effective: Date): void {
    const key = JSON.stringify(slot);
    const group = this.groups.get(key) ?? new Map<string, Rank>();
    this.groups.set(key, group.set(rid, rank));
    this.past.get(key)?.delete(rid);
    this.times.set(rid, effective);
    const keys = this.where.get(rid) ?? new Set<string>();
    this.where.set(rid, keys.add(key));
  }

  private newer(facts: ReadonlyMap<string, Rank>, rid: string): Array<[Rank, string]> {
    const mine: [Rank, string] = [facts.get(rid)!, rid];
    return [...facts]
      .map(([o, r]) => [r, o] as [Rank, string])
      .filter((pair) => compareRanked(pair, mine) > 0)
      .sort(compareRanked);
  }

  private drop(rid: string): void {
    for (const key of this.where.get(rid) ?? []) {
      const group = this.groups.get(key)!;
      this.past.set(key, (this.past.get(key) ?? new Map<string, Rank>()).set(rid, group.get(rid)!));
      group.delete(rid);
    }
    this.where.delete(rid);
  }

  /**
   * Record a relation becoming current at every constrained endpoint.
   *
   * @param rid (string): the relation id.
   * @param rtype (string): the normalized relation type.
   * @param fromEntity (string): the source entity id.
   * @param toEntity (string): the destination entity id.
   * @param rank (Rank): the relation's rank, from rank.
   * @param effective (Date): the relation's effective time.
   * @param certified (boolean): whether the version becoming current is certified, which spares it in settle.
   * @param recheck (boolean): check limits even when the relation is already current.
   * @return (InsertWarning[]): the warn-mode contradiction warnings.
   */
  admit(
    rid: string,
    rtype: string,
    fromEntity: string,
    toEntity: string,
    rank: Rank,
    effective: Date,
    certified = false,
    recheck = false,
  ): InsertWarning[] {
    if (certified) this.certified.add(rid);
    else this.certified.delete(rid);
    const warnings: InsertWarning[] = [];
    const slots = capSlots(this.caps, rtype, fromEntity, toEntity);
    for (const [slot, limit] of slots) {
      const key = JSON.stringify(slot);
      const group = this.groups.get(key) ?? new Map<string, Rank>();
      if (this.mode === "supersede") {
        this.dirty.set(key, limit);
        continue;
      }
      if ((group.has(rid) && !recheck) || group.size + (group.has(rid) ? 0 : 1) <= limit) continue;
      const [canonical, side, endpoint] = slot;
      const others = [...group.keys()].join(", ");
      if (this.mode === "strict") {
        throw new ValidationError(
          `relation ${rid} would exceed max_count ${limit} for ${canonical} at ${side} entity ${endpoint} ` +
            `(current: ${others}); schema_mode 'strict' rejects it; use contradiction='supersede' to ` +
            "retire the older relation instead",
          { code: "schema_violation" },
        );
      }
      warnings.push(
        insertWarning(
          "contradiction",
          `relation ${rid} contradicts current ${canonical} relation(s) ${others} ` +
            `at ${side} entity ${endpoint} (max_count ${limit})`,
        ),
      );
    }
    if (!this.order.has(rid)) this.order.set(rid, this.order.size + 1);
    for (const [slot] of slots) this.seat(slot, rid, rank, effective);
    return warnings;
  }

  /**
   * Retire the oldest current relations beyond max_count at every endpoint a supersede-mode write touched.
   *
   * The current relations at an endpoint, the ones just written included, rank by effective time, then revision,
   * then creation time, and all but the newest max_count are retired, except a certified relation, which stays
   * current with a "certified_kept" warning. A retired relation is invalidated by the fact that displaced it in time
   * order, the max_count-th newer fact at the endpoint with retired history counted, at the time it displaced it
   * (see displacedAt). Each retired relation gets one warning: "contradiction_out_of_order" when it was
   * written by this write after that fact was current, else "relation_superseded".
   *
   * @return ([Map<string, [string, Date]>, InsertWarning[]]): each retired relation id with the id that invalidated it and when, and the warnings.
   */
  settle(): [Map<string, [string, Date]>, InsertWarning[]] {
    const retired = new Map<string, [string, Date]>();
    const why = new Map<string, [string, number, string]>();
    const slots: Array<InsertWarning | string> = [];
    for (const [key, limit] of this.dirty) {
      const group = this.groups.get(key) ?? new Map<string, Rank>();
      const facts = new Map([...(this.past.get(key) ?? []), ...group]);
      const ranked = [...group.keys()].sort((a, b) => compareRanked([group.get(b)!, b], [group.get(a)!, a]));
      const [canonical, side, endpoint] = JSON.parse(key) as [string, string, string];
      const windows = new Map<string, Array<[Date, Date | null]>>();
      for (const rid of facts.keys()) {
        windows.set(rid, this.factWindows(rid, retired));
      }
      for (const old of ranked) {
        const newer = this.newer(facts, old);
        if (newer.length < limit) continue;
        if (this.certified.has(old)) {
          slots.push(
            insertWarning(
              "certified_kept",
              `relation ${old} is certified, so it stays current beside newer ${canonical} relations at ${side} ` +
                `entity ${endpoint} (max_count ${limit})`,
            ),
          );
          continue;
        }
        const [by, at] = this.displacedAt(newer, limit, old, windows);
        if (!retired.has(old)) slots.push(old);
        if (!retired.has(old) || epochMicros(at) < epochMicros(retired.get(old)![1])) {
          retired.set(old, [by, at]);
          windows.set(old, this.factWindows(old, retired));
          why.set(old, [key, limit, ranked.length >= limit ? ranked[limit - 1]! : by]);
        }
      }
      for (const rid of this.past.get(key)?.keys() ?? []) {
        const newer = this.newer(facts, rid);
        const ended = retired.get(rid) ?? this.ended.get(rid);
        if (ended === undefined || newer.length < limit) continue;
        const [by, at] = this.sharedDisplacement(
          rid,
          ended[0],
          this.displacedAt(newer, limit, rid, windows),
          key,
          retired,
        );
        if (
          (by !== ended[0] || epochMicros(at) !== epochMicros(ended[1])) &&
          (facts.has(ended[0]) || epochMicros(at) < epochMicros(ended[1]))
        ) {
          retired.set(rid, [by, at]);
          this.ended.set(rid, [by, at]);
          windows.set(rid, this.factWindows(rid, retired));
        }
      }
    }
    const warnings: InsertWarning[] = [];
    for (const slot of slots) {
      if (typeof slot !== "string") {
        warnings.push(slot);
        continue;
      }
      const [by] = retired.get(slot)!;
      const [key, limit, keeper] = why.get(slot)!;
      const [canonical, side, endpoint] = JSON.parse(key) as [string, string, string];
      this.drop(slot);
      if ((this.order.get(by) ?? 0) < (this.order.get(slot) ?? 0)) {
        warnings.push(
          insertWarning(
            "contradiction_out_of_order",
            `relation ${slot} is older than current ${canonical} relation ${keeper} at ${side} entity ${endpoint}, ` +
              `so ${keeper} stays current`,
          ),
        );
      } else {
        warnings.push(
          insertWarning(
            "relation_superseded",
            `relation ${slot} was superseded by ${by}, a newer ${canonical} relation at ${side} entity ${endpoint} ` +
              `(max_count ${limit})`,
          ),
        );
      }
    }
    this.dirty.clear();
    return [retired, warnings];
  }
}

/**
 * Read the relations at every endpoint a max_count constrains, one query per endpoint and stored type.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param caps (ReadonlyMap<string, RelationCap>): the max_count limits by normalized relation type and alias.
 * @param ends (Iterable<readonly [string, string, string]>): (normalized type, source id, destination id) of each write.
 * @param every (Map<string, EdgeRow[]>): receives every version read, by relation id.
 * @param twins (boolean): also read, and lock, the other endpoint of a relation retired by one with the same endpoints.
 * @return ([Map<string, EdgeRow>, Map<string, EdgeRow>]): each current relation's edge row by id, in read order, and the newest version of each relation a contradiction retired there by id.
 */
async function constrainedCurrent(
  runner: Runner,
  ns: string,
  caps: ReadonlyMap<string, RelationCap>,
  ends: Iterable<readonly [string, string, string]>,
  every: Map<string, EdgeRow[]>,
  twins: boolean,
): Promise<[Map<string, EdgeRow>, Map<string, EdgeRow>]> {
  const writes = [...ends];
  const seen = new Set<string>();
  const found = await endpointEdges(runner, ns, caps, writes, every, seen);
  if (twins) {
    const shared: Array<[string, string, string]> = [];
    for (const e of found.values()) {
      const twin = typeof e.props.invalidated_by === "string" ? found.get(e.props.invalidated_by) : undefined;
      if (
        !e.props.is_current &&
        twin?.from_id === e.from_id &&
        twin.to_id === e.to_id &&
        capSlots(caps, e.type, e.from_id, e.to_id).length > 1
      ) {
        shared.push([e.type, e.from_id, e.to_id]);
      }
    }
    const locked = new Set(relationLockIds(caps, writes));
    for (const eid of relationLockIds(caps, shared)) {
      if (!locked.has(eid)) await runner.lockNode(ns, L_ENTITY, eid);
    }
    for (const [rid, edge] of await endpointEdges(runner, ns, caps, shared, every, seen)) {
      if (!found.has(rid)) found.set(rid, edge);
    }
  }
  const rows = [...found.values()];
  return [
    new Map(rows.filter((e) => e.props.is_current).map((e) => [idOf(e.props), e])),
    new Map(
      rows
        .filter(
          (e) =>
            !e.props.is_current &&
            e.props.invalidated_at &&
            !(typeof e.props.invalidated_by === "string" && e.props.invalidated_by.startsWith("sv:")),
        )
        .map((e) => [idOf(e.props), e]),
    ),
  ];
}

/**
 * Read the newest version of every relation at the constrained endpoints of some relations.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param caps (ReadonlyMap<string, RelationCap>): the schema's max_count limits by relation type.
 * @param ends (Iterable<readonly [string, string, string]>): (normalized type, source id, destination id) of each relation.
 * @param every (Map<string, EdgeRow[]> | undefined): receives every version read, by relation id, when given.
 * @param seen (Set<string>): the reads already made, as JSON [side, endpoint, stored type], which are skipped and added to.
 * @return (Map<string, EdgeRow>): each relation's newest edge row by id, in read order.
 */
async function endpointEdges(
  runner: Runner,
  ns: string,
  caps: ReadonlyMap<string, RelationCap>,
  ends: Iterable<readonly [string, string, string]>,
  every?: Map<string, EdgeRow[]>,
  seen = new Set<string>(),
): Promise<Map<string, EdgeRow>> {
  const found = new Map<string, EdgeRow>();
  for (const [rtype, fromEntity, toEntity] of ends) {
    const cap = caps.get(rtype);
    for (const [side] of cap?.limits ?? []) {
      const endpoint = side === "from" ? fromEntity : toEntity;
      for (const stored of cap!.types) {
        const key = JSON.stringify([side, endpoint, stored]);
        if (seen.has(key)) continue;
        seen.add(key);
        const anchor = side === "from" ? { from_id: endpoint } : { to_id: endpoint };
        const filter = { from_label: L_ENTITY, to_label: L_ENTITY, type: stored, ...anchor };
        for (const edge of await allEdges(runner, ns, filter)) {
          keepNewest(found, edge);
          if (every !== undefined) {
            const id = idOf(edge.props);
            const versions = every.get(id);
            if (versions === undefined) every.set(id, [edge]);
            else versions.push(edge);
          }
        }
      }
    }
  }
  return found;
}

/**
 * Reject relations that would exceed a schema max_count, against the stored graph or each other, before writing.
 *
 * Strict schema mode runs this unless the contradiction mode is supersede, which resolves the conflict instead.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param caps (ReadonlyMap<string, RelationCap> | null): the max_count limits, or null without a schema.
 * @param relations (readonly ParsedRelationInput[]): the relations about to be written.
 * @param defaultEventTime (Date | null): fallback event time.
 * @param createdAt (Date): timestamp of the planned write.
 */
export async function requireMaxCount(
  runner: Runner,
  ns: string,
  caps: ReadonlyMap<string, RelationCap> | null,
  relations: readonly ParsedRelationInput[],
  defaultEventTime: Date | null,
  createdAt: Date,
): Promise<void> {
  const keyed = relations.map((rel) => {
    const rtype = ids.normalizeRelType(rel.type);
    return { rid: rel.id || ids.relationId(rel.from_entity, rtype, rel.to_entity), rtype, rel };
  });
  const [tracker] = await contradictionCheck(
    runner,
    ns,
    { contradiction: "strict", caps },
    keyed.map(({ rtype, rel }) => [rtype, rel.from_entity, rel.to_entity] as const),
  );
  if (tracker === null) return;
  const stored = await currentRelations(
    runner,
    ns,
    keyed.map(({ rid, rel }) => [rid, rel] as const),
  );
  const admitted = new Set<string>();
  for (const { rid, rtype, rel } of keyed) {
    const effective = rel.event_time ?? defaultEventTime ?? createdAt;
    const edge = stored.get(rid);
    if (edge !== undefined && !admitted.has(rid)) {
      const prev = relationOf(edge);
      if (!prev.is_current && !reasserts(prev, effective)) continue;
    }
    const rank: Rank = [epochMicros(effective)];
    tracker.admit(rid, rtype, rel.from_entity, rel.to_entity, rank, effective);
    admitted.add(rid);
  }
}

/**
 * Mark a relation version as no longer current because a newer relation superseded it.
 *
 * @param edge (EdgeRow): the edge row, current or already retired.
 * @param by (string): the id of the relation that superseded it.
 * @param at (Date): the superseding relation's effective time.
 * @param known (Date): when the retirement is written, for reads with known_at.
 * @param inPlace (boolean): rewrite an already retired version under its own revision instead of adding one.
 * @return (EdgeRow): the edge row with its version retired.
 */
function retiredEdge(edge: EdgeRow, by: string, at: Date, known: Date, inPlace = false): EdgeRow {
  const props: Record<string, unknown> = {
    ...edge.props,
    is_current: false,
    invalidated_at: toIso(at),
    invalidated_by: by,
    invalidated_known_at: toIso(known),
  };
  if (!edge.props.is_current && !inPlace) {
    props.revision = (edge.props.revision as number) + 1;
    props.created_at = toIso(known);
    props.event_time = edge.props.event_time || edge.props.created_at;
  }
  return { ...edge, props };
}

export interface ContradictionOptions {
  dry_run?: boolean;
  contradiction?: string;
  caps?: ReadonlyMap<string, RelationCap> | null;
  warnings?: InsertWarning[];
  /** For each relation input, each evidence record's statements (see planEvidence); omitted for all direct. */
  via?: ReadonlyArray<ReadonlyArray<readonly string[]>>;
}

/**
 * Prepare the contradiction check for a write, reading the current relations it can conflict with.
 *
 * Under supersede it also reads, and locks, the other endpoint of each relation that a relation with the same
 * endpoints retired, since that endpoint can have displaced it earlier.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param options (ContradictionOptions): the mode and the max_count limits.
 * @param ends (Iterable<readonly [string, string, string]>): (normalized type, source id, destination id) of each write.
 * @return ([Contradictions | null, Map<string, EdgeRow>]): the tracker, or null when off, and the rows read.
 */
async function contradictionCheck(
  runner: Runner,
  ns: string,
  options: ContradictionOptions,
  ends: Iterable<readonly [string, string, string]>,
): Promise<[Contradictions | null, Map<string, EdgeRow>]> {
  const { contradiction = "off", caps } = options;
  if (contradiction === "off" || !caps?.size) return [null, new Map()];
  const every = new Map<string, EdgeRow[]>();
  const [existing, history] = await constrainedCurrent(runner, ns, caps, ends, every, contradiction === "supersede");
  const tracker = new Contradictions(
    caps,
    contradiction,
    [...existing.values()].map(relationOf),
    [...history.values()].map(relationOf),
    new Map([...every].map(([rid, edges]) => [rid, edges.map(relationOf)])),
  );
  return [tracker, new Map([...history, ...existing])];
}

/**
 * Find the older current relations each written relation may make untrue, for a judge to rule on.
 *
 * A rival shares the written relation's source entity and either its type with another destination, or its
 * destination with another type. It took effect no later than the written relation and is not part of the same
 * write. A written relation whose type carries a max_count has none, since the cardinality rule already settled it.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param written (readonly Relation[]): the relations a write just stored.
 * @param caps (ReadonlyMap<string, RelationCap> | null): the schema's max_count limits by relation type.
 * @param limit (number): the most rivals to list per relation, lowest id first.
 * @return (Map<string, EdgeRow[]>): each written relation id with a rival, mapped to the rivals' edge rows.
 */
export async function rivalRelations(
  runner: Runner,
  ns: string,
  written: readonly Relation[],
  caps: ReadonlyMap<string, RelationCap> | null,
  limit: number,
): Promise<Map<string, EdgeRow[]>> {
  const fresh = written.filter((r) => r.is_current && !caps?.has(r.type));
  const batch = new Set(written.map((r) => r.id));
  const current = new Map<string, EdgeRow[]>();
  for (const source of dedupList(fresh.map((r) => r.from_entity))) {
    const found = new Map<string, EdgeRow>();
    const filter = { from_label: L_ENTITY, to_label: L_ENTITY, from_id: source };
    for (const edge of await allEdges(runner, ns, filter)) keepNewest(found, edge);
    const rows = [...found].sort((a, b) => comparePy(a[0], b[0])).map(([, e]) => e);
    current.set(
      source,
      rows.filter((e) => e.props.is_current),
    );
  }
  const out = new Map<string, EdgeRow[]>();
  for (const rel of fresh) {
    const rivals = current
      .get(rel.from_entity)!
      .filter(
        (e) =>
          !batch.has(idOf(e.props)) &&
          (e.type === rel.type) !== (e.to_id === rel.to_entity) &&
          epochMicros(effectiveTime(relationOf(e))) <= epochMicros(effectiveTime(rel)),
      );
    if (rivals.length) out.set(rel.id, rivals.slice(0, limit));
  }
  return out;
}

/**
 * Retire current relations, each once, by the first retirement named for it.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param retirements (Iterable<readonly [EdgeRow, string, Date]>): each current edge row with what retired it (a
 * relation or source version id) and when.
 * @param known (Date): the timestamp of the write that retires them.
 * @return (Relation[]): the retired versions.
 */
export async function retireRelations(
  runner: Runner,
  ns: string,
  retirements: Iterable<readonly [EdgeRow, string, Date]>,
  known: Date,
): Promise<Relation[]> {
  const gone = new Map<string, EdgeRow>();
  for (const [edge, by, at] of retirements) {
    if (!gone.has(idOf(edge.props))) gone.set(idOf(edge.props), retiredEdge(edge, by, at, known));
  }
  const rows: EdgeWrite[] = [...gone.values()].map((e) => [e.type, e.from_id, e.to_id, e.props]);
  precheckEdges(runner, ns, L_ENTITY, L_ENTITY, rows);
  if (rows.length) await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
  return [...gone.values()].map(relationOf);
}

/**
 * Settle again each max_count endpoint a deleted or moved relation sat at, as supersede would settle it now.
 *
 * A relation that comes back is a new current revision. With inPlace the retired version becomes current again under its own revision, and one another relation still retires keeps its revision with the new pointer.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param given (Iterable<EdgeRow>): the edge rows of the deleted relations, read before they were deleted, or of the new versions of the moved ones.
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @param at (Date): the write's timestamp, the created_at of each restored revision.
 * @param inPlace (boolean): undo a retirement inside the version list instead of adding a revision, as unmerge does.
 * @return (number): how many relations came back.
 */
export async function resettleEndpoints(
  runner: Runner,
  ns: string,
  given: Iterable<EdgeRow>,
  caps: ReadonlyMap<string, RelationCap> | null | undefined,
  at: Date,
  inPlace = false,
): Promise<number> {
  const limits = caps ?? new Map<string, RelationCap>();
  const slotsOf = (edge: EdgeRow) => capSlots(limits, edge.type, edge.from_id, edge.to_id);
  const endsOf = (edges: readonly EdgeRow[]) => edges.map((e) => [e.type, e.from_id, e.to_id] as const);
  const moved = [...given].filter((edge) => slotsOf(edge).length);
  if (!moved.length) return 0;
  for (const eid of dedupList(moved.flatMap((edge) => [edge.from_id, edge.to_id]))) {
    await runner.lockNode(ns, L_ENTITY, eid);
  }
  const every = new Map<string, EdgeRow[]>();
  const found = await endpointEdges(runner, ns, limits, endsOf(moved), every);
  const members = new Map<string, Set<string>>();
  for (const edge of [...moved, ...found.values()]) {
    for (const [slot] of slotsOf(edge)) {
      const key = JSON.stringify(slot);
      members.set(key, (members.get(key) ?? new Set<string>()).add(idOf(edge.props)));
    }
  }
  const freed = new Set(moved.flatMap((edge) => slotsOf(edge).map(([slot]) => JSON.stringify(slot))));
  const movedIds = new Set(moved.map((edge) => idOf(edge.props)));
  const stale = [...found.values()].filter(
    (edge) =>
      !movedIds.has(idOf(edge.props)) &&
      !edge.props.is_current &&
      edge.props.invalidated_at &&
      slotsOf(edge).some(([slot]) => {
        const key = JSON.stringify(slot);
        return freed.has(key) && members.get(key)!.has(edge.props.invalidated_by as string);
      }),
  );
  const gone = new Set(moved.map((edge) => idOf(edge.props)));
  const older = new Map<string, EdgeWrite>();
  for (const [rid, edges] of inPlace ? every : []) {
    for (const edge of edges) {
      if (edge === found.get(rid) || !gone.has(edge.props.invalidated_by as string)) continue;
      const props = { ...edge.props, invalidated_at: null, invalidated_by: null, invalidated_known_at: null };
      older.set(`${rid}:${revisionOf(edge)}`, [edge.type, edge.from_id, edge.to_id, props]);
    }
  }
  if (!stale.length) {
    if (older.size) await runner.createEdges(ns, L_ENTITY, L_ENTITY, [...older.values()]);
    return 0;
  }
  const [tracker, read] = await contradictionCheck(
    runner,
    ns,
    { contradiction: "supersede", caps: limits },
    endsOf(stale),
  );
  for (const edge of stale) {
    const rel = relationOf(edge);
    tracker!.admit(rel.id, rel.type, rel.from_entity, rel.to_entity, tracker!.rank(rel), effectiveTime(rel));
  }
  const [ended] = tracker!.settle();
  const rows: EdgeWrite[] = [];
  for (const edge of stale) {
    if (ended.has(idOf(edge.props))) continue;
    const rel = relationOf(edge);
    const props = inPlace
      ? { ...edge.props, is_current: true, invalidated_at: null, invalidated_by: null, invalidated_known_at: null }
      : encodeRelationProps({
          ns,
          id: rel.id,
          revision: rel.revision + 1,
          properties: rel.properties,
          event_time: effectiveTime(rel),
          created_at: at,
          is_current: true,
          source_count: rel.source_count,
        });
    rows.push([edge.type, edge.from_id, edge.to_id, props]);
  }
  const restored = rows.length;
  rows.push(...older.values());
  for (const [rid, [by, when]] of ended) {
    const edge = read.get(rid)!;
    if (by === edge.props.invalidated_by && toIso(when) === edge.props.invalidated_at) continue;
    const gone = retiredEdge(edge, by, when, at, inPlace);
    rows.push([gone.type, gone.from_id, gone.to_id, gone.props]);
  }
  precheckEdges(runner, ns, L_ENTITY, L_ENTITY, rows);
  if (rows.length) await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
  return restored;
}

/**
 * Re-point the relations some deleted duplicates had retired to the survivor they were folded into, in place.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param deleted (readonly EdgeRow[]): the edge rows of the deleted duplicates, each with its id, type, and endpoints.
 * @param survivor (string): the relation id the duplicates were folded into.
 */
export async function repointRetired(
  runner: Runner,
  ns: string,
  deleted: readonly EdgeRow[],
  survivor: string,
): Promise<void> {
  const gone = new Set(deleted.map((e) => idOf(e.props)));
  const found = new Map<string, EdgeRow>();
  for (const [side, end] of [
    ["from_in", "from_id"],
    ["to_in", "to_id"],
  ] as const) {
    const anchors = dedupList(deleted.map((e) => e[end]));
    for (const edge of await edgesAt(runner, ns, { from_label: L_ENTITY, to_label: L_ENTITY }, side, anchors)) {
      if (isRelationType(edge.type)) keepNewest(found, edge);
    }
  }
  const rows: EdgeWrite[] = [...found]
    .sort((a, b) => comparePy(a[0], b[0]))
    .map(([, e]) => e)
    .filter((e) => !gone.has(idOf(e.props)) && !e.props.is_current && gone.has(e.props.invalidated_by as string))
    .map((e) => [e.type, e.from_id, e.to_id, { ...e.props, invalidated_by: survivor }]);
  precheckEdges(runner, ns, L_ENTITY, L_ENTITY, rows);
  if (rows.length) await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
}

interface KeyedRelation {
  rid: string;
  rtype: string;
  rel: ParsedRelationInput;
  evidence: Evidence[];
  via: Array<readonly string[]> | null;
}

/**
 * Fold the inputs that share a relation id into one input per id, ending where applying them in turn would.
 *
 * Later properties overwrite earlier ones and keep their null values so a stored key is still removed, the newest
 * named event time wins, and the evidence records and their statements are joined in input order.
 *
 * @param keyed (KeyedRelation[]): each input with its id, normalized type, evidence, and statements per record.
 * @param defaultEventTime (Date | null): the event time an input without one is written at.
 * @return (KeyedRelation[]): one entry per distinct id, in first-appearance order.
 */
function foldRelations(keyed: readonly KeyedRelation[], defaultEventTime: Date | null): KeyedRelation[] {
  const folded = new Map<string, KeyedRelation>();
  for (const { rid, rtype, rel, evidence, via } of keyed) {
    const first = folded.get(rid);
    if (first === undefined) {
      folded.set(rid, { rid, rtype, rel, evidence: [...evidence], via: via === null ? null : [...via] });
      continue;
    }
    const named = rel.event_time ?? defaultEventTime ?? null;
    first.rel = {
      ...first.rel,
      properties: { ...canonProps(first.rel.properties), ...canonProps(rel.properties) },
      event_time: named ?? first.rel.event_time,
    };
    first.evidence.push(...evidence);
    if (first.via !== null && via !== null) first.via.push(...via);
  }
  return [...folded.values()];
}

/**
 * Insert-semantics upsert of many relations: merge properties, versioning on change, recording evidence.
 *
 * Relations are read and written in batches; inputs that share an id are folded into one input first, so a
 * repeated id writes at most one new revision, and replaying the same inputs writes none. A relation invalidated
 * by a contradiction is reasserted, as a new current revision, by an input whose effective time is at or after its
 * invalidation; an earlier input restates history and leaves it retired.
 * A superseded relation is retired in place: its version keeps its revision and gains invalidated_at and
 * invalidated_by, so the version list shows exactly the writes that happened. In supersede mode each constrained
 * endpoint the batch touches is settled once after the whole batch (see Contradictions.settle): an input older than
 * the relations it conflicts with is written already invalidated. New versions are written before any retirement,
 * so a failed write never leaves an endpoint without its current relation. A new revision of a certified relation is
 * not certified, and a certified_dropped warning says so; the superseded version keeps the certification, ended at the
 * write.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param items (ReadonlyArray<readonly [ParsedRelationInput, Evidence[]]>): relations with their evidence, in order.
 * @param defaultEventTime (Date | null): the fallback event time.
 * @param createdAt (Date): the timestamp.
 * @param options (ContradictionOptions): the contradiction mode, the schema's max_count limits, and a list that receives the contradiction warnings.
 * @return (Relation[]): each input's stored version, in input order.
 */
export async function upsertRelations(
  runner: Runner,
  ns: string,
  items: ReadonlyArray<readonly [ParsedRelationInput, Evidence[]]>,
  defaultEventTime: Date | null,
  createdAt: Date,
  options: ContradictionOptions = {},
): Promise<Relation[]> {
  const inputs = items.map(([rel, evidence], position): KeyedRelation => {
    validateOwnId("relation", rel.id);
    const rtype = ids.normalizeRelType(rel.type);
    rejectReservedRelType(rtype, rtype);
    const rid = rel.id || ids.relationId(rel.from_entity, rtype, rel.to_entity);
    return { rid, rtype, rel, evidence, via: options.via === undefined ? null : [...options.via[position]!] };
  });
  const keyed = foldRelations(inputs, defaultEventTime);
  await lockNodes(
    runner,
    ns,
    L_ENTITY,
    relationLockIds(
      options.caps,
      keyed.map((k) => [k.rtype, k.rel.from_entity, k.rel.to_entity] as const),
    ),
  );
  const rids = dedupList(keyed.map((k) => k.rid));
  const claims = new Map(rids.map((rid) => [rid, takeClaim(runner, ns, rid)] as const));
  const stored = await currentRelations(
    runner,
    ns,
    keyed.map((k) => [k.rid, k.rel] as const),
  );
  for (const [rid, edge] of stored) if (edge.props.is_current) foundCurrent(claims.get(rid)!);
  const [records, counts] = await planEvidence(
    runner,
    ns,
    keyed.flatMap((k) => k.evidence.map((ev) => [k.rid, ev] as const)),
    new Set(rids.filter((rid) => !stored.has(rid))),
    options.via === undefined ? null : keyed.flatMap((k) => k.via!),
  );
  const [tracker, existing] = await contradictionCheck(
    runner,
    ns,
    options,
    keyed.map((k) => [k.rtype, k.rel.from_entity, k.rel.to_entity] as const),
  );

  const current = new Map(stored);
  const writes = new Map<string, readonly [string, Props]>();
  const retires = new Map<string, readonly [string, Props]>();
  const out: Array<readonly [string, number, Relation]> = [];
  const moved = new Set<string>();
  for (const { rid, rtype, rel } of keyed) {
    const named = rel.event_time ?? defaultEventTime ?? null;
    let edge = current.get(rid);
    let props: Props;
    let write = true;
    let eventTime: Date | null;
    if (edge === undefined) {
      eventTime = named;
      props = encodeRelationProps({
        ns,
        id: rid,
        revision: 1,
        properties: mergeProps(null, rel.properties),
        event_time: eventTime,
        created_at: createdAt,
        is_current: true,
        source_count: takeCount(counts, rid, 0),
      });
      edge = { props, from_id: rel.from_entity, to_id: rel.to_entity, type: rtype };
    } else {
      requireSameEnds(rid, [edge.from_id, edge.type, edge.to_id], [rel.from_entity, rtype, rel.to_entity]);
      const prev = relationOf(edge);
      if (!prev.is_current && prev.invalidated_at == null) requireUnshared(claims.get(rid)!, rid, "relation");
      eventTime =
        named ?? (prev.invalidated_at == null || options.contradiction === "supersede" ? prev.event_time : null);
      const effective = eventTime ?? createdAt;
      const sources = takeCount(counts, rid, prev.source_count);
      const mergedProperties = mergeProps(prev.properties, rel.properties);
      let reassert = reasserts(prev, effective);
      const unchanged = deepEqual(prev.properties, mergedProperties) && toIso(prev.event_time) === toIso(eventTime);
      if (
        unchanged &&
        prev.invalidated_at != null &&
        options.contradiction === "supersede" &&
        (named === null || toIso(effective) === toIso(prev.invalidated_at))
      )
        reassert = false;
      if (
        eventTime != null &&
        toIso(prev.event_time) !== toIso(eventTime) &&
        (prev.is_current ||
          (!reassert && epochMicros(effective) < epochMicros(effectiveTime(prev))) ||
          toIso(effective) === toIso(prev.invalidated_at))
      )
        moved.add(rid);
      if (unchanged && !reassert) {
        write = sources !== prev.source_count;
        props = { ...edge.props, source_count: sources };
      } else {
        if (prev.is_current) {
          writes.set(JSON.stringify([rid, prev.revision]), [
            rid,
            { ...edge.props, ...certifications(prev, createdAt), is_current: false },
          ]);
        }
        if (prev.is_current && prev.certified_at !== null) {
          const message = `relation ${rid} was certified, but this write changed it, so its new revision is not`;
          options.warnings?.push(insertWarning("certified_dropped", message));
        }
        const live = prev.is_current || reassert;
        props = encodeRelationProps({
          ns,
          id: rid,
          revision: prev.revision + 1,
          properties: mergedProperties,
          event_time: eventTime,
          created_at: createdAt,
          is_current: live,
          source_count: sources,
          invalidated_at: live ? null : prev.invalidated_at,
          invalidated_by: live ? null : prev.invalidated_by,
          invalidated_known_at: live ? null : prev.invalidated_known_at,
        });
      }
      edge = { ...edge, props };
    }
    if (tracker !== null && props.is_current) {
      const version = relationOf(edge);
      options.warnings?.push(
        ...tracker.admit(
          rid,
          rtype,
          rel.from_entity,
          rel.to_entity,
          tracker.rank(version),
          effectiveTime(version),
          version.certified_at !== null,
        ),
      );
    }
    if (write) writes.set(JSON.stringify([rid, props.revision]), [rid, props]);
    current.set(rid, edge);
    out.push([rid, props.revision as number, relationOf(edge)]);
  }
  const [ended, settled] = tracker?.settle() ?? [new Map<string, [string, Date]>(), []];
  options.warnings?.push(...settled);
  for (const [old, [by, at]] of ended) {
    const gone = retiredEdge(current.get(old) ?? existing.get(old)!, by, at, createdAt);
    const key = JSON.stringify([old, gone.props.revision]);
    (writes.has(key) ? writes : retires).set(key, [old, gone.props]);
    current.set(old, gone);
  }

  const batched = [writes, retires].map((batch): EdgeWrite[] =>
    [...batch.values()].map(([rid, props]) => {
      const edge = current.get(rid)!;
      return [edge.type, edge.from_id, edge.to_id, props];
    }),
  );
  precheckEdges(runner, ns, L_ENTITY, L_ENTITY, batched.flat());
  if (!options.dry_run) {
    for (const rows of batched) {
      if (rows.length) await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
    }
    await writeEvidence(runner, ns, records, createdAt);
  }
  if (!options.dry_run && options.contradiction === "supersede" && moved.size) {
    await resettleEndpoints(
      runner,
      ns,
      [...moved].map((rid) => current.get(rid)!),
      options.caps,
      createdAt,
    );
    const stored = new Map<string, Relation>();
    for (const rid of dedupList(out.map(([rid]) => rid))) stored.set(rid, (await newestRelation(runner, ns, rid))!);
    return inputs.map(({ rid }) => stored.get(rid)!);
  }
  const result = new Map<string, Relation>();
  for (const [rid, revision, rel] of out) {
    const key = JSON.stringify([rid, revision]);
    const final = retires.get(key) ?? writes.get(key);
    result.set(rid, final === undefined ? rel : relationOf({ ...current.get(rid)!, props: final[1] }));
  }
  return inputs.map(({ rid }) => result.get(rid)!);
}

export interface CreateRelationArgs {
  from_entity: string;
  type: string;
  to_entity: string;
  id?: string | null;
  properties?: JsonObject | null;
  event_time?: Date | null;
  evidence: Evidence[];
}

/**
 * Create one relation version, normalizing the type to UPPER_SNAKE, failing if the id already exists unless a contradiction invalidated it.
 *
 * Creating an invalidated relation again reasserts it as a new current revision with exactly the given properties,
 * nothing carried over from the retired one, and adds a "relation_reasserted" warning. Without event_time the effective
 * time is the creation time. The new version is written before any relation it supersedes is retired; in supersede
 * mode one older than the current relations it conflicts with is written already invalidated. A reassertion in
 * supersede mode then settles its max_count endpoints again (see resettleEndpoints), as an insert that moves the
 * relation does.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (CreateRelationArgs): the relation fields.
 * @param schemaCheck (SchemaCheck | undefined): checks the relation against the schema before the write.
 * @param options (ContradictionOptions): the contradiction mode, the schema's max_count limits, and a list that receives the contradiction warnings.
 * @return (Relation): the created relation.
 */
export async function createRelation(
  runner: Runner,
  ns: string,
  given: CreateRelationArgs,
  schemaCheck?: SchemaCheck,
  options: ContradictionOptions = {},
): Promise<Relation> {
  requireStr("relation from_entity", given.from_entity);
  requireStr("relation type", given.type);
  requireStr("relation to_entity", given.to_entity);
  const args = {
    ...given,
    from_entity: ids.canonicalId(given.from_entity),
    to_entity: ids.canonicalId(given.to_entity),
  };
  requireJsonMapping("properties", args.properties);
  requireDatetime("event_time", args.event_time);
  validateOwnId("relation", args.id);
  const rtype = ids.normalizeRelType(args.type);
  const rid = args.id || ids.relationId(args.from_entity, rtype, args.to_entity);
  const properties = mergeProps(null, args.properties);
  const ends = { from_entity: args.from_entity, type: rtype, to_entity: args.to_entity };
  await schemaCheck?.(runner, { entities: [], relations: [{ id: args.id || null, ...ends, properties }] });
  for (const eid of relationLockIds(options.caps, [[rtype, args.from_entity, args.to_entity]]))
    await runner.lockNode(ns, L_ENTITY, eid);
  const prior = await newestRelation(runner, ns, rid);
  if (prior !== null) {
    if (prior.is_current || prior.invalidated_at === null) throw new ConflictError("Relation", rid);
    requireSameEnds(rid, [prior.from_entity, prior.type, prior.to_entity], [args.from_entity, rtype, args.to_entity]);
  }
  const [records, counts] = await planEvidence(
    runner,
    ns,
    args.evidence.map((ev) => [rid, ev] as const),
    prior === null ? new Set([rid]) : new Set(),
  );
  const createdAt = new Date();
  const props = encodeRelationProps({
    ns,
    id: rid,
    revision: prior === null ? 1 : prior.revision + 1,
    properties,
    event_time: args.event_time ?? null,
    created_at: createdAt,
    is_current: true,
    source_count: counts.get(rid) ?? prior?.source_count ?? 0,
  });
  const [tracker, existing] = await contradictionCheck(runner, ns, options, [
    [rtype, args.from_entity, args.to_entity],
  ]);
  let retires: EdgeRow[] = [];
  let written = props;
  if (tracker !== null) {
    const edge = { props, from_id: args.from_entity, to_id: args.to_entity, type: rtype };
    const version = relationOf(edge);
    const found = tracker.admit(
      rid,
      rtype,
      args.from_entity,
      args.to_entity,
      tracker.rank(version),
      effectiveTime(version),
    );
    const [ended, settled] = tracker.settle();
    options.warnings?.push(...found, ...settled);
    retires = [...ended]
      .filter(([old]) => old !== rid)
      .map(([old, [by, at]]) => retiredEdge(existing.get(old)!, by, at, createdAt));
    const own = ended.get(rid);
    if (own !== undefined) written = retiredEdge(edge, ...own, createdAt).props;
  }
  const retired: EdgeWrite[] = retires.map((e) => [e.type, e.from_id, e.to_id, e.props]);
  precheckEdges(runner, ns, L_ENTITY, L_ENTITY, [[ends.type, ends.from_entity, ends.to_entity, written], ...retired]);
  if (options.dry_run)
    return relationOf({ type: rtype, from_id: args.from_entity, to_id: args.to_entity, props: written });
  const rel = await writeRelationVersion(runner, ns, ends, written, null);
  if (retired.length) await runner.createEdges(ns, L_ENTITY, L_ENTITY, retired);
  await writeEvidence(runner, ns, records, createdAt);
  if (prior !== null) {
    options.warnings?.push(
      insertWarning(
        "relation_reasserted",
        `${invalidatedNote(prior)} (revision ${prior.revision}); reasserted as revision ${rel.revision} ` +
          "with exactly the given properties",
      ),
    );
  }
  if (prior !== null && options.contradiction === "supersede") {
    const edge = { type: rtype, from_id: args.from_entity, to_id: args.to_entity, props: written };
    await resettleEndpoints(runner, ns, [edge], options.caps, createdAt);
    return (await newestRelation(runner, ns, rid))!;
  }
  return rel;
}

export interface UpdateRelationArgs {
  set_properties?: JsonObject | null;
  remove_properties: readonly string[];
  event_time?: Date | null;
  evidence?: Evidence[] | null;
}

/**
 * Return the current version of a relation or preference, read again under its lock so no writer slips in.
 *
 * An object whose newest version carries invalidated_at was retired by a contradiction, which is a settled state
 * and throws ValidationError. One another write may still be writing throws TransientError (see takeClaim). Any
 * other object with versions but no current one lost its create to an interrupted write, so its newest version is
 * returned for the caller to complete.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param id (string): the relation or preference id.
 * @param kind ("relation" | "preference"): the object kind, for the errors.
 * @param get ((runner: Runner, ns: string, id: string) => Promise<T | null>): reads the current version, or null.
 * @param newest ((runner: Runner, ns: string, id: string) => Promise<T | null>): reads the highest revision, current or not, or null.
 * @param lockOn ((current: T) => [string, string]): maps the current version to the (label, id) node to lock.
 * @return (T): the current version under the lock, or the newest version when an interrupted update left none.
 */
async function lockCurrent<T extends { is_current: boolean }>(
  runner: Runner,
  ns: string,
  id: string,
  kind: "relation" | "preference",
  get: (runner: Runner, ns: string, id: string) => Promise<T | null>,
  newest: (runner: Runner, ns: string, id: string) => Promise<T | null>,
  lockOn: (current: T) => [string, string],
): Promise<T> {
  const claim = takeClaim(runner, ns, id);
  const before = (await get(runner, ns, id)) ?? (await newestUnretired(runner, ns, id, kind, newest));
  await runner.lockNode(ns, ...lockOn(before));
  if (runner.lockRefreshesReads === false) {
    if (before.is_current) foundCurrent(claim);
    else requireUnshared(claim, id, kind);
    return before;
  }
  const current = await get(runner, ns, id);
  if (current !== null) {
    foundCurrent(claim);
    return current;
  }
  if (before.is_current) throw new TransientError(`${kind} ${pyRepr(id)} was changed concurrently; retry`);
  requireUnshared(claim, id, kind);
  return newestUnretired(runner, ns, id, kind, newest);
}

/**
 * Return the newest version of a relation or preference with no current one, unless a contradiction retired it.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param id (string): the relation or preference id.
 * @param kind ("relation" | "preference"): the object kind, for the errors.
 * @param newest ((runner: Runner, ns: string, id: string) => Promise<T | null>): reads the highest revision, current or not, or null.
 * @return (T): the newest version.
 */
async function newestUnretired<T>(
  runner: Runner,
  ns: string,
  id: string,
  kind: "relation" | "preference",
  newest: (runner: Runner, ns: string, id: string) => Promise<T | null>,
): Promise<T> {
  const latest = await newest(runner, ns, id);
  if (latest === null) {
    throw new NotFoundError(kind === "relation" ? "Relation" : "Preference", id, undefined, { namespace: ns });
  }
  const ended = latest as Partial<Relation>;
  if (ended.invalidated_at != null) {
    throw new ValidationError(`${invalidatedNote(ended as Relation)}; create it again to reassert it`, {
      code: "relation_invalidated",
    });
  }
  return latest;
}

/**
 * Create a new version of a relation, settling its max_count endpoints again under supersede.
 *
 * The mark belongs to the version: a later revision starts uncertified, and the superseded version keeps its open
 * certification, ended at the update in the same write that retires it.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rid (string): the relation id.
 * @param args (UpdateRelationArgs): the properties to set and remove, a new valid time, and evidence to add.
 * @param schemaCheck (SchemaCheck | undefined): checks the resulting relation against the schema before the write, given the stored version too so only violations the update introduces count.
 * @param options (ContradictionOptions): "supersede" settles the endpoints again when event_time moves or the new revision of a certified relation, which starts uncertified, loses the exemption that kept it current, against the max_count limits; any other mode leaves them as they are, since an update adds no relation.
 * @return (Relation): the new version, current unless supersede retired it; throws ValidationError for a relation a contradiction invalidated.
 */
export async function updateRelation(
  runner: Runner,
  ns: string,
  rid: string,
  args: UpdateRelationArgs,
  schemaCheck?: SchemaCheck,
  options: ContradictionOptions = {},
): Promise<Relation> {
  requireJsonMapping("set_properties", args.set_properties);
  requireList("remove_properties", args.remove_properties);
  requireDatetime("event_time", args.event_time);
  requireChanges({
    set_properties: args.set_properties ?? undefined,
    remove_properties: args.remove_properties.length ? args.remove_properties : undefined,
    event_time: args.event_time ?? undefined,
    evidence: args.evidence ?? undefined,
  });
  const current = await lockCurrent(runner, ns, rid, "relation", getRelationCurrent, newestRelation, (rel) => [
    L_ENTITY,
    rel.from_entity,
  ]);
  const newProps = mergeProps(current.properties, args.set_properties, args.remove_properties);
  const { from_entity, type, to_entity } = current;
  await schemaCheck?.(
    runner,
    { entities: [], relations: [{ id: rid, from_entity, type, to_entity, properties: newProps }] },
    { entities: [], relations: [{ id: rid, from_entity, type, to_entity, properties: current.properties }] },
  );
  const newEventTime = args.event_time ?? current.event_time;
  const createdAt = new Date();
  const [records, counts] = await planEvidence(
    runner,
    ns,
    (args.evidence ?? []).map((ev) => [rid, ev] as const),
    new Set(),
  );
  const sources = counts.get(rid) ?? current.source_count;

  if (
    current.is_current &&
    deepEqual(newProps, current.properties) &&
    toIso(newEventTime) === toIso(current.event_time)
  ) {
    if (sources !== current.source_count) {
      await runner.updateCurrentEdge(ns, rid, { source_count: sources });
      current.source_count = sources;
    }
    await writeEvidence(runner, ns, records, createdAt);
    return current;
  }

  const props = encodeRelationProps({
    ns,
    id: rid,
    revision: current.revision + 1,
    properties: newProps,
    event_time: newEventTime,
    created_at: createdAt,
    is_current: true,
    source_count: sources,
  });
  const retire = current.is_current ? certifications(current, createdAt) : null;
  const rel = await writeRelationVersion(runner, ns, current, props, retire);
  await writeEvidence(runner, ns, records, createdAt);
  const moved = toIso(newEventTime) !== toIso(current.event_time);
  const lostCertification = current.is_current
    ? current.certified_at !== null
    : current.certifications.slice(-1).some((c) => c.until !== null);
  if (options.contradiction === "supersede" && (moved || lostCertification)) {
    if (lostCertification) await settleUncertified(runner, ns, rel, options.caps, createdAt);
    if (moved) {
      const edge = { type: rel.type, from_id: rel.from_entity, to_id: rel.to_entity, props };
      await resettleEndpoints(runner, ns, [edge], options.caps, createdAt);
    }
    return (await newestRelation(runner, ns, rid))!;
  }
  return rel;
}

/**
 * Settle the max_count endpoints of a relation whose new revision dropped the certification that kept it current.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rel (Relation): the new, uncertified revision, already written.
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @param at (Date): the write's timestamp, stamped on each retirement.
 * @param mode (string): the endpoint contradiction mode.
 * @return (Promise<InsertWarning[]>): endpoint warnings.
 */
async function settleUncertified(
  runner: Runner,
  ns: string,
  rel: Relation,
  caps: ReadonlyMap<string, RelationCap> | null | undefined,
  at: Date,
  mode: string = "supersede",
): Promise<InsertWarning[]> {
  const [tracker, found] = await contradictionCheck(runner, ns, { contradiction: mode, caps }, [
    [rel.type, rel.from_entity, rel.to_entity],
  ]);
  if (tracker === null) return [];
  const warnings = tracker.admit(
    rel.id,
    rel.type,
    rel.from_entity,
    rel.to_entity,
    tracker.rank(rel),
    effectiveTime(rel),
    false,
    true,
  );
  const [ended, foundWarnings] = tracker.settle();
  await retireRelations(
    runner,
    ns,
    [...ended].map(([old, [by, when]]) => [found.get(old)!, by, when] as const),
    at,
  );
  return [...warnings, ...foundWarnings];
}

/**
 * List current relations, optionally filtered by endpoints and type.
 *
 * With include_invalidated, the newest version of each relation a contradiction invalidated is listed too, in id
 * order with the current ones; this reads every version matching the filters.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (object): the endpoint and type filters, the page window, include_invalidated, and the id to list after for keyset paging.
 * @return (Relation[]): the current relations, and the invalidated ones when asked.
 */
export async function listRelations(
  runner: Runner,
  ns: string,
  args: {
    from_entity?: string | null;
    type?: string | null;
    to_entity?: string | null;
    skip: number;
    limit: number;
    from_in?: readonly string[] | null;
    to_in?: readonly string[] | null;
    include_invalidated?: boolean;
    after?: string | null;
  },
): Promise<Relation[]> {
  requireOptionalText("from_entity filter", args.from_entity);
  requireOptionalText("type filter", args.type);
  requireOptionalText("to_entity filter", args.to_entity);
  if (args.from_in != null) requireList("from_in filter", args.from_in);
  if (args.to_in != null) requireList("to_in filter", args.to_in);
  const all = args.include_invalidated === true;
  const filter = {
    from_label: L_ENTITY,
    to_label: L_ENTITY,
    type: args.type ? ids.normalizeRelType(args.type) : null,
    from_id: ids.canonicalId(args.from_entity ?? null),
    to_id: ids.canonicalId(args.to_entity ?? null),
    from_in: args.from_in ?? null,
    to_in: args.to_in ?? null,
    current_only: !all,
    id_gt: args.after,
  };
  if (!all) return (await runner.matchEdges(ns, { ...filter, skip: args.skip, limit: args.limit })).map(relationOf);
  const newest = new Map<string, EdgeRow>();
  for (const edge of await allEdges(runner, ns, filter)) keepNewest(newest, edge);
  return [...newest.values()]
    .filter((e) => e.props.is_current || e.props.invalidated_at)
    .slice(args.skip, args.skip + args.limit)
    .map(relationOf);
}

export interface AsOf {
  valid: Date;
  known: Date | null;
}

/**
 * Parse the as_of and known_at arguments, reading a time with no offset as UTC; known_at alone sets both.
 *
 * @param asOf (unknown): the valid time, as a Date, ISO 8601 text, or null.
 * @param knownAt (unknown): the time the graph knew it by, in the same forms.
 * @return (AsOf | null): the times to read at, or null to read the current graph.
 */
export function parseAsOf(asOf: unknown, knownAt: unknown): AsOf | null {
  const valid = parseTime(asOf, "as_of");
  const known = parseTime(knownAt, "known_at");
  if (valid === null && known === null) return null;
  return { valid: valid ?? known!, known };
}

/**
 * Report whether something written at a time was in the graph by another time.
 *
 * @param stamp (Date | null): when it was written; null counts as always.
 * @param known (Date | null): the time read on the knowledge axis, or null for everything stored.
 * @return (boolean): true when it was written by then.
 */
export function knownBy(stamp: Date | null, known: Date | null): boolean {
  return stamp === null || known === null || epochMicros(stamp) <= epochMicros(known);
}

/**
 * Pick the version of a relation or preference that was valid at a point in time.
 *
 * The picked version is the highest revision whose effective time is at or before asOf.valid, so a later write
 * overrides earlier ones from its effective time on. It is valid unless the first invalidation recorded at or after
 * its revision happened at or before asOf.valid. With asOf.known, only the versions and invalidations written by then
 * count, and the picked version is shown as the graph held it then: an invalidation written later is cleared, its
 * certification is the one in force then, and it is current when no newer revision and no invalidation was written by
 * then.
 *
 * @param versions (Iterable<T>): every version of one relation or preference.
 * @param asOf (AsOf): the valid time, and the time the graph knew it by.
 * @return (T | null): the version valid at asOf, or null.
 */
export function versionAsOf<T extends Relation | Preference>(versions: Iterable<T>, asOf: AsOf): T | null {
  const at = epochMicros(asOf.valid);
  const ordered = [...versions]
    .filter((v) => knownBy(v.created_at, asOf.known))
    .sort((a, b) => a.revision - b.revision);
  let picked: T | null = null;
  for (const version of ordered) {
    if (epochMicros(effectiveTime(version)) <= at) picked = version;
  }
  if (picked === null) return null;
  for (const version of ordered) {
    const rel = version as Partial<Relation>;
    const ended = rel.invalidated_at ?? null;
    if (version.revision >= picked.revision && ended && knownBy(rel.invalidated_known_at ?? null, asOf.known)) {
      if (epochMicros(ended) <= at) return null;
      break;
    }
  }
  if (asOf.known === null) return picked;
  const held = picked as Partial<Relation>;
  const update: Partial<Relation> = { is_current: picked.revision === ordered.at(-1)!.revision };
  if ((held.invalidated_at ?? null) !== null) {
    if (knownBy(held.invalidated_known_at ?? null, asOf.known)) update.is_current = false;
    else Object.assign(update, { invalidated_at: null, invalidated_by: null, invalidated_known_at: null });
  }
  if (held.certifications !== undefined) {
    const known = epochMicros(asOf.known);
    const seen = held.certifications
      .filter((c) => knownBy(c.at, asOf.known))
      .map((c) => ({ ...c, until: c.until !== null && epochMicros(c.until) <= known ? c.until : null }));
    const inForce = seen.length && seen.at(-1)!.until === null ? seen.at(-1)! : null;
    Object.assign(update, {
      certifications: seen,
      certified_at: inForce?.at ?? null,
      certified_by: inForce?.by ?? null,
    });
  }
  return { ...picked, ...update };
}

/**
 * Group edge versions by id in read order and keep the version of each valid at a point in time.
 *
 * @param edges (readonly EdgeRow[]): the edge versions.
 * @param decode ((e: EdgeRow) => T): turns an edge row into a Relation or Preference.
 * @param asOf (AsOf): the valid time, and the time the graph knew it by.
 * @return (T[]): the valid versions, one per id at most.
 */
function pickAsOf<T extends Relation | Preference>(
  edges: readonly EdgeRow[],
  decode: (e: EdgeRow) => T,
  asOf: AsOf,
): T[] {
  const versions = new Map<string, T[]>();
  for (const edge of edges) {
    const group = versions.get(idOf(edge.props));
    if (group === undefined) versions.set(idOf(edge.props), [decode(edge)]);
    else group.push(decode(edge));
  }
  return [...versions.values()].map((group) => versionAsOf(group, asOf)).filter((v): v is T => v !== null);
}

/**
 * Read every version of the relations starting or ending at some entities, as each stood at a point in time. With
 * asOf.known and countSources, each relation's source_count counts only the sources whose evidence was written by
 * then.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param asOf (AsOf): the valid time, and the time the graph knew it by.
 * @param anchor ({ from_in?: readonly string[]; to_in?: readonly string[] }): the entity ids the relations start or end at.
 * @param countSources (boolean): recount source_count for asOf.known; left as stored otherwise.
 * @return (Relation[]): the relations valid at asOf, in id order.
 */
export async function relationsAsOf(
  runner: Runner,
  ns: string,
  asOf: AsOf,
  anchor: { from_in?: readonly string[]; to_in?: readonly string[] },
  countSources = false,
): Promise<Relation[]> {
  const edges = (await allEdges(runner, ns, { from_label: L_ENTITY, to_label: L_ENTITY, ...anchor }, PAGE)).filter(
    (e) => isRelationType(e.type),
  );
  const picked = pickAsOf(edges, relationOf, asOf);
  return countSources ? withKnownSources(runner, ns, picked, asOf.known) : picked;
}

/**
 * Count distinct sources whose evidence was recorded by the knowledge cutoff.
 *
 * @param runner (Runner): graph reader.
 * @param ns (string): namespace.
 * @param records (T[]): entities or relations to recount.
 * @param known (Date | null): knowledge cutoff, or null to keep the stored counts.
 * @return (Promise<T[]>): records with the source counts visible at the cutoff.
 */
export async function withKnownSources<T extends Entity | Relation>(
  runner: Runner,
  ns: string,
  records: T[],
  known: Date | null,
): Promise<T[]> {
  if (known === null || !records.length) return records;
  const sources = new Map<string, Set<string>>();
  for (const row of await nodesWhere(
    runner,
    ns,
    L_EVIDENCE,
    "target_id",
    records.map((r) => r.id),
  )) {
    if (!knownBy(fromIso(row.created_at), known)) continue;
    const target = row.target_id as string;
    if (!sources.has(target)) sources.set(target, new Set());
    sources.get(target)!.add(row.source_id as string);
  }
  return records.map((r) => ({ ...r, source_count: sources.get(r.id)?.size ?? 0 }));
}

/**
 * Read every version of every preference, as each stood at a point in time.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param asOf (AsOf): the valid time, and the time the graph knew it by.
 * @return (Preference[]): the preferences valid at asOf, in id order.
 */
export async function preferencesAsOf(runner: Runner, ns: string, asOf: AsOf): Promise<Preference[]> {
  const edges = (await allEdges(runner, ns, { from_label: L_PROFILE, to_label: null }, PAGE)).filter((e) =>
    isPreferenceType(e.type),
  );
  return pickAsOf(edges, preferenceOf, asOf);
}

/**
 * Encode a relation version's certifications with the open one ended at a time, and a new one from then by someone.
 *
 * @param rel (Relation): the stored version.
 * @param at (Date): when the open certification ends, and the new one starts.
 * @param by (string | null): who certifies the version from then on, or null to leave it uncertified.
 * @return (Props): the version's certified_at, certified_by, and certifications_json, or none when no certification is open and none starts.
 */
function certifications(rel: Relation, at: Date, by: string | null = null): Props {
  if (rel.certified_at === null && by === null) return {};
  const history = rel.certifications.map((c) => ({ by: c.by, at: toIso(c.at), until: toIso(c.until ?? at) }));
  if (by !== null) history.push({ by, at: toIso(at), until: null });
  return { certified_at: by === null ? null : toIso(at), certified_by: by, certifications_json: dumps(history) };
}

/**
 * Mark the current version of a relation as verified by someone, in place, or clear the mark when by is null.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rid (string): the relation id.
 * @param by (string | null): who verified it, or null to remove the certification.
 * @param at (Date): when it was certified.
 * @param mode (string): the endpoint contradiction mode.
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): schema endpoint limits.
 * @return (Relation): the stored version after certification and settlement.
 */
export async function certifyRelation(
  runner: Runner,
  ns: string,
  rid: string,
  by: string | null,
  at: Date,
  mode: string = "off",
  caps?: ReadonlyMap<string, RelationCap> | null,
): Promise<Relation> {
  requireStr("relation id", rid);
  if (by !== null && (typeof by !== "string" || !pyStrip(by))) {
    throw new ValidationError("certified_by must be a non-empty string");
  }
  if (by !== null && hasSurrogate(by)) {
    throw new ValidationError("certified_by cannot contain unpaired surrogate characters", { field: "by" });
  }
  let edge = await runner.getCurrentEdge(ns, rid);
  if (edge !== null) {
    for (const eid of relationLockIds(caps, [[edge.type, edge.from_id, edge.to_id]])) {
      await runner.lockNode(ns, L_ENTITY, eid);
    }
    edge = await runner.getCurrentEdge(ns, rid);
  }
  if (edge === null || !isRelationType(edge.type)) {
    const newest = await newestRelation(runner, ns, rid);
    if (newest === null) throw new NotFoundError("Relation", rid, undefined, { namespace: ns });
    throw new ValidationError(`${invalidatedNote(newest)}; only a current relation can be certified`, {
      code: "relation_invalidated",
    });
  }
  let rel = relationOf(edge);
  if (rel.certified_by !== by) {
    const props = { ...edge.props, ...certifications(rel, at, by) };
    const rows: EdgeWrite[] = [[edge.type, edge.from_id, edge.to_id, props]];
    precheckEdges(runner, ns, L_ENTITY, L_ENTITY, rows);
    await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
    rel = relationOf({ ...edge, props });
  }
  if (by === null && mode !== "off" && caps?.size) {
    const warnings = await settleUncertified(runner, ns, rel, caps, at, mode);
    warnSchema(warnings);
    rel = (await newestRelation(runner, ns, rid))!;
  }
  return rel;
}

/**
 * List the entities and relations that have evidence from any unreplaced version of a source.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param sourceId (string): the source id.
 * @return (Set<string>): the evidence target ids.
 */
export async function sourceTargets(runner: Runner, ns: string, sourceId: string): Promise<Set<string>> {
  const versions = await runner.childNodes(ns, L_SOURCE, ids.sourceNodeId(sourceId), R_HAS_VERSION, L_SOURCE_VERSION);
  const replaced = new Set(versions.filter((row) => (row.replaced_by ?? null) !== null).map((row) => row.id as string));
  const rows = await scan(nodeListing(runner, ns, L_EVIDENCE, { equals: { source_id: sourceId } }), Infinity, BATCH);
  return new Set(
    rows.filter((row) => !replaced.has(row.source_version as string)).map((row) => row.target_id as string),
  );
}

/**
 * Make one version of a source replace its others: mark them replaced_at and replaced_by, so retrieval stops quoting
 * them, and retire the current relations among some candidates whose every evidence record is from one of them, as a
 * newer fact retires one: invalidated_at is set and nothing is deleted. Each version keeps its replacements, with when
 * each was written and undone, in replacements_json for known_at reads.
 *
 * A relation with evidence from the given version, or from a version of another source that was not itself replaced,
 * stays current, and so does a certified one, with a "certified_kept" warning. Evidence recorded by hand has no stored
 * version and always counts.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param sourceId (string): the source id.
 * @param version (string): the source version just recorded; it is stored as invalidated_by.
 * @param stale (Iterable<string>): the ids the source supported before and the new version did not produce again.
 * @param at (Date): the insert's effective time, for a version it stores or restores.
 * @param known (Date): the timestamp of the insert that recorded the new version.
 * @return ([string[], InsertWarning[]]): the retired relation ids, and one warning per decision.
 */
export async function replaceSource(
  runner: Runner,
  ns: string,
  sourceId: string,
  version: string,
  stale: Iterable<string>,
  at: Date,
  known: Date,
): Promise<[string[], InsertWarning[]]> {
  const stored = await runner.getNode(ns, L_SOURCE_VERSION, version);
  if (stored !== null && (stored.replaced_by ?? null) === null) {
    at = fromIso((stored.event_time ?? stored.created_at) as string)!;
  }
  const candidates = [...new Set(stale)].sort(comparePy);
  const support = new Map<string, Props[]>();
  for (const row of await nodesWhere(runner, ns, L_EVIDENCE, "target_id", candidates)) {
    const target = row.target_id as string;
    support.set(target, [...(support.get(target) ?? []), row]);
  }
  const others = dedupList(
    [...support.values()]
      .flat()
      .filter((r) => r.source_id !== sourceId)
      .map((r) => r.source_version as string),
  );
  const replaced = new Set(
    [...(await nodesById(runner, ns, L_SOURCE_VERSION, others))].filter(([, row]) => row.replaced_by).map(([sv]) => sv),
  );
  const active = (r: Props): boolean =>
    r.source_version === `${r.source_id}:manual` ||
    (r.source_id === sourceId ? r.source_version === version : !replaced.has(r.source_version as string));
  const retired: string[] = [];
  const retirements: Array<readonly [EdgeRow, string, Date]> = [];
  const warnings: InsertWarning[] = [];
  for (const rid of candidates) {
    if ((support.get(rid) ?? []).some(active)) continue;
    const edge = await runner.getCurrentEdge(ns, rid);
    if (edge === null || !isRelationType(edge.type)) continue;
    if (edge.props.certified_at !== null && edge.props.certified_at !== undefined) {
      const message = `relation ${rid} is certified, so it stays current though source ${sourceId} no longer states it`;
      warnings.push(insertWarning("certified_kept", message));
      continue;
    }
    retirements.push([edge, version, at]);
    retired.push(rid);
    const message = `relation ${rid} was retired: only older versions of source ${sourceId} stated it`;
    warnings.push(insertWarning("fact_retired_by_source", message));
  }
  await retireRelations(runner, ns, retirements, known);
  const knownAt = toIso(known);
  const marks: NodeRow[] = [];
  for (const row of await runner.childNodes(
    ns,
    L_SOURCE,
    ids.sourceNodeId(sourceId),
    R_HAS_VERSION,
    L_SOURCE_VERSION,
  )) {
    const replacedBy = row.replaced_by ?? null;
    const history = loads<Array<Record<string, string | null>>>(row.replacements_json, []);
    if (row.id === version && replacedBy !== null) {
      history.at(-1)!.until = knownAt;
      history.at(-1)!.valid_until = toIso(at);
      marks.push([
        row.id as string,
        { ...row, replaced_at: null, replaced_by: null, replacements_json: dumps(history) },
      ]);
    } else if (row.id !== version && replacedBy === null) {
      history.push({ at: toIso(at), by: version, known_at: knownAt, until: null });
      const mark = { replaced_at: toIso(at), replaced_by: version, replacements_json: dumps(history) };
      marks.push([row.id as string, { ...row, ...mark }]);
    }
  }
  if (marks.length) await runner.upsertNodes(ns, L_SOURCE_VERSION, marks);
  return [retired, warnings];
}

/**
 * Delete a relation, all of its versions, and any decision trace that uses it as a step.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rid (string): the relation id.
 * @param caps (ReadonlyMap<string, RelationCap> | null | undefined): the schema's max_count limits, or null without a schema.
 * @return (DeleteResult): counts of what was removed and restored.
 */
export async function deleteRelation(
  runner: Runner,
  ns: string,
  rid: string,
  caps?: ReadonlyMap<string, RelationCap> | null,
): Promise<DeleteResult> {
  requireStr("relation id", rid);
  const newest = newestEdge(await typedEdgeVersions(runner, ns, rid, isRelationType));
  if (newest === null) throw new NotFoundError("Relation", rid, undefined, { namespace: ns });
  const deletedDecisions = await deleteTraces(runner, ns, await tracesTouchingRelations(runner, ns, [rid]));
  const deletedVersions = await runner.deleteEdges(ns, rid);
  await deleteEvidence(runner, ns, rid);
  const restored = await resettleEndpoints(runner, ns, [newest], caps, new Date());
  return {
    ...NO_DELETES,
    deleted_relation_versions: deletedVersions,
    deleted_decisions: deletedDecisions,
    restored_relations: restored,
  };
}

async function ensureProfile(runner: Runner, ns: string, subjectId: string, createdAt: Date): Promise<string> {
  const pid = ids.profileId(subjectId);
  if (await runner.nodeExists(ns, L_PROFILE, pid)) return pid;
  if (!(await runner.nodeExists(ns, L_ENTITY, subjectId))) {
    throw new ValidationError(`preference references unknown subject entity ${pyRepr(subjectId)}`, {
      code: "unknown_reference",
    });
  }
  await runner.upsertNode(ns, L_PROFILE, pid, { id: pid, ns, subject_entity: subjectId, created_at: toIso(createdAt) });
  await runner.createEdge(ns, R_HAS_PROFILE, L_ENTITY, subjectId, L_PROFILE, pid, {
    ns,
    id: childEdgeId(R_HAS_PROFILE, pid),
    revision: 1,
  });
  return pid;
}

type PreferenceEnds = Pick<Preference, "value_entity" | "profile_id" | "stance">;

export const preferenceOf = (e: EdgeRow): Preference =>
  decodePreference(e.props, {
    value_entity: e.to_id,
    profile_id: e.from_id,
    stance: preferenceStanceOf(e.type) ?? DEFAULT_STANCE,
  });

/**
 * Write a preference version as the current one, retiring the previous current version when there is one.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param ends (PreferenceEnds): the profile, value entity, and stance.
 * @param props (Props): the encoded version.
 * @param retire (boolean): true when an existing current version must be flipped first.
 * @return (Preference): the written version.
 */
async function writePreferenceVersion(
  runner: Runner,
  ns: string,
  ends: PreferenceEnds,
  props: Props,
  retire: boolean,
): Promise<Preference> {
  const type = preferenceEdgeType(ends.stance);
  if (retire) {
    precheckEdges(runner, ns, L_PROFILE, L_ENTITY, [[type, ends.profile_id, ends.value_entity, props]]);
    await runner.updateCurrentEdge(ns, idOf(props), { is_current: false });
  }
  await runner.createEdge(ns, type, L_PROFILE, ends.profile_id, L_ENTITY, ends.value_entity, props);
  return decodePreference(props, ends);
}

export async function getPreference(runner: Runner, ns: string, pid: string): Promise<Preference | null> {
  requireStr("preference id", pid);
  const edge = await runner.getCurrentEdge(ns, pid);
  return edge === null || !isPreferenceType(edge.type) ? null : preferenceOf(edge);
}

export async function preferenceExists(runner: Runner, ns: string, pid: string): Promise<boolean> {
  return (await typedEdgeVersions(runner, ns, pid, isPreferenceType)).length > 0;
}

/**
 * The fields that identify a preference and cannot change: subject, stance, normalized key, and value.
 *
 * @param pref (Preference | ParsedPreferenceInput): a stored preference or an input to write.
 * @return (string): its identity as one comparable key.
 */
function preferenceIdentity(pref: Preference | ParsedPreferenceInput): string {
  return JSON.stringify([pref.subject_entity, pref.stance, ids.normalizeText(pref.key), pref.value_entity]);
}

/**
 * Reject a write that would change the subject, stance, key, or value of an existing preference.
 *
 * @param pid (string): the preference id.
 * @param stored (string): the stored identity.
 * @param given (string): the written identity.
 * @return (void): nothing; throws ValidationError when they differ.
 */
function requireSamePreference(pid: string, stored: string, given: string): void {
  if (stored !== given) {
    throw new ValidationError(
      `preference ${pyRepr(pid)} already exists with different subject/stance/key/value; ` +
        "these identify the preference and are immutable; create a new preference to change them",
      { code: "immutable_identity" },
    );
  }
}

/**
 * Reject conflicting preference ids before the insert writes any facts or provenance.
 *
 * An id conflicts when it is stored, or given earlier in the batch, with a different identity.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param preferences (readonly ParsedPreferenceInput[]): the final canonical preferences to write.
 * @return (Promise<void>): nothing; throws ValidationError if a preference id names a different identity.
 */
export async function requirePreferenceIdentities(
  runner: Runner,
  ns: string,
  preferences: readonly ParsedPreferenceInput[],
): Promise<void> {
  const identities = new Map<string, string>();
  for (const pref of preferences) {
    const pid = pref.id || ids.preferenceId(pref.subject_entity, pref.stance, pref.key, pref.value_entity);
    const given = preferenceIdentity(pref);
    let stored = identities.get(pid);
    if (stored === undefined) {
      const current = await getPreference(runner, ns, pid);
      stored = current === null ? given : preferenceIdentity(current);
      identities.set(pid, stored);
    }
    requireSamePreference(pid, stored, given);
  }
}

/**
 * Insert-semantics upsert of a preference: merge properties, versioning on change.
 *
 * A preference an interrupted update left with no current version is completed from its newest version.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param pref (ParsedPreferenceInput): the preference to upsert.
 * @param defaultEventTime (Date | null): the fallback event time.
 * @param createdAt (Date): the timestamp.
 * @return (Preference): the stored current version.
 */
export async function upsertPreference(
  runner: Runner,
  ns: string,
  pref: ParsedPreferenceInput,
  defaultEventTime: Date | null,
  createdAt: Date,
): Promise<Preference> {
  validateStrength(pref.strength);
  validateOwnId("preference", pref.id);
  const pid = pref.id || ids.preferenceId(pref.subject_entity, pref.stance, pref.key, pref.value_entity);
  const named = pref.event_time ?? defaultEventTime ?? null;
  await requirePreferenceRefs(runner, ns, pref);
  const profileId = await ensureProfile(runner, ns, pref.subject_entity, createdAt);

  const claim = takeClaim(runner, ns, pid);
  await runner.lockNode(ns, L_PROFILE, profileId);
  const base = await newestPreference(runner, ns, pid);
  const current = base?.is_current ? base : null;
  if (current !== null) foundCurrent(claim);
  else if (base !== null) requireUnshared(claim, pid, "preference");
  if (base !== null) requireSamePreference(pid, preferenceIdentity(base), preferenceIdentity(pref));
  const eventTime = named ?? base?.event_time ?? null;
  const strength = base === null || pref.strength != null ? pref.strength : base.strength;
  const aboutEntity = base === null || pref.about_entity != null ? pref.about_entity : base.about_entity;
  const mergedProps = mergeProps(base?.properties ?? null, pref.properties);
  const props = encodePreferenceProps({
    ns,
    id: pid,
    revision: base === null ? 1 : base.revision + 1,
    subject_entity: pref.subject_entity,
    key: ids.normalizeText(pref.key),
    about_entity: aboutEntity ?? null,
    strength: strength ?? null,
    properties: mergedProps,
    event_time: eventTime,
    created_at: createdAt,
    is_current: true,
  });

  if (current !== null) {
    const unchanged =
      current.strength === strength &&
      current.about_entity === aboutEntity &&
      deepEqual(current.properties, mergedProps) &&
      toIso(current.event_time) === toIso(eventTime);
    if (unchanged) return current;
  }
  const ends = { value_entity: pref.value_entity, profile_id: profileId, stance: pref.stance };
  return writePreferenceVersion(runner, ns, ends, props, current !== null);
}

/**
 * Insert-semantics upsert of many preferences, folding the inputs that share an id into one write.
 *
 * Later properties overwrite earlier ones and keep their null values so a stored key is still removed, and a later
 * strength, about_entity, or event time replaces an earlier one only when it is given. A repeated id writes at most
 * one new revision, and replaying the same inputs writes none.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param prefs (readonly ParsedPreferenceInput[]): the preferences to upsert, in order.
 * @param defaultEventTime (Date | null): the fallback event time.
 * @param createdAt (Date): the timestamp.
 * @return (Preference[]): each input's stored current version, in input order.
 */
export async function upsertPreferences(
  runner: Runner,
  ns: string,
  prefs: readonly ParsedPreferenceInput[],
  defaultEventTime: Date | null,
  createdAt: Date,
): Promise<Preference[]> {
  const folded = new Map<string, ParsedPreferenceInput>();
  const order: string[] = [];
  for (const pref of prefs) {
    const pid = pref.id || ids.preferenceId(pref.subject_entity, pref.stance, pref.key, pref.value_entity);
    order.push(pid);
    const first = folded.get(pid);
    if (first === undefined) {
      folded.set(pid, pref);
      continue;
    }
    folded.set(pid, {
      ...first,
      properties: { ...canonProps(first.properties), ...canonProps(pref.properties) },
      event_time: pref.event_time ?? defaultEventTime ?? first.event_time,
      strength: pref.strength ?? first.strength,
      about_entity: pref.about_entity ?? first.about_entity,
    });
  }
  const stored = new Map<string, Preference>();
  for (const [pid, pref] of folded)
    stored.set(pid, await upsertPreference(runner, ns, pref, defaultEventTime, createdAt));
  return order.map((pid) => stored.get(pid)!);
}

export interface CreatePreferenceArgs {
  subject_entity: string;
  key: string;
  value_entity: string;
  id?: string | null;
  stance: Stance;
  about_entity?: string | null;
  strength?: number | null;
  properties?: JsonObject | null;
  event_time?: Date | null;
}

/**
 * Create one preference, failing if its id already exists.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (CreatePreferenceArgs): the preference fields.
 * @return (Preference): the created preference.
 */
export async function createPreference(runner: Runner, ns: string, given: CreatePreferenceArgs): Promise<Preference> {
  requireChoice("preference stance", given.stance, STANCES);
  validateStrength(given.strength);
  requireStr("preference subject_entity", given.subject_entity);
  requireStr("preference key", given.key);
  requireStr("preference value_entity", given.value_entity);
  const args = {
    ...given,
    subject_entity: ids.canonicalId(given.subject_entity),
    value_entity: ids.canonicalId(given.value_entity),
    about_entity: ids.canonicalId(given.about_entity),
  };
  const key = ids.normalizeText(args.key);
  requireJsonMapping("properties", args.properties);
  requireDatetime("event_time", args.event_time);
  validateOwnId("preference", args.id);
  const pid = args.id || ids.preferenceId(args.subject_entity, args.stance, key, args.value_entity);
  await requirePreferenceRefs(runner, ns, args);
  const props = encodePreferenceProps({
    ns,
    id: pid,
    revision: 1,
    subject_entity: args.subject_entity,
    key,
    about_entity: args.about_entity ?? null,
    strength: args.strength ?? null,
    properties: mergeProps(null, args.properties),
    event_time: args.event_time ?? null,
    created_at: new Date(),
    is_current: true,
  });
  const type = preferenceEdgeType(args.stance);
  precheckEdges(runner, ns, L_PROFILE, L_ENTITY, [
    [type, ids.profileId(args.subject_entity), args.value_entity, props],
  ]);
  const profileId = await ensureProfile(runner, ns, args.subject_entity, new Date());
  await runner.lockNode(ns, L_PROFILE, profileId);
  if (await preferenceExists(runner, ns, pid)) throw new ConflictError("Preference", pid);
  const ends = { value_entity: args.value_entity, profile_id: profileId, stance: args.stance };
  return writePreferenceVersion(runner, ns, ends, props, false);
}

export interface UpdatePreferenceArgs {
  strength?: number | null;
  properties?: JsonObject | null;
  remove_properties: readonly string[];
  event_time?: Date | null;
  clear?: readonly string[];
}

/**
 * Create a new version of a preference, merging properties; an unchanged update is a no-op.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param pid (string): the preference id.
 * @param args (UpdatePreferenceArgs): the new strength, properties to merge and remove, valid time, and the fields to clear (strength, about_entity, event_time).
 * @param aboutDropped (boolean): true when an entity delete writes the version to drop a deleted about_entity.
 * @return (Preference): the current version.
 */
export async function updatePreference(
  runner: Runner,
  ns: string,
  pid: string,
  args: UpdatePreferenceArgs,
  aboutDropped = false,
): Promise<Preference> {
  validateStrength(args.strength);
  requireJsonMapping("properties", args.properties);
  requireList("remove_properties", args.remove_properties);
  requireDatetime("event_time", args.event_time);
  const cleared = requireClear("preferences.update", args.clear ?? [], PREFERENCE_CLEARABLE, {
    strength: args.strength,
    event_time: args.event_time,
  });
  requireChanges({
    strength: args.strength ?? undefined,
    properties: args.properties ?? undefined,
    remove_properties: args.remove_properties.length ? args.remove_properties : undefined,
    event_time: args.event_time ?? undefined,
    clear: cleared.size ? cleared : undefined,
  });
  const current = await lockCurrent(runner, ns, pid, "preference", getPreference, newestPreference, (pref) => [
    L_PROFILE,
    pref.profile_id,
  ]);
  const newStrength = cleared.has("strength") ? null : (args.strength ?? current.strength);
  const newProps = mergeProps(current.properties, args.properties, args.remove_properties);
  const newEventTime = cleared.has("event_time") ? null : (args.event_time ?? current.event_time);
  const newAbout = cleared.has("about_entity") ? null : current.about_entity;
  if (
    current.is_current &&
    newStrength === current.strength &&
    newAbout === current.about_entity &&
    deepEqual(newProps, current.properties) &&
    toIso(newEventTime) === toIso(current.event_time)
  ) {
    return current;
  }
  const props = encodePreferenceProps({
    ns,
    id: pid,
    revision: current.revision + 1,
    subject_entity: current.subject_entity,
    key: current.key,
    about_entity: newAbout,
    strength: newStrength,
    properties: newProps,
    event_time: newEventTime,
    created_at: new Date(),
    is_current: true,
    about_dropped: aboutDropped,
  });
  return writePreferenceVersion(runner, ns, current, props, current.is_current);
}

export async function listPreferenceVersions(
  runner: Runner,
  ns: string,
  pid: string,
  newestFirst: boolean,
): Promise<Preference[]> {
  requireStr("preference id", pid);
  const prefs = (await typedEdgeVersions(runner, ns, pid, isPreferenceType)).map(preferenceOf);
  if (newestFirst) prefs.reverse();
  return prefs;
}

export async function listPreferences(
  runner: Runner,
  ns: string,
  args: {
    subject_entity?: string | null;
    key?: string | null;
    stance?: Stance | null;
    skip: number;
    limit: number;
    after?: string | null;
  },
): Promise<Preference[]> {
  requireOptionalText("subject_entity filter", args.subject_entity);
  requireOptionalText("key filter", args.key);
  if (args.stance != null) requireChoice("preference stance", args.stance, STANCES);
  const equals: Props = {};
  if (args.subject_entity != null) equals.subject_entity = ids.canonicalId(args.subject_entity);
  if (args.key != null) equals.key = ids.normalizeText(args.key);
  const rows = await runner.matchEdges(ns, {
    from_label: L_PROFILE,
    to_label: null,
    type: args.stance != null ? preferenceEdgeType(args.stance) : null,
    current_only: true,
    equals,
    skip: args.skip,
    limit: args.limit,
    id_gt: args.after,
  });
  return rows.map(preferenceOf);
}

export async function deletePreference(runner: Runner, ns: string, pid: string): Promise<DeleteResult> {
  requireStr("preference id", pid);
  const versions = await typedEdgeVersions(runner, ns, pid, isPreferenceType);
  if (!versions.length) throw new NotFoundError("Preference", pid, undefined, { namespace: ns });
  const dropped = versions.length - authoredVersions(versions);
  return { ...NO_DELETES, deleted_preference_versions: (await runner.deleteEdges(ns, pid)) - dropped };
}

async function readSteps(runner: Runner, ns: string, tid: string): Promise<DecisionStep[]> {
  return stepsOf(await runner.childNodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP));
}

/**
 * Decode a trace's stored step nodes into its steps, in step order.
 *
 * @param rows (readonly Props[]): the step nodes' properties.
 * @return (DecisionStep[]): the steps.
 */
function stepsOf(rows: readonly Props[]): DecisionStep[] {
  return rows
    .map((r) => ({
      order: Math.trunc(Number(r.order)),
      relation_id: r.relation_id as string,
      from_entity: r.from_entity as string,
      to_entity: r.to_entity as string,
    }))
    .sort((a, b) => a.order - b.order);
}

export async function getTrace(runner: Runner, ns: string, tid: string): Promise<DecisionTrace | null> {
  requireStr("decision id", tid);
  const props = await runner.getNode(ns, L_TRACE, tid);
  if (props === null) return null;
  return decodeTrace(props, await readSteps(runner, ns, tid));
}

/**
 * Fetch many decision traces by id, in the order given, skipping ids with no trace.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param tids (readonly string[]): decision ids.
 * @return (DecisionTrace[]): the traces found.
 */
export async function getTraces(runner: Runner, ns: string, tids: readonly string[]): Promise<DecisionTrace[]> {
  const nodes = await nodesById(runner, ns, L_TRACE, tids);
  const rows = tids.filter((tid) => nodes.has(tid)).map((tid) => nodes.get(tid)!);
  return decodeTraces(runner, ns, rows);
}

/**
 * Rebuild stored decision traces with their steps, in the order given, reading every trace's steps at once.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rows (readonly Props[]): the stored decision trace nodes.
 * @return (DecisionTrace[]): the traces.
 */
export async function decodeTraces(runner: Runner, ns: string, rows: readonly Props[]): Promise<DecisionTrace[]> {
  const tids = rows.map(idOf);
  let steps: Map<string, Props[]>;
  if (runner.childrenOf) {
    steps = await runner.childrenOf(ns, L_TRACE, tids, R_HAS_STEP, L_STEP);
  } else {
    const edges = await edgesAt(
      runner,
      ns,
      { from_label: L_TRACE, to_label: L_STEP, type: R_HAS_STEP },
      "from_in",
      tids,
    );
    const nodes = await nodesById(
      runner,
      ns,
      L_STEP,
      edges.map((edge) => edge.to_id),
    );
    steps = new Map();
    for (const edge of edges) {
      const node = nodes.get(edge.to_id);
      if (!node) continue;
      if (!steps.has(edge.from_id)) steps.set(edge.from_id, []);
      steps.get(edge.from_id)!.push(node);
    }
  }
  return rows.map((row) => decodeTrace(row, stepsOf(steps.get(idOf(row)) ?? [])));
}

/**
 * Resolve decision step relation ids to their latest versions, so a step can name a retired relation.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param stepRelIds (readonly string[]): ordered relation ids.
 * @return (DecisionStep[]): the steps; throws ValidationError for an id with no version.
 */
async function resolveSteps(runner: Runner, ns: string, stepRelIds: readonly string[]): Promise<DecisionStep[]> {
  const versions = runner.edgeVersions ? await runner.edgeVersions(ns, null, null, dedupList(stepRelIds)) : null;
  const newest = new Map<string, EdgeRow>();
  for (const edge of versions ?? []) if (isRelationType(edge.type)) keepNewest(newest, edge);
  const steps: DecisionStep[] = [];
  for (const [order, relId] of stepRelIds.entries()) {
    const found = newest.get(relId);
    const rel = versions === null ? await newestRelation(runner, ns, relId) : found ? relationOf(found) : null;
    if (rel === null)
      throw new ValidationError(`decision step references unknown relation ${pyRepr(relId)}`, {
        code: "unknown_reference",
      });
    steps.push({ order, relation_id: relId, from_entity: rel.from_entity, to_entity: rel.to_entity });
  }
  return steps;
}

async function writeTraceStructure(
  runner: Runner,
  ns: string,
  args: {
    tid: string;
    actor_entity: string | null;
    outcome_entity: string | null;
    alternative_entities: string[];
  },
): Promise<void> {
  const { tid } = args;
  if (args.actor_entity !== null)
    await runner.createEdges(ns, L_ENTITY, L_TRACE, [[R_MADE_DECISION, args.actor_entity, tid, { ns }]]);
  const outcome: EdgeWrite[] = args.outcome_entity === null ? [] : [[R_RESULTED_IN, tid, args.outcome_entity, { ns }]];
  const considered = args.alternative_entities.map((alt): EdgeWrite => [R_CONSIDERED, tid, alt, { ns }]);
  await runner.createEdges(ns, L_TRACE, L_ENTITY, [...outcome, ...considered]);
}

/**
 * Write the steps of a decision trace, the new step nodes before the stale ones are deleted.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param tid (string): the trace id.
 * @param steps (DecisionStep[]): the ordered steps to store.
 * @return (Promise<void>): resolves once the steps are stored.
 */
async function writeSteps(runner: Runner, ns: string, tid: string, steps: DecisionStep[]): Promise<void> {
  const keyed = steps.map((step) => [ids.stepId(tid, step.order), step] as const);
  const sids = keyed.map(([sid]) => sid);
  await runner.upsertNodes(
    ns,
    L_STEP,
    keyed.map(
      ([sid, step]): NodeRow => [
        sid,
        {
          id: sid,
          ns,
          relation_id: step.relation_id,
          order: step.order,
          from_entity: step.from_entity,
          to_entity: step.to_entity,
        },
      ],
    ),
  );
  const linked = new Set((await runner.childNodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP)).map(idOf));
  await runner.createEdges(
    ns,
    L_TRACE,
    L_STEP,
    keyed
      .filter(([sid]) => !linked.has(sid))
      .map(([sid, step]): EdgeWrite => [R_HAS_STEP, tid, sid, { ns, order: step.order }]),
  );
  await runner.deleteNodes(ns, L_STEP, [...linked].filter((sid) => !sids.includes(sid)).sort());
  const stored = new Map<string, string[]>();
  for (const edge of await edgesAt(runner, ns, { from_label: L_STEP, to_label: L_ENTITY }, "from_in", sids)) {
    stored.set(edge.from_id, [...(stored.get(edge.from_id) ?? []), `${edge.type}\u0000${edge.to_id}`]);
  }
  const wanted = new Map(
    keyed.map(([sid, step]) => [sid, [`${R_FROM}\u0000${step.from_entity}`, `${R_TO}\u0000${step.to_entity}`].sort()]),
  );
  const stale = sids.filter((sid) => !deepEqual((stored.get(sid) ?? []).sort(), wanted.get(sid)));
  for (const sid of stale.filter((s) => stored.has(s))) {
    for (const kind of [R_FROM, R_TO]) await runner.deleteEdgesTouchingByType(ns, L_STEP, sid, kind);
  }
  await runner.createEdges(
    ns,
    L_STEP,
    L_ENTITY,
    keyed
      .filter(([sid]) => stale.includes(sid))
      .flatMap(([sid, step]): EdgeWrite[] => [
        [R_FROM, sid, step.from_entity, { ns }],
        [R_TO, sid, step.to_entity, { ns }],
      ]),
  );
}

async function clearTraceStructure(runner: Runner, ns: string, tid: string): Promise<void> {
  for (const rtype of [R_MADE_DECISION, R_RESULTED_IN, R_CONSIDERED]) {
    await runner.deleteEdgesTouchingByType(ns, L_TRACE, tid, rtype);
  }
}

export interface UpsertTraceArgs {
  tid: string | null;
  title: string;
  step_rel_ids: readonly string[];
  actor_entity: string | null;
  summary: string | null;
  rationale: string | null;
  outcome_entity: string | null;
  alternative_entities: readonly string[];
  status: Status;
  event_time: Date | null;
  created_at: Date;
  create?: boolean;
}

/**
 * Report whether a stored trace has exactly the links its fields name: actor, outcome, alternatives, step ends.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param trace (DecisionTrace): the stored trace, with its steps.
 * @return (boolean): true when no link is missing, extra, or repeated.
 */
async function traceLinksIntact(runner: Runner, ns: string, trace: DecisionTrace): Promise<boolean> {
  const made = await edgesAt(runner, ns, { from_label: L_ENTITY, to_label: L_TRACE, type: R_MADE_DECISION }, "to_in", [
    trace.id,
  ]);
  const actors = made.map((e) => e.from_id).sort();
  if (!deepEqual(actors, trace.actor_entity === null ? [] : [trace.actor_entity])) return false;
  const named = trace.alternative_entities.map((alt) => `${R_CONSIDERED}\u0000${alt}`);
  if (trace.outcome_entity !== null) named.push(`${R_RESULTED_IN}\u0000${trace.outcome_entity}`);
  const out = await edgesAt(runner, ns, { from_label: L_TRACE, to_label: L_ENTITY }, "from_in", [trace.id]);
  if (!deepEqual(out.map((e) => `${e.type}\u0000${e.to_id}`).sort(), named.sort())) return false;
  return stepLinksIntact(runner, ns, trace);
}

/**
 * Report whether the steps of a stored trace have exactly the FROM and TO links their relations name.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param trace (DecisionTrace): the stored trace, with its steps.
 * @return (boolean): true when no step link is missing, extra, or repeated.
 */
async function stepLinksIntact(runner: Runner, ns: string, trace: DecisionTrace): Promise<boolean> {
  const sids = trace.steps.map((step) => ids.stepId(trace.id, step.order));
  const ends = await edgesAt(runner, ns, { from_label: L_STEP, to_label: L_ENTITY }, "from_in", sids);
  const expected = trace.steps.flatMap((step, k) => [
    `${R_FROM}\u0000${sids[k]}\u0000${step.from_entity}`,
    `${R_TO}\u0000${sids[k]}\u0000${step.to_entity}`,
  ]);
  return deepEqual(ends.map((e) => `${e.type}\u0000${e.from_id}\u0000${e.to_id}`).sort(), expected.sort());
}

/**
 * Insert-semantics upsert of a decision trace and its structure; an unchanged trace is a no-op.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (UpsertTraceArgs): the trace fields, ordered step relation ids, timestamp, and create, which throws ConflictError after every input is checked when the trace already exists.
 * @return (DecisionTrace): the stored trace.
 */
export async function upsertTrace(runner: Runner, ns: string, given: UpsertTraceArgs): Promise<DecisionTrace> {
  requireChoice("decision status", given.status, STATUSES);
  requireStr("decision title", given.title);
  const title = ids.normalizeText(given.title);
  if (given.actor_entity !== null) requireStr("decision actor_entity", given.actor_entity);
  requireOptionalText("decision summary", given.summary);
  requireOptionalText("decision rationale", given.rationale);
  requireList("decision steps", given.step_rel_ids);
  requireList("alternative_entities", given.alternative_entities);
  requireDatetime("event_time", given.event_time);
  validateOwnId("decision", given.tid);
  const args = {
    ...given,
    actor_entity: ids.canonicalId(given.actor_entity),
    outcome_entity: ids.canonicalId(given.outcome_entity),
  };
  const alternatives = dedupList(args.alternative_entities.map(ids.canonicalId));
  const tid = args.tid || ids.decisionId(args.actor_entity, title);
  await requireTraceRefs(runner, ns, { ...args, alternative_entities: alternatives });
  const steps = await resolveSteps(runner, ns, args.step_rel_ids);
  await runner.lockNode(ns, L_TRACE, tid);
  const existing = await getTrace(runner, ns, tid);
  if (args.create && existing !== null) throw new ConflictError("DecisionTrace", tid);
  if (
    existing !== null &&
    existing.title === title &&
    existing.actor_entity === args.actor_entity &&
    existing.summary === args.summary &&
    existing.rationale === args.rationale &&
    existing.status === args.status &&
    existing.outcome_entity === args.outcome_entity &&
    deepEqual(existing.alternative_entities, alternatives) &&
    toIso(existing.event_time) === toIso(args.event_time) &&
    deepEqual(
      existing.steps.map((s) => s.relation_id),
      steps.map((s) => s.relation_id),
    ) &&
    (await traceLinksIntact(runner, ns, existing))
  ) {
    return existing;
  }
  const props = encodeTraceProps({
    ns,
    id: tid,
    title,
    actor_entity: args.actor_entity,
    summary: args.summary,
    rationale: args.rationale,
    status: args.status,
    outcome_entity: args.outcome_entity,
    alternative_entities: alternatives,
    event_time: args.event_time,
    created_at: existing !== null ? existing.created_at : args.created_at,
    updated_at: args.created_at,
  });
  precheckNodes(runner, ns, L_TRACE, [[tid, props]]);
  const keepSteps =
    existing !== null &&
    deepEqual(
      existing.steps.map((s) => s.relation_id),
      steps.map((s) => s.relation_id),
    ) &&
    (await stepLinksIntact(runner, ns, existing));
  if (existing !== null) await clearTraceStructure(runner, ns, tid);
  await runner.upsertNode(ns, L_TRACE, tid, props);
  await writeTraceStructure(runner, ns, {
    tid,
    actor_entity: args.actor_entity,
    outcome_entity: args.outcome_entity,
    alternative_entities: alternatives,
  });
  if (!keepSteps) await writeSteps(runner, ns, tid, steps);
  return decodeTrace(props, steps);
}

export interface CreateTraceArgs {
  title: string;
  steps: readonly string[];
  id?: string | null;
  actor_entity?: string | null;
  summary?: string | null;
  rationale?: string | null;
  outcome_entity?: string | null;
  alternative_entities: readonly string[];
  status: Status;
  event_time?: Date | null;
}

/**
 * Create one decision trace, failing if its id already exists.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (CreateTraceArgs): the trace fields.
 * @return (DecisionTrace): the created trace.
 */
export async function createTrace(runner: Runner, ns: string, args: CreateTraceArgs): Promise<DecisionTrace> {
  requireStr("decision title", args.title);
  const actor = args.actor_entity ?? null;
  if (actor !== null) requireStr("decision actor_entity", actor);
  validateOwnId("decision", args.id);
  return upsertTrace(runner, ns, {
    tid: args.id ?? null,
    title: args.title,
    step_rel_ids: args.steps,
    actor_entity: actor,
    summary: args.summary ?? null,
    rationale: args.rationale ?? null,
    outcome_entity: args.outcome_entity ?? null,
    alternative_entities: args.alternative_entities,
    status: args.status,
    event_time: args.event_time ?? null,
    created_at: new Date(),
    create: true,
  });
}

export interface UpdateTraceFields {
  title?: string;
  steps?: readonly string[];
  actor_entity?: string | null;
  summary?: string | null;
  rationale?: string | null;
  outcome_entity?: string | null;
  alternative_entities?: readonly string[];
  status?: Status;
  event_time?: Date | null;
  clear?: readonly string[];
}

/**
 * Update a decision trace in place, rewriting its structure; omitted fields keep their value and null clears one.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param tid (string): the trace id.
 * @param fields (UpdateTraceFields): the fields to change.
 * @return (DecisionTrace): the updated trace.
 */
export async function updateTrace(
  runner: Runner,
  ns: string,
  tid: string,
  fields: UpdateTraceFields,
): Promise<DecisionTrace> {
  checkOptions("decisions.update", fields, DECISION_UPDATE_FIELDS);
  const cleared = requireClear("decisions.update", fields.clear ?? [], DECISION_CLEARABLE, { ...fields });
  requireChanges({ ...fields, clear: cleared.size ? cleared : undefined });
  await runner.lockNode(ns, L_TRACE, tid);
  const existing = await getTrace(runner, ns, tid);
  if (existing === null) throw new NotFoundError("DecisionTrace", tid, undefined, { namespace: ns });
  const pick = <K extends keyof UpdateTraceFields>(key: K, fallback: Exclude<UpdateTraceFields[K], undefined>) =>
    cleared.has(key)
      ? ((LIST_FIELDS.includes(key) ? [] : null) as Exclude<UpdateTraceFields[K], undefined>)
      : fields[key] !== undefined
        ? (fields[key] as Exclude<UpdateTraceFields[K], undefined>)
        : fallback;
  return upsertTrace(runner, ns, {
    tid,
    title: pick("title", existing.title),
    step_rel_ids: pick(
      "steps",
      existing.steps.map((s) => s.relation_id),
    ),
    actor_entity: pick("actor_entity", existing.actor_entity),
    summary: pick("summary", existing.summary),
    rationale: pick("rationale", existing.rationale),
    outcome_entity: pick("outcome_entity", existing.outcome_entity),
    alternative_entities: pick("alternative_entities", existing.alternative_entities),
    status: pick("status", existing.status),
    event_time: pick("event_time", existing.event_time),
    created_at: new Date(),
  });
}

export async function listTraces(
  runner: Runner,
  ns: string,
  args: {
    actor_entity?: string | null;
    status?: Status | null;
    skip: number;
    limit: number;
    after?: string | null;
  },
): Promise<DecisionTrace[]> {
  requireOptionalText("actor_entity filter", args.actor_entity);
  requireOptionalText("status filter", args.status);
  if (args.status != null) requireChoice("decision status", args.status, STATUSES);
  const equals: Props = {};
  if (args.actor_entity != null) equals.actor_entity = ids.canonicalId(args.actor_entity);
  if (args.status != null) equals.status = args.status;
  const rows = await runner.matchNodes(ns, L_TRACE, { equals, skip: args.skip, limit: args.limit, id_gt: args.after });
  return decodeTraces(runner, ns, rows);
}

export async function deleteTrace(runner: Runner, ns: string, tid: string): Promise<DeleteResult> {
  requireStr("decision id", tid);
  if (!(await deleteTraceQuietly(runner, ns, tid))) {
    throw new NotFoundError("DecisionTrace", tid, undefined, { namespace: ns });
  }
  return { ...NO_DELETES, deleted_decisions: 1 };
}
