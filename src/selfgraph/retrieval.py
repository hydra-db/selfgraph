from __future__ import annotations

import logging
import math
import re
from collections import deque
from functools import partial
from typing import TYPE_CHECKING

from . import _ops
from ._ops import _paged
from ._serde import L_CHUNK, L_EVIDENCE, L_SOURCE_VERSION, R_HAS_CHUNK, preference_edge_type
from .errors import ValidationError
from .extraction.chunking import count_tokens
from .ids import normalize_text
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
_PASSAGE_BUDGET_PERCENT = 60
_BM25_K1 = 2.0
_BM25_B = 1.0
_GREP_WEIGHT = 1.0
_GREP_MIN_ASCII = 3
STRATEGIES = ("bfs", "dfs", "ppr")
_POOL_FACTOR = 4
_PPR_DAMPING = 0.5
_PPR_MAX_ITERATIONS = 50
_PPR_TOLERANCE = 1e-6


def _fold(text: str) -> str:
    """Normalize text to NFC and casefold it, so query and stored text compare in one form.

    @param text (str): the text to fold.
    @return (str): the NFC-normalized, casefolded text.
    """
    return normalize_text(text).casefold()


def _tokens(text: str) -> set[str]:
    """Split text into casefolded Unicode letter and digit tokens, dropping stopwords.

    @param text (str): the text to tokenize.
    @return (set[str]): the distinct content tokens.
    """
    return {t for t in re.findall(r"[^\W_]+", _fold(text)) if t not in _STOPWORDS}


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
    """Count query terms found as a substring, skipping ASCII terms too short to be specific.

    @param terms (set[str]): the query content tokens.
    @param text (str): the folded searchable text.
    @return (int): the number of terms found as a substring.
    """
    return sum(1 for t in terms if (len(t) >= _GREP_MIN_ASCII or not t.isascii()) and t in text)


def _select_seeds(entities: list[Entity], query_tokens: set[str], k: int) -> list[tuple[Entity, float]]:
    """Rank entities by BM25 plus a grep boost, divided by the log of their distinct source count.

    @param entities (list[Entity]): the candidate entities.
    @param query_tokens (set[str]): the content tokens from the query.
    @param k (int): the maximum number of seeds to keep.
    @return (list[tuple[Entity, float]]): seed entities with their scores, best first.
    """
    if not entities:
        return []

    texts = [_entity_text(e) for e in entities]
    docs = [list(_tokens(t)) for t in texts]
    bm25 = _bm25_scores(query_tokens, docs)
    scored = []
    for i, entity in enumerate(entities):
        score = bm25[i] + _GREP_WEIGHT * _grep_score(query_tokens, _fold(texts[i]))
        if score > 0:
            scored.append((entity, score / math.log(math.e + entity.source_count)))
    scored.sort(key=lambda pair: (-pair[1], pair[0].id))
    return scored[:k]


async def _traverse(
    graph: SelfGraph, ns: str, seed_ids: list[str], strategy: str, depth: int, max_nodes: int, prefetch: int
) -> tuple[dict[str, int], list[Relation]]:
    """Walk the current-relation graph out from the seeds in BFS or DFS order over prefetched adjacency.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to traverse.
    @param seed_ids (list[str]): entity ids to start from, best first.
    @param strategy (str): "bfs" or "dfs" traversal order.
    @param depth (int): the maximum number of hops from a seed.
    @param max_nodes (int): the maximum number of entities to collect.
    @param prefetch (int): the most entities whose adjacency to load up front; DFS needs more than it keeps.
    @return (tuple[dict[str, int], list[Relation]]): visited entity ids with distance, and the relations among them.
    """
    adjacency = await _prefetch(graph, ns, seed_ids, depth, prefetch)
    start = [(sid, 0) for sid in seed_ids]
    frontier: deque[tuple[str, int]] = deque(start if strategy == "bfs" else list(reversed(start)))
    dist: dict[str, int] = {}
    relations: dict[str, Relation] = {}
    while frontier and len(dist) < max_nodes:
        node, d = frontier.popleft() if strategy == "bfs" else frontier.pop()
        if dist.get(node, depth + 1) <= d:
            continue
        dist[node] = d
        if d >= depth:
            continue
        if node not in adjacency:
            upcoming = frontier if strategy == "bfs" else reversed(frontier)
            pending = [n for n, nd in upcoming if nd < depth and n not in adjacency]
            adjacency.update(await _neighbors(graph, ns, list(dict.fromkeys([node, *pending]))[:_PAGE]))
        for rel in adjacency[node]:
            relations[rel.id] = rel
            other = rel.to_entity if rel.from_entity == node else rel.from_entity
            if dist.get(other, depth + 1) > d + 1:
                frontier.append((other, d + 1))
    return dist, _within(relations.values(), dist)


