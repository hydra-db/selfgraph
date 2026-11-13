import { type GraphAccess, seedTier } from "./access.js";
import { loadTokenizer } from "./chunking.js";
import { ValidationError } from "./errors.js";
import { normalizeText } from "./ids.js";
import { casefold } from "./internal/casefold.js";
import { comparePy, cpLen, NON_ASCII, pyFloatRepr, pyRepr, pyStr, pyStrip } from "./internal/py.js";
import { epochMicros, fromIso } from "./internal/time.js";
import { L_CHUNK, L_ENTITY, L_EVIDENCE, L_SOURCE_VERSION, preferenceEdgeType, R_HAS_CHUNK } from "./labels.js";
import type {
  Coverage,
  DateTimeInput,
  DecisionTrace,
  Entity,
  JsonObject,
  Preference,
  Relation,
  RetrievalResult,
  Subgraph,
} from "./models.js";
import * as ops from "./ops.js";
import type { GraphPrimitives } from "./protocols.js";
import { decodeEntity } from "./serde.js";
import { expandTokens, matchTerms, stem } from "./terms.js";
import type { SeedTier } from "./tiers.js";
import { checkOptions, keysOf, parseTime, requireInt, typeName } from "./validate.js";

const STOPWORDS = new Set(
  (
    "a an and are as at be by did do does for from had has have how in is it its of on or that the their " +
    "them they to was were what when which who why will with"
  ).split(" "),
);

const PAGE = 500;
const MAX_POOL = 5000;
const MAX_PASSAGE_SOURCES = 12;
const MAX_PASSAGES = 6;
const PASSAGE_BUDGET_PERCENT = 60;
const BM25_K1 = 2.0;
const BM25_B = 1.0;
const GREP_WEIGHT = 1.0;
const GREP_MIN_ASCII = 3;
const POOL_FACTOR = 4;
const PPR_DAMPING = 0.5;
const PPR_MAX_ITERATIONS = 50;
const PPR_TOLERANCE = 1e-6;
const EMBED_BATCH = 64;
const EMBED_CACHE = 50_000;
const RRF_K = 60;

export const STRATEGIES = ["bfs", "dfs", "ppr"] as const;

export const RETRIEVE_DEFAULTS = { strategy: "bfs", depth: 3, k: 20, max_nodes: 200, budget_tokens: 3000 } as const;

const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * NFC-normalize and casefold text, so query and stored text compare in one form.
 *
 * @param text (string): the text to fold.
 * @return (string): the folded text.
 */
export function fold(text: string): string {
  return casefold(normalizeText(text));
}

/**
 * Split text into casefolded Unicode letter and digit tokens, dropping stopwords.
 *
 * @param text (string): the text to tokenize.
 * @return (Set<string>): the distinct content tokens.
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of fold(text).matchAll(TOKEN)) if (!STOPWORDS.has(m[0])) out.add(m[0]);
  return out;
}

/**
 * The single-character tokens of a text, stopwords included, for exact matches against entity names.
 *
 * @param text (string): the text to tokenize.
 * @return (Set<string>): the distinct casefolded one-character tokens.
 */
function shortTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of fold(text).matchAll(TOKEN)) if ([...m[0]].length === 1) out.add(m[0]);
  return out;
}

function entityText(e: Entity): string {
  const parts = [e.name, e.type, ...e.aliases];
  for (const v of Object.values(e.properties)) if (typeof v === "string") parts.push(v);
  return parts.join(" ");
}

/**
 * Render relation properties as a compact brace-wrapped string, values rendered by pyStr.
 *
 * @param props (JsonObject): the properties.
 * @return (string): the rendered text, or empty when there are none.
 */
export function formatProps(props: JsonObject): string {
  const entries = Object.entries(props);
  if (!entries.length) return "";
  return `{${entries.map(([k, v]) => `${k}=${pyStr(v)}`).join(", ")}}`;
}

/**
 * Count each query token's occurrences in a document, in first-occurrence order.
 *
 * @param query (Set<string>): the query content tokens.
 * @param doc (string[]): the document's tokens.
 * @return (Map<string, number>): the count of each query token the document holds.
 */
function termCounts(query: Set<string>, doc: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of doc) if (query.has(token)) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

interface CorpusStats {
  n: number;
  total: number;
  df: Map<string, number>;
}

/**
 * Accumulate the BM25 corpus statistics of some documents onto earlier ones, so a corpus streams in pages.
 *
 * @param query (Set<string>): the query content tokens.
 * @param docs (Iterable<string[]>): the token list for each document.
 * @param stats (CorpusStats | null): the statistics so far, or null to start.
 * @return (CorpusStats): the document count, total length, and each query token's document frequency.
 */
function corpusStats(query: Set<string>, docs: Iterable<string[]>, stats: CorpusStats | null = null): CorpusStats {
  const out = stats ?? { n: 0, total: 0, df: new Map([...query].map((t) => [t, 0])) };
  for (const doc of docs) {
    out.n += 1;
    out.total += doc.length;
    for (const token of termCounts(query, doc).keys()) out.df.set(token, (out.df.get(token) ?? 0) + 1);
  }
  return out;
}

/**
 * Score entities by Okapi BM25 over the corpus statistics plus a substring boost and an exact-name boost, divided by the log of their source count.
 *
 * @param entities (Iterable<Entity>): the entities to score.
 * @param queryTokens (Set<string>): the content tokens from the query.
 * @param exact (Set<string>): short query tokens that seed an entity whose whole name equals one.
 * @param stats (CorpusStats): the corpus statistics, from corpusStats.
 * @return (Array<[Entity, number]>): the entities with a positive score, with it.
 */
