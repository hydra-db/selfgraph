from __future__ import annotations

import logging
from datetime import datetime, timedelta

from .. import _maintenance as _m
from .. import _ops
from .._serde import aware, json_iso, to_iso
from .._serde import now as _now
from ..errors import DECAY_HINT, ValidationError
from ..ids import normalize_rel_type
from ..models import DecayResult, DedupeGroup, DedupeResult, DeleteResult, PruneResult, Relation
from ._common import Resource

__all__ = ["Maintenance"]

_log = logging.getLogger("selfgraph")
_SKEW = timedelta(minutes=1)
_UNSCORED = f"no items have a relevance score yet; {DECAY_HINT}"
_SURVIVOR_RULE = (
    "each group keeps its lowest relation id as the survivor and only the survivor's version history; "
    "every version of each duplicate is deleted (versions_lost)"
)


def _require_flag(name: str, value: object) -> None:
    """Validate a flag is a real boolean, so a truthy string never turns a dry run into a delete.

    @param name (str): the argument name for the error message.
    @param value (object): the value to check.
    @return (None): nothing; raises ValidationError otherwise.
    """
    if not isinstance(value, bool):
        raise ValidationError(f"{name} must be a boolean, got {type(value).__name__}")


def _require_not_future(name: str, at: datetime, action: str) -> None:
    """Reject a reference time more than one minute ahead of now, allowing for clock skew.

    @param name (str): the argument name for the error message.
    @param at (datetime): the timezone-aware reference time.
    @param action (str): what the operation does relative to the time, for the error message.
    @return (None): nothing; raises ValidationError otherwise.
    """
    if at > _now() + _SKEW:
        raise ValidationError(f"{name} {json_iso(at)} is in the future; {action} a past or present time")


