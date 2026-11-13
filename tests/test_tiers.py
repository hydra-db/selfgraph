import pytest
from helpers import ANN_ACME_GLOBEX, cli, fresh_graph, mcp_session, run, store_settings, utc, works_at

from selfgraph import Schema, ValidationError, ids
from selfgraph.runtime import build_graph

ACME = ids.relation_id("person:ann", "WORKS_AT", "company:acme")
GLOBEX = ids.relation_id("person:ann", "WORKS_AT", "company:globex")
ROBERT = {"type": "Person", "name": "Robert Johnson", "aliases": ["Bob Johnson"]}
BOB = {"type": "Person", "name": "Bob Johnson"}
TERMS = {
    "entities": [
        {
            "name": "Company",
            "synonyms": ["employer", "firm"],
            "certified": True,
            "definitions": [{"name": "headcount", "expression": "count(Person)", "synonyms": ["staff size"]}],
        },
        {"name": "Person", "aliases": ["user"]},
    ],
    "relations": [{"type": "WORKS_AT", "synonyms": ["employed by"]}],
}


class Judge:
    def __init__(self, retire=(1,)):
        self.retire = list(retire)
        self.prompts = []

    async def generate(self, *, system, user, output):
        self.prompts.append(user)
        return output(retired=self.retire)


class Embedder:
    def __init__(self):
        self.calls = []

    async def embed(self, texts):
        self.calls.append(list(texts))
        return [[1.0, 0.0] if "feline" in t or "Cat" in t else [0.0, 1.0] for t in texts]


def test_levels_set_every_default_and_reject_unknown_names():
    assert fresh_graph("tier").tiers == {
        "level": "balanced",
        "max_tier": "max",
        "extraction": "spacy",
        "resolution": "default",
        "contradiction": "warn",
        "seeds": "synonyms",
        "traversal": "bfs",
    }
    light = fresh_graph("tier", level="light").tiers
    assert (light["extraction"], light["resolution"], light["seeds"]) == ("regex", "exact", "bm25")
    top = fresh_graph("tier", level="max", llm=Judge()).tiers
    assert (top["extraction"], top["resolution"], top["contradiction"]) == ("llm", "llm", "llm")
    assert (top["seeds"], top["traversal"]) == ("synonyms", "ppr")
    assert fresh_graph("tier", level="max", llm=Judge(), embedder=Embedder()).tiers["seeds"] == "embeddings"
    with pytest.raises(ValidationError, match="level must be one of light, balanced, max"):
        fresh_graph("tier", level="heavy")
    with pytest.raises(ValidationError, match="level 'max' needs an LLM"):
        fresh_graph("tier", level="max")
    with pytest.raises(ValidationError, match="contradiction 'llm' needs an LLM"):
        fresh_graph("tier", contradiction="llm")
    with pytest.raises(ValidationError, match="seeds 'embeddings' needs an embedder"):
        fresh_graph("tier", seeds="embeddings")


def test_an_llm_turns_on_extraction_only_and_an_explicit_option_wins():
    g = fresh_graph("tier", llm=Judge())
    assert g.tiers["extraction"] == "llm"
    assert (g.tiers["resolution"], g.tiers["contradiction"]) == ("default", "warn")
    assert fresh_graph("tier", llm=Judge(), extraction="regex").tiers["extraction"] == "regex"
    assert fresh_graph("tier", level="light", resolver="fuzzy").tiers["resolution"] == "fuzzy"


def test_max_tier_caps_graph_and_per_call_options():
    g = fresh_graph("tier", llm=Judge(), level="max", max_tier="balanced")
    assert g.tiers["extraction"] == "spacy"
    assert (g.tiers["resolution"], g.tiers["contradiction"], g.tiers["seeds"]) == ("fuzzy", "supersede", "synonyms")
    res = run(g.insert.ontology({"entities": [BOB]}, resolver="llm", contradiction="llm"))
    assert res.tiers == {"resolution": "fuzzy", "contradiction": "supersede"}
    capped = fresh_graph("tier", max_tier="light")
    assert (capped.tiers["resolution"], capped.tiers["seeds"]) == ("exact", "bm25")


