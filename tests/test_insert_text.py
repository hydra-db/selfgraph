import logging
import random
import unicodedata

import pytest
from helpers import FakeLLM, extracting_llm, fresh_graph, new_graph, run, utc

from selfgraph import (
    EntityInput,
    Extraction,
    ExtractionError,
    ExtractionInstructions,
    ExtractionPrompts,
    ParsedDocument,
    PromptTemplate,
    PromptTemplateError,
    Schema,
    SelfGraph,
    ValidationError,
)
from selfgraph import ids as _ids
from selfgraph.extraction.chunking import chunk_text
from selfgraph.extraction.extractor import (
    LLMExtractor,
    _DecisionsOut,
    _DecOut,
    _lenient_event_time,
    _PreferencesOut,
    _PrefOut,
    _RelationsOut,
    _RelOut,
    _StepOut,
)
from selfgraph.extraction.prompts import render


@pytest.mark.parametrize("typed", [False, True])
def test_issue_343_keeps_same_name_entities_with_different_types(typed):
    class LLM:
        async def generate(self, *, system, user, output):
            kind = next(iter(output.model_fields))
            if kind == "entities":
                return {kind: [{"type": "Person", "name": "Acme"}, {"type": "Company", "name": "acme"}]}
            if kind == "relations":
                return {kind: [{"from_name": "Acme", "type": "WORKS_AT", "to_name": "acme"}]}
            if kind == "decisions":
                return {
                    kind: [{"title": "Join", "steps": [{"from_name": "Acme", "type": "WORKS_AT", "to_name": "acme"}]}]
                }
            return {kind: []}

    schema = (
        {
            "entities": [{"name": "Person"}, {"name": "Company"}],
            "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"]}, "to": {"types": ["Company"]}}],
        }
        if typed
        else None
    )
    g = fresh_graph("issue-343", llm=LLM(), resolver="exact", schema=schema)
    result = run(g.insert.text("Acme works at acme."))
    assert {e.id for e in result.entities} == {"person:acme", "company:acme"}
    assert {e.id for e in run(g.entities.list()).items} == {"person:acme", "company:acme"}
    if typed:
        assert [(r.from_entity, r.to_entity) for r in result.relations] == [("person:acme", "company:acme")]
        assert [step.relation_id for step in result.decisions[0].steps] == [result.relations[0].id]
        assert result.warnings == []
    else:
        assert result.relations == []
        assert result.decisions[0].steps == []
        assert [w.code for w in result.warnings] == ["extraction_partial_failure"] * 4


@pytest.mark.parametrize("multiple_chunks", [False, True])
def test_issue_360_unions_aliases_from_every_mention(multiple_chunks):
    calls = 0

    class LLM:
        async def generate(self, *, system, user, output):
            nonlocal calls
            kind = next(iter(output.model_fields))
            if kind != "entities":
                return {kind: []}
            calls += 1
            first = {"type": "Person", "name": "Ann", "aliases": ["A"]}
            later = {"type": "Person", "name": "ann", "aliases": ["A", "Annie"]}
            return {kind: [first] if multiple_chunks and calls == 1 else [first, later]}

    g = fresh_graph("issue-360", llm=LLM(), resolver="exact")
    text = "Ann is also called Annie." + (" context" * 650 if multiple_chunks else "")
    assert len(chunk_text(text)) == (2 if multiple_chunks else 1)
    result = run(g.insert.text(text))
    assert len(result.entities) == 1
    assert result.entities[0].aliases == ["A", "Annie"]
    assert run(g.entities.get("person:ann")).aliases == ["A", "Annie"]
    assert result.warnings == []


def test_replace_source_preserves_facts_when_one_chunk_call_fails():
    llm = extracting_llm([("Person", "Jane"), ("Company", "Acme"), ("Company", "Globex")])
    calls = 0
    phase = "initial"

    def relations(system, user):
        nonlocal calls
        calls += 1
        if phase == "partial" and calls == 2:
            raise TimeoutError("provider timed out")
        target = "Globex" if phase == "initial" and calls == 2 else "Acme"
        return _RelationsOut(relations=[_RelOut(from_name="Jane", type="WORKS_AT", to_name=target)])

    llm.responses["_RelationsOut"] = relations
    g = fresh_graph("replace-partial", llm=llm, resolver="exact")
    text = "Jane works at Acme and Globex." + " context" * 650
    assert len(chunk_text(text)) == 2
    first = run(g.insert.text(text, source_id="doc", replace_source=True))
    prior = {r.id for r in first.relations}
    assert len(prior) == 2
    phase = "partial"
    calls = 0
    result = run(g.insert.text(text + " Updated.", source_id="doc", replace_source=True))
    assert calls == 2
    assert [w.code for w in result.warnings] == ["extraction_partial_failure"]
    assert result.source_diff.retired == []
    assert set(result.source_diff.kept) == {r.id for r in result.relations}
    assert {r.id for r in run(g.relations.list()).items} == prior
    assert all(r.is_current for r in run(g.relations.list(include_invalidated=True)).items)
    phase = "complete"
    calls = 0
    complete = run(g.insert.text(text + " Removed Globex.", source_id="doc", replace_source=True))
    assert calls == 2
    assert set(complete.source_diff.retired) == prior - {r.id for r in complete.relations}
    assert [w.code for w in complete.warnings] == ["fact_retired_by_source"]
    assert {r.id for r in run(g.relations.list()).items} == {r.id for r in complete.relations}


