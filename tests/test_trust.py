import json
import logging
from datetime import datetime, timedelta, timezone

import pytest
from helpers import (
    ANN_ACME_GLOBEX,
    KUZU,
    RAW_CYPHER,
    cli,
    employment_graph,
    fresh_graph,
    mcp_session,
    run,
    utc,
    works_at,
)

from selfgraph import (
    Entity,
    EntityInput,
    Extraction,
    NotFoundError,
    Relation,
    RelationInput,
    Schema,
    SelfGraph,
    StoreError,
    ValidationError,
    _maintenance,
)
from selfgraph._export import obsidian_vault
from selfgraph.retrieval import HUB_DEGREE, _ppr_rank, answerability
from selfgraph.runtime import checked_cypher, cypher_names
from selfgraph.stores.cypher import Neo4jStore

T0 = utc(2026)


class LineExtractor:
    async def extract(self, document):
        """Read one "from TYPE to" relation per line, between Thing entities.

        @param document (ParsedDocument): the text.
        @return (Extraction): the entities and relations.
        """
        entities, relations = {}, []
        for line in document.text.splitlines():
            a, rtype, b = line.split()
            for name in (a, b):
                entities[name] = EntityInput(type="Thing", name=name)
            relations.append(RelationInput(from_entity=f"thing:{a}", type=rtype, to_entity=f"thing:{b}"))
        return Extraction(entities=list(entities.values()), relations=relations)


class Judge:
    async def generate(self, *, system, user, output):
        """Judge the first older fact contradicted.

        @param system (str): the system prompt.
        @param user (str): the prompt.
        @param output (type): the verdict model.
        @return (BaseModel): a verdict retiring fact 1.
        """
        return output(retired=[1])


class Embedder:
    async def embed(self, texts):
        """Embed every text as the same vector.

        @param texts (list[str]): the texts.
        @return (list[list[float]]): one vector per text.
        """
        return [[1.0, 0.0] for _ in texts]


def _merged_graph(prefix):
    """Store Thing acme with alias acmecorp, then insert "ann WORKS_AT acmecorp" from source hr, which merges into acme.

    @param prefix (str): the namespace prefix.
    @return (tuple[SelfGraph, InsertResult]): the graph and the merging insert.
    """
    g = fresh_graph(prefix, extractor=LineExtractor())
    run(g.insert.facts({"entities": [{"type": "Thing", "name": "acme", "aliases": ["acmecorp"]}]}))
    return g, run(g.insert.text("ann WORKS_AT acmecorp", source_id="hr", event_time=utc(2024)))


def _entity(eid, name, etype="Thing", **props):
    return Entity(id=eid, type=etype, name=name, properties=props, created_at=T0, updated_at=T0)


def _relation(rid, a, rtype, b):
    return Relation(id=rid, revision=1, from_entity=a, type=rtype, to_entity=b, created_at=T0, is_current=True)


def test_answerability_matches_terms_by_kind_and_judges_connectivity():
    entities = [
        _entity("person:ann-lee", "Ann Lee", "Person"),
        _entity("company:acme", "Acme", "Company", revenue=5),
        _entity("company:globex", "Globex", "Company"),
    ]
    relations = [_relation("r1", "person:ann-lee", "WORKS_AT", "company:acme")]

    def judge(question, terms=None):
        return answerability(question, terms, entities, relations, ["revenue", "diet"], None, 3)

    report = judge("where does Ann Lee work")
    assert [(t.term, t.status, t.matches) for t in report.terms] == [
        ("ann lee", "entity", ["person:ann-lee"]),
        ("work", "relation", ["WORKS_AT"]),
    ]
    assert report.verdict == "answerable" and report.connected
    assert judge("Acme revenue by company").verdict == "answerable"
    partial = judge("Acme churn in Q3")
    assert (partial.verdict, partial.missing) == ("partial", ["churn", "q3"])
    assert judge("tell me about churn").verdict == "not_answerable"
    apart = judge("ignored", ["Ann Lee", "Globex"])
    assert (apart.verdict, apart.connected, apart.hub_only) == ("uncertain", False, [])


def test_check_answerable_matches_explicit_stopword_and_single_char_entity_names_and_aliases():
    schema = Schema.model_validate(
        {
            "entities": [
                {"name": "Vitamin", "definitions": [{"name": "who", "expression": "count(Vitamin)"}]},
                {"name": "Department"},
                {"name": "Language"},
                {"name": "On"},
            ],
            "relations": [{"type": "R"}, {"type": "USES"}],
        }
    )
    g = fresh_graph("explicit-terms", schema=schema)
    run(
        g.insert.facts(
            {
                "entities": [
                    {"type": "Vitamin", "name": "A"},
                    {"type": "Vitamin", "name": "Vitamin B"},
                    {"type": "Department", "name": "Information Technology", "aliases": ["IT"]},
                    {"type": "Language", "name": "C"},
                    {"type": "On", "name": "Switch"},
                ],
                "relations": [
                    {"from_entity": "vitamin:a", "type": "R", "to_entity": "language:c"},
                    {"from_entity": "language:c", "type": "USES", "to_entity": "department:information-technology"},
                ],
            }
        )
    )
    matched = run(g.check_answerable("question", terms=["a", "it", "c"]))
    assert matched.verdict == "answerable" and matched.connected
    assert [(t.term, t.status, t.matches) for t in matched.terms] == [
        ("a", "entity", ["vitamin:a"]),
        ("it", "entity", ["department:information-technology"]),
        ("c", "entity", ["language:c"]),
    ]
    missed = run(g.check_answerable("question", terms=["B", "On", "who", "R"]))
    assert (missed.verdict, missed.missing) == ("not_answerable", ["B", "On", "who", "R"])
    assert run(g.check_answerable("A and it")).verdict == "not_answerable"


