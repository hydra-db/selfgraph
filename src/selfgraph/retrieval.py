from __future__ import annotations

import heapq
import logging
import math
import re
from collections import deque
from collections.abc import Iterable
from datetime import datetime
from functools import partial
from typing import TYPE_CHECKING

from . import _ops
from ._ops import _paged
from ._serde import (
    L_CHUNK,
    L_ENTITY,
    L_EVIDENCE,
    L_SOURCE_VERSION,
    R_HAS_CHUNK,
    decode_entity,
    from_iso,
    preference_edge_type,
)
from .errors import ValidationError
from .extraction.chunking import count_tokens
from .ids import normalize_text
from .models import Coverage, Entity, Preference, Relation, RetrievalResult, RetrievalSeed, Subgraph
from .terms import expand_tokens, match_terms, stem

_log = logging.getLogger("selfgraph")

if TYPE_CHECKING:
    from .client import SelfGraph

__all__ = ["coverage", "retrieve"]

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
_MAX_POOL = 5000
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
_EMBED_BATCH = 64
_EMBED_CACHE = 50_000
_RRF_K = 60


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


def _short_tokens(text: str) -> set[str]:
    """The single-character tokens of a text, stopwords included, for exact matches against entity names.

    @param text (str): the text to tokenize.
    @return (set[str]): the distinct casefolded one-character tokens.
    """
    return {t for t in re.findall(r"[^\W_]+", _fold(text)) if len(t) == 1}


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


def _term_counts(query: set[str], doc: list[str]) -> dict[str, int]:
    """Count each query token's occurrences in a document, in first-occurrence order.

    @param query (set[str]): the query content tokens.
    @param doc (list[str]): the document's tokens.
    @return (dict[str, int]): the count of each query token the document holds.
    """
    tf: dict[str, int] = {}
    for token in doc:
        if token in query:
            tf[token] = tf.get(token, 0) + 1
    return tf


def _corpus_stats(
    query: set[str], docs: Iterable[list[str]], stats: tuple[int, int, dict[str, int]] | None = None
) -> tuple[int, int, dict[str, int]]:
    """Accumulate the BM25 corpus statistics of some documents onto earlier ones, so a corpus streams in pages.

    @param query (set[str]): the query content tokens.
    @param docs (Iterable[list[str]]): the token list for each document.
    @param stats (tuple[int, int, dict[str, int]] | None): the statistics so far, or None to start.
    @return (tuple[int, int, dict[str, int]]): the document count, total length, and each query token's document
        frequency.
    """
    n, total, df = stats or (0, 0, dict.fromkeys(query, 0))
    for doc in docs:
        n += 1
        total += len(doc)
        for token in _term_counts(query, doc):
            df[token] += 1
    return n, total, df


def _seed_scores(
    entities: Iterable[Entity],
    query_tokens: set[str],
    exact: set[str] | frozenset[str],
    stats: tuple[int, int, dict[str, int]],
) -> list[tuple[Entity, float]]:
    """Score entities by Okapi BM25 over the corpus statistics plus a grep boost and an exact-name boost, divided by
    the log of their source count.

    @param entities (Iterable[Entity]): the entities to score.
    @param query_tokens (set[str]): the content tokens from the query.
    @param exact (set[str] | frozenset[str]): short query tokens that seed an entity whose whole name equals one.
    @param stats (tuple[int, int, dict[str, int]]): the corpus statistics, from _corpus_stats.
    @return (list[tuple[Entity, float]]): the entities with a positive score, with it.
    """
    n, total, df = stats
    avgdl = (total / n if n else 0) or 1.0
    idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in query_tokens}
    scored = []
    for entity in entities:
        text = _entity_text(entity)
        bm25 = 0.0
        if query_tokens:
            doc = list(_tokens(text))
            norm = _BM25_K1 * (1 - _BM25_B + _BM25_B * len(doc) / avgdl)
            tf = _term_counts(query_tokens, doc)
            bm25 = sum(idf[t] * f * (_BM25_K1 + 1) / (f + norm) for t, f in tf.items())
        score = bm25 + _GREP_WEIGHT * (_grep_score(query_tokens, _fold(text)) + (_fold(entity.name) in exact))
        if score > 0:
            scored.append((entity, score / math.log(math.e + entity.source_count)))
    return scored


