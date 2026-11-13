import pytest
from helpers import WORKS_AT_SPEC, FakeLLM, cli, fresh_graph, json_file, mcp_session, run, utc, works_at

from selfgraph import (
    DefaultResolver,
    Entity,
    EntityInput,
    LLMResolver,
    NotFoundError,
    ResolutionDecision,
    ValidationError,
    decision_id,
    entity_id,
    preference_id,
    relation_id,
)
from selfgraph.cli import build_parser
from selfgraph.resolution import (
    _SameEntity,
    distinct_names,
    jaro_winkler,
    name_similarity,
    token_jaccard,
)
from selfgraph.runtime import settings_from_env

AT = utc(2024)
IBM = entity_id("Company", "International Business Machines")
BIG_BLUE = entity_id("Company", "Big Blue")
ADA = entity_id("Person", "Ada")
ROBERT_ID = entity_id("Person", "Robert")
BOB_ID = entity_id("Person", "Bob")
ROBERT = {"type": "Person", "name": "Robert", "aliases": ["Bob"]}
BOB = {"type": "Person", "name": "Bob"}
JANE = entity_id("Person", "Jane Doe")
JD = entity_id("Person", "JD")
JANE_DOES = entity_id("Person", "Jane Does")
IBM_SEED = {"type": "Company", "name": "International Business Machines", "external_ids": {"ticker": "IBM"}}


def _entity(eid, type_, name, aliases=(), external_ids=None):
    stamps = {"created_at": AT, "updated_at": AT}
    return Entity(id=eid, type=type_, name=name, aliases=list(aliases), external_ids=external_ids or {}, **stamps)


def _seed(g, *entities):
    run(g.insert.facts({"entities": list(entities)}))


def _people(*names):
    return {"entities": [{"type": "Person", "name": n} for n in names]}


def _ids(g):
    return sorted(e.id for e in run(g.entities.list(limit=1000)).items)


def test_jaro_winkler_and_jaccard_reference_values():
    assert jaro_winkler("MARTHA", "MARHTA") == pytest.approx(0.9611111111111111)
    assert jaro_winkler("DWAYNE", "DUANE") == pytest.approx(0.84)
    assert jaro_winkler("", "a") == 0.0
    assert jaro_winkler("abc", "abc") == 1.0
    assert token_jaccard("New York Times", "the new york times") == 1.0
    assert token_jaccard("", "x") == 0.0
    assert name_similarity("Jonathan Smith", "jonathon smith") == jaro_winkler("jonathan smith", "jonathon smith")


def test_default_resolver_decisions():
    stored = [
        _entity("company:big-blue", "Company", "Big Blue", external_ids={"ticker": "IBM"}),
        _entity("company:ibm-research", "Company", "IBM Research", aliases=["IBM Labs"]),
    ]
    decide = DefaultResolver().decide
    by_id = decide(EntityInput(type="Company", name="Big Blue"), stored)
    assert (by_id.target_id, by_id.confidence, by_id.reason) == ("company:big-blue", 1.0, "id")
    by_ext = decide(EntityInput(type="Company", name="IBM", external_ids={"ticker": "IBM"}), stored)
    assert (by_ext.target_id, by_ext.confidence, by_ext.reason) == ("company:big-blue", 1.0, "external_id")
    by_alias = decide(EntityInput(type="Company", name="ibm labs"), stored)
    assert (by_alias.target_id, by_alias.confidence, by_alias.reason) == ("company:ibm-research", 0.95, "alias")
    assert decide(EntityInput(type="Company", name="IBMR", aliases=["IBM Research"]), stored).target_id == (
        "company:ibm-research"
    )
    assert decide(EntityInput(type="Company", name="Microsoft"), stored).target_id is None
    thing = EntityInput(type="Thing", name="Y", external_ids={"lei": "1"})
    assert decide(thing, [_entity("company:x", "Company", "X", external_ids={"lei": "1"})]).target_id is None

    people = [
        _entity("person:jane3", "Person", "Jane"),
        _entity("person:jane", "Person", "Jane Doe", aliases=["Jane"]),
        _entity("person:jd", "Person", "J D", aliases=["JD"]),
        _entity("person:b", "Person", "B", aliases=["Sam"]),
        _entity("person:a", "Person", "A", aliases=["Sam"]),
    ]
    assert decide(EntityInput(type="Person", name="Sam"), people).target_id == "person:a"
    assert decide(EntityInput(type="Person", name="Janie", aliases=["Jane"]), people).target_id == "person:jane"
    assert decide(EntityInput(type="Person", name="Jay", aliases=["jd"]), people).target_id == "person:jd"

    stored = [_entity("person:jonathan-smith", "Person", "Jonathan Smith")]
    candidate = EntityInput(type="Person", name="Jonathon Smith")
    assert decide(candidate, stored).target_id is None
    fuzzy = DefaultResolver(fuzzy=True).decide(candidate, stored)
    assert (fuzzy.target_id, fuzzy.reason) == ("person:jonathan-smith", "similarity")
    assert fuzzy.confidence == pytest.approx(name_similarity("Jonathon Smith", "Jonathan Smith"))
    assert DefaultResolver(fuzzy=True, threshold=0.99).decide(candidate, stored).target_id is None
    other_type = [_entity("company:jonathan-smith", "Company", "Jonathan Smith")]
    assert DefaultResolver(fuzzy=True).decide(candidate, other_type).target_id is None