@pytest.mark.parametrize(
    ("dates", "expected"),
    [
        ([None, "2020-01-01"], "2020-01-01"),
        (["2020-01-01", None], "2020-01-01"),
        ([None, None], None),
        (["2020-01-01", "2020-01-01"], "2020-01-01"),
        (["2020-01-01", "2022-01-01"], "2022-01-01"),
        (["2022-01-01", "2020-01-01"], "2020-01-01"),
        ([None, "2020-01-01", "2022-01-01"], "2022-01-01"),
        (["not a date", "2020-01-01"], "2020-01-01"),
        (["2020-01-01", "not a date"], "2020-01-01"),
        (["0001", None], "0001-01-01"),
    ],
)
def test_repeated_extracted_relations_keep_the_last_valid_date(dates, expected):
    facts = LLMExtractor._assemble(
        [EntityInput(type="Person", name="Jane"), EntityInput(type="Company", name="Acme")],
        [_RelOut(from_name="Jane", type="WORKS_AT", to_name="Acme", event_time=date) for date in dates],
        [],
        [],
    )
    [rel] = facts.relations
    assert rel.event_time == _lenient_event_time(expected)
    assert (rel.from_entity, rel.type, rel.to_entity) == ("person:jane", "WORKS_AT", "company:acme")


@pytest.mark.parametrize("multiple_chunks", [False, True])
def test_repeated_extracted_relations_merge_dates_properties_and_evidence(multiple_chunks):
    first = [
        {"event_time": "2020-01-01", "properties": {"role": "Engineer", "remove": "old", "nested": {"old": 1}}},
        {"event_time": None, "properties": {"team": "Platform"}},
    ]
    later = [
        {"event_time": "2022-01-01", "properties": {"role": "Lead", "remove": None, "nested": {"new": 2}}},
        {"event_time": "not a date", "properties": {"office": "London"}},
        {"event_time": None},
    ]

    class DatedLLM(FakeLLM):
        relation_calls = 0

        async def generate(self, *, system, user, output):
            if output is _RelationsOut:
                self.relation_calls += 1
                rows = (first if self.relation_calls == 1 else later) if multiple_chunks else first + later
                return _RelationsOut(
                    relations=[_RelOut(from_name="Jane", type="WORKS_AT", to_name="Acme", **row) for row in rows]
                )
            return await super().generate(system=system, user=user, output=output)

    text = "Jane works at Acme." + (" context" * 650 if multiple_chunks else "")
    chunks = chunk_text(text)
    assert (len(chunks) > 1) == multiple_chunks
    llm = DatedLLM(extracting_llm([("Person", "Jane"), ("Company", "Acme")], []).responses)
    g = fresh_graph("chunk-dates", llm=llm, resolver="exact")
    result = run(g.insert.text(text, source_id="dated-chunks"))
    [rel] = run(g.relations.list()).items
    assert rel.event_time == utc(2022)
    assert rel.properties == {"role": "Lead", "team": "Platform", "office": "London", "nested": {"new": 2}}
    assert len(result.relations) == 1
    assert llm.relation_calls == len(chunks)
    evidence = run(g.relations.evidence(rel.id)).items
    assert {e.chunk_id for e in evidence} == {_ids.chunk_id(result.source_version, c.index) for c in chunks}
    assert rel.source_count == 1
    assert [r.id for r in run(g.retrieve("Jane", as_of="2023-01-01")).subgraph.relations] == [rel.id]


def _relations_llm(rows):
    return FakeLLM(
        {
            **extracting_llm([("Person", "Jane"), ("Company", "Acme")]).responses,
            "_RelationsOut": {
                "relations": [{"from_name": "Jane", "type": "WORKS_AT", "to_name": "Acme", **r} for r in rows]
            },
        }
    )


@pytest.mark.parametrize(
    ("rows", "expected"),
    [
        ([{"properties": {"role": None}}], {"team": "Platform"}),
        (
            [{"properties": {"role": "a", "office": "London"}}, {"properties": {"role": None}}],
            {"team": "Platform", "office": "London"},
        ),
        ([{"properties": {"role": None}}, {"properties": {"role": "b"}}], {"team": "Platform", "role": "b"}),
    ],
)
def test_extracted_null_property_clears_the_stored_key(rows, expected):
    g = fresh_graph("null-props", llm=_relations_llm(rows), resolver="exact")
    run(
        g.insert.facts(
            {
                "entities": [{"type": "Person", "name": "Jane"}, {"type": "Company", "name": "Acme"}],
                "relations": [
                    {
                        "from_entity": "person:jane",
                        "type": "WORKS_AT",
                        "to_entity": "company:acme",
                        "properties": {"role": "x", "team": "Platform"},
                    }
                ],
            }
        )
    )
    res = run(g.insert.text("Jane works at Acme.", source_id="null-props"))
    assert res.warnings == []
    [rel] = run(g.relations.list()).items
    assert rel.properties == expected
    assert rel.revision == 2