async def _prefetch(
    graph: SelfGraph, ns: str, seed_ids: list[str], depth: int, limit: int
) -> dict[str, list[Relation]]:
    """Load the adjacency of entities within depth - 1 hops of the seeds, one batched query per hop.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param seed_ids (list[str]): entity ids to start from.
    @param depth (int): the maximum number of hops from a seed.
    @param limit (int): the most entities to prefetch.
    @return (dict[str, list[Relation]]): each prefetched entity's adjacent relations.
    """
    adjacency: dict[str, list[Relation]] = {}
    level = list(dict.fromkeys(seed_ids))
    seen = set(level)
    for _ in range(depth):
        level = level[: max(0, limit - len(adjacency))]
        if not level:
            break
        adjacency.update(await _neighbors(graph, ns, level))
        following = []
        for node in level:
            for rel in adjacency[node]:
                other = rel.to_entity if rel.from_entity == node else rel.from_entity
                if other not in seen:
                    seen.add(other)
                    following.append(other)
        level = following
    return adjacency


async def _neighbors(graph: SelfGraph, ns: str, nodes: list[str]) -> dict[str, list[Relation]]:
    """Fetch each entity's outgoing then incoming relations; one-sided queries, as OR scans every edge.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param nodes (list[str]): the entity ids to expand.
    @return (dict[str, list[Relation]]): each entity's adjacent relations.
    """
    outgoing: dict[str, list[Relation]] = {n: [] for n in nodes}
    incoming: dict[str, list[Relation]] = {n: [] for n in nodes}
    for start in range(0, len(nodes), _PAGE):
        chunk = nodes[start : start + _PAGE]
        fetch = partial(_ops.list_relations, graph.store, ns, from_entity=None, type=None, to_entity=None)
        for rel in await _paged(partial(fetch, from_in=chunk)):
            outgoing[rel.from_entity].append(rel)
        for rel in await _paged(partial(fetch, to_in=chunk)):
            incoming[rel.to_entity].append(rel)
    return {n: outgoing[n] + incoming[n] for n in nodes}


async def _entity(graph: SelfGraph, ns: str, known: dict[str, Entity], eid: str) -> Entity | None:
    """Return an entity from the already-scanned set, falling back to a store read past the scan limit.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param known (dict[str, Entity]): entities already loaded by the seed scan, by id.
    @param eid (str): the entity id to resolve.
    @return (Entity | None): the entity, or None if it no longer exists.
    """
    return known[eid] if eid in known else await _ops.get_entity(graph.store, ns, eid)


def _within(relations, nodes) -> list[Relation]:
    """Keep only the relations whose two endpoints are both among the given entities.

    @param relations (Iterable[Relation]): the candidate relations.
    @param nodes (Container[str]): the entity ids that were kept.
    @return (list[Relation]): the relations with both endpoints kept.
    """
    return [r for r in relations if r.from_entity in nodes and r.to_entity in nodes]


