import { ConflictError, NotFoundError, TransientError, ValidationError } from "./errors.js";
import * as ids from "./ids.js";
import { casefold } from "./internal/casefold.js";
import { dumps, loads } from "./internal/json.js";
import { comparePy, deepEqual, isPlainObject, pyRepr, pyStrip, utf8 } from "./internal/py.js";
import { epochMicros, jsonIso, toIso } from "./internal/time.js";
import {
  childEdgeId,
  EDGE_TYPES,
  L_ENTITY,
  L_EVIDENCE,
  L_MERGE,
  L_PROFILE,
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
import type { SchemaSubject } from "./schema.js";
import {
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
  requireDatetime,
  requireInt,
  requireJsonMapping,
  requireList,
  requireOptionalText,
  requireStr,
  requireStrMapping,
  requireUnit,
  typeName,
} from "./validate.js";

type Runner = GraphPrimitives;
export type SchemaCheck = (runner: Runner, subject: SchemaSubject, before?: SchemaSubject) => Promise<void>;

export const NO_DELETES: Readonly<DeleteResult> = Object.freeze({
  deleted_entities: 0,
  deleted_relation_versions: 0,
  deleted_decisions: 0,
  deleted_preference_versions: 0,
});

const RESERVED_LABELS = new Set(LABELS.map((t) => t.toLowerCase()));
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
  const expected = ids.slug(ids.normalizeText(type));
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
  if (RESERVED_LABELS.has(pyStrip(type).toLowerCase())) {
    throw new ValidationError(`entity type ${pyRepr(type)} is reserved for internal use; choose another type`);
  }
  if (type.includes("`")) throw new ValidationError("entity type cannot contain a backtick");
  if (type.includes(":")) {
    throw new ValidationError(
      `entity type ${pyRepr(type)} cannot contain ':', which separates an entity id's type and name`,
    );
  }
  if (hasControl(name) || hasControl(type)) {
    throw new ValidationError("entity type and name cannot contain control or surrogate characters");
  }
  if (!/^[\p{L}\p{N} _.-]*$/u.test(type)) {
    throw new ValidationError(
      `entity type ${pyRepr(type)} can only contain letters, digits, spaces, '_', '-', and '.'`,
    );
  }
  if (hasControl(eid)) throw new ValidationError("entity id cannot contain control or surrogate characters");
  ids.requireEntityShape(eid);
  const prefix = eid.slice(0, eid.indexOf(":"));
  if (ids.RESERVED_ID_PREFIXES.has(prefix.toLowerCase())) {
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
  const prefix = sep >= 0 ? oid.slice(0, sep).toLowerCase() : "";
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
 * Split a list into consecutive batches of at most BATCH items.
 *
 * @param items (readonly T[]): the items to split.
 * @return (T[][]): the batches, in order.
 */
export function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
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
async function nodesWhere(
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

/**
 * Find which evidence records are not stored yet and how many distinct sources each target gains.
 *
 * Records are looked up by id first; only a target missing a record is then checked for any record from that
 * source. A target with no stored version has no stored evidence, so targets in newTargets skip both lookups.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param items (ReadonlyArray<readonly [string, Evidence]>): (target id, evidence) pairs to record.
 * @param newTargets (ReadonlySet<string>): targets known to have no stored evidence.
 * @return ([NodeRow[], Map<string, number>]): the records to write, and the sources gained per target.
 */
async function planEvidence(
  runner: Runner,
  ns: string,
  items: ReadonlyArray<readonly [string, Evidence]>,
  newTargets: ReadonlySet<string>,
): Promise<[NodeRow[], Map<string, number>]> {
  const pending = new Map<string, readonly [string, Evidence]>();
  for (const [target, ev] of items) {
    const evid = ids.evidenceId(target, ev);
    if (!pending.has(evid)) pending.set(evid, [target, ev]);
  }
  const known = [...pending].filter(([, [target]]) => !newTargets.has(target)).map(([evid]) => evid);
  const stored = new Set((await nodesById(runner, ns, L_EVIDENCE, known)).keys());
  const bySource = new Map<string, Set<string>>();
  for (const evid of known) {
    if (stored.has(evid)) continue;
    const [target, ev] = pending.get(evid)!;
    const targets = bySource.get(ev.source_id) ?? new Set<string>();
    bySource.set(ev.source_id, targets.add(target));
  }
  const seen = new Set<string>();
  const pair = (target: string, sourceId: string): string => JSON.stringify([target, sourceId]);
  for (const [sourceId, targets] of bySource) {
    for (const props of await nodesWhere(runner, ns, L_EVIDENCE, "target_id", [...targets], { source_id: sourceId }))
      seen.add(pair(props.target_id as string, sourceId));
  }
  const records: NodeRow[] = [];
  const gained = new Map<string, number>();
  for (const [evid, [target, ev]] of pending) {
    if (stored.has(evid)) continue;
    records.push([evid, encodeEvidenceProps({ ns, id: evid, target_id: target, evidence: ev })]);
    if (!seen.has(pair(target, ev.source_id))) {
      seen.add(pair(target, ev.source_id));
      gained.set(target, (gained.get(target) ?? 0) + 1);
    }
  }
  return [records, gained];
}

async function writeEvidence(runner: Runner, ns: string, records: readonly NodeRow[]): Promise<void> {
  if (records.length) await runner.upsertNodes(ns, L_EVIDENCE, records);
}

/**
 * Take and remove a target's gained source count, so it applies to the first input naming the target.
 *
 * @param gained (Map<string, number>): sources gained per target.
 * @param target (string): the entity or relation id.
 * @return (number): the sources gained, or 0 once taken.
 */
function takeGained(gained: Map<string, number>, target: string): number {
  const n = gained.get(target) ?? 0;
  gained.delete(target);
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
  if (!rows.length && skip === 0) {
    const exists =
      kind === "entity" ? await runner.nodeExists(ns, L_ENTITY, targetId) : await relationExists(runner, ns, targetId);
    if (!exists) throw new NotFoundError(kind === "entity" ? "Entity" : "Relation", targetId);
  }
  return rows.map(decodeEvidence);
}

export async function deleteEvidence(runner: Runner, ns: string, targetId: string): Promise<void> {
  await runner.deleteNodesBy(ns, L_EVIDENCE, { target_id: targetId });
}

export const precheckWrite = (runner: Runner, props: Props): void => runner.checkDocSize?.(props);

async function entityKnown(runner: Runner, ns: string, eid: unknown, known: Set<string>): Promise<boolean> {
  if (typeof eid !== "string") throw new ValidationError(`entity reference must be a string id, got ${typeName(eid)}`);
  if (hasControl(eid)) throw new ValidationError("entity reference cannot contain control or surrogate characters");
  return known.has(eid) || (await runner.nodeExists(ns, L_ENTITY, eid));
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
    throw new ValidationError(`${context} references unknown entity ${pyRepr(eid)}`);
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

  for (const rel of facts.relations) {
    validateOwnId("relation", rel.id);
    requireDatetime("relation event_time", rel.event_time);
    rejectReservedRelType(ids.normalizeRelType(rel.type), rel.type);
    if (!Array.isArray(rel.evidence))
      throw new ValidationError(`relation evidence must be a list, got ${typeName(rel.evidence)}`);
    for (const ev of rel.evidence) requireCleanEvidence(ev);
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
      throw new ValidationError(`preference references unknown subject entity ${pyRepr(pref.subject_entity)}`);
    }
    await requirePreferenceRefs(runner, ns, pref, entities);
  }

  for (const dec of facts.decisions) {
    validateOwnId("decision", dec.id);
    requireDatetime("decision event_time", dec.event_time);
    requireChoice("decision status", dec.status, STATUSES);
    requireStr("decision title", dec.title);
    requireOptionalText("decision summary", dec.summary);
    requireOptionalText("decision rationale", dec.rationale);
    requireList("decision steps", dec.steps);
    requireList("decision alternative_entities", dec.alternative_entities);
    for (const relId of dec.steps) {
      if (!relations.has(relId) && !(await relationExists(runner, ns, relId))) {
        throw new ValidationError(`decision step references unknown relation ${pyRepr(relId)}`);
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

/**
 * Insert-semantics upsert of many entities: keep stored names, record new surface forms as aliases, merge the rest.
 *
 * Entities are read and written in batches; a repeated id merges into the earlier input, as sequential upserts would.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param ents (readonly ParsedEntityInput[]): the entities to upsert, in order.
 * @param evidence (Evidence[]): evidence recorded for every entity.
 * @param createdAt (Date): the timestamp for the created and updated fields.
 * @return (Entity[]): each input's stored entity, in input order.
 */
export async function upsertEntities(
  runner: Runner,
  ns: string,
  ents: readonly ParsedEntityInput[],
  evidence: Evidence[],
  createdAt: Date,
): Promise<Entity[]> {
  const keyed = ents.map((ent) => {
    const etype = cleanText(ent.type);
    const ename = cleanText(ent.name);
    const eid = ent.id || ids.entityId(etype, ename);
    validateEntityIdentity(eid, etype, ename);
    return { eid, etype, ename, ent };
  });
  const eids = dedupList(keyed.map((k) => k.eid));
  for (const eid of eids) await runner.lockNode(ns, L_ENTITY, eid);
  const stored = new Map<string, Entity>();
  for (const [eid, props] of await nodesById(runner, ns, L_ENTITY, eids)) stored.set(eid, decodeEntity(props));
  const [records, gained] = await planEvidence(
    runner,
    ns,
    eids.flatMap((eid) => evidence.map((ev) => [eid, ev] as const)),
    new Set(eids.filter((eid) => !stored.has(eid))),
  );

  const current = new Map(stored);
  const writes = new Map<string, Props>();
  const out: Entity[] = [];
  for (const { eid, etype, ename, ent } of keyed) {
    const prev = current.get(eid);
    const sources = (prev?.source_count ?? 0) + takeGained(gained, eid);
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

  for (const props of writes.values()) precheckWrite(runner, props);
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
  for (const [etype, rows] of byType) await runner.upsertNodes(ns, L_ENTITY, rows, { extra_label: etype });
  await writeEvidence(runner, ns, records);
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
  if (existing === null) throw new NotFoundError("Entity", eid);
  for (const key of ["aliases", "remove_aliases", "remove_properties"] as const) {
    if (fields[key] !== undefined) requireList(key, fields[key]);
  }
  if (fields.properties !== undefined) requireJsonMapping("properties", fields.properties);
  if (fields.external_ids !== undefined) requireStrMapping("external_ids", fields.external_ids);
  if (fields.type !== undefined) requireStr("entity type", fields.type);
  if (fields.name !== undefined) requireStr("entity name", fields.name);
  await runner.lockNode(ns, L_ENTITY, eid);
  existing = await getEntity(runner, ns, eid);
  if (existing === null) throw new TransientError(`entity ${pyRepr(eid)} was changed concurrently; retry`);
  let type = fields.type !== undefined ? cleanText(fields.type) : existing.type;
  if (ids.slug(type) !== ids.slug(ids.normalizeText(existing.type))) {
    throw new ValidationError(`type is part of the id ${pyRepr(eid)}; create a new entity to change its type`);
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
  precheckWrite(runner, props);
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
  const key = (etype: string): string => {
    const clean = cleanText(etype);
    return casefold(args.canonical ? args.canonical(clean) : clean);
  };
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

async function deleteSteps(runner: Runner, ns: string, tid: string): Promise<void> {
  for (const step of await runner.childNodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP)) {
    await runner.deleteNode(ns, L_STEP, idOf(step));
  }
}

export async function deleteTraceQuietly(runner: Runner, ns: string, tid: string): Promise<boolean> {
  if (!(await runner.nodeExists(ns, L_TRACE, tid))) return false;
  await deleteSteps(runner, ns, tid);
  await runner.deleteNode(ns, L_TRACE, tid);
  return true;
}

async function deleteTraces(runner: Runner, ns: string, tids: Iterable<string>): Promise<number> {
  let deleted = 0;
  for (const tid of tids) if (await deleteTraceQuietly(runner, ns, tid)) deleted += 1;
  return deleted;
}

/**
 * Find decision traces that use any of some relations as one of their steps.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rids (readonly string[]): the relation ids.
 * @return (Set<string>): the owning trace ids.
 */
export async function tracesTouchingRelations(
  runner: Runner,
  ns: string,
  rids: readonly string[],
): Promise<Set<string>> {
  const steps = await nodesWhere(runner, ns, L_STEP, "relation_id", rids);
  return new Set(steps.map((step) => ids.traceOfStep(idOf(step))));
}

/**
 * Find decision traces that reference any of some entities as actor, outcome, or step endpoint.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param eids (readonly string[]): the entity ids.
 * @return (Set<string>): the referencing trace ids.
 */
async function tracesTouchingEntities(runner: Runner, ns: string, eids: readonly string[]): Promise<Set<string>> {
  const tids = new Set<string>();
  const lookups: Array<[string, string[]]> = [
    [L_TRACE, ["actor_entity", "outcome_entity"]],
    [L_STEP, ["from_entity", "to_entity"]],
  ];
  for (const [label, keys] of lookups) {
    for (const key of keys) {
      for (const node of await nodesWhere(runner, ns, label, key, eids)) {
        tids.add(label === L_TRACE ? idOf(node) : ids.traceOfStep(idOf(node)));
      }
    }
  }
  return tids;
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
 * @return (DeleteResult): counts of what was removed.
 */
export async function deleteEntity(runner: Runner, ns: string, given: string): Promise<DeleteResult> {
  const eid = ids.canonicalEntityId(given);
  if (!(await runner.nodeExists(ns, L_ENTITY, eid))) throw new NotFoundError("Entity", eid);
  return deleteEntities(runner, ns, [eid]);
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
async function edgesAt(
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
 * Delete many entities and everything attached to them, reading and deleting in batches.
 *
 * The result matches deleting them one by one: their relations with every version and the relations' evidence,
 * decisions that reference an entity or use one of those relations as a step, their profiles and the preferences
 * pointing at them, their evidence, and the merge records they survived or were absorbed in. A considered
 * alternative is dropped from a decision that is kept, and a kept preference about a deleted entity loses its
 * about_entity in a new version. Ids that are not stored are skipped.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param given (readonly string[]): the canonical entity ids.
 * @return (DeleteResult): counts of what was removed.
 */
export async function deleteEntities(runner: Runner, ns: string, given: readonly string[]): Promise<DeleteResult> {
  const counts = { ...NO_DELETES };
  const eids = [...(await nodesById(runner, ns, L_ENTITY, dedupList(given))).keys()];
  if (!eids.length) return counts;
  const doomed = new Set(eids);
  const seen = new Map<string, string>();
  for (const side of ["from_in", "to_in"] as const) {
    for (const edge of await edgesAt(runner, ns, { from_label: L_ENTITY, to_label: L_ENTITY }, side, eids)) {
      if (isRelationType(edge.type)) seen.set(JSON.stringify([idOf(edge.props), revisionOf(edge)]), idOf(edge.props));
    }
  }
  const rids = dedupList([...seen.values()]);
  counts.deleted_relation_versions = seen.size;
  const traceIds = await tracesTouchingEntities(runner, ns, eids);
  for (const tid of await tracesTouchingRelations(runner, ns, rids)) traceIds.add(tid);
  counts.deleted_decisions = await deleteTraces(runner, ns, [...traceIds].sort(comparePy));
  const alternatives = [...(await tracesWithAlternatives(runner, ns, eids))].sort(([a], [b]) => comparePy(a, b));
  for (const [tid, alts] of alternatives) {
    if (!traceIds.has(tid)) await pruneTraceAlternatives(runner, ns, tid, alts);
  }

  const profiles = [...(await nodesById(runner, ns, L_PROFILE, eids.map(ids.profileId))).keys()];
  const goneProfiles = new Set(profiles);
  counts.deleted_preference_versions = (
    await edgesAt(runner, ns, { from_label: L_PROFILE }, "from_in", profiles)
  ).length;
  for (const pref of await preferencesAbout(runner, ns, doomed)) {
    if (!doomed.has(pref.to_id) && !goneProfiles.has(pref.from_id)) {
      await updatePreference(runner, ns, idOf(pref.props), {
        properties: null,
        remove_properties: [],
        clear: ["about_entity"],
      });
    }
  }
  for (const edge of await edgesAt(runner, ns, { from_label: L_PROFILE, to_label: L_ENTITY }, "to_in", eids)) {
    if (PREFERENCE_EDGE_TYPES.includes(edge.type) && !goneProfiles.has(edge.from_id)) {
      counts.deleted_preference_versions += 1;
    }
  }
  for (const batch of batches(profiles)) await runner.deleteNodes(ns, L_PROFILE, batch);
  await deleteNodesWhere(runner, ns, L_EVIDENCE, "target_id", rids);
  for (const batch of batches(eids)) await runner.deleteNodes(ns, L_ENTITY, batch);
  await deleteNodesWhere(runner, ns, L_EVIDENCE, "target_id", eids);
  for (const side of ["survivor_id", "absorbed_id"]) await deleteNodesWhere(runner, ns, L_MERGE, side, eids);
  counts.deleted_entities = eids.length;
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
 * @return (DeleteResult): counts of what was removed.
 */
export async function deleteRelations(runner: Runner, ns: string, rids: readonly string[]): Promise<DeleteResult> {
  const counts = { ...NO_DELETES };
  for (const rid of rids) {
    if (!(await relationExists(runner, ns, rid))) continue;
    addCounts(counts, await deleteRelation(runner, ns, rid));
  }
  return counts;
}

const isRelationType = (rtype: string): boolean => !EDGE_TYPES.has(rtype);

type RelationEnds = Pick<Relation, "from_entity" | "type" | "to_entity">;

const relationOf = (e: EdgeRow): Relation =>
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

/**
 * Write a relation version as the current one, retiring the previous current version when there is one.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param ends (RelationEnds): the endpoints and type.
 * @param props (Props): the encoded version.
 * @param retire (boolean): true when an existing current version must be flipped first.
 * @return (Relation): the written version.
 */
async function writeRelationVersion(
  runner: Runner,
  ns: string,
  ends: RelationEnds,
  props: Props,
  retire: boolean,
): Promise<Relation> {
  if (retire) {
    precheckWrite(runner, props);
    await runner.updateCurrentEdge(ns, idOf(props), { is_current: false });
  }
  rejectReservedRelType(ends.type, ends.type);
  if (!(await runner.createEdge(ns, ends.type, L_ENTITY, ends.from_entity, L_ENTITY, ends.to_entity, props))) {
    const hint = "create the entities first, then reference them by id ('type:name')";
    await requireEndpoints(runner, ns, ends.from_entity, ends.to_entity, hint);
    throw new ValidationError(
      `relation endpoints not found (from=${pyRepr(ends.from_entity)}, to=${pyRepr(ends.to_entity)}); ${hint}`,
    );
  }
  return decodeRelation(props, ends);
}

const revisionOf = (e: EdgeRow): number => Math.trunc(Number(e.props.revision));

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
 *
 * A derived relation id fixes its endpoints, so its stored versions are among its source entity's relations; an
 * explicit id may name a relation between other entities, so one not found that way is looked up by id. Only
 * source entities with a relation not found current are read again across all versions, so an insert of new
 * relations from new entities costs one query.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param keyed (ReadonlyArray<readonly [string, Pick<ParsedRelationInput, "id" | "from_entity">]>): (relation id, input) pairs.
 * @return (Map<string, EdgeRow>): each found relation's current edge row, else its newest edge row, by id.
 */
export async function currentRelations(
  runner: Runner,
  ns: string,
  keyed: ReadonlyArray<readonly [string, Pick<ParsedRelationInput, "id" | "from_entity">]>,
): Promise<Map<string, EdgeRow>> {
  const wanted = new Set(keyed.map(([rid]) => rid));
  const found = new Map<string, EdgeRow>();
  for (const currentOnly of [true, false]) {
    const pending = dedupList(keyed.filter(([rid]) => !found.has(rid)).map(([, rel]) => rel.from_entity));
    const filter = { from_label: L_ENTITY, to_label: L_ENTITY, current_only: currentOnly };
    for (const edge of await edgesAt(runner, ns, filter, "from_in", pending)) {
      if (wanted.has(idOf(edge.props)) && isRelationType(edge.type)) keepNewest(found, edge);
    }
    for (const rid of found.keys()) wanted.delete(rid);
  }
  for (const [rid, rel] of keyed) {
    if (!rel.id || found.has(rid)) continue;
    const edge = newestEdge(await typedEdgeVersions(runner, ns, rid, isRelationType));
    if (edge !== null) found.set(rid, edge);
  }
  return found;
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

type Slot = readonly [string, string, string];
type Rank = readonly [number, number, number];

/**
 * Order a relation among others at one endpoint: by effective time, then revision, then creation time.
 *
 * @param rel (Relation): the relation version.
 * @return (Rank): the sort key, newer last.
 */
const rankOf = (rel: Relation): Rank => [epochMicros(effectiveTime(rel)), rel.revision, epochMicros(rel.created_at)];

/**
 * Compare two (rank, id) pairs, older first.
 *
 * @param a (readonly [Rank, string]): the first pair.
 * @param b (readonly [Rank, string]): the second pair.
 * @return (number): negative, zero, or positive.
 */
function compareRanked(a: readonly [Rank, string], b: readonly [Rank, string]): number {
  for (let i = 0; i < 3; i++) if (a[0][i] !== b[0][i]) return a[0][i]! - b[0][i]!;
  return comparePy(a[1], b[1]);
}

export class Contradictions {
  private readonly groups = new Map<string, Map<string, Rank>>();
  private readonly past = new Map<string, Map<string, Rank>>();
  private readonly where = new Map<string, Set<string>>();
  private readonly times = new Map<string, Date>();
  private readonly order = new Map<string, number>();
  private readonly dirty = new Map<string, number>();

  /**
   * Track the current relations at every endpoint a schema max_count constrains.
   *
   * @param caps (ReadonlyMap<string, RelationCap>): the max_count limits by normalized relation type and alias.
   * @param mode (string): "warn" keeps both relations of a conflict, "supersede" retires the older ones, "strict" throws ValidationError.
   * @param current (Iterable<Relation>): the stored current relations at the constrained endpoints.
   * @param history (Iterable<Relation>): the newest version of each relation a contradiction retired there.
   */
  constructor(
    private readonly caps: ReadonlyMap<string, RelationCap>,
    private readonly mode: string,
    current: Iterable<Relation>,
    history: Iterable<Relation> = [],
  ) {
    for (const rel of history) {
      this.times.set(rel.id, effectiveTime(rel));
      for (const [slot] of this.slots(rel.type, rel.from_entity, rel.to_entity)) {
        const key = JSON.stringify(slot);
        this.past.set(key, (this.past.get(key) ?? new Map<string, Rank>()).set(rel.id, rankOf(rel)));
      }
    }
    for (const rel of current) {
      for (const [slot] of this.slots(rel.type, rel.from_entity, rel.to_entity)) {
        this.seat(slot, rel.id, rankOf(rel), effectiveTime(rel));
      }
    }
  }

  /**
   * List the constrained endpoint groups a relation belongs to, with each group's max_count.
   *
   * @param rtype (string): the normalized relation type.
   * @param fromEntity (string): the source entity id.
   * @param toEntity (string): the destination entity id.
   * @return (Array<[Slot, number]>): ((canonical type, side, endpoint), max_count) pairs.
   */
  private slots(rtype: string, fromEntity: string, toEntity: string): Array<[Slot, number]> {
    const cap = this.caps.get(rtype);
    if (cap === undefined) return [];
    return cap.limits.map(([side, limit]) => [[cap.canonical, side, side === "from" ? fromEntity : toEntity], limit]);
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
   * A conflict is more than max_count current relations of one type at one endpoint. In warn mode both are kept
   * and a "contradiction" warning names the others. In strict mode the conflict throws ValidationError. In
   * supersede mode the endpoint is resolved by settle once the whole write is admitted.
   *
   * @param rid (string): the relation id.
   * @param rtype (string): the normalized relation type.
   * @param fromEntity (string): the source entity id.
   * @param toEntity (string): the destination entity id.
   * @param rank (Rank): the relation's rank, from rankOf.
   * @param effective (Date): the relation's effective time.
   * @return (InsertWarning[]): the warn-mode contradiction warnings.
   */
  admit(
    rid: string,
    rtype: string,
    fromEntity: string,
    toEntity: string,
    rank: Rank,
    effective: Date,
  ): InsertWarning[] {
    const warnings: InsertWarning[] = [];
    const slots = this.slots(rtype, fromEntity, toEntity);
    for (const [slot, limit] of slots) {
      const key = JSON.stringify(slot);
      const group = this.groups.get(key) ?? new Map<string, Rank>();
      if (this.mode === "supersede") {
        this.dirty.set(key, limit);
        continue;
      }
      if (group.has(rid) || group.size + 1 <= limit) continue;
      const [canonical, side, endpoint] = slot;
      const others = [...group.keys()].join(", ");
      if (this.mode === "strict") {
        throw new ValidationError(
          `relation ${rid} would exceed max_count ${limit} for ${canonical} at ${side} entity ${endpoint} ` +
            `(current: ${others}); schema_mode 'strict' rejects it; use contradiction='supersede' to ` +
            "retire the older relation instead",
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
   * then creation time, and all but the newest max_count are retired. A retired relation is invalidated by the fact
   * that displaced it in time order, the max_count-th newer fact at the endpoint with retired history counted, at
   * that fact's effective time. Each retired relation gets one warning: "contradiction_out_of_order" when it was
   * written by this write after that fact was current, else "relation_superseded".
   *
   * @return ([Map<string, [string, Date]>, InsertWarning[]]): each retired relation id with the id that invalidated it and when, and the warnings.
   */
  settle(): [Map<string, [string, Date]>, InsertWarning[]] {
    const retired = new Map<string, [string, Date]>();
    const warnings: InsertWarning[] = [];
    for (const [key, limit] of this.dirty) {
      const group = this.groups.get(key) ?? new Map<string, Rank>();
      const ranked = [...group.keys()].sort((a, b) => compareRanked([group.get(b)!, b], [group.get(a)!, a]));
      const [canonical, side, endpoint] = JSON.parse(key) as [string, string, string];
      for (const old of ranked.slice(limit)) {
        const facts = new Map([...(this.past.get(key) ?? []), ...group]);
        const mine: [Rank, string] = [facts.get(old)!, old];
        const newer = [...facts]
          .map(([o, r]) => [r, o] as [Rank, string])
          .filter((pair) => compareRanked(pair, mine) > 0)
          .sort(compareRanked);
        const by = newer[limit - 1]![1];
        retired.set(old, [by, this.times.get(by)!]);
        this.drop(old);
        if ((this.order.get(by) ?? 0) < (this.order.get(old) ?? 0)) {
          const keeper = ranked[limit - 1]!;
          warnings.push(
            insertWarning(
              "contradiction_out_of_order",
              `relation ${old} is older than current ${canonical} relation ${keeper} at ${side} entity ${endpoint}, ` +
                `so ${keeper} stays current`,
            ),
          );
        } else {
          warnings.push(
            insertWarning(
              "relation_superseded",
              `relation ${old} was superseded by ${by}, a newer ${canonical} relation at ${side} entity ${endpoint} ` +
                `(max_count ${limit})`,
            ),
          );
        }
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
 * @return ([Map<string, EdgeRow>, Relation[]]): each current relation's edge row by id, in read order, and the newest version of each relation a contradiction retired there.
 */
async function constrainedCurrent(
  runner: Runner,
  ns: string,
  caps: ReadonlyMap<string, RelationCap>,
  ends: Iterable<readonly [string, string, string]>,
): Promise<[Map<string, EdgeRow>, Relation[]]> {
  const found = new Map<string, EdgeRow>();
  const seen = new Set<string>();
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
        for (const edge of await allEdges(runner, ns, filter)) keepNewest(found, edge);
      }
    }
  }
  const rows = [...found.values()];
  return [
    new Map(rows.filter((e) => e.props.is_current).map((e) => [idOf(e.props), e])),
    rows.filter((e) => !e.props.is_current && e.props.invalidated_at).map(relationOf),
  ];
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
 */
export async function requireMaxCount(
  runner: Runner,
  ns: string,
  caps: ReadonlyMap<string, RelationCap> | null,
  relations: readonly ParsedRelationInput[],
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
  const at = new Date();
  const rank: Rank = [epochMicros(at), 0, epochMicros(at)];
  for (const { rid, rtype, rel } of tracker ? keyed : [])
    tracker!.admit(rid, rtype, rel.from_entity, rel.to_entity, rank, at);
}

/**
 * Mark a relation version as no longer current because a newer relation superseded it.
 *
 * @param edge (EdgeRow): the current edge row.
 * @param by (string): the id of the relation that superseded it.
 * @param at (Date): the superseding relation's effective time.
 * @return (EdgeRow): the edge row with its version retired.
 */
function retiredEdge(edge: EdgeRow, by: string, at: Date): EdgeRow {
  return { ...edge, props: { ...edge.props, is_current: false, invalidated_at: toIso(at), invalidated_by: by } };
}

export interface ContradictionOptions {
  contradiction?: string;
  caps?: ReadonlyMap<string, RelationCap> | null;
  warnings?: InsertWarning[];
}

/**
 * Prepare the contradiction check for a write, reading the current relations it can conflict with.
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
  const [existing, history] = await constrainedCurrent(runner, ns, caps, ends);
  return [new Contradictions(caps, contradiction, [...existing.values()].map(relationOf), history), existing];
}

/**
 * Insert-semantics upsert of many relations: merge properties, versioning on change, recording evidence.
 *
 * Relations are read and written in batches; a repeated id applies after the earlier input, as sequential
 * upserts would. A relation invalidated by a contradiction is reasserted, as a new current revision, by an input
 * whose effective time is at or after its invalidation; an earlier input restates history and leaves it retired.
 * A superseded relation is retired in place: its version keeps its revision and gains invalidated_at and
 * invalidated_by, so the version list shows exactly the writes that happened. In supersede mode each constrained
 * endpoint the batch touches is settled once after the whole batch (see Contradictions.settle): an input older than
 * the relations it conflicts with is written already invalidated. New versions are written before any retirement,
 * so a failed write never leaves an endpoint without its current relation.
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
  const keyed = items.map(([rel, evidence]) => {
    validateOwnId("relation", rel.id);
    const rtype = ids.normalizeRelType(rel.type);
    rejectReservedRelType(rtype, rtype);
    return { rid: rel.id || ids.relationId(rel.from_entity, rtype, rel.to_entity), rtype, rel, evidence };
  });
  for (const from of new Set(keyed.map((k) => k.rel.from_entity))) await runner.lockNode(ns, L_ENTITY, from);
  const rids = dedupList(keyed.map((k) => k.rid));
  const stored = await currentRelations(
    runner,
    ns,
    keyed.map((k) => [k.rid, k.rel] as const),
  );
  const [records, gained] = await planEvidence(
    runner,
    ns,
    keyed.flatMap((k) => k.evidence.map((ev) => [k.rid, ev] as const)),
    new Set(rids.filter((rid) => !stored.has(rid))),
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
  for (const { rid, rtype, rel } of keyed) {
    const eventTime = rel.event_time || defaultEventTime;
    const effective = eventTime ?? createdAt;
    let edge = current.get(rid);
    let props: Props;
    let write = true;
    if (edge === undefined) {
      props = encodeRelationProps({
        ns,
        id: rid,
        revision: 1,
        properties: mergeProps(null, rel.properties),
        event_time: eventTime,
        created_at: createdAt,
        is_current: true,
        source_count: takeGained(gained, rid),
      });
      edge = { props, from_id: rel.from_entity, to_id: rel.to_entity, type: rtype };
    } else {
      requireSameEnds(rid, [edge.from_id, edge.type, edge.to_id], [rel.from_entity, rtype, rel.to_entity]);
      const prev = relationOf(edge);
      const sources = prev.source_count + takeGained(gained, rid);
      const mergedProperties = mergeProps(prev.properties, rel.properties);
      const reassert =
        !prev.is_current &&
        (prev.invalidated_at === null || epochMicros(effective) >= epochMicros(prev.invalidated_at));
      const unchanged = deepEqual(prev.properties, mergedProperties) && toIso(prev.event_time) === toIso(eventTime);
      if (unchanged && !reassert) {
        write = sources !== prev.source_count;
        props = { ...edge.props, source_count: sources };
      } else {
        if (prev.is_current) {
          writes.set(JSON.stringify([rid, prev.revision]), [rid, { ...edge.props, is_current: false }]);
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
        });
      }
      edge = { ...edge, props };
    }
    if (tracker !== null && props.is_current) {
      const version = relationOf(edge);
      options.warnings?.push(
        ...tracker.admit(rid, rtype, rel.from_entity, rel.to_entity, rankOf(version), effectiveTime(version)),
      );
    }
    if (write) writes.set(JSON.stringify([rid, props.revision]), [rid, props]);
    current.set(rid, edge);
    out.push([rid, props.revision as number, relationOf(edge)]);
  }
  const [ended, settled] = tracker?.settle() ?? [new Map<string, [string, Date]>(), []];
  options.warnings?.push(...settled);
  for (const [old, [by, at]] of ended) {
    const gone = retiredEdge(current.get(old) ?? existing.get(old)!, by, at);
    const key = JSON.stringify([old, gone.props.revision]);
    (writes.has(key) ? writes : retires).set(key, [old, gone.props]);
    current.set(old, gone);
  }

  for (const [, props] of [...writes.values(), ...retires.values()]) precheckWrite(runner, props);
  for (const batch of [writes, retires]) {
    const rows: EdgeWrite[] = [...batch.values()].map(([rid, props]) => {
      const edge = current.get(rid)!;
      return [edge.type, edge.from_id, edge.to_id, props];
    });
    if (rows.length) await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
  }
  await writeEvidence(runner, ns, records);
  return out.map(([rid, revision, rel]) => {
    const key = JSON.stringify([rid, revision]);
    const final = retires.get(key) ?? writes.get(key);
    return final === undefined ? rel : relationOf({ ...current.get(rid)!, props: final[1] });
  });
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
 * mode one older than the current relations it conflicts with is written already invalidated.
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
  await runner.lockNode(ns, L_ENTITY, args.from_entity);
  const prior = await newestRelation(runner, ns, rid);
  if (prior !== null) {
    if (prior.is_current || prior.invalidated_at === null) throw new ConflictError("Relation", rid);
    requireSameEnds(rid, [prior.from_entity, prior.type, prior.to_entity], [args.from_entity, rtype, args.to_entity]);
  }
  const [records, gained] = await planEvidence(
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
    source_count: (prior?.source_count ?? 0) + (gained.get(rid) ?? 0),
  });
  const [tracker, existing] = await contradictionCheck(runner, ns, options, [
    [rtype, args.from_entity, args.to_entity],
  ]);
  let retires: EdgeRow[] = [];
  let written = props;
  if (tracker !== null) {
    const edge = { props, from_id: args.from_entity, to_id: args.to_entity, type: rtype };
    const version = relationOf(edge);
    const found = tracker.admit(rid, rtype, args.from_entity, args.to_entity, rankOf(version), effectiveTime(version));
    const [ended, settled] = tracker.settle();
    options.warnings?.push(...found, ...settled);
    retires = [...ended]
      .filter(([old]) => old !== rid)
      .map(([old, [by, at]]) => retiredEdge(existing.get(old)!, by, at));
    const own = ended.get(rid);
    if (own !== undefined) written = retiredEdge(edge, ...own).props;
  }
  for (const write of [written, ...retires.map((e) => e.props)]) precheckWrite(runner, write);
  const rel = await writeRelationVersion(runner, ns, ends, written, false);
  if (retires.length) {
    await runner.createEdges(
      ns,
      L_ENTITY,
      L_ENTITY,
      retires.map((e) => [e.type, e.from_id, e.to_id, e.props]),
    );
  }
  await writeEvidence(runner, ns, records);
  if (prior !== null) {
    options.warnings?.push(
      insertWarning(
        "relation_reasserted",
        `${invalidatedNote(prior)} (revision ${prior.revision}); reasserted as revision ${rel.revision} ` +
          "with exactly the given properties",
      ),
    );
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
 * and throws ValidationError; any other object with versions but no current one is mid-write and throws
 * TransientError so the caller retries.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param id (string): the relation or preference id.
 * @param kind ("relation" | "preference"): the object kind, for the errors.
 * @param get ((runner: Runner, ns: string, id: string) => Promise<T | null>): reads the current version, or null.
 * @param newest ((runner: Runner, ns: string, id: string) => Promise<T | null>): reads the highest revision, current or not, or null.
 * @param lockOn ((current: T) => [string, string]): maps the current version to the (label, id) node to lock.
 * @return (T): the current version, under the lock.
 */
async function lockCurrent<T>(
  runner: Runner,
  ns: string,
  id: string,
  kind: "relation" | "preference",
  get: (runner: Runner, ns: string, id: string) => Promise<T | null>,
  newest: (runner: Runner, ns: string, id: string) => Promise<T | null>,
  lockOn: (current: T) => [string, string],
): Promise<T> {
  const before = await get(runner, ns, id);
  if (before === null) {
    const latest = await newest(runner, ns, id);
    if (latest === null) throw new NotFoundError(kind === "relation" ? "Relation" : "Preference", id);
    const ended = latest as Partial<Relation>;
    if (ended.invalidated_at != null) {
      throw new ValidationError(`${invalidatedNote(ended as Relation)}; create it again to reassert it`);
    }
    throw new TransientError(`${kind} ${pyRepr(id)} has no current version right now (concurrent write); retry`);
  }
  await runner.lockNode(ns, ...lockOn(before));
  const current = await get(runner, ns, id);
  if (current === null) throw new TransientError(`${kind} ${pyRepr(id)} was changed concurrently; retry`);
  return current;
}

/**
 * Create a new version of a relation with changed properties; an unchanged update is a no-op.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rid (string): the relation id.
 * @param args (UpdateRelationArgs): the properties to set and remove, a new valid time, and evidence to add.
 * @param schemaCheck (SchemaCheck | undefined): checks the resulting relation against the schema before the write, given the stored version too so only violations the update introduces count.
 * @return (Relation): the current version; throws ValidationError for a relation a contradiction invalidated.
 */
export async function updateRelation(
  runner: Runner,
  ns: string,
  rid: string,
  args: UpdateRelationArgs,
  schemaCheck?: SchemaCheck,
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
  const [records, gained] = await planEvidence(
    runner,
    ns,
    (args.evidence ?? []).map((ev) => [rid, ev] as const),
    new Set(),
  );
  const sources = current.source_count + (gained.get(rid) ?? 0);

  if (deepEqual(newProps, current.properties) && toIso(newEventTime) === toIso(current.event_time)) {
    if (sources !== current.source_count) {
      await runner.updateCurrentEdge(ns, rid, { source_count: sources });
      current.source_count = sources;
    }
    await writeEvidence(runner, ns, records);
    return current;
  }

  const props = encodeRelationProps({
    ns,
    id: rid,
    revision: current.revision + 1,
    properties: newProps,
    event_time: newEventTime,
    created_at: new Date(),
    is_current: true,
    source_count: sources,
  });
  const rel = await writeRelationVersion(runner, ns, current, props, true);
  await writeEvidence(runner, ns, records);
  return rel;
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

/**
 * Pick the version of a relation or preference that was valid at a point in time.
 *
 * The picked version is the highest revision whose effective time is at or before asOf, so a later write overrides
 * earlier ones from its effective time on. It is valid unless the first invalidation recorded at or after its
 * revision happened at or before asOf.
 *
 * @param versions (Iterable<T>): every version of one relation or preference.
 * @param asOf (Date): the point in time.
 * @return (T | null): the version valid at asOf, or null.
 */
export function versionAsOf<T extends Relation | Preference>(versions: Iterable<T>, asOf: Date): T | null {
  const at = epochMicros(asOf);
  const ordered = [...versions].sort((a, b) => a.revision - b.revision);
  let picked: T | null = null;
  for (const version of ordered) {
    if (epochMicros(effectiveTime(version)) <= at) picked = version;
  }
  if (picked === null) return null;
  for (const version of ordered) {
    const ended = (version as { invalidated_at?: Date | null }).invalidated_at ?? null;
    if (version.revision >= picked.revision && ended !== null) return epochMicros(ended) > at ? picked : null;
  }
  return picked;
}

/**
 * Group edge versions by id in read order and keep the version of each valid at a point in time.
 *
 * @param edges (readonly EdgeRow[]): the edge versions.
 * @param decode ((e: EdgeRow) => T): turns an edge row into a Relation or Preference.
 * @param asOf (Date): the point in time.
 * @return (T[]): the valid versions, one per id at most.
 */
function pickAsOf<T extends Relation | Preference>(
  edges: readonly EdgeRow[],
  decode: (e: EdgeRow) => T,
  asOf: Date,
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
 * Read every version of the relations starting or ending at some entities, as each stood at a point in time.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param asOf (Date): the point in time.
 * @param anchor ({ from_in?: readonly string[]; to_in?: readonly string[] }): the entity ids the relations start or end at.
 * @return (Relation[]): the relations valid at asOf, in id order.
 */
export async function relationsAsOf(
  runner: Runner,
  ns: string,
  asOf: Date,
  anchor: { from_in?: readonly string[]; to_in?: readonly string[] },
): Promise<Relation[]> {
  const edges = (await allEdges(runner, ns, { from_label: L_ENTITY, to_label: L_ENTITY, ...anchor }, PAGE)).filter(
    (e) => isRelationType(e.type),
  );
  return pickAsOf(edges, relationOf, asOf);
}

/**
 * Read every version of every preference, as each stood at a point in time.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param asOf (Date): the point in time.
 * @return (Preference[]): the preferences valid at asOf, in id order.
 */
export async function preferencesAsOf(runner: Runner, ns: string, asOf: Date): Promise<Preference[]> {
  const edges = (await allEdges(runner, ns, { from_label: L_PROFILE, to_label: null }, PAGE)).filter((e) =>
    isPreferenceType(e.type),
  );
  return pickAsOf(edges, preferenceOf, asOf);
}

/**
 * Delete a relation, all of its versions, and any decision trace that uses it as a step.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param rid (string): the relation id.
 * @return (DeleteResult): counts of what was removed.
 */
export async function deleteRelation(runner: Runner, ns: string, rid: string): Promise<DeleteResult> {
  requireStr("relation id", rid);
  if (!(await relationExists(runner, ns, rid))) throw new NotFoundError("Relation", rid);
  const traceIds = await tracesTouchingRelations(runner, ns, [rid]);
  const deletedVersions = await runner.deleteEdges(ns, rid);
  await deleteEvidence(runner, ns, rid);
  const deletedDecisions = await deleteTraces(runner, ns, traceIds);
  return { ...NO_DELETES, deleted_relation_versions: deletedVersions, deleted_decisions: deletedDecisions };
}

async function ensureProfile(runner: Runner, ns: string, subjectId: string, createdAt: Date): Promise<string> {
  const pid = ids.profileId(subjectId);
  if (await runner.nodeExists(ns, L_PROFILE, pid)) return pid;
  if (!(await runner.nodeExists(ns, L_ENTITY, subjectId))) {
    throw new ValidationError(`preference references unknown subject entity ${pyRepr(subjectId)}`);
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

const preferenceOf = (e: EdgeRow): Preference =>
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
  if (retire) {
    precheckWrite(runner, props);
    await runner.updateCurrentEdge(ns, idOf(props), { is_current: false });
  }
  await runner.createEdge(
    ns,
    preferenceEdgeType(ends.stance),
    L_PROFILE,
    ends.profile_id,
    L_ENTITY,
    ends.value_entity,
    props,
  );
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
 * Insert-semantics upsert of a preference: merge properties, versioning on change.
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
  const eventTime = pref.event_time || defaultEventTime;
  await requirePreferenceRefs(runner, ns, pref);
  const profileId = await ensureProfile(runner, ns, pref.subject_entity, createdAt);

  await runner.lockNode(ns, L_PROFILE, profileId);
  const current = await getPreference(runner, ns, pid);
  if (
    current !== null &&
    (current.subject_entity !== pref.subject_entity ||
      current.stance !== pref.stance ||
      current.key !== ids.normalizeText(pref.key) ||
      current.value_entity !== pref.value_entity)
  ) {
    throw new ValidationError(
      `preference ${pyRepr(pid)} already exists with different subject/stance/key/value; ` +
        "these identify the preference and are immutable; create a new preference to change them",
    );
  }
  const mergedProps = mergeProps(current?.properties ?? null, pref.properties);
  const props = encodePreferenceProps({
    ns,
    id: pid,
    revision: current === null ? 1 : current.revision + 1,
    subject_entity: pref.subject_entity,
    key: ids.normalizeText(pref.key),
    about_entity: pref.about_entity,
    strength: pref.strength,
    properties: mergedProps,
    event_time: eventTime,
    created_at: createdAt,
    is_current: true,
  });

  if (current !== null) {
    const unchanged =
      current.strength === pref.strength &&
      current.about_entity === pref.about_entity &&
      deepEqual(current.properties, mergedProps) &&
      toIso(current.event_time) === toIso(eventTime);
    if (unchanged) return current;
  }
  const ends = { value_entity: pref.value_entity, profile_id: profileId, stance: pref.stance };
  return writePreferenceVersion(runner, ns, ends, props, current !== null);
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
  precheckWrite(runner, props);
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
 * @return (Preference): the current version.
 */
export async function updatePreference(
  runner: Runner,
  ns: string,
  pid: string,
  args: UpdatePreferenceArgs,
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
  });
  return writePreferenceVersion(runner, ns, current, props, true);
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
  if (!(await preferenceExists(runner, ns, pid))) throw new NotFoundError("Preference", pid);
  return { ...NO_DELETES, deleted_preference_versions: await runner.deleteEdges(ns, pid) };
}

async function readSteps(runner: Runner, ns: string, tid: string): Promise<DecisionStep[]> {
  const rows = await runner.childNodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP);
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
 * Resolve decision step relation ids to their latest versions, so a step can name a retired relation.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param stepRelIds (readonly string[]): ordered relation ids.
 * @return (DecisionStep[]): the steps; throws ValidationError for an id with no version.
 */
async function resolveSteps(runner: Runner, ns: string, stepRelIds: readonly string[]): Promise<DecisionStep[]> {
  const steps: DecisionStep[] = [];
  for (const [order, relId] of stepRelIds.entries()) {
    const rel = await newestRelation(runner, ns, relId);
    if (rel === null) throw new ValidationError(`decision step references unknown relation ${pyRepr(relId)}`);
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
    steps: DecisionStep[];
  },
): Promise<void> {
  const { tid } = args;
  if (args.actor_entity !== null)
    await runner.createEdge(ns, R_MADE_DECISION, L_ENTITY, args.actor_entity, L_TRACE, tid, { ns });
  if (args.outcome_entity !== null)
    await runner.createEdge(ns, R_RESULTED_IN, L_TRACE, tid, L_ENTITY, args.outcome_entity, { ns });
  for (const alt of args.alternative_entities)
    await runner.createEdge(ns, R_CONSIDERED, L_TRACE, tid, L_ENTITY, alt, { ns });
  for (const step of args.steps) {
    const sid = ids.stepId(tid, step.order);
    await runner.upsertNode(ns, L_STEP, sid, {
      id: sid,
      ns,
      relation_id: step.relation_id,
      order: step.order,
      from_entity: step.from_entity,
      to_entity: step.to_entity,
    });
    await runner.createEdge(ns, R_HAS_STEP, L_TRACE, tid, L_STEP, sid, { ns, order: step.order });
    await runner.createEdge(ns, R_FROM, L_STEP, sid, L_ENTITY, step.from_entity, { ns });
    await runner.createEdge(ns, R_TO, L_STEP, sid, L_ENTITY, step.to_entity, { ns });
  }
}

async function clearTraceStructure(runner: Runner, ns: string, tid: string): Promise<void> {
  await deleteSteps(runner, ns, tid);
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
    )
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
  precheckWrite(runner, props);
  if (existing !== null) await clearTraceStructure(runner, ns, tid);
  await runner.upsertNode(ns, L_TRACE, tid, props);
  await writeTraceStructure(runner, ns, {
    tid,
    actor_entity: args.actor_entity,
    outcome_entity: args.outcome_entity,
    alternative_entities: alternatives,
    steps,
  });
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
  if (existing === null) throw new NotFoundError("DecisionTrace", tid);
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
  const traces: DecisionTrace[] = [];
  for (const props of rows) traces.push(decodeTrace(props, await readSteps(runner, ns, idOf(props))));
  return traces;
}

export async function deleteTrace(runner: Runner, ns: string, tid: string): Promise<DeleteResult> {
  requireStr("decision id", tid);
  if (!(await deleteTraceQuietly(runner, ns, tid))) throw new NotFoundError("DecisionTrace", tid);
  return { ...NO_DELETES, deleted_decisions: 1 };
}