def test_resolver_arguments_are_validated():
    with pytest.raises(ValidationError):
        DefaultResolver(threshold=0)
    with pytest.raises(ValidationError):
        DefaultResolver(threshold=1.5)
    with pytest.raises(ValidationError):
        LLMResolver(FakeLLM(), band=(0.9, 0.8))
    with pytest.raises(ValidationError, match="one of exact, default, fuzzy, llm"):
        fresh_graph("res", resolver="fuzzier")
    with pytest.raises(ValidationError):
        fresh_graph("res", resolver=object())
    with pytest.raises(ValidationError, match="needs an LLM"):
        fresh_graph("res", resolver="llm")
    g = fresh_graph("res")
    with pytest.raises(ValidationError):
        run(g.insert.facts({"entities": []}, resolver="nope"))
    with pytest.raises(ValidationError, match="needs an LLM"):
        run(g.insert.text("Ada met Bob.", resolver="llm"))


def test_exact_mode_explicit_ids_and_per_call_resolver():
    g = fresh_graph("res", resolver="exact")
    _seed(g, IBM_SEED, ROBERT)
    res = run(
        g.insert.facts({"entities": [{"type": "Company", "name": "Big Blue", "external_ids": {"ticker": "IBM"}}]})
    )
    assert res.merges == []
    assert not [w for w in res.warnings if w.code == "entity_merged"]
    assert _ids(g) == [BIG_BLUE, IBM, ROBERT_ID]
    explicit = {"id": "company:ibm", "type": "Company", "name": "IBM", "external_ids": {"ticker": "IBM"}}
    assert run(g.insert.facts({"entities": [explicit]}, resolver="default")).merges == []
    assert "company:ibm" in _ids(g)
    assert len(run(g.insert.facts({"entities": [BOB]}, resolver="default")).merges) == 1
    g = fresh_graph("res", resolver="default")
    _seed(g, ROBERT)
    assert run(g.insert.facts({"entities": [BOB]}, resolver="exact")).merges == []


def test_external_id_merge_rewrites_relations_and_records_the_merge():
    g = fresh_graph("res", resolver="default")
    _seed(g, IBM_SEED, {"type": "Person", "name": "Ada"})
    big_blue = {"type": "Company", "name": "Big Blue", "aliases": ["IBM"], "external_ids": {"ticker": "IBM"}}
    rel = {"from_entity": ADA, "type": "WORKS_AT", "to_entity": BIG_BLUE}
    res = run(g.insert.facts({"entities": [big_blue], "relations": [rel]}, source_id="doc-1"))
    assert _ids(g) == [IBM, ADA]
    assert [e.id for e in res.entities] == [IBM]
    assert res.relations[0].to_entity == IBM
    assert res.relations[0].id == relation_id(ADA, "WORKS_AT", IBM)
    [merge] = res.merges
    assert (merge.survivor_id, merge.absorbed_id, merge.reason, merge.confidence) == (IBM, BIG_BLUE, "external_id", 1.0)
    assert merge.source_id == "doc-1"
    assert merge.added_aliases == ["Big Blue", "IBM"]
    assert merge.absorbed["name"] == "Big Blue"
    assert [(r.kind, r.id, r.existed) for r in merge.rewrites] == [("relation", res.relations[0].id, False)]
    assert [w.code for w in res.warnings] == ["entity_merged"]
    survivor = run(g.entities.get(IBM))
    assert survivor.name == "International Business Machines"
    assert survivor.aliases == ["IBM", "Big Blue"]
    assert [m.id for m in run(g.entities.merges(IBM)).items] == [merge.id]