class Maintenance(Resource):
    async def decay(
        self, *, half_life_days: float = 30, now: datetime | str | None = None, dry_run: bool = True
    ) -> DecayResult:
        """Score every entity and current relation by recency and frequency and store it as relevance.

        relevance = recency * (1 + frequency) / 2, rounded to six decimals, where
        recency = 0.5 ** (age_days / half_life_days) from the latest of created_at, updated_at, and
        event_time, and frequency = n / (n + 1) with n = source_count, plus degree (current relations
        touching it) for an entity. With dry_run=False, scores are written in place with relevance_at,
        without a new version and without touching user properties. Nothing is deleted; rerunning with
        the same now writes nothing.

        @param half_life_days (float): the days after which recency halves.
        @param now (datetime | str | None): the reference time, or None for the current time; at most one minute ahead.
        @param dry_run (bool): compute the scores without writing them; True by default.
        @return (DecayResult): the score per entity and relation id and how many were written.
        """
        _m.require_number("half_life_days", half_life_days, positive=True)
        now = _ops.parse_time(now, "now")
        _require_flag("dry_run", dry_run)
        at = aware(now) if now is not None else _now()
        _require_not_future("now", at, "decay scores items as of")
        ns = self._c.namespace
        reader = await self._c._reader()
        relations = await _m.scan_relations(reader, ns)
        degree: dict[str, int] = {}
        for rel in relations:
            for eid in (rel.from_entity, rel.to_entity):
                degree[eid] = degree.get(eid, 0) + 1
        rel_scores = {
            r.id: _m.relevance_score((r.created_at, r.event_time), at, half_life_days, r.source_count)
            for r in relations
        }
        entities = await _m.scan_entities(reader, ns)
        ent_scores = {
            e.id: _m.relevance_score(
                (e.created_at, e.updated_at), at, half_life_days, e.source_count + degree.get(e.id, 0)
            )
            for e in entities
        }
        result = DecayResult(
            dry_run=dry_run, half_life_days=half_life_days, now=at, entities=ent_scores, relations=rel_scores
        )
        if dry_run:
            return result
        stamp = to_iso(at)
        stale_entities = [e.id for e in entities if (e.relevance, to_iso(e.relevance_at)) != (ent_scores[e.id], stamp)]
        stale_relations = [r for r in relations if (r.relevance, to_iso(r.relevance_at)) != (rel_scores[r.id], stamp)]
        for batch in _ops._batches(stale_entities):
            scores = {eid: ent_scores[eid] for eid in batch}
            result.updated_entities += await self._c._write(_m.write_entity_relevance, scores, at)
        for batch in _ops._batches(stale_relations):
            scores = {r.id: rel_scores[r.id] for r in batch}
            result.updated_relations += await self._c._write(_m.write_relation_relevance, batch, scores, at)
        return result

    async def prune(
        self,
        *,
        min_relevance: float | None = None,
        older_than: datetime | str | None = None,
        types: list[str] | None = None,
        relation_types: list[str] | None = None,
        dry_run: bool = True,
    ) -> PruneResult:
        """Remove entities and current relations that are below a relevance or older than a time.

        Every given criterion must hold. An item never scored by decay has no relevance and never
        matches min_relevance. types narrows the entities to these entity types and relation_types the
        relations to these relation types; neither is a criterion on its own. Given only one of them, the
        other kind is not matched directly, so types alone removes no relation except those of a removed
        entity, and relation_types alone removes no entity. Removal goes through the normal deletes, so a
        removed entity takes its relations, evidence, preferences, and decisions with it; those cascaded
        relations are listed too. Only current relations are matched: a relation a contradiction invalidated stays
        as history unless its entity is removed, which deletes every version. Removal runs in batches
        of up to 1000 ids per transaction.

        @param min_relevance (float | None): remove items whose relevance is below this.
        @param older_than (datetime | str | None): remove items whose latest timestamp is before this; at most one
            minute ahead.
        @param types (list[str] | None): only consider entities of these types.
        @param relation_types (list[str] | None): only consider relations of these types.
        @param dry_run (bool): list what would be removed without removing it; True by default.
        @return (PruneResult): the entity and relation ids removed, or that would be, and delete counts (no
            deleted block on a dry run); with min_relevance and nothing scored yet, a note says to run decay first.
        """
        if min_relevance is not None:
            _m.require_number("min_relevance", min_relevance, upper=1)
        older_than = _ops.parse_time(older_than, "older_than")
        cutoff = None if older_than is None else aware(older_than)
        if cutoff is not None:
            _require_not_future("older_than", cutoff, "prune removes items older than")
        for name, value in (("types", types), ("relation_types", relation_types)):
            if value is not None:
                _ops._require_list(name, value)
        _require_flag("dry_run", dry_run)
        if min_relevance is None and older_than is None:
            raise ValidationError("prune needs min_relevance or older_than; types and relation_types only narrow them")
        narrowed = types is not None or relation_types is not None
        entity_types = {_ops._clean_text(t) for t in types or ()} if narrowed else None
        rel_types = {normalize_rel_type(t) for t in relation_types or ()} if narrowed else None

        def matches(relevance: float | None, stamps: tuple, kind: str, allowed: set[str] | None) -> bool:
            if allowed is not None and kind not in allowed:
                return False
            if min_relevance is not None and (relevance is None or relevance >= min_relevance):
                return False
            return cutoff is None or _m.epoch_ms(_m.latest(stamps)) < _m.epoch_ms(cutoff)

        ns = self._c.namespace
        reader = await self._c._reader()
        relations = await _m.scan_relations(reader, ns)
        entities = await _m.scan_entities(reader, ns)
        doomed = sorted(
            e.id for e in entities if matches(e.relevance, (e.created_at, e.updated_at), e.type, entity_types)
        )
        gone = set(doomed)
        cascaded = {r.id for r in relations if r.from_entity in gone or r.to_entity in gone}
        direct = sorted(
            r.id
            for r in relations
            if r.id not in cascaded and matches(r.relevance, (r.created_at, r.event_time), r.type, rel_types)
        )
        result = PruneResult(dry_run=dry_run, entity_ids=doomed, relation_ids=sorted(cascaded | set(direct)))
        if min_relevance is not None and all(item.relevance is None for item in (*entities, *relations)):
            result.note = _UNSCORED
        if dry_run:
            return result
        counts = dict(_ops._NO_DELETES)
        for op, ids in ((_ops.delete_entities, doomed), (_ops.delete_relations, direct)):
            for batch in _ops._batches(ids):
                _m.add_counts(counts, await self._c._write(op, batch))
        result.deleted = DeleteResult(**counts)
        _log.info(
            "pruned %d entities and %d relations in namespace %r (min_relevance=%s, older_than=%s, types=%s, "
            "relation_types=%s)",
            len(doomed),
            len(result.relation_ids),
            ns,
            min_relevance,
            json_iso(cutoff),
            types,
            relation_types,
        )
        return result

    async def dedupe_relations(self, *, dry_run: bool = True) -> DedupeResult:
        """Collapse parallel current relations with the same endpoints and type but different ids into one.

        The survivor of each group is the lowest id, whichever is newer, and only its version history is
        kept: every version of each duplicate is deleted, and the plan lists how many per duplicate in
        versions_lost (the result's note states the rule). Properties are unioned: the survivor wins a
        conflict, then each duplicate in id order, and every key a duplicate loses is reported in the group's
        conflicts. The survivor takes the earliest event_time of the group, the duplicates' evidence moves
        onto it (recounting its distinct sources), decisions that used a duplicate as a step are repointed
        to it, and the duplicates are then deleted. Relations a contradiction invalidated are never grouped.

        @param dry_run (bool): list the groups without merging them; True by default.
        @return (DedupeResult): each group's survivor, duplicates, conflicting keys, and versions lost per
            duplicate, the survivor rule, and delete counts (no deleted block on a dry run).
        """
        _require_flag("dry_run", dry_run)
        ns = self._c.namespace
        reader = await self._c._reader()
        groups: dict[tuple[str, str, str], list[Relation]] = {}
        for rel in await _m.scan_relations(reader, ns):
            groups.setdefault((rel.from_entity, rel.type, rel.to_entity), []).append(rel)
        plan = []
        for (f, t, to), rels in sorted(groups.items()):
            if len(rels) < 2:
                continue
            survivor, *duplicates = sorted(rels, key=lambda r: r.id)
            _, conflicts = _m.fold_properties(survivor, duplicates)
            plan.append(
                DedupeGroup(
                    from_entity=f,
                    type=t,
                    to_entity=to,
                    survivor=survivor.id,
                    duplicates=[r.id for r in duplicates],
                    conflicts=conflicts,
                    versions_lost={
                        r.id: len(await _ops.list_relation_versions(reader, ns, r.id, newest_first=False))
                        for r in duplicates
                    },
                )
            )
        result = DedupeResult(dry_run=dry_run, groups=plan, note=_SURVIVOR_RULE if plan else None)
        if dry_run:
            return result
        counts = dict(_ops._NO_DELETES)
        for group in plan:
            _m.add_counts(counts, await self._c._write(_m.merge_relations, group.survivor, group.duplicates))
        result.deleted = DeleteResult(**counts)
        _log.info(
            "deduplicated %d relation groups in namespace %r, removing %d duplicates",
            len(plan),
            ns,
            sum(len(g.duplicates) for g in plan),
        )
        return result
