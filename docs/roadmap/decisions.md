# Decisions

## Open

| Decision | Recommendation |
|----------|----------------|
| Does extraction keep using the LLM automatically when `llm=` is passed? | Yes. It is the one exception to opt-in, because passing an LLM signals that intent. |
| Does the resolution default move from `exact` to name and alias match? | Yes, with a release note. Merges are reversible, so the risk is low. |
| Do embeddings live in this repo or a separate package? | A retriever hook in the core, with the embedder behind an extra. |
| Which LLM tiers are Python-only? | Conformance-test deterministic tiers in both languages. Port LLM tiers after they settle. |

## Risks

| Risk | Mitigation |
|------|------------|
| The cost and quality trade-off does not disappear. It moves into the defaults. | `level`, per-capability overrides, and `max_tier`. |
| Lexical seeding may trail embeddings on recall. | Measure it in phase 1 before building around it. |
| Tiers times five backends grows the test matrix. | Keep tier logic in `_ops`, so it is backend-independent. |
| Every feature is built twice, in Python and TypeScript. | Port deterministic tiers only at first. |
| Kuzu may be unmaintained upstream, as Graphiti's README says. | Verify. The no-server quickstart depends on it, so line up an embedded alternative. |
| Claiming parity without proof. | Publish benchmark numbers before announcing. |
| Breadth turns the SDK into a sprawl. | Every module is usable alone and does one job. |

## Ruled out

| Idea | Why |
|------|-----|
| A UI, auth, or access control | SelfGraph is a library. Apps provide these. |
| Database connectors and row-level ingestion | Only metadata is read. The caller executes SQL. |
| The highest tier as the default | Defaults must be free and deterministic. |
| Feature-for-feature parity with Auto Ontology | The goal is its primitives, not its application. |
| A Rust core or native extension | The SDK is I/O bound, and a compiled extension would cost the simple install. Revisit only if profiling shows a CPU hotspot or the two ports become too costly to keep in sync. |