def _seed_rank(pair: tuple[Entity, float]) -> tuple[float, float, str]:
    """Order seeds best first: higher score, then higher stored relevance, then lower id.

    @param pair (tuple[Entity, float]): an entity and its seed score.
    @return (tuple[float, float, str]): the sort key.
    """
    return -pair[1], -(pair[0].relevance or 0.0), pair[0].id


def _grep_score(terms: set[str], text: str) -> int:
    """Count query terms found as a substring, skipping ASCII terms too short to be specific.

    @param terms (set[str]): the query content tokens.
    @param text (str): the folded searchable text.
    @return (int): the number of terms found as a substring.
    """
    return sum(1 for t in terms if (len(t) >= _GREP_MIN_ASCII or not t.isascii()) and t in text)


def _select_seeds(
    entities: list[Entity], query_tokens: set[str], k: int, exact: set[str] | frozenset[str] = frozenset()
) -> list[tuple[Entity, float]]:
    """Rank entities by BM25 plus a grep boost and an exact-name boost, divided by the log of their source count.

    A tie goes to the higher stored relevance, then the lower id; without relevance the order is unchanged.

    @param entities (list[Entity]): the candidate entities.
    @param query_tokens (set[str]): the content tokens from the query.
    @param k (int): the maximum number of seeds to keep.
    @param exact (set[str] | frozenset[str]): short query tokens that seed an entity whose whole name equals one.
    @return (list[tuple[Entity, float]]): seed entities with their scores, best first.
    """
    stats = _corpus_stats(query_tokens, (list(_tokens(_entity_text(e))) for e in entities))
    return heapq.nsmallest(k, _seed_scores(entities, query_tokens, exact, stats), key=_seed_rank)


async def _scan_seeds(
    graph: SelfGraph,
    ns: str,
    query_tokens: set[str],
    k: int,
    exact: set[str],
    as_of: datetime | None,
    valid: list[Preference] | None,
) -> list[tuple[Entity, float]]:
    """Rank every entity as a seed, as _select_seeds does, in two streaming passes over id-ordered pages.

    The first pass gathers the BM25 corpus statistics and the second scores each page and keeps the best k, so
    memory holds one page and the seeds, never the whole graph.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param query_tokens (set[str]): the content tokens from the query.
    @param k (int): the maximum number of seeds to keep.
    @param exact (set[str]): short query tokens that seed an entity whose whole name equals one.
    @param as_of (datetime | None): score only the entities visible at this time, or None for all.
    @param valid (list[Preference] | None): the preference versions valid at as_of.
    @return (list[tuple[Entity, float]]): seed entities with their scores, best first.
    """
    stats = None
    async for page in _entity_pages(graph, ns, as_of, valid):
        stats = _corpus_stats(query_tokens, (list(_tokens(_entity_text(e))) for e in page), stats)
    best: list[tuple[Entity, float]] = []
    async for page in _entity_pages(graph, ns, as_of, valid):
        best = heapq.nsmallest(k, [*best, *_seed_scores(page, query_tokens, exact, stats)], key=_seed_rank)
    return best


async def _entity_pages(graph: SelfGraph, ns: str, as_of: datetime | None, valid: list[Preference] | None):
    """Stream every entity in id-ordered pages, keeping only those visible at as_of when it is set.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param as_of (datetime | None): keep only the entities visible at this time, or None for all.
    @param valid (list[Preference] | None): the preference versions valid at as_of.
    @return (AsyncIterator[list[Entity]]): the pages.
    """
    fetch = partial(_ops.list_entities, graph.store, ns, type=None, name=None, skip=0)
    async for page in _ops._keyset(lambda after, limit: fetch(limit=limit, after=after)):
        if as_of is not None:
            visible = await _visible_at(graph, ns, page, as_of, valid or [])
            page = [e for e in page if e.id in visible]
        yield page


