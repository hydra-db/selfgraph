import pytest
from helpers import FakeLLM, new_graph, run

from selfgraph import EntityInput, ValidationError
from selfgraph.extraction.extractor import _EntitiesOut


def _graph():
    g = new_graph()
    run(
        g.insert.ontology(
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


def test_retrieve_bfs_and_dfs_reach_target():
    g = _graph()
    for strategy in ("bfs", "dfs"):
        res = run(g.retrieve("team", strategy=strategy, depth=3))
        assert "company:hydradb" in {e.id for e in res.subgraph.entities}


def test_retrieve_depth_bounds_traversal():
    g = _graph()
    res = run(g.retrieve("team", depth=1))
    ids = {e.id for e in res.subgraph.entities}
    assert "company:hydradb" in ids
    assert "feature:temporal" not in ids


def test_retrieve_rejects_bad_strategy():
    g = _graph()
    with pytest.raises(ValidationError):
        run(g.retrieve("team", strategy="sideways"))


def test_retrieve_includes_source_passage():
    llm = FakeLLM(
        {
            "_EntitiesOut": _EntitiesOut(
                entities=[
                    EntityInput(type="Person", name="Soham"),
                    EntityInput(type="Company", name="HydraDB"),
                ]
            )
        }
    )
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


def test_retrieve_empty_query_returns_nothing():
    g = _graph()
    res = run(g.retrieve("the and of"))
    assert res.seeds == []
    assert res.subgraph.entities == []
    assert res.context == ""