function seedScores(
  entities: Iterable<Entity>,
  queryTokens: Set<string>,
  exact: Set<string>,
  stats: CorpusStats,
): Array<[Entity, number]> {
  const { n, total, df } = stats;
  const avgdl = (n ? total / n : 0) || 1.0;
  const idf = new Map([...df].map(([t, d]) => [t, Math.log(1 + (n - d + 0.5) / (d + 0.5))]));
  const scored: Array<[Entity, number]> = [];
  for (const entity of entities) {
    const text = entityText(entity);
    let bm25 = 0;
    if (queryTokens.size) {
      const doc = [...tokens(text)];
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgdl);
      for (const [t, f] of termCounts(queryTokens, doc)) bm25 += ((idf.get(t) ?? 0) * f * (BM25_K1 + 1)) / (f + norm);
    }
    const named = exact.has(fold(entity.name)) ? 1 : 0;
    const score = bm25 + GREP_WEIGHT * (grepScore(queryTokens, fold(text)) + named);
    if (score > 0) scored.push([entity, score / Math.log(Math.E + entity.source_count)]);
  }
  return scored;
}

/**
 * Keep the best k seeds: higher score, then higher stored relevance, then lower id.
 *
 * @param scored (Array<[Entity, number]>): entities with their seed scores.
 * @param k (number): the maximum number of seeds.
 * @return (Array<[Entity, number]>): the best k, best first.
 */
function bestSeeds(scored: Array<[Entity, number]>, k: number): Array<[Entity, number]> {
  scored.sort((a, b) => b[1] - a[1] || (b[0].relevance ?? 0) - (a[0].relevance ?? 0) || comparePy(a[0].id, b[0].id));
  return scored.slice(0, k);
}

/**
 * Count query terms occurring as a substring of the text, skipping short ASCII terms but counting non-ASCII terms at any length.
 *
 * @param terms (Set<string>): the query content tokens.
 * @param text (string): the folded searchable text.
 * @return (number): the number of terms found.
 */
export function grepScore(terms: Set<string>, text: string): number {
  let n = 0;
  for (const t of terms) if ((cpLen(t) >= GREP_MIN_ASCII || NON_ASCII.test(t)) && text.includes(t)) n++;
  return n;
}

/**
 * Rank entities against the query by BM25 plus a substring boost, divided by the log of distinct mentioning sources so generic entities do not crowd out specific ones; a tie goes to the higher stored relevance, then the lower id.
 *
 * @param entities (Entity[]): the candidate entities.
 * @param queryTokens (Set<string>): the content tokens from the query.
 * @param k (number): the maximum number of seeds.
 * @return (Array<[Entity, number]>): seed entities with their scores, best first.
 */
export function selectSeeds(entities: Entity[], queryTokens: Set<string>, k: number): Array<[Entity, number]> {
  const stats = corpusStats(
    queryTokens,
    entities.map((e) => [...tokens(entityText(e))]),
  );
  return bestSeeds(seedScores(entities, queryTokens, new Set(), stats), k);
}

/**
 * Rank every entity as a seed, as selectSeeds does, in two streaming passes over id-ordered pages: the first gathers the BM25 corpus statistics and the second scores each page and keeps the best k, so memory holds one page and the seeds, never the whole graph.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param queryTokens (Set<string>): the content tokens from the query.
 * @param k (number): the maximum number of seeds.
 * @param exact (Set<string>): short query tokens that seed an entity whose whole name equals one.
 * @param asOf (Date | null): score only the entities visible at this time, or null for all.
 * @param valid (Preference[] | null): the preference versions valid at asOf.
 * @return (Array<[Entity, number]>): seed entities with their scores, best first.
 */
async function scanSeeds(
  store: GraphPrimitives,
  ns: string,
  queryTokens: Set<string>,
  k: number,
  exact: Set<string>,
  asOf: Date | null,
  valid: Preference[] | null,
): Promise<Array<[Entity, number]>> {
  let stats: CorpusStats | null = null;
  for await (const page of entityPages(store, ns, asOf, valid)) {
    stats = corpusStats(
      queryTokens,
      page.map((e) => [...tokens(entityText(e))]),
      stats,
    );
  }
  let best: Array<[Entity, number]> = [];
  for await (const page of entityPages(store, ns, asOf, valid)) {
    best = bestSeeds([...best, ...seedScores(page, queryTokens, exact, stats!)], k);
  }
  return best;
}

/**
 * Stream every entity in id-ordered pages, keeping only those visible at asOf when it is set.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to read.
 * @param asOf (Date | null): keep only the entities visible at this time, or null for all.
 * @param valid (Preference[] | null): the preference versions valid at asOf.
 * @return (AsyncGenerator<Entity[]>): the pages.
 */
async function* entityPages(
  store: GraphPrimitives,
  ns: string,
  asOf: Date | null,
  valid: Preference[] | null,
): AsyncGenerator<Entity[]> {
  for await (const page of ops.keyset((after, limit) => ops.listEntities(store, ns, { skip: 0, limit, after }))) {
    if (asOf === null || valid === null) {
      yield page;
      continue;
    }
    const visible = await visibleAt(store, ns, page, asOf, valid);
    yield page.filter((e) => visible.has(e.id));
  }
}

