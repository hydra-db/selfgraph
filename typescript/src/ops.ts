import { ConflictError, NotFoundError, TransientError, ValidationError } from "./errors.js";
import * as ids from "./ids.js";
import { dumps, loads } from "./internal/json.js";
import { deepEqual, isPlainObject, pyRepr, pyStrip, utf8 } from "./internal/py.js";
import { toIso } from "./internal/time.js";
import {
  childEdgeId,
  EDGE_TYPES,
  L_ENTITY,
  L_EVIDENCE,
  L_PROFILE,
  L_STEP,
  L_TRACE,
  LABELS,
  PREFERENCE_EDGE_TYPES,
  preferenceEdgeType,
  preferenceKindOf,
  R_CONSIDERED,
  R_FROM,
  R_HAS_PROFILE,
  R_HAS_STEP,
  R_MADE_DECISION,
  R_RESULTED_IN,
  R_TO,
} from "./labels.js";
import {
  DEFAULT_KIND,
  type DecisionStep,
  type DecisionTrace,
  type DeleteResult,
  type Entity,
  type Evidence,
  type JsonObject,
  Kind,
  type ParsedEntityInput,
  type ParsedEvidenceInput,
  type ParsedOntology,
  type ParsedPreferenceInput,
  type ParsedRelationInput,
  type Preference,
  type Relation,
  Status,
} from "./models.js";
import type { EdgeRow, EdgeWrite, GraphPrimitives, MatchNodesOptions, NodeRow, Props } from "./protocols.js";
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
  hasControl,
  hasSurrogate,
  keysOf,
  pyTypeName,
  rejectUnknown,
  requireDatetime,
  requireJsonMapping,
  requireList,
  requireOptionalText,
  requireStr,
  requireStrMapping,
  requireText,
} from "./validate.js";

type Runner = GraphPrimitives;
export type SchemaCheck = (runner: Runner, subject: SchemaSubject) => Promise<void>;

const NO_DELETES: Readonly<DeleteResult> = Object.freeze({
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
});
const KINDS: readonly Kind[] = [...Kind.options].sort();
const STATUSES: readonly Status[] = [...Status.options].sort();
const MAX_ID_BYTES = 1024;

const byteLength = (s: string): number => utf8(s).length;

const cleanText = (s: string): string => pyStrip(ids.normalizeText(s));

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
 * Validate an entity's type, name, and resolved id before writing.
 *
 * @param eid (unknown): the resolved entity id.
 * @param type (unknown): the entity type, used as a backend label.
 * @param name (unknown): the entity name.
 */
export function validateEntityIdentity(eid: unknown, type: unknown, name: unknown): void {
  if (typeof eid !== "string") throw new ValidationError(`entity id must be a string, got ${pyTypeName(eid)}`);
  if (typeof type !== "string" || typeof name !== "string" || !pyStrip(type) || !pyStrip(name)) {
    throw new ValidationError(
      "entity type and name cannot be empty; an entity needs both, e.g. type='Person', name='Jane Doe'",
    );
  }
  if (RESERVED_LABELS.has(pyStrip(type).toLowerCase())) {
    throw new ValidationError(`entity type ${pyRepr(type)} is reserved for internal use; choose another type`);
  }
  if (type.includes("`")) throw new ValidationError("entity type cannot contain a backtick");
  if (hasControl(name) || hasControl(type)) {
    throw new ValidationError("entity type and name cannot contain control or surrogate characters");
  }
  if (hasControl(eid)) throw new ValidationError("entity id cannot contain control or surrogate characters");
  const sep = eid.indexOf(":");
  if (sep < 0) throw new ValidationError(`entity id must be 'type:name', e.g. 'person:jane', got ${pyRepr(eid)}`);
  const prefix = eid.slice(0, sep);
  if (!pyStrip(prefix) || !pyStrip(eid.slice(sep + 1))) {
    throw new ValidationError(`entity id must be 'type:name' with a non-empty prefix and name, got ${pyRepr(eid)}`);
  }
  if (ids.RESERVED_ID_PREFIXES.has(prefix.toLowerCase())) {
    throw new ValidationError(`entity id prefix ${pyRepr(prefix)} is reserved for internal use`);
  }
  if (byteLength(eid) > MAX_ID_BYTES) {
    throw new ValidationError(`entity id is too long (${byteLength(eid)} bytes); keep ids under ${MAX_ID_BYTES} bytes`);
  }
}

export function validateStrength(strength: unknown): void {
  if (strength === null || strength === undefined) return;
  if (typeof strength !== "number") {
    throw new ValidationError(`preference strength must be a number, got ${pyTypeName(strength)}`);
  }
  if (!(strength >= 0 && strength <= 1)) {
    throw new ValidationError(`preference strength must be between 0 and 1, got ${strength}`);
  }
}

/**
 * Validate a caller-chosen relation, preference, or decision id, which must carry its own kind as prefix.
 *
 * @param kind (string): the object kind and required id prefix.
 * @param oid (unknown): the id, or null to skip the check.
 */
