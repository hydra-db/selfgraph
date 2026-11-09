from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from typing import Any, Literal, Protocol, get_args, runtime_checkable

from pydantic import BaseModel

from . import _ops
from . import ids as _ids
from ._serde import (
    L_ENTITY,
    L_EVIDENCE,
    L_MERGE,
    L_TRACE,
    _dumps,
    _loads,
    decode_entity,
    decode_evidence,
    from_iso,
    json_iso,
    now,
    to_iso,
)
from .errors import LLM_HINT, NotFoundError, ValidationError
from .extraction.extractor import _FALLBACK_TYPE
from .llm.base import resolve_llm
from .models import (
    DecisionTraceInput,
    Entity,
    EntityInput,
    InsertWarning,
    LLMConfig,
    MergeRecord,
    MergeRewrite,
    Ontology,
    PreferenceInput,
    RelationInput,
    UnmergeResult,
)
from .protocols import LLMClient
from .retrieval import _fold, _tokens
from .schema import Schema, _entity_index, _lineage, _require_mode

__all__ = [
    "EntityResolver",
    "ResolutionDecision",
    "DefaultResolver",
    "LLMResolver",
    "ResolverMode",
    "as_resolver",
    "require_resolver",
    "jaro_winkler",
    "token_jaccard",
    "name_similarity",
]

ResolverMode = Literal["exact", "default", "fuzzy", "llm"]

_DEFAULT_THRESHOLD = 0.92
_DEFAULT_BAND = (0.8, 0.92)
_MAX_QUESTIONS = 3
_ALIAS_CONFIDENCE = 0.95
_PREFIX_LIMIT = 4
_PREFIX_SCALE = 0.1
_GENERATIONAL = frozenset({"jr", "sr", "ii", "iii", "iv"})
_LLM_SYSTEM = (
    "You decide whether two mentions name the same real-world entity. Answer same=true only when you are "
    "confident they are the same entity; different entities with similar names are not the same."
)


class ResolutionDecision(BaseModel):
    target_id: str | None = None
    confidence: float | None = None
    reason: str | None = None


@runtime_checkable
class EntityResolver(Protocol):
    async def resolve(self, candidate: EntityInput, existing: Sequence[Entity]) -> ResolutionDecision: ...


class _SameEntity(BaseModel):
    same: bool


