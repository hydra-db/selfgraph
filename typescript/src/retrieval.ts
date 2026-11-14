import { type GraphAccess, seedTier } from "./access.js";
import { loadTokenizer } from "./chunking.js";
import { ValidationError } from "./errors.js";
import { normalizeText, profileId } from "./ids.js";
import { casefold } from "./internal/casefold.js";
import { comparePy, cpLen, NON_ASCII, pyFloatRepr, pyRepr, pyStr, pyStrip } from "./internal/py.js";
import { epochMicros, fromIso } from "./internal/time.js";
import {
  L_CHUNK,
  L_ENTITY,
  L_EVIDENCE,
  L_PROFILE,
  L_SOURCE_VERSION,
  preferenceEdgeType,
  R_HAS_CHUNK,
} from "./labels.js";
import { scanEntities, scanRelations } from "./maintenance.js";
import type {
  AnswerabilityReport,
  DateTimeInput,
  DecisionTrace,
  Entity,
  JsonObject,
  Preference,
  Relation,
  RetrievalResult,
  Subgraph,
  TermCoverage,
} from "./models.js";
import * as ops from "./ops.js";
import type { GraphPrimitives, Props } from "./protocols.js";
import type { ParsedSchema } from "./schema.js";
import { decodeEntity } from "./serde.js";
import { expandTokens, groundedTerms, schemaForms, stem } from "./terms.js";
import type { SeedTier } from "./tiers.js";
import { checkOptions, keysOf, parseTime, requireBool, requireInt, typeName } from "./validate.js";

const STOPWORDS = new Set(
  (
    "a an and are as at be by did do does for from had has have how in is it its of on or that the their " +
    "them they to was were what when which who why will with"
  ).split(" "),
);

const FILLER = new Set(
  (
    "about all any can could describe does explain find give i know list many me much my our please should show " +
    "tell there we where whom whose would you your"
  ).split(" "),
);

const PAGE = 500;
const MAX_POOL = 5000;
const SEED_PAGE = 5000;
const NEIGHBOR_PARTS = 8;
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
export const HUB_DEGREE = 50;
const MAX_MATCHES = 10;

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
 * Split text into casefolded Unicode letter and digit tokens in order, dropping stopwords.
 *
 * @param text (string): the text to tokenize.
 * @return (string[]): the content tokens, repeats kept.
 */
export function tokenList(text: string): string[] {
  return [...fold(text).matchAll(TOKEN)].map((m) => m[0]).filter((t) => !STOPWORDS.has(t));
}

/**
 * Split text into casefolded Unicode letter and digit tokens, dropping stopwords.
 *
 * @param text (string): the text to tokenize.
 * @return (Set<string>): the distinct content tokens.
 */