def test_answerability_flags_pairs_joined_only_through_a_hub():
    hub = _entity("thing:hub", "Hub")
    leaves = [_relation(f"r{i}", "thing:hub", "HAS", f"thing:leaf{i}") for i in range(HUB_DEGREE)]
    entities = [hub, _entity("thing:leaf0", "Ada"), _entity("thing:leaf1", "Bo")]
    report = answerability("Ada and Bo", None, entities, leaves, [], None, 3)
    assert report.connected and report.hub_only == [["ada", "bo"]] and report.verdict == "uncertain"
    few = answerability("Ada and Bo", None, entities, leaves[:3], [], None, 3)
    assert few.verdict == "answerable" and few.hub_only == []


def test_check_answerable_reads_the_graph_now_and_as_of():
    g = employment_graph("trust")
    run(g.insert.facts({"relations": [works_at("acme", 2024)]}))
    assert run(g.check_answerable("where does Ann work")).verdict == "answerable"
    assert run(g.check_answerable("x", terms=["Ann", "Globex"])).verdict == "uncertain"
    assert run(g.check_answerable("Ann", as_of="2000-01-01")).verdict == "not_answerable"
    for kwargs, message in (
        ({"terms": []}, "terms must be a non-empty list"),
        ({"terms": ["ok", " "]}, "terms must be a non-empty list"),
        ({"depth": 0}, "depth must be >= 1"),
    ):
        with pytest.raises(ValidationError, match=message):
            run(g.check_answerable("Ann", **kwargs))
    with pytest.raises(ValidationError, match="question must be a non-empty string"):
        run(g.check_answerable("  "))


def test_retrieve_lists_hubs_marks_lines_through_them_and_can_skip_them():
    g = fresh_graph("hubs")
    names = ["Ada", "Bo", *(f"Leaf{i}" for i in range(HUB_DEGREE))]
    run(
        g.insert.facts(
            {
                "entities": [{"type": "Thing", "name": n} for n in ["Hub", *names]],
                "relations": [
                    {"from_entity": "thing:hub", "type": "HAS", "to_entity": f"thing:{n.lower()}"} for n in names
                ],
            }
        )
    )
    result = run(g.retrieve("Ada", k=1, depth=2))
    assert result.hubs == ["thing:hub"]
    assert "GRAPH (via hub) | Hub -[HAS]-> Ada" in result.context.splitlines()
    assert "thing:bo" in {e.id for e in result.subgraph.entities}
    skipped = run(g.retrieve("Ada", k=1, depth=2, skip_hubs=True))
    assert {e.id for e in skipped.subgraph.entities} == {"thing:ada", "thing:hub"}
    assert run(g.retrieve("Hub", k=1, depth=1)).context.count("(via hub)") == 0
    with pytest.raises(ValidationError, match="skip_hubs must be a boolean"):
        run(g.retrieve("Ada", skip_hubs="yes"))


def test_certified_relations_survive_supersede_and_lead_retrieval():
    for action in ("uncertify", "update"):
        g = employment_graph("cert", contradiction="supersede")
        old = run(g.insert.facts({"relations": [works_at("acme", 2024)]})).relations[0]
        certified = run(g.relations.certify(old.id, by="hr"))
        assert certified.certified_by == "hr" and certified.certified_at is not None
        assert certified.revision == old.revision
        result = run(g.insert.facts({"relations": [works_at("globex", 2025)]}))
        assert [w.code for w in result.warnings] == ["certified_kept"]
        assert run(g.relations.get(old.id)).is_current
        assert "GRAPH [certified] | Ann -[WORKS_AT]-> Acme" in run(g.retrieve("Ann")).context
        bumped = run(
            g.relations.uncertify(old.id)
            if action == "uncertify"
            else g.relations.update(old.id, set_properties={"role": "cto"})
        )
        assert bumped.certified_by is None
        assert bumped.certified_at is None
        newer = result.relations[0]
        assert (bumped.is_current, bumped.invalidated_by, bumped.invalidated_at) == (False, newer.id, newer.event_time)
        assert [r.id for r in run(g.relations.list(from_entity="person:ann")).items] == [newer.id]
        with pytest.raises(ValidationError, match="certified_by must be a non-empty string"):
            run(g.relations.certify(old.id, by=" "))
        with pytest.raises(NotFoundError):
            run(g.relations.certify("relation:missing", by="hr"))


def test_certify_rejects_a_retired_relation():
    g = employment_graph("cert-retired", contradiction="supersede")
    old = run(g.insert.facts({"relations": [works_at("acme", 2024)]})).relations[0]
    run(g.insert.facts({"relations": [works_at("globex", 2025)]}))
    with pytest.raises(ValidationError, match="only a current relation can be certified"):
        run(g.relations.certify(old.id, by="hr"))