def test_alias_merge_and_type_gating_with_and_without_schema():
    g = fresh_graph("res", resolver="default")
    _seed(g, {"type": "Person", "name": "Robert Smith", "aliases": ["Bob Smith"]})
    _seed(g, {"type": "Company", "name": "Apple Inc", "aliases": ["Apple"]})
    res = run(g.insert.facts({"entities": [{"type": "Person", "name": "bob smith", "properties": {"age": 40}}]}))
    [merge] = res.merges
    assert (merge.reason, merge.confidence) == ("alias", 0.95)
    survivor = run(g.entities.get(entity_id("Person", "Robert Smith")))
    assert (survivor.properties, survivor.type) == ({"age": 40}, "Person")
    assert run(g.insert.facts({"entities": [{"type": "Fruit", "name": "Apple"}]})).merges == []

    schema = {
        "entities": [
            {"name": "Person"},
            {"name": "Manager", "parent": "Person"},
            {"name": "Engineer", "parent": "Person"},
        ]
    }
    g = fresh_graph("res", resolver="default", schema=schema)
    _seed(g, {"type": "Person", "name": "Grace Hopper", "aliases": ["Amazing Grace"]})
    _seed(g, {"type": "Manager", "name": "Linus Torvalds", "aliases": ["Linus"]})
    _seed(g, {"type": "Engineer", "name": "Ken Thompson", "aliases": ["Ken"]})
    down = run(g.insert.facts({"entities": [{"type": "Manager", "name": "Amazing Grace"}]}))
    assert [m.survivor_id for m in down.merges] == [entity_id("Person", "Grace Hopper")]
    up = run(g.insert.facts({"entities": [{"type": "Person", "name": "Linus"}]}))
    assert [m.survivor_id for m in up.merges] == [entity_id("Manager", "Linus Torvalds")]
    assert run(g.insert.facts({"entities": [{"type": "Manager", "name": "Ken"}]})).merges == []


def test_within_batch_needs_fuzzy():
    batch = {
        "entities": [IBM_SEED, {"type": "Company", "name": "Big Blue", "external_ids": {"ticker": "IBM"}}],
        "relations": [{"from_entity": BIG_BLUE, "type": "OWNS", "to_entity": IBM}],
    }
    g = fresh_graph("res", resolver="default")
    assert run(g.insert.facts(batch)).merges == []
    assert _ids(g) == [BIG_BLUE, IBM]

    g = fresh_graph("res", resolver="fuzzy")
    res = run(g.insert.facts(batch))
    assert [(m.absorbed_id, m.survivor_id) for m in res.merges] == [(BIG_BLUE, IBM)]
    assert _ids(g) == [IBM]
    assert res.relations == []
    rid = relation_id(BIG_BLUE, "OWNS", IBM)
    assert [(w.code, w.message) for w in res.warnings if w.code == "merge_self_loop"] == [
        (
            "merge_self_loop",
            f"relation {rid} ({BIG_BLUE} -OWNS-> {IBM}) would join {IBM} to itself after a merge and was dropped; "
            "unmerging restores it",
        )
    ]
    assert run(g.relations.list()).items == []
    restored = run(g.entities.unmerge(res.merges[0].id))
    assert [(r.id, r.from_entity, r.to_entity) for r in restored.relations] == [(rid, BIG_BLUE, IBM)]