/**
 * The cosine similarity of two vectors, 0 when either has no length.
 *
 * @param a (readonly number[]): one vector.
 * @param b (readonly number[]): the other vector.
 * @return (number): the similarity.
 */
function cosine(a: readonly number[], b: readonly number[]): number {
  const dot = (x: readonly number[], y: readonly number[]): number => {
    let sum = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i++) sum += x[i]! * y[i]!;
    return sum;
  };
  const norm = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return norm ? dot(a, b) / norm : 0;
}

/**
 * Rank every entity by the embedder's similarity between its text and the query, best first.
 *
 * An entity's vector is kept in memory on the graph and reused while its text is unchanged, so each entity is
 * embedded once per process.
 *
 * @param graph (GraphAccess): the graph, with an embedder.
 * @param store (GraphPrimitives): the graph reader.
 * @param query (string): the query text.
 * @param k (number): the maximum number of seeds to keep.
 * @param asOf (Date | null): score only the entities visible at this time, or null for all.
 * @param valid (Preference[] | null): the preference versions valid at asOf.
 * @return (Array<[Entity, number]>): the entities with a positive similarity, with it.
 */
async function embeddingSeeds(
  graph: GraphAccess,
  store: GraphPrimitives,
  query: string,
  k: number,
  asOf: Date | null,
  valid: Preference[] | null,
): Promise<Array<[Entity, number]>> {
  const ns = graph.namespace;
  const { embeddings: cache } = graph.tiers;
  const embedder = graph.tiers.embedder!;
  const embed = async (texts: string[]): Promise<number[][]> => {
    const vectors = await embedder.embed(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      const count = Array.isArray(vectors) ? vectors.length : 0;
      throw new ValidationError(`embedder returned ${count} vectors for ${texts.length} texts`);
    }
    return vectors;
  };
  const [target] = await embed([query]);
  const key = (eid: string): string => JSON.stringify([ns, eid]);
  let best: Array<[Entity, number]> = [];
  for await (const page of entityPages(store, ns, asOf, valid)) {
    const texts = new Map(page.map((e) => [e.id, entityText(e)]));
    const found = new Map<string, number[]>();
    for (const e of page) {
      const kept = cache.get(key(e.id));
      if (kept !== undefined && kept[0] === texts.get(e.id)) found.set(e.id, kept[1]);
    }
    const stale = page.map((e) => e.id).filter((eid) => !found.has(eid));
    for (let start = 0; start < stale.length; start += EMBED_BATCH) {
      const chunk = stale.slice(start, start + EMBED_BATCH);
      const vectors = await embed(chunk.map((eid) => texts.get(eid)!));
      chunk.forEach((eid, i) => {
        found.set(eid, [...vectors[i]!]);
      });
    }
    if (cache.size + stale.length > EMBED_CACHE) cache.clear();
    for (const eid of stale) cache.set(key(eid), [texts.get(eid)!, found.get(eid)!]);
    const scored: Array<[Entity, number]> = [];
    for (const e of page) {
      const score = cosine(target!, found.get(e.id)!);
      if (score > 0) scored.push([e, score]);
    }
    best = bestSeeds([...best, ...scored], k);
  }
  return best;
}

/**
 * Merge seed rankings by reciprocal rank fusion, so an entity high in either list ranks high.
 *
 * @param rankings (ReadonlyArray<ReadonlyArray<[Entity, number]>>): the rankings, each best first.
 * @param k (number): the maximum number of seeds to keep.
 * @return (Array<[Entity, number]>): the fused seeds with their fused scores, best first.
 */
function fuse(rankings: ReadonlyArray<ReadonlyArray<[Entity, number]>>, k: number): Array<[Entity, number]> {
  const entities = new Map<string, Entity>();
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [rank, [entity]] of ranking.entries()) {
      entities.set(entity.id, entity);
      scores.set(entity.id, (scores.get(entity.id) ?? 0) + 1 / (RRF_K + rank + 1));
    }
  }
  return bestSeeds(
    [...scores].map(([eid, score]) => [entities.get(eid)!, score] as [Entity, number]),
    k,
  );
}

/**
 * List the entities visible at a point in time on the valid-time axis. An entity is visible when it was stored by then, or when it is an endpoint of a relation version, or the subject, value, or about entity of a preference version, valid then.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to read.
 * @param entities (Iterable<Entity>): the entities to judge.
 * @param asOf (Date): the point in time.
 * @param preferences (Preference[]): the preference versions valid at asOf.
 * @return (Set<string>): the ids of the visible entities.
 */
async function visibleAt(
  store: GraphPrimitives,
  ns: string,
  entities: Iterable<Entity>,
  asOf: Date,
  preferences: Preference[],
): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const p of preferences) {
    for (const r of [p.subject_entity, p.value_entity, p.about_entity]) if (r) referenced.add(r);
  }
  const visible = new Set<string>();
  const late: string[] = [];
  for (const entity of entities) {
    if (epochMicros(entity.created_at) <= epochMicros(asOf) || referenced.has(entity.id)) visible.add(entity.id);
    else late.push(entity.id);
  }
  for (let start = 0; start < late.length; start += PAGE) {
    const chunk = late.slice(start, start + PAGE);
    for (const r of await ops.relationsAsOf(store, ns, asOf, { from_in: chunk })) visible.add(r.from_entity);
    for (const r of await ops.relationsAsOf(store, ns, asOf, { to_in: chunk })) visible.add(r.to_entity);
  }
  return visible;
}