def test_replace_source_retires_what_only_older_versions_stated():
    g = fresh_graph("replace", extractor=LineExtractor())
    first = run(g.insert.text("ann WORKS_AT acme\nann KNOWS bob", source_id="hr", event_time=utc(2024)))
    works, knows = (r.id for r in first.relations)
    other = run(g.insert.text("ann LIKES tea", source_id="chat"))
    run(g.insert.text("ann LIKES tea", source_id="hr", event_time=utc(2024)))
    second = run(
        g.insert.text("ann KNOWS bob\nann READS news", source_id="hr", event_time=utc(2025), replace_source=True)
    )
    reads = second.relations[1].id
    likes = other.relations[0].id
    assert second.source_diff.model_dump() == {"kept": [knows], "added": [reads], "retired": [works]}
    assert [w.code for w in second.warnings] == ["fact_retired_by_source"]
    retired = run(g.relations.versions(works))[0]
    assert (retired.is_current, retired.invalidated_at, retired.invalidated_by) == (
        False,
        utc(2025),
        second.source_version,
    )
    assert run(g.relations.get(likes)).is_current
    now = run(g.retrieve("ann acme"))
    assert "WORKS_AT" not in now.context and "ann WORKS_AT acme" not in now.context
    then = run(g.retrieve("ann acme", as_of=utc(2024, 6)))
    assert "ann -[WORKS_AT]-> acme" in then.context and "ann WORKS_AT acme" in then.context
    again = run(g.insert.text("ann KNOWS bob\nann READS news", source_id="hr", replace_source=True))
    assert again.source_diff.retired == [] and again.source_diff.kept == sorted([knows, reads])
    readded = run(
        g.insert.text("ann WORKS_AT acme\nann KNOWS bob", source_id="hr", event_time=utc(2026), replace_source=True)
    )
    assert readded.source_diff.model_dump() == {"kept": [knows], "added": [works], "retired": [reads]}
    manual = run(
        g.relations.create("thing:ann", "READS", "thing:news", evidence=[{"source_id": "hr", "quote": "hand"}])
    )
    with_manual = run(
        g.insert.text(
            "ann WORKS_AT acme\nann KNOWS bob\nann READS news",
            source_id="hr",
            event_time=utc(2027),
            replace_source=True,
        )
    )
    assert with_manual.source_diff.model_dump() == {
        "kept": sorted([knows, manual.id, works]),
        "added": [],
        "retired": [],
    }


@pytest.mark.parametrize("replay_time", [None, utc(2024)])
def test_replace_source_takes_effect_when_the_stored_version_did(replay_time):
    g = fresh_graph("replace-stored", extractor=LineExtractor())
    run(g.insert.text("ann WORKS_AT acme", source_id="hr", event_time=utc(2020)))
    stored = run(g.insert.text("ann WORKS_AT globex", source_id="hr", event_time=utc(2022)))
    again = run(g.insert.text("ann WORKS_AT globex", source_id="hr", replace_source=True, event_time=replay_time))
    assert again.source_version == stored.source_version
    [works] = again.source_diff.retired
    assert run(g.relations.versions(works))[0].invalidated_at == utc(2022)
    old = ["SOURCE | ann WORKS_AT acme", "GRAPH | ann -[WORKS_AT]-> acme"]
    before = run(g.retrieve("ann acme globex", as_of=utc(2021))).context.splitlines()
    after = run(g.retrieve("ann acme globex", as_of=utc(2023))).context.splitlines()
    assert [line in before for line in old] == [True, True]
    assert [line in after for line in old] == [False, False]


def test_replace_source_keeps_manual_evidence_from_the_same_source():
    g = fresh_graph("replace-manual", extractor=LineExtractor())
    run(g.insert.facts({"entities": [{"type": "Thing", "name": name} for name in ("ann", "acme")]}))
    rel = run(g.relations.create("thing:ann", "WORKS_AT", "thing:acme", evidence=[{"source_id": "hr"}]))
    result = run(g.insert.text("ann KNOWS bob", source_id="hr", replace_source=True))
    assert result.source_diff.retired == [] and result.warnings == []
    assert run(g.relations.get(rel.id)).is_current
    assert "ann -[WORKS_AT]-> acme" in run(g.retrieve("ann acme")).context


def test_replace_source_keeps_added_manual_support_without_quoting_replaced_text():
    g = fresh_graph("replace-manual-mixed", extractor=LineExtractor())
    first = run(g.insert.text("ann WORKS_AT acme", source_id="hr", event_time=utc(2024)))
    rel = first.relations[0]
    run(g.relations.update(rel.id, evidence=[{"source_id": "hr"}]))
    result = run(g.insert.text("ann KNOWS bob", source_id="hr", event_time=utc(2025), replace_source=True))
    assert result.source_diff.retired == [] and result.warnings == []
    assert run(g.relations.get(rel.id)).is_current
    now = run(g.retrieve("ann acme"))
    assert "ann -[WORKS_AT]-> acme" in now.context and "ann WORKS_AT acme" not in now.context
    assert "ann WORKS_AT acme" in run(g.retrieve("ann acme", as_of=utc(2024, 6))).context


def test_replace_source_keeps_certified_facts_and_needs_a_source_id():
    g = fresh_graph("replace-cert", extractor=LineExtractor())
    rel = run(g.insert.text("ann WORKS_AT acme", source_id="hr")).relations[0]
    run(g.relations.certify(rel.id, by="hr"))
    result = run(g.insert.text("ann KNOWS bob", source_id="hr", replace_source=True))
    assert result.source_diff.retired == [] and [w.code for w in result.warnings] == ["certified_kept"]
    assert run(g.relations.get(rel.id)).is_current
    later = run(g.insert.text("ann KNOWS bob\nann READS news", source_id="hr", replace_source=True))
    assert [w.code for w in later.warnings] == []
    assert run(g.insert.text("ann KNOWS bob", source_id="hr")).source_diff is None
    with pytest.raises(ValidationError, match="replace_source needs a source_id"):
        run(g.insert.text("ann KNOWS bob", replace_source=True))
    with pytest.raises(ValidationError, match="replace_source must be a boolean"):
        run(g.insert.text("ann KNOWS bob", source_id="hr", replace_source="yes"))