def _cosine(a: list[float], b: list[float]) -> float:
    """The cosine similarity of two vectors, 0 when either has no length.

    @param a (list[float]): one vector.
    @param b (list[float]): the other vector.
    @return (float): the similarity.
    """
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b, strict=False)) / norm if norm else 0.0


async def _embedding_seeds(
    graph: SelfGraph, ns: str, query: str, k: int, as_of: datetime | None, valid: list[Preference] | None
) -> list[tuple[Entity, float]]:
    """Rank every entity by the embedder's similarity between its text and the query, best first.

    An entity's vector is kept in memory on the graph and reused while its text is unchanged, so each entity is
    embedded once per process.

    @param graph (SelfGraph): the open graph, with an embedder.
    @param ns (str): the namespace to read.
    @param query (str): the query text.
    @param k (int): the maximum number of seeds to keep.
    @param as_of (datetime | None): score only the entities visible at this time, or None for all.
    @param valid (list[Preference] | None): the preference versions valid at as_of.
    @return (list[tuple[Entity, float]]): the entities with a positive similarity, with it.
    """
    embedder, cache = graph._embedder, graph._embeddings
    (target,) = await embedder.embed([query])
    best: list[tuple[Entity, float]] = []
    async for page in _entity_pages(graph, ns, as_of, valid):
        texts = {e.id: _entity_text(e) for e in page}
        found = {e.id: cache[(ns, e.id)][1] for e in page if cache.get((ns, e.id), ("", []))[0] == texts[e.id]}
        stale = [e.id for e in page if e.id not in found]
        for start in range(0, len(stale), _EMBED_BATCH):
            chunk = stale[start : start + _EMBED_BATCH]
            vectors = await embedder.embed([texts[eid] for eid in chunk])
            if len(vectors) != len(chunk):
                raise ValidationError(f"embedder returned {len(vectors)} vectors for {len(chunk)} texts")
            found.update((eid, list(vector)) for eid, vector in zip(chunk, vectors, strict=True))
        if len(cache) + len(stale) > _EMBED_CACHE:
            cache.clear()
        cache.update(((ns, eid), (texts[eid], found[eid])) for eid in stale)
        scored = [(e, _cosine(target, found[e.id])) for e in page]
        best = heapq.nsmallest(k, [*best, *((e, s) for e, s in scored if s > 0)], key=_seed_rank)
    return best


def _fuse(rankings: list[list[tuple[Entity, float]]], k: int) -> list[tuple[Entity, float]]:
    """Merge seed rankings by reciprocal rank fusion, so an entity high in either list ranks high.

    @param rankings (list[list[tuple[Entity, float]]]): the rankings, each best first.
    @param k (int): the maximum number of seeds to keep.
    @return (list[tuple[Entity, float]]): the fused seeds with their fused scores, best first.
    """
    entities: dict[str, Entity] = {}
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, (entity, _) in enumerate(ranking):
            entities[entity.id] = entity
            scores[entity.id] = scores.get(entity.id, 0.0) + 1.0 / (_RRF_K + rank + 1)
    return heapq.nsmallest(k, ((entities[eid], score) for eid, score in scores.items()), key=_seed_rank)