/**
 * Fetch each entity's outgoing then incoming relations; one-sided queries, as OR scans every edge. With asOf, each relation is read as the version valid then; its other entity is visible through it, so only one whose other entity is gone is dropped.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to read.
 * @param nodes (string[]): the entity ids to expand.
 * @param asOf (Date | null): read the relations valid at this time instead of the current ones.
 * @return (Map<string, Relation[]>): each entity's adjacent relations.
 */
async function neighbors(
  store: GraphPrimitives,
  ns: string,
  nodes: string[],
  asOf: Date | null = null,
): Promise<Map<string, Relation[]>> {
  const outgoing = new Map<string, Relation[]>(nodes.map((n) => [n, []]));
  const incoming = new Map<string, Relation[]>(nodes.map((n) => [n, []]));
  const page = (filter: { from_in?: string[]; to_in?: string[] }) => (skip: number, limit: number) =>
    ops.listRelations(store, ns, { skip, limit, ...filter });
  for (let start = 0; start < nodes.length; start += PAGE) {
    const chunk = nodes.slice(start, start + PAGE);
    let out: Relation[];
    let inc: Relation[];
    if (asOf === null) {
      out = await ops.scan(page({ from_in: chunk }));
      inc = await ops.scan(page({ to_in: chunk }));
    } else {
      out = await ops.relationsAsOf(store, ns, asOf, { from_in: chunk });
      inc = await ops.relationsAsOf(store, ns, asOf, { to_in: chunk });
      const others = [...new Set([...out.map((r) => r.to_entity), ...inc.map((r) => r.from_entity)])];
      const alive = new Set((await ops.nodesById(store, ns, L_ENTITY, others)).keys());
      out = out.filter((r) => alive.has(r.to_entity));
      inc = inc.filter((r) => alive.has(r.from_entity));
    }
    for (const rel of out) outgoing.get(rel.from_entity)?.push(rel);
    for (const rel of inc) incoming.get(rel.to_entity)?.push(rel);
  }
  return new Map(nodes.map((n) => [n, [...(outgoing.get(n) ?? []), ...(incoming.get(n) ?? [])]]));
}

/**
 * Load the adjacency of entities within depth - 1 hops of the seeds, one batched query per hop, leaving anything past the limit to lazy traversal.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to read.
 * @param seedIds (string[]): entity ids to start from.
 * @param depth (number): the maximum number of hops from a seed.
 * @param limit (number): the most entities to prefetch.
 * @param asOf (Date | null): load the relations valid at this time instead of the current ones.
 * @return (Map<string, Relation[]>): each prefetched entity's adjacent relations.
 */
async function prefetch(
  store: GraphPrimitives,
  ns: string,
  seedIds: string[],
  depth: number,
  limit: number,
  asOf: Date | null = null,
): Promise<Map<string, Relation[]>> {
  const adjacency = new Map<string, Relation[]>();
  let level = [...new Set(seedIds)];
  const seen = new Set(level);
  for (let hop = 0; hop < depth; hop++) {
    level = level.slice(0, Math.max(0, limit - adjacency.size));
    if (!level.length) break;
    for (const [n, rels] of await neighbors(store, ns, level, asOf)) adjacency.set(n, rels);
    const following: string[] = [];
    for (const node of level) {
      for (const rel of adjacency.get(node) ?? []) {
        const other = otherEnd(rel, node);
        if (!seen.has(other)) {
          seen.add(other);
          following.push(other);
        }
      }
    }
    level = following;
  }
  return adjacency;
}

function within(relations: Iterable<Relation>, nodes: { has(id: string): boolean }): Relation[] {
  return [...relations].filter((r) => nodes.has(r.from_entity) && nodes.has(r.to_entity));
}

const otherEnd = (rel: Relation, node: string): string => (rel.from_entity === node ? rel.to_entity : rel.from_entity);

const distanceIn = (dist: Map<string, number>): ((id: string) => number) => {
  const far = dist.size + 1;
  return (id) => dist.get(id) ?? far;
};

/**
 * Walk the current-relation graph out from the seeds in BFS or DFS order over a per-hop prefetched adjacency cache.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to traverse.
 * @param seedIds (string[]): entity ids to start from, best first.
 * @param strategy (string): "bfs" or "dfs" traversal order.
 * @param depth (number): the maximum number of hops from a seed.
 * @param maxNodes (number): the maximum number of entities to collect.
 * @param prefetchLimit (number): the most entities whose adjacency to load up front; DFS needs more than it keeps.
 * @param asOf (Date | null): walk the relations valid at this time instead of the current ones.
 * @return ([Map<string, number>, Relation[]]): visited entity ids with distance, and the relations among them.
 */