def test_readiness_counts_and_lints_the_namespace():
    schema = {"entities": [{"name": "Thing"}], "relations": [{"type": "KNOWS"}]}
    g = fresh_graph("ready", extractor=LineExtractor(), schema=schema)
    empty = run(g.readiness())
    assert (empty.ready, empty.reachable, empty.has_schema, empty.lint) == (False, True, True, [])
    assert empty.counts == {"entities": 0, "relations": 0, "preferences": 0, "decisions": 0, "sources": 0}
    first = run(g.insert.text("ann KNOWS bob", source_id="hr"))
    run(g.insert.facts({"entities": [{"type": "Gadget", "name": "Lamp"}, {"type": "Thing", "name": "Cy"}]}))
    loose = run(g.relations.create("thing:ann", "LIKES", "thing:cy"))
    run(g.decisions.create("Pick", steps=[first.relations[0].id]))
    run(g.insert.text("ann LIKES cy", source_id="hr", replace_source=True))
    report = run(g.readiness())
    assert report.ready and report.store == type(g.store).__name__ and report.namespace == g.namespace
    assert report.counts == {"entities": 4, "relations": 1, "preferences": 0, "decisions": 1, "sources": 1}
    assert {i.code: (i.count, i.sample) for i in report.lint} == {
        "orphan_entity": (1, ["gadget:lamp"]),
        "stale_decision_step": (1, [run(g.decisions.list()).items[0].id]),
        "type_off_schema": (2, sorted(["gadget:lamp", loose.id])),
    }
    run(g.relations.create("thing:bob", "KNOWS", "thing:cy"))
    assert "unsupported_fact" in {i.code for i in run(g.readiness()).lint}


def test_readiness_reports_an_unreachable_store():
    g = SelfGraph(Neo4jStore("bolt://127.0.0.1:1", auth=("neo4j", "x")))
    report = run(g.readiness())
    assert (report.ready, report.reachable, report.store) == (False, False, "Neo4jStore")
    assert "127.0.0.1:1" in report.error
    run(g.close())


def test_ossie_export_maps_types_properties_and_relations():
    schema = Schema.model_validate(
        {
            "name": "hr",
            "entities": [
                {"name": "Person", "description": "a human", "properties": [{"name": "age", "type": "integer"}]},
                {"name": "Employee", "parent": "Person"},
                {"name": "Company"},
            ],
            "relations": [
                {"type": "works at", "from": {"types": ["Person"], "max_count": 1}, "to": {"types": ["Company"]}},
                {"type": "KNOWS", "from": {"types": ["Person"]}, "to": {"types": ["Person", "Company"]}},
                {"type": "MENTIONS", "to": {"types": ["Company"]}},
            ],
        }
    )
    doc = schema.to_ossie()
    assert (doc["version"], doc["name"]) == ("0.3.0.dev0", "hr")
    person, employee, company = doc["ontology"]
    assert employee == {"concept": "Employee", "type": "EntityType", "extends": ["Person"]}
    assert company == {"concept": "Company", "type": "EntityType"}
    assert person["description"] == "a human"
    assert [r["name"] for r in person["relationships"]] == ["age", "WORKS_AT", "KNOWS_Person", "KNOWS_Company"]
    age, works, knows_person, _ = person["relationships"]
    assert age["roles"] == [{"concept": "Integer"}] and age["verbalizes"] == ["{Person} has age {Integer}"]
    assert works["multiplicity"] == "ManyToOne" and works["verbalizes"] == ["{Person} works at {Company}"]
    assert knows_person["roles"] == [{"concept": "Person", "name": "other"}]
    assert knows_person["verbalizes"] == ["{Person} knows {Person:other}"]
    with pytest.raises(ValidationError, match="needs at least one concept"):
        Schema.model_validate({"relations": [{"type": "KNOWS"}]}).to_ossie()


def test_obsidian_vault_cuts_long_names_without_splitting_a_character():
    names = ["B" * 300, "\u00e9" * 150, "B" * 199 + "\u00e9" + "B" * 50, "x" * 150 + " " + "y" * 150]
    g = fresh_graph("vault_long")
    run(g.insert.facts({"entities": [{"type": "Thing", "name": name} for name in names]}))
    vault = run(g.export_obsidian())
    notes = sorted(path for path in vault if "/" not in path)
    assert len(notes) == 4
    for path in notes:
        assert len(path.encode("utf-8")) <= 255
        assert "\ufffd" not in path
    assert "B" * 199 + ".md" in notes
    assert "\u00e9" * 100 + ".md" in notes


def test_obsidian_vault_strips_leading_and_trailing_dots():
    names = [". .NET", "Acme. .", "v1. ."]
    g = fresh_graph("vault_dots")
    run(g.insert.facts({"entities": [{"type": "Product", "name": name} for name in names]}))
    notes = sorted(path for path in run(g.export_obsidian()) if "/" not in path)
    assert notes == ["Acme.md", "NET.md", "v1.md"]


def test_obsidian_vault_numbers_names_that_collide_after_the_cut():
    g = fresh_graph("vault_clash")
    prefix = "z" * 300
    run(g.insert.facts({"entities": [{"type": "Thing", "name": prefix + suffix} for suffix in ("a", "b", "c")]}))
    notes = [path for path in run(g.export_obsidian()) if "/" not in path]
    assert len(set(notes)) == 3
    assert all(len(path.encode("utf-8")) <= 255 for path in notes)


def test_obsidian_vault_writes_a_note_per_entity_and_decision():
    g = fresh_graph("vault")
    run(
        g.insert.facts(
            {
                "entities": [
                    {"type": "Person", "name": "Ann", "aliases": ["Annie"], "properties": {"age": 30}},
                    {"type": "Company", "name": "Acme"},
                    {"type": "Product", "name": "Acme"},
                    {"type": "Thing", "name": "A/B: test?"},
                ],
                "relations": [
                    {"id": "relation:w", "from_entity": "person:ann", "type": "WORKS_AT", "to_entity": "company:acme"}
                ],
                "preferences": [{"subject_entity": "person:ann", "key": "tool", "value_entity": "product:acme"}],
                "decisions": [{"title": "Join", "steps": ["relation:w"], "actor_entity": "person:ann"}],
            }
        )
    )
    vault = run(g.export_obsidian())
    assert sorted(vault) == ["A-B- test-.md", "Acme (Product).md", "Acme.md", "Ann.md", "decisions/Join.md"]
    assert vault["Ann.md"] == (
        '---\nid: "person:ann"\ntype: "Person"\naliases: ["Annie"]\n---\n# Ann\n\n## Properties\n- age: 30\n\n'
        "## Links\n- WORKS_AT [[Acme]]\n- prefers [[Acme (Product)]] for tool\n\n## Decisions\n- [[decisions/Join]]\n"
    )
    assert vault["decisions/Join.md"].endswith(
        "# Join\n\n- Actor: [[Ann]]\n\n## Steps\n1. [[Ann]] to [[Acme]] (relation:w)\n"
    )
    assert obsidian_vault([], [], [], []) == {}


