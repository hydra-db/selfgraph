import { DECAY_HINT, ValidationError } from "../errors.js";
import { normalizeRelType } from "../ids.js";
import { log } from "../internal/log.js";
import { comparePy } from "../internal/py.js";
import { jsonIso, toIso } from "../internal/time.js";
import * as m from "../maintenance.js";
import type { DateTimeInput, DecayResult, DedupeGroup, DedupeResult, PruneResult, Relation } from "../models.js";
import * as ops from "../ops.js";
import { checkOptions, keysOf, parseTime, requireList, typeName } from "../validate.js";
import { Resource } from "./common.js";

export interface DecayOptions {
  half_life_days?: number;
  now?: DateTimeInput | null;
  dry_run?: boolean;
}

export interface PruneOptions {
  min_relevance?: number | null;
  older_than?: DateTimeInput | null;
  types?: readonly string[] | null;
  relation_types?: readonly string[] | null;
  dry_run?: boolean;
}

export interface DedupeRelationsOptions {
  dry_run?: boolean;
}

const DECAY_KEYS = keysOf<DecayOptions>({ half_life_days: true, now: true, dry_run: true });
const PRUNE_KEYS = keysOf<PruneOptions>({
  min_relevance: true,
  older_than: true,
  types: true,
  relation_types: true,
  dry_run: true,
});
const DEDUPE_RELATIONS_KEYS = keysOf<DedupeRelationsOptions>({ dry_run: true });
const SKEW_MS = 60_000;
const UNSCORED = `no items have a relevance score yet; ${DECAY_HINT}`;
const SURVIVOR_RULE =
  "each group keeps its lowest relation id as the survivor and only the survivor's version history; " +
  "every version of each duplicate is deleted (versions_lost)";

/**
 * Validate a flag is a real boolean, so a truthy string never turns a dry run into a delete.
 *
 * @param name (string): the argument name for the error message.
 * @param value (unknown): the value to check.
 */