export function tokens(text: string): Set<string> {
  return new Set(tokenList(text));
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
 * Rank every entity as a seed, as selectSeeds does, in two streaming passes over id-ordered pages: the first gathers the BM25 corpus statistics and the second scores each page and keeps the best k, so memory holds one page and the seeds, never the whole graph. When the first pass read a single page, the second scores that page instead of reading it again.
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
  let pagesRead = 0;
  let first: Entity[] = [];
  for await (const page of entityPages(store, ns, asOf, valid)) {
    stats = corpusStats(
      queryTokens,
      page.map((e) => [...tokens(entityText(e))]),
      stats,
    );
    pagesRead += 1;
    first = pagesRead === 1 ? page : [];
  }
  async function* scored(): AsyncGenerator<Entity[]> {
    if (pagesRead === 1) yield first;
    else yield* entityPages(store, ns, asOf, valid);
  }
  let best: Array<[Entity, number]> = [];
  for await (const page of scored()) best = bestSeeds([...best, ...seedScores(page, queryTokens, exact, stats!)], k);
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
  for await (const page of ops.keyset(
    (after, limit) => ops.listEntities(store, ns, { skip: 0, limit, after }),
    SEED_PAGE,
  )) {
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
 * Fetch the outgoing and incoming relations of some entities, both sides at once. With asOf, each relation is read as the version valid then; its other entity is visible through it, so only one whose other entity is gone is dropped.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to read.
 * @param nodes (string[]): the entity ids to expand.
 * @param asOf (Date | null): read the relations valid at this time instead of the current ones.
 * @return ([Relation[], Relation[]]): the outgoing and the incoming relations.
 */
async function adjacent(
  store: GraphPrimitives,
  ns: string,
  nodes: string[],
  asOf: Date | null,
): Promise<[Relation[], Relation[]]> {
  if (asOf === null) {
    const page = (filter: { from_in?: string[]; to_in?: string[] }) => (skip: number, limit: number) =>
      ops.listRelations(store, ns, { skip, limit, ...filter });
    return Promise.all([ops.scan(page({ from_in: nodes })), ops.scan(page({ to_in: nodes }))]);
  }
  const [out, inc] = await Promise.all([
    ops.relationsAsOf(store, ns, asOf, { from_in: nodes }),
    ops.relationsAsOf(store, ns, asOf, { to_in: nodes }),
  ]);
  const others = [...new Set([...out.map((r) => r.to_entity), ...inc.map((r) => r.from_entity)])];
  const alive = new Set((await ops.nodesById(store, ns, L_ENTITY, others)).keys());
  return [out.filter((r) => alive.has(r.to_entity)), inc.filter((r) => alive.has(r.from_entity))];
}

/**
 * Fetch each entity's outgoing then incoming relations; one-sided queries, as OR scans every edge. Each page of entities is read as a few smaller id batches in parallel, which engines that serve one query per session run on separate cores.
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
  for (let start = 0; start < nodes.length; start += PAGE) {
    const chunk = nodes.slice(start, start + PAGE);
    const parts: string[][] = [];
    const size = Math.ceil(chunk.length / NEIGHBOR_PARTS);
    for (let i = 0; i < chunk.length; i += size) parts.push(chunk.slice(i, i + size));
    for (const [out, inc] of await Promise.all(parts.map((part) => adjacent(store, ns, part, asOf)))) {
      for (const rel of out) outgoing.get(rel.from_entity)?.push(rel);
      for (const rel of inc) incoming.get(rel.to_entity)?.push(rel);
    }
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
 * A hub is an entity with at least HUB_DEGREE relations. With skipHubs, a hub reached from a seed is kept but not expanded, so the walk never passes through one.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to traverse.
 * @param seedIds (string[]): entity ids to start from, best first.
 * @param strategy (string): "bfs" or "dfs" traversal order.
 * @param depth (number): the maximum number of hops from a seed.
 * @param maxNodes (number): the maximum number of entities to collect.
 * @param prefetchLimit (number): the most entities whose adjacency to load up front; DFS needs more than it keeps.
 * @param asOf (Date | null): walk the relations valid at this time instead of the current ones.
 * @param skipHubs (boolean): do not expand hubs other than the seeds.
 * @return ([Map<string, number>, Relation[], Set<string>]): visited entity ids with distance, the relations among them, and the visited hubs.
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
  skipHubs = false,
): Promise<[Map<string, number>, Relation[], Set<string>]> {
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
    if (skipHubs && d > 0 && (adjacency.get(node)?.length ?? 0) >= HUB_DEGREE) continue;
    for (const rel of adjacency.get(node) ?? []) {
      relations.set(rel.id, rel);
      const other = otherEnd(rel, node);
      if ((dist.get(other) ?? depth + 1) > d + 1) frontier.push([other, d + 1]);
    }
  }
  const hubs = new Set([...dist.keys()].filter((n) => (adjacency.get(n)?.length ?? 0) >= HUB_DEGREE));
  return [dist, within(relations.values(), dist), hubs];
}

/**
 * Rank collected entities by personalized PageRank mass teleporting to the scored seeds, edges undirected and weighted by distinct source count.
 *
 * A blocked entity takes mass but passes none on: its mass restarts at the seeds, as from a dead end.
 *
 * @param seeds (Array<[Entity, number]>): seed entities with their scores.
 * @param nodes (Iterable<string>): the entity ids collected by traversal.
 * @param relations (Relation[]): the relations collected by traversal.
 * @param blocked (ReadonlySet<string>): entities the walk may reach but not pass through, such as skipped hubs.
 * @return (Map<string, number>): each entity's rank by mass, 0 for the highest.
 */
export function pprRank(
  seeds: Array<[Entity, number]>,
  nodes: Iterable<string>,
  relations: Relation[],
  blocked: ReadonlySet<string> = new Set(),
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
      const out = blocked.has(n) ? new Map<string, number>() : (edges.get(n) ?? new Map<string, number>());
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
  const tids = await ops.tracesTouchingRelations(store, ns, [...relationIds].sort(comparePy));
  const traces = await ops.getTraces(store, ns, [...tids].sort(comparePy));
  return traces.filter((t) => asOf === null || epochMicros(ops.effectiveTime(t)) <= epochMicros(asOf));
}

/**
 * Report whether a source version can supply passages: it exists, took effect by asOf, and was not replaced by a newer version of its source by then.
 *
 * @param version (Props | undefined): the stored source version, or undefined when it is gone.
 * @param asOf (Date | null): the point in time read, or null for now.
 * @return (boolean): true when its chunks may be quoted.
 */
function quotable(version: Props | undefined, asOf: Date | null): boolean {
  if (version === undefined) return false;
  if (asOf !== null && epochMicros(fromIso(version.event_time ?? version.created_at)!) > epochMicros(asOf)) {
    return false;
  }
  const replaced = fromIso(version.replaced_at);
  return replaced == null || (asOf !== null && epochMicros(replaced) > epochMicros(asOf));
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
  const usable = new Map<string, boolean>();
  for (const e of [...entities].sort((a, b) => distOf(a.id) - distOf(b.id))) {
    if (svDist.size >= MAX_PASSAGE_SOURCES) break;
    if (!e.source_count) continue;
    const fetch = ops.nodeListing(store, ns, L_EVIDENCE, { equals: { target_id: e.id } });
    for (let skip = 0; svDist.size < MAX_PASSAGE_SOURCES; ) {
      const rows = await fetch(skip, PAGE);
      const unseen = [...new Set(rows.map((r) => r.source_version as string).filter((sv) => !usable.has(sv)))];
      const versions = await ops.nodesById(store, ns, L_SOURCE_VERSION, unseen);
      for (const sv of unseen) usable.set(sv, quotable(versions.get(sv), asOf));
      for (const row of rows) {
        const sv = row.source_version as string;
        if (!usable.get(sv)) continue;
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
  const prefs =
    valid ??
    (
      await ops.edgesAt(
        store,
        ns,
        { from_label: L_PROFILE, current_only: true },
        "from_in",
        [...order.keys()].map(profileId),
      )
    ).map(ops.preferenceOf);
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
 * @param hubs (ReadonlySet<string>): hub entity ids; a relation line through one is marked "(via hub)".
 * @return (string): the context text. Certified relations come first among equally close ones and are marked "[certified]".
 */
function assemble(
  passages: string[],
  subgraph: Subgraph,
  names: Map<string, string>,
  dist: Map<string, number>,
  budgetTokens: number,
  countTokens: (text: string) => number,
  hubs: ReadonlySet<string> = new Set(),
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
  const relRank = (r: Relation): [number, number, number, number] => {
    const a = distOf(r.from_entity);
    const b = distOf(r.to_entity);
    return [Math.min(a, b), Math.max(a, b), r.certified_at === null ? 1 : 0, -epochMicros(r.created_at)];
  };
  const ordered = [...relations].sort((x, y) => {
    const [a0, a1, a2, a3] = relRank(x);
    const [b0, b1, b2, b3] = relRank(y);
    return a0 - b0 || a1 - b1 || a2 - b2 || a3 - b3;
  });
  for (const r of ordered) {
    let line = `${nameOf(r.from_entity)} -[${r.type}]-> ${nameOf(r.to_entity)}`;
    const props = formatProps(r.properties);
    if (props) line += ` ${props}`;
    if (r.certified_at !== null) line += " [certified]";
    if (hubs.has(r.from_entity) || hubs.has(r.to_entity)) line += " (via hub)";
    if (!add(line, budgetTokens)) break;
  }

  for (const p of [...preferences].sort((a, b) => distOf(a.subject_entity) - distOf(b.subject_entity))) {
    const verb = preferenceEdgeType(p.stance).toLowerCase();
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
  skip_hubs?: boolean;
}

const RETRIEVE_KEYS = keysOf<RetrieveOptions>({
  strategy: true,
  depth: true,
  k: true,
  max_nodes: true,
  budget_tokens: true,
  as_of: true,
  seeds: true,
  skip_hubs: true,
});

/**
 * Retrieve graph context for a query via keyword seeds and bounded traversal, optionally ranked by PageRank. Seeding climbs a ladder: "bm25" scores entities lexically; "synonyms" first adds the name of each schema entity type the query names by alias or synonym; "embeddings" also ranks entities by the graph embedder and fuses the two rankings. With as_of, the graph is read on the valid-time axis: each relation and preference at its version valid then, and an entity when it was stored by then or is an endpoint, subject, value, or about entity of one of those versions. Decisions effective by then are kept unless they name an entity not visible then, and passages come from source versions stored by then.
 *
 * @param graph (GraphAccess): the graph to read.
 * @param query (string): the natural-language query to seed from.
 * Entities with at least HUB_DEGREE relations reached by the walk are listed in hubs, and a context line through one that is not a seed is marked "(via hub)": a link through a hub is weak evidence of a real connection.
 *
 * @param options (RetrieveOptions): the strategy and seeding tier (the graph's defaults when null), hop depth, seed count, entity cap, token budget, and as_of, the point in time to read the graph at (no offset means UTC; null for now), and skip_hubs, to not walk through hubs other than the seeds.
 * @return (RetrievalResult): the seeds, the collected subgraph, the assembled context, and the hubs reached.
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
  const skipHubs = options.skip_hubs ?? false;
  requireBool("skip_hubs", skipHubs);
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
    run(graph, store, ns, query, { strategy, depth, k, maxNodes, budgetTokens, asOf, seeds, skipHubs }),
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
  skipHubs: boolean;
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
  const { strategy, depth, k, maxNodes, budgetTokens, asOf, seeds, skipHubs } = opts;
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
  const prefetchLimit = walk === "bfs" ? cap : pool;
  let [dist, relations, hubs] = await traverse(store, ns, seedIds, walk, depth, cap, prefetchLimit, asOf, skipHubs);
  if (strategy === "ppr") {
    const seedSet = new Set(seedIds);
    const blocked = new Set(skipHubs ? [...hubs].filter((h) => !seedSet.has(h)) : []);
    const ranked = pprRank(seedsScored, dist.keys(), relations, blocked);
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
  hubs = new Set([...hubs].filter((h) => dist.has(h)));
  const seedSet = new Set(seedIds);
  const marked = new Set([...hubs].filter((h) => !seedSet.has(h)));
  const context = assemble(passages, subgraph, names, dist, budgetTokens, countTokens, marked);

  return {
    query,
    strategy,
    seeds: seedsScored.map(([e, score]) => ({ id: e.id, score })),
    subgraph,
    context,
    tiers: { seeds: seeded, traversal: strategy },
    hubs: [...hubs].sort(comparePy),
  };
}

/**
 * Split a question into terms: each longest run of its content tokens that spells a multi-word name or alias, and every other content token on its own, except filler words such as "where", "tell", and "me".
 *
 * @param question (string): the question.
 * @param names (Iterable<string>): the entity names, aliases, and schema term forms a run may spell, ignoring a plain plural ending.
 * @return (string[]): the distinct terms, in question order.
 */
function questionTerms(question: string, names: Iterable<string>): string[] {
  const words = tokenList(question).filter((w) => !FILLER.has(w));
  const stems = words.map(stem);
  const spelled = new Set<string>();
  let longest = 1;
  for (const name of names) {
    const phrase = tokenList(name).map(stem);
    if (phrase.length > 1) {
      spelled.add(JSON.stringify(phrase));
      longest = Math.max(longest, phrase.length);
    }
  }
  const terms: string[] = [];
  for (let i = 0; i < words.length; ) {
    let size = Math.min(longest, words.length - i);
    while (size > 1 && !spelled.has(JSON.stringify(stems.slice(i, i + size)))) size--;
    terms.push(words.slice(i, i + size).join(" "));
    i += size;
  }
  return [...new Set(terms)];
}

/**
 * Report whether every term token appears in a text as a token, ignoring a plain plural ending, or, when long enough, as a substring.
 *
 * @param words (string[]): the term's content tokens.
 * @param text (string): the name, type, or key to match.
 * @return (boolean): true when the text covers the term.
 */
function covers(words: string[], text: string): boolean {
  const folded = fold(text);
  const stems = new Set([...tokens(text)].map(stem));
  return words.every((t) => stems.has(stem(t)) || grepScore(new Set([t]), folded) > 0);
}

/**
 * Report whether a path of at most depth hops joins two entity sets without passing through a hub.
 *
 * @param start (Set<string>): the entities to walk from.
 * @param goal (Set<string>): the entities to reach.
 * @param adjacency (Map<string, Set<string>>): the undirected neighbours of each entity.
 * @param depth (number): the most hops.
 * @param hubs (ReadonlySet<string>): entities the path may end at but not pass through.
 * @return (boolean): true when goal is reachable.
 */
function reaches(
  start: Set<string>,
  goal: Set<string>,
  adjacency: Map<string, Set<string>>,
  depth: number,
  hubs: ReadonlySet<string>,
): boolean {
  for (const node of start) if (goal.has(node)) return true;
  const seen = new Set(start);
  let level = [...start];
  for (let hop = 0; hop < depth; hop++) {
    const following: string[] = [];
    for (const node of level) {
      if (hubs.has(node) && !start.has(node)) continue;
      for (const other of adjacency.get(node) ?? []) {
        if (goal.has(other)) return true;
        if (!seen.has(other)) {
          seen.add(other);
          following.push(other);
        }
      }
    }
    level = following;
  }
  return false;
}

/**
 * Judge whether a graph holds what a question asks about, by lexical matching only.
 *
 * Each term is matched in turn against entity names and aliases, entity types, definitions, relation types, and property and preference keys; the first kind with a match covers it. Schema terms match by name, alias, and synonym, and a match through a certified one is marked certified. Entities matched by different terms must be joined by a path of at most depth hops; a pair joined only through a hub (HUB_DEGREE or more relations) is listed in hub_only. The verdict is not_answerable when no term is covered, partial when some are missing, uncertain when all are covered but not connected or only through a hub, and answerable otherwise.
 *
 * @param question (string): the question.
 * @param terms (string[] | null): the terms to check, or null to take them from the question.
 * @param entities (Entity[]): the entities to match.
 * @param relations (Relation[]): the relations to match and walk.
 * @param keys (Iterable<string>): the property and preference keys to match.
 * @param schema (ParsedSchema | null): its entity types, definitions, and relation types match too.
 * @param depth (number): the most hops between matched entities.
 * @return (AnswerabilityReport): the coverage of each term, the connectivity, and the verdict.
 */
export function answerability(
  question: string,
  terms: string[] | null,
  entities: Entity[],
  relations: Relation[],
  keys: Iterable<string>,
  schema: ParsedSchema | null,
  depth: number,
): AnswerabilityReport {
  const found = schemaForms(schema);
  const asked =
    terms ??
    questionTerms(question, [
      ...entities.flatMap((e) => [e.name, ...e.aliases]),
      ...Object.values(found).flatMap((named) => [...named.keys()]),
    ]);
  const held = groundedTerms(
    schema,
    entities.map((e) => e.type),
    relations.map((r) => r.type),
  );
  const isHeld = (kind: TermCoverage["status"], term: string): boolean =>
    !(kind in held) || held[kind as keyof typeof held].has(term);
  const own = (names: Iterable<string>) => new Map([...names].map((n) => [n, [n, false] as const]));
  const kinds: Array<[TermCoverage["status"], Map<string, readonly [string, boolean]>]> = [
    ["type", new Map([...own(entities.map((e) => e.type)), ...found.type])],
    ["definition", found.definition],
    ["relation", new Map([...own(relations.map((r) => r.type)), ...found.relation])],
    ["property", own(keys)],
  ];
  const coverage: TermCoverage[] = [];
  const linked = new Map<string, Set<string>>();
  for (const term of asked) {
    const words = tokenList(term);
    let matched = words.length
      ? entities.filter((e) => [e.name, ...e.aliases].some((n) => covers(words, n))).map((e) => e.id)
      : [];
    let status: TermCoverage["status"] = "entity";
    let certified = false;
    if (matched.length) {
      linked.set(term, new Set(matched));
    } else {
      status = "missing";
      let declared: Array<readonly [string, boolean]> = [];
      for (const [kind, named] of kinds) {
        const hits = words.length ? [...named].filter(([form]) => covers(words, form)).map(([, hit]) => hit) : [];
        const live = hits.filter(([t]) => isHeld(kind, t));
        if (live.length) {
          status = kind;
          matched = live.map(([t]) => t);
          certified = live.some(([, c]) => c);
          break;
        }
        if (!declared.length) declared = hits;
      }
      if (status === "missing" && declared.length) {
        status = "schema_only";
        matched = declared.map(([t]) => t);
        certified = declared.some(([, c]) => c);
      }
    }
    coverage.push({ term, status, matches: [...new Set(matched)].sort(comparePy).slice(0, MAX_MATCHES), certified });
  }
  const adjacency = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  const link = (a: string, b: string) => adjacency.set(a, (adjacency.get(a) ?? new Set<string>()).add(b));
  for (const r of relations) {
    link(r.from_entity, r.to_entity);
    link(r.to_entity, r.from_entity);
    for (const eid of [r.from_entity, r.to_entity]) degree.set(eid, (degree.get(eid) ?? 0) + 1);
  }
  const hubs = new Set([...degree].filter(([, n]) => n >= HUB_DEGREE).map(([eid]) => eid));
  const named = [...linked.keys()];
  const pairs = named.flatMap((a, i) => named.slice(i + 1).map((b) => [a, b] as const));
  const none = new Set<string>();
  const joined = pairs.filter(([a, b]) => reaches(linked.get(a)!, linked.get(b)!, adjacency, depth, none));
  const hubOnly = joined
    .filter(([a, b]) => !reaches(linked.get(a)!, linked.get(b)!, adjacency, depth, hubs))
    .map(([a, b]) => [a, b]);
  const missing = coverage.filter((c) => c.status === "schema_only" || c.status === "missing").map((c) => c.term);
  const connected = joined.length === pairs.length;
  let verdict: AnswerabilityReport["verdict"] = "answerable";
  if (missing.length === coverage.length) verdict = "not_answerable";
  else if (missing.length) verdict = "partial";
  else if (!connected || hubOnly.length) verdict = "uncertain";
  return { question, verdict, terms: coverage, missing, connected, hub_only: hubOnly, note: null };
}

/**
 * Read the namespace and judge whether it holds what a question asks about; see answerability.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param schema (ParsedSchema | null): the graph's schema.
 * @param question (string): the question.
 * @param terms (string[] | null): the terms to check, or null to take them from the question.
 * @param asOf (Date | null): judge the graph as it stood at this time, or null for now.
 * @param depth (number): the most hops between matched entities.
 * @return (AnswerabilityReport): the coverage of each term, the connectivity, and the verdict.
 */
export async function checkAnswerable(
  store: GraphPrimitives,
  ns: string,
  schema: ParsedSchema | null,
  question: string,
  terms: string[] | null,
  asOf: Date | null,
  depth: number,
): Promise<AnswerabilityReport> {
  let entities = await scanEntities(store, ns);
  let relations: Relation[];
  let preferences: Preference[];
  if (asOf === null) {
    relations = await scanRelations(store, ns);
    preferences = await ops.scan((skip, limit) => ops.listPreferences(store, ns, { skip, limit }));
  } else {
    relations = await ops.relationsAsOf(store, ns, asOf, {});
    preferences = await ops.preferencesAsOf(store, ns, asOf);
    const visible = await visibleAt(store, ns, entities, asOf, preferences);
    entities = entities.filter((e) => visible.has(e.id));
  }
  const keys = [...entities, ...relations].flatMap((item) => Object.keys(item.properties));
  keys.push(...preferences.map((p) => p.key));
  return answerability(question, terms, entities, relations, keys, schema, depth);
}