function validateOwnId(kind: string, oid: unknown): void {
  if (oid == null) return;
  if (typeof oid !== "string" || !oid)
    throw new ValidationError(`${kind} id must be a non-empty string, got ${pyTypeName(oid)}`);
  if (hasControl(oid)) throw new ValidationError(`${kind} id cannot contain control or surrogate characters`);
  if (byteLength(oid) > MAX_ID_BYTES) {
    throw new ValidationError(
      `${kind} id is too long (${byteLength(oid)} bytes); keep ids under ${MAX_ID_BYTES} bytes`,
    );
  }
  const sep = oid.indexOf(":");
  const prefix = sep >= 0 ? oid.slice(0, sep).toLowerCase() : "";
  if (prefix !== kind) throw new ValidationError(`${kind} id must start with '${kind}:', got ${pyRepr(oid)}`);
  if (!pyStrip(oid.slice(sep + 1))) {
    throw new ValidationError(`${kind} id must have a non-empty name after '${kind}:', got ${pyRepr(oid)}`);
  }
}

/**
 * Validate a value is one of the allowed strings.
 *
 * @param field (string): the field name for the error message.
 * @param value (unknown): the value to check.
 * @param choices (readonly T[]): the allowed values, sorted.
 */
function requireChoice<T extends string>(field: string, value: unknown, choices: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of ${pyRepr(choices)}, got ${pyRepr(value)}`);
  }
}

function canonProps(props: Props | null | undefined): JsonObject {
  if (!props || Object.keys(props).length === 0) return {};
  return loads(dumps(props), {});
}

function requireCleanEvidence(ev: unknown): void {
  if (!isPlainObject(ev)) throw new ValidationError(`evidence must be EvidenceInput objects, got a ${pyTypeName(ev)}`);
  requireText("evidence source_id", ev.source_id);
  if (ev.quote != null) {
    if (typeof ev.quote !== "string")
      throw new ValidationError(`evidence quote must be a string, got ${pyTypeName(ev.quote)}`);
    if (hasSurrogate(ev.quote))
      throw new ValidationError("evidence quote cannot contain unpaired surrogate characters");
  }
  if (ev.confidence != null) {
    if (typeof ev.confidence !== "number") {
      throw new ValidationError(`evidence confidence must be a number, got ${pyTypeName(ev.confidence)}`);
    }
    if (!Number.isFinite(ev.confidence)) throw new ValidationError("evidence confidence must be a finite number");
  }
  for (const [name, offset] of [
    ["evidence start_offset", ev.start_offset],
    ["evidence end_offset", ev.end_offset],
  ] as const) {
    if (offset != null && !(typeof offset === "number" && Number.isInteger(offset))) {
      throw new ValidationError(`${name} must be an integer, got ${pyTypeName(offset)}`);
    }
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
    throw new ValidationError(`evidence must be a list of Evidence objects, got ${pyTypeName(inputs)}`);
  }
  return inputs.map((ev) => {
    requireCleanEvidence(ev);
    return evidenceOf({
      source_id: ev.source_id,
      source_version: sourceVersion && ev.source_id === sourceId ? sourceVersion : `${ev.source_id}:manual`,
      quote: ev.quote,
      start_offset: ev.start_offset,
      end_offset: ev.end_offset,
      confidence: ev.confidence,
    });
  });
}

const dedupList = (items: readonly string[]): string[] => [...new Set(items)];

const dedupTextList = (items: readonly string[]): string[] => dedupList(items.map(ids.normalizeText));

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
function batches<T>(items: readonly T[]): T[][] {
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
async function nodesById(
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
    for (const batch of batches([...targets])) {
      const fetch = nodeListing(runner, ns, L_EVIDENCE, {
        equals: { source_id: sourceId },
        any_of: { target_id: batch },
      });
      for (const props of await scan(fetch, Number.POSITIVE_INFINITY, BATCH))
        seen.add(pair(props.target_id as string, sourceId));
    }
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
  targetId: string,
  kind: "entity" | "relation",
  skip: number,
  limit: number,
): Promise<Evidence[]> {
  requireStr(`${kind} id`, targetId);
  const rows = await runner.matchNodes(ns, L_EVIDENCE, { equals: { target_id: targetId }, skip, limit });
  if (!rows.length && skip === 0) {
    const exists =
      kind === "entity" ? await runner.nodeExists(ns, L_ENTITY, targetId) : await relationExists(runner, ns, targetId);
    if (!exists) throw new NotFoundError(kind === "entity" ? "Entity" : "Relation", targetId);
  }
  return rows.map(decodeEvidence);
}

async function deleteEvidence(runner: Runner, ns: string, targetId: string): Promise<void> {
  await runner.deleteNodesBy(ns, L_EVIDENCE, { target_id: targetId });
}

const precheckWrite = (runner: Runner, props: Props): void => runner.checkDocSize?.(props);

async function entityKnown(runner: Runner, ns: string, eid: unknown, known: Set<string>): Promise<boolean> {
  if (typeof eid !== "string")
    throw new ValidationError(`entity reference must be a string id, got ${pyTypeName(eid)}`);
  if (hasControl(eid)) throw new ValidationError("entity reference cannot contain control or surrogate characters");
  return known.has(eid) || (await runner.nodeExists(ns, L_ENTITY, eid));
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
 * Check every reference and value in an ontology before any write, so a bad one fails atomically.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param ontology (ParsedOntology): the ontology to check.
 */
export async function validateOntology(runner: Runner, ns: string, ontology: ParsedOntology): Promise<void> {
  const entityIds = ontology.entities.map((e) => e.id || ids.entityId(e.type, e.name));
  const entities = new Set(entityIds);
  const relations = new Set(ontology.relations.map((r) => r.id || ids.relationId(r.from_entity, r.type, r.to_entity)));

  for (const [i, ent] of ontology.entities.entries()) validateEntityIdentity(entityIds[i], ent.type, ent.name);

  for (const item of [...ontology.entities, ...ontology.relations, ...ontology.preferences]) {
    if (item.properties == null) throw new ValidationError("properties must be a mapping, got NoneType");
    requireJsonMapping("properties", item.properties);
  }
  for (const ent of ontology.entities) {
    requireStrMapping("external_ids", ent.external_ids);
    requireList("entity aliases", ent.aliases);
  }

  for (const rel of ontology.relations) {
    validateOwnId("relation", rel.id);
    requireDatetime("relation event_time", rel.event_time);
    rejectReservedRelType(ids.normalizeRelType(rel.type), rel.type);
    if (!Array.isArray(rel.evidence))
      throw new ValidationError(`relation evidence must be a list, got ${pyTypeName(rel.evidence)}`);
    for (const ev of rel.evidence) requireCleanEvidence(ev);
    if (
      !(await entityKnown(runner, ns, rel.from_entity, entities)) ||
      !(await entityKnown(runner, ns, rel.to_entity, entities))
    ) {
      throw new ValidationError(
        `relation endpoints not found (from=${pyRepr(rel.from_entity)}, to=${pyRepr(rel.to_entity)}); both must be ` +
          "entity ids ('type:name') listed in this ontology's entities or already in the graph. " +
          "Ids are canonicalized; compute one with selfgraph.entity_id(type, name)",
      );
    }
  }

  for (const pref of ontology.preferences) {
    validateOwnId("preference", pref.id);
    requireDatetime("preference event_time", pref.event_time);
    requireChoice("preference kind", pref.kind, KINDS);
    requireText("preference key", pref.key);
    validateStrength(pref.strength);
    if (!(await entityKnown(runner, ns, pref.subject_entity, entities))) {
      throw new ValidationError(`preference references unknown subject entity ${pyRepr(pref.subject_entity)}`);
    }
    await requirePreferenceRefs(runner, ns, pref, entities);
  }

  for (const dec of ontology.decisions) {
    validateOwnId("decision", dec.id);
    requireDatetime("decision event_time", dec.event_time);
    requireChoice("decision status", dec.status, STATUSES);
    requireText("decision title", dec.title);
    requireOptionalText("decision summary", dec.summary);
    requireOptionalText("decision rationale", dec.rationale);
    requireList("decision steps", dec.steps);
    requireList("decision alternative_entities", dec.alternative_entities);
    for (const relId of dec.steps) {
      if (!relations.has(relId) && (await getRelationCurrent(runner, ns, relId)) === null) {
        throw new ValidationError(`decision step references unknown relation ${pyRepr(relId)}`);
      }
    }
    await requireTraceRefs(runner, ns, dec, entities);
  }
}

export async function getEntity(runner: Runner, ns: string, eid: string): Promise<Entity | null> {
  requireStr("entity id", eid);
  const props = await runner.getNode(ns, L_ENTITY, eid);
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
  const eids = [...new Set(keyed.map((k) => k.eid))];
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
        aliases: dedupTextList(ent.aliases),
        external_ids: { ...ent.external_ids },
        properties: { ...ent.properties },
        source_count: sources,
        created_at: createdAt,
        updated_at: createdAt,
      });
    } else {
      const aliases = dedupTextList([...prev.aliases, ...ent.aliases, ...(ename === prev.name ? [] : [ename])]);
      const externalIds = { ...prev.external_ids, ...ent.external_ids };
      const properties = { ...prev.properties, ...canonProps(ent.properties) };
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
    byType.set(props.type as string, [...rows, [eid, props]]);
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
  requireText("entity type", args.type);
  requireText("entity name", args.name);
  const type = cleanText(args.type);
  const name = cleanText(args.name);
  const eid = args.id || ids.entityId(type, name);
  validateEntityIdentity(eid, type, name);
  if (args.aliases != null) requireList("aliases", args.aliases);
  if (args.external_ids != null) requireStrMapping("external_ids", args.external_ids);
  requireJsonMapping("properties", args.properties);
  await runner.lockNode(ns, L_ENTITY, eid);
  if (await runner.nodeExists(ns, L_ENTITY, eid)) throw new ConflictError("Entity", eid);
  const properties = { ...(args.properties ?? {}) };
  await schemaCheck?.(runner, { entities: [{ id: args.id || null, type, name, properties }], relations: [] });
  const ts = new Date();
  const props = encodeEntityProps({
    ns,
    id: eid,
    type,
    name,
    aliases: dedupTextList(args.aliases ?? []),
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
 * @param schemaCheck (SchemaCheck | undefined): checks the resulting entity against the schema before the write.
 * @return (Entity): the updated entity.
 */
export async function updateEntity(
  runner: Runner,
  ns: string,
  eid: string,
  fields: UpdateEntityFields,
  schemaCheck?: SchemaCheck,
): Promise<Entity> {
  let existing = await getEntity(runner, ns, eid);
  if (existing === null) throw new NotFoundError("Entity", eid);
  rejectUnknown("entity", fields, ENTITY_UPDATE_FIELDS);
  for (const key of ["aliases", "remove_aliases", "remove_properties"] as const) {
    if (fields[key] !== undefined) requireList(key, fields[key]);
  }
  if (fields.properties !== undefined) requireJsonMapping("properties", fields.properties);
  if (fields.external_ids !== undefined) requireStrMapping("external_ids", fields.external_ids);
  if (fields.type !== undefined) requireText("entity type", fields.type);
  if (fields.name !== undefined) requireText("entity name", fields.name);
  await runner.lockNode(ns, L_ENTITY, eid);
  existing = await getEntity(runner, ns, eid);
  if (existing === null) throw new TransientError(`entity ${pyRepr(eid)} was changed concurrently; retry`);
  const type = fields.type !== undefined ? cleanText(fields.type) : existing.type;
  const name = fields.name !== undefined ? cleanText(fields.name) : existing.name;
  validateEntityIdentity(eid, type, name);
  const removed = new Set((fields.remove_aliases ?? []).map(ids.normalizeText));
  const aliases = dedupTextList([...existing.aliases, ...(fields.aliases ?? [])]).filter((a) => !removed.has(a));
  const properties: JsonObject = { ...existing.properties, ...canonProps(fields.properties) };
  for (const key of fields.remove_properties ?? []) delete properties[key];
  const externalIds = { ...existing.external_ids, ...fields.external_ids };
  await schemaCheck?.(runner, { entities: [{ id: eid, type, name, properties }], relations: [] });
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
  });
  precheckWrite(runner, props);
  if (type !== existing.type) await runner.removeNodeLabel(ns, L_ENTITY, eid, existing.type);
  await runner.upsertNode(ns, L_ENTITY, eid, props, { extra_label: type });
  return decodeEntity(props);
}

export async function listEntities(
  runner: Runner,
  ns: string,
  args: { type?: string | null; name?: string | null; skip: number; limit: number },
): Promise<Entity[]> {
  requireOptionalText("type filter", args.type);
  requireOptionalText("name filter", args.name);
  const equals: Props = {};
  if (args.type != null) equals.type = cleanText(args.type);
  if (args.name != null) equals.name = cleanText(args.name);
  const rows = await runner.matchNodes(ns, L_ENTITY, { equals, skip: args.skip, limit: args.limit });
  return rows.map(decodeEntity);
}

async function deleteSteps(runner: Runner, ns: string, tid: string): Promise<void> {
  for (const step of await runner.childNodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP)) {
    await runner.deleteNode(ns, L_STEP, idOf(step));
  }
}

async function deleteTraceQuietly(runner: Runner, ns: string, tid: string): Promise<boolean> {
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

async function tracesTouchingRelation(runner: Runner, ns: string, rid: string): Promise<Set<string>> {
  const steps = await runner.matchNodes(ns, L_STEP, { equals: { relation_id: rid } });
  return new Set(steps.map((s) => ids.traceOfStep(idOf(s))));
}

async function tracesTouchingEntity(runner: Runner, ns: string, eid: string): Promise<Set<string>> {
  const tids = new Set<string>();
  for (const key of ["actor_entity", "outcome_entity"]) {
    for (const trace of await runner.matchNodes(ns, L_TRACE, { equals: { [key]: eid } })) tids.add(idOf(trace));
  }
  for (const key of ["from_entity", "to_entity"]) {
    for (const step of await runner.matchNodes(ns, L_STEP, { equals: { [key]: eid } }))
      tids.add(ids.traceOfStep(idOf(step)));
  }
  return tids;
}

async function tracesWithAlternative(runner: Runner, ns: string, eid: string): Promise<Set<string>> {
  const edges = await runner.matchEdges(ns, {
    from_label: L_TRACE,
    to_label: L_ENTITY,
    type: R_CONSIDERED,
    to_id: eid,
  });
  return new Set(edges.map((e) => e.from_id));
}

async function pruneTraceAlternative(runner: Runner, ns: string, tid: string, eid: string): Promise<void> {
  const trace = await getTrace(runner, ns, tid);
  if (trace === null) return;
  const remaining = trace.alternative_entities.filter((a) => a !== eid);
  if (!deepEqual(remaining, trace.alternative_entities)) {
    await updateTrace(runner, ns, tid, { alternative_entities: remaining });
  }
}

/**
 * Delete an entity, its relations, its profile and preferences, and any decision trace that references it.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param eid (string): the entity id.
 * @return (DeleteResult): counts of what was removed.
 */
export async function deleteEntity(runner: Runner, ns: string, eid: string): Promise<DeleteResult> {
  requireStr("entity id", eid);
  if (!(await runner.nodeExists(ns, L_ENTITY, eid))) throw new NotFoundError("Entity", eid);
  const counts = { ...NO_DELETES };
  const traceIds = await tracesTouchingEntity(runner, ns, eid);

  for (const rid of await runner.versionedRelationIds(ns, L_ENTITY, eid, {
    exclude_types: [...PREFERENCE_EDGE_TYPES, R_HAS_PROFILE],
  })) {
    counts.deleted_relation_versions += await runner.deleteEdges(ns, rid);
    await deleteEvidence(runner, ns, rid);
    for (const tid of await tracesTouchingRelation(runner, ns, rid)) traceIds.add(tid);
  }

  counts.deleted_decisions = await deleteTraces(runner, ns, traceIds);

  for (const tid of await tracesWithAlternative(runner, ns, eid)) {
    if (!traceIds.has(tid)) await pruneTraceAlternative(runner, ns, tid, eid);
  }

  for (const profile of await runner.childNodes(ns, L_ENTITY, eid, R_HAS_PROFILE, L_PROFILE)) {
    counts.deleted_preference_versions += await runner.countOutEdges(ns, L_PROFILE, idOf(profile));
    await runner.deleteNode(ns, L_PROFILE, idOf(profile));
  }

  for (const pref of await runner.matchEdges(ns, {
    from_label: L_PROFILE,
    current_only: true,
    equals: { about_entity: eid },
  })) {
    if (pref.to_id !== eid) {
      await updatePreference(runner, ns, idOf(pref.props), {
        properties: null,
        remove_properties: [],
        clear_about: true,
      });
    }
  }

  counts.deleted_preference_versions += await runner.countInEdgesTyped(ns, L_ENTITY, eid, PREFERENCE_EDGE_TYPES);
  await runner.deleteNode(ns, L_ENTITY, eid);
  await deleteEvidence(runner, ns, eid);
  counts.deleted_entities = 1;
  return counts;
}

const isRelationType = (rtype: string): boolean => !EDGE_TYPES.has(rtype);

type RelationEnds = Pick<Relation, "from_entity" | "type" | "to_entity">;

const relationOf = (e: EdgeRow): Relation =>
  decodeRelation(e.props, { from_entity: e.from_id, to_entity: e.to_id, type: e.type });
const isPreferenceType = (rtype: string): boolean => preferenceKindOf(rtype) !== null;

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

async function relationExists(runner: Runner, ns: string, rid: string): Promise<boolean> {
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
    throw new ValidationError(
      `relation endpoints not found (from=${pyRepr(ends.from_entity)}, to=${pyRepr(ends.to_entity)}); ` +
        "create both entities first, then reference them by id ('type:name')",
    );
  }
  return decodeRelation(props, ends);
}

/**
 * Fetch the current version of many relations, reading each batch of source entities' outgoing relations.
 *
 * A derived relation id fixes its endpoints, so its stored version is among its source entity's relations; an
 * explicit id may name a relation between other entities, so one not found that way is looked up by id.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param keyed (ReadonlyArray<readonly [string, ParsedRelationInput]>): (relation id, input) pairs.
 * @return (Map<string, EdgeRow>): each found relation's current edge row by id.
 */
async function currentRelations(
  runner: Runner,
  ns: string,
  keyed: ReadonlyArray<readonly [string, ParsedRelationInput]>,
): Promise<Map<string, EdgeRow>> {
  const wanted = new Set(keyed.map(([rid]) => rid));
  const found = new Map<string, EdgeRow>();
  for (const batch of batches([...new Set(keyed.map(([, rel]) => rel.from_entity))])) {
    const fetch = (skip: number, limit: number) =>
      runner.matchEdges(ns, {
        from_label: L_ENTITY,
        to_label: L_ENTITY,
        from_in: batch,
        current_only: true,
        skip,
        limit,
      });
    for (const edge of await scan(fetch, Number.POSITIVE_INFINITY, BATCH)) {
      if (wanted.has(idOf(edge.props)) && isRelationType(edge.type)) found.set(idOf(edge.props), edge);
    }
  }
  for (const [rid, rel] of keyed) {
    if (!rel.id || found.has(rid)) continue;
    const edge = await runner.getCurrentEdge(ns, rid);
    if (edge !== null && isRelationType(edge.type)) found.set(rid, edge);
  }
  return found;
}

/**
 * Insert-semantics upsert of many relations: merge properties, versioning on change, recording evidence.
 *
 * Relations are read and written in batches; a repeated id applies after the earlier input, as sequential
 * upserts would.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param items (ReadonlyArray<readonly [ParsedRelationInput, Evidence[]]>): relations with their evidence, in order.
 * @param defaultEventTime (Date | null): the fallback event time.
 * @param createdAt (Date): the timestamp.
 * @return (Relation[]): each input's stored current version, in input order.
 */
export async function upsertRelations(
  runner: Runner,
  ns: string,
  items: ReadonlyArray<readonly [ParsedRelationInput, Evidence[]]>,
  defaultEventTime: Date | null,
  createdAt: Date,
): Promise<Relation[]> {
  const keyed = items.map(([rel, evidence]) => {
    validateOwnId("relation", rel.id);
    const rtype = ids.normalizeRelType(rel.type);
    rejectReservedRelType(rtype, rtype);
    return { rid: rel.id || ids.relationId(rel.from_entity, rtype, rel.to_entity), rtype, rel, evidence };
  });
  for (const from of new Set(keyed.map((k) => k.rel.from_entity))) await runner.lockNode(ns, L_ENTITY, from);
  const rids = [...new Set(keyed.map((k) => k.rid))];
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

  const current = new Map(stored);
  const writes = new Map<string, readonly [string, Props]>();
  const out: Relation[] = [];
  for (const { rid, rtype, rel } of keyed) {
    const eventTime = rel.event_time || defaultEventTime;
    let edge = current.get(rid);
    let props: Props;
    if (edge === undefined) {
      props = encodeRelationProps({
        ns,
        id: rid,
        revision: 1,
        properties: { ...rel.properties },
        event_time: eventTime,
        created_at: createdAt,
        is_current: true,
        source_count: takeGained(gained, rid),
      });
      edge = { props, from_id: rel.from_entity, to_id: rel.to_entity, type: rtype };
    } else {
      if (rel.from_entity !== edge.from_id || rtype !== edge.type || rel.to_entity !== edge.to_id) {
        throw new ValidationError(
          `relation ${pyRepr(rid)} already exists with different endpoints/type; ` +
            "endpoints and type are immutable; create a new relation to change them",
        );
      }
      const prev = relationOf(edge);
      const sources = prev.source_count + takeGained(gained, rid);
      const mergedProperties = { ...prev.properties, ...canonProps(rel.properties) };
      if (deepEqual(prev.properties, mergedProperties) && toIso(prev.event_time) === toIso(eventTime)) {
        if (sources === prev.source_count) {
          out.push(prev);
          continue;
        }
        props = { ...edge.props, source_count: sources };
      } else {
        writes.set(JSON.stringify([rid, prev.revision]), [rid, { ...edge.props, is_current: false }]);
        props = encodeRelationProps({
          ns,
          id: rid,
          revision: prev.revision + 1,
          properties: mergedProperties,
          event_time: eventTime,
          created_at: createdAt,
          is_current: true,
          source_count: sources,
        });
      }
      edge = { ...edge, props };
    }
    writes.set(JSON.stringify([rid, props.revision]), [rid, props]);
    current.set(rid, edge);
    out.push(relationOf(edge));
  }

  for (const [, props] of writes.values()) precheckWrite(runner, props);
  const rows: EdgeWrite[] = [...writes.values()].map(([rid, props]) => {
    const edge = current.get(rid)!;
    return [edge.type, edge.from_id, edge.to_id, props];
  });
  await runner.createEdges(ns, L_ENTITY, L_ENTITY, rows);
  await writeEvidence(runner, ns, records);
  return out;
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
 * Create one relation version, normalizing the type to UPPER_SNAKE, failing if the id already exists.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (CreateRelationArgs): the relation fields.
 * @param schemaCheck (SchemaCheck | undefined): checks the relation against the schema before the write.
 * @return (Relation): the created relation.
 */
export async function createRelation(
  runner: Runner,
  ns: string,
  args: CreateRelationArgs,
  schemaCheck?: SchemaCheck,
): Promise<Relation> {
  requireText("relation from_entity", args.from_entity);
  requireText("relation type", args.type);
  requireText("relation to_entity", args.to_entity);
  requireJsonMapping("properties", args.properties);
  requireDatetime("event_time", args.event_time);
  validateOwnId("relation", args.id);
  const rtype = ids.normalizeRelType(args.type);
  const rid = args.id || ids.relationId(args.from_entity, rtype, args.to_entity);
  await runner.lockNode(ns, L_ENTITY, args.from_entity);
  if (await relationExists(runner, ns, rid)) throw new ConflictError("Relation", rid);
  const properties = { ...(args.properties ?? {}) };
  const ends = { from_entity: args.from_entity, type: rtype, to_entity: args.to_entity };
  await schemaCheck?.(runner, { entities: [], relations: [{ id: args.id || null, ...ends, properties }] });
  const [records, gained] = await planEvidence(
    runner,
    ns,
    args.evidence.map((ev) => [rid, ev] as const),
    new Set([rid]),
  );
  const props = encodeRelationProps({
    ns,
    id: rid,
    revision: 1,
    properties,
    event_time: args.event_time ?? null,
    created_at: new Date(),
    is_current: true,
    source_count: gained.get(rid) ?? 0,
  });
  const rel = await writeRelationVersion(runner, ns, ends, props, false);
  await writeEvidence(runner, ns, records);
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
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param id (string): the relation or preference id.
 * @param kind ("relation" | "preference"): the object kind, for the errors.
 * @param get ((runner: Runner, ns: string, id: string) => Promise<T | null>): reads the current version, or null.
 * @param exists ((runner: Runner, ns: string, id: string) => Promise<boolean>): reports whether any version exists.
 * @param lockOn ((current: T) => [string, string]): maps the current version to the (label, id) node to lock.
 * @return (T): the current version, under the lock.
 */
async function lockCurrent<T>(
  runner: Runner,
  ns: string,
  id: string,
  kind: "relation" | "preference",
  get: (runner: Runner, ns: string, id: string) => Promise<T | null>,
  exists: (runner: Runner, ns: string, id: string) => Promise<boolean>,
  lockOn: (current: T) => [string, string],
): Promise<T> {
  const before = await get(runner, ns, id);
  if (before === null) {
    if (await exists(runner, ns, id)) {
      throw new TransientError(`${kind} ${pyRepr(id)} has no current version right now (concurrent write); retry`);
    }
    throw new NotFoundError(kind === "relation" ? "Relation" : "Preference", id);
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
 * @param schemaCheck (SchemaCheck | undefined): checks the resulting relation against the schema before the write.
 * @return (Relation): the current version.
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
  const current = await lockCurrent(runner, ns, rid, "relation", getRelationCurrent, relationExists, (rel) => [
    L_ENTITY,
    rel.from_entity,
  ]);
  const newProps: JsonObject = { ...current.properties, ...canonProps(args.set_properties) };
  for (const key of args.remove_properties) delete newProps[key];
  const { from_entity, type, to_entity } = current;
  await schemaCheck?.(runner, {
    entities: [],
    relations: [{ id: rid, from_entity, type, to_entity, properties: newProps }],
  });
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
  },
): Promise<Relation[]> {
  requireOptionalText("from_entity filter", args.from_entity);
  requireOptionalText("type filter", args.type);
  requireOptionalText("to_entity filter", args.to_entity);
  if (args.from_in != null) requireList("from_in filter", args.from_in);
  if (args.to_in != null) requireList("to_in filter", args.to_in);
  const rows = await runner.matchEdges(ns, {
    from_label: L_ENTITY,
    to_label: L_ENTITY,
    type: args.type ? ids.normalizeRelType(args.type) : null,
    from_id: args.from_entity ?? null,
    to_id: args.to_entity ?? null,
    from_in: args.from_in ?? null,
    to_in: args.to_in ?? null,
    current_only: true,
    skip: args.skip,
    limit: args.limit,
  });
  return rows.map(relationOf);
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
  const traceIds = await tracesTouchingRelation(runner, ns, rid);
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

type PreferenceEnds = Pick<Preference, "value_entity" | "profile_id" | "kind">;

const preferenceOf = (e: EdgeRow): Preference =>
  decodePreference(e.props, {
    value_entity: e.to_id,
    profile_id: e.from_id,
    kind: preferenceKindOf(e.type) ?? DEFAULT_KIND,
  });

/**
 * Write a preference version as the current one, retiring the previous current version when there is one.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param ends (PreferenceEnds): the profile, value entity, and kind.
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
    preferenceEdgeType(ends.kind),
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

async function preferenceExists(runner: Runner, ns: string, pid: string): Promise<boolean> {
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
  const pid = pref.id || ids.preferenceId(pref.subject_entity, pref.kind, pref.key, pref.value_entity);
  const eventTime = pref.event_time || defaultEventTime;
  await requirePreferenceRefs(runner, ns, pref);
  const profileId = await ensureProfile(runner, ns, pref.subject_entity, createdAt);

  await runner.lockNode(ns, L_PROFILE, profileId);
  const current = await getPreference(runner, ns, pid);
  if (
    current !== null &&
    (current.subject_entity !== pref.subject_entity ||
      current.kind !== pref.kind ||
      current.key !== ids.normalizeText(pref.key) ||
      current.value_entity !== pref.value_entity)
  ) {
    throw new ValidationError(
      `preference ${pyRepr(pid)} already exists with different subject/kind/key/value; ` +
        "these identify the preference and are immutable; create a new preference to change them",
    );
  }
  const mergedProps = { ...(current?.properties ?? {}), ...canonProps(pref.properties) };
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
  const ends = { value_entity: pref.value_entity, profile_id: profileId, kind: pref.kind };
  return writePreferenceVersion(runner, ns, ends, props, current !== null);
}

export interface CreatePreferenceArgs {
  subject_entity: string;
  key: string;
  value_entity: string;
  id?: string | null;
  kind: Kind;
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
export async function createPreference(runner: Runner, ns: string, args: CreatePreferenceArgs): Promise<Preference> {
  requireChoice("preference kind", args.kind, KINDS);
  validateStrength(args.strength);
  requireText("preference subject_entity", args.subject_entity);
  requireText("preference key", args.key);
  requireText("preference value_entity", args.value_entity);
  const key = ids.normalizeText(args.key);
  requireJsonMapping("properties", args.properties);
  requireDatetime("event_time", args.event_time);
  validateOwnId("preference", args.id);
  const pid = args.id || ids.preferenceId(args.subject_entity, args.kind, key, args.value_entity);
  await requirePreferenceRefs(runner, ns, args);
  const props = encodePreferenceProps({
    ns,
    id: pid,
    revision: 1,
    subject_entity: args.subject_entity,
    key,
    about_entity: args.about_entity ?? null,
    strength: args.strength ?? null,
    properties: { ...(args.properties ?? {}) },
    event_time: args.event_time ?? null,
    created_at: new Date(),
    is_current: true,
  });
  precheckWrite(runner, props);
  const profileId = await ensureProfile(runner, ns, args.subject_entity, new Date());
  await runner.lockNode(ns, L_PROFILE, profileId);
  if (await preferenceExists(runner, ns, pid)) throw new ConflictError("Preference", pid);
  const ends = { value_entity: args.value_entity, profile_id: profileId, kind: args.kind };
  return writePreferenceVersion(runner, ns, ends, props, false);
}

export interface UpdatePreferenceArgs {
  strength?: number | null;
  properties?: JsonObject | null;
  remove_properties: readonly string[];
  event_time?: Date | null;
  clear_about?: boolean;
}

/**
 * Create a new version of a preference, merging properties; an unchanged update is a no-op.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param pid (string): the preference id.
 * @param args (UpdatePreferenceArgs): the new strength, properties to merge and remove, valid time, and whether to drop the about entity.
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
  const current = await lockCurrent(runner, ns, pid, "preference", getPreference, preferenceExists, (pref) => [
    L_PROFILE,
    pref.profile_id,
  ]);
  const newStrength = args.strength ?? current.strength;
  const newProps: JsonObject = { ...current.properties, ...canonProps(args.properties) };
  for (const key of args.remove_properties) delete newProps[key];
  const newEventTime = args.event_time ?? current.event_time;
  const newAbout = args.clear_about ? null : current.about_entity;
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
  args: { subject_entity?: string | null; key?: string | null; kind?: Kind | null; skip: number; limit: number },
): Promise<Preference[]> {
  requireOptionalText("subject_entity filter", args.subject_entity);
  requireOptionalText("key filter", args.key);
  if (args.kind != null) requireChoice("preference kind", args.kind, KINDS);
  const equals: Props = {};
  if (args.subject_entity != null) equals.subject_entity = args.subject_entity;
  if (args.key != null) equals.key = ids.normalizeText(args.key);
  const rows = await runner.matchEdges(ns, {
    from_label: L_PROFILE,
    to_label: null,
    type: args.kind != null ? preferenceEdgeType(args.kind) : null,
    current_only: true,
    equals,
    skip: args.skip,
    limit: args.limit,
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

async function resolveSteps(runner: Runner, ns: string, stepRelIds: readonly string[]): Promise<DecisionStep[]> {
  const steps: DecisionStep[] = [];
  for (const [order, relId] of stepRelIds.entries()) {
    const rel = await getRelationCurrent(runner, ns, relId);
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
}

/**
 * Insert-semantics upsert of a decision trace and its structure; an unchanged trace is a no-op.
 *
 * @param runner (Runner): the graph runner.
 * @param ns (string): the namespace.
 * @param args (UpsertTraceArgs): the trace fields, ordered step relation ids, and timestamp.
 * @return (DecisionTrace): the stored trace.
 */
export async function upsertTrace(runner: Runner, ns: string, args: UpsertTraceArgs): Promise<DecisionTrace> {
  requireChoice("decision status", args.status, STATUSES);
  requireText("decision title", args.title);
  const title = ids.normalizeText(args.title);
  if (args.actor_entity !== null) requireText("decision actor_entity", args.actor_entity);
  requireOptionalText("decision summary", args.summary);
  requireOptionalText("decision rationale", args.rationale);
  requireList("decision steps", args.step_rel_ids);
  requireList("alternative_entities", args.alternative_entities);
  requireDatetime("event_time", args.event_time);
  validateOwnId("decision", args.tid);
  const alternatives = dedupList(args.alternative_entities);
  const tid = args.tid || ids.decisionId(args.actor_entity, title);
  await requireTraceRefs(runner, ns, { ...args, alternative_entities: alternatives });
  const steps = await resolveSteps(runner, ns, args.step_rel_ids);
  await runner.lockNode(ns, L_TRACE, tid);
  const existing = await getTrace(runner, ns, tid);
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
  requireText("decision title", args.title);
  const title = ids.normalizeText(args.title);
  const actor = args.actor_entity ?? null;
  if (actor !== null) requireText("decision actor_entity", actor);
  validateOwnId("decision", args.id);
  const tid = args.id || ids.decisionId(actor, title);
  await runner.lockNode(ns, L_TRACE, tid);
  if (await runner.nodeExists(ns, L_TRACE, tid)) throw new ConflictError("DecisionTrace", tid);
  return upsertTrace(runner, ns, {
    tid,
    title,
    step_rel_ids: args.steps,
    actor_entity: actor,
    summary: args.summary ?? null,
    rationale: args.rationale ?? null,
    outcome_entity: args.outcome_entity ?? null,
    alternative_entities: args.alternative_entities,
    status: args.status,
    event_time: args.event_time ?? null,
    created_at: new Date(),
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
  await runner.lockNode(ns, L_TRACE, tid);
  const existing = await getTrace(runner, ns, tid);
  if (existing === null) throw new NotFoundError("DecisionTrace", tid);
  rejectUnknown("decision", fields, DECISION_UPDATE_FIELDS);
  const pick = <K extends keyof UpdateTraceFields>(key: K, fallback: Exclude<UpdateTraceFields[K], undefined>) =>
    fields[key] !== undefined ? (fields[key] as Exclude<UpdateTraceFields[K], undefined>) : fallback;
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
  args: { actor_entity?: string | null; status?: Status | null; skip: number; limit: number },
): Promise<DecisionTrace[]> {
  requireOptionalText("actor_entity filter", args.actor_entity);
  requireOptionalText("status filter", args.status);
  const equals: Props = {};
  if (args.actor_entity != null) equals.actor_entity = args.actor_entity;
  if (args.status != null) equals.status = args.status;
  const rows = await runner.matchNodes(ns, L_TRACE, { equals, skip: args.skip, limit: args.limit });
  const traces: DecisionTrace[] = [];
  for (const props of rows) traces.push(decodeTrace(props, await readSteps(runner, ns, idOf(props))));
  return traces;
}

export async function deleteTrace(runner: Runner, ns: string, tid: string): Promise<DeleteResult> {
  requireStr("decision id", tid);
  if (!(await deleteTraceQuietly(runner, ns, tid))) throw new NotFoundError("DecisionTrace", tid);
  return { ...NO_DELETES, deleted_decisions: 1 };
}
