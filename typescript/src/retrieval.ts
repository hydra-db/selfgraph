import type { GraphAccess } from "./access.js";
import { loadTokenizer } from "./chunking.js";
import { ValidationError } from "./errors.js";
import { normalizeText } from "./ids.js";
import { casefold } from "./internal/casefold.js";
import { comparePy, cpLen, NON_ASCII, pyFloatRepr, pyRepr, pyStr, pyStrip } from "./internal/py.js";
import { epochMicros } from "./internal/time.js";
import type { DecisionTrace, Entity, JsonObject, Preference, Relation, RetrievalResult, Subgraph } from "./models.js";
import * as ops from "./ops.js";
import type { GraphPrimitives } from "./protocols.js";
import { readChunks } from "./provenance.js";
import { preferenceEdgeType } from "./schema.js";
import { pyTypeName, requireInt } from "./validate.js";

const STOPWORDS = new Set(
  (
    "a an and are as at be by did do does for from had has have how in is it its of on or that the their " +
    "them they to was were what when which who why will with"
  ).split(" "),
);

const PAGE = 500;
const SCAN_LIMIT = 5000;
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

function bm25Scores(query: Set<string>, docs: string[][]): number[] {
  const n = docs.length;
  if (!n || !query.size) return new Array(n).fill(0);
  const avgdl = docs.reduce((total, doc) => total + doc.length, 0) / n || 1.0;
  const df = new Map<string, number>([...query].map((t) => [t, 0]));
  const counts = docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc) if (query.has(token)) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    return tf;
  });
  const idf = new Map([...df].map(([t, d]) => [t, Math.log(1 + (n - d + 0.5) / (d + 0.5))]));
  return counts.map((tf, i) => {
    const norm = BM25_K1 * (1 - BM25_B + (BM25_B * docs[i].length) / avgdl);
    let score = 0;
    for (const [t, f] of tf) score += ((idf.get(t) ?? 0) * f * (BM25_K1 + 1)) / (f + norm);
    return score;
  });
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