def test_extracted_relation_with_a_proto_or_control_property_key_or_non_json_value_is_dropped_with_a_warning():
    bad = [
        {"__proto__": 1},
        {"nested": {"__proto__": {}}},
        {"a\x00b": 1},
        {"nested": [{"a\x00b": 1}]},
        {"when": utc(2022, 1, 1)},
        {"p": float("inf")},
        {"p": float("nan")},
    ]
    rows = [{"properties": {"ok": 1}}, *({"properties": p, "event_time": "2022-01-01"} for p in bad)]
    g = fresh_graph("bad-prop-keys", llm=_relations_llm(rows), resolver="exact")
    res = run(g.insert.text("Jane works at Acme.", source_id="bad-prop-keys"))
    proto = "dropped an extracted relation: property and external id keys cannot be '__proto__'"
    control = "dropped an extracted relation: relation property keys cannot contain control or surrogate characters"
    date = "dropped an extracted relation: relation property cannot hold Date values; use an ISO 8601 string"
    finite = (
        "dropped an extracted relation: relation property cannot hold NaN or Infinity; use a finite number or a string"
    )
    assert [(w.code, w.message) for w in res.warnings] == [
        ("extraction_partial_failure", m) for m in [proto, proto, control, control, date, finite, finite]
    ]
    [rel] = run(g.relations.list()).items
    assert (rel.properties, rel.event_time) == ({"ok": 1}, None)