def test_insert_result_lists_each_entity_and_relation_once_after_a_merge():
    g = fresh_graph("res", resolver="fuzzy")
    batch = [IBM_SEED, {"type": "Company", "name": "Big Blue", "external_ids": {"ticker": "IBM"}}, BOB]
    rels = [{"from_entity": BOB_ID, "type": "WORKS_AT", "to_entity": c} for c in (IBM, BIG_BLUE)]
    res = run(g.insert.facts({"entities": batch, "relations": rels}))
    assert [r.id for r in res.relations] == [relation_id(BOB_ID, "WORKS_AT", IBM)]
    assert len({e.id for e in res.entities}) == len(res.entities)

    janes = _people("Jane Doe", "Jane Does")
    janes["entities"].append({"type": "Person", "name": "jane doe", "aliases": ["Janie"]})
    res = run(g.insert.facts(janes))
    assert [e.id for e in res.entities] == [JANE]
    assert res.entities[0].aliases == ["Jane Does", "Janie"]
    assert [(m.absorbed_id, m.survivor_id) for m in res.merges] == [(JANE_DOES, JANE)]
    [warning] = [w for w in res.warnings if w.code == "entity_merged"]
    merge = res.merges[0]
    assert warning.merge_id == merge.id
    assert warning.message == (
        f"entity {JANE_DOES} merged into {JANE} (similarity, confidence {merge.confidence!r}, merge id {merge.id}); "
        "undo with unmerge"
    )


def test_merge_rewrites_every_reference_and_unmerge_restores_them():
    g = fresh_graph("res", resolver="default")
    tool = entity_id("Tool", "Hammer")
    _seed(g, ROBERT, {"type": "Person", "name": "Ada"})
    run(g.insert.facts({"relations": [{"from_entity": ADA, "type": "KNOWS", "to_entity": ROBERT_ID}]}))
    facts = {
        "entities": [BOB, {"type": "Tool", "name": "Hammer"}],
        "relations": [
            {
                "from_entity": BOB_ID,
                "type": "USES",
                "to_entity": tool,
                "properties": {"since": 2020},
                "event_time": "2024-02-01T00:00:00+00:00",
            },
            {"from_entity": ADA, "type": "KNOWS", "to_entity": BOB_ID},
        ],
        "preferences": [
            {"subject_entity": BOB_ID, "key": "tool", "value_entity": tool, "strength": 0.5},
            {"subject_entity": ADA, "key": "friend", "value_entity": BOB_ID, "about_entity": BOB_ID},
        ],
        "decisions": [
            {
                "title": "Pick a hammer",
                "actor_entity": BOB_ID,
                "outcome_entity": tool,
                "alternative_entities": [BOB_ID, ADA],
                "steps": [relation_id(BOB_ID, "USES", tool)],
            }
        ],
    }
    res = run(g.insert.facts(facts, source_id="doc-1"))
    assert BOB_ID not in _ids(g)
    assert [(r.from_entity, r.to_entity) for r in res.relations] == [(ROBERT_ID, tool), (ADA, ROBERT_ID)]
    assert res.relations[0].properties == {"since": 2020}
    pref_refs = [(p.subject_entity, p.value_entity, p.about_entity) for p in res.preferences]
    assert pref_refs == [(ROBERT_ID, tool, None), (ADA, ROBERT_ID, ROBERT_ID)]
    assert res.preferences[0].id == preference_id(ROBERT_ID, "preference", "tool", tool)
    [dec] = res.decisions
    assert dec.id == decision_id(ROBERT_ID, "Pick a hammer")
    assert (dec.actor_entity, dec.outcome_entity, dec.alternative_entities) == (ROBERT_ID, tool, [ROBERT_ID, ADA])
    assert [s.relation_id for s in dec.steps] == [relation_id(ROBERT_ID, "USES", tool)]
    [merge] = res.merges
    assert sorted(r.kind for r in merge.rewrites) == ["decision", "preference", "preference", "relation", "relation"]
    assert merge.added_aliases == []
    knows = relation_id(ADA, "KNOWS", ROBERT_ID)
    assert [r.existed for r in merge.rewrites if r.kind == "relation" and r.id == knows] == [True]

    out = run(g.entities.unmerge(merge.id))
    assert (out.entity.id, out.entity.name) == (BOB_ID, "Bob")
    assert out.merge.reverted_at is not None
    assert out.survivor.aliases == ["Bob"]
    assert len(run(g.entities.evidence(BOB_ID)).items) == 1
    uses_back = relation_id(BOB_ID, "USES", tool)
    rel = run(g.relations.get(uses_back))
    assert (rel.properties, rel.event_time) == ({"since": 2020}, utc(2024, 2))
    assert run(g.relations.get(relation_id(ROBERT_ID, "USES", tool))) is None
    assert len(run(g.relations.evidence(uses_back)).items) == 1
    assert run(g.relations.get(knows)) is not None
    assert run(g.relations.get(relation_id(ADA, "KNOWS", BOB_ID))) is not None
    prefs = {p.id: p for p in run(g.preferences.list(limit=100)).items}
    assert preference_id(ROBERT_ID, "preference", "tool", tool) not in prefs
    assert prefs[preference_id(BOB_ID, "preference", "tool", tool)].strength == 0.5
    assert prefs[preference_id(ADA, "preference", "friend", BOB_ID)].about_entity == BOB_ID
    assert run(g.decisions.get(decision_id(ROBERT_ID, "Pick a hammer"))) is None
    dec = run(g.decisions.get(decision_id(BOB_ID, "Pick a hammer")))
    assert (dec.actor_entity, dec.alternative_entities) == (BOB_ID, [BOB_ID, ADA])
    assert [s.relation_id for s in dec.steps] == [uses_back]
    [record] = run(g.entities.merges(ROBERT_ID)).items
    assert record.reverted_at is not None
    with pytest.raises(ValidationError, match=r"already reverted at \d{4}-\d\d-\d\dT[\d:.]+Z$"):
        run(g.entities.unmerge(merge.id))
    with pytest.raises(NotFoundError):
        run(g.entities.unmerge("entitymerge:missing"))