def test_cypher_names_reads_labels_types_and_name_literals():
    query = "MATCH (n:Person:`Big Co` {name: 'Ann'})-[r:WORKS_AT|:KNOWS]->(c) WHERE c.name = \"acme\" RETURN n"
    assert cypher_names(query) == (["Person", "Big Co"], ["WORKS_AT", "KNOWS"], ["Ann", "acme"])
    assert cypher_names("MATCH (n {ns: $ns}) RETURN [x IN [1] | x]") == ([], [], [])


def test_checked_cypher_explains_an_empty_or_failed_query():
    g = employment_graph("notes")
    run(g.insert.facts({"relations": [works_at("acme")]}))
    query = "MATCH (p:Persn {name: 'ann'})-[:WORKZ_AT]->(c) RETURN p"
    try:
        notes = run(checked_cypher(g, query, None)).warnings
    except StoreError as exc:
        notes = [str(exc)]
    text = " ".join(notes)
    assert "label 'Persn' is not stored" in text and "stored: Company, Person" in text
    assert "relationship type 'WORKZ_AT' is not stored" in text
    assert "is named 'ann', but one is named 'Ann'" in text
    if RAW_CYPHER:
        found = run(checked_cypher(g, "MATCH (p:Person) RETURN p.name AS name", None))
        assert found.rows and found.warnings == []


def test_cli_surfaces(tmp_path, capsys):
    g = employment_graph("cli-trust", extractor=LineExtractor())
    rel = run(g.insert.facts({"relations": [works_at("acme")]})).relations[0]
    assert cli(g, ["readiness"], capsys)["counts"]["relations"] == 1
    report = cli(g, ["check-answerable", "where", "does", "Ann", "work"], capsys)
    assert report["verdict"] == "answerable"
    assert cli(g, ["check-answerable", "x", "--term", "Ann", "--term", "churn"], capsys)["missing"] == ["churn"]
    assert cli(g, ["relation", "certify", rel.id, "--by", "hr"], capsys)["certified_by"] == "hr"
    assert cli(g, ["relation", "uncertify", rel.id], capsys)["certified_by"] is None
    assert cli(g, ["schema", "export", "--to", "ossie"], capsys)["ontology"][0]["concept"] == "Person"
    assert cli(g, ["retrieve", "Ann", "--skip-hubs"], capsys)["hubs"] == []
    inserted = cli(g, ["insert", "text", "ann KNOWS bob", "--source-id", "s", "--replace-source"], capsys)
    assert inserted["source_diff"]["added"]
    written = cli(g, ["export", "obsidian", str(tmp_path / "vault")], capsys)
    assert written["notes"] == 4 and (tmp_path / "vault" / "Ann.md").read_text().startswith("---\n")


def test_mcp_surfaces():
    pytest.importorskip("mcp")
    with mcp_session("trust") as srv:
        server = srv.build_server()
        assert "check_answerable" in server.instructions
        run(srv.insert_facts({"entities": [{"type": "Person", "name": "Ann"}]}))
        assert run(srv.check_readiness())["ready"] is True
        assert run(srv.check_answerable("Ann churn", terms=None))["verdict"] == "partial"
        assert run(srv.retrieve("Ann", skip_hubs=True))["hubs"] == []
        if RAW_CYPHER:
            result = run(srv.run_cypher("MATCH (n:Persn) RETURN n"))
            assert result["rows"] == [] and "label 'Persn' is not stored" in json.dumps(result["warnings"])


def test_llm_contradiction_keeps_a_certified_rival():
    g = fresh_graph("cert-llm", llm=Judge(), extraction="regex", contradiction="llm")
    acme = run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]})).relations[0]
    run(g.relations.certify(acme.id, by="hr"))
    res = run(g.insert.facts({"relations": [works_at("globex", 2022)]}))
    assert [w.code for w in res.warnings] == ["certified_kept"]
    assert run(g.relations.get(acme.id)).is_current


def test_a_delete_leaves_what_the_llm_judge_retired_retired():
    g = fresh_graph("llm-delete", llm=Judge(), extraction="regex", contradiction="llm")
    acme = run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]})).relations[0]
    globex = run(g.insert.facts({"relations": [works_at("globex", 2022)]})).relations[0]
    assert run(g.relations.versions(acme.id))[0].invalidated_by == globex.id
    assert run(g.relations.delete(globex.id)).restored_relations == 0
    assert not run(g.relations.versions(acme.id))[0].is_current


def test_a_write_that_changes_a_certified_relation_warns_it_dropped_the_mark():
    g = employment_graph("cert-drop")
    rel = run(g.insert.facts({"relations": [works_at("acme", 2024)]})).relations[0]
    run(g.relations.certify(rel.id, by="hr"))
    same = run(g.insert.facts({"relations": [works_at("acme", 2024)]}))
    assert same.warnings == [] and run(g.relations.get(rel.id)).certified_by == "hr"
    changed = run(g.insert.facts({"relations": [works_at("acme", 2024, properties={"role": "cto"})]}))
    assert [w.code for w in changed.warnings] == ["certified_dropped"]
    assert run(g.relations.get(rel.id)).certified_at is None