def jaro_winkler(a: str, b: str) -> float:
    """Score two strings by Jaro-Winkler similarity over code points, with the prefix bonus capped at four.

    @param a (str): the first string.
    @param b (str): the second string.
    @return (float): the similarity in [0, 1].
    """
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    window = max(max(la, lb) // 2 - 1, 0)
    a_hit = [False] * la
    b_hit = [False] * lb
    matches = 0
    for i, ch in enumerate(a):
        for j in range(max(0, i - window), min(lb, i + window + 1)):
            if not b_hit[j] and b[j] == ch:
                a_hit[i] = b_hit[j] = True
                matches += 1
                break
    if not matches:
        return 0.0
    transposed = 0
    j = 0
    for i in range(la):
        if a_hit[i]:
            while not b_hit[j]:
                j += 1
            if a[i] != b[j]:
                transposed += 1
            j += 1
    jaro = (matches / la + matches / lb + (matches - transposed / 2) / matches) / 3
    prefix = 0
    for x, y in zip(a[:_PREFIX_LIMIT], b[:_PREFIX_LIMIT], strict=False):
        if x != y:
            break
        prefix += 1
    return jaro + prefix * _PREFIX_SCALE * (1 - jaro)


def token_jaccard(a: str, b: str) -> float:
    """Score two texts by the Jaccard overlap of their casefolded content tokens.

    @param a (str): the first text.
    @param b (str): the second text.
    @return (float): the overlap in [0, 1], 0 when either side has no tokens.
    """
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def name_similarity(a: str, b: str) -> float:
    """Score two entity names lexically: the higher of folded Jaro-Winkler and token Jaccard.

    @param a (str): the first name.
    @param b (str): the second name.
    @return (float): the similarity in [0, 1].
    """
    return max(jaro_winkler(_fold(a.strip()), _fold(b.strip())), token_jaccard(a, b))


def _words(name: str) -> list[str]:
    """Split a name into its folded word tokens.

    @param name (str): the entity name.
    @return (list[str]): the folded letter and digit runs, in order.
    """
    return re.findall(r"[^\W_]+", _fold(name.strip()))


def _distinguishers(words: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Collect the tokens that tell apart otherwise similar names: digit runs, single-letter words, and generations.

    @param words (list[str]): the name's folded word tokens.
    @return (tuple[list[str], list[str], list[str]]): the sorted digit runs, the sorted single-letter word tokens,
        and the sorted generational suffixes (Jr, Sr, II, III, IV).
    """
    digits = [d for w in words for d in re.findall(r"\d+", w)]
    letters = [t for t in words if len(t) == 1 and not t.isdecimal()]
    generations = [t for t in words if t in _GENERATIONAL]
    return sorted(digits), sorted(letters), sorted(generations)


def _covered(words: list[str], others: list[str], threshold: float) -> bool:
    """Report whether every word has a counterpart among the other name's words.

    A counterpart is a word one of the two starts with (an initial or a short form) or one whose Jaro-Winkler
    similarity reaches the threshold.

    @param words (list[str]): the folded words that need a counterpart.
    @param others (list[str]): the other name's folded words.
    @param threshold (float): the per-word similarity a counterpart needs.
    @return (bool): True when every word has a counterpart.
    """
    return all(
        any(w.startswith(o) or o.startswith(w) or jaro_winkler(w, o) >= threshold for o in others) for w in words
    )


def distinct_names(a: str, b: str, threshold: float = _DEFAULT_THRESHOLD) -> bool:
    """Report whether two similar names carry different distinguishing tokens, so they must not merge by similarity.

    Names differ when their digit runs differ as multisets (Employee1 and Employee2, Project 12 and Project 13),
    when their generational suffixes (Jr, Sr, II, III, IV) differ (Bobby Tables Jr and Bobby Tables), when both
    have single-letter words and those differ (Model A and Model B), or when both have several words and a word of
    the shorter name (of either, at equal length) has no counterpart in the other: no word that starts
    with it or that it starts with, and none within the threshold by Jaro-Winkler. So Katherine Zorkfuzzy and
    Katherine Zorkdefault differ, while Jon Smithers and Jonathan Smithers do not.

    @param a (str): the first name.
    @param b (str): the second name.
    @param threshold (float): the per-word Jaro-Winkler similarity that counts as the same word.
    @return (bool): True when a similarity or LLM merge between the names is not allowed.
    """
    words_a, words_b = _words(a), _words(b)
    digits_a, letters_a, generations_a = _distinguishers(words_a)
    digits_b, letters_b, generations_b = _distinguishers(words_b)
    if digits_a != digits_b or generations_a != generations_b or (letters_a and letters_b and letters_a != letters_b):
        return True
    if len(words_a) < 2 or len(words_b) < 2:
        return False
    return (len(words_a) <= len(words_b) and not _covered(words_a, words_b, threshold)) or (
        len(words_b) <= len(words_a) and not _covered(words_b, words_a, threshold)
    )


def _surface_match(candidate: EntityInput, ent: Entity) -> bool:
    """Report whether any of the candidate's name and aliases matches the entity's name or one of its aliases.

    @param candidate (EntityInput): the candidate entity.
    @param ent (Entity): the existing entity.
    @return (bool): True on a folded match.
    """
    forms = {_fold(f.strip()) for f in (ent.name, *ent.aliases)}
    return any(_fold(f.strip()) in forms for f in (candidate.name, *candidate.aliases))


def _no_match() -> ResolutionDecision:
    return ResolutionDecision(target_id=None, confidence=0.0, reason="no_match")


class DefaultResolver:
    def __init__(self, *, fuzzy: bool = False, threshold: float = _DEFAULT_THRESHOLD) -> None:
        """An LLM-free resolver: id, external id, and alias matches merge; lexical similarity merges when fuzzy.

        @param fuzzy (bool): also merge same-type names whose similarity reaches the threshold, and within one batch.
        @param threshold (float): the similarity a fuzzy merge needs, in (0, 1].
        """
        _require_unit("threshold", threshold, open_low=True)
        self.fuzzy = bool(fuzzy)
        self.threshold = float(threshold)

    @property
    def within_batch(self) -> bool:
        """Whether entities earlier in the same insert are offered as merge targets: only when fuzzy.

        @return (bool): True when fuzzy.
        """
        return self.fuzzy

    async def resolve(self, candidate: EntityInput, existing: Sequence[Entity]) -> ResolutionDecision:
        return self.decide(candidate, existing)

    def score(self, candidate: EntityInput, ent: Entity) -> tuple[float, str] | None:
        """Score one existing entity as the candidate's merge target by the first signal that fires.

        @param candidate (EntityInput): the candidate entity.
        @param ent (Entity): the existing entity.
        @return (tuple[float, str] | None): the confidence and reason, or None when no signal fires.
        """
        ctype = _ops._clean_text(candidate.type)
        if ctype == _FALLBACK_TYPE and ent.type != ctype:
            return (_ALIAS_CONFIDENCE, "alias") if _surface_match(candidate, ent) else None
        if (candidate.id or _ids.entity_id(ctype, _ops._clean_text(candidate.name))) == ent.id:
            return 1.0, "id"
        if any(candidate.external_ids.get(key) == value for key, value in ent.external_ids.items()):
            return 1.0, "external_id"
        if _surface_match(candidate, ent):
            return _ALIAS_CONFIDENCE, "alias"
        if self.fuzzy and ctype == ent.type and not distinct_names(candidate.name, ent.name, self.threshold):
            similarity = name_similarity(candidate.name, ent.name)
            if similarity >= self.threshold:
                return similarity, "similarity"
        return None

    def decide(self, candidate: EntityInput, existing: Sequence[Entity]) -> ResolutionDecision:
        """Pick the merge target: highest confidence, ties to the lexicographically smallest id.

        Signal 3 (alias) matches any candidate surface form (name or alias) against any target surface form, so a
        candidate alias equal to two entities' names or aliases ties at the alias confidence and the smallest id wins.

        @param candidate (EntityInput): the candidate entity.
        @param existing (Sequence[Entity]): the type-compatible entities it may merge into.
        @return (ResolutionDecision): the decision, with target_id None when nothing matches.
        """
        scored = ((self.score(candidate, ent), ent.id) for ent in existing)
        found = ((s[0], eid, s[1]) for s, eid in scored if s is not None)
        best = min(found, key=lambda b: (-b[0], b[1]), default=None)
        if best is None:
            return _no_match()
        return ResolutionDecision(target_id=best[1], confidence=best[0], reason=best[2])


class LLMResolver:
    within_batch = True

    def __init__(
        self,
        llm: LLMConfig | LLMClient,
        *,
        band: tuple[float, float] = _DEFAULT_BAND,
        max_questions: int = _MAX_QUESTIONS,
    ) -> None:
        """A resolver that asks the LLM a yes/no question for same-type names in a middle similarity band.

        Signals 1 to 3 and similarity at or above the band's top merge without asking; below the band's
        bottom nothing merges, so the LLM never merges an entity without a lexical candidate. Names whose digit runs
        or single-letter words differ, or whose words have no counterpart within the band's bottom, are never merged
        by similarity or asked about (see distinct_names).

        @param llm (LLMConfig | LLMClient): the LLM to ask.
        @param band (tuple[float, float]): the low and high similarity bounds; low <= score < high is asked.
        @param max_questions (int): the most LLM calls per candidate, highest similarity first.
        """
        client = resolve_llm(llm)
        if client is None:
            raise ValidationError("LLMResolver needs an LLM; pass an LLMConfig or an LLMClient")
        if not isinstance(band, tuple | list) or len(band) != 2:
            raise ValidationError(f"band must be a (low, high) pair, got {band!r}")
        low, high = band
        _require_unit("band low", low, open_low=False)
        _require_unit("band high", high, open_low=True)
        if not low < high:
            raise ValidationError(f"band low must be below band high, got {band!r}")
        _ops._require_int("max_questions", max_questions)
        if max_questions < 1:
            raise ValidationError(f"max_questions must be >= 1, got {max_questions}")
        self._llm = client
        self.band = (float(low), float(high))
        self.max_questions = max_questions
        self._lexical = DefaultResolver(fuzzy=True, threshold=high)

    async def resolve(self, candidate: EntityInput, existing: Sequence[Entity]) -> ResolutionDecision:
        """Decide lexically, then ask the LLM about same-type names in the band, highest similarity first.

        @param candidate (EntityInput): the candidate entity.
        @param existing (Sequence[Entity]): the type-compatible entities it may merge into.
        @return (ResolutionDecision): the decision, with reason "llm" when the LLM confirmed it.
        """
        decision = self._lexical.decide(candidate, existing)
        if decision.target_id is not None:
            return decision
        low, high = self.band
        ctype = _ops._clean_text(candidate.type)
        scored = [
            (name_similarity(candidate.name, ent.name), ent)
            for ent in existing
            if ent.type == ctype and not distinct_names(candidate.name, ent.name, low)
        ]
        band = sorted(((s, e) for s, e in scored if low <= s < high), key=lambda pair: (-pair[0], pair[1].id))
        for similarity, ent in band[: self.max_questions]:
            answer = await self._llm.generate(system=_LLM_SYSTEM, user=_question(candidate, ent), output=_SameEntity)
            if answer.same:
                return ResolutionDecision(target_id=ent.id, confidence=similarity, reason="llm")
        return _no_match()


def _question(candidate: EntityInput, ent: Entity) -> str:
    """Render the yes/no question for one candidate and one existing entity.

    @param candidate (EntityInput): the candidate entity.
    @param ent (Entity): the existing entity.
    @return (str): the user prompt.
    """

    def describe(type_: str, name: str, aliases: Sequence[str]) -> str:
        extra = f" (also known as {', '.join(aliases)})" if aliases else ""
        return f"{type_} {name!r}{extra}"

    return (
        f"Mention A: {describe(candidate.type, candidate.name, candidate.aliases)}\n"
        f"Mention B: {describe(ent.type, ent.name, ent.aliases)}\n"
        "Do A and B name the same entity?"
    )


def _require_unit(name: str, value: Any, *, open_low: bool) -> None:
    """Validate a number lies in the unit interval, optionally excluding zero.

    @param name (str): the parameter name for the message.
    @param value (Any): the value.
    @param open_low (bool): reject zero when True.
    @return (None): nothing; raises ValidationError when out of range.
    """
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise ValidationError(f"{name} must be a number, got {type(value).__name__}")
    if value > 1 or value < 0 or (open_low and value == 0):
        bounds = "(0, 1]" if open_low else "[0, 1]"
        raise ValidationError(f"{name} must be in {bounds}, got {value}")


def require_resolver(value: Any) -> None:
    """Reject a resolver argument that is neither a mode name nor an object with a resolve method.

    @param value (Any): the resolver argument.
    @return (None): nothing; raises ValidationError on anything else.
    """
    if isinstance(value, str):
        _require_mode("resolver", value, get_args(ResolverMode))
        return
    if not callable(getattr(value, "resolve", None)):
        raise ValidationError(
            f"resolver must be 'exact', 'default', 'fuzzy', 'llm', or an EntityResolver, got {type(value).__name__}"
        )


def as_resolver(value: Any, llm: LLMClient | None) -> EntityResolver | None:
    """Turn a resolver argument into a resolver, or None for exact matching.

    @param value (Any): "exact", "default", "fuzzy", "llm", or an EntityResolver.
    @param llm (LLMClient | None): the graph's LLM, needed for "llm".
    @return (EntityResolver | None): the resolver, or None for "exact".
    """
    require_resolver(value)
    if value == "exact":
        return None
    if value == "default":
        return DefaultResolver()
    if value == "fuzzy":
        return DefaultResolver(fuzzy=True)
    if value == "llm":
        if llm is None:
            raise ValidationError(f"resolver 'llm' needs an LLM: {LLM_HINT}")
        return LLMResolver(llm)
    return value


def compatible_types(etype: str, schema: Schema | None) -> set[str]:
    """The entity type names a type may merge with: itself, plus its schema ancestors and descendants with aliases.

    @param etype (str): the cleaned entity type.
    @param schema (Schema | None): the active schema.
    @return (set[str]): the compatible type names.
    """
    out = {etype}
    if schema is None:
        return out
    index = _entity_index(schema)
    own = index.get(etype)
    if own is None:
        return out
    related = {t.name for t in _lineage(own, index)}
    for ent in schema.entities:
        if own.name in {t.name for t in _lineage(ent, index)}:
            related.add(ent.name)
    for ent in schema.entities:
        if ent.name in related:
            out.update([ent.name, *ent.aliases])
    return out


@dataclass
class _Merge:
    absorbed_id: str
    survivor_id: str
    candidate: EntityInput
    decision: ResolutionDecision
    added_aliases: list[str] = field(default_factory=list)
    added_external_ids: list[str] = field(default_factory=list)
    added_properties: list[str] = field(default_factory=list)
    rewrites: list[MergeRewrite] = field(default_factory=list)

    def note(self, added: tuple[list[str], list[str], list[str]]) -> None:
        """Record the aliases, external id keys, and property keys a fold added to the survivor.

        @param added (tuple[list[str], list[str], list[str]]): what _absorb_into returned.
        @return (None): nothing.
        """
        self.added_aliases += added[0]
        self.added_external_ids += added[1]
        self.added_properties += added[2]


@dataclass
class Resolution:
    ontology: Ontology
    merges: list[_Merge] = field(default_factory=list)
    warnings: list[InsertWarning] = field(default_factory=list)


def _view(ent: EntityInput, eid: str, etype: str, ename: str, at: datetime) -> Entity:
    """An in-memory entity for a batch input, so later candidates can match it.

    @param ent (EntityInput): the input.
    @param eid (str): its id.
    @param etype (str): its cleaned type.
    @param ename (str): its cleaned name.
    @param at (datetime): the insert time.
    @return (Entity): the view.
    """
    return Entity(
        id=eid,
        type=etype,
        name=ename,
        aliases=_ops._alias_list(ename, ent.aliases),
        external_ids=dict(ent.external_ids),
        properties=dict(ent.properties),
        created_at=at,
        updated_at=at,
    )


def _absorb_into(
    view: Entity, ent: EntityInput, ename: str, *, merge: bool = True
) -> tuple[list[str], list[str], list[str]]:
    """Fold an input into an in-memory view; a merge only fills keys the view lacks, so the survivor's values win.

    @param view (Entity): the target view, updated in place.
    @param ent (EntityInput): the input being folded in.
    @param ename (str): the input's cleaned name.
    @param merge (bool): fold as a merge (fill missing keys only) rather than as an upsert of the same id (input wins).
    @return (tuple[list[str], list[str], list[str]]): the aliases, external id keys, and property keys the view did not
        have.
    """
    aliases = [f for f in _ops._alias_list(view.name, [ename, *ent.aliases]) if f not in view.aliases]
    external = [k for k in ent.external_ids if k not in view.external_ids]
    props = [k for k, v in _ops._canon_props(ent.properties).items() if k not in view.properties and v is not None]
    view.aliases = [*view.aliases, *aliases]
    if merge:
        view.external_ids = {**view.external_ids, **{k: ent.external_ids[k] for k in external}}
        view.properties = {**view.properties, **{k: _ops._canon_props(ent.properties)[k] for k in props}}
    else:
        view.external_ids = {**view.external_ids, **ent.external_ids}
        view.properties = _ops._merge_props(view.properties, ent.properties)
    return aliases, external, props


def _dump(model: BaseModel, **kwargs: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", **kwargs)


async def plan_resolution(
    runner: Any, ns: str, ontology: Ontology, resolver: EntityResolver, schema: Schema | None, created_at: datetime
) -> Resolution:
    """Resolve each new entity without an explicit id against compatible stored and batch entities, and rewrite refs.

    A typed candidate is offered every stored entity of its compatible types, each type read once per insert in
    id-ordered pages. A candidate of the extraction fallback type (Thing) is also offered entities of other types,
    stored and from the same batch, whose name or alias matches its own, and is resolved after the others so a typed
    entity later in the batch can absorb it; of the stored entities of other types, only those are kept in memory.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ontology (Ontology): the validated ontology.
    @param resolver (EntityResolver): the resolver.
    @param schema (Schema | None): the active schema, for parent-closure type compatibility.
    @param created_at (datetime): the insert time.
    @return (Resolution): the rewritten ontology, the merges it carries, and merge_self_loop warnings.
    """
    keyed = []
    for ent in ontology.entities:
        etype, ename = _ops._clean_text(ent.type), _ops._clean_text(ent.name)
        keyed.append((ent, ent.id or _ids.entity_id(etype, ename), etype, ename))
    stored = set(await _ops._nodes_by_id(runner, ns, L_ENTITY, _ops._dedup_list(eid for _, eid, _, _ in keyed)))
    candidate_types = {etype for ent, eid, etype, _ in keyed if ent.id is None and eid not in stored}
    if not candidate_types:
        return Resolution(ontology)
    wanted: set[str | None] = set()
    for etype in candidate_types:
        wanted |= compatible_types(etype, schema)
    if _FALLBACK_TYPE in candidate_types:
        wanted.add(None)
    fallbacks = [ent for ent, eid, etype, _ in keyed if etype == _FALLBACK_TYPE and ent.id is None]
    named = {eid for _, eid, _, _ in keyed}
    pool: dict[str, Entity] = {}
    for etype in sorted(wanted, key=str):
        fetch = partial(runner.match_nodes, ns, L_ENTITY, equals={} if etype is None else {"type": etype}, skip=0)
        async for rows in _ops._keyset(lambda after, limit, fetch=fetch: fetch(limit=limit, id_gt=after)):
            for ent in map(decode_entity, rows):
                if etype is not None or ent.id in named or any(_surface_match(c, ent) for c in fallbacks):
                    pool[ent.id] = ent

    within = bool(getattr(resolver, "within_batch", True))
    batch: dict[str, Entity] = {}
    mapping: dict[str, str] = {}
    merges: dict[str, _Merge] = {}
    entities: list[EntityInput] = list(ontology.entities)
    for i in sorted(range(len(keyed)), key=lambda i: keyed[i][2] == _FALLBACK_TYPE):
        ent, eid, etype, ename = keyed[i]
        if eid in mapping:
            merge = merges[eid]
            target = pool.get(merge.survivor_id) or batch[merge.survivor_id]
            merge.note(_absorb_into(target, ent, ename))
            entities[i] = _redirect(ent, target)
            continue
        if ent.id is not None or eid in stored or eid in batch:
            view = pool.get(eid) or batch.get(eid)
            if view is not None:
                _absorb_into(view, ent, ename, merge=False)
            elif ent.id is not None and eid not in stored:
                batch[eid] = _view(ent, eid, etype, ename, created_at)
            continue
        fallback = etype == _FALLBACK_TYPE
        compatible = compatible_types(etype, schema)
        offered = [e for e in pool.values() if e.type in compatible or (fallback and _surface_match(ent, e))]
        existing = sorted(offered, key=lambda e: e.id)
        existing += [
            e
            for e in batch.values()
            if (e.type in compatible and within) or (fallback and e.type not in compatible and _surface_match(ent, e))
        ]
        decision = await resolver.resolve(ent, existing)
        if not isinstance(decision, ResolutionDecision):
            raise ValidationError(f"a resolver must return a ResolutionDecision, got {type(decision).__name__}")
        if decision.target_id is None:
            batch[eid] = _view(ent, eid, etype, ename, created_at)
            continue
        for name in ("confidence", "reason"):
            if getattr(decision, name) is None:
                raise ValidationError(
                    f"resolver decision merging {eid!r} into {decision.target_id!r} is missing {name}; "
                    "a decision with a target_id needs confidence and reason"
                )
        target = next((e for e in existing if e.id == decision.target_id), None)
        if target is None:
            raise ValidationError(
                f"resolver chose {decision.target_id!r} for {eid!r}, "
                "which is not one of the compatible entities it was offered"
            )
        mapping[eid] = target.id
        merges[eid] = _Merge(eid, target.id, ent, decision)
        merges[eid].note(_absorb_into(target, ent, ename))
        entities[i] = _redirect(ent, target)
    if not mapping:
        return Resolution(ontology)
    warnings: list[InsertWarning] = []
    rewritten = await _rewrite_refs(runner, ns, ontology, mapping, merges, warnings)
    return Resolution(rewritten.model_copy(update={"entities": entities}), list(merges.values()), warnings)


def _redirect(ent: EntityInput, target: Entity) -> EntityInput:
    """The input that folds a merged candidate into its target through the normal upsert alias path.

    @param ent (EntityInput): the candidate, already folded into the target view.
    @param target (Entity): the target view, whose values win for every key the candidate shares with it.
    @return (EntityInput): an input with the target's id and type, the candidate's surface forms, and the target's
        values for the candidate's external id and property keys.
    """
    return EntityInput(
        id=target.id,
        type=target.type,
        name=ent.name,
        aliases=list(ent.aliases),
        external_ids={k: target.external_ids[k] for k in ent.external_ids},
        properties={k: target.properties[k] for k in ent.properties if k in target.properties},
    )


async def _rewrite_refs(
    runner: Any,
    ns: str,
    ontology: Ontology,
    mapping: dict[str, str],
    merges: dict[str, _Merge],
    warnings: list[InsertWarning],
) -> Ontology:
    """Point every reference to a merged candidate at its target and record each rewrite on the merges it involves.

    A relation between two different entities that the merge would join into a self-loop is dropped, with a
    merge_self_loop warning; its rewrite is still recorded, marked dropped, so unmerging restores it.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ontology (Ontology): the ontology.
    @param mapping (dict[str, str]): candidate id to target id.
    @param merges (dict[str, _Merge]): the merges by candidate id.
    @param warnings (list[InsertWarning]): receives one merge_self_loop warning per dropped relation.
    @return (Ontology): the ontology with rewritten relations, preferences, and decisions.
    """

    def m(eid: str | None) -> str | None:
        return mapping.get(eid, eid) if eid is not None else None

    def note(rewrite: MergeRewrite, refs: set[str]) -> None:
        for eid in sorted(refs & mapping.keys()):
            merges[eid].rewrites.append(rewrite)

    def rid_of(rel: RelationInput) -> str:
        return rel.id or _ids.relation_id(rel.from_entity, rel.type, rel.to_entity)

    touched = [rel.from_entity in mapping or rel.to_entity in mapping for rel in ontology.relations]
    kept_rids = {rid_of(rel) for rel, hit in zip(ontology.relations, touched, strict=True) if not hit}
    rel_map: dict[str, str] = {}
    rel_refs: dict[str, set[str]] = {}
    dropped: set[str] = set()
    relations = []
    for rel, hit in zip(ontology.relations, touched, strict=True):
        if not hit:
            relations.append(rel)
            continue
        new = rel.model_copy(update={"from_entity": m(rel.from_entity), "to_entity": m(rel.to_entity)})
        old_id, new_id = rid_of(rel), rid_of(new)
        refs = {rel.from_entity, rel.to_entity}
        rel_refs[old_id] = refs
        existed = new_id in kept_rids or await _ops.relation_exists(runner, ns, new_id)
        original, rewritten = _dump(rel, exclude={"evidence"}), _dump(new, exclude={"evidence"})
        loop = new.from_entity == new.to_entity and rel.from_entity != rel.to_entity
        rewrite = MergeRewrite(
            kind="relation", id=new_id, original=original, rewritten=rewritten, existed=existed, dropped=loop
        )
        note(rewrite, refs)
        if loop:
            dropped.add(old_id)
            warnings.append(
                InsertWarning(
                    code="merge_self_loop",
                    message=f"relation {old_id} ({rel.from_entity} -{rel.type}-> {rel.to_entity}) would join "
                    f"{new.from_entity} to itself after a merge and was dropped; unmerging restores it",
                )
            )
            continue
        rel_map[old_id] = new_id
        relations.append(new)

    preferences = []
    for pref in ontology.preferences:
        refs = {pref.subject_entity, pref.value_entity, *([pref.about_entity] if pref.about_entity else [])}
        if not refs & mapping.keys():
            preferences.append(pref)
            continue
        new = pref.model_copy(
            update={
                "subject_entity": m(pref.subject_entity),
                "value_entity": m(pref.value_entity),
                "about_entity": m(pref.about_entity),
            }
        )
        new_id = new.id or _ids.preference_id(new.subject_entity, new.kind, new.key, new.value_entity)
        existed = await _ops.preference_exists(runner, ns, new_id)
        note(
            MergeRewrite(kind="preference", id=new_id, original=_dump(pref), rewritten=_dump(new), existed=existed),
            refs,
        )
        preferences.append(new)

    decisions = []
    for dec in ontology.decisions:
        refs = {r for r in (dec.actor_entity, dec.outcome_entity, *dec.alternative_entities) if r is not None}
        for step in dec.steps:
            refs |= rel_refs.get(step, set())
        if not refs & mapping.keys():
            decisions.append(dec)
            continue
        new = dec.model_copy(
            update={
                "actor_entity": m(dec.actor_entity),
                "outcome_entity": m(dec.outcome_entity),
                "alternative_entities": [m(a) for a in dec.alternative_entities],
                "steps": [rel_map.get(s, s) for s in dec.steps if s not in dropped],
            }
        )
        new_id = new.id or _ids.decision_id(new.actor_entity, new.title)
        existed = await runner.node_exists(ns, L_TRACE, new_id)
        note(MergeRewrite(kind="decision", id=new_id, original=_dump(dec), rewritten=_dump(new), existed=existed), refs)
        decisions.append(new)
    return ontology.model_copy(update={"relations": relations, "preferences": preferences, "decisions": decisions})


def _encode_merge(ns: str, rec: MergeRecord) -> dict[str, Any]:
    return {
        "id": rec.id,
        "ns": ns,
        "survivor_id": rec.survivor_id,
        "absorbed_id": rec.absorbed_id,
        "reason": rec.reason,
        "confidence": rec.confidence,
        "source_id": rec.source_id,
        "source_ids_json": _dumps(rec.source_ids),
        "absorbed_json": _dumps(rec.absorbed),
        "added_aliases_json": _dumps(rec.added_aliases),
        "added_external_ids_json": _dumps(rec.added_external_ids),
        "added_properties_json": _dumps(rec.added_properties),
        "rewrites_json": _dumps([_dump(r) for r in rec.rewrites]),
        "created_at": to_iso(rec.created_at),
        "reverted_at": to_iso(rec.reverted_at),
    }


def _decode_merge(props: dict[str, Any]) -> MergeRecord:
    return MergeRecord(
        id=props["id"],
        survivor_id=props["survivor_id"],
        absorbed_id=props["absorbed_id"],
        absorbed=_loads(props.get("absorbed_json"), {}),
        reason=props.get("reason") or "",
        confidence=float(props.get("confidence") or 0.0),
        source_id=props.get("source_id"),
        source_ids=_loads(props.get("source_ids_json"), [props["source_id"]] if props.get("source_id") else []),
        added_aliases=_loads(props.get("added_aliases_json"), []),
        added_external_ids=_loads(props.get("added_external_ids_json"), []),
        added_properties=_loads(props.get("added_properties_json"), []),
        rewrites=_loads(props.get("rewrites_json"), []),
        created_at=from_iso(props["created_at"]),
        reverted_at=from_iso(props.get("reverted_at")),
    )


async def save_merges(
    runner: Any, ns: str, resolution: Resolution, *, source_id: str | None, created_at: datetime
) -> list[MergeRecord]:
    """Write one record per merge, folding a repeat of the same merge into its live record so inserts stay idempotent.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param resolution (Resolution): the planned merges.
    @param source_id (str | None): the inserted source, if any.
    @param created_at (datetime): the insert time.
    @return (list[MergeRecord]): the stored records, in candidate order.
    """
    if not resolution.merges:
        return []
    keyed = [(_ids.entity_merge_id(m.survivor_id, m.absorbed_id), m) for m in resolution.merges]
    stored = await _ops._nodes_by_id(runner, ns, L_MERGE, [mid for mid, _ in keyed])
    records = []
    for mid, merge in keyed:
        absorbed = _dump(merge.candidate)
        absorbed["id"] = merge.absorbed_id
        rec = MergeRecord(
            id=mid,
            survivor_id=merge.survivor_id,
            absorbed_id=merge.absorbed_id,
            absorbed=absorbed,
            reason=merge.decision.reason,
            confidence=merge.decision.confidence,
            source_id=source_id,
            source_ids=[] if source_id is None else [source_id],
            added_aliases=merge.added_aliases,
            added_external_ids=merge.added_external_ids,
            added_properties=merge.added_properties,
            rewrites=merge.rewrites,
            created_at=created_at,
        )
        prev = _decode_merge(stored[mid]) if mid in stored else None
        if prev is not None and prev.reverted_at is None:
            seen = {(r.kind, r.id) for r in prev.rewrites}
            rec = prev.model_copy(
                update={
                    "source_ids": _ops._dedup_list([*prev.source_ids, *rec.source_ids]),
                    "added_aliases": _ops._dedup_list([*prev.added_aliases, *merge.added_aliases]),
                    "added_external_ids": _ops._dedup_list([*prev.added_external_ids, *merge.added_external_ids]),
                    "added_properties": _ops._dedup_list([*prev.added_properties, *merge.added_properties]),
                    "rewrites": [*prev.rewrites, *(r for r in merge.rewrites if (r.kind, r.id) not in seen)],
                }
            )
        records.append(rec)
    rows = [(rec.id, _encode_merge(ns, rec)) for rec in records]
    for _, props in rows:
        await _ops._precheck_write(runner, props)
    await runner.upsert_nodes(ns, L_MERGE, rows)
    return records


def merge_warnings(records: list[MergeRecord]) -> list[InsertWarning]:
    """One entity_merged warning per merge, so callers notice that an entity was folded into another.

    @param records (list[MergeRecord]): the merges.
    @return (list[InsertWarning]): the warnings.
    """
    return [
        InsertWarning(
            code="entity_merged",
            message=(
                f"entity {rec.absorbed_id} merged into {rec.survivor_id} "
                f"({rec.reason}, confidence {rec.confidence!r}, merge id {rec.id}); undo with unmerge"
            ),
            source_id=rec.source_id,
            merge_id=rec.id,
        )
        for rec in records
    ]


async def list_merges(runner: Any, ns: str, entity_id: str, *, skip: int, limit: int) -> list[MergeRecord]:
    """List the merge records whose survivor is an entity, ordered by merge id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param entity_id (str): the surviving entity id.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[MergeRecord]): the records; raises NotFoundError for an unknown entity with no records.
    """
    entity_id = _ids.canonical_entity_id(entity_id)
    rows = await runner.match_nodes(
        ns, L_MERGE, equals={"survivor_id": entity_id}, order_by="id", skip=skip, limit=limit
    )
    if not rows and skip == 0 and not await runner.node_exists(ns, L_ENTITY, entity_id):
        raise NotFoundError("Entity", entity_id)
    return [_decode_merge(r) for r in rows]


def _moved_to(rw: MergeRewrite, new_id: str, rewritten: dict[str, Any], existed: bool) -> MergeRewrite:
    """The rewrite that records where an unmerge put the object a merge rewrite moved.

    @param rw (MergeRewrite): the replayed rewrite.
    @param new_id (str): the restored object's id.
    @param rewritten (dict[str, Any]): the restored object as written.
    @param existed (bool): whether that object was stored before the unmerge wrote it.
    @return (MergeRewrite): the rewrite at its new location.
    """
    return rw.model_copy(update={"id": new_id, "rewritten": rewritten, "existed": existed, "dropped": False})


def _forward(
    rw: MergeRewrite, moved: list[tuple[MergeRewrite, MergeRewrite]], restored: dict[str, str]
) -> MergeRewrite:
    """Point one rewrite of another merge at where an unmerge put the object it shares with that merge.

    @param rw (MergeRewrite): a rewrite of a still-live merge.
    @param moved (list[tuple[MergeRewrite, MergeRewrite]]): each rewrite the unmerge replayed, with its new location.
    @param restored (dict[str, str]): the relation ids the unmerge moved, old to new.
    @return (MergeRewrite): the rewrite to keep on that merge.
    """
    for old, new in moved:
        if (rw.kind, rw.id, rw.original) == (old.kind, old.id, old.original):
            return new
    steps = rw.rewritten.get("steps")
    if rw.kind == "decision" and isinstance(steps, list) and any(s in restored for s in steps):
        return rw.model_copy(update={"rewritten": {**rw.rewritten, "steps": [restored.get(s, s) for s in steps]}})
    return rw


async def _forward_siblings(
    runner: Any, ns: str, merge_id: str, moved: list[tuple[MergeRewrite, MergeRewrite]], restored: dict[str, str]
) -> None:
    """Update the live merges that share a rewrite with an unmerged one, so unmerging them later replays exactly.

    Merges from one insert can rewrite the same relation, preference, or decision (both endpoints merged, say).
    Once one is unmerged that object lives somewhere new, so the other merges record that location, whether it
    existed before, and the restored entity id, and undo from there.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param merge_id (str): the merge being reverted.
    @param moved (list[tuple[MergeRewrite, MergeRewrite]]): each rewrite the unmerge replayed, with its new location.
    @param restored (dict[str, str]): the relation ids the unmerge moved, old to new.
    @return (None): nothing.
    """
    rows = await _ops._paged(partial(runner.match_nodes, ns, L_MERGE, equals={}, order_by="id"))
    for props in rows:
        sib = _decode_merge(props)
        if sib.id == merge_id or sib.reverted_at is not None:
            continue
        rewrites = [_forward(rw, moved, restored) for rw in sib.rewrites]
        if rewrites != sib.rewrites:
            await runner.lock_node(ns, L_MERGE, sib.id)
            updated = sib.model_copy(update={"rewrites": rewrites})
            await runner.upsert_node(ns, L_MERGE, sib.id, _encode_merge(ns, updated))


async def unmerge(runner: Any, ns: str, merge_id: str) -> UnmergeResult:
    """Reverse one merge: recreate the absorbed entity, drop what it added to the survivor, and move references back.

    The record is replayed exactly: the absorbed entity gets back the created_at of the merge and the survivor's
    evidence from every source the merge was seen in (source_ids), which restores its source_count, a relation the merge
    dropped as a self-loop is restored, and a relation the merge created on the survivor is removed with all its
    versions, including one a contradiction retired after the merge, and its original is written back as the
    current relation of the absorbed entity. An endpoint whose own merge is still live keeps pointing at that
    merge's survivor, and that merge is updated to undo from the new location, so unmerging every merge of an
    insert, in any order, restores the relations it would have written without them. Restored relations are
    written with contradiction checks off, so an unmerge never supersedes or warns about another relation, and a
    relation the merged insert superseded stays retired until it is inserted again.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param merge_id (str): the merge record id.
    @return (UnmergeResult): the reverted record, the recreated entity, the survivor, and what was moved back.
    """
    _ids._require_str("merge id", merge_id)
    await runner.lock_node(ns, L_MERGE, merge_id)
    props = await runner.get_node(ns, L_MERGE, merge_id)
    if props is None:
        raise NotFoundError("EntityMerge", merge_id)
    rec = _decode_merge(props)
    if rec.reverted_at is not None:
        raise ValidationError(f"merge {merge_id!r} was already reverted at {json_iso(rec.reverted_at)}")
    at = now()
    absorbed_id = rec.absorbed_id
    evidence = []
    for source_id in rec.source_ids:
        fetch = partial(
            runner.match_nodes, ns, L_EVIDENCE, equals={"target_id": rec.survivor_id, "source_id": source_id}
        )
        evidence += [decode_evidence(p) for p in await _ops._paged(fetch)]

    exists = partial(runner.node_exists, ns, L_ENTITY)

    absorbed = EntityInput.model_validate({**rec.absorbed, "id": absorbed_id})
    made_at = at if await exists(absorbed_id) else rec.created_at
    [entity] = await _ops.upsert_entities(runner, ns, [absorbed], evidence=evidence, created_at=made_at)

    async def end(original: str | None, rewritten: str | None) -> str | None:
        """The reference a restored object takes: the absorbed id where the original named it, else the rewritten one.

        An original reference to another absorbed entity that has since been restored is kept as well.

        @param original (str | None): the reference as first inserted.
        @param rewritten (str | None): the reference as written after the merge.
        @return (str | None): the reference to restore.
        """
        if original is None or original in (absorbed_id, rewritten):
            return original
        return original if await exists(original) else rewritten

    restored: dict[str, str] = {}
    moved: list[tuple[MergeRewrite, MergeRewrite]] = []
    relations = []
    for rw in (r for r in rec.rewrites if r.kind == "relation"):
        original, rewritten = RelationInput.model_validate(rw.original), RelationInput.model_validate(rw.rewritten)
        live = not rw.existed and not rw.dropped
        versions = await _ops.list_relation_versions(runner, ns, rw.id, newest_first=True) if live else []
        properties, event_time, carried, touching = dict(original.properties), original.event_time, [], set()
        if versions:
            properties, event_time = versions[0].properties, versions[0].event_time
            carried = await _ops._paged(partial(_ops.list_evidence, runner, ns, rw.id, kind="relation"))
            touching = await _ops._traces_touching_relations(runner, ns, [rw.id])
            await runner.delete_edges(ns, rw.id)
            await _ops._delete_evidence(runner, ns, rw.id)
        back = RelationInput(
            id=original.id,
            from_entity=await end(original.from_entity, rewritten.from_entity),
            type=original.type,
            to_entity=await end(original.to_entity, rewritten.to_entity),
            properties=properties,
            event_time=event_time,
        )
        existed = await _ops.relation_exists(
            runner, ns, back.id or _ids.relation_id(back.from_entity, back.type, back.to_entity)
        )
        [rel] = await _ops.upsert_relations(
            runner, ns, [(back, carried)], default_event_time=None, created_at=at, contradiction="off"
        )
        restored[rw.id] = rel.id
        relations.append(rel)
        moved.append((rw, _moved_to(rw, rel.id, _dump(back, exclude={"evidence"}), existed)))
        await _ops._repoint_steps(runner, ns, touching, restored)

    preferences = []
    for rw in (r for r in rec.rewrites if r.kind == "preference"):
        original, rewritten = PreferenceInput.model_validate(rw.original), PreferenceInput.model_validate(rw.rewritten)
        current = await _ops.get_preference(runner, ns, rw.id)
        values = {"strength": original.strength, "properties": original.properties, "event_time": original.event_time}
        if current is not None and not rw.existed:
            values = {"strength": current.strength, "properties": current.properties, "event_time": current.event_time}
            await runner.delete_edges(ns, rw.id)
        back = PreferenceInput(
            id=original.id,
            subject_entity=await end(original.subject_entity, rewritten.subject_entity),
            kind=original.kind,
            key=original.key,
            value_entity=await end(original.value_entity, rewritten.value_entity),
            about_entity=await end(original.about_entity, rewritten.about_entity),
            **values,
        )
        pid = back.id or _ids.preference_id(back.subject_entity, back.kind, back.key, back.value_entity)
        existed = await _ops.preference_exists(runner, ns, pid)
        pref = await _ops.upsert_preference(runner, ns, back, default_event_time=None, created_at=at)
        preferences.append(pref)
        moved.append((rw, _moved_to(rw, pref.id, _dump(back), existed)))

    decisions = []
    for rw in (r for r in rec.rewrites if r.kind == "decision"):
        original = DecisionTraceInput.model_validate(rw.original)
        rewritten = DecisionTraceInput.model_validate(rw.rewritten)
        base = original
        current = await _ops.get_trace(runner, ns, rw.id)
        if current is not None and not rw.existed:
            base = original.model_copy(
                update={
                    "title": current.title,
                    "summary": current.summary,
                    "rationale": current.rationale,
                    "status": current.status,
                    "event_time": current.event_time,
                }
            )
            await _ops._delete_trace_quietly(runner, ns, rw.id)
        alternatives = [
            await end(o, r) for o, r in zip(original.alternative_entities, rewritten.alternative_entities, strict=True)
        ]
        back = base.model_copy(
            update={
                "steps": [restored.get(s, s) for s in rewritten.steps],
                "actor_entity": await end(original.actor_entity, rewritten.actor_entity),
                "outcome_entity": await end(original.outcome_entity, rewritten.outcome_entity),
                "alternative_entities": [a for a in alternatives if a is not None],
            }
        )
        existed = await runner.node_exists(ns, L_TRACE, back.id or _ids.decision_id(back.actor_entity, back.title))
        trace = await _ops.upsert_trace(
            runner,
            ns,
            tid=back.id,
            title=back.title,
            step_rel_ids=back.steps,
            actor_entity=back.actor_entity,
            summary=back.summary,
            rationale=back.rationale,
            outcome_entity=back.outcome_entity,
            alternative_entities=back.alternative_entities,
            status=back.status,
            event_time=back.event_time,
            created_at=at,
        )
        decisions.append(trace)
        moved.append((rw, _moved_to(rw, trace.id, _dump(back), existed)))

    if moved:
        await _forward_siblings(runner, ns, rec.id, moved, restored)
    survivor = None
    if await exists(rec.survivor_id):
        survivor = await _ops.update_entity(
            runner,
            ns,
            rec.survivor_id,
            remove_aliases=list(rec.added_aliases),
            remove_properties=list(rec.added_properties),
            remove_external_ids=rec.added_external_ids,
        )
    reverted = rec.model_copy(update={"reverted_at": at})
    await runner.upsert_node(ns, L_MERGE, reverted.id, _encode_merge(ns, reverted))
    return UnmergeResult(
        merge=reverted,
        entity=entity,
        survivor=survivor,
        relations=relations,
        preferences=preferences,
        decisions=decisions,
    )