async def _traverse(
    graph: SelfGraph,
    ns: str,
    seed_ids: list[str],
    strategy: str,
    depth: int,
    max_nodes: int,
    prefetch: int,
    as_of: datetime | None = None,
) -> tuple[dict[str, int], list[Relation]]:
    """Walk the current-relation graph out from the seeds in BFS or DFS order over prefetched adjacency.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to traverse.
    @param seed_ids (list[str]): entity ids to start from, best first.
    @param strategy (str): "bfs" or "dfs" traversal order.
    @param depth (int): the maximum number of hops from a seed.
    @param max_nodes (int): the maximum number of entities to collect.
    @param prefetch (int): the most entities whose adjacency to load up front; DFS needs more than it keeps.
    @param as_of (datetime | None): walk the relations valid at this time instead of the current ones.
    @return (tuple[dict[str, int], list[Relation]]): visited entity ids with distance, and the relations among them.
    """
    adjacency = await _prefetch(graph, ns, seed_ids, depth, prefetch, as_of)
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
            adjacency.update(await _neighbors(graph, ns, list(dict.fromkeys([node, *pending]))[:_PAGE], as_of))
        for rel in adjacency[node]:
            relations[rel.id] = rel
            other = rel.to_entity if rel.from_entity == node else rel.from_entity
            if dist.get(other, depth + 1) > d + 1:
                frontier.append((other, d + 1))
    return dist, _within(relations.values(), dist)


async def _prefetch(
    graph: SelfGraph, ns: str, seed_ids: list[str], depth: int, limit: int, as_of: datetime | None = None
) -> dict[str, list[Relation]]:
    """Load the adjacency of entities within depth - 1 hops of the seeds, one batched query per hop.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param seed_ids (list[str]): entity ids to start from.
    @param depth (int): the maximum number of hops from a seed.
    @param limit (int): the most entities to prefetch.
    @param as_of (datetime | None): load the relations valid at this time instead of the current ones.
    @return (dict[str, list[Relation]]): each prefetched entity's adjacent relations.
    """
    adjacency: dict[str, list[Relation]] = {}
    level = list(dict.fromkeys(seed_ids))
    seen = set(level)
    for _ in range(depth):
        level = level[: max(0, limit - len(adjacency))]
        if not level:
            break
        adjacency.update(await _neighbors(graph, ns, level, as_of))
        following = []
        for node in level:
            for rel in adjacency[node]:
                other = rel.to_entity if rel.from_entity == node else rel.from_entity
                if other not in seen:
                    seen.add(other)
                    following.append(other)
        level = following
    return adjacency


async def _visible_at(
    graph: SelfGraph, ns: str, entities: Iterable[Entity], as_of: datetime, preferences: list[Preference]
) -> set[str]:
    """List the entities visible at a point in time on the valid-time axis.

    An entity is visible when it was stored by then, or when it is an endpoint of a relation version, or the
    subject, value, or about entity of a preference version, valid then.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param entities (Iterable[Entity]): the entities to judge.
    @param as_of (datetime): the point in time.
    @param preferences (list[Preference]): the preference versions valid at as_of.
    @return (set[str]): the ids of the visible entities.
    """
    referenced = {r for p in preferences for r in (p.subject_entity, p.value_entity, p.about_entity) if r}
    visible: set[str] = set()
    late: list[str] = []
    for entity in entities:
        if entity.created_at <= as_of or entity.id in referenced:
            visible.add(entity.id)
        else:
            late.append(entity.id)
    for start in range(0, len(late), _PAGE):
        chunk = late[start : start + _PAGE]
        visible.update(r.from_entity for r in await _ops.relations_as_of(graph.store, ns, as_of, from_in=chunk))
        visible.update(r.to_entity for r in await _ops.relations_as_of(graph.store, ns, as_of, to_in=chunk))
    return visible