def test_replace_source_ignores_support_from_a_replaced_version_of_another_source():
    g = fresh_graph("replace-two", extractor=LineExtractor())
    rid = run(g.insert.text("ann WORKS_AT acme", source_id="hr", event_time=utc(2024))).relations[0].id
    run(g.insert.text("ann WORKS_AT acme", source_id="wiki", event_time=utc(2024)))
    first = run(g.insert.text("ann KNOWS bob", source_id="hr", event_time=utc(2025), replace_source=True))
    assert first.source_diff.retired == [] and run(g.relations.get(rid)).is_current
    second = run(g.insert.text("ann KNOWS bob", source_id="wiki", event_time=utc(2025), replace_source=True))
    assert second.source_diff.retired == [rid]
    assert not run(g.relations.versions(rid))[0].is_current


def test_dedupe_leaves_a_group_with_a_certified_relation_alone():
    g = fresh_graph("cert-dedupe")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    for rid in ("relation:a", "relation:b"):
        run(g.relations.create("person:ann", "WORKS_AT", "company:acme", id=rid))
    run(g.relations.certify("relation:b", by="hr"))
    plan = run(g.maintenance.dedupe_relations(dry_run=False))
    assert plan.groups == [] and [(c.survivor, c.duplicates) for c in plan.certified] == [
        ("relation:a", ["relation:b"])
    ]
    assert {r.id for r in run(g.relations.list()).items} == {"relation:a", "relation:b"}


def test_unmerge_refuses_a_certified_move_and_keeps_a_source_retirement():
    g, merged = _merged_graph("unmerge-cert")
    [merge] = merged.merges
    rid = merged.relations[0].id
    run(g.relations.certify(rid, by="hr"))
    with pytest.raises(ValidationError, match=f"relation {rid} is certified"):
        run(g.entities.unmerge(merge.id))
    run(g.relations.uncertify(rid))
    gone = run(g.insert.text("ann KNOWS bob", source_id="hr", event_time=utc(2025), replace_source=True))
    assert gone.source_diff.retired == [rid]
    [back] = run(g.entities.unmerge(merge.id)).relations
    assert (back.from_entity, back.to_entity, back.is_current) == ("thing:ann", "thing:acmecorp", False)
    assert (back.invalidated_by, back.invalidated_at) == (gone.source_version, utc(2025))


def test_prune_keeps_certified_facts_and_lists_the_merges_it_would_lose():
    g, merged = _merged_graph("prune-cert")
    rid = merged.relations[0].id
    run(g.relations.certify(rid, by="hr"))
    soon = datetime.now(timezone.utc) + timedelta(seconds=30)
    kept = run(g.maintenance.prune(older_than=soon))
    assert (kept.entity_ids, kept.relation_ids, kept.certified, kept.merge_ids) == ([], [], [rid], [])
    every = run(g.maintenance.prune(older_than=soon, include_certified=True))
    assert every.entity_ids == ["thing:acme", "thing:ann"] and every.relation_ids == [rid]
    assert (every.certified, every.merge_ids) == ([], [merged.merges[0].id])


def _after_scan(monkeypatch, name, write):
    """Run a write right after a maintenance scan reads the graph, as a concurrent client would.

    @param monkeypatch (pytest.MonkeyPatch): the fixture that swaps the scan.
    @param name (str): the _maintenance scan to wrap, such as "scan_entities".
    @param write (Callable[[], Awaitable[Any]]): the write to run once the scan has read.
    @return (None): nothing.
    """
    scan = getattr(_maintenance, name)

    async def wrapped(runner, ns):
        out = await scan(runner, ns)
        monkeypatch.setattr(_maintenance, name, scan)
        await write()
        return out

    monkeypatch.setattr(_maintenance, name, wrapped)


def test_prune_keeps_a_fact_certified_after_its_scan(monkeypatch):
    g = fresh_graph("prune-race-cert")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    rid = run(g.relations.create("person:ann", "WORKS_AT", "company:acme")).id
    _after_scan(monkeypatch, "scan_entities", lambda: g.relations.certify(rid, by="hr"))
    done = run(g.maintenance.prune(older_than=datetime.now(timezone.utc) + timedelta(seconds=30), dry_run=False))
    assert (done.entity_ids, done.relation_ids, done.certified) == (["company:globex"], [], [rid])
    assert run(g.relations.get(rid)).certified_by == "hr"


def test_prune_lists_a_relation_created_after_its_scan(monkeypatch):
    g = fresh_graph("prune-race-new")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    late = []

    async def relate():
        late.append((await g.relations.create("person:ann", "KNOWS", "company:globex")).id)

    _after_scan(monkeypatch, "scan_entities", relate)
    done = run(g.maintenance.prune(older_than=datetime.now(timezone.utc) + timedelta(seconds=30), dry_run=False))
    assert done.entity_ids == ["company:acme", "company:globex", "person:ann"] and done.relation_ids == late
    assert done.deleted.deleted_relation_versions == 1 and run(g.relations.list()).items == []


def test_dedupe_leaves_a_group_certified_after_its_scan_alone(monkeypatch):
    g = fresh_graph("dedupe-race-cert")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    for rid in ("relation:a", "relation:b"):
        run(g.relations.create("person:ann", "WORKS_AT", "company:acme", id=rid))
    _after_scan(monkeypatch, "scan_relations", lambda: g.relations.certify("relation:b", by="hr"))
    done = run(g.maintenance.dedupe_relations(dry_run=False))
    assert done.groups == [] and [(c.survivor, c.duplicates) for c in done.certified] == [
        ("relation:a", ["relation:b"])
    ]
    assert done.note is None and done.deleted.deleted_relation_versions == 0
    assert {r.id for r in run(g.relations.list()).items} == {"relation:a", "relation:b"}


