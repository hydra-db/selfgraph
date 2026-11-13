# Roadmap

This folder is a plan, not a description of the current SDK. For what SelfGraph
does today, see the [docs index](../index.md). Each ladder below marks which
tiers already exist.

## Goal

One lightweight SDK for graphs and ontologies. It covers the primitives of
[Graphiti](https://github.com/getzep/graphiti) (temporal agent memory) and
[NVIDIA Auto Ontology](https://github.com/NVIDIA/auto-ontology) (a semantic layer
over databases), stacked as tiers from light to powerful. SelfGraph stays a
library. Apps, UIs, and auth are built on top of it.

## Design rules

| Rule | Meaning |
|------|---------|
| Ladders | Every capability runs from a light tier to a powerful one, on one data model with the same ids and encoding. |
| Cascade | A tier handles what it can and passes only the undecided cases up. |
| Balanced default | The default is the strongest tier that is free and deterministic. Anything that costs money or varies between runs is opt-in. |
| Tier labels | Every fact records which tier produced it. |
| Light core | The core keeps two dependencies. Each higher tier is an optional extra, usable alone. |

## Ladders

Tiers run light to powerful. **Bold** is the planned default. Tiers marked
*planned* do not exist yet.

| Capability | Tiers |
|------------|-------|
| Extraction | regex, **spaCy**, LLM, ontology-guided LLM (*planned*) |
| Resolution | derived ids, **name and alias**, fuzzy, LLM |
| Contradictions | **warn on cardinality**, supersede, LLM-judged (*planned*) |
| Ontology | none, **prescribed schema**, learned (*planned*), certified (*planned*) |
| Retrieval seeds | BM25, **plus synonyms** (*planned*), embeddings (*planned*), reranking (*planned*) |
| Traversal | **BFS/DFS**, PageRank, communities (*planned*) |
| Querying | **typed lookups and raw Cypher**, text-to-Cypher (*planned*), text-to-SQL (*planned*) |

See [tiers](tiers.md) for how tiers are chosen and combined.

## Phases

| Phase | Delivers |
|-------|----------|
| 1. Groundwork | A shared tier interface, the `level` preset, tier labels, and a benchmark baseline. |
| 2. Graphiti gap | Schema-free contradictions, a pluggable retriever, entity summaries, communities. |
| 3. Ontology core | Terms, mappings, metrics, certification, coverage checks, import and export. |
| 4. Query modules | Text-to-Cypher, then text-to-SQL. |
| 5. Unified entities | Text mentions resolved to database records. |

See [phases](phases.md) for the deliverables and exit checks of each.

## Pages

| Page | Covers |
|------|--------|
| [Tiers](tiers.md) | The tier model, defaults, presets, and the cost cap. |
| [Phases](phases.md) | The work in order, with exit checks. |
| [Ontology](ontology.md) | The ontology primitives added in phase 3. |
| [Querying](querying.md) | The text-to-Cypher and text-to-SQL modules. |
| [Landscape](landscape.md) | How SelfGraph compares with Graphiti, Auto Ontology, and Graphify. |
| [Decisions](decisions.md) | Open decisions, risks, and what was ruled out. |
