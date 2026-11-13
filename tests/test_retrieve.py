import pytest
from helpers import KUZU, extracting_llm, fresh_graph, new_graph, run

from selfgraph import ValidationError
from selfgraph.extraction.chunking import count_tokens


def _graph():
    g = new_graph()
    run(
        g.insert.facts(
            {
                "entities": [
                    {"id": "person:soham", "type": "Person", "name": "Soham"},
                    {"id": "company:hydradb", "type": "Company", "name": "HydraDB"},
                    {"id": "company:neo4j", "type": "Company", "name": "Neo4j"},
                    {"id": "org:team", "type": "Org", "name": "Team"},
                    {"id": "feature:temporal", "type": "Feature", "name": "Temporal History"},
                ],
                "relations": [
                    {
                        "id": "relation:works",
                        "from_entity": "person:soham",
                        "type": "WORKS_AT",
                        "to_entity": "company:hydradb",
                    },
                    {
                        "id": "relation:selected",
                        "from_entity": "org:team",
                        "type": "SELECTED",
                        "to_entity": "company:hydradb",
                    },
                    {
                        "id": "relation:requires",
                        "from_entity": "company:hydradb",
                        "type": "REQUIRES",
                        "to_entity": "feature:temporal",
                    },
                ],
                "decisions": [
                    {
                        "id": "decision:db",
                        "title": "Select the graph database",
                        "steps": ["relation:requires", "relation:selected"],
                        "actor_entity": "org:team",
                        "outcome_entity": "company:hydradb",
                        "alternative_entities": ["company:neo4j"],
                        "rationale": "The product requires temporal graph history.",
                    },
                ],
            }
        )
    )
    return g


def test_retrieve_reaches_decision():
    g = _graph()
    res = run(g.retrieve("which database did the team pick and why"))
    assert "org:team" in [s.id for s in res.seeds]
    assert "SELECTED" in {r.type for r in res.subgraph.relations}
    assert any(d.title == "Select the graph database" for d in res.subgraph.decisions)
    assert "HydraDB" in res.context
    assert "temporal graph history" in res.context


def test_retrieve_strategies_and_depth_bound_traversal():
    g = _graph()
    for strategy in ("bfs", "dfs"):
        res = run(g.retrieve("team", strategy=strategy, depth=3))
        assert "company:hydradb" in {e.id for e in res.subgraph.entities}
    ids = {e.id for e in run(g.retrieve("team", depth=1)).subgraph.entities}
    assert "company:hydradb" in ids
    assert "feature:temporal" not in ids
    with pytest.raises(ValidationError):
        run(g.retrieve("team", strategy="sideways"))


def test_retrieve_includes_source_passage():
    llm = extracting_llm([("Person", "Soham"), ("Company", "HydraDB")])
    g = new_graph(llm=llm)
    passage = "Soham praised HydraDB for its bitemporal provenance ledger."
    run(g.insert.text(passage, source_id="m1"))
    res = run(g.retrieve("Soham HydraDB"))
    assert "bitemporal provenance ledger" in res.context


def test_retrieve_surfaces_preferences():
    g = _graph()
    run(g.preferences.create("person:soham", "database", "company:hydradb", strength=0.9))
    res = run(g.retrieve("what database does Soham prefer"))
    assert any(p.subject_entity == "person:soham" for p in res.subgraph.preferences)
    assert "Soham prefers HydraDB (database)" in res.context


def test_stopword_query_returns_nothing_and_an_empty_query_is_rejected():
    g = _graph()
    res = run(g.retrieve("the and of"))
    assert res.seeds == []
    assert res.subgraph.entities == []
    assert res.context == ""
    for query in ("", "   "):
        with pytest.raises(ValidationError, match="^query cannot be empty$"):
            run(g.retrieve(query))


def test_tiny_budgets_cut_to_fit_and_one_letter_names_seed():
    g = fresh_graph("q4")
    run(g.entities.create("A", "Person", id="person:a"))
    run(g.entities.create("Bob Builder", "Person", id="person:bob"))
    run(g.relations.create("person:a", "KNOWS", "person:bob", properties={"since": "a long time ago" * 20}))
    tiny = run(g.retrieve("Bob Builder", budget_tokens=1))
    assert tiny.subgraph.entities
    assert tiny.context.splitlines() == [tiny.context] and tiny.context
    assert [s.id for s in run(g.retrieve("A")).seeds] == ["person:a"]
    g = fresh_graph("budget")
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Ann"}, {"type": "Company", "name": "Acme"}]}))
    run(g.insert.text("Ann works at Acme in Paris as a senior engineer.", source_id="note"))
    full = run(g.retrieve("Ann Acme")).context
    previous = ""
    for budget in (1, 2, 3):
        context = run(g.retrieve("Ann Acme", budget_tokens=budget)).context
        assert context and count_tokens(context) <= budget
        assert full.startswith(context) and context.startswith(previous)
        previous = context


@pytest.mark.skipif(not KUZU, reason="a bulk insert; the paged scan is the same on every backend")
def test_retrieve_scores_every_entity_past_five_thousand():
    g = fresh_graph("bulk")
    fillers = [{"type": "Filler", "name": f"filler {i:05d} common"} for i in range(5100)]
    run(g.insert.facts({"entities": [*fillers, {"type": "Tool", "name": "Zebracorn common"}]}))
    assert [s.id for s in run(g.retrieve("zebracorn", k=3)).seeds] == ["tool:zebracorn-common"]
    assert run(g.retrieve("filler 05099", k=1)).seeds[0].id == "filler:filler-05099-common"