@pytest.mark.parametrize("moved", ["relation:a", "relation:b"])
def test_dedupe_skips_a_relation_recreated_between_other_entities_after_its_scan(monkeypatch, moved):
    g = fresh_graph("dedupe-race-ends")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    for rid in ("relation:a", "relation:b"):
        run(g.relations.create("person:ann", "WORKS_AT", "company:acme", id=rid))

    async def recreate():
        await g.relations.delete(moved)
        await g.relations.create("person:ann", "WORKS_AT", "company:globex", id=moved, properties={"role": "cfo"})

    _after_scan(monkeypatch, "scan_relations", recreate)
    done = run(g.maintenance.dedupe_relations(dry_run=False))
    assert done.groups == [] and done.certified == [] and done.deleted.deleted_relation_versions == 0
    stored = {r.id: (r.to_entity, r.properties) for r in run(g.relations.list()).items}
    assert stored == {
        "relation:a": ("company:globex", {"role": "cfo"}) if moved == "relation:a" else ("company:acme", {}),
        "relation:b": ("company:globex", {"role": "cfo"}) if moved == "relation:b" else ("company:acme", {}),
    }


def _before_apply(monkeypatch, g, write):
    """Run a write after a maintenance plan is made, right before its first apply transaction.

    @param monkeypatch (pytest.MonkeyPatch): the fixture that swaps the graph's write.
    @param g (SelfGraph): the graph.
    @param write (Callable[[], Awaitable[Any]]): the write to run between plan and apply.
    @return (None): nothing.
    """
    apply = g._write

    async def wrapped(*args, **kwargs):
        monkeypatch.setattr(g, "_write", apply)
        await write()
        return await apply(*args, **kwargs)

    monkeypatch.setattr(g, "_write", wrapped)


def test_prune_lists_a_merge_made_after_its_plan(monkeypatch):
    g = fresh_graph("prune-race-merge")
    run(g.insert.facts({"entities": [{"type": "Thing", "name": "acme", "aliases": ["acmecorp"]}]}))
    made = []

    async def merge():
        made.extend((await g.insert.facts({"entities": [{"type": "Thing", "name": "acmecorp"}]})).merges)

    _before_apply(monkeypatch, g, merge)
    done = run(g.maintenance.prune(older_than=datetime.now(timezone.utc) + timedelta(seconds=30), dry_run=False))
    assert len(made) == 1 and (done.entity_ids, done.merge_ids) == (["thing:acme"], [made[0].id])
    assert run(g.store.match_nodes(g.namespace, "EntityMerge")) == []


@pytest.mark.parametrize("change", ["revision", "conflict"])
def test_dedupe_reports_what_it_merged_after_a_duplicate_changes_since_its_plan(monkeypatch, change):
    g = fresh_graph("dedupe-race-applied")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", id="relation:a", properties={"role": "cto"}))
    run(g.relations.create("person:ann", "WORKS_AT", "company:acme", id="relation:b"))
    props = {"since": 2020} if change == "revision" else {"role": "cfo"}
    _before_apply(monkeypatch, g, lambda: g.relations.update("relation:b", set_properties=props))
    done = run(g.maintenance.dedupe_relations(dry_run=False))
    [group] = done.groups
    assert group.versions_lost == {"relation:b": 2} and done.deleted.deleted_relation_versions == 2
    assert group.conflicts == ({} if change == "revision" else {"relation:b": ["role"]})
    assert run(g.relations.get("relation:a")).properties == {
        "role": "cto",
        **({"since": 2020} if change == "revision" else {}),
    }


def test_dedupe_reports_only_the_duplicates_it_folded(monkeypatch):
    g = fresh_graph("dedupe-race-narrow")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX}))
    for rid in ("relation:a", "relation:b", "relation:c"):
        run(g.relations.create("person:ann", "WORKS_AT", "company:acme", id=rid))

    async def recreate():
        await g.relations.delete("relation:c")
        await g.relations.create("person:ann", "WORKS_AT", "company:globex", id="relation:c")

    _after_scan(monkeypatch, "scan_relations", recreate)
    done = run(g.maintenance.dedupe_relations(dry_run=False))
    assert [(grp.survivor, grp.duplicates, list(grp.versions_lost)) for grp in done.groups] == [
        ("relation:a", ["relation:b"], ["relation:b"])
    ]
    assert {r.id: r.to_entity for r in run(g.relations.list()).items} == {
        "relation:a": "company:acme",
        "relation:c": "company:globex",
    }


def test_lint_keeps_a_merge_survivor_off_the_orphan_list():
    g = fresh_graph("lint-merge")
    run(g.insert.facts({"entities": [{"type": "Thing", "name": "acme", "aliases": ["acmecorp"]}]}))
    assert run(g.insert.facts({"entities": [{"type": "Thing", "name": "acmecorp"}]})).merges
    assert "orphan_entity" not in {i.code for i in run(g.readiness()).lint}


def test_check_answerable_needs_stored_instances_of_a_schema_term():
    schema = Schema.model_validate(
        {
            "entities": [
                {"name": "Person"},
                {"name": "Company", "synonyms": ["firm"], "definitions": [{"name": "headcount", "expression": "n"}]},
                {"name": "Startup", "parent": "Company"},
            ],
        }
    )
    ann = _entity("person:ann", "Ann", "Person")
    bare = answerability("firm headcount", None, [ann], [], [], schema, 3)
    assert [(t.term, t.status, t.matches) for t in bare.terms] == [
        ("firm", "schema_only", ["Company"]),
        ("headcount", "schema_only", ["headcount"]),
    ]
    assert (bare.verdict, bare.missing) == ("not_answerable", ["firm", "headcount"])
    held = answerability("firm headcount", None, [ann, _entity("startup:zap", "Zap", "Startup")], [], [], schema, 3)
    assert [(t.status, t.matches) for t in held.terms] == [("type", ["Company"]), ("definition", ["headcount"])]
    g = fresh_graph("lexical", seeds="embeddings", embedder=Embedder())
    assert "lexical" in run(g.check_answerable("zebra")).note
    assert run(fresh_graph("lexical").check_answerable("zebra")).note is None