def test_balanced_merges_by_alias_and_results_name_their_tiers():
    g = fresh_graph("tier")
    run(g.insert.ontology({"entities": [ROBERT]}))
    res = run(g.insert.ontology({"entities": [BOB]}))
    assert len(res.merges) == 1
    assert res.tiers == {"resolution": "default", "contradiction": "warn"}
    light = fresh_graph("tier", level="light")
    run(light.insert.ontology({"entities": [ROBERT]}))
    assert run(light.insert.ontology({"entities": [BOB]})).merges == []
    text = run(light.insert.text("Ann works at Acme."))
    assert text.tiers == {"extraction": "regex", "resolution": "exact", "contradiction": "warn"}
    found = run(light.retrieve("Ann"))
    assert found.tiers == {"seeds": "bm25", "traversal": "bfs"}
    assert run(light.retrieve("Ann", strategy="ppr")).tiers["traversal"] == "ppr"


def test_llm_judged_contradiction_retires_an_older_fact_without_a_schema():
    judge = Judge()
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    run(g.insert.ontology({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    assert judge.prompts == []
    res = run(g.insert.ontology({"relations": [works_at("globex", 2022)]}))
    assert res.tiers["contradiction"] == "llm"
    assert [w.code for w in res.warnings] == ["relation_superseded"]
    assert "New fact: Ann -[WORKS_AT]-> Globex" in judge.prompts[0]
    assert "1. Ann -[WORKS_AT]-> Acme" in judge.prompts[0]
    assert [r.id for r in run(g.relations.list(from_entity="person:ann")).items] == [GLOBEX]
    old = run(g.relations.versions(ACME))[-1]
    assert (old.is_current, old.invalidated_by, old.invalidated_at) == (False, GLOBEX, utc(2022))
    past = run(g.retrieve("Ann", as_of="2021-06-01"))
    assert [r.id for r in past.subgraph.relations] == [ACME]


def test_llm_judge_keeps_compatible_facts_and_skips_same_write_and_older_inputs():
    judge = Judge(retire=())
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    run(g.insert.ontology({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    res = run(g.insert.ontology({"relations": [works_at("globex", 2022)]}))
    assert res.warnings == [] and len(judge.prompts) == 1
    assert len(run(g.relations.list(from_entity="person:ann")).items) == 2
    g = fresh_graph("tier", llm=Judge(), extraction="regex", contradiction="llm")
    both = [works_at("acme", 2020), works_at("globex", 2022)]
    assert run(g.insert.ontology({"entities": ANN_ACME_GLOBEX, "relations": both})).warnings == []
    late = Judge()
    g = fresh_graph("tier", llm=late, extraction="regex", contradiction="llm")
    run(g.insert.ontology({"entities": ANN_ACME_GLOBEX, "relations": [works_at("globex", 2022)]}))
    assert run(g.insert.ontology({"relations": [works_at("acme", 2020)]})).warnings == []
    assert late.prompts == []


def test_llm_judge_leaves_cardinality_types_to_the_schema_rule_and_judges_other_types():
    judge = Judge()
    spec = {"relations": [{"type": "WORKS_AT", "from": {"max_count": 1}}]}
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm", schema=spec)
    run(g.insert.ontology({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    res = run(g.insert.ontology({"relations": [works_at("globex", 2022)]}))
    assert [w.code for w in res.warnings] == ["relation_superseded"] and judge.prompts == []
    likes = {"from_entity": "person:ann", "type": "LIKES", "to_entity": "company:acme"}
    run(g.insert.ontology({"relations": [likes]}))
    rel = run(g.relations.create("person:ann", "DISLIKES", "company:acme"))
    assert "1. Ann -[LIKES]-> Acme" in judge.prompts[0]
    assert [r.type for r in run(g.relations.list(to_entity="company:acme")).items] == ["DISLIKES"]
    assert (
        run(g.relations.versions(ids.relation_id("person:ann", "LIKES", "company:acme")))[-1].invalidated_by == rel.id
    )


def test_coverage_names_schema_terms_entities_and_what_is_missing():
    g = fresh_graph("tier", schema=TERMS)
    run(g.insert.ontology({"entities": [{"type": "Company", "name": "Acme"}]}))
    cov = run(g.coverage("What is the staff size of the firm Acme by ad spend?"))
    assert [(t.term, t.kind, t.matched, t.certified) for t in cov.terms] == [
        ("Company", "entity", "firm", True),
        ("headcount", "definition", "staff size", False),
    ]
    assert cov.covered == ["acme", "firm", "size", "staff"]
    assert cov.uncovered == ["ad", "spend"]
    assert cov.ratio == pytest.approx(4 / 6)
    assert [t.term for t in run(g.coverage("users employed by employers")).terms] == ["Company", "Person", "WORKS_AT"]
    bare = run(fresh_graph("tier").coverage("anything"))
    assert (bare.terms, bare.covered, bare.uncovered, bare.ratio) == ([], [], ["anything"], 0.0)
    with pytest.raises(ValidationError, match="question cannot be empty"):
        run(g.coverage(" "))


def test_synonym_seeding_finds_entities_by_a_type_synonym():
    g = fresh_graph("tier", schema=TERMS)
    run(g.insert.ontology({"entities": [{"type": "Company", "name": "Acme"}, {"type": "Person", "name": "Ann"}]}))
    found = run(g.retrieve("which employers are there"))
    assert found.tiers["seeds"] == "synonyms"
    assert [s.id for s in found.seeds] == ["company:acme"]
    assert run(g.retrieve("which employers are there", seeds="bm25")).seeds == []
    assert run(fresh_graph("tier").retrieve("which employers")).tiers["seeds"] == "bm25"


def test_embedding_seeding_fuses_with_bm25_and_embeds_each_entity_once():
    embedder = Embedder()
    g = fresh_graph("tier", embedder=embedder, seeds="embeddings")
    run(g.insert.ontology({"entities": [{"type": "Animal", "name": "Cat"}, {"type": "Animal", "name": "Dog"}]}))
    found = run(g.retrieve("feline"))
    assert found.tiers["seeds"] == "embeddings"
    assert [s.id for s in found.seeds] == ["animal:cat"]
    assert run(g.retrieve("feline", seeds="bm25")).seeds == []
    calls = len(embedder.calls)
    run(g.retrieve("feline"))
    assert len(embedder.calls) == calls + 1 and embedder.calls[-1] == ["feline"]
    with pytest.raises(ValidationError, match="embedder must have an embed method"):
        fresh_graph("tier", embedder=object())


def test_from_tables_drafts_types_properties_relations_and_mappings():
    schema = Schema.from_tables(
        [
            {
                "name": "sales.invoice_lines",
                "description": "one line of an invoice",
                "columns": [
                    {"name": "invoice_id", "type": "bigint", "references": "sales.invoices"},
                    {"name": "extended_price", "type": "numeric(18,2)", "nullable": False},
                    {"name": "note", "type": "varchar"},
                ],
            },
            {"name": "sales.invoices", "columns": [{"name": "invoice_date", "type": "date"}]},
        ],
        name="sales",
    )
    line, invoice = schema.entities
    assert (line.name, line.description, line.certified) == ("InvoiceLine", "one line of an invoice", False)
    assert line.synonyms == ["invoice lines", "invoice line"]
    assert [(m.table, m.column) for m in line.mappings] == [("sales.invoice_lines", None)]
    assert [(p.name, p.type, p.required) for p in line.properties] == [
        ("extended_price", "float", True),
        ("note", "string", False),
    ]
    assert (invoice.name, invoice.properties[0].type) == ("Invoice", "datetime")
    (rel,) = schema.relations
    assert (rel.type, rel.from_.types, rel.from_.max_count, rel.to.types) == (
        "HAS_INVOICE",
        ["InvoiceLine"],
        1,
        ["Invoice"],
    )
    g = fresh_graph("tier", schema=schema)
    assert [t.term for t in run(g.coverage("total for invoice lines")).terms][0] == "InvoiceLine"
    with pytest.raises(ValidationError, match="unknown table 'nope'"):
        Schema.from_tables([{"name": "t", "columns": [{"name": "x_id", "references": "nope"}]}])
    with pytest.raises(ValidationError, match="each table needs a name"):
        Schema.from_tables([{}])


def test_cli_mcp_and_settings_carry_the_level_and_coverage(capsys):
    g = fresh_graph("tier")
    run(g.insert.ontology({"entities": [{"type": "Company", "name": "Acme"}]}))
    cov = cli(g, ["coverage", "Acme", "revenue"], capsys)
    assert (cov["covered"], cov["uncovered"]) == (["acme"], ["revenue"])
    assert cli(g, ["retrieve", "Acme", "--seeds", "bm25"], capsys)["tiers"] == {"seeds": "bm25", "traversal": "bfs"}
    assert build_graph(store_settings(level="light")).tiers["resolution"] == "exact"
    assert build_graph(store_settings(max_tier="light", resolver="fuzzy")).tiers["resolution"] == "exact"
    with pytest.raises(ValidationError, match="level must be one of"):
        build_graph(store_settings(level="huge"))
    with mcp_session("tier", level="light") as srv:
        run(srv.create_entity("Acme", "Company"))
        assert run(srv.coverage("Acme revenue"))["uncovered"] == ["revenue"]
        assert run(srv.retrieve("Acme"))["tiers"] == {"seeds": "bm25", "traversal": "bfs"}
