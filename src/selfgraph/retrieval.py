from __future__ import annotations

import logging
import math
import re
from collections import deque
from typing import TYPE_CHECKING

from . import _ops
from ._serde import L_CHUNK, L_SOURCE_VERSION, R_HAS_CHUNK
from .errors import ValidationError
from .extraction.chunking import count_tokens
from .models import Entity, Preference, Relation, RetrievalResult, RetrievalSeed, Subgraph

_log = logging.getLogger("selfgraph")

if TYPE_CHECKING:
    from .client import SelfGraph

__all__ = ["retrieve"]

_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "how",
        "in",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "their",
        "them",
        "they",
        "to",
        "was",
        "were",
        "what",
        "when",
        "which",
        "who",
        "why",
        "will",
        "with",
    }
)

_PAGE = 500
_SCAN_LIMIT = 5000
_MAX_PASSAGE_SOURCES = 12
_MAX_PASSAGES = 6
_PASSAGE_BUDGET_FRACTION = 0.6
_BM25_K1 = 2.0
_BM25_B = 1.0
_GREP_WEIGHT = 1.0


def _tokens(text: str) -> set[str]:
    """Split text into lowercase alphanumeric tokens, dropping stopwords and single characters.

    @param text (str): the text to tokenize.
    @return (set[str]): the distinct content tokens.
    """
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) > 1 and t not in _STOPWORDS}


def _entity_text(e: Entity) -> str:
    """Build the searchable text of an entity from its name, type, aliases, and string properties.

    @param e (Entity): the entity to describe.
    @return (str): the concatenated searchable text.
    """
    parts = [e.name, e.type, *e.aliases]
    parts.extend(str(v) for v in e.properties.values() if isinstance(v, str))
    return " ".join(parts)


def _format_props(props: dict) -> str:
    """Render relation properties as a compact brace-wrapped string.

    @param props (dict): the properties to render.
    @return (str): the rendered string, or empty when there are none.
    """
    if not props:
        return ""
    return "{" + ", ".join(f"{k}={v}" for k, v in props.items()) + "}"


def _bm25_scores(query: set[str], docs: list[list[str]]) -> list[float]:
    """Score each document against the query with Okapi BM25.

    @param query (set[str]): the query content tokens.
    @param docs (list[list[str]]): the token list for each document.
    @return (list[float]): a BM25 score per document.
    """
    n = len(docs)
    if not n or not query:
        return [0.0] * n
    lengths = [len(d) for d in docs]
    avgdl = sum(lengths) / n or 1.0
    counts: list[dict[str, int]] = []
    df = dict.fromkeys(query, 0)
    for doc in docs:
        tf: dict[str, int] = {}
        for token in doc:
            if token in query:
                tf[token] = tf.get(token, 0) + 1
        counts.append(tf)
        for token in tf:
            df[token] += 1
    idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in query}
    scores = []
    for tf, length in zip(counts, lengths, strict=False):
        norm = _BM25_K1 * (1 - _BM25_B + _BM25_B * length / avgdl)
        scores.append(sum(idf[t] * f * (_BM25_K1 + 1) / (f + norm) for t, f in tf.items()))
    return scores


def _grep_score(terms: set[str], text: str) -> int:
    """Count query terms that occur as a substring of the text.

    @param terms (set[str]): the query content tokens.
    @param text (str): the lowercased searchable text.
    @return (int): the number of terms found as a substring.
    """
    return sum(1 for t in terms if t in text)


async def _select_seeds(graph: SelfGraph, ns: str, query_tokens: set[str], k: int) -> list[tuple[Entity, float]]:
    """Rank entities against the query by BM25 plus a grep substring boost.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to search.
    @param query_tokens (set[str]): the content tokens from the query.
    @param k (int): the maximum number of seeds to keep.
    @return (list[tuple[Entity, float]]): seed entities with their scores, best first.
    """
    entities: list[Entity] = []
    skip = 0
    while skip < _SCAN_LIMIT:
        batch = await _ops.list_entities(graph.store, ns, type=None, name=None, skip=skip, limit=_PAGE)
        entities.extend(batch)
        skip += len(batch)
        if len(batch) < _PAGE:
            break
    if not entities:
        return []

    texts = [_entity_text(e) for e in entities]
    docs = [list(_tokens(t)) for t in texts]
    bm25 = _bm25_scores(query_tokens, docs)
    scored = []
    for i, entity in enumerate(entities):
        score = bm25[i] + _GREP_WEIGHT * _grep_score(query_tokens, texts[i].lower())
        if score > 0:
            scored.append((entity, score))
    scored.sort(key=lambda pair: (-pair[1], pair[0].id))
    return scored[:k]


