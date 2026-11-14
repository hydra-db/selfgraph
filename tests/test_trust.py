import json
import logging
from datetime import datetime, timedelta, timezone

import pytest
from helpers import (
    ANN_ACME_GLOBEX,
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
    assert "Hub -[HAS]-> Ada (via hub)" in result.context.splitlines()
    assert "thing:bo" in {e.id for e in result.subgraph.entities}
    skipped = run(g.retrieve("Ada", k=1, depth=2, skip_hubs=True))
    assert {e.id for e in skipped.subgraph.entities} == {"thing:ada", "thing:hub"}
    assert run(g.retrieve("Hub", k=1, depth=1)).context.count("(via hub)") == 0
    with pytest.raises(ValidationError, match="skip_hubs must be a boolean"):
        run(g.retrieve("Ada", skip_hubs="yes"))


def test_certified_relations_survive_supersede_and_lead_retrieval():
    g = employment_graph("cert", contradiction="supersede")
    old = run(g.insert.facts({"relations": [works_at("acme", 2024)]})).relations[0]
    certified = run(g.relations.certify(old.id, by="hr"))
    assert certified.certified_by == "hr" and certified.certified_at is not None
    assert certified.revision == old.revision
    result = run(g.insert.facts({"relations": [works_at("globex", 2025)]}))
    assert [w.code for w in result.warnings] == ["certified_kept"]
    assert run(g.relations.get(old.id)).is_current
    assert "Ann -[WORKS_AT]-> Acme [certified]" in run(g.retrieve("Ann")).context
    assert run(g.relations.uncertify(old.id)).certified_at is None
    run(g.relations.certify(old.id, by="hr"))
    bumped = run(g.relations.update(old.id, set_properties={"role": "cto"}))
    assert bumped.certified_at is None
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


def test_replace_source_keeps_certified_facts_and_needs_a_source_id():
    g = fresh_graph("replace-cert", extractor=LineExtractor())
    rel = run(g.insert.text("ann WORKS_AT acme", source_id="hr")).relations[0]
    run(g.relations.certify(rel.id, by="hr"))
    result = run(g.insert.text("ann KNOWS bob", source_id="hr", replace_source=True))
    assert result.source_diff.retired == [] and [w.code for w in result.warnings] == ["certified_kept"]
    assert run(g.relations.get(rel.id)).is_current
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