def test_unmerge_restores_a_retired_merge_relation_without_superseding():
    g = fresh_graph("res", resolver="default", schema=WORKS_AT_SPEC, contradiction="supersede")
    acme, globex, initech = (entity_id("Company", n) for n in ("Acme", "Globex", "Initech"))
    _seed(g, ROBERT, *({"type": "Company", "name": n} for n in ("Acme", "Globex", "Initech")))
    run(g.insert.facts({"relations": [works_at("acme", 2020, person="robert")]}))
    res = run(g.insert.facts({"entities": [BOB], "relations": [works_at("globex", 2021, person="bob")]}))
    [merge] = res.merges
    run(g.insert.facts({"relations": [works_at("initech", 2022, person="robert")]}))

    run(g.entities.unmerge(merge.id))
    current = sorted(r.id for r in run(g.relations.list()).items)
    assert current == sorted([relation_id(BOB_ID, "WORKS_AT", globex), relation_id(ROBERT_ID, "WORKS_AT", initech)])
    listed = sorted(r.id for r in run(g.relations.list(include_invalidated=True)).items)
    assert listed == sorted([*current, relation_id(ROBERT_ID, "WORKS_AT", acme)])
    with pytest.raises(NotFoundError):
        run(g.relations.versions(relation_id(ROBERT_ID, "WORKS_AT", globex)))


def test_merge_keeps_survivor_values_and_unmerge_restores_both_exactly():
    g = fresh_graph("res", resolver="default")
    keeper = entity_id("Person", "Keeper")
    _seed(
        g,
        {
            "type": "Person",
            "name": "Keeper",
            "aliases": ["Absorbed"],
            "external_ids": {"hr": "A1"},
            "properties": {"team": "red"},
        },
    )
    before = run(g.entities.get(keeper))
    absorbed = {
        "type": "Person",
        "name": "Absorbed",
        "aliases": ["Abby"],
        "external_ids": {"hr": "B2", "crm": "C3"},
        "properties": {"team": "blue", "level": 2},
    }
    [merge] = run(g.insert.facts({"entities": [absorbed]})).merges
    assert (merge.added_aliases, merge.added_external_ids, merge.added_properties) == (["Abby"], ["crm"], ["level"])
    merged = run(g.entities.get(keeper))
    assert merged.external_ids == {"hr": "A1", "crm": "C3"}
    assert merged.properties == {"team": "red", "level": 2}
    out = run(g.entities.unmerge(merge.id))
    survivor = (out.survivor.aliases, out.survivor.external_ids, out.survivor.properties)
    assert survivor == (before.aliases, before.external_ids, before.properties)
    assert (out.entity.aliases, out.entity.external_ids) == (["Abby"], {"hr": "B2", "crm": "C3"})