async def _traverse(
    graph: SelfGraph, ns: str, seed_ids: list[str], strategy: str, depth: int, max_nodes: int
) -> tuple[dict[str, int], list[Relation]]:
    """Walk the current-relation graph out from the seeds in BFS or DFS order.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to traverse.
    @param seed_ids (list[str]): entity ids to start from, best first.
    @param strategy (str): "bfs" or "dfs" traversal order.
    @param depth (int): the maximum number of hops from a seed.
    @param max_nodes (int): the maximum number of entities to collect.
    @return (tuple[dict[str, int], list[Relation]]): visited entity ids with distance, and the relations traversed.
    """
    start = [(sid, 0) for sid in seed_ids]
    frontier: deque[tuple[str, int]] = deque(start if strategy == "bfs" else list(reversed(start)))
    dist: dict[str, int] = {}
    relations: dict[str, Relation] = {}
    while frontier and len(dist) < max_nodes:
        node, d = frontier.popleft() if strategy == "bfs" else frontier.pop()
        if node in dist:
            continue
        dist[node] = d
        if d >= depth:
            continue
        neighbors = await _ops.list_relations(
            graph.store, ns, from_entity=node, type=None, to_entity=None, skip=0, limit=_SCAN_LIMIT
        )
        neighbors += await _ops.list_relations(
            graph.store, ns, from_entity=None, type=None, to_entity=node, skip=0, limit=_SCAN_LIMIT
        )
        for rel in neighbors:
            relations[rel.id] = rel
            other = rel.to_entity if rel.from_entity == node else rel.from_entity
            if other not in dist:
                frontier.append((other, d + 1))
    return dist, list(relations.values())


async def _collect_decisions(graph: SelfGraph, ns: str, relation_ids: set[str]):
    """Return decision traces that reference any of the given relations.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to search.
    @param relation_ids (set[str]): the relation ids collected during traversal.
    @return (list[DecisionTrace]): the matching decision traces.
    """
    if not relation_ids:
        return []
    out = []
    skip = 0
    while skip < _SCAN_LIMIT:
        batch = await _ops.list_traces(graph.store, ns, actor_entity=None, status=None, skip=skip, limit=_PAGE)
        for t in batch:
            if any(step.relation_id in relation_ids for step in t.steps):
                out.append(t)
        skip += len(batch)
        if len(batch) < _PAGE:
            break
    return out


async def _collect_passages(
    graph: SelfGraph,
    ns: str,
    entities: list[Entity],
    dist: dict[str, int],
    query_tokens: set[str],
) -> list[str]:
    """Gather the most query-relevant source passages behind the retrieved entities.

    @param graph (SelfGraph): the open graph to read.
    @param ns (str): the namespace to read.
    @param entities (list[Entity]): the collected entities carrying source evidence.
    @param dist (dict[str, int]): distance of each entity from the nearest seed.
    @param query_tokens (set[str]): the content tokens from the query.
    @return (list[str]): passage texts, most query-relevant first.
    """
    far = len(dist) + 1
    sv_dist: dict[str, int] = {}
    for e in sorted(entities, key=lambda e: dist.get(e.id, far)):
        for ev in e.evidence:
            if ev.source_version not in sv_dist:
                sv_dist[ev.source_version] = dist.get(e.id, far)
            if len(sv_dist) >= _MAX_PASSAGE_SOURCES:
                break
        if len(sv_dist) >= _MAX_PASSAGE_SOURCES:
            break

    candidates: list[tuple[float, int, str]] = []
    for sv, d in sv_dist.items():
        chunks = await graph.store.child_nodes(ns, L_SOURCE_VERSION, sv, R_HAS_CHUNK, L_CHUNK, order_by="index")
        for c in chunks:
            text = (c.get("text") or "").strip()
            if text:
                candidates.append((float(len(query_tokens & _tokens(text))), d, text))

    candidates.sort(key=lambda t: (-t[0], t[1]))
    out: list[str] = []
    seen: set[str] = set()
    for score, _, text in candidates:
        if score <= 0 or len(out) >= _MAX_PASSAGES:
            break
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


async def _collect_preferences(graph: SelfGraph, ns: str, entity_ids) -> list[Preference]:
    """Return the current preferences held by any of the retrieved entities.

    @param graph (SelfGraph): the open graph to read.
    @param ns (str): the namespace to search.
    @param entity_ids (Iterable[str]): the entity ids collected during traversal.
    @return (list[Preference]): the preferences reached through those entities' profiles.
    """
    out: list[Preference] = []
    for eid in entity_ids:
        out.extend(
            await _ops.list_preferences(
                graph.store, ns, subject_entity=eid, key=None, kind=None, skip=0, limit=_SCAN_LIMIT
            )
        )
    return out