def _full_responses():
    return {
        **extracting_llm([("Person", "Soham"), ("Company", "HydraDB")], [("Soham", "WORKS_AT", "HydraDB")]).responses,
        "_PreferencesOut": _PreferencesOut(
            preferences=[_PrefOut(subject_name="Soham", stance="preference", key="database", value_name="HydraDB")]
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


def test_insert_text_without_llm_uses_ner_extractor(caplog):
    g = new_graph()
    res = run(g.insert.text("Acme acquired Globex."))
    ids = {e.id for e in res.entities}
    assert "thing:acme" in ids
    assert "thing:globex" in ids
    assert any(w.code == "basic_extraction" for w in res.warnings)
    assert any(r.getMessage().startswith("basic_extraction: extracted without an LLM") for r in caplog.records)
    assert all("pass llm= to SelfGraph" in w.message for w in res.warnings if w.code == "basic_extraction")


@pytest.mark.parametrize(
    ("text", "names"),
    [
        ("# Acme Handbook\n\nAcme was founded in 2019 by Jane Doe.", ["Acme Handbook", "Acme", "Jane Doe"]),
        ("Company Handbook\nAnn works at Acme.", ["Company Handbook", "Ann", "Acme"]),
        ("Attendees:\nAnn Smith\nBob Lee", ["Attendees", "Ann Smith", "Bob Lee"]),
        ("Acme Report\r\nAnn works at Acme.", ["Acme Report", "Ann", "Acme"]),
        ("Ann\tSmith works at Acme.", ["Ann Smith", "Acme"]),
        ("Acme Report\fAnn works at Acme.", ["Acme Report", "Ann", "Acme"]),
        ("Acme Report\u2028Ann works at Acme.", ["Acme Report", "Ann", "Acme"]),
    ],
    ids=["heading", "title-line", "list", "crlf", "tab", "form-feed", "line-separator"],
)
def test_regex_extraction_stops_names_at_line_breaks(text, names):
    res = run(fresh_graph("lines", extraction="regex").insert.text(text))
    assert sorted(e.name for e in res.entities) == sorted(names)
    assert [w.code for w in res.warnings] == ["basic_extraction"]


@pytest.mark.parametrize("form", ["NFC", "NFD"])
def test_regex_extraction_keeps_names_with_combining_marks_whole(form):
    text = unicodedata.normalize(form, "Zoë met José García at Café Société in São Paulo.")
    res = run(fresh_graph("marks", extraction="regex").insert.text(text))
    names = ["Zoë", "José García", "Café Société", "São Paulo"]
    assert sorted(e.name for e in res.entities) == sorted(names)


def test_regex_extraction_keeps_a_mark_with_no_precomposed_form():
    res = run(fresh_graph("marks", extraction="regex").insert.text("Ann met Q\u0307ing Lee at Acme."))
    assert sorted(e.name for e in res.entities) == sorted(
        ["Ann", unicodedata.normalize("NFC", "Q\u0307ing Lee"), "Acme"]
    )


def test_regex_extraction_still_relates_names_in_a_sentence_wrapped_across_lines():
    res = run(fresh_graph("wrapped", extraction="regex").insert.text("Jane Doe met\nBob Smith at Acme."))
    assert {(r.from_entity, r.to_entity) for r in res.relations} == {
        ("thing:jane-doe", "thing:bob-smith"),
        ("thing:bob-smith", "thing:acme"),
    }


def test_extracted_relation_with_an_invalid_endpoint_is_dropped_with_a_warning():
    g = new_graph(llm=extracting_llm([("Person", "Ann")], [("Bob\nLee", "KNOWS", "Ann")]))
    res = run(g.insert.text("Bob Lee knows Ann.", source_id="bad-endpoint"))
    assert [e.id for e in res.entities] == ["person:ann"]
    assert res.relations == []
    assert [w.message for w in res.warnings if w.code == "extraction_partial_failure"] == [
        "dropped an extracted entity: entity name cannot contain control or surrogate characters"
    ]


def test_regex_extraction_keeps_names_that_start_with_a_non_ascii_capital():
    g = fresh_graph("regex-unicode", extraction="regex")
    res = run(g.insert.text("Émile Zola met Łukasz Nowak in Århus. Иван Петров wrote to Σωκράτης."))
    names = {e.name for e in res.entities}
    assert {"Émile Zola", "Łukasz Nowak", "Århus", "Иван Петров", "Σωκράτης"} <= names
    assert "Zola" not in names


def test_llm_entity_ids_are_ignored_and_relation_endpoints_use_the_derived_ids():
    entities = [{"id": "1", "type": "Person", "name": "Ann Lee"}, {"id": "2", "type": "Company", "name": "Acme Inc."}]
    relations = _RelationsOut(relations=[_RelOut(from_name="Ann Lee", type="WORKS_AT", to_name="Acme Inc.")])
    g = fresh_graph("llm-ids", llm=FakeLLM({"_EntitiesOut": {"entities": entities}, "_RelationsOut": relations}))
    res = run(g.insert.text("Ann Lee works at Acme Inc.", source_id="llm-ids"))
    assert {e.id for e in res.entities} == {"person:ann-lee", "company:acme"}
    assert [(r.from_entity, r.type, r.to_entity) for r in res.relations] == [
        ("person:ann-lee", "WORKS_AT", "company:acme")
    ]


def test_llm_entity_with_null_aliases_is_stored_without_aliases():
    entities = [
        {"type": "Person", "name": "Ann Lee", "aliases": None},
        {"type": "Company", "name": "Acme", "aliases": ["Acme Corp"]},
    ]
    g = fresh_graph("llm-null-aliases", llm=FakeLLM({"_EntitiesOut": {"entities": entities}}))
    res = run(g.insert.text("Ann Lee works at Acme.", source_id="llm-null-aliases"))
    assert res.warnings == []
    assert {e.id: e.aliases for e in res.entities} == {"person:ann-lee": [], "company:acme": ["Acme Corp"]}


def test_custom_extractor_bypasses_the_llm_and_receives_the_insert_metadata():
    seen = []

    class Recorder:
        async def extract(self, document: ParsedDocument) -> Extraction:
            seen.append((document.media_type, document.metadata))
            return Extraction(entities=[EntityInput(type="Person", name="Zed")])

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
        LLMExtractor(FakeLLM({}), call_prompts=bogus)
    ok = PromptTemplate(system="s", user='{instructions} {text} {"json": 1}', version="v1")
    LLMExtractor(FakeLLM({}), prompts=ExtractionPrompts(entities=ok))
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
    extractor = LLMExtractor(llm)
    facts = run(
        extractor.extract(ParsedDocument(text="Soham prefers Postgres and avoids Mongo.", media_type="text/plain"))
    )
    assert [(p.stance, p.key, p.value_entity) for p in facts.preferences] == [
        ("preference", "database", "database:postgres")
    ]
    assert facts.relations == []
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
    facts = LLMExtractor._assemble([], [], [], [decision], sink)
    assert [w.code for w in sink] == ["dropped_reserved_relation", "dropped_reserved_relation"]
    assert facts.relations == [] and facts.decisions[0].steps == []


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


def test_strict_text_insert_drops_off_schema_extractions_but_facts_insert_raises():
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
        run(g.insert.facts({"entities": [{"type": "Team", "name": "Core"}]}))

    aged_schema = {
        "entities": [
            {"name": "Person", "properties": [{"name": "age", "type": "integer", "required": True}]},
            {"name": "Company"},
        ],
        "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"]}, "to": {"types": ["Company"]}}],
    }
    g_aged = fresh_graph("strict-text-merged", llm=FakeLLM(_full_responses()), schema=aged_schema, schema_mode="strict")
    run(
        g_aged.insert.facts(
            {"entities": [{"type": "Person", "name": "Soham Gupta", "aliases": ["Soham"], "properties": {"age": 28}}]}
        )
    )
    res_aged = run(g_aged.insert.text("Soham works at HydraDB. The team selected it.", source_id="m-aged"))
    assert {e.id for e in res_aged.entities} == {"person:soham-gupta", "company:hydradb"}
    assert [(r.from_entity, r.type) for r in res_aged.relations] == [("person:soham-gupta", "WORKS_AT")]
    assert [m.survivor_id for m in res_aged.merges] == ["person:soham-gupta"]
    assert run(g_aged.entities.get("person:soham-gupta")).properties == {"age": 28}


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


def test_llm_restatement_keeps_the_stored_decision_fields():
    g = fresh_graph("restate", llm=FakeLLM(_full_responses()))
    [dec] = run(g.insert.text("The team selected HydraDB.", source_id="m1")).decisions
    assert dec.status == "completed"
    run(g.decisions.update(dec.id, status="active", rationale="needs temporal history"))
    [again] = run(g.insert.text("The team picked HydraDB again.", source_id="m2")).decisions
    assert (again.id, again.status, again.rationale) == (dec.id, "active", "needs temporal history")


def test_lenient_event_time_reads_a_bare_year_and_drops_what_it_cannot_parse():
    assert _lenient_event_time("2021") == utc(2021)
    assert _lenient_event_time(" 0001 ") == utc(1)
    assert _lenient_event_time("2021-06-15T12:00:00Z") == utc(2021, 6, 15).replace(hour=12)
    for noise in ("0000", "\u00b2\u00b2\u00b2\u00b2", "\uff12\uff10\uff12\uff11", "March 2021", "", None):
        assert _lenient_event_time(noise) is None