def test_reinserting_the_same_merge_is_idempotent_and_counts_every_source():
    g = fresh_graph("res", resolver="default")
    _seed(g, ROBERT, {"type": "Person", "name": "Ada"})
    facts = {
        "entities": [{"type": "Person", "name": "Bob", "aliases": ["Bobby"]}],
        "relations": [{"from_entity": ADA, "type": "KNOWS", "to_entity": BOB_ID}],
    }
    merges = [run(g.insert.facts(facts, source_id=s)).merges[0] for s in ("s1", "s2", "s1")]
    assert len({m.id for m in merges}) == 1
    last = merges[-1]
    assert (last.source_id, last.source_ids, last.added_aliases) == ("s1", ["s1", "s2"], ["Bobby"])
    assert [r.existed for r in last.rewrites] == [False]
    assert len(run(g.entities.merges(ROBERT_ID)).items) == 1
    restored = run(g.entities.unmerge(last.id)).entity
    assert (restored.id, restored.source_count) == (BOB_ID, 2)
    assert run(g.entities.get(ROBERT_ID)).aliases == ["Bob"]


def test_deleting_either_side_drops_merge_records_so_a_later_merge_starts_fresh():
    g = fresh_graph("res", resolver="default")
    _seed(g, ROBERT)
    first = run(g.insert.facts({"entities": [BOB]}, source_id="s1")).merges[0]
    run(g.entities.create("Bob", "Person"))
    run(g.entities.delete(BOB_ID))
    assert run(g.entities.merges(ROBERT_ID)).items == []
    again = run(g.insert.facts({"entities": [BOB]}, source_id="s2")).merges[0]
    assert again.id == first.id and again.source_ids == ["s2"] and again.created_at > first.created_at
    run(g.entities.delete(ROBERT_ID))
    assert run(g.store.match_nodes(g.namespace, "EntityMerge")) == []
    with pytest.raises(NotFoundError):
        run(g.entities.merges(ROBERT_ID))


def test_custom_resolvers_see_compatible_candidates_and_must_return_a_complete_decision():
    seen: dict[str, list[str]] = {}

    class Custom:
        def __init__(self, decide):
            self.decide = decide

        async def resolve(self, candidate, existing):
            seen[candidate.name] = [e.id for e in existing]
            return self.decide(existing)

    g = fresh_graph("res")
    _seed(
        g,
        {"type": "Person", "name": "Ann"},
        {"type": "Person", "name": "Zed"},
        {"type": "Company", "name": "Acme"},
        {"type": "Company", "name": "Ray"},
        {"type": "Thing", "name": "Box"},
    )
    batch = {"entities": [{"type": "Person", "name": "Ray"}, {"type": "Thing", "name": "ann"}]}
    assert run(g.insert.facts(batch, resolver=Custom(lambda existing: ResolutionDecision()))).merges == []
    assert seen == {"Ray": ["person:ann", "person:zed"], "ann": ["person:ann", "thing:box"]}
    for match, decision in (
        ("is missing confidence", ResolutionDecision(target_id="person:ann", reason="x")),
        ("is missing reason", ResolutionDecision(target_id="person:ann", confidence=1.0)),
        (
            "not one of the compatible entities",
            ResolutionDecision(target_id="person:nobody", confidence=1.0, reason="w"),
        ),
    ):
        with pytest.raises(ValidationError, match=match):
            run(g.insert.facts(_people("Cy"), resolver=Custom(lambda existing, d=decision: d)))