async function traverse(
  store: GraphPrimitives,
  ns: string,
  seedIds: string[],
  strategy: string,
  depth: number,
  maxNodes: number,
  prefetchLimit: number,
  asOf: Date | null = null,
): Promise<[Map<string, number>, Relation[]]> {
  const bfs = strategy === "bfs";
  const adjacency = await prefetch(store, ns, seedIds, depth, prefetchLimit, asOf);
  const start: Array<[string, number]> = seedIds.map((sid) => [sid, 0]);
  const frontier: Array<[string, number]> = bfs ? start : start.reverse();
  let head = 0;
  const dist = new Map<string, number>();
  const relations = new Map<string, Relation>();
  while (frontier.length > head && dist.size < maxNodes) {
    const next = bfs ? frontier[head++] : frontier.pop();
    if (next === undefined) break;
    const [node, d] = next;
    if ((dist.get(node) ?? depth + 1) <= d) continue;
    dist.set(node, d);
    if (d >= depth) continue;
    if (!adjacency.has(node)) {
      const rest = frontier.slice(head);
      const upcoming = bfs ? rest : rest.reverse();
      const pending = upcoming.filter(([n, nd]) => nd < depth && !adjacency.has(n)).map(([n]) => n);
      const batch = [...new Set([node, ...pending])].slice(0, PAGE);
      for (const [n, rels] of await neighbors(store, ns, batch, asOf)) adjacency.set(n, rels);
    }
    for (const rel of adjacency.get(node) ?? []) {
      relations.set(rel.id, rel);
      const other = otherEnd(rel, node);
      if ((dist.get(other) ?? depth + 1) > d + 1) frontier.push([other, d + 1]);
    }
  }
  return [dist, within(relations.values(), dist)];
}

/**
 * Rank collected entities by personalized PageRank mass teleporting to the scored seeds, edges undirected and weighted by distinct source count.
 *
 * @param seeds (Array<[Entity, number]>): seed entities with their scores.
 * @param nodes (Iterable<string>): the entity ids collected by traversal.
 * @param relations (Relation[]): the relations collected by traversal.
 * @return (Map<string, number>): each entity's rank by mass, 0 for the highest.
 */
export function pprRank(
  seeds: Array<[Entity, number]>,
  nodes: Iterable<string>,
  relations: Relation[],
): Map<string, number> {
  const nodeSet = new Set(nodes);
  const nodeList = [...nodeSet];
  const total = seeds.reduce((acc, [e, score]) => (nodeSet.has(e.id) ? acc + score : acc), 0);
  if (!nodeList.length || total <= 0) {
    return new Map(nodeList.sort(comparePy).map((n, i) => [n, i]));
  }
  const teleport = new Map<string, number>();
  for (const [e, score] of seeds) if (nodeSet.has(e.id)) teleport.set(e.id, score / total);
  const edges = new Map<string, Map<string, number>>(nodeList.map((n) => [n, new Map()]));
  for (const r of relations) {
    if (nodeSet.has(r.from_entity) && nodeSet.has(r.to_entity) && r.from_entity !== r.to_entity) {
      const weight = Math.max(1, r.source_count);
      const a = edges.get(r.from_entity);
      const b = edges.get(r.to_entity);
      a?.set(r.to_entity, (a.get(r.to_entity) ?? 0) + weight);
      b?.set(r.from_entity, (b.get(r.from_entity) ?? 0) + weight);
    }
  }
  let mass = new Map<string, number>(nodeList.map((n) => [n, teleport.get(n) ?? 0]));
  for (let iteration = 0; iteration < PPR_MAX_ITERATIONS; iteration++) {
    const next = new Map<string, number>(nodeList.map((n) => [n, (1 - PPR_DAMPING) * (teleport.get(n) ?? 0)]));
    for (const [n, m] of mass) {
      const out = edges.get(n) ?? new Map<string, number>();
      if (out.size) {
        let sum = 0;
        for (const w of out.values()) sum += w;
        const norm = (PPR_DAMPING * m) / sum;
        for (const [other, weight] of out) next.set(other, (next.get(other) ?? 0) + norm * weight);
      } else {
        for (const [s, w] of teleport) next.set(s, (next.get(s) ?? 0) + PPR_DAMPING * m * w);
      }
    }
    let delta = 0;
    for (const n of nodeList) delta += Math.abs((next.get(n) ?? 0) - (mass.get(n) ?? 0));
    mass = next;
    if (delta < PPR_TOLERANCE) break;
  }
  const massOf = (n: string): number => mass.get(n) ?? 0;
  const ranked = nodeList.sort((a, b) => massOf(b) - massOf(a) || comparePy(a, b));
  return new Map(ranked.map((n, i) => [n, i]));
}

/**
 * Read the entities not loaded yet into known, a batch of ids per query; a deleted one stays absent.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param known (Map<string, Entity>): the entities loaded so far, by id, updated in place.
 * @param eids (Iterable<string>): the entity ids needed.
 */
async function load(
  store: GraphPrimitives,
  ns: string,
  known: Map<string, Entity>,
  eids: Iterable<string>,
): Promise<void> {
  const missing = [...new Set(eids)].filter((eid) => !known.has(eid));
  for (const [eid, props] of await ops.nodesById(store, ns, L_ENTITY, missing)) known.set(eid, decodeEntity(props));
}

async function collectDecisions(
  store: GraphPrimitives,
  ns: string,
  relationIds: Set<string>,
  asOf: Date | null = null,
): Promise<DecisionTrace[]> {
  if (!relationIds.size) return [];
  const found: DecisionTrace[] = [];
  for await (const page of ops.keyset((after, limit) => ops.listTraces(store, ns, { skip: 0, limit, after }))) {
    found.push(
      ...page.filter(
        (t) =>
          t.steps.some((s) => relationIds.has(s.relation_id)) &&
          (asOf === null || epochMicros(ops.effectiveTime(t)) <= epochMicros(asOf)),
      ),
    );
  }
  return found;
}