def test_llm_year_event_time_is_stored_and_an_unparseable_one_keeps_its_relation():
    times = {"JOINED": "2021", "KNOWS": "March 2021", "MET": "\u00b2\u00b2\u00b2\u00b2"}

    class YearLLM(FakeLLM):
        async def generate(self, *, system, user, output):
            name = output.__name__
            if name == "_EntitiesOut":
                return {"entities": [{"type": "Person", "name": "Ann"}, {"type": "Company", "name": "Acme"}]}
            if name == "_RelationsOut":
                return {
                    "relations": [
                        {"from_name": "Ann", "type": rtype, "to_name": "Acme", "event_time": event_time}
                        for rtype, event_time in times.items()
                    ]
                }
            return {name[1:-3].lower(): []}

    g = fresh_graph("extract-year", llm=YearLLM(), resolver="exact")
    res = run(g.insert.text("Ann joined Acme in 2021.", source_id="doc"))
    assert res.warnings == []
    assert {r.type: r.event_time for r in res.relations} == {"JOINED": utc(2021), "KNOWS": None, "MET": None}
    assert run(g.retrieve("Ann Acme", as_of="2000-01-01")).subgraph.relations == []


def test_custom_extractor_rejects_proto_properties():
    class Extractor:
        async def extract(self, document):
            entity = EntityInput(type="Person", name="Ann")
            entity.properties = {"nested": [{"__proto__": "x"}]}
            return Extraction(entities=[entity])

    g = fresh_graph("proto_ext", extractor=Extractor())
    with pytest.raises(ValidationError, match="^property and external id keys cannot be '__proto__'$"):
        run(g.insert.text("Ann is a person."))
    assert run(g.entities.list()).items == []


_RESOLVE_TYPES = ["Person", "Company", "Organization", "Organisation", "Bank", "Org", "COMPANY", "Place", "Thing"]
_RESOLVE_BASES = ["Acme", "Beta", "Café", "Straße", "Ünï", "Jane Doe"]
_RESOLVE_PREFIXES = ["", "The ", "the "]
_RESOLVE_SUFFIXES = ["", " Inc", " inc.", " Corp", " LLC", "!", " Ltd"]
_RESOLVE_CASES = [str, str.upper, str.lower]
_RESOLVE_FORMS = ["NFC", "NFD"]
_FILLERS = 1000


def _resolve_surface(rng):
    name = rng.choice(_RESOLVE_PREFIXES) + rng.choice(_RESOLVE_BASES) + rng.choice(_RESOLVE_SUFFIXES)
    return unicodedata.normalize(rng.choice(_RESOLVE_FORMS), rng.choice(_RESOLVE_CASES)(name))


def _scan_resolve(registry, name):
    matches = [e for e in registry.values() if _ids.entity_id(e.type, name) == _ids.entity_id(e.type, e.name)]
    if len(matches) > 1:
        return None
    if not matches:
        ent = EntityInput(type="Thing", name=name.strip())
        registry[_ids.entity_id(ent.type, ent.name)] = ent
        return _ids.entity_id(ent.type, ent.name)
    return _ids.entity_id(matches[0].type, matches[0].name)


def _scan_registry(entities):
    registry = {}
    for ent in entities:
        registry.setdefault(_ids.entity_id(ent.type, ent.name), ent)
    return registry


def _limit_derivations(monkeypatch, budget):
    calls = 0

    def counted(fn):
        def wrapper(*args):
            nonlocal calls
            calls += 1
            if calls > budget:
                raise AssertionError(f"name resolution derived more than {budget} ids")
            return fn(*args)

        return wrapper

    monkeypatch.setattr(_ids, "entity_id", counted(_ids.entity_id))
    monkeypatch.setattr(_ids, "_canonical_name", counted(_ids._canonical_name))


def _fillers():
    return [EntityInput(type="Thing", name=f"Filler {i}") for i in range(_FILLERS)]


def _assemble_names(monkeypatch, entities, names, sink=None):
    _limit_derivations(monkeypatch, 6 * _FILLERS + 20 * len(names))
    rels = [_RelOut(from_name=name, type=f"R{i}", to_name="Anchor") for i, name in enumerate(names)]
    anchor = EntityInput(type="Person", name="Anchor")
    return LLMExtractor._assemble([*_fillers(), *entities, anchor], rels, [], [], sink)


@pytest.mark.parametrize("seed", range(60))
def test_name_resolution_matches_the_linear_scan_on_random_name_sets(seed, monkeypatch):
    rng = random.Random(seed)
    entities = [
        EntityInput(type=rng.choice(_RESOLVE_TYPES), name=_resolve_surface(rng), aliases=[_resolve_surface(rng)])
        for _ in range(rng.randint(0, 14))
    ]
    names = [_resolve_surface(rng) for _ in range(40)]
    registry = _scan_registry([*entities, EntityInput(type="Person", name="Anchor")])
    expected = [_scan_resolve(registry, name) for name in names]
    sink = []
    facts = _assemble_names(monkeypatch, entities, names, sink)
    assert [r.from_entity for r in facts.relations] == [eid for eid in expected if eid is not None]
    assert [(e.type, e.name) for e in facts.entities[_FILLERS:]] == [(e.type, e.name) for e in registry.values()]
    assert [w.message for w in sink] == [
        f"unresolved extracted entity reference {name!r}: multiple entity types match"
        for name, eid in zip(names, expected, strict=True)
        if eid is None
    ]


