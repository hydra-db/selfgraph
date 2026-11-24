from __future__ import annotations

import math
import re
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache, partial
from typing import Any, Literal, Protocol, get_args, runtime_checkable

from pydantic import BaseModel

from . import _ops
from . import ids as _ids
from ._maintenance import scan_live_merges
from ._payload import context_payload
from ._serde import (
    L_ENTITY,
    L_EVIDENCE,
    L_MERGE,
    L_MERGE_ENTRY,
    L_SOURCE_VERSION,
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
from ._unicode import DECIMAL_CLASS
from .errors import ExtractionError, NotFoundError, ValidationError, needs_llm
from .extraction.extractor import _FALLBACK_TYPE
from .llm.base import resolve_llm
from .models import (
    DecisionTraceInput,
    Entity,
    EntityInput,
    Evidence,
    EvidenceInput,
    Extraction,
    InsertWarning,
    LLMConfig,
    MergeRecord,
    MergeRewrite,
    PreferenceInput,
    Relation,
    RelationInput,
    UnmergeResult,
)
from .protocols import LLMClient
from .retrieval import _fold, _tokens
from .schema import Schema, _entity_index, _lineage, _require_mode, canonical_entity_type

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

_FALLBACK_KEY = _ops.entity_type_key(_FALLBACK_TYPE)
_DEFAULT_THRESHOLD = 0.92
_DEFAULT_BAND = (0.8, 0.92)
_MAX_QUESTIONS = 3
_ALIAS_CONFIDENCE = 0.95
_PREFIX_LIMIT = 4
_PREFIX_SCALE = 0.1
_GENERATIONAL = frozenset({"jr", "sr", "ii", "iii", "iv"})
_DIGITS = re.compile(f"[{DECIMAL_CLASS}]+")
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
    return _ids._word_runs(_fold(name.strip()))


def _distinguishers(words: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Collect the tokens that tell apart otherwise similar names: digit runs, single-letter words, and generations.

    @param words (list[str]): the name's folded word tokens.
    @return (tuple[list[str], list[str], list[str]]): the sorted digit runs, the sorted single-letter word tokens,
        and the sorted generational suffixes (Jr, Sr, II, III, IV).
    """
    digits = [d for w in words for d in _DIGITS.findall(w)]
    letters = [t for t in words if len(t) == 1 and not _DIGITS.fullmatch(t)]
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


@lru_cache(maxsize=1 << 16)
def _folded_forms(name: str, aliases: tuple[str, ...]) -> frozenset[str]:
    """The folded name and aliases of an entity, cached since resolution compares each one against many.

    @param name (str): the name.
    @param aliases (tuple[str, ...]): the aliases.
    @return (frozenset[str]): the stripped, folded forms.
    """
    return frozenset(_fold(f.strip()) for f in (name, *aliases))


def _forms(ent: EntityInput | Entity) -> frozenset[str]:
    """The folded name and aliases of a candidate or an existing entity.

    @param ent (EntityInput | Entity): the entity.
    @return (frozenset[str]): the stripped, folded forms.
    """
    return _folded_forms(ent.name, tuple(ent.aliases))


def match_keys(name: str, aliases: Sequence[str], external_ids: Mapping[str, str]) -> frozenset[str]:
    """The keys an entity is indexed under for the default resolver: its folded name and aliases, and its external ids.

    Two entities share a key exactly when the default resolver's alias or external id signal can fire between them.

    @param name (str): the name.
    @param aliases (Sequence[str]): the aliases.
    @param external_ids (Mapping[str, str]): the external ids.
    @return (frozenset[str]): the keys.
    """
    forms = (f"form:{f}" for f in _folded_forms(name, tuple(aliases)))
    return frozenset((*forms, *(f"xid:{_dumps([k, v])}" for k, v in external_ids.items())))


def _surface_match(candidate: EntityInput, ent: Entity) -> bool:
    """Report whether any of the candidate's name and aliases matches the entity's name or one of its aliases.

    @param candidate (EntityInput): the candidate entity.
    @param ent (Entity): the existing entity.
    @return (bool): True on a folded match.
    """
    return not _forms(candidate).isdisjoint(_forms(ent))


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
        return self._scorer(candidate)(ent)

    def _scorer(self, candidate: EntityInput) -> Callable[[Entity], tuple[float, str] | None]:
        """Score existing entities against one candidate, deriving the candidate's type, id, and forms once.

        @param candidate (EntityInput): the candidate entity.
        @return (Callable[[Entity], tuple[float, str] | None]): score for one existing entity.
        """
        ctype = _ops._clean_text(candidate.type)
        ckey = _ops.entity_type_key(ctype)
        forms = _forms(candidate)
        derived: list[str] = []

        def cid() -> str:
            if not derived:
                derived.append(candidate.id or _ids.entity_id(ctype, _ops._clean_text(candidate.name)))
            return derived[0]

        def score(ent: Entity) -> tuple[float, str] | None:
            ekey = _ops.entity_type_key(ent.type)
            if ckey == _FALLBACK_KEY and ekey != ckey:
                return (_ALIAS_CONFIDENCE, "alias") if not forms.isdisjoint(_forms(ent)) else None
            if cid() == ent.id:
                return 1.0, "id"
            if any(candidate.external_ids.get(key) == value for key, value in ent.external_ids.items()):
                return 1.0, "external_id"
            if not forms.isdisjoint(_forms(ent)):
                return _ALIAS_CONFIDENCE, "alias"
            if self.fuzzy and ekey == ckey and not distinct_names(candidate.name, ent.name, self.threshold):
                similarity = name_similarity(candidate.name, ent.name)
                if similarity >= self.threshold:
                    return similarity, "similarity"
            return None

        return score

    def decide(self, candidate: EntityInput, existing: Sequence[Entity]) -> ResolutionDecision:
        """Pick the merge target: highest confidence, ties to the lexicographically smallest id.

        Signal 3 (alias) matches any candidate surface form (name or alias) against any target surface form, so a
        candidate alias equal to two entities' names or aliases ties at the alias confidence and the smallest id wins.

        @param candidate (EntityInput): the candidate entity.
        @param existing (Sequence[Entity]): the type-compatible entities it may merge into.
        @return (ResolutionDecision): the decision, with target_id None when nothing matches.
        """
        score = self._scorer(candidate)
        scored = ((score(ent), ent.id) for ent in existing)
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
            raise ValidationError("LLMResolver needs an LLM; pass an LLMConfig or an LLMClient", code="llm_required")
        if not isinstance(band, tuple | list) or len(band) != 2:
            raise ValidationError(f"band must be a (low, high) pair, got {band!r}")
        low, high = band
        _require_unit("band low", low, open_low=False)
        _require_unit("band high", high, open_low=True)
        if not low < high:
            raise ValidationError(f"band low must be below band high, got {band!r}")
        _ops._require_int("max_questions", max_questions)
        if max_questions < 1:
            raise ValidationError(f"max_questions must be >= 1, got {max_questions}", field="max_questions")
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
        ckey = _ops.entity_type_key(candidate.type)
        scored = [
            (name_similarity(candidate.name, ent.name), ent)
            for ent in existing
            if _ops.entity_type_key(ent.type) == ckey and not distinct_names(candidate.name, ent.name, low)
        ]
        band = sorted(((s, e) for s, e in scored if low <= s < high), key=lambda pair: (-pair[0], pair[1].id))
        for similarity, ent in band[: self.max_questions]:
            answer = await self._llm.generate(system=_LLM_SYSTEM, user=_question(candidate, ent), output=_SameEntity)
            same = answer.get("same") if isinstance(answer, Mapping) else getattr(answer, "same", None)
            if type(same) is not bool:
                raise ExtractionError(
                    "LLM client returned an invalid result for the resolver: same must be a boolean",
                    code="invalid_llm_output",
                    field="same",
                )
            if same:
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
        return context_payload(f"{type_} {name!r}{extra}")

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
        raise ValidationError(f"{name} must be a number, got {_ids.type_name(value)}")
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
            f"resolver must be 'exact', 'default', 'fuzzy', 'llm', or an EntityResolver, got {_ids.type_name(value)}"
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
            raise needs_llm("resolver 'llm'")
        return LLMResolver(llm)
    return value


def compatible_types(etype: str, schema: Schema | None) -> set[str]:
    """The case-folded entity type keys a type may merge with: itself, plus schema ancestors, descendants, and aliases.

    @param etype (str): the cleaned entity type.
    @param schema (Schema | None): the active schema.
    @return (set[str]): the compatible case-folded type keys.
    """
    out = {_ops.entity_type_key(etype)}
    if schema is None:
        return out
    index = _entity_index(schema)
    own = index.get(canonical_entity_type(etype, schema))
    if own is None:
        return out
    related = {t.name for t in _lineage(own, index)}
    for ent in schema.entities:
        if own.name in {t.name for t in _lineage(ent, index)}:
            related.add(ent.name)
    for ent in schema.entities:
        if ent.name in related:
            out.update(_ops.entity_type_key(n) for n in (ent.name, *ent.aliases))
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
    facts: Extraction
    merges: list[_Merge] = field(default_factory=list)
    warnings: list[InsertWarning] = field(default_factory=list)
    via: dict[str, dict[str, None]] = field(default_factory=dict)
    entity_via: dict[str, dict[str, None]] = field(default_factory=dict)
    held: list[tuple[MergeRewrite, list[EvidenceInput]]] = field(default_factory=list)

    def statements(self, rel: RelationInput) -> list[str]:
        """The statements behind one resolved relation, for the evidence it records (see _ops.evidence_via).

        A relation the merges rewrote is recorded under the ids of those merges, so an unmerge moves exactly that
        evidence; one stated directly is recorded as direct. Inputs that resolve to the same relation with the same
        evidence write the same records, so each record lists all of their statements.

        @param rel (RelationInput): a relation of facts.
        @return (list[str]): the statements.
        """
        return list(self.via.get(_statement_key(rel), {_ops.DIRECT: None}))


def _statement_key(rel: RelationInput) -> str:
    return _dumps([_rid_of(rel), _dump(rel)])


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


def _fold_absorbed(base: EntityInput, ent: EntityInput) -> EntityInput:
    """Fold a repeat of a merged candidate into the input recorded for it, as an upsert of the absorbed id would.

    @param base (EntityInput): the absorbed input recorded so far.
    @param ent (EntityInput): the repeated candidate.
    @return (EntityInput): the input unmerge restores, keeping the recorded name and taking the repeat's aliases,
        external ids, and properties.
    """
    return base.model_copy(
        update={
            "aliases": _ops._alias_list(base.name, [*base.aliases, *ent.aliases, ent.name]),
            "external_ids": {**base.external_ids, **ent.external_ids},
            "properties": _ops._merge_props(base.properties, ent.properties),
        }
    )


async def plan_resolution(
    runner: Any, ns: str, facts: Extraction, resolver: EntityResolver, schema: Schema | None, created_at: datetime
) -> Resolution:
    """Resolve each new entity without an explicit id against compatible stored and batch entities, and rewrite refs.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param facts (Extraction): the validated facts.
    @param resolver (EntityResolver): the resolver.
    @param schema (Schema | None): the active schema, for parent-closure type compatibility.
    @param created_at (datetime): the insert time.
    @return (Resolution): the rewritten facts, the merges it carries, and merge_self_loop warnings.
    """
    keyed = []
    for ent in facts.entities:
        etype, ename = _ops._clean_text(ent.type), _ops._clean_text(ent.name)
        keyed.append((ent, ent.id or _ids.entity_id(etype, ename), etype, ename))
    found = await _ops._nodes_by_id(runner, ns, L_ENTITY, _ops._dedup_list(eid for _, eid, _, _ in keyed))
    stored = set(found)
    candidate_types = {etype for ent, eid, etype, _ in keyed if ent.id is None and eid not in stored}
    if not candidate_types:
        return Resolution(facts)
    wanted: set[str] = set()
    for etype in candidate_types:
        wanted |= compatible_types(etype, schema)
    fallback_forms = frozenset().union(
        *(_forms(ent) for ent, _, etype, _ in keyed if _ops.entity_type_key(etype) == _FALLBACK_KEY and ent.id is None)
    )
    named = {eid for _, eid, _, _ in keyed}

    def keep(props: dict[str, Any]) -> bool:
        if _ops.entity_type_key(props["type"]) in wanted or props["id"] in named:
            return True
        return not fallback_forms.isdisjoint(_folded_forms(props["name"], tuple(props.get("aliases") or ())))

    async def candidates() -> AsyncIterator[list[dict[str, Any]]]:
        lookup = getattr(runner, "entities_matching", None)
        if lookup is not None and type(resolver) is DefaultResolver and not resolver.fuzzy:
            new = [ent for ent, eid, _, _ in keyed if ent.id is None and eid not in stored]
            keys = frozenset().union(*(match_keys(ent.name, ent.aliases, ent.external_ids) for ent in new))
            yield [*found.values(), *await lookup(ns, keys)]
            return
        fetch = partial(runner.match_nodes, ns, L_ENTITY, equals={}, skip=0)
        async for rows in _ops._keyset(lambda after, limit, fetch=fetch: fetch(limit=limit, id_gt=after)):
            yield rows

    pool: dict[str, Entity] = {}
    async for rows in candidates():
        for ent in map(decode_entity, filter(keep, rows)):
            pool[ent.id] = ent

    within = bool(getattr(resolver, "within_batch", True))
    batch: dict[str, Entity] = {}
    mapping: dict[str, str] = {}
    merges: dict[str, _Merge] = {}
    entities: list[EntityInput] = list(facts.entities)
    redirected: dict[int, str] = {}
    for i in sorted(range(len(keyed)), key=lambda i: _ops.entity_type_key(keyed[i][2]) == _FALLBACK_KEY):
        ent, eid, etype, ename = keyed[i]
        if eid in mapping:
            merge = merges[eid]
            target = pool.get(merge.survivor_id) or batch[merge.survivor_id]
            merge.note(_absorb_into(target, ent, ename))
            merge.candidate = _fold_absorbed(merge.candidate, ent)
            entities[i] = _redirect(ent, target)
            redirected[i] = _ids.entity_merge_id(target.id, eid)
            continue
        if ent.id is not None or eid in stored or eid in batch:
            view = pool.get(eid) or batch.get(eid)
            if view is not None:
                _absorb_into(view, ent, ename, merge=False)
            elif ent.id is not None and eid not in stored:
                batch[eid] = _view(ent, eid, etype, ename, created_at)
            continue
        fallback = _ops.entity_type_key(etype) == _FALLBACK_KEY
        compatible = compatible_types(etype, schema)
        offered = [
            e
            for e in pool.values()
            if _ops.entity_type_key(e.type) in compatible or (fallback and _surface_match(ent, e))
        ]
        existing = sorted(offered, key=lambda e: e.id)
        existing += [
            e
            for e in batch.values()
            if (_ops.entity_type_key(e.type) in compatible and within)
            or (fallback and _ops.entity_type_key(e.type) not in compatible and _surface_match(ent, e))
        ]
        decision = await resolver.resolve(ent, existing)
        if not isinstance(decision, ResolutionDecision):
            raise ValidationError(
                f"a resolver must return a ResolutionDecision, got {_ids.type_name(decision)}",
                code="invalid_resolver_decision",
            )
        if decision.target_id is None:
            batch[eid] = _view(ent, eid, etype, ename, created_at)
            continue
        for name in ("confidence", "reason"):
            if getattr(decision, name) is None:
                raise ValidationError(
                    f"resolver decision merging {eid!r} into {decision.target_id!r} is missing {name}; "
                    "a decision with a target_id needs confidence and reason",
                    code="invalid_resolver_decision",
                )
        target = next((e for e in existing if e.id == decision.target_id), None)
        if target is None:
            raise ValidationError(
                f"resolver chose {decision.target_id!r} for {eid!r}, "
                "which is not one of the compatible entities it was offered",
                code="invalid_resolver_decision",
            )
        mapping[eid] = target.id
        merges[eid] = _Merge(eid, target.id, ent, decision)
        merges[eid].note(_absorb_into(target, ent, ename))
        entities[i] = _redirect(ent, target)
        redirected[i] = _ids.entity_merge_id(target.id, eid)
    if not mapping:
        return Resolution(facts)
    entity_via: dict[str, dict[str, None]] = {}
    for i, (_, eid, _, _) in enumerate(keyed):
        target, statement = (entities[i].id, redirected[i]) if i in redirected else (eid, _ops.DIRECT)
        entity_via.setdefault(target, {})[statement] = None
    warnings: list[InsertWarning] = []
    via: dict[str, dict[str, None]] = {}
    held: list[tuple[MergeRewrite, list[EvidenceInput]]] = []
    rewritten = await _rewrite_refs(runner, ns, facts, mapping, merges, warnings, via, held)
    return Resolution(
        rewritten.model_copy(update={"entities": entities}), list(merges.values()), warnings, via, entity_via, held
    )


def trim_resolution(resolution: Resolution, kept: Extraction) -> Resolution:
    """Drop planned merges and rewrites whose survivor or rewritten item was removed by drop_off_schema.

    @param resolution (Resolution): the planned resolution before schema dropping.
    @param kept (Extraction): the facts kept after drop_off_schema.
    @return (Resolution): the resolution aligned to kept.
    """
    entities = {ent.id or _ids.entity_id(ent.type, ent.name) for ent in kept.entities}
    kept_by_kind = {
        "relation": {_rid_of(rel) for rel in kept.relations},
        "preference": {
            p.id or _ids.preference_id(p.subject_entity, p.stance, p.key, p.value_entity) for p in kept.preferences
        },
        "decision": {d.id or _ids.decision_id(d.actor_entity, d.title) for d in kept.decisions},
    }
    merges = []
    for merge in resolution.merges:
        if merge.survivor_id not in entities:
            continue
        merge.rewrites = [r for r in merge.rewrites if r.dropped or r.id in kept_by_kind[r.kind]]
        merges.append(merge)
    warnings = [w for w in resolution.warnings if any(f"join {eid} to itself" in w.message for eid in entities)]
    return Resolution(kept, merges, warnings, resolution.via, resolution.entity_via, resolution.held)


def _rid_of(rel: RelationInput) -> str:
    """The id of a relation input, derived from its endpoints and type when it has none.

    @param rel (RelationInput): the relation.
    @return (str): the relation id.
    """
    return rel.id or _ids.relation_id(rel.from_entity, rel.type, rel.to_entity)


def _redirect(ent: EntityInput, target: Entity) -> EntityInput:
    """The input that folds a merged candidate into its target through the normal upsert alias path.

    @param ent (EntityInput): the candidate, already folded into the target view.
    @param target (Entity): the target view, whose values win for every key the candidate shares with it.
    @return (EntityInput): an input with the target's id, name, and type, the candidate's surface forms as aliases,
        and the target's values for the candidate's external id and property keys.
    """
    return EntityInput(
        id=target.id,
        type=target.type,
        name=target.name,
        aliases=[*ent.aliases, ent.name],
        external_ids={k: target.external_ids[k] for k in ent.external_ids},
        properties={k: target.properties[k] for k in ent.properties if k in target.properties},
    )


async def _rewrite_refs(
    runner: Any,
    ns: str,
    facts: Extraction,
    mapping: dict[str, str],
    merges: dict[str, _Merge],
    warnings: list[InsertWarning],
    via: dict[str, dict[str, None]],
    held: list[tuple[MergeRewrite, list[EvidenceInput]]],
) -> Extraction:
    """Point every reference to a merged candidate at its target and record each rewrite on the merges it involves.

    A relation between two different entities that the merge would join into a self-loop is dropped, with a
    merge_self_loop warning; its rewrite is still recorded, marked dropped, so unmerging restores it.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param facts (Extraction): the facts.
    @param mapping (dict[str, str]): candidate id to target id.
    @param merges (dict[str, _Merge]): the merges by candidate id.
    @param warnings (list[InsertWarning]): receives one merge_self_loop warning per dropped relation.
    @param via (dict[str, dict[str, None]]): receives each written relation's statements (see Resolution.statements).
    @param held (list[tuple[MergeRewrite, list[EvidenceInput]]]): receives each dropped rewrite with the evidence its
        relation stated, which save_merges completes with the insert's source evidence.
    @return (Extraction): the facts with rewritten relations, preferences, and decisions.
    """

    def m(eid: str | None) -> str | None:
        return mapping.get(eid, eid) if eid is not None else None

    def note(rewrite: MergeRewrite, refs: set[str]) -> None:
        for eid in sorted(refs & mapping.keys()):
            merges[eid].rewrites.append(rewrite)

    touched = [rel.from_entity in mapping or rel.to_entity in mapping for rel in facts.relations]
    kept_rids = {_rid_of(rel) for rel, hit in zip(facts.relations, touched, strict=True) if not hit}
    rel_map: dict[str, str] = {}
    rel_refs: dict[str, set[str]] = {}
    dropped: set[str] = set()
    relations = []
    for rel, hit in zip(facts.relations, touched, strict=True):
        if not hit:
            via.setdefault(_statement_key(rel), {})[_ops.DIRECT] = None
            relations.append(rel)
            continue
        new = rel.model_copy(update={"from_entity": m(rel.from_entity), "to_entity": m(rel.to_entity)})
        old_id, new_id = _rid_of(rel), _rid_of(new)
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
            held.append((rewrite, rel.evidence))
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
        merge_ids = (_ids.entity_merge_id(mapping[eid], eid) for eid in refs & mapping.keys())
        via.setdefault(_statement_key(new), {})[_ops.via_of(merge_ids)] = None
        relations.append(new)

    preferences = []
    for pref in facts.preferences:
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
        new_id = new.id or _ids.preference_id(new.subject_entity, new.stance, new.key, new.value_entity)
        existed = await _ops.preference_exists(runner, ns, new_id)
        note(
            MergeRewrite(kind="preference", id=new_id, original=_dump(pref), rewritten=_dump(new), existed=existed),
            refs,
        )
        preferences.append(new)

    decisions = []
    for dec in facts.decisions:
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
    return facts.model_copy(update={"relations": relations, "preferences": preferences, "decisions": decisions})


def _encode_merge(ns: str, rec: MergeRecord) -> dict[str, Any]:
    """The merge record node, without its sources and rewrites, which live in EntityMergeEntry rows.

    @param ns (str): namespace.
    @param rec (MergeRecord): the record.
    @return (dict[str, Any]): the node properties.
    """
    return {
        "id": rec.id,
        "ns": ns,
        "survivor_id": rec.survivor_id,
        "absorbed_id": rec.absorbed_id,
        "reason": rec.reason,
        "confidence": rec.confidence,
        "source_id": rec.source_id,
        "absorbed_json": _dumps(rec.absorbed),
        "added_aliases_json": _dumps(rec.added_aliases),
        "added_external_ids_json": _dumps(rec.added_external_ids),
        "added_properties_json": _dumps(rec.added_properties),
        "source_entries": len(rec.source_ids),
        "rewrite_entries": len(rec.rewrites),
        "created_at": to_iso(rec.created_at),
        "reverted_at": to_iso(rec.reverted_at),
    }


def _entry_rows(ns: str, rec: MergeRecord) -> dict[str, dict[str, Any]]:
    """One row per source and per rewrite of a merge record, keyed by a position that never moves.

    @param ns (str): namespace.
    @param rec (MergeRecord): the record.
    @return (dict[str, dict[str, Any]]): the entry node properties by entry id.
    """
    rows = {}
    for kind, values in (("source", rec.source_ids), ("rewrite", [_dump(r) for r in rec.rewrites])):
        for seq, value in enumerate(values):
            eid = _ids.merge_entry_id(rec.id, kind, seq)
            rows[eid] = {"id": eid, "ns": ns, "merge_id": rec.id, "kind": kind, "seq": seq, "value_json": _dumps(value)}
    return rows


async def _load_entries(runner: Any, ns: str, records: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Read the source and rewrite rows of some stored merge records, by id from the counts each record keeps.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param records (list[dict[str, Any]]): the stored merge record nodes.
    @return (dict[str, list[dict[str, Any]]]): each record's entry rows, in no particular order.
    """
    found: dict[str, list[dict[str, Any]]] = {props["id"]: [] for props in records}
    wanted = [
        _ids.merge_entry_id(props["id"], kind, seq)
        for props in records
        for kind in ("source", "rewrite")
        for seq in range(int(props.get(f"{kind}_entries") or 0))
    ]
    for row in (await _ops._nodes_by_id(runner, ns, L_MERGE_ENTRY, wanted)).values():
        found[row["merge_id"]].append(row)
    return found


def _decode_merge(props: dict[str, Any], entries: Sequence[dict[str, Any]] = ()) -> MergeRecord:
    """Rebuild a merge record from its node and entry rows.

    @param props (dict[str, Any]): the record node.
    @param entries (Sequence[dict[str, Any]]): its EntityMergeEntry rows.
    @return (MergeRecord): the record.
    """
    listed: dict[str, list[Any]] = {"source": [], "rewrite": []}
    for row in sorted(entries, key=lambda r: int(r["seq"])):
        listed[row["kind"]].append(_loads(row["value_json"], None))
    return MergeRecord(
        id=props["id"],
        survivor_id=props["survivor_id"],
        absorbed_id=props["absorbed_id"],
        absorbed=_loads(props.get("absorbed_json"), {}),
        reason=props.get("reason") or "",
        confidence=float(props.get("confidence") or 0.0),
        source_id=props.get("source_id"),
        source_ids=listed["source"],
        added_aliases=_loads(props.get("added_aliases_json"), []),
        added_external_ids=_loads(props.get("added_external_ids_json"), []),
        added_properties=_loads(props.get("added_properties_json"), []),
        rewrites=listed["rewrite"],
        created_at=from_iso(props["created_at"]),
        reverted_at=from_iso(props.get("reverted_at")),
    )


async def _write_merges(
    runner: Any, ns: str, records: list[MergeRecord], stored: dict[str, list[dict[str, Any]]]
) -> None:
    """Write merge records, rewriting only the entry rows that are new or changed, so a repeat costs its own rows.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param records (list[MergeRecord]): the records to store.
    @param stored (dict[str, list[dict[str, Any]]]): each already stored record's entry rows, by id.
    @return (None): nothing.
    """
    nodes, entries = [], []
    for rec in records:
        rows = stored.get(rec.id, [])
        nodes.append((rec.id, _encode_merge(ns, rec)))
        have = {row["id"]: row.get("value_json") for row in rows}
        entries += [(eid, row) for eid, row in _entry_rows(ns, rec).items() if have.get(eid) != row["value_json"]]
    await _ops._precheck_nodes(runner, ns, L_MERGE_ENTRY, entries)
    await _ops._precheck_nodes(runner, ns, L_MERGE, nodes)
    if entries:
        await runner.upsert_nodes(ns, L_MERGE_ENTRY, entries)
    await runner.upsert_nodes(ns, L_MERGE, nodes)


def _rewrite_key(rw: MergeRewrite) -> tuple[Any, ...]:
    """Key a rewrite by what it points at and by its original, so a repeated merge keeps each distinct original.

    Two statements a merge redirects onto one object each need undoing to their own endpoints, while a repeat of
    the same statement is the same rewrite.

    @param rw (MergeRewrite): the recorded rewrite.
    @return (tuple[Any, ...]): its deduplication key.
    """
    if rw.kind == "relation":
        original: str = _rid_of(RelationInput.model_validate(rw.original))
    elif rw.kind == "preference":
        pref = PreferenceInput.model_validate(rw.original)
        original = pref.id or _ids.preference_id(pref.subject_entity, pref.stance, pref.key, pref.value_entity)
    else:
        dec = DecisionTraceInput.model_validate(rw.original)
        original = dec.id or _ids.decision_id(dec.actor_entity, dec.title)
    return (rw.kind, rw.id, original)


def _fold_rewrites(prev: list[MergeRewrite], fresh: list[MergeRewrite]) -> list[MergeRewrite]:
    """Add the rewrites a repeat of a merge brings, and the evidence it gives each dropped one already recorded.

    @param prev (list[MergeRewrite]): the rewrites recorded so far.
    @param fresh (list[MergeRewrite]): the repeat's rewrites.
    @return (list[MergeRewrite]): the rewrites to record.
    """
    where = {_rewrite_key(r): i for i, r in enumerate(prev)}
    out = list(prev)
    for rw in fresh:
        i = where.get(_rewrite_key(rw))
        if i is None:
            out.append(rw)
        elif rw.dropped:
            kept = {_dumps(_dump(ev)): ev for ev in [*out[i].evidence, *rw.evidence]}
            out[i] = out[i].model_copy(update={"evidence": list(kept.values())})
    return out


async def save_merges(
    runner: Any,
    ns: str,
    resolution: Resolution,
    *,
    source_id: str | None,
    source_version: str | None,
    evidence: list[Evidence],
    created_at: datetime,
) -> list[MergeRecord]:
    """Write one record per merge, folding a repeat of the same merge into its live record so inserts stay idempotent.

    A dropped relation has no stored evidence to carry back, so its rewrite keeps the evidence it would have recorded.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param resolution (Resolution): the planned merges.
    @param source_id (str | None): the inserted source, if any.
    @param source_version (str | None): the inserted source's version, if any.
    @param evidence (list[Evidence]): the insert's source-level evidence, empty without a source.
    @param created_at (datetime): the insert time.
    @return (list[MergeRecord]): the stored records, in candidate order.
    """
    if not resolution.merges:
        return []
    for rewrite, own in resolution.held:
        rewrite.evidence = _ops.relation_evidence(own, evidence, source_id=source_id, source_version=source_version)
    keyed = [(_ids.entity_merge_id(m.survivor_id, m.absorbed_id), m) for m in resolution.merges]
    stored = await _ops._nodes_by_id(runner, ns, L_MERGE, [mid for mid, _ in keyed])
    entries = await _load_entries(runner, ns, list(stored.values()))
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
        prev = _decode_merge(stored[mid], entries[mid]) if mid in stored else None
        if prev is not None and prev.reverted_at is None:
            rec = prev.model_copy(
                update={
                    "source_ids": _ops._dedup_list([*prev.source_ids, *rec.source_ids]),
                    "absorbed": _dump(_fold_absorbed(EntityInput.model_validate(prev.absorbed), merge.candidate)),
                    "added_aliases": _ops._dedup_list([*prev.added_aliases, *merge.added_aliases]),
                    "added_external_ids": _ops._dedup_list([*prev.added_external_ids, *merge.added_external_ids]),
                    "added_properties": _ops._dedup_list([*prev.added_properties, *merge.added_properties]),
                    "rewrites": _fold_rewrites(prev.rewrites, merge.rewrites),
                }
            )
        records.append(rec)
    await _write_merges(runner, ns, records, entries)
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
        raise await _ops.missing_entity(runner, ns, entity_id)
    return await decode_merges(runner, ns, rows)


async def decode_merges(runner: Any, ns: str, rows: list[dict[str, Any]]) -> list[MergeRecord]:
    """Rebuild stored merge records with their source and rewrite entries, in the order given.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rows (list[dict[str, Any]]): the stored merge record nodes.
    @return (list[MergeRecord]): the records.
    """
    entries = await _load_entries(runner, ns, rows)
    return [_decode_merge(r, entries[r["id"]]) for r in rows]


async def _evidence_rows(runner: Any, ns: str, relation_id: str) -> list[dict[str, Any]]:
    return await _ops._nodes_where(runner, ns, L_EVIDENCE, "target_id", [relation_id])


@dataclass
class _Split:
    carried: list[tuple[Evidence, list[str]]] = field(default_factory=list)
    changed: list[tuple[dict[str, Any], list[str]]] = field(default_factory=list)
    emptied: list[str] = field(default_factory=list)
    sources: set[str] = field(default_factory=set)


def _statement_of(rw: MergeRewrite, merge_id: str) -> str:
    """The via entry of the statement one rewrite redirected: this merge and each other merge still redirecting it.

    An endpoint whose rewritten id differs from its original is still redirected by the merge of that original into
    that survivor, so a statement two merges redirect is told apart from one only this merge redirects.

    @param rw (MergeRewrite): a relation rewrite of the merge being reverted, as forwarded so far.
    @param merge_id (str): the merge being reverted.
    @return (str): the entry, as _ops.via_of gives it.
    """
    ends = [(rw.original.get(k), rw.rewritten.get(k)) for k in ("from_entity", "to_entity")]
    return _ops.via_of([merge_id, *(_ids.entity_merge_id(new, old) for old, new in ends if old != new)])


def _split_evidence(rows: list[dict[str, Any]], statement: str, merge_id: str) -> _Split:
    """Split a relation's evidence between the statement one rewrite carried onto it and the ones that stay.

    Each row lists the statements that wrote it (see _ops.evidence_via). The rewrite's statement moves with the
    merge, minus that merge's id, so a row another merge also carried keeps that merge on its new relation. Every
    other statement, stated directly, by another merge, or by another rewrite of this one, stays, so a row both kinds
    wrote is on both relations.

    @param rows (list[dict[str, Any]]): the relation's stored evidence rows.
    @param statement (str): the rewrite's statement, from _statement_of.
    @param merge_id (str): the merge being reverted.
    @return (_Split): the evidence to carry, each with its statements there; each row that stays with fewer
        statements; the rows no statement backs any more; and the distinct sources of the rows that stay.
    """
    out = _Split()
    for row in rows:
        statements = _ops.evidence_via(row)
        rest = [s for s in statements if s != statement]
        if len(rest) < len(statements):
            out.carried.append((decode_evidence(row), [_ops.via_of(m for m in statement.split() if m != merge_id)]))
            if rest:
                out.changed.append((row, rest))
            else:
                out.emptied.append(row["id"])
        if rest:
            out.sources.add(row["source_id"])
    return out


async def _leave_evidence(runner: Any, ns: str, relation_id: str, split: _Split) -> None:
    """Take a merge's statements off a relation that stays, and recount the distinct sources its evidence keeps.

    The count is written before any row is changed or deleted, so a write that fails partway leaves the merge's
    rows in place and a retried unmerge finds them again; the evidence was already carried to the restored relation.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param relation_id (str): the relation the merge rewrote onto.
    @param split (_Split): what _split_evidence found on it.
    @return (None): nothing.
    """
    edge = await runner.get_current_edge(ns, relation_id)
    if edge is not None and edge["props"].get("source_count") != len(split.sources):
        await runner.update_current_edge(ns, relation_id, {"source_count": len(split.sources)})
    await _write_split(runner, ns, split)


async def _write_split(runner: Any, ns: str, split: _Split) -> None:
    """Rewrite the evidence rows that keep fewer statements and delete the ones no statement backs.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param split (_Split): what _split_evidence found.
    @return (None): nothing.
    """
    if split.changed:
        rows = [(row["id"], {**row, "via": None if rest == [_ops.DIRECT] else rest}) for row, rest in split.changed]
        await runner.upsert_nodes(ns, L_EVIDENCE, rows)
    if split.emptied:
        await runner.delete_nodes(ns, L_EVIDENCE, split.emptied)


async def _leave_entity_evidence(runner: Any, ns: str, entity_id: str, split: _Split) -> None:
    """Take a merge's statement off the survivor's evidence, and recount the distinct sources its evidence keeps.

    The count is written before any row is changed or deleted, as _leave_evidence does, and the evidence was already
    carried to the restored entity.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param entity_id (str): the surviving entity.
    @param split (_Split): what _split_evidence found on it.
    @return (None): nothing.
    """
    props = await runner.get_node(ns, L_ENTITY, entity_id)
    if props is not None and props.get("source_count") != len(split.sources):
        await runner.upsert_nodes(
            ns, L_ENTITY, [(entity_id, {**props, "source_count": len(split.sources)})], extra_label=props["type"]
        )
    await _write_split(runner, ns, split)


async def _sibling_rewrites(
    runner: Any, ns: str, merge_id: str
) -> tuple[dict[tuple[str, str], list[dict[str, Any]]], list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """List what the other live merges rewrote onto each object, so an unmerge keeps one another merge still backs.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param merge_id (str): the merge being reverted.
    @return (tuple[...]): the originals each object's live sibling rewrites came from, by (kind, id); and the live
        sibling merges with their entries, for _forward_siblings.
    """
    live = [props for props in await scan_live_merges(runner, ns) if props["id"] != merge_id]
    entries = await _load_entries(runner, ns, live)
    out: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for props in live:
        for rw in _decode_merge(props, entries[props["id"]]).rewrites:
            if not rw.dropped:
                out.setdefault((rw.kind, rw.id), []).append(rw.original)
    return out, live, entries


def _backed_elsewhere(
    rw: MergeRewrite, rec: MergeRecord, siblings: dict[tuple[str, str], list[dict[str, Any]]]
) -> bool:
    """Whether another live merge rewrote a statement this merge did not onto the object this rewrite points at.

    A sibling with the same original as one of this merge's rewrites onto the object is the same statement seen
    through its other merged endpoint, which moves with this unmerge, so it does not keep the object.

    @param rw (MergeRewrite): a rewrite of the merge being reverted.
    @param rec (MergeRecord): the merge being reverted.
    @param siblings (dict[tuple[str, str], list[dict[str, Any]]]): what _sibling_rewrites found.
    @return (bool): whether the object stays for that merge.
    """
    own = [r.original for r in rec.rewrites if (r.kind, r.id) == (rw.kind, rw.id) and not r.dropped]
    return any(original not in own for original in siblings.get((rw.kind, rw.id), ()))


def _explained(before: Relation, stated: list[RelationInput], newest: Relation) -> bool:
    """Whether a relation version is what the statements, landing in some order, made of the version before.

    Each statement writes its event time and its properties over the earlier ones, so the event time and each property
    of the result come from one of the statements that gave it, and from the version before when none did.

    @param before (Relation): the version before the statements.
    @param stated (list[RelationInput]): the statements.
    @param newest (Relation): the version after them.
    @return (bool): True when nothing but the statements shaped it.
    """
    times = {to_iso(r.event_time) for r in stated} - {None}
    if to_iso(newest.event_time) not in (times or {to_iso(before.event_time)}):
        return False
    for key in {*before.properties, *newest.properties, *(k for r in stated for k in r.properties)}:
        said = [r.properties[key] for r in stated if key in r.properties]
        outcomes = [_ops._merge_props({}, {key: v}).get(key) for v in said] or [before.properties.get(key)]
        if not any(_ops._json_equal(newest.properties.get(key), o) for o in outcomes):
            return False
    return True


async def _undo_revision(runner: Any, ns: str, rec: MergeRecord, rw: MergeRewrite) -> None:
    """Put a relation that existed before the merge back to the version it had, when only the merge wrote after it.

    The versions the merge insert wrote carry its created_at. They are removed, and the version before them takes the
    place of the newest one, current or retired as it was, only when nothing wrote after them, nothing certified the
    relation, and the newest one is what the rewrites of every merge of that insert, reverted ones included, would have
    made of the version before, in some order. Otherwise a direct statement or a later write shaped the relation, and
    it stays as it is.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rec (MergeRecord): the merge being reverted.
    @param rw (MergeRewrite): one of its rewrites onto the existing relation.
    @return (None): nothing.
    """
    edges = sorted(await _ops._typed_edge_versions(runner, ns, rw.id, _ops._is_relation_type), key=_ops._revision)
    wrote = [from_iso(e["props"]["created_at"]) == rec.created_at for e in edges]
    first = wrote.index(True) if True in wrote else 0
    if first == 0 or not all(wrote[first:]):
        return
    before, newest = _ops._relation_of(edges[first - 1]), _ops._relation_of(edges[-1])
    rows = await _ops._paged(partial(runner.match_nodes, ns, L_MERGE, equals={"created_at": to_iso(rec.created_at)}))
    inserted = [rec, *(m for m in await decode_merges(runner, ns, rows) if m.id != rec.id)]
    stated = [
        RelationInput.model_validate(r.rewritten)
        for m in inserted
        for r in m.rewrites
        if (r.kind, r.id) == (rw.kind, rw.id) and r.existed and not r.dropped
    ]
    if (
        before.invalidated_at is not None
        or before.certifications
        or newest.certifications
        or not _explained(before, stated, newest)
    ):
        return
    kept = [(e["type"], e["from_id"], e["to_id"], e["props"]) for e in edges[: first - 1]]
    last, ended = edges[first - 1], edges[-1]["props"]
    ending = {k: ended.get(k) for k in ("is_current", "invalidated_at", "invalidated_by", "invalidated_known_at")}
    kept.append((last["type"], last["from_id"], last["to_id"], {**last["props"], **ending}))
    await runner.delete_edges(ns, rw.id)
    await runner.create_edges(ns, L_ENTITY, L_ENTITY, kept)


async def _withdrawal(runner: Any, ns: str, rows: list[dict[str, Any]]) -> tuple[str, datetime] | None:
    """The source version and time that withdrew the last of a relation's evidence, when every record was replaced.

    Evidence recorded by hand has no stored version and always counts, as in _ops.replace_source.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rows (list[dict[str, Any]]): the stored evidence nodes of a relation.
    @return (tuple[str, datetime] | None): the replacing version and when it replaced, or None when any record stands.
    """
    stored = await _ops._nodes_by_id(runner, ns, L_SOURCE_VERSION, _ops._dedup_list(r["source_version"] for r in rows))
    marks = [stored.get(r["source_version"], {}) for r in rows]
    if not marks or not all(m.get("replaced_by") for m in marks):
        return None
    last = max(marks, key=lambda m: m["replaced_at"])
    return last["replaced_by"], from_iso(last["replaced_at"])


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
    rw: MergeRewrite,
    moved: list[tuple[MergeRewrite, MergeRewrite]],
    restored: dict[str, str],
    handed: set[tuple[str, str]],
) -> MergeRewrite:
    """Point one rewrite of another merge at where an unmerge put the object it shares with that merge.

    @param rw (MergeRewrite): a rewrite of a still-live merge.
    @param moved (list[tuple[MergeRewrite, MergeRewrite]]): each rewrite the unmerge replayed, with its new location.
    @param restored (dict[str, str]): the relation ids the unmerge deleted, each to the relation it moved them to.
    @param handed (set[tuple[str, str]]): (kind, id) of each object the unmerged merge created and left in place
        because another merge or a direct statement still backs it.
    @return (MergeRewrite): the rewrite to keep on that merge.
    """
    for old, new in moved:
        if (rw.kind, rw.id, rw.original) == (old.kind, old.id, old.original):
            return new
    if rw.existed and (rw.kind, rw.id) in handed:
        return rw.model_copy(update={"existed": False})
    steps = rw.rewritten.get("steps")
    if rw.kind == "decision" and isinstance(steps, list) and any(s in restored for s in steps):
        return rw.model_copy(update={"rewritten": {**rw.rewritten, "steps": [restored.get(s, s) for s in steps]}})
    return rw


async def _forward_siblings(
    runner: Any,
    ns: str,
    merge_id: str,
    moved: list[tuple[MergeRewrite, MergeRewrite]],
    restored: dict[str, str],
    handed: set[tuple[str, str]],
    live: list[dict[str, Any]] | None = None,
    entries: dict[str, list[dict[str, Any]]] | None = None,
) -> None:
    """Update the live merges that share a rewrite with an unmerged one, so unmerging them later replays exactly.

    Merges from one insert can rewrite the same relation, preference, or decision (both endpoints merged, say).
    Once one is unmerged that object lives somewhere new, so the other merges record that location, whether it
    existed before, and the restored entity id, and undo from there. An object the unmerged merge created and left
    in place for another merge is that merge's to undo now, so its rewrite stops saying the object already existed.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param merge_id (str): the merge being reverted.
    @param moved (list[tuple[MergeRewrite, MergeRewrite]]): each rewrite the unmerge replayed, with its new location.
    @param restored (dict[str, str]): the relation ids the unmerge deleted, each to the relation it moved them to.
    @param handed (set[tuple[str, str]]): (kind, id) of each object the unmerged merge created and left in place.
    @param live (list[dict[str, Any]] | None): optional cached live merges.
    @param entries (dict[str, list[dict[str, Any]]] | None): optional cached entries.
    @return (None): nothing.
    """
    if live is None:
        live = [props for props in await scan_live_merges(runner, ns) if props["id"] != merge_id]
    if entries is None:
        entries = await _load_entries(runner, ns, live)
    for props in live:
        sib = _decode_merge(props, entries[props["id"]])
        rewrites = [_forward(rw, moved, restored, handed) for rw in sib.rewrites]
        if rewrites != sib.rewrites:
            await runner.lock_node(ns, L_MERGE, sib.id)
            updated = sib.model_copy(update={"rewrites": rewrites})
            await _write_merges(runner, ns, [updated], entries)


async def unmerge(runner: Any, ns: str, merge_id: str, caps: Mapping[str, Any] | None = None) -> UnmergeResult:
    """Reverse one merge: recreate the absorbed entity, drop what it added to the survivor, and move references back.

    The record is replayed exactly: the absorbed entity gets back the created_at of the merge and the evidence the
    merge wrote on the survivor, which restores its source_count and leaves the survivor the evidence it had without
    the merge, a relation the merge dropped as a self-loop is restored with the evidence its rewrite recorded, and a
    relation the merge created on the survivor is removed with all its
    versions, and its original is written back as the current relation of the absorbed entity, or retired again when
    a replaced source retired its last version, so an unmerge never reasserts a withdrawn fact; one a contradiction
    retired comes back current, since the conflict came from the merged identity. Each evidence row records the
    merges whose rewrite wrote it, so the restored relation takes exactly the rows this merge carried, and a survivor
    relation that a direct statement or another live merge still backs stays, with its other evidence, its recounted
    source_count, and its decision steps. A relation that existed before the merge goes back to the revision it had
    when only the merge wrote after it, and a survivor relation a removed relation retired is current again. An
    object an earlier rewrite of this merge created is this merge's to undo even where a repeat of the merge recorded
    it as existing. A restored relation that keeps the explicit id of the redirected one takes all of its evidence,
    and the redirected edge is deleted before the id is written again. Each restored relation is returned once, as
    stored after the last write. A merge whose moved relation is certified is refused until it is uncertified, since
    the mark verified other endpoints. An endpoint whose own merge is still live keeps pointing at that
    merge's survivor, and that merge is updated to undo from the new location, so unmerging every merge of an
    insert, in any order, restores the relations it would have written without them. Restored relations are
    written with contradiction checks off, so an unmerge never supersedes or warns about another relation.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param merge_id (str): the merge record id.
    @param caps (Mapping[str, Any] | None): the schema's max_count limits, or None without a schema.
    @return (UnmergeResult): the reverted record, the recreated entity, the survivor, and what was moved back.
    """
    _ids._require_str("merge id", merge_id)
    await runner.lock_node(ns, L_MERGE, merge_id)
    props = await runner.get_node(ns, L_MERGE, merge_id)
    if props is None:
        raise NotFoundError("EntityMerge", merge_id, namespace=ns)
    entries = (await _load_entries(runner, ns, [props]))[merge_id]
    rec = _decode_merge(props, entries)
    if rec.reverted_at is not None:
        raise ValidationError(
            f"merge {merge_id!r} was already reverted at {json_iso(rec.reverted_at)}", code="merge_reverted"
        )
    created = {(rw.kind, rw.id) for rw in rec.rewrites if not (rw.existed or rw.dropped)}
    rewrites = [
        rw.model_copy(update={"existed": False}) if rw.existed and (rw.kind, rw.id) in created else rw
        for rw in rec.rewrites
    ]
    rec = rec.model_copy(update={"rewrites": rewrites})
    history: dict[str, list[Relation]] = {}
    for rw in rec.rewrites:
        if rw.kind == "relation" and not rw.existed and not rw.dropped:
            history[rw.id] = await _ops.list_relation_versions(runner, ns, rw.id, newest_first=True)
            if history[rw.id] and history[rw.id][0].is_current and history[rw.id][0].certified_at is not None:
                raise ValidationError(
                    f"relation {rw.id} is certified, and unmerging {merge_id!r} would change it",
                    code="relation_certified",
                )
    at = now()
    absorbed_id = rec.absorbed_id
    owned = _split_evidence(await _evidence_rows(runner, ns, rec.survivor_id), rec.id, rec.id)
    exists = partial(runner.node_exists, ns, L_ENTITY)

    absorbed = EntityInput.model_validate({**rec.absorbed, "id": absorbed_id})
    made_at = at if await exists(absorbed_id) else rec.created_at
    [entity] = await _ops.upsert_entities(
        runner, ns, [absorbed], evidence=[ev for ev, _ in owned.carried], created_at=made_at
    )
    await _leave_entity_evidence(runner, ns, rec.survivor_id, owned)

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
    deleted: dict[str, str] = {}
    orig_restored: dict[str, str] = {}
    moved: list[tuple[MergeRewrite, MergeRewrite]] = []
    handed: set[tuple[str, str]] = set()
    siblings, live_merges, live_entries = await _sibling_rewrites(runner, ns, rec.id)
    gone: list[dict[str, Any]] = []
    superseded: list[tuple[Relation, Relation]] = []
    relations = []
    for rw in (r for r in rec.rewrites if r.kind == "relation"):
        original, rewritten = RelationInput.model_validate(rw.original), RelationInput.model_validate(rw.rewritten)
        source = await end(original.from_entity, rewritten.from_entity)
        target = await end(original.to_entity, rewritten.to_entity)
        versions = history.get(rw.id, [])
        if not (await exists(source) and await exists(target)):
            continue
        properties, event_time = dict(original.properties), original.event_time
        if versions:
            properties, event_time = versions[0].properties, versions[0].event_time
        rows = await _evidence_rows(runner, ns, rw.id)
        statement = _statement_of(rw, rec.id)
        split = _split_evidence(rows, statement, rec.id)
        if rw.dropped:
            split.carried = [(ev, [_ops.via_of(m for m in statement.split() if m != rec.id)]) for ev in rw.evidence]
        back = RelationInput(
            id=original.id,
            from_entity=source,
            type=original.type,
            to_entity=target,
            properties=properties,
            event_time=event_time,
        )
        back_id = back.id or _ids.relation_id(back.from_entity, back.type, back.to_entity)
        touching: set[str] = set()
        reused = back_id == rw.id and not rw.dropped
        kept = not reused and (rw.existed or bool(split.sources) or _backed_elsewhere(rw, rec, siblings))
        if kept and not rw.existed:
            handed.add((rw.kind, rw.id))
        if reused:
            stripped = _ops.via_of(m for m in statement.split() if m != rec.id)
            split.carried = [
                (
                    decode_evidence(r),
                    list(dict.fromkeys(stripped if s == statement else s for s in _ops.evidence_via(r))),
                )
                for r in rows
            ]
            touching = await _ops._traces_touching_relations(runner, ns, [rw.id])
            gone.append(await _ops._newest_edge(runner, ns, rw.id, _ops._is_relation_type))
            await runner.delete_edges(ns, rw.id)
            await _ops._delete_evidence(runner, ns, rw.id)
            deleted[rw.id] = rw.id
        existed = await _ops.relation_exists(runner, ns, back_id)
        [rel] = await _ops.upsert_relations(
            runner,
            ns,
            [(back, [ev for ev, _ in split.carried])],
            default_event_time=None,
            created_at=at,
            contradiction="off",
            via=[[statements for _, statements in split.carried]],
        )
        if kept:
            if (
                rw.existed
                and not split.sources.intersection(rec.source_ids)
                and not _backed_elsewhere(rw, rec, siblings)
            ):
                await _undo_revision(runner, ns, rec, rw)
            await _leave_evidence(runner, ns, rw.id, split)
        elif versions and not reused:
            handed.discard((rw.kind, rw.id))
            touching = await _ops._traces_touching_relations(runner, ns, [rw.id])
            gone.append(await _ops._newest_edge(runner, ns, rw.id, _ops._is_relation_type))
            await runner.delete_edges(ns, rw.id)
            await _ops._delete_evidence(runner, ns, rw.id)
            deleted[rw.id] = rel.id
        withdrawn = versions and not versions[0].is_current and not existed
        if withdrawn and await runner.node_exists(ns, L_SOURCE_VERSION, versions[0].invalidated_by):
            edge = await runner.get_current_edge(ns, rel.id)
            [rel] = await _ops.retire_relations(
                runner, ns, [(edge, versions[0].invalidated_by, versions[0].invalidated_at)], at
            )
        if withdrawn:
            superseded.append((rel, versions[0]))
        restored[rw.id] = rel.id
        orig_restored[_rid_of(original)] = rel.id
        relations.append(rel)
        moved.append((rw, _moved_to(rw, rel.id, _dump(back, exclude={"evidence"}), existed)))
        await _ops._repoint_steps(runner, ns, touching, deleted)

    def slots(rel: Relation) -> set[Any]:
        """The max_count slots a relation occupies.

        @param rel (Relation): the relation.
        @return (set[Any]): its slot keys.
        """
        return {key for key, _ in _ops._cap_slots(caps or {}, rel.type, rel.from_entity, rel.to_entity)}

    for rel, old in superseded:
        by = next((r for r in relations if r.id == restored.get(old.invalidated_by)), None)
        if by is not None and slots(rel) & slots(by):
            edge = await runner.get_current_edge(ns, rel.id)
            await _ops.retire_relations(runner, ns, [(edge, by.id, old.invalidated_at)], at)

    for rid in dict.fromkeys([*restored.values(), *restored]):
        edge = await runner.get_current_edge(ns, rid)
        cut = None
        if edge is not None and edge["props"].get("certified_at") is None:
            cut = await _withdrawal(runner, ns, await _evidence_rows(runner, ns, rid))
        if cut is not None:
            [ended] = await _ops.retire_relations(runner, ns, [(edge, *cut)], at)
            relations = [ended if r.id == rid else r for r in relations]

    preferences = []
    for rw in (r for r in rec.rewrites if r.kind == "preference"):
        original, rewritten = PreferenceInput.model_validate(rw.original), PreferenceInput.model_validate(rw.rewritten)
        subject = await end(original.subject_entity, rewritten.subject_entity)
        value = await end(original.value_entity, rewritten.value_entity)
        about = await end(original.about_entity, rewritten.about_entity)
        if not (await exists(subject) and await exists(value)):
            continue
        current = await _ops.get_preference(runner, ns, rw.id)
        values = {"strength": original.strength, "properties": original.properties, "event_time": original.event_time}
        if current is not None and not rw.existed:
            values = {"strength": current.strength, "properties": current.properties, "event_time": current.event_time}
            if _backed_elsewhere(rw, rec, siblings):
                handed.add((rw.kind, rw.id))
            else:
                await runner.delete_edges(ns, rw.id)
        back = PreferenceInput(
            id=original.id,
            subject_entity=subject,
            stance=original.stance,
            key=original.key,
            value_entity=value,
            about_entity=about if about is None or await exists(about) else None,
            **values,
        )
        pid = back.id or _ids.preference_id(back.subject_entity, back.stance, back.key, back.value_entity)
        existed = await _ops.preference_exists(runner, ns, pid)
        pref = await _ops.upsert_preference(runner, ns, back, default_event_time=None, created_at=at)
        preferences.append(pref)
        moved.append((rw, _moved_to(rw, pref.id, _dump(back), existed)))

    decisions = []
    decision_rws = [r for r in rec.rewrites if r.kind == "decision"]
    dropped_sibling_ids: set[str] = set()
    sibling_step_map: dict[str, str] = {}
    if decision_rws:
        for props in live_merges:
            sib = _decode_merge(props, live_entries[props["id"]])
            for srw in sib.rewrites:
                if srw.kind == "relation":
                    sorig_id = _rid_of(RelationInput.model_validate(srw.original))
                    if srw.dropped:
                        dropped_sibling_ids.add(sorig_id)
                    else:
                        sibling_step_map[sorig_id] = restored.get(srw.id, srw.id)

    for rw in decision_rws:
        original = DecisionTraceInput.model_validate(rw.original)
        rewritten = DecisionTraceInput.model_validate(rw.rewritten)
        actor = await end(original.actor_entity, rewritten.actor_entity)
        outcome = await end(original.outcome_entity, rewritten.outcome_entity)
        steps = [restored.get(s, s) for s in rewritten.steps]
        current = await _ops.get_trace(runner, ns, rw.id)
        if current is not None and not rw.existed:
            if current.actor_entity != rewritten.actor_entity:
                actor = current.actor_entity
            if current.outcome_entity != rewritten.outcome_entity:
                outcome = current.outcome_entity
        step_inputs = original.steps
        if current is not None and not rw.existed:
            current_steps = [restored.get(s.relation_id, s.relation_id) for s in current.steps]
            if current_steps != steps:
                step_inputs = current_steps
            steps = current_steps
        if (actor is not None and not await exists(actor)) or (outcome is not None and not await exists(outcome)):
            continue
        if not all([await _ops.relation_exists(runner, ns, s) for s in steps]):
            continue
        base = original
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
            if _backed_elsewhere(rw, rec, siblings):
                handed.add((rw.kind, rw.id))
            else:
                await _ops._delete_trace_quietly(runner, ns, rw.id)
        alternatives = [
            await end(o, r) for o, r in zip(original.alternative_entities, rewritten.alternative_entities, strict=True)
        ]
        if current is not None and not rw.existed and current.alternative_entities != rewritten.alternative_entities:
            alternatives = list(current.alternative_entities)
        restored_steps = []
        for s in step_inputs:
            if s in dropped_sibling_ids and s not in orig_restored:
                continue
            if s in orig_restored:
                restored_steps.append(orig_restored[s])
            elif s in sibling_step_map:
                restored_steps.append(sibling_step_map[s])
            elif s in restored:
                restored_steps.append(restored[s])
            elif await _ops.relation_exists(runner, ns, s):
                restored_steps.append(s)
        back = base.model_copy(
            update={
                "steps": restored_steps,
                "actor_entity": actor,
                "outcome_entity": outcome,
                "alternative_entities": [a for a in alternatives if a is not None and await exists(a)],
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
            status=back.status or "completed",
            event_time=back.event_time,
            created_at=at,
        )
        decisions.append(trace)
        moved.append((rw, _moved_to(rw, trace.id, _dump(back), existed)))

    await _ops.resettle_endpoints(runner, ns, [e for e in gone if e is not None], caps, at, in_place=True)
    if moved:
        await _forward_siblings(runner, ns, rec.id, moved, deleted, handed, live=live_merges, entries=live_entries)
    newest = [
        await _ops.list_relation_versions(runner, ns, rid, newest_first=True) for rid in {r.id: 0 for r in relations}
    ]
    relations = [versions[0] for versions in newest if versions]
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
    await _write_merges(runner, ns, [reverted], {rec.id: entries})
    return UnmergeResult(
        merge=reverted,
        entity=entity,
        survivor=survivor,
        relations=relations,
        preferences=preferences,
        decisions=decisions,
    )