async function scan<T>(fetch: (skip: number) => Promise<T[]>, cap = Infinity): Promise<T[]> {
  const out: T[] = [];
  while (out.length < cap) {
    const batch = await fetch(out.length);
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

const distinctSources = (evidence: Entity["evidence"]): number => new Set(evidence.map((ev) => ev.source_id)).size;

/**
 * Rank entities against the query by BM25 plus a substring boost, divided by the log of distinct mentioning sources so generic entities do not crowd out specific ones.
 *
 * @param entities (Entity[]): the candidate entities.
 * @param queryTokens (Set<string>): the content tokens from the query.
 * @param k (number): the maximum number of seeds.
 * @return (Array<[Entity, number]>): seed entities with their scores, best first.
 */
export function selectSeeds(entities: Entity[], queryTokens: Set<string>, k: number): Array<[Entity, number]> {
  if (!entities.length) return [];
  const texts = entities.map(entityText);
  const bm25 = bm25Scores(
    queryTokens,
    texts.map((t) => [...tokens(t)]),
  );
  const scored: Array<[Entity, number]> = [];
  for (const [i, entity] of entities.entries()) {
    const score = bm25[i] + GREP_WEIGHT * grepScore(queryTokens, fold(texts[i]));
    if (score > 0) scored.push([entity, score / Math.log(Math.E + distinctSources(entity.evidence))]);
  }
  scored.sort((a, b) => b[1] - a[1] || comparePy(a[0].id, b[0].id));
  return scored.slice(0, k);
}

/**
 * Fetch the current relations touching a batch of entities as two one-sided queries per page, each entity's outgoing relations then its incoming ones, in id order.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace to read.
 * @param nodes (string[]): the entity ids to expand.
 * @return (Map<string, Relation[]>): each entity's adjacent relations.
 */
async function neighbors(store: GraphPrimitives, ns: string, nodes: string[]): Promise<Map<string, Relation[]>> {
  const outgoing = new Map<string, Relation[]>(nodes.map((n) => [n, []]));
  const incoming = new Map<string, Relation[]>(nodes.map((n) => [n, []]));
  const page = (filter: { from_in?: string[]; to_in?: string[] }) => (skip: number) =>
    ops.listRelations(store, ns, { skip, limit: PAGE, ...filter });
  for (let start = 0; start < nodes.length; start += PAGE) {
    const chunk = nodes.slice(start, start + PAGE);
    for (const rel of await scan(page({ from_in: chunk }))) outgoing.get(rel.from_entity)?.push(rel);
    for (const rel of await scan(page({ to_in: chunk }))) incoming.get(rel.to_entity)?.push(rel);
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
 * @return (Map<string, Relation[]>): each prefetched entity's adjacent relations.
 */
async function prefetch(
  store: GraphPrimitives,
  ns: string,
  seedIds: string[],
  depth: number,
  limit: number,
): Promise<Map<string, Relation[]>> {
  const adjacency = new Map<string, Relation[]>();
  let level = [...new Set(seedIds)];
  const seen = new Set(level);
  for (let hop = 0; hop < depth; hop++) {
    level = level.slice(0, Math.max(0, limit - adjacency.size));
    if (!level.length) break;
    for (const [n, rels] of await neighbors(store, ns, level)) adjacency.set(n, rels);
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
): Promise<[Map<string, number>, Relation[]]> {
  const bfs = strategy === "bfs";
  const adjacency = await prefetch(store, ns, seedIds, depth, prefetchLimit);
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
      for (const [n, rels] of await neighbors(store, ns, batch)) adjacency.set(n, rels);
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
      const weight = Math.max(1, distinctSources(r.evidence));
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

async function entityOf(
  store: GraphPrimitives,
  ns: string,
  known: Map<string, Entity>,
  eid: string,
): Promise<Entity | null> {
  return known.get(eid) ?? (await ops.getEntity(store, ns, eid));
}

async function collectDecisions(
  store: GraphPrimitives,
  ns: string,
  relationIds: Set<string>,
): Promise<DecisionTrace[]> {
  if (!relationIds.size) return [];
  const traces = await scan((skip) => ops.listTraces(store, ns, { skip, limit: PAGE }), SCAN_LIMIT);
  return traces.filter((t) => t.steps.some((s) => relationIds.has(s.relation_id)));
}

async function collectPassages(
  store: GraphPrimitives,
  ns: string,
  entities: Entity[],
  dist: Map<string, number>,
  queryTokens: Set<string>,
): Promise<string[]> {
  const distOf = distanceIn(dist);
  const svDist = new Map<string, number>();
  outer: for (const e of [...entities].sort((a, b) => distOf(a.id) - distOf(b.id))) {
    for (const ev of e.evidence) {
      if (!svDist.has(ev.source_version)) svDist.set(ev.source_version, distOf(e.id));
      if (svDist.size >= MAX_PASSAGE_SOURCES) break outer;
    }
  }

  const candidates: Array<[number, number, string]> = [];
  for (const [sv, d] of svDist) {
    for (const chunk of await readChunks(store, ns, sv)) {
      const text = pyStrip(chunk);
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
): Promise<Preference[]> {
  const order = new Map<string, number>();
  for (const eid of entityIds) order.set(eid, order.size);
  if (!order.size) return [];
  const prefs = await scan((skip) => ops.listPreferences(store, ns, { skip, limit: PAGE }));
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
 * @param budgetTokens (number): the token budget.
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
  let used = 0;
  const add = (line: string, cap: number): boolean => {
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

  return lines.join("\n");
}

export interface RetrieveOptions {
  strategy?: (typeof STRATEGIES)[number] | (string & {});
  depth?: number;
  k?: number;
  max_nodes?: number;
  budget_tokens?: number;
}

/**
 * Retrieve graph context for a query via keyword seeds and bounded traversal, optionally ranked by PageRank.
 *
 * @param graph (GraphAccess): the graph to read.
 * @param query (string): the natural-language query to seed from.
 * @param options (RetrieveOptions): the strategy, hop depth, seed count, entity cap, and token budget.
 * @return (RetrievalResult): the seeds, the collected subgraph, and the assembled context.
 */
export async function retrieve(
  graph: GraphAccess,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  if (typeof query !== "string") throw new ValidationError(`query must be a string, got ${pyTypeName(query)}`);
  if (options.strategy !== undefined && typeof options.strategy !== "string") {
    throw new ValidationError(`strategy must be a string, got ${pyTypeName(options.strategy)}`);
  }
  for (const key of ["depth", "k", "max_nodes", "budget_tokens"] as const) {
    if (options[key] !== undefined) requireInt(key, options[key]);
  }
  const { depth, k, max_nodes: maxNodes, budget_tokens: budgetTokens } = { ...RETRIEVE_DEFAULTS, ...options };
  const strategy = (options.strategy ?? RETRIEVE_DEFAULTS.strategy).toLowerCase();
  if (!(STRATEGIES as readonly string[]).includes(strategy)) {
    throw new ValidationError(`strategy must be one of ${STRATEGIES.join(", ")}, got ${pyRepr(strategy)}`);
  }
  if (depth < 0 || k < 1 || maxNodes < 1 || budgetTokens < 1) {
    throw new ValidationError("depth must be >= 0 and k, max_nodes, budget_tokens must be >= 1");
  }
  return graph.read((store, ns) => run(store, ns, query, { strategy, depth, k, maxNodes, budgetTokens }));
}

/**
 * Seed, traverse, collect, and assemble the context, with validated options.
 *
 * @param store (GraphPrimitives): the graph reader.
 * @param ns (string): the namespace.
 * @param query (string): the query.
 * @param opts ({ strategy: string; depth: number; k: number; maxNodes: number; budgetTokens: number }): the options.
 * @return (RetrievalResult): the retrieval result.
 */
async function run(
  store: GraphPrimitives,
  ns: string,
  query: string,
  opts: { strategy: string; depth: number; k: number; maxNodes: number; budgetTokens: number },
): Promise<RetrievalResult> {
  const { strategy, depth, k, maxNodes, budgetTokens } = opts;
  const { countTokens } = await loadTokenizer();
  const queryTokens = tokens(query);
  const known = new Map<string, Entity>();
  if (queryTokens.size) {
    const entities = await scan((skip) => ops.listEntities(store, ns, { skip, limit: PAGE }), SCAN_LIMIT);
    for (const e of entities) known.set(e.id, e);
  }
  const seedsScored = selectSeeds([...known.values()], queryTokens, k);
  const seedIds = seedsScored.map(([e]) => e.id);

  const walk = strategy === "dfs" ? "dfs" : "bfs";
  const pool = Math.max(maxNodes, Math.min(SCAN_LIMIT, maxNodes * POOL_FACTOR));
  const cap = strategy === "ppr" ? pool : maxNodes;
  let [dist, relations] = await traverse(store, ns, seedIds, walk, depth, cap, walk === "bfs" ? cap : pool);
  if (strategy === "ppr") {
    const ranked = pprRank(seedsScored, dist.keys(), relations);
    dist = new Map([...ranked].filter(([, rank]) => rank < maxNodes));
    relations = within(relations, dist);
  }

  const entities: Entity[] = [];
  for (const eid of dist.keys()) {
    const entity = await entityOf(store, ns, known, eid);
    if (entity !== null) entities.push(entity);
  }

  const decisions = await collectDecisions(store, ns, new Set(relations.map((r) => r.id)));
  const preferences = await collectPreferences(store, ns, dist.keys());
  const passages = await collectPassages(store, ns, entities, dist, queryTokens);
  const names = new Map(entities.map((e) => [e.id, e.name]));
  const mentioned = new Set<string>();
  for (const p of preferences) mentioned.add(p.subject_entity).add(p.value_entity);
  for (const d of decisions) for (const x of [d.outcome_entity, ...d.alternative_entities]) if (x) mentioned.add(x);
  for (const eid of mentioned) {
    if (names.has(eid)) continue;
    const entity = await entityOf(store, ns, known, eid);
    if (entity !== null) names.set(eid, entity.name);
  }
  const subgraph = { entities, relations, preferences, decisions };
  const context = assemble(passages, subgraph, names, dist, budgetTokens, countTokens);

  return { query, strategy, seeds: seedsScored.map(([e, score]) => ({ id: e.id, score })), subgraph, context };
}