@pytest.mark.parametrize(
    ("entities", "name", "expected"),
    [
        ([("Organization", "Acme"), ("Company", "Acme Ltd")], "ACME Inc", None),
        ([("Company", "Acme Ltd"), ("Organization", "Acme")], "ACME Inc", None),
        ([("Person", "Acme"), ("Company", "Acme")], "Acme Inc", "company:acme"),
        ([("Person", "Acme!"), ("Company", "Acme Corp")], "Acme", None),
        ([("Person", "Acme!"), ("Company", "Acme Corp")], "The Acme Inc", "company:acme"),
        ([("Person", "Acme!"), ("Company", "Acme Corp")], "ACME.", None),
        ([("Person", "Bob"), ("Place", "Bob")], "BOB.", None),
        ([("Person", "Robert")], "Bob", "thing:bob"),
        ([("Person", "Bob"), ("Person", "Robert")], "BOB.", "person:bob"),
        ([("Person", "Bob"), ("Human", "Bob")], "bob", None),
        ([("Place", "Café")], "Café", "place:café"),
        ([("Place", "Café")], "CAFÉ", "place:café"),
        ([("COMPANY", "Acme Corp")], "ACME inc", "company:acme"),
        ([("Person", "The Acme Inc")], "The Acme Inc!", "person:the-acme-inc"),
        ([("Thing", "Acme Inc")], "ACME INC.", "thing:acme-inc"),
        ([], "Acme Inc", "thing:acme-inc"),
    ],
)
def test_name_resolution_pins_the_winner(entities, name, expected, monkeypatch):
    registered = [EntityInput(type=t, name=n) for t, n in entities]
    sink = []
    facts = _assemble_names(monkeypatch, registered, [name], sink)
    assert [r.from_entity for r in facts.relations] == ([] if expected is None else [expected])
    assert len(sink) == (expected is None)


@pytest.mark.parametrize("name", ["!!!", "...", " - "])
def test_name_resolution_drops_punctuation_only_names_without_a_warning(name, monkeypatch):
    sink = []
    facts = _assemble_names(monkeypatch, [EntityInput(type="Person", name="Bob")], [name, "BOB."], sink)
    assert [r.from_entity for r in facts.relations] == ["person:bob"]
    assert sink == []


@pytest.mark.parametrize("bob_first", [True, False])
def test_name_resolution_ignores_aliases_that_name_another_entity(bob_first, monkeypatch):
    bob = EntityInput(type="Person", name="Bob")
    robert = EntityInput(type="Person", name="Robert", aliases=["Bob", "Rob"])
    facts = _assemble_names(monkeypatch, [bob, robert] if bob_first else [robert, bob], ["BOB.", "ROB."])
    assert [r.from_entity for r in facts.relations] == ["person:bob", "thing:rob"]


def test_name_resolution_picks_the_endpoint_type_out_of_several_matches(monkeypatch):
    _limit_derivations(monkeypatch, 6 * _FILLERS + 100)
    schema = Schema.model_validate(
        {
            "entities": [{"name": "Person"}, {"name": "Company"}],
            "relations": [{"type": "WORKS_AT", "from": {"types": ["Person"]}, "to": {"types": ["Company"]}}],
        }
    )
    entities = [*_fillers(), EntityInput(type="Company", name="Acme"), EntityInput(type="Person", name="acme")]
    facts = LLMExtractor._assemble(
        entities, [_RelOut(from_name="ACME", type="WORKS_AT", to_name="Acme.")], [], [], schema=schema
    )
    assert [(r.from_entity, r.to_entity) for r in facts.relations] == [("person:acme", "company:acme")]


@pytest.mark.parametrize(
    ("from_types", "expected"),
    [(["Person"], "person:acme"), (["Place"], "place:acme"), (["Person", "Company"], None), (["Org"], None)],
)
def test_name_resolution_narrows_several_matches_by_endpoint_type(from_types, expected, monkeypatch):
    _limit_derivations(monkeypatch, 6 * _FILLERS + 100)
    schema = Schema.model_validate(
        {
            "entities": [{"name": "Person"}, {"name": "Company"}, {"name": "Place"}, {"name": "Org"}],
            "relations": [{"type": "KNOWS", "from": {"types": from_types}, "to": {"types": ["Person"]}}],
        }
    )
    entities = [EntityInput(type=t, name="Acme") for t in ["Company", "Person", "Place"]]
    sink = []
    facts = LLMExtractor._assemble(
        [*_fillers(), *entities, EntityInput(type="Person", name="Anchor")],
        [_RelOut(from_name="ACME", type="KNOWS", to_name="Anchor")],
        [],
        [],
        sink,
        schema,
    )
    assert [r.from_entity for r in facts.relations] == ([] if expected is None else [expected])
    assert len(sink) == (expected is None)


