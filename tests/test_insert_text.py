import logging

import pytest
from helpers import FakeLLM, extracting_llm, fresh_graph, new_graph, run

from selfgraph import (
    EntityInput,
    ExtractionError,
    ExtractionInstructions,
    ExtractionPrompts,
    Ontology,
    ParsedDocument,
    PromptTemplate,
    PromptTemplateError,
    SelfGraph,
    ValidationError,
)
from selfgraph import ids as _ids
from selfgraph.extraction.extractor import (
    DefaultExtractor,
    _DecisionsOut,
    _DecOut,
    _PreferencesOut,
    _PrefOut,
    _RelOut,
    _StepOut,
)
from selfgraph.extraction.prompts import render


def _full_responses():
    return {
        **extracting_llm([("Person", "Soham"), ("Company", "HydraDB")], [("Soham", "WORKS_AT", "HydraDB")]).responses,
        "_PreferencesOut": _PreferencesOut(
            preferences=[_PrefOut(subject_name="Soham", kind="preference", key="database", value_name="HydraDB")]
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


def test_insert_text_full_pipeline_with_custom_prompts_and_instructions():
    llm = FakeLLM(_full_responses())
    g = new_graph(llm=llm)
    res = run(
        g.insert.text(
            "Soham prefers HydraDB. The team selected it.",
            source_id="m1",
            prompts=ExtractionPrompts(
                entities=PromptTemplate(system="CUSTOM-SYS", user="custom {text}", version="c-v1")
            ),
            instructions=ExtractionInstructions(preferences="Only explicit DB preferences."),
        )
    )
    assert {"person:soham", "company:hydradb", "thing:team"} <= {e.id for e in res.entities}
    assert {"WORKS_AT", "SELECTED"} <= {r.type for r in res.relations}
    assert [p.key for p in res.preferences] == ["database"]
    [dec] = res.decisions
    assert (dec.title, len(dec.steps)) == ("Select the graph database", 1)
    assert res.source_version is not None
    calls = {name: (system, user) for name, system, user in llm.calls}
    assert calls["_EntitiesOut"][0] == "CUSTOM-SYS"
    assert calls["_EntitiesOut"][1].startswith("custom ")
    assert "Only explicit DB preferences." in calls["_PreferencesOut"][1]


def test_noise_entities_are_filtered():
    llm = extracting_llm([("Company", "Acme"), ("Metric", "74")], [("Acme", "GAINED", "74")])
    g = new_graph(llm=llm)
    res = run(g.insert.text("Acme gained 74."))
    ids = {e.id for e in res.entities}
    assert "company:acme" in ids
    assert not any("74" in i for i in ids)
    assert all("74" not in r.to_entity for r in res.relations)


def test_insert_text_without_llm_uses_basic_extractor(caplog):
    g = new_graph()
    res = run(g.insert.text("Acme acquired Globex."))
    ids = {e.id for e in res.entities}
    assert "thing:acme" in ids
    assert "thing:globex" in ids
    assert any(w.code == "basic_extraction" for w in res.warnings)
    assert any(r.getMessage().startswith("basic_extraction: extracted without an LLM") for r in caplog.records)
    assert all("pass llm= to SelfGraph" in w.message for w in res.warnings if w.code == "basic_extraction")


def test_custom_extractor_bypasses_the_llm_and_receives_the_insert_metadata():
    seen = []

    class Recorder:
        async def extract(self, document: ParsedDocument) -> Ontology:
            seen.append((document.media_type, document.metadata))
            return Ontology(entities=[EntityInput(type="Person", name="Zed")])

    llm = FakeLLM()
    g = fresh_graph("ext", llm=llm, extractor=Recorder())
    res = run(g.insert.text("hello", metadata={"lang": "en"}, event_time="2024-05-01T00:00:00Z"))
    assert [e.id for e in res.entities] == ["person:zed"]
    assert seen == [("text/plain", {"lang": "en"})]
    assert llm.calls == []


def test_prompt_templates_are_checked_and_rendered_without_resubstitution():
    missing = r"^prompt 'entities' is missing required variable \{text\}$"
    no_text = PromptTemplate(system="s", user="no placeholder", version="v1")
    with pytest.raises(PromptTemplateError, match=missing):
        SelfGraph(store=object(), prompts=ExtractionPrompts(entities=no_text))
    with pytest.raises(PromptTemplateError, match=missing):
        render(no_text, text="hello", instructions=None, name="entities")
    bogus = ExtractionPrompts(relations=PromptTemplate(system="s", user="{text} {bogus}", version="v1"))
    expected = r"^prompt 'relations' uses unknown variable \{bogus\}; allowed variables: \{text\}, \{instructions\}$"
    with pytest.raises(PromptTemplateError, match=expected):
        SelfGraph(store=object(), prompts=bogus)
    with pytest.raises(PromptTemplateError, match=expected):
        DefaultExtractor(FakeLLM({}), call_prompts=bogus)
    ok = PromptTemplate(system="s", user='{instructions} {text} {"json": 1}', version="v1")
    DefaultExtractor(FakeLLM({}), prompts=ExtractionPrompts(entities=ok))
    slotted = PromptTemplate(system="s", user="{instructions}|{text}", version="v1")
    _, user = render(slotted, text="doc {instructions} {text}", instructions="be brief {text}")
    assert user == "be brief {text}|doc {instructions} {text}"
    appended = PromptTemplate(system="s", user="T:{text}", version="v2")
    _, user = render(appended, text="doc {instructions}", instructions="extra")
    assert user == "T:doc {instructions}\n\nAdditional instructions:\nextra"


def test_invalid_extracted_items_are_dropped_with_warnings():
    responses = _full_responses()
    responses["_RelationsOut"].relations += [
        _RelOut(from_name="Soham", type="", to_name="HydraDB"),
        _RelOut(from_name="Soham", type="HAS_STEP", to_name="HydraDB"),
    ]
    responses["_PreferencesOut"].preferences.append(
        _PrefOut(subject_name="Soham", key="editor", value_name="HydraDB", strength=2.0)
    )
    g = fresh_graph("drop", llm=FakeLLM(responses))
    res = run(g.insert.text("Soham prefers HydraDB. The team selected it.", source_id="m-drop"))
    assert {r.type for r in res.relations} == {"WORKS_AT", "SELECTED"}
    assert [p.key for p in res.preferences] == ["database"]
    assert len(res.decisions) == 1
    dropped = [w.message for w in res.warnings if w.code == "extraction_partial_failure"]
    assert len(dropped) == 2
    assert any("preference strength" in m for m in dropped)
    reserved = [w.message for w in res.warnings if w.code == "dropped_reserved_relation"]
    assert reserved == [
        "dropped an extracted relation: relation type 'HAS_STEP' is reserved for internal use; choose another type"
    ]


def test_reserved_preference_relation_becomes_a_preference():
    llm = extracting_llm(
        [("Person", "Soham"), ("Database", "Postgres")],
        [("Soham", "prefers", "Postgres"), ("Soham", "AVOIDS", "Mongo")],
    )
    extractor = DefaultExtractor(llm)
    ontology = run(
        extractor.extract(ParsedDocument(text="Soham prefers Postgres and avoids Mongo.", media_type="text/plain"))
    )
    assert [(p.kind, p.key, p.value_entity) for p in ontology.preferences] == [
        ("preference", "database", "database:postgres")
    ]
    assert ontology.relations == []
    dropped = [(w.code, w.message) for w in extractor.pop_warnings()]
    assert (
        len(dropped) == 1 and dropped[0][0] == "dropped_reserved_relation" and "'AVOIDS' is reserved" in dropped[0][1]
    )
    reserved = "AVOIDS, CONSIDERED, FROM, HAS_CHUNK, HAS_PROFILE, HAS_STEP, HAS_VERSION, MADE_DECISION, PREFERS, RESULTED_IN, TO"
    system = next(c[1] for c in llm.calls if c[0] == "_RelationsOut")
    assert system.endswith(f"Never use these reserved relationship types: {reserved}.")
    decisions = next(c[1] for c in llm.calls if c[0] == "_DecisionsOut")
    assert f"never these reserved relationship types: {reserved}. Put the alternatives considered in " in decisions
    assert decisions.endswith("never as CONSIDERED or RESULTED_IN steps.")
    step = _StepOut(from_name="Team", type="CONSIDERED", to_name="Neo4j")
    decision = _DecOut(title="Pick a DB", actor_name="Team", outcome_name="HydraDB", steps=[step, step])
    sink = []
    ontology = DefaultExtractor._assemble([], [], [], [decision], sink)
    assert [w.code for w in sink] == ["dropped_reserved_relation", "dropped_reserved_relation"]
    assert ontology.relations == [] and ontology.decisions[0].steps == []


def test_partial_failure_warnings_are_summarized_and_carry_the_source():
    responses = _full_responses()
    responses["_PreferencesOut"] = RuntimeError("\x1b[31mModelResponse(id=1)\x1b[0m\n" + "y" * 500)
    g = fresh_graph("summary", llm=FakeLLM(responses))
    res = run(g.insert.text("Soham prefers HydraDB. The team selected it.", source_id="m-sum"))
    assert {"person:soham", "company:hydradb"} <= {e.id for e in res.entities}
    assert res.preferences == []
    failed = [w for w in res.warnings if w.code == "extraction_partial_failure"]
    assert [w.message for w in failed] == [
        "preferences extraction failed on chunk 0: RuntimeError: ModelResponse(id=1)"
    ]
    assert failed[0].chunk_id == _ids.chunk_id(res.source_version, 0)
    assert all(w.source_id == "m-sum" for w in res.warnings)


@pytest.mark.parametrize(
    ("responses", "match"),
    [
        (
            {"_EntitiesOut": RuntimeError("No tool calls or function call found\n" + "x" * 500)},
            r"whole input \(1 of 4 LLM calls failed\)",
        ),
        (
            {"_EntitiesOut": ExtractionError("LLM authentication failed for provider gemini: check the key")},
            "^LLM authentication failed for provider gemini",
        ),
        (
            {"_PreferencesOut": {"preferences": [{"subject_name": "Soham", "value_name": "HydraDB"}]}},
            r"invalid result for the preferences pass: preferences\[0\].key: field required",
        ),
        (
            {"_RelationsOut": {"entities": [{"type": "Person", "name": "Ann"}]}},
            "^LLM client returned an invalid result for the relations pass: relations: field required$",
        ),
    ],
    ids=["nothing-extracted", "fatal-llm-error", "malformed-output", "wrong-shape"],
)
def test_unrecoverable_extraction_raises(responses, match):
    g = fresh_graph("fail", llm=FakeLLM({"_EntitiesOut": _full_responses()["_EntitiesOut"], **responses}))
    with pytest.raises(ExtractionError, match=match):
        run(g.insert.text("Soham prefers HydraDB.", source_id="fail"))


def test_strict_text_insert_drops_off_schema_extractions_but_ontology_insert_raises():
    schema = {
        "entities": [{"name": "Person"}, {"name": "Company"}],
        "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"]}, "to": {"types": ["Company"]}}],
    }
    g = fresh_graph("strict-text", llm=FakeLLM(_full_responses()), schema=schema, schema_mode="strict")
    res = run(g.insert.text("Soham works at HydraDB. The team selected it.", source_id="m-strict"))
    assert {e.id for e in res.entities} == {"person:soham", "company:hydradb"}
    assert [r.type for r in res.relations] == ["WORKS_AT"]
    assert res.decisions == []
    dropped = [w.message for w in res.warnings if w.code == "dropped_off_schema"]
    assert dropped[0] == "dropped extracted entity thing:team: entity thing:team has unknown type 'Thing'"
    assert any("relation" in m and "thing:team was dropped" in m for m in dropped)
    with pytest.raises(ValidationError, match="unknown type 'Team'"):
        run(g.insert.ontology({"entities": [{"type": "Team", "name": "Core"}]}))


def test_llm_relations_cite_their_chunk_and_progress_is_logged(caplog):
    text = " ".join(["Soham prefers HydraDB and works there every day."] * 400)
    g = fresh_graph("chunks", llm=FakeLLM(_full_responses()))
    with caplog.at_level(logging.INFO, logger="selfgraph"):
        res = run(g.insert.text(text, source_id="long"))
    progress = [r.getMessage() for r in caplog.records if r.getMessage().startswith("extracting chunk")]
    total = len(progress)
    assert total > 1 and progress[0] == f"extracting chunk 1/{total}"
    rel = next(r for r in res.relations if r.type == "WORKS_AT")
    evidence = run(g.relations.evidence(rel.id, limit=100)).items
    assert {ev.chunk_id for ev in evidence} == {_ids.chunk_id(res.source_version, i) for i in range(total)}
    assert all(ev.source_version == res.source_version for ev in evidence)
