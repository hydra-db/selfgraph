# Phases

Each phase lands as its own branch and pull request. One long-lived branch for
all five would drift from `main`.

## 1. Groundwork

Changes no behaviour except the two defaults listed under
[decisions](decisions.md).

- Reword the scope rule in `AGENTS.md` and `docs/index.md`: embeddings and
  query generation are allowed as optional top tiers, never in the core.
- Put the extraction and resolution ladders behind one shared tier interface.
- Add the `level` preset, per-capability overrides, and `max_tier`.
- Record the producing tier on every fact.
- Add a benchmark harness and record a baseline on LongMemEval and LOCOMO.

**Exit check:** the existing suite passes on every backend, and the baseline
numbers are committed.

## 2. Graphiti gap

- **LLM-judged contradictions.** Detect that a new fact retires an old one with
  no schema cardinality declared. It cascades from the `max_count` rules.
- **Retriever hook.** A pluggable seeding interface. BM25 stays the built-in.
  Embeddings and reranking plug in through an extra.
- **Entity summaries** that update as facts change.
- **Communities** as a traversal tier.
- **Graphiti import.** Read its episodes and custom types.

**Exit check:** benchmark numbers at `balanced` and `max` are published next to
the phase 1 baseline.

## 3. Ontology core

The primitives are described in [ontology](ontology.md).

- Terms with descriptions, synonyms, and source mappings.
- Derived definitions (metrics).
- Draft and certified state.
- A coverage check.
- Import and export.
- Draft ontology generation from database metadata.

**Exit check:** an ontology round-trips through export and import unchanged, and
synonyms improve seeding on the benchmark.

## 4. Query modules

Described in [querying](querying.md). Text-to-Cypher ships first because
SelfGraph owns the store it runs against.

**Exit check:** each module has its own accuracy benchmark, and generated writes
are rejected by default.

## 5. Unified entities

Resolve a text mention ("Acme Corp" in a transcript) to a database record
(`customer_id 4417`), so one ontology answers both "what did the customer say"
and "what was their revenue". Neither Graphiti nor Auto Ontology does both
halves.

This extends [entity resolution](../resolution.md) to structured records. It is
the differentiator and the riskiest piece, so prototype it alongside phase 2.

**Exit check:** one end-to-end demo that joins a text graph and a database on
the same entity.

## Checklist for every phase

- Tier logic lives in `_ops`, never in a `GraphStore`.
- The base install keeps its two dependencies.
- Deterministic tiers are ported to `typescript/` and pass the conformance test.
- Changed defaults get a version bump and a release note.
- The docs page for the capability is updated in the same pull request.