def _ppr_rank(seeds: list[tuple[Entity, float]], nodes, relations: list[Relation]) -> dict[str, int]:
    """Rank entities by personalized PageRank over source-weighted undirected edges, restarting at the seeds.

    @param seeds (list[tuple[Entity, float]]): seed entities with their scores.
    @param nodes (Iterable[str]): the entity ids collected by traversal.
    @param relations (list[Relation]): the relations collected by traversal.
    @return (dict[str, int]): each entity's rank by PageRank mass, 0 for the highest.
    """
    nodes = set(nodes)
    total = sum(score for e, score in seeds if e.id in nodes)
    if not nodes or total <= 0:
        return {n: i for i, n in enumerate(sorted(nodes))}
    teleport = {e.id: score / total for e, score in seeds if e.id in nodes}
    edges: dict[str, dict[str, float]] = {n: {} for n in nodes}
    for r in relations:
        if r.from_entity in nodes and r.to_entity in nodes and r.from_entity != r.to_entity:
            weight = float(max(1, r.source_count))
            edges[r.from_entity][r.to_entity] = edges[r.from_entity].get(r.to_entity, 0.0) + weight
            edges[r.to_entity][r.from_entity] = edges[r.to_entity].get(r.from_entity, 0.0) + weight
    mass = dict.fromkeys(nodes, 0.0) | teleport
    for _ in range(_PPR_MAX_ITERATIONS):
        nxt = {n: (1 - _PPR_DAMPING) * teleport.get(n, 0.0) for n in nodes}
        for n, m in mass.items():
            out = edges[n]
            if out:
                norm = _PPR_DAMPING * m / sum(out.values())
                for other, weight in out.items():
                    nxt[other] += norm * weight
            else:
                for s, w in teleport.items():
                    nxt[s] += _PPR_DAMPING * m * w
        delta = sum(abs(nxt[n] - mass[n]) for n in nodes)
        mass = nxt
        if delta < _PPR_TOLERANCE:
            break
    return {n: i for i, n in enumerate(sorted(nodes, key=lambda n: (-mass[n], n)))}


async def _collect_decisions(graph: SelfGraph, ns: str, relation_ids: set[str]):
    """Return decision traces that reference any of the given relations.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to search.
    @param relation_ids (set[str]): the relation ids collected during traversal.
    @return (list[DecisionTrace]): the matching decision traces.
    """
    if not relation_ids:
        return []
    traces = await _paged(partial(_ops.list_traces, graph.store, ns, actor_entity=None, status=None), _SCAN_LIMIT)
    return [t for t in traces if any(step.relation_id in relation_ids for step in t.steps)]


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
    @param entities (list[Entity]): the collected entities.
    @param dist (dict[str, int]): each entity's closeness rank to the query, lower first (hops, or PageRank rank).
    @param query_tokens (set[str]): the content tokens from the query.
    @return (list[str]): passage texts, most query-relevant first.
    """
    far = len(dist) + 1
    sv_dist: dict[str, int] = {}
    for e in sorted(entities, key=lambda e: dist.get(e.id, far)):
        if len(sv_dist) >= _MAX_PASSAGE_SOURCES:
            break
        if not e.source_count:
            continue
        fetch = partial(graph.store.match_nodes, ns, L_EVIDENCE, equals={"target_id": e.id})
        skip = 0
        while len(sv_dist) < _MAX_PASSAGE_SOURCES:
            rows = await fetch(skip=skip, limit=_PAGE)
            for row in rows:
                sv_dist.setdefault(row["source_version"], dist.get(e.id, far))
                if len(sv_dist) >= _MAX_PASSAGE_SOURCES:
                    break
            if len(rows) < _PAGE:
                break
            skip += len(rows)

    candidates: list[tuple[float, int, str]] = []
    for sv, d in sv_dist.items():
        chunks = await graph.store.child_nodes(ns, L_SOURCE_VERSION, sv, R_HAS_CHUNK, L_CHUNK, order_by="index")
        for c in sorted(chunks, key=lambda c: int(c["index"])):
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
    @param entity_ids (Iterable[str]): the entity ids collected during traversal, in rank order.
    @return (list[Preference]): the preferences reached through those entities' profiles, grouped in that order.
    """
    order = {eid: i for i, eid in enumerate(entity_ids)}
    if not order:
        return []
    fetch = partial(_ops.list_preferences, graph.store, ns, subject_entity=None, key=None, kind=None)
    preferences = await _paged(fetch)
    return sorted((p for p in preferences if p.subject_entity in order), key=lambda p: order[p.subject_entity])