def test_llm_resolver_asks_only_inside_the_band():
    yes = FakeLLM({"_SameEntity": _SameEntity(same=True)})
    g = fresh_graph("res", llm=yes, resolver="llm")
    _seed(g, *_people("John Smith", "Alice Wong", "Employee1")["entities"], {"type": "Project", "name": "Project 12"})
    [merge] = run(g.insert.facts(_people("Jon Smyth"))).merges
    assert (merge.survivor_id, merge.reason) == (entity_id("Person", "John Smith"), "llm")
    assert merge.confidence == pytest.approx(name_similarity("Jon Smyth", "John Smith"))
    assert len(yes.calls) == 1
    assert "Jon Smyth" in yes.calls[0][2] and "John Smith" in yes.calls[0][2]
    assert run(g.insert.facts(_people("Zed Quincy"))).merges == []
    numbered = {"entities": [{"type": "Person", "name": "Employee2"}, {"type": "Project", "name": "Project 13"}]}
    assert run(g.insert.facts(numbered)).merges == []
    assert len(yes.calls) == 1

    no = FakeLLM({"_SameEntity": _SameEntity(same=False)})
    g = fresh_graph("res", llm=no, resolver="llm")
    _seed(g, {"type": "Person", "name": "John Smith"})
    assert run(g.insert.facts(_people("Jon Smyth"))).merges == []
    assert len(no.calls) == 1
    stored = [_entity("person:robert", "Person", "Robert", aliases=["Bob"])]
    assert run(LLMResolver(no).resolve(EntityInput(type="Person", name="Bob"), stored)).reason == "alias"
    assert len(no.calls) == 1


def test_id_derivation_merges_and_the_name_never_repeats_as_an_alias():
    g = fresh_graph("res")
    names = [{"type": "Company", "name": n} for n in ("Acme Inc", "Acme Corp", "ACME")]
    names.append({"type": "Company", "name": "Acme", "aliases": ["acme inc", "Acme Inc ", "Acme Corp"]})
    run(g.insert.facts({"entities": names}))
    [acme] = run(g.entities.list()).items
    assert (acme.id, acme.name, acme.aliases) == ("company:acme", "Acme Inc", ["Acme Corp", "ACME", "Acme"])
    updated = run(g.entities.update(acme.id, name="Acme Corp", aliases=["ACME INC"]))
    assert updated.aliases == ["ACME", "Acme", "ACME INC"]
    created = run(g.entities.create("Globex", "Company", aliases=["globex", "Globex Ltd"]))
    assert created.aliases == ["Globex Ltd"]


def test_settings_read_the_resolver_from_the_environment(monkeypatch):
    monkeypatch.setenv("SELFGRAPH_RESOLVER", "default")
    assert settings_from_env().resolver == "default"
    assert settings_from_env(resolver="exact").resolver == "exact"
    monkeypatch.setenv("SELFGRAPH_RESOLVER", "fuzzy")
    assert settings_from_env().resolver == "fuzzy"
    for mode in ("fuzzy", "llm"):
        assert build_parser().parse_args(["--resolver", mode, "version"]).resolver == mode


@pytest.mark.parametrize(
    ("a", "b", "args", "distinct"),
    [
        ("Employee1", "Employee2", (), True),
        ("Project 12", "Project 13", (), True),
        ("Server00", "Server0", (), True),
        ("Model A", "Model B", (), True),
        ("Employee 1", "employee1", (), False),
        ("John F Kennedy", "John Kennedy", (), False),
        ("Katherine Zorkfuzzy", "Katherine Zorkdefault", (), True),
        ("Jon Smithers", "Jonathan Smithers", (), False),
        ("J Smithers", "Jon Smithers", (), False),
        ("New York Times", "The New York Times", (), False),
        ("Jane Dow", "Jane Doe", (), True),
        ("Jane Dow", "Jane Doe", (0.8,), False),
        ("Bobby Tables Jr", "Bobby Tables", (), True),
        ("Bobby Tables Sr.", "Bobby Tables Jr.", (), True),
        ("Henry Ford II", "Henry Ford III", (), True),
        ("Bobby Tables Jr.", "bobby tables jr", (), False),
    ],
)
def test_distinct_names(a, b, args, distinct):
    assert distinct_names(a, b, *args) is distinct