async def _neighbors(
    graph: SelfGraph, ns: str, nodes: list[str], as_of: datetime | None = None
) -> dict[str, list[Relation]]:
    """Fetch each entity's outgoing then incoming relations; one-sided queries, as OR scans every edge.

    With as_of, each relation is read as the version valid then; its other entity is visible through it, so only
    one whose other entity is gone is dropped.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param nodes (list[str]): the entity ids to expand.
    @param as_of (datetime | None): read the relations valid at this time instead of the current ones.
    @return (dict[str, list[Relation]]): each entity's adjacent relations.
    """
    outgoing: dict[str, list[Relation]] = {n: [] for n in nodes}
    incoming: dict[str, list[Relation]] = {n: [] for n in nodes}
    for start in range(0, len(nodes), _PAGE):
        chunk = nodes[start : start + _PAGE]
        if as_of is None:
            fetch = partial(_ops.list_relations, graph.store, ns, from_entity=None, type=None, to_entity=None)
            found = (await _paged(partial(fetch, from_in=chunk)), await _paged(partial(fetch, to_in=chunk)))
        else:
            found = (
                await _ops.relations_as_of(graph.store, ns, as_of, from_in=chunk),
                await _ops.relations_as_of(graph.store, ns, as_of, to_in=chunk),
            )
            others = list(dict.fromkeys([*(r.to_entity for r in found[0]), *(r.from_entity for r in found[1])]))
            alive = set(await _ops._nodes_by_id(graph.store, ns, L_ENTITY, others))
            found = ([r for r in found[0] if r.to_entity in alive], [r for r in found[1] if r.from_entity in alive])
        for rel in found[0]:
            outgoing[rel.from_entity].append(rel)
        for rel in found[1]:
            incoming[rel.to_entity].append(rel)
    return {n: outgoing[n] + incoming[n] for n in nodes}


async def _load(graph: SelfGraph, ns: str, known: dict[str, Entity], ids: Iterable[str]) -> None:
    """Read the entities not loaded yet into known, a batch of ids per query; a deleted one stays absent.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to read.
    @param known (dict[str, Entity]): the entities loaded so far, by id, updated in place.
    @param ids (Iterable[str]): the entity ids needed.
    @return (None): nothing.
    """
    missing = [eid for eid in dict.fromkeys(ids) if eid not in known]
    for eid, props in (await _ops._nodes_by_id(graph.store, ns, L_ENTITY, missing)).items():
        known[eid] = decode_entity(props)


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


async def _collect_decisions(graph: SelfGraph, ns: str, relation_ids: set[str], as_of: datetime | None = None):
    """Return decision traces that reference any of the given relations.

    @param graph (SelfGraph): the open graph.
    @param ns (str): the namespace to search.
    @param relation_ids (set[str]): the relation ids collected during traversal.
    @param as_of (datetime | None): keep only traces whose effective time is at or before this time.
    @return (list[DecisionTrace]): the matching decision traces.
    """
    if not relation_ids:
        return []
    fetch = partial(_ops.list_traces, graph.store, ns, actor_entity=None, status=None, skip=0)
    found = []
    async for page in _ops._keyset(lambda after, limit: fetch(limit=limit, after=after)):
        found += [
            t
            for t in page
            if any(step.relation_id in relation_ids for step in t.steps)
            and (as_of is None or _ops.effective_time(t) <= as_of)
        ]
    return found


async def _collect_passages(
    graph: SelfGraph,
    ns: str,
    entities: list[Entity],
    dist: dict[str, int],
    query_tokens: set[str],
    as_of: datetime | None = None,
) -> list[str]:
    """Gather the most query-relevant source passages behind the retrieved entities.

    @param graph (SelfGraph): the open graph to read.
    @param ns (str): the namespace to read.
    @param entities (list[Entity]): the collected entities.
    @param dist (dict[str, int]): each entity's closeness rank to the query, lower first (hops, or PageRank rank).
    @param query_tokens (set[str]): the content tokens from the query.
    @param as_of (datetime | None): skip source versions whose effective time (event_time, else created_at) is after it.
    @return (list[str]): passage texts, most query-relevant first.
    """
    far = len(dist) + 1
    sv_dist: dict[str, int] = {}
    stored_at: dict[str, bool] = {}
    for e in sorted(entities, key=lambda e: dist.get(e.id, far)):
        if len(sv_dist) >= _MAX_PASSAGE_SOURCES:
            break
        if not e.source_count:
            continue
        fetch = partial(graph.store.match_nodes, ns, L_EVIDENCE, equals={"target_id": e.id})
        skip = 0
        while len(sv_dist) < _MAX_PASSAGE_SOURCES:
            rows = await fetch(skip=skip, limit=_PAGE)
            if as_of is not None:
                unseen = list(dict.fromkeys(r["source_version"] for r in rows if r["source_version"] not in stored_at))
                versions = await _ops._nodes_by_id(graph.store, ns, L_SOURCE_VERSION, unseen)
                for sv in unseen:
                    props = versions.get(sv)
                    stored_at[sv] = (
                        props is not None and from_iso(props.get("event_time") or props["created_at"]) <= as_of
                    )
            for row in rows:
                if as_of is not None and not stored_at[row["source_version"]]:
                    continue
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