def test_every_name_lookup_resolves_through_the_same_index(monkeypatch):
    entities = [
        EntityInput(type="Company", name="Acme Corp"),
        EntityInput(type="Person", name="Jane"),
        EntityInput(type="Place", name="Café"),
    ]
    acme, cafe = "ACME inc", "Café"
    step = _StepOut(from_name=acme, type="USES", to_name=cafe)
    _limit_derivations(monkeypatch, 6 * _FILLERS + 100)
    facts = LLMExtractor._assemble(
        [*_fillers(), *entities],
        [_RelOut(from_name=acme, type="OWNS", to_name=cafe)],
        [_PrefOut(subject_name=acme, key="venue", value_name=cafe, about_name=acme)],
        [
            _DecOut(
                title="Pick a venue",
                actor_name=acme,
                outcome_name=cafe,
                alternative_names=[cafe, acme, "Nowhere Inc"],
                steps=[step],
            )
        ],
    )
    assert [(r.from_entity, r.to_entity) for r in facts.relations] == [("company:acme", "place:café")] * 2
    [pref] = facts.preferences
    assert (pref.subject_entity, pref.value_entity, pref.about_entity) == ("company:acme", "place:café", "company:acme")
    [decision] = facts.decisions
    assert (decision.actor_entity, decision.outcome_entity) == ("company:acme", "place:café")
    assert decision.alternative_entities == ["place:café", "company:acme", "thing:nowhere-inc"]
    assert [(e.type, e.name) for e in facts.entities[_FILLERS:]] == [
        ("Company", "Acme Corp"),
        ("Person", "Jane"),
        ("Place", "Café"),
        ("Thing", "Nowhere Inc"),
    ]


def test_name_resolution_drops_invalid_and_blank_names_with_one_warning(monkeypatch):
    bad = "Bad\x00name"
    sink = []
    alone = [_RelOut(from_name=bad, type=f"R{i}", to_name="Jane") for i in range(2)]
    assert LLMExtractor._assemble([], alone, [], [], sink).relations == []
    assert [w.code for w in sink] == ["extraction_partial_failure"]
    assert sink[0].message.startswith("dropped an extracted entity: ")

    sink = []
    facts = _assemble_names(monkeypatch, [], [bad, "  ", bad, "", "\t", "Gamma Inc"], sink)
    assert [r.from_entity for r in facts.relations] == ["thing:gamma-inc"]
    assert [w.code for w in sink] == ["extraction_partial_failure"]
    assert sink[0].message.startswith("dropped an extracted entity: ")


def test_name_resolution_work_grows_linearly_with_the_entity_count(monkeypatch):
    n = 2000
    entities = [EntityInput(type="Person", name=f"Person {i}") for i in range(n)]
    rels = [_RelOut(from_name=f"Person {i}", type="KNOWS", to_name=f"Stranger {i}") for i in range(n)]
    _limit_derivations(monkeypatch, 30 * n)
    facts = LLMExtractor._assemble(entities, rels, [], [])
    assert len(facts.entities) == 2 * n and len(facts.relations) == n


@pytest.mark.parametrize(
    "relations", [None, [_RelOut.model_construct(from_name="Ann", type="KNOWS", to_name="Bob", event_time=2024)]]
)
def test_extraction_revalidates_output_model_instances(relations):
    llm = FakeLLM({"_RelationsOut": _RelationsOut.model_construct(relations=relations)})
    g = fresh_graph("invalid-instance", llm=llm)
    with pytest.raises(ExtractionError) as caught:
        run(g.insert.text("Ann knows Bob.", source_id="s"))
    field = "relations" if relations is None else "relations[0].event_time"
    assert caught.value.code == "invalid_llm_output"
    assert str(caught.value).startswith(f"LLM client returned an invalid result for the relations pass: {field}:")
    assert run(g.entities.list()).items == []
    assert run(g.relations.list()).items == []


def test_extraction_revalidates_raw_items_inside_output_model():
    llm = FakeLLM(
        {
            "_RelationsOut": _RelationsOut.model_construct(
                relations=[{"from_name": "Ann", "type": "KNOWS", "to_name": "Bob"}]
            )
        }
    )
    g = fresh_graph("raw-instance", llm=llm)
    result = run(g.insert.text("Ann knows Bob.", source_id="s"))
    assert [(r.from_entity, r.type, r.to_entity) for r in result.relations] == [("thing:ann", "KNOWS", "thing:bob")]


@pytest.mark.parametrize("alias", ["Acme\x07Inc", "Acme\x00Inc", "Acme\ud800Inc", "Acme\x85Inc"])
def test_issue_362_drops_only_bad_extracted_alias(alias):
    llm = FakeLLM(
        {
            "_EntitiesOut": {
                "entities": [
                    {"type": "Person", "name": "Ann", "aliases": []},
                    {"type": "Company", "name": "Acme", "aliases": ["AC", alias]},
                ]
            },
            "_RelationsOut": {
                "relations": [{"from_name": "Ann", "type": "WORKS_AT", "to_name": "Acme", "event_time": None}]
            },
        }
    )
    g = fresh_graph("issue-362", llm=llm)
    result = run(g.insert.text("Ann works at Acme."))
    assert {e.id for e in result.entities} == {"person:ann", "company:acme"}
    assert run(g.entities.get("company:acme")).aliases == ["AC"]
    assert len(result.relations) == 1
    assert [(w.code, w.message) for w in result.warnings] == [
        (
            "extraction_partial_failure",
            "dropped an extracted alias: entity alias cannot contain control or surrogate characters",
        )
    ]
    with pytest.raises(ValidationError, match="entity alias cannot contain"):
        EntityInput(type="Company", name="Acme", aliases=[alias])