def test_fuzzy_mode_keeps_distinct_names_apart():
    g = fresh_graph("res", resolver="fuzzy")
    _seed(g, *_people("Katherine Zorkdefault", "Jonathan Smithers", "Bobby Tables")["entities"])
    assets = [f"Employee{i}" for i in range(1, 6)] + [f"Server0{i}" for i in range(5)]
    assets += ["Project 12", "Project 13", "Model A", "Model B", "Jonathan Smith", "Jonathon Smith"]
    batch = _people("Katherine Zorkfuzzy", "Jonathon Smithers", "Bobby Tables Jr")
    batch["entities"] += [{"type": "Asset", "name": n} for n in assets]
    res = run(g.insert.facts(batch))
    assert sorted((m.absorbed_id, m.survivor_id) for m in res.merges) == [
        (entity_id("Asset", "Jonathon Smith"), entity_id("Asset", "Jonathan Smith")),
        (entity_id("Person", "Jonathon Smithers"), entity_id("Person", "Jonathan Smithers")),
    ]
    assert len(_ids(g)) == len(assets) + 4
    assert "person:bobby-tables-jr" in [e.id for e in res.entities]


def test_a_thing_merges_into_a_typed_entity_by_name_but_never_the_reverse():
    g = fresh_graph("res", resolver="default")
    things = {"entities": [{"type": "Thing", "name": "Robert Johnson"}, {"type": "Person", "name": "Robert Johnson"}]}
    res = run(g.insert.facts(things))
    assert [(m.absorbed_id, m.survivor_id, m.reason) for m in res.merges] == [
        ("thing:robert-johnson", "person:robert-johnson", "alias")
    ]
    assert _ids(g) == ["person:robert-johnson"]
    things = {"entities": [{"type": "Thing", "name": "robert johnson"}, {"type": "Thing", "name": "Bob J"}]}
    assert [m.survivor_id for m in run(g.insert.facts(things)).merges] == ["person:robert-johnson"]
    assert _ids(g) == ["person:robert-johnson", "thing:bob-j"]
    assert run(g.insert.facts({"entities": [{"type": "Company", "name": "Bob J"}]})).merges == []
    assert _ids(g) == ["company:bob-j", "person:robert-johnson", "thing:bob-j"]


def test_cli_and_mcp_resolver_merges_and_unmerge(capsys, tmp_path):
    g = fresh_graph("res")
    _seed(g, ROBERT)
    path = json_file(tmp_path, "facts.json", {"entities": [BOB]})
    merge_id = cli(g, ["insert", "facts", path, "--resolver", "default"], capsys)["merges"][0]["id"]
    assert [m["id"] for m in cli(g, ["entity", "merges", ROBERT_ID], capsys)["items"]] == [merge_id]
    assert cli(g, ["entity", "unmerge", merge_id], capsys)["entity"]["id"] == BOB_ID

    with mcp_session("resmcp") as srv:
        run(srv.insert_facts({"entities": [ROBERT]}))
        res = run(srv.insert_facts({"entities": [BOB]}, resolver="default"))
        merge_id = res["merges"][0]["id"]
        assert [w["code"] for w in res["warnings"]] == ["entity_merged"]
        assert [m["id"] for m in run(srv.entity_merges(ROBERT_ID))["items"]] == [merge_id]
        assert run(srv.unmerge_entity(merge_id))["entity"]["id"] == BOB_ID


@pytest.mark.parametrize("order", [(0, 1), (1, 0)])
def test_unmerging_chained_merges_in_any_order_restores_the_exact_relations(order):
    g = fresh_graph("res", resolver="fuzzy")
    _seed(g, {"type": "Person", "name": "Jane Doe", "aliases": ["JD"]})
    rel = {"from_entity": JD, "type": "KNOWS", "to_entity": JANE_DOES}
    res = run(g.insert.facts({**_people("JD", "Jane Does"), "relations": [rel]}))
    assert [(m.absorbed_id, m.survivor_id) for m in res.merges] == [(JD, JANE), (JANE_DOES, JANE)]
    assert run(g.relations.list()).items == []
    for merge in run(g.entities.merges(JANE)).items:
        [rw] = merge.rewrites
        assert (rw.kind, rw.dropped, rw.original["from_entity"], rw.original["to_entity"]) == (
            "relation",
            True,
            JD,
            JANE_DOES,
        )
    for i in order:
        out = run(g.entities.unmerge(res.merges[i].id))
        assert out.entity.created_at == res.merges[i].created_at == res.created_at
        assert out.entity.updated_at == res.created_at
    assert [(r.from_entity, r.type, r.to_entity) for r in run(g.relations.list()).items] == [(JD, "KNOWS", JANE_DOES)]
    assert _ids(g) == [JANE, JANE_DOES, JD]