async def _collect_preferences(
    graph: SelfGraph, ns: str, entity_ids, valid: list[Preference] | None
) -> list[Preference]:
    """Return the current preferences held by any of the retrieved entities.

    @param graph (SelfGraph): the open graph to read.
    @param ns (str): the namespace to search.
    @param entity_ids (Iterable[str]): the entity ids collected during traversal, in rank order.
    @param valid (list[Preference] | None): the preference versions valid at as_of to pick from, or None for now.
    @return (list[Preference]): the preferences reached through those entities' profiles, grouped in that order.
    """
    order = {eid: i for i, eid in enumerate(entity_ids)}
    if not order:
        return []
    preferences = valid
    if preferences is None:
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
    @param budget_tokens (int): the maximum estimated tokens to emit; when even the first line does not fit, that
        line is cut to the budget, so a non-empty subgraph never yields an empty context.
    @return (str): the assembled context text.
    """
    lines: list[str] = []
    first: list[str] = []
    used = 0

    def add(line: str, cap: int) -> bool:
        nonlocal used
        if not first:
            first.append(line)
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

    return "\n".join(lines) if lines or not first else _truncate(first[0], budget_tokens)


def _truncate(text: str, budget: int) -> str:
    """Cut text to its longest prefix, in characters, whose token count fits the budget.

    @param text (str): the text to cut.
    @param budget (int): the token budget.
    @return (str): the longest fitting prefix.
    """
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if count_tokens(text[:mid]) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo]


async def retrieve(
    graph: SelfGraph,
    query: str,
    *,
    strategy: str = "bfs",
    depth: int = 3,
    k: int = 20,
    max_nodes: int = 200,
    budget_tokens: int = 3000,
    as_of: datetime | None = None,
    seeds: str = "bm25",
) -> RetrievalResult:
    """Retrieve graph context for a query via keyword seeds and bounded traversal.

    Seeding climbs a ladder: "bm25" scores entities lexically; "synonyms" first adds the name of each schema
    entity type the query names by alias or synonym; "embeddings" also ranks entities by the graph embedder and
    fuses the two rankings.

    With as_of, the graph is read on the valid-time axis: each relation and preference at its version valid then
    (see version_as_of), and an entity when it was stored by then or is an endpoint, subject, value, or about
    entity of one of those versions, so a backdated fact shows with its entities. Decisions effective by then are
    kept unless they name an entity not visible then, and passages come from source versions stored by then.

    @param graph (SelfGraph): the open graph to read.
    @param query (str): the natural-language query to seed from.
    @param strategy (str): "bfs" or "dfs" traversal order, or "ppr" to rank the BFS subgraph by PageRank.
    @param depth (int): the maximum number of hops from a seed.
    @param k (int): the maximum number of seed entities.
    @param max_nodes (int): the maximum number of entities to collect.
    @param budget_tokens (int): the assembled-context token budget.
    @param as_of (datetime | None): the point in time to read the graph at (naive means UTC), or None for now.
    @param seeds (str): the seeding tier: "bm25", "synonyms", or "embeddings".
    @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
    """
    strategy = strategy.lower()
    if strategy not in STRATEGIES:
        raise ValidationError(f"strategy must be one of {', '.join(STRATEGIES)}, got {strategy!r}")
    for name, value, least in (
        ("depth", depth, 0),
        ("k", k, 1),
        ("max_nodes", max_nodes, 1),
        ("budget_tokens", budget_tokens, 1),
    ):
        if value < least:
            raise ValidationError(f"{name} must be >= {least}, got {value}")

    ns = graph.namespace
    query_tokens, exact = _tokens(query), _short_tokens(query)
    seed_tokens = query_tokens
    seed_tier = "bm25"
    if seeds != "bm25" and graph.schema is not None:
        seed_tokens = expand_tokens(query_tokens, graph.schema, _tokens)
        seed_tier = "synonyms"
    valid = None if as_of is None else await _ops.preferences_as_of(graph.store, ns, as_of)
    seeds_scored = await _scan_seeds(graph, ns, seed_tokens, k, exact, as_of, valid) if seed_tokens or exact else []
    if seeds == "embeddings" and graph._embedder is not None:
        semantic = await _embedding_seeds(graph, ns, query, k, as_of, valid)
        seeds_scored = _fuse([seeds_scored, semantic], k)
        seed_tier = "embeddings"
    seed_ids = [e.id for e, _ in seeds_scored]
    known = {e.id: e for e, _ in seeds_scored}

    walk = "dfs" if strategy == "dfs" else "bfs"
    pool = max(max_nodes, min(_MAX_POOL, max_nodes * _POOL_FACTOR))
    cap = pool if strategy == "ppr" else max_nodes
    dist, relations = await _traverse(graph, ns, seed_ids, walk, depth, cap, cap if walk == "bfs" else pool, as_of)
    if strategy == "ppr":
        dist = {n: rank for n, rank in _ppr_rank(seeds_scored, dist, relations).items() if rank < max_nodes}
        relations = _within(relations, dist)

    await _load(graph, ns, known, dist)
    entities = [known[eid] for eid in dist if eid in known]

    decisions = await _collect_decisions(graph, ns, {r.id for r in relations}, as_of)
    preferences = await _collect_preferences(graph, ns, dist, valid)
    if as_of is not None and decisions:
        refs = {r for d in decisions for r in (d.actor_entity, d.outcome_entity, *d.alternative_entities) if r}
        await _load(graph, ns, known, sorted(refs))
        found = [known[eid] for eid in sorted(refs) if eid in known]
        visible = await _visible_at(graph, ns, found, as_of, valid)
        decisions = [
            d
            for d in decisions
            if all(r in visible for r in (d.actor_entity, d.outcome_entity, *d.alternative_entities) if r)
        ]
    passages = await _collect_passages(graph, ns, entities, dist, query_tokens, as_of)
    names = {e.id: e.name for e in entities}
    mentioned = {p.subject_entity for p in preferences} | {p.value_entity for p in preferences}
    for d in decisions:
        mentioned.update(x for x in (d.outcome_entity, *d.alternative_entities) if x)
    await _load(graph, ns, known, sorted(mentioned - names.keys()))
    for eid in mentioned - names.keys():
        if eid in known:
            names[eid] = known[eid].name
    if as_of is not None:
        preferences = [p for p in preferences if p.subject_entity in names and p.value_entity in names]
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
        tiers={"seeds": seed_tier, "traversal": strategy},
    )


async def coverage(graph: SelfGraph, question: str) -> Coverage:
    """Report which content words of a question a schema term or a stored entity grounds.

    Words compare ignoring case and a plain plural ending. The scan over entities stops once every word is
    covered.

    @param graph (SelfGraph): the open graph to read.
    @param question (str): the natural-language question.
    @return (Coverage): the matched terms, the covered and uncovered words in sorted order, and the covered share.
    """
    tokens = _tokens(question)
    terms = match_terms(tokens, graph.schema, _tokens)
    covered = {t for term in terms for t in term.tokens}
    stems: dict[str, set[str]] = {}
    for token in tokens - covered:
        stems.setdefault(stem(token), set()).add(token)
    async for page in _entity_pages(graph, graph.namespace, None, None):
        if not stems:
            break
        for entity in page:
            for word in {stem(t) for t in _tokens(_entity_text(entity))} & stems.keys():
                covered |= stems.pop(word)
    return Coverage(
        question=question,
        terms=terms,
        covered=sorted(covered),
        uncovered=sorted(tokens - covered),
        ratio=len(covered) / len(tokens) if tokens else 0.0,
    )