ANN = {"type": "Person", "name": "Ann"}
ACME = {"type": "Company", "name": "Acme"}
CHOSE = {"from_name": "Ann", "type": "CHOSE", "to_name": "Acme"}
FRESH_STEP = {"from_name": "Zed", "type": "CHOSE", "to_name": "Pizza"}


def extract_items(kind, rows, entities=(ANN, ACME), relations=()):
    llm = FakeLLM(
        {
            "_EntitiesOut": {"entities": list(entities)},
            "_RelationsOut": {"relations": list(relations)},
            f"_{kind.title()}Out": {kind: rows},
        }
    )
    g = fresh_graph("issue-342", llm=llm)
    result = run(g.insert.text("x"))
    stored = {
        "entities": sorted(e.id for e in run(g.entities.list()).items),
        "relations": [(r.from_entity, r.type, r.to_entity) for r in run(g.relations.list()).items],
        "decisions": [d.title for d in run(g.decisions.list()).items],
        "preferences": [(p.subject_entity, p.key, p.value_entity) for p in run(g.preferences.list()).items],
    }
    return result, stored


@pytest.mark.parametrize("title", ["", "   ", "Pick\x07it"])
@pytest.mark.parametrize("actor", [None, "Ann", "Nobody"])
def test_issue_342_dropped_decision_writes_nothing_it_named(title, actor):
    row = {"title": title, "actor_name": actor, "outcome_name": "Fresh Outcome", "steps": [CHOSE, FRESH_STEP]}
    result, stored = extract_items("decisions", [row])
    assert stored == {
        "entities": ["company:acme", "person:ann"],
        "relations": [],
        "decisions": [],
        "preferences": [],
    }
    assert [e.id for e in result.entities] == ["person:ann", "company:acme"]
    assert result.relations == []
    assert result.decisions == []
    assert [w.code for w in result.warnings] == ["extraction_partial_failure"]
    assert result.warnings[0].message.startswith("dropped an extracted decision: ")


def test_issue_342_dropped_decision_keeps_what_other_items_wrote():
    rows = [
        {"title": "", "actor_name": "Newcomer", "steps": [CHOSE, FRESH_STEP]},
        {"title": "Pick Acme", "actor_name": "Zed", "steps": [FRESH_STEP]},
    ]
    result, stored = extract_items("decisions", rows)
    assert stored["entities"] == ["company:acme", "person:ann", "thing:pizza", "thing:zed"]
    assert stored["relations"] == [("thing:zed", "CHOSE", "thing:pizza")]
    assert stored["decisions"] == ["Pick Acme"]
    assert [len(d.steps) for d in result.decisions] == [1]
    assert len(result.warnings) == 1


@pytest.mark.parametrize(
    "row",
    [
        {"subject_name": "Zed", "key": "food", "value_name": "Pizza", "strength": 5.0},
        {"subject_name": "Zed", "key": "food", "value_name": "Pizza", "strength": -0.1},
        {"subject_name": "Zed", "key": "", "value_name": "Pizza"},
        {"subject_name": "Zed", "key": "food", "value_name": ""},
        {"subject_name": "Zed", "key": "food", "value_name": "Pizza", "about_name": "Dinner", "strength": 2.0},
    ],
)
def test_issue_342_dropped_preference_writes_nothing_it_named(row):
    result, stored = extract_items("preferences", [row])
    assert stored["entities"] == ["company:acme", "person:ann"]
    assert stored["preferences"] == []
    assert [e.id for e in result.entities] == ["person:ann", "company:acme"]
    assert result.preferences == []


def test_issue_342_dropped_preference_keeps_what_other_items_wrote():
    rows = [
        {"subject_name": "Zed", "key": "food", "value_name": "Pizza", "strength": 5.0},
        {"subject_name": "Zed", "key": "drink", "value_name": "Tea", "strength": 0.5},
        {"subject_name": "Ann", "key": "food", "value_name": "Pizza", "strength": 7.0},
    ]
    result, stored = extract_items("preferences", rows)
    assert stored["entities"] == ["company:acme", "person:ann", "thing:tea", "thing:zed"]
    assert stored["preferences"] == [("thing:zed", "drink", "thing:tea")]
    assert len(result.warnings) == 2


def test_issue_342_dropped_preference_does_not_block_the_one_a_relation_states():
    soup = {"type": "Food", "name": "Soup", "aliases": []}
    likes = {"from_name": "Ann", "type": "PREFERS", "to_name": "Soup", "event_time": None}
    row = {"subject_name": "Ann", "key": "taste", "value_name": "Soup", "strength": 9.0}
    result, stored = extract_items("preferences", [row], entities=(ANN, ACME, soup), relations=[likes])
    assert stored["preferences"] == [("person:ann", "food", "food:soup")]
    assert stored["relations"] == []
    assert len(result.warnings) == 1
    assert result.warnings[0].message.startswith("dropped an extracted preference: ")