def _assemble(passages, entities, relations, preferences, decisions, dist: dict[str, int], budget_tokens: int) -> str:
    """Serialise passages and the subgraph into text for an LLM, under a token budget, nearest first.

    @param passages (list[str]): source passages to ground the answer, most relevant first.
    @param entities (list[Entity]): the collected entities.
    @param relations (list[Relation]): the collected relations.
    @param preferences (list[Preference]): the collected preferences.
    @param decisions (list[DecisionTrace]): the collected decision traces.
    @param dist (dict[str, int]): distance of each entity from the nearest seed.
    @param budget_tokens (int): the maximum estimated tokens to emit.
    @return (str): the assembled context text.
    """
    name = {e.id: e.name for e in entities}
    lines: list[str] = []
    used = 0

    def add(line: str, cap: int) -> bool:
        nonlocal used
        cost = count_tokens(line)
        if used + cost > cap:
            return False
        lines.append(line)
        used += cost
        return True

    passage_cap = int(budget_tokens * _PASSAGE_BUDGET_FRACTION)
    for p in passages:
        if not add(p, passage_cap):
            break

    far = len(dist) + 1
    ordered = sorted(
        relations,
        key=lambda r: (min(dist.get(r.from_entity, far), dist.get(r.to_entity, far)), -r.created_at.timestamp()),
    )
    for r in ordered:
        line = f"{name.get(r.from_entity, r.from_entity)} -[{r.type}]-> {name.get(r.to_entity, r.to_entity)}"
        props = _format_props(r.properties)
        if props:
            line += f" {props}"
        if not add(line, budget_tokens):
            break

    for p in sorted(preferences, key=lambda p: dist.get(p.subject_entity, far)):
        verb = "prefers" if p.kind == "preference" else "avoids"
        subject = name.get(p.subject_entity, p.subject_entity)
        value = name.get(p.value_entity, p.value_entity)
        line = f"{subject} {verb} {value} ({p.key})"
        if p.strength is not None:
            line += f" [strength {p.strength}]"
        add(line, budget_tokens)

    for d in decisions:
        parts = [f"Decision: {d.title}"]
        if d.outcome_entity:
            parts.append(f"outcome {name.get(d.outcome_entity, d.outcome_entity)}")
        if d.alternative_entities:
            parts.append("alternatives " + ", ".join(name.get(a, a) for a in d.alternative_entities))
        if d.rationale:
            parts.append(f"rationale {d.rationale}")
        add("; ".join(parts), budget_tokens)

    for e in sorted(entities, key=lambda e: dist.get(e.id, far)):
        add(f"{e.name} [{e.type}]", budget_tokens)

    return "\n".join(lines)


async def retrieve(
    graph: SelfGraph,
    query: str,
    *,
    strategy: str = "bfs",
    depth: int = 3,
    k: int = 20,
    max_nodes: int = 200,
    budget_tokens: int = 3000,
) -> RetrievalResult:
    """Retrieve graph context for a query via keyword seeds and bounded traversal.

    @param graph (SelfGraph): the open graph to read.
    @param query (str): the natural-language query to seed from.
    @param strategy (str): "bfs" or "dfs" traversal order.
    @param depth (int): the maximum number of hops from a seed.
    @param k (int): the maximum number of seed entities.
    @param max_nodes (int): the maximum number of entities to collect.
    @param budget_tokens (int): the assembled-context token budget.
    @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
    """
    strategy = strategy.lower()
    if strategy not in ("bfs", "dfs"):
        raise ValidationError(f"strategy must be 'bfs' or 'dfs', got {strategy!r}")
    if depth < 0 or k < 1 or max_nodes < 1 or budget_tokens < 1:
        raise ValidationError("depth must be >= 0 and k, max_nodes, budget_tokens must be >= 1")

    ns = graph.namespace
    query_tokens = _tokens(query)
    seeds_scored = await _select_seeds(graph, ns, query_tokens, k) if query_tokens else []
    seed_ids = [e.id for e, _ in seeds_scored]

    dist, relations = await _traverse(graph, ns, seed_ids, strategy, depth, max_nodes)

    entities = []
    for eid in dist:
        entity = await _ops.get_entity(graph.store, ns, eid)
        if entity is not None:
            entities.append(entity)

    decisions = await _collect_decisions(graph, ns, {r.id for r in relations})
    preferences = await _collect_preferences(graph, ns, dist)
    passages = await _collect_passages(graph, ns, entities, dist, query_tokens)
    context = _assemble(passages, entities, relations, preferences, decisions, dist, budget_tokens)

    _log.debug(
        "retrieve %r: %d seeds, %d entities, %d relations, %d passages",
        query,
        len(seed_ids),
        len(entities),
        len(relations),
        len(passages),
    )
    return RetrievalResult(
        query=query,
        strategy=strategy,
        seeds=[RetrievalSeed(id=e.id, score=s) for e, s in seeds_scored],
        subgraph=Subgraph(entities=entities, relations=relations, preferences=preferences, decisions=decisions),
        context=context,
    )