def test_ppr_passes_no_mass_through_a_blocked_hub():
    seed = _entity("thing:a", "A")
    rels = [_relation("relation:ah", "thing:a", "R", "thing:h"), _relation("relation:hb", "thing:h", "R", "thing:b")]
    nodes = ["thing:a", "thing:h", "thing:b", "thing:0"]
    open_walk = _ppr_rank([(seed, 1.0)], nodes, rels)
    assert open_walk["thing:b"] < open_walk["thing:0"]
    blocked = _ppr_rank([(seed, 1.0)], nodes, rels, {"thing:h"})
    assert blocked["thing:0"] < blocked["thing:b"] and blocked["thing:h"] == 1


def test_ppr_ranks_equal_mass_by_id_whatever_the_string_hashing():
    half = [("s", "{}b"), ("{}b", "{}x1"), ("{}b", "{}x2"), ("{}x1", "{}x2"), ("{}x2", "{}x3"), ("{}x1", "{}x3")]
    pairs = [(a.format(p), b.format(p)) for p in "lr" for a, b in [*half, ("s", "{}x3")]]
    walk = ["s", "lb", "lx3", "rb", "rx3", "lx1", "lx2", "rx1", "rx2"]
    rels = [_relation(f"relation:{a}{b}", f"thing:{a}", "R", f"thing:{b}") for a, b in pairs]
    ranks = _ppr_rank([(_entity("thing:s", "S"), 1.0)], [f"thing:{n}" for n in walk], rels)
    assert sorted(ranks, key=ranks.get) == [f"thing:{n}" for n in walk]


def test_ossie_export_leaves_out_and_logs_a_one_to_many_multiplicity(caplog):
    schema = Schema.model_validate(
        {
            "entities": [{"name": "Person"}, {"name": "Team"}],
            "relations": [{"type": "LEADS", "from": {"types": ["Person"]}, "to": {"types": ["Team"], "max_count": 1}}],
        }
    )
    with caplog.at_level(logging.WARNING, logger="selfgraph"):
        doc = schema.to_ossie()
    assert "multiplicity" not in doc["ontology"][0]["relationships"][0]
    assert [r.getMessage() for r in caplog.records] == [
        "ossie export: the OneToMany multiplicity of relation LEADS are left out"
    ]


def test_ossie_export_logs_every_field_it_leaves_out(caplog):
    schema = Schema.model_validate(
        {
            "entities": [{"name": "Company", "aliases": ["Co"], "certified": True}],
            "relations": [{"type": "OWNS", "from": {"types": ["Company"], "min_count": 1}, "synonyms": ["holds"]}],
        }
    )
    with caplog.at_level(logging.WARNING, logger="selfgraph"):
        schema.to_ossie()
    assert [r.getMessage() for r in caplog.records] == [
        "ossie export: the aliases, certified flag of entity type Company are left out",
        "ossie export: the synonyms, min counts of relation OWNS are left out",
    ]


@pytest.mark.parametrize("mode", ["supersede", "warn"])
@pytest.mark.parametrize("side", ["from", "to"])
def test_uncertifying_settles_certification_surplus(mode, side, caplog):
    schema = {
        "entities": [{"name": "Person"}, {"name": "Company"}],
        "relations": [{"type": "WORKS_AT", side: {"max_count": 1}}],
    }
    g = fresh_graph("uncertify-surplus", schema=schema, schema_mode="strict", contradiction=mode)
    run(g.insert.facts({"entities": [*ANN_ACME_GLOBEX, {"type": "Person", "name": "Bob"}]}))
    old = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2020-01-01"))
    run(g.relations.certify(old.id, by="alice"))
    new = run(
        g.relations.create(
            "person:ann" if side == "from" else "person:bob",
            "WORKS_AT",
            "company:globex" if side == "from" else "company:acme",
            event_time="2023-01-01",
            contradiction="supersede",
        )
    )
    replay = run(
        g.insert.facts(
            {
                "relations": [
                    {
                        "from_entity": new.from_entity,
                        "type": new.type,
                        "to_entity": new.to_entity,
                        "event_time": new.event_time,
                    }
                ]
            }
        )
    )
    assert replay.relations[0].revision == new.revision
    caplog.clear()
    result = run(g.relations.uncertify(old.id))
    assert result.certified_by is None
    if mode == "supersede":
        assert not result.is_current and result.invalidated_by == new.id
        assert [r.id for r in run(g.relations.list()).items] == [new.id]
    else:
        assert len(run(g.relations.list()).items) == 2
    if mode == "warn":
        assert "schema warning [contradiction]" in caplog.text


@pytest.mark.skipif(not KUZU, reason="Kuzu auto-commit settlement recovery")
def test_uncertify_retry_finishes_failed_settlement(monkeypatch):
    g = employment_graph("uncertify-retry", contradiction="supersede")
    old = run(g.relations.create("person:ann", "WORKS_AT", "company:acme", event_time="2020-01-01"))
    run(g.relations.certify(old.id, by="hr"))
    newer = run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2023-01-01"))
    original = g.store.create_edges
    calls = 0

    async def fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise StoreError("retirement write failed")
        return await original(*args, **kwargs)

    monkeypatch.setattr(g.store, "create_edges", fail_once)
    with pytest.raises(StoreError, match="retirement write failed"):
        run(g.relations.uncertify(old.id))
    result = run(g.relations.uncertify(old.id))
    assert result.certified_by is None
    assert (result.is_current, result.invalidated_by) == (False, newer.id)
    assert [rel.id for rel in run(g.relations.list()).items] == [newer.id]
