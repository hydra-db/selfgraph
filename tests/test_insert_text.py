import pytest
from helpers import FakeLLM, new_graph, run

from selfgraph import (
    EntityInput,
    ExtractionInstructions,
    ExtractionPrompts,
    Ontology,
    ParsedDocument,
    PromptTemplate,
)
from selfgraph.extraction.extractor import (
    _DecisionsOut,
    _DecOut,
    _EntitiesOut,
    _PreferencesOut,
    _PrefOut,
    _RelationsOut,
    _RelOut,
    _StepOut,
)


def _full_responses():
    return {
        "_EntitiesOut": _EntitiesOut(
            entities=[
                EntityInput(type="Person", name="Soham"),
                EntityInput(type="Company", name="HydraDB"),
            ]
        ),
        "_RelationsOut": _RelationsOut(
            relations=[
                _RelOut(from_name="Soham", type="WORKS_AT", to_name="HydraDB"),
            ]
        ),
        "_PreferencesOut": _PreferencesOut(
            preferences=[
                _PrefOut(subject_name="Soham", kind="preference", key="database", value_name="HydraDB"),
            ]
        ),
        "_DecisionsOut": _DecisionsOut(
            decisions=[
                _DecOut(
                    title="Select the graph database",
                    actor_name="Team",
                    outcome_name="HydraDB",
                    steps=[_StepOut(from_name="Team", type="SELECTED", to_name="HydraDB")],
                ),
            ]
        ),
    }


def test_insert_text_full_pipeline():
    llm = FakeLLM(_full_responses())
    g = new_graph(llm=llm)
    run(g.initialize())

    res = run(g.insert.text("Soham prefers HydraDB. The team selected it.", source_id="m1"))

    ids = {e.id for e in res.entities}
    assert "person:soham" in ids
    assert "company:hydradb" in ids
    assert "thing:team" in ids

    rel_types = {r.type for r in res.relations}
    assert "WORKS_AT" in rel_types
    assert "SELECTED" in rel_types

    assert len(res.preferences) == 1
    assert res.preferences[0].key == "database"

    assert len(res.decisions) == 1
    dec = res.decisions[0]
    assert dec.title == "Select the graph database"
    assert len(dec.steps) == 1

    assert res.source_version is not None


def test_noise_entities_are_filtered():
    responses = {
        "_EntitiesOut": _EntitiesOut(
            entities=[
                EntityInput(type="Company", name="Acme"),
                EntityInput(type="Metric", name="74"),
            ]
        ),
        "_RelationsOut": _RelationsOut(
            relations=[
                _RelOut(from_name="Acme", type="GAINED", to_name="74"),
            ]
        ),
    }
    g = new_graph(llm=FakeLLM(responses))
    run(g.initialize())
    res = run(g.insert.text("Acme gained 74."))
    ids = {e.id for e in res.entities}
    assert "company:acme" in ids
    assert not any("74" in i for i in ids)
    assert all("74" not in r.to_entity for r in res.relations)


def test_insert_text_without_llm_uses_basic_extractor():
    g = new_graph()
    run(g.initialize())
    res = run(g.insert.text("Acme acquired Globex."))
    ids = {e.id for e in res.entities}
    assert "thing:acme" in ids
    assert "thing:globex" in ids
    assert any(w.code == "basic_extraction" for w in res.warnings)


def test_custom_extractor_bypasses_llm():
    class MyExtractor:
        async def extract(self, document: ParsedDocument) -> Ontology:
            return Ontology(entities=[EntityInput(type="Person", name="Zed")])

    g = new_graph(extractor=MyExtractor())
    run(g.initialize())
    res = run(g.insert.text("anything"))
    assert [e.id for e in res.entities] == ["person:zed"]


def test_instructions_are_appended_to_prompt():
    llm = FakeLLM(_full_responses())
    g = new_graph(llm=llm)
    run(g.initialize())
    run(
        g.insert.text(
            "text",
            instructions=ExtractionInstructions(preferences="Only explicit DB preferences."),
        )
    )
    pref_calls = [c for c in llm.calls if c[0] == "_PreferencesOut"]
    assert pref_calls
    assert "Only explicit DB preferences." in pref_calls[0][2]


def test_prompt_missing_text_variable_raises():
    from selfgraph import PromptTemplateError
    from selfgraph.extraction.prompts import render

    bad = PromptTemplate(system="s", user="no placeholder here", version="bad-v1")
    with pytest.raises(PromptTemplateError):
        render(bad, text="hello", instructions=None)


def test_custom_prompts_override_default():
    llm = FakeLLM(_full_responses())
    g = new_graph(llm=llm)
    run(g.initialize())
    run(
        g.insert.text(
            "text",
            prompts=ExtractionPrompts(
                entities=PromptTemplate(system="CUSTOM-SYS", user="custom {text}", version="c-v1")
            ),
        )
    )
    ent_calls = [c for c in llm.calls if c[0] == "_EntitiesOut"]
    assert ent_calls[0][1] == "CUSTOM-SYS"
    assert ent_calls[0][2].startswith("custom ")


def test_partial_extraction_failure_becomes_warning():
    responses = {
        "_EntitiesOut": _EntitiesOut(entities=[EntityInput(type="Person", name="Zed")]),
        "_PreferencesOut": RuntimeError("preferences model exploded"),
    }
    g = new_graph(llm=FakeLLM(responses))
    run(g.initialize())
    res = run(g.insert.text("Zed exists."))
    assert [e.id for e in res.entities] == ["person:zed"]
    assert res.warnings
    assert any("preferences" in w.message for w in res.warnings)