async function collectPassages(
  store: GraphPrimitives,
  ns: string,
  entities: Entity[],
  dist: Map<string, number>,
  queryTokens: Set<string>,
  asOf: Date | null = null,
): Promise<string[]> {
  const distOf = distanceIn(dist);
  const svDist = new Map<string, number>();
  const storedAt = new Map<string, boolean>();
  for (const e of [...entities].sort((a, b) => distOf(a.id) - distOf(b.id))) {
    if (svDist.size >= MAX_PASSAGE_SOURCES) break;
    if (!e.source_count) continue;
    const fetch = ops.nodeListing(store, ns, L_EVIDENCE, { equals: { target_id: e.id } });
    for (let skip = 0; svDist.size < MAX_PASSAGE_SOURCES; ) {
      const rows = await fetch(skip, PAGE);
      if (asOf !== null) {
        const unseen = [...new Set(rows.map((r) => r.source_version as string).filter((sv) => !storedAt.has(sv)))];
        const versions = await ops.nodesById(store, ns, L_SOURCE_VERSION, unseen);
        for (const sv of unseen) {
          const props = versions.get(sv);
          const effective = fromIso(props?.event_time ?? props?.created_at);
          storedAt.set(sv, effective != null && epochMicros(effective) <= epochMicros(asOf));
        }
      }
      for (const row of rows) {
        const sv = row.source_version as string;
        if (asOf !== null && !storedAt.get(sv)) continue;
        if (!svDist.has(sv)) svDist.set(sv, distOf(e.id));
        if (svDist.size >= MAX_PASSAGE_SOURCES) break;
      }
      if (rows.length < PAGE) break;
      skip += rows.length;
    }
  }

  const candidates: Array<[number, number, string]> = [];
  for (const [sv, d] of svDist) {
    const chunks = await store.childNodes(ns, L_SOURCE_VERSION, sv, R_HAS_CHUNK, L_CHUNK);
    chunks.sort((a, b) => Math.trunc(Number(a.index)) - Math.trunc(Number(b.index)));
    for (const chunk of chunks) {
      const text = typeof chunk.text === "string" ? pyStrip(chunk.text) : "";
      if (text) {
        let overlap = 0;
        for (const t of tokens(text)) if (queryTokens.has(t)) overlap++;
        candidates.push([overlap, d, text]);
      }
    }
  }

  candidates.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [score, , text] of candidates) {
    if (score <= 0 || out.length >= MAX_PASSAGES) break;
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

async function collectPreferences(
  store: GraphPrimitives,
  ns: string,
  entityIds: Iterable<string>,
  valid: Preference[] | null,
): Promise<Preference[]> {
  const order = new Map<string, number>();
  for (const eid of entityIds) order.set(eid, order.size);
  if (!order.size) return [];
  const prefs = valid ?? (await ops.scan((skip, limit) => ops.listPreferences(store, ns, { skip, limit })));
  return prefs
    .filter((p) => order.has(p.subject_entity))
    .sort((a, b) => (order.get(a.subject_entity) ?? 0) - (order.get(b.subject_entity) ?? 0));
}

/**
 * Fill the token budget with passages, then relations, preferences, decisions, and entities, nearest first.
 *
 * @param passages (string[]): the ranked source passages.
 * @param subgraph (Subgraph): the collected entities, relations, preferences, and decisions.
 * @param names (Map<string, string>): entity id to display name.
 * @param dist (Map<string, number>): entity id to hop distance from the seeds.
 * @param budgetTokens (number): the token budget; when even the first line does not fit, that line is cut to the budget, so a non-empty subgraph never yields an empty context.
 * @param countTokens ((text: string) => number): the token counter.
 * @return (string): the context text.
 */
function assemble(
  passages: string[],
  subgraph: Subgraph,
  names: Map<string, string>,
  dist: Map<string, number>,
  budgetTokens: number,
  countTokens: (text: string) => number,
): string {
  const { entities, relations, preferences, decisions } = subgraph;
  const nameOf = (id: string): string => names.get(id) ?? id;
  const lines: string[] = [];
  let first: string | null = null;
  let used = 0;
  const add = (line: string, cap: number): boolean => {
    first ??= line;
    const cost = countTokens(line);
    if (used + cost > cap) return false;
    lines.push(line);
    used += cost;
    return true;
  };

  const passageCap = Math.floor((budgetTokens * PASSAGE_BUDGET_PERCENT) / 100);
  for (const p of passages) if (!add(p, passageCap)) break;

  const distOf = distanceIn(dist);
  const relRank = (r: Relation): [number, number, number] => {
    const a = distOf(r.from_entity);
    const b = distOf(r.to_entity);
    return [Math.min(a, b), Math.max(a, b), -epochMicros(r.created_at)];
  };
  const ordered = [...relations].sort((x, y) => {
    const [a0, a1, a2] = relRank(x);
    const [b0, b1, b2] = relRank(y);
    return a0 - b0 || a1 - b1 || a2 - b2;
  });
  for (const r of ordered) {
    let line = `${nameOf(r.from_entity)} -[${r.type}]-> ${nameOf(r.to_entity)}`;
    const props = formatProps(r.properties);
    if (props) line += ` ${props}`;
    if (!add(line, budgetTokens)) break;
  }

  for (const p of [...preferences].sort((a, b) => distOf(a.subject_entity) - distOf(b.subject_entity))) {
    const verb = preferenceEdgeType(p.kind).toLowerCase();
    let line = `${nameOf(p.subject_entity)} ${verb} ${nameOf(p.value_entity)} (${p.key})`;
    if (p.strength !== null) line += ` [strength ${pyFloatRepr(p.strength)}]`;
    if (!add(line, budgetTokens)) break;
  }

  for (const d of decisions) {
    const parts = [`Decision: ${d.title}`];
    if (d.outcome_entity) parts.push(`outcome ${nameOf(d.outcome_entity)}`);
    if (d.alternative_entities.length) parts.push(`alternatives ${d.alternative_entities.map(nameOf).join(", ")}`);
    if (d.rationale) parts.push(`rationale ${d.rationale}`);
    add(parts.join("; "), budgetTokens);
  }

  for (const e of [...entities].sort((a, b) => distOf(a.id) - distOf(b.id))) {
    if (!add(`${e.name} [${e.type}]`, budgetTokens)) break;
  }

  return lines.length || first === null ? lines.join("\n") : truncate(first, budgetTokens, countTokens);
}

/**
 * Cut text to its longest prefix, in characters, whose token count fits the budget.
 *
 * @param text (string): the text to cut.
 * @param budget (number): the token budget.
 * @param countTokens ((text: string) => number): the token counter.
 * @return (string): the longest fitting prefix.
 */
function truncate(text: string, budget: number, countTokens: (text: string) => number): string {
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (countTokens(chars.slice(0, mid).join("")) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("");
}

export type Strategy = (typeof STRATEGIES)[number];

export interface RetrieveOptions {
  strategy?: Strategy | null;
  depth?: number;
  k?: number;
  max_nodes?: number;
  budget_tokens?: number;
  as_of?: DateTimeInput | null;
  seeds?: SeedTier | null;
}

const RETRIEVE_KEYS = keysOf<RetrieveOptions>({
  strategy: true,
  depth: true,
  k: true,
  max_nodes: true,
  budget_tokens: true,
  as_of: true,
  seeds: true,
});

/**
 * Retrieve graph context for a query via keyword seeds and bounded traversal, optionally ranked by PageRank. Seeding climbs a ladder: "bm25" scores entities lexically; "synonyms" first adds the name of each schema entity type the query names by alias or synonym; "embeddings" also ranks entities by the graph embedder and fuses the two rankings. With as_of, the graph is read on the valid-time axis: each relation and preference at its version valid then, and an entity when it was stored by then or is an endpoint, subject, value, or about entity of one of those versions. Decisions effective by then are kept unless they name an entity not visible then, and passages come from source versions stored by then.
 *
 * @param graph (GraphAccess): the graph to read.
 * @param query (string): the natural-language query to seed from.
 * @param options (RetrieveOptions): the strategy and seeding tier (the graph's defaults when null), hop depth, seed count, entity cap, token budget, and as_of, the point in time to read the graph at (no offset means UTC; null for now).
 * @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
 */
export async function retrieve(
  graph: GraphAccess,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  if (typeof query !== "string") throw new ValidationError(`query must be a string, got ${typeName(query)}`);
  if (!pyStrip(query)) throw new ValidationError("query cannot be empty");
  checkOptions("retrieve", options, RETRIEVE_KEYS);
  const { embedder, max_tier: maxTier } = graph.tiers;
  const seeds = options.seeds == null ? graph.tiers.seeds : seedTier(options.seeds, embedder, maxTier);
  if (options.strategy != null && typeof options.strategy !== "string") {
    throw new ValidationError(`strategy must be a string, got ${typeName(options.strategy)}`);
  }
  for (const key of ["depth", "k", "max_nodes", "budget_tokens"] as const) {
    if (options[key] !== undefined) requireInt(key, options[key]);
  }
  const asOf = parseTime(options.as_of, "as_of");
  const { depth, k, max_nodes: maxNodes, budget_tokens: budgetTokens } = { ...RETRIEVE_DEFAULTS, ...options };
  const strategy = (options.strategy ?? graph.tiers.strategy).toLowerCase();
  if (!(STRATEGIES as readonly string[]).includes(strategy)) {
    throw new ValidationError(`strategy must be one of ${STRATEGIES.join(", ")}, got ${pyRepr(strategy)}`);
  }
  const bounds = [
    ["depth", depth, 0],
    ["k", k, 1],
    ["max_nodes", maxNodes, 1],
    ["budget_tokens", budgetTokens, 1],
  ] as const;
  for (const [name, value, least] of bounds) {
    if (value < least) throw new ValidationError(`${name} must be >= ${least}, got ${value}`);
  }
  return graph.read((store, ns) =>
    run(graph, store, ns, query, { strategy, depth, k, maxNodes, budgetTokens, asOf, seeds }),
  );
}

interface RunOptions {
  strategy: string;
  depth: number;
  k: number;
  maxNodes: number;
  budgetTokens: number;
  asOf: Date | null;
  seeds: SeedTier;
}

/**
 * Seed, traverse, collect, and assemble the context, with validated options.
 *
 * @param graph (GraphAccess): the graph, for its schema and embedder.
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param query (string): the query.
 * @param opts (RunOptions): the validated options.
 * @return (RetrievalResult): the retrieval result.
 */
async function run(
  graph: GraphAccess,
  store: GraphPrimitives,
  ns: string,
  query: string,
  opts: RunOptions,
): Promise<RetrievalResult> {
  const { strategy, depth, k, maxNodes, budgetTokens, asOf, seeds } = opts;
  const { countTokens } = await loadTokenizer();
  const queryTokens = tokens(query);
  const exact = shortTokens(query);
  let seedTokens = queryTokens;
  let seeded: SeedTier = "bm25";
  if (seeds !== "bm25" && graph.schema !== null) {
    seedTokens = expandTokens(queryTokens, graph.schema, tokens);
    seeded = "synonyms";
  }
  const valid = asOf === null ? null : await ops.preferencesAsOf(store, ns, asOf);
  let seedsScored = seedTokens.size || exact.size ? await scanSeeds(store, ns, seedTokens, k, exact, asOf, valid) : [];
  if (seeds === "embeddings" && graph.tiers.embedder !== null) {
    const semantic = await embeddingSeeds(graph, store, query, k, asOf, valid);
    seedsScored = fuse([seedsScored, semantic], k);
    seeded = "embeddings";
  }
  const seedIds = seedsScored.map(([e]) => e.id);
  const known = new Map(seedsScored.map(([e]) => [e.id, e]));

  const walk = strategy === "dfs" ? "dfs" : "bfs";
  const pool = Math.max(maxNodes, Math.min(MAX_POOL, maxNodes * POOL_FACTOR));
  const cap = strategy === "ppr" ? pool : maxNodes;
  let [dist, relations] = await traverse(store, ns, seedIds, walk, depth, cap, walk === "bfs" ? cap : pool, asOf);
  if (strategy === "ppr") {
    const ranked = pprRank(seedsScored, dist.keys(), relations);
    dist = new Map([...ranked].filter(([, rank]) => rank < maxNodes));
    relations = within(relations, dist);
  }

  await load(store, ns, known, dist.keys());
  const entities = [...dist.keys()].flatMap((eid) => known.get(eid) ?? []);

  let decisions = await collectDecisions(store, ns, new Set(relations.map((r) => r.id)), asOf);
  let preferences = await collectPreferences(store, ns, dist.keys(), valid);
  if (asOf !== null && valid !== null && decisions.length) {
    const refsOf = (d: DecisionTrace): string[] =>
      [d.actor_entity, d.outcome_entity, ...d.alternative_entities].filter((r): r is string => Boolean(r));
    const refs = [...new Set(decisions.flatMap(refsOf))].sort(comparePy);
    await load(store, ns, known, refs);
    const visible = await visibleAt(
      store,
      ns,
      refs.flatMap((eid) => known.get(eid) ?? []),
      asOf,
      valid,
    );
    decisions = decisions.filter((d) => refsOf(d).every((r) => visible.has(r)));
  }
  const passages = await collectPassages(store, ns, entities, dist, queryTokens, asOf);
  const names = new Map(entities.map((e) => [e.id, e.name]));
  const mentioned = new Set<string>();
  for (const p of preferences) mentioned.add(p.subject_entity).add(p.value_entity);
  for (const d of decisions) for (const x of [d.outcome_entity, ...d.alternative_entities]) if (x) mentioned.add(x);
  await load(
    store,
    ns,
    known,
    [...mentioned].filter((eid) => !names.has(eid)),
  );
  for (const eid of mentioned) {
    const entity = known.get(eid);
    if (!names.has(eid) && entity !== undefined) names.set(eid, entity.name);
  }
  if (asOf !== null) preferences = preferences.filter((p) => names.has(p.subject_entity) && names.has(p.value_entity));
  const subgraph = { entities, relations, preferences, decisions };
  const context = assemble(passages, subgraph, names, dist, budgetTokens, countTokens);

  return {
    query,
    strategy,
    seeds: seedsScored.map(([e, score]) => ({ id: e.id, score })),
    subgraph,
    context,
    tiers: { seeds: seeded, traversal: strategy },
  };
}

/**
 * Report which content words of a question a schema term or a stored entity grounds.
 *
 * Words compare ignoring case and a plain plural ending. The scan over entities stops once every word is covered.
 *
 * @param graph (GraphAccess): the graph to read.
 * @param question (string): the natural-language question.
 * @return (Coverage): the matched terms, the covered and uncovered words in sorted order, and the covered share.
 */
export async function coverage(graph: GraphAccess, question: string): Promise<Coverage> {
  if (typeof question !== "string") throw new ValidationError(`question must be a string, got ${typeName(question)}`);
  if (!pyStrip(question)) throw new ValidationError("question cannot be empty");
  return graph.read(async (store, ns) => {
    const asked = tokens(question);
    const terms = matchTerms(asked, graph.schema, tokens);
    const covered = new Set(terms.flatMap((term) => term.tokens));
    const stems = new Map<string, string[]>();
    for (const token of asked) {
      if (covered.has(token)) continue;
      stems.set(stem(token), [...(stems.get(stem(token)) ?? []), token]);
    }
    for await (const page of entityPages(store, ns, null, null)) {
      if (!stems.size) break;
      for (const entity of page) {
        for (const token of tokens(entityText(entity))) {
          for (const word of stems.get(stem(token)) ?? []) covered.add(word);
          stems.delete(stem(token));
        }
      }
    }
    return {
      question,
      terms,
      covered: [...covered].sort(comparePy),
      uncovered: [...asked].filter((t) => !covered.has(t)).sort(comparePy),
      ratio: asked.size ? covered.size / asked.size : 0,
    };
  });
}