def _assemble(
    passages,
    entities,
    relations,
    preferences,
    decisions,
    names: dict[str, str],
    dist: dict[str, int],
    budget_tokens: int,
) -> str:
    """Serialise passages and the subgraph into text for an LLM, under a token budget, nearest first.

    @param passages (list[str]): source passages to ground the answer, most relevant first.
    @param entities (list[Entity]): the collected entities.
    @param relations (list[Relation]): the collected relations.
    @param preferences (list[Preference]): the collected preferences.
    @param decisions (list[DecisionTrace]): the collected decision traces.
    @param names (dict[str, str]): display name for every entity id the context mentions.
    @param dist (dict[str, int]): each entity's closeness rank to the query, lower first (hops, or PageRank rank).
    @param budget_tokens (int): the maximum estimated tokens to emit.
    @return (str): the assembled context text.
    """
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

    passage_cap = budget_tokens * _PASSAGE_BUDGET_PERCENT // 100
    for p in passages:
        if not add(p, passage_cap):
            break

    far = len(dist) + 1

    def rel_rank(r: Relation) -> tuple[int, int, float]:
        a, b = dist.get(r.from_entity, far), dist.get(r.to_entity, far)
        return min(a, b), max(a, b), -r.created_at.timestamp()

    ordered = sorted(relations, key=rel_rank)
    for r in ordered:
        line = f"{names.get(r.from_entity, r.from_entity)} -[{r.type}]-> {names.get(r.to_entity, r.to_entity)}"
        props = _format_props(r.properties)
        if props:
            line += f" {props}"
        if not add(line, budget_tokens):
            break

    for p in sorted(preferences, key=lambda p: dist.get(p.subject_entity, far)):
        verb = preference_edge_type(p.kind).lower()
        subject = names.get(p.subject_entity, p.subject_entity)
        value = names.get(p.value_entity, p.value_entity)
        line = f"{subject} {verb} {value} ({p.key})"
        if p.strength is not None:
            line += f" [strength {p.strength}]"
        if not add(line, budget_tokens):
            break

    for d in decisions:
        parts = [f"Decision: {d.title}"]
        if d.outcome_entity:
            parts.append(f"outcome {names.get(d.outcome_entity, d.outcome_entity)}")
        if d.alternative_entities:
            parts.append("alternatives " + ", ".join(names.get(a, a) for a in d.alternative_entities))
        if d.rationale:
            parts.append(f"rationale {d.rationale}")
        add("; ".join(parts), budget_tokens)

    for e in sorted(entities, key=lambda e: dist.get(e.id, far)):
        if not add(f"{e.name} [{e.type}]", budget_tokens):
            break

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
    @param strategy (str): "bfs" or "dfs" traversal order, or "ppr" to rank the BFS subgraph by PageRank.
    @param depth (int): the maximum number of hops from a seed.
    @param k (int): the maximum number of seed entities.
    @param max_nodes (int): the maximum number of entities to collect.
    @param budget_tokens (int): the assembled-context token budget.
    @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
    """
    strategy = strategy.lower()
    if strategy not in STRATEGIES:
        raise ValidationError(f"strategy must be one of {', '.join(STRATEGIES)}, got {strategy!r}")
    if depth < 0 or k < 1 or max_nodes < 1 or budget_tokens < 1:
        raise ValidationError("depth must be >= 0 and k, max_nodes, budget_tokens must be >= 1")

    ns = graph.namespace
    query_tokens = _tokens(query)
    scan = partial(_ops.list_entities, graph.store, ns, type=None, name=None)
    known = {e.id: e for e in await _paged(scan, _SCAN_LIMIT)} if query_tokens else {}
    seeds_scored = _select_seeds(list(known.values()), query_tokens, k)
    seed_ids = [e.id for e, _ in seeds_scored]

    walk = "dfs" if strategy == "dfs" else "bfs"
    pool = max(max_nodes, min(_SCAN_LIMIT, max_nodes * _POOL_FACTOR))
    cap = pool if strategy == "ppr" else max_nodes
    dist, relations = await _traverse(graph, ns, seed_ids, walk, depth, cap, cap if walk == "bfs" else pool)
    if strategy == "ppr":
        dist = {n: rank for n, rank in _ppr_rank(seeds_scored, dist, relations).items() if rank < max_nodes}
        relations = _within(relations, dist)

    entities = [e for e in [await _entity(graph, ns, known, eid) for eid in dist] if e is not None]

    decisions = await _collect_decisions(graph, ns, {r.id for r in relations})
    preferences = await _collect_preferences(graph, ns, dist)
    passages = await _collect_passages(graph, ns, entities, dist, query_tokens)
    names = {e.id: e.name for e in entities}
    mentioned = {p.subject_entity for p in preferences} | {p.value_entity for p in preferences}
    for d in decisions:
        mentioned.update(x for x in (d.outcome_entity, *d.alternative_entities) if x)
    for eid in mentioned - names.keys():
        entity = await _entity(graph, ns, known, eid)
        if entity is not None:
            names[eid] = entity.name
    context = _assemble(passages, entities, relations, preferences, decisions, names, dist, budget_tokens)

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