function requireFlag(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${name} must be a boolean, got ${typeName(value)}`);
}

/**
 * Reject a reference time more than one minute ahead of now, allowing for clock skew.
 *
 * @param name (string): the argument name for the error message.
 * @param at (Date): the reference time.
 * @param action (string): what the operation does relative to the time, for the error message.
 */
function requireNotFuture(name: string, at: Date, action: string): void {
  if (at.getTime() > Date.now() + SKEW_MS) {
    throw new ValidationError(`${name} ${jsonIso(at)} is in the future; ${action} a past or present time`);
  }
}

export class Maintenance extends Resource {
  /**
   * Score every entity and current relation by recency and frequency and store it as relevance.
   *
   * relevance = recency * (1 + frequency) / 2, rounded to six decimals, where recency = 0.5 ** (age_days / half_life_days) from the latest of created_at, updated_at, and event_time, and frequency = n / (n + 1) with n = source_count, plus degree (current relations touching it) for an entity. With dry_run false, scores are written in place with relevance_at, without a new version and without touching user properties. Nothing is deleted; rerunning with the same now writes nothing.
   *
   * @param options (DecayOptions): half_life_days (default 30), now (default the current time, at most one minute ahead), and dry_run (true by default) to compute without writing.
   * @return (DecayResult): the score per entity and relation id and how many were written.
   */
  async decay(options: DecayOptions = {}): Promise<DecayResult> {
    checkOptions("maintenance.decay", options, DECAY_KEYS);
    const halfLife = options.half_life_days ?? 30;
    m.requireNumber("half_life_days", halfLife, true);
    const now = parseTime(options.now, "now");
    const dryRun = options.dry_run ?? true;
    requireFlag("dry_run", dryRun);
    const at = now ?? new Date();
    requireNotFuture("now", at, "decay scores items as of");
    const [relations, entities] = await this.graph.read(async (store, ns) => [
      await m.scanRelations(store, ns),
      await m.scanEntities(store, ns),
    ]);
    const degree = new Map<string, number>();
    for (const rel of relations) {
      for (const eid of [rel.from_entity, rel.to_entity]) degree.set(eid, (degree.get(eid) ?? 0) + 1);
    }
    const relScores = new Map(
      relations.map((r) => [r.id, m.relevanceScore([r.created_at, r.event_time], at, halfLife, r.source_count)]),
    );
    const entScores = new Map(
      entities.map((e) => [
        e.id,
        m.relevanceScore([e.created_at, e.updated_at], at, halfLife, e.source_count + (degree.get(e.id) ?? 0)),
      ]),
    );
    const result: DecayResult = {
      dry_run: dryRun,
      half_life_days: halfLife,
      now: at,
      entities: Object.fromEntries(entScores),
      relations: Object.fromEntries(relScores),
      updated_entities: 0,
      updated_relations: 0,
    };
    if (dryRun) return result;
    const stamp = toIso(at);
    const stale = <T extends { id: string; relevance: number | null; relevance_at: Date | null }>(
      items: T[],
      scores: Map<string, number>,
    ) => items.filter((x) => x.relevance !== scores.get(x.id) || toIso(x.relevance_at) !== stamp);
    for (const batch of ops.batches(stale(entities, entScores))) {
      const scores = new Map(batch.map((e) => [e.id, entScores.get(e.id)!]));
      result.updated_entities += await this.graph.write((tx, ns) => m.writeEntityRelevance(tx, ns, scores, at));
    }
    for (const batch of ops.batches(stale(relations, relScores))) {
      const scores = new Map(batch.map((r) => [r.id, relScores.get(r.id)!]));
      result.updated_relations += await this.graph.write((tx, ns) =>
        m.writeRelationRelevance(tx, ns, batch, scores, at),
      );
    }
    return result;
  }

  /**
   * Remove entities and current relations that are below a relevance or older than a time.
   *
   * Every given criterion must hold. An item never scored by decay has no relevance and never matches min_relevance. types narrows the entities to these entity types and relation_types the relations to these relation types; neither is a criterion on its own. Given only one of them, the other kind is not matched directly, so types alone removes no relation except those of a removed entity, and relation_types alone removes no entity. Removal goes through the normal deletes, so a removed entity takes its relations, evidence, preferences, and decisions with it; those cascaded relations are listed too. Only current relations are matched: a relation a contradiction invalidated stays as history unless its entity is removed, which deletes every version. Removal runs in batches of up to 1000 ids per transaction.
   *
   * @param options (PruneOptions): min_relevance, older_than (at most one minute ahead), types (entity types), relation_types, and dry_run (true by default).
   * @return (PruneResult): the entity and relation ids removed, or that would be, and delete counts (no deleted block on a dry run); with min_relevance and nothing scored yet, a note says to run decay first.
   */
  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    checkOptions("maintenance.prune", options, PRUNE_KEYS);
    const minRelevance = options.min_relevance ?? null;
    if (minRelevance !== null) m.requireNumber("min_relevance", minRelevance, false, 1);
    const olderThan = parseTime(options.older_than, "older_than");
    if (olderThan !== null) requireNotFuture("older_than", olderThan, "prune removes items older than");
    const types = options.types ?? null;
    const relTypes = options.relation_types ?? null;
    if (types !== null) requireList("types", types);
    if (relTypes !== null) requireList("relation_types", relTypes);
    const dryRun = options.dry_run ?? true;
    requireFlag("dry_run", dryRun);
    if (minRelevance === null && olderThan === null) {
      throw new ValidationError("prune needs min_relevance or older_than; types and relation_types only narrow them");
    }
    const narrowed = types !== null || relTypes !== null;
    const entityTypes = narrowed ? new Set((types ?? []).map(ops.cleanText)) : null;
    const relationTypes = narrowed ? new Set((relTypes ?? []).map(normalizeRelType)) : null;
    const matches = (
      relevance: number | null,
      stamps: Array<Date | null>,
      kind: string,
      allowed: Set<string> | null,
    ): boolean => {
      if (allowed !== null && !allowed.has(kind)) return false;
      if (minRelevance !== null && (relevance === null || relevance >= minRelevance)) return false;
      return olderThan === null || m.latest(stamps).getTime() < olderThan.getTime();
    };

    const [relations, entities, ns] = await this.graph.read(
      async (store, ns) => [await m.scanRelations(store, ns), await m.scanEntities(store, ns), ns] as const,
    );
    const doomed = entities
      .filter((e) => matches(e.relevance, [e.created_at, e.updated_at], e.type, entityTypes))
      .map((e) => e.id)
      .sort(comparePy);
    const gone = new Set(doomed);
    const cascaded = new Set(
      relations.filter((r) => gone.has(r.from_entity) || gone.has(r.to_entity)).map((r) => r.id),
    );
    const direct = relations
      .filter((r) => !cascaded.has(r.id) && matches(r.relevance, [r.created_at, r.event_time], r.type, relationTypes))
      .map((r) => r.id)
      .sort(comparePy);
    const relationIds = [...cascaded, ...direct].sort(comparePy);
    const note =
      minRelevance !== null && [...entities, ...relations].every((item) => item.relevance === null) ? UNSCORED : null;
    if (dryRun) return { dry_run: dryRun, entity_ids: doomed, relation_ids: relationIds, note };
    const deleted = { ...ops.NO_DELETES };
    const deletes: Array<[typeof ops.deleteEntities, string[]]> = [
      [ops.deleteEntities, doomed],
      [ops.deleteRelations, direct],
    ];
    for (const [op, oids] of deletes) {
      for (const batch of ops.batches(oids)) {
        ops.addCounts(deleted, await this.graph.write((tx, n) => op(tx, n, batch)));
      }
    }
    log(`pruned ${doomed.length} entities and ${relationIds.length} relations in namespace '${ns}'`, "info");
    return { dry_run: dryRun, entity_ids: doomed, relation_ids: relationIds, deleted, note };
  }

  /**
   * Collapse parallel current relations with the same endpoints and type but different ids into one.
   *
   * The survivor of each group is the lowest id, whichever is newer, and only its version history is kept: every version of each duplicate is deleted, and the plan lists how many per duplicate in versions_lost (the result's note states the rule). Properties are unioned: the survivor wins a conflict, then each duplicate in id order, and every key a duplicate loses is reported in the group's conflicts. The survivor takes the earliest event_time of the group, the duplicates' evidence moves onto it (recounting its distinct sources), decisions that used a duplicate as a step are repointed to it, and the duplicates are then deleted. Relations a contradiction invalidated are never grouped.
   *
   * @param options (DedupeRelationsOptions): dry_run, true by default, lists the groups without merging them.
   * @return (DedupeResult): each group's survivor, duplicates, conflicting keys, and versions lost per duplicate, the survivor rule, and delete counts (no deleted block on a dry run).
   */
  async dedupeRelations(options: DedupeRelationsOptions = {}): Promise<DedupeResult> {
    checkOptions("maintenance.dedupeRelations", options, DEDUPE_RELATIONS_KEYS);
    const dryRun = options.dry_run ?? true;
    requireFlag("dry_run", dryRun);
    const [relations, ns] = await this.graph.read(async (store, ns) => [await m.scanRelations(store, ns), ns] as const);
    const groups = new Map<string, Relation[]>();
    for (const rel of relations) {
      const key = JSON.stringify([rel.from_entity, rel.type, rel.to_entity]);
      groups.set(key, [...(groups.get(key) ?? []), rel]);
    }
    const plan: DedupeGroup[] = [...groups.values()]
      .filter((rels) => rels.length > 1)
      .map((rels) => {
        const [survivor, ...duplicates] = rels.sort((a, b) => comparePy(a.id, b.id)) as [Relation, ...Relation[]];
        return {
          from_entity: survivor.from_entity,
          type: survivor.type,
          to_entity: survivor.to_entity,
          survivor: survivor.id,
          duplicates: duplicates.map((r) => r.id),
          conflicts: m.foldProperties(survivor, duplicates)[1],
          versions_lost: {} as Record<string, number>,
        };
      })
      .sort(
        (a, b) =>
          comparePy(a.from_entity, b.from_entity) || comparePy(a.type, b.type) || comparePy(a.to_entity, b.to_entity),
      );
    for (const group of plan) {
      for (const rid of group.duplicates) {
        const versions = await this.graph.read((store, n) => ops.listRelationVersions(store, n, rid, false));
        group.versions_lost[rid] = versions.length;
      }
    }
    const note = plan.length ? SURVIVOR_RULE : null;
    if (dryRun) return { dry_run: dryRun, groups: plan, note };
    const deleted = { ...ops.NO_DELETES };
    for (const group of plan) {
      ops.addCounts(
        deleted,
        await this.graph.write((tx, n) => m.mergeRelations(tx, n, group.survivor, group.duplicates)),
      );
    }
    const removed = plan.reduce((n, g) => n + g.duplicates.length, 0);
    log(`deduplicated ${plan.length} relation groups in namespace '${ns}', removing ${removed} duplicates`, "info");
    return { dry_run: dryRun, groups: plan, deleted, note };
  }
}
