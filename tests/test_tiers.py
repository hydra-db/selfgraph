import asyncio
import contextvars
from datetime import datetime

import pytest
from helpers import ANN_ACME_GLOBEX, cli, fresh_graph, mcp_session, run, store_settings, utc, works_at

from selfgraph import (
    LLMResolver,
    ResolutionDecision,
    Schema,
    SelfGraph,
    TransientError,
    ValidationError,
    _ops,
    ids,
)
from selfgraph.runtime import build_graph
from selfgraph.terms import schema_forms, stem

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


class WritingLLM:
    def __init__(self, answer):
        self.answer = answer
        self.prompts = []
        self.write = None

    async def generate(self, *, system, user, output):
        self.prompts.append(user)
        if self.write is not None:
            other_client = contextvars.Context().run(asyncio.ensure_future, self.write())
            await asyncio.wait_for(other_client, timeout=5)
        return output(**self.answer)


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
    res = run(g.insert.facts({"entities": [BOB]}, resolver="llm", contradiction="llm"))
    assert res.tiers == {"resolution": "fuzzy", "contradiction": "supersede"}
    quiet = fresh_graph("tier", level="max", max_tier="balanced", resolver="llm", contradiction="llm")
    assert (quiet.tiers["resolution"], quiet.tiers["contradiction"]) == ("fuzzy", "supersede")
    capped = fresh_graph("tier", max_tier="light")
    assert (capped.tiers["resolution"], capped.tiers["seeds"]) == ("exact", "bm25")


def test_balanced_merges_by_alias_and_results_name_their_tiers():
    g = fresh_graph("tier")
    run(g.insert.facts({"entities": [ROBERT]}))
    res = run(g.insert.facts({"entities": [BOB]}))
    assert len(res.merges) == 1
    assert res.tiers == {"resolution": "default", "contradiction": "warn"}
    light = fresh_graph("tier", level="light")
    run(light.insert.facts({"entities": [ROBERT]}))
    assert run(light.insert.facts({"entities": [BOB]})).merges == []
    text = run(light.insert.text("Ann works at Acme."))
    assert text.tiers == {"extraction": "regex", "resolution": "exact", "contradiction": "warn"}
    found = run(light.retrieve("Ann"))
    assert found.tiers == {"seeds": "bm25", "traversal": "bfs"}
    assert run(light.retrieve("Ann", strategy="ppr")).tiers["traversal"] == "ppr"


def test_llm_judged_contradiction_retires_an_older_fact_without_a_schema():
    judge = Judge()
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    assert judge.prompts == []
    res = run(g.insert.facts({"relations": [works_at("globex", 2022)]}))
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
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    res = run(g.insert.facts({"relations": [works_at("globex", 2022)]}))
    assert res.warnings == [] and len(judge.prompts) == 1
    assert len(run(g.relations.list(from_entity="person:ann")).items) == 2
    g = fresh_graph("tier", llm=Judge(), extraction="regex", contradiction="llm")
    both = [works_at("acme", 2020), works_at("globex", 2022)]
    assert run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": both})).warnings == []
    late = Judge()
    g = fresh_graph("tier", llm=late, extraction="regex", contradiction="llm")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("globex", 2022)]}))
    assert run(g.insert.facts({"relations": [works_at("acme", 2020)]})).warnings == []
    assert late.prompts == []


def test_llm_judge_excludes_unchanged_relations_in_a_mixed_batch():
    judge = Judge()
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    both = [works_at("acme", 2020), works_at("globex", 2022)]
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": both}))
    assert run(g.insert.facts({"relations": both})).warnings == []
    assert judge.prompts == []
    changed = [both[0], {**both[1], "properties": {"role": "lead"}}]
    result = run(g.insert.facts({"relations": changed}))
    assert judge.prompts == []
    assert result.warnings == []
    assert [(r.revision, r.is_current) for r in result.relations] == [(1, True), (2, True)]
    assert run(g.relations.get(ACME)).is_current
    assert run(g.relations.get(GLOBEX)).is_current
    assert run(g.insert.facts({"relations": changed})).warnings == []
    assert judge.prompts == []
    run(g.entities.create("Initech", "Company"))
    external = run(g.insert.facts({"relations": [works_at("initech", 2024)]}))
    assert len(judge.prompts) == 1
    assert "Ann -[WORKS_AT]-> Acme" in judge.prompts[0]
    assert "Ann -[WORKS_AT]-> Globex" in judge.prompts[0]
    assert [w.code for w in external.warnings] == ["relation_superseded"]
    assert len(run(g.relations.list()).items) == 2


def test_llm_judge_leaves_cardinality_types_to_the_schema_rule_and_judges_other_types():
    judge = Judge()
    spec = {"relations": [{"type": "WORKS_AT", "from": {"max_count": 1}}]}
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm", schema=spec)
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    res = run(g.insert.facts({"relations": [works_at("globex", 2022)]}))
    assert [w.code for w in res.warnings] == ["relation_superseded"] and judge.prompts == []
    likes = {"from_entity": "person:ann", "type": "LIKES", "to_entity": "company:acme"}
    run(g.insert.facts({"relations": [likes]}))
    rel = run(g.relations.create("person:ann", "DISLIKES", "company:acme"))
    assert "1. Ann -[LIKES]-> Acme" in judge.prompts[0]
    assert [r.type for r in run(g.relations.list(to_entity="company:acme")).items] == ["DISLIKES"]
    assert (
        run(g.relations.versions(ids.relation_id("person:ann", "LIKES", "company:acme")))[-1].invalidated_by == rel.id
    )


def test_check_answerable_grounds_schema_synonyms_definitions_and_plurals():
    g = fresh_graph("tier", schema=TERMS)
    run(g.insert.facts({"entities": [{"type": "Company", "name": "Acme"}]}))
    report = run(g.check_answerable("What is the staff size of the firm Acme by ad spend?"))
    assert [(t.term, t.status, t.matches, t.certified) for t in report.terms] == [
        ("staff size", "definition", ["headcount"], False),
        ("firm", "type", ["Company"], True),
        ("acme", "entity", ["company:acme"], False),
        ("ad", "missing", [], False),
        ("spend", "missing", [], False),
    ]
    assert (report.verdict, report.missing) == ("partial", ["ad", "spend"])
    report = run(g.check_answerable("users employed by employers"))
    assert [(t.status, t.matches) for t in report.terms] == [
        ("schema_only", ["Person"]),
        ("schema_only", ["WORKS_AT"]),
        ("type", ["Company"]),
    ]
    assert (report.verdict, report.missing) == ("partial", ["users", "employed"])
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Ann"}], "relations": [works_at("acme")]}))
    report = run(g.check_answerable("users employed by employers"))
    assert [(t.status, t.matches) for t in report.terms] == [
        ("type", ["Person"]),
        ("relation", ["WORKS_AT"]),
        ("type", ["Company"]),
    ]
    assert report.verdict == "answerable"
    assert run(fresh_graph("tier").check_answerable("anything")).verdict == "not_answerable"


def test_definition_terms_keep_their_entity_owners():
    schema = {
        "entities": [
            {
                "name": "Employee",
                "definitions": [{"name": "status", "expression": "active", "synonyms": ["employment state"]}],
            },
            {
                "name": "Project",
                "definitions": [{"name": "status", "expression": "phase", "synonyms": ["project state"]}],
            },
        ]
    }
    g = fresh_graph("tier", schema=schema)
    run(g.insert.facts({"entities": [{"type": "Employee", "name": "Alice"}]}))
    report = run(g.check_answerable("project state", terms=["project state"]))
    assert report.verdict == "not_answerable"
    assert [(t.status, t.matches) for t in report.terms] == [("schema_only", ["status"])]
    assert [seed.id for seed in run(g.retrieve("employment state", depth=0)).seeds] == ["employee:alice"]


def test_certification_follows_the_stored_definitions_name():
    schema = {
        "entities": [
            {
                "name": "Project",
                "definitions": [{"name": "phase", "expression": "b", "synonyms": ["state"], "certified": False}],
            },
            {
                "name": "Employee",
                "definitions": [{"name": "status", "expression": "a", "synonyms": ["state"], "certified": True}],
            },
        ]
    }
    g = fresh_graph("tier", schema=schema)
    run(g.insert.facts({"entities": [{"type": "Employee", "name": "Alice"}]}))
    report = run(g.check_answerable("state"))
    assert [(t.status, t.matches, t.certified) for t in report.terms] == [("definition", ["status"], True)]


def test_a_schema_only_shared_synonym_lists_every_definition_it_names():
    schema = {
        "entities": [
            {
                "name": "Employee",
                "definitions": [{"name": "status", "expression": "a", "synonyms": ["state"], "certified": True}],
            },
            {
                "name": "Project",
                "definitions": [{"name": "phase", "expression": "b", "synonyms": ["state"], "certified": False}],
            },
            {"name": "Person"},
        ]
    }
    assert schema_forms(Schema.model_validate(schema))["definition"]["state"] == [("status", True), ("phase", False)]
    g = fresh_graph("tier", schema=schema)
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Alice"}]}))
    report = run(g.check_answerable("state"))
    assert [(t.status, t.matches, t.certified) for t in report.terms] == [("schema_only", ["phase", "status"], True)]


@pytest.mark.parametrize(("stored", "status"), [("Employee", "definition"), ("Person", "schema_only")])
def test_a_shared_definition_name_is_certified_only_when_every_declaring_type_certifies_it(stored, status):
    schema = {
        "entities": [
            {
                "name": "Employee",
                "definitions": [{"name": "status", "expression": "a", "synonyms": ["standing"], "certified": True}],
            },
            {"name": "Project", "definitions": [{"name": "status", "expression": "b", "synonyms": ["phase"]}]},
            {"name": "Invoice", "certified": True},
            {"name": "InvoiceLine"},
            {"name": "Person"},
        ]
    }
    g = fresh_graph("tier", schema=schema)
    entities = [{"type": t, "name": n} for t, n in ((stored, "Alice"), ("Invoice", "I1"), ("InvoiceLine", "L1"))]
    run(g.insert.facts({"entities": entities}))
    report = run(g.check_answerable("standing invoice", terms=["standing", "invoice"]))
    assert [(t.term, t.status, t.matches, t.certified) for t in report.terms] == [
        ("standing", status, ["status"], False),
        ("invoice", "type", ["Invoice", "InvoiceLine"], True),
    ]


@pytest.mark.parametrize("certified_first", [True, False])
def test_a_definition_declared_twice_by_one_type_keeps_both_declarations(certified_first):
    declarations = [
        {"name": "status", "expression": "a", "synonyms": ["payroll marker"], "certified": True},
        {"name": "status", "expression": "b", "synonyms": ["staff metric"]},
    ]
    schema = {
        "entities": [
            {"name": "Employee", "definitions": declarations if certified_first else declarations[::-1]},
            {"name": "Person"},
        ]
    }
    g = fresh_graph("tier", schema=schema)
    run(g.insert.facts({"entities": [{"type": "Employee", "name": "Alice"}, {"type": "Person", "name": "Bob"}]}))
    for term in ("payroll marker", "staff metric"):
        report = run(g.check_answerable(term, terms=[term]))
        assert [(t.status, t.matches, t.certified) for t in report.terms] == [("definition", ["status"], True)]
        assert [seed.id for seed in run(g.retrieve(term, depth=0)).seeds] == ["employee:alice"]


def test_check_answerable_ignores_possessive_and_contraction_endings():
    spec = {
        "entities": [{"name": "Person"}, {"name": "Company"}],
        "relations": [{"type": "WORKS_AT"}, {"type": "BACKS", "synonyms": ["John's employer"]}],
    }
    g = fresh_graph("tier", schema=spec)
    facts = {
        "entities": [
            {"type": "Person", "name": "Ann"},
            {"type": "Company", "name": "Acme"},
            {"type": "Company", "name": "Ann's Bakery"},
        ],
        "relations": [works_at("acme")],
    }
    run(g.insert.facts(facts))
    for question in ["What is Ann's company?", "What is Ann’s company?", "Doesn't Ann work at Acme?"]:
        report = run(g.check_answerable(question))
        assert (report.verdict, report.missing) == ("answerable", []), question
    assert [t.term for t in run(g.check_answerable("What is Ann's company?")).terms] == ["ann", "company"]
    for question in ["What is Ann's Bakery?", "What is Ann’s Bakery?"]:
        assert [(t.term, t.status) for t in run(g.check_answerable(question)).terms] == [("ann bakery", "entity")]
    for question in ["Who is John's employer?", "Who is John’s employer?"]:
        assert [(t.term, t.status) for t in run(g.check_answerable(question)).terms] == [
            ("john employer", "schema_only")
        ]


def test_check_answerable_keeps_wont_and_cant_whole():
    g = fresh_graph("tier")
    run(g.insert.facts({"entities": [{"type": "Person", "name": "Ann"}]}))
    assert [t.term for t in run(g.check_answerable("Why can't Ann stay?")).terms] == ["can't", "ann", "stay"]
    assert [t.term for t in run(g.check_answerable("Won’t Ann stay?")).terms] == ["won't", "ann", "stay"]


def test_stem_singularizes_es_plurals_and_keeps_status_and_analysis():
    singular = {
        "addresses": "address",
        "boxes": "box",
        "dishes": "dish",
        "batches": "batch",
        "branches": "branch",
        "statuses": "status",
        "buses": "bus",
        "movies": "movie",
        "cookies": "cookie",
        "quizzes": "quiz",
        "heroes": "hero",
        "potatoes": "potato",
        "axes": "axe",
        "shoes": "shoe",
        "buzzes": "buzz",
        "waltzes": "waltz",
        "menus": "menu",
        "excuses": "excuse",
        "abuses": "abuse",
        "status": "status",
        "analysis": "analysis",
        "class": "class",
    }
    assert {word: stem(word) for word in singular} == singular
    assert all(stem(word) == word for word in singular.values())
    tables = [
        "addresses",
        "order_status",
        "tax_classes",
        "batches",
        "analysis",
        "movies",
        "cookies",
        "quizzes",
        "businesses",
    ]
    assert [e.name for e in Schema.from_tables([{"name": t} for t in tables]).entities] == [
        "Address",
        "OrderStatus",
        "TaxClass",
        "Batch",
        "Analysis",
        "Movie",
        "Cookie",
        "Quiz",
        "Business",
    ]
    g = fresh_graph("tier", schema={"entities": [{"name": "Address"}, {"name": "Status"}]})
    run(
        g.insert.facts({"entities": [{"type": "Address", "name": "12 Main St"}, {"type": "Status", "name": "Shipped"}]})
    )
    for question, matched in (("which addresses", "Address"), ("which statuses", "Status"), ("which status", "Status")):
        report = run(g.check_answerable(question))
        assert (report.verdict, [t.matches for t in report.terms]) == ("answerable", [[matched]])


def test_synonym_seeding_finds_entities_by_a_type_synonym():
    g = fresh_graph("tier", schema=TERMS)
    run(g.insert.facts({"entities": [{"type": "Company", "name": "Acme"}, {"type": "Person", "name": "Ann"}]}))
    found = run(g.retrieve("which employers are there"))
    assert found.tiers["seeds"] == "synonyms"
    assert [s.id for s in found.seeds] == ["company:acme"]
    assert run(g.retrieve("which employers are there", seeds="bm25")).seeds == []
    assert run(fresh_graph("tier").retrieve("which employers")).tiers["seeds"] == "bm25"


def test_bm25_seed_ranking_counts_repeated_document_words():
    g = fresh_graph("tier")
    run(
        g.insert.facts(
            {
                "entities": [
                    {"type": "Thing", "name": "Zebra", "properties": {"text": "alpha alpha beta"}},
                    {"type": "Thing", "name": "Mango", "properties": {"text": "alpha beta beta"}},
                ]
            }
        )
    )
    found = run(g.retrieve("alpha", seeds="bm25"))
    assert [seed.id for seed in found.seeds[:2]] == ["thing:zebra", "thing:mango"]
    assert found.seeds[0].score > found.seeds[1].score


def test_synonym_seeding_expands_parent_types_and_definitions_to_subtypes():
    hierarchy = {
        "entities": [
            {
                "name": "Employee",
                "aliases": ["Worker"],
                "synonyms": ["staff"],
                "definitions": [{"name": "Active Staff", "expression": "active = true", "synonyms": ["personnel"]}],
            },
            {"name": "Engineer", "parent": "Employee"},
            {"name": "PrincipalEngineer", "parent": "Engineer"},
        ]
    }
    g = fresh_graph("tier", schema=hierarchy)
    run(g.entities.create("Ann", "PrincipalEngineer"))
    for question in (
        "Who are the Employees?",
        "Who are the Workers?",
        "Who are the staff?",
        "Who are the personnel?",
    ):
        assert run(g.check_answerable(question)).verdict == "answerable", question
        found = run(g.retrieve(question, seeds="synonyms"))
        assert [s.id for s in found.seeds] == ["principalengineer:ann"], question
        assert run(g.retrieve(question, seeds="bm25")).seeds == [], question


def test_embedding_seeding_fuses_with_bm25_and_embeds_each_entity_once():
    embedder = Embedder()
    g = fresh_graph("tier", embedder=embedder, seeds="embeddings")
    run(g.insert.facts({"entities": [{"type": "Animal", "name": "Cat"}, {"type": "Animal", "name": "Dog"}]}))
    found = run(g.retrieve("feline"))
    assert found.tiers["seeds"] == "embeddings"
    assert [s.id for s in found.seeds] == ["animal:cat"]
    assert run(g.retrieve("feline", seeds="bm25")).seeds == []
    calls = len(embedder.calls)
    run(g.retrieve("feline"))
    assert len(embedder.calls) == calls + 1 and embedder.calls[-1] == ["feline"]
    with pytest.raises(ValidationError, match="embedder must have an embed method"):
        fresh_graph("tier", embedder=object())


def test_embedding_seeding_rejects_mismatched_dimensions_and_can_retry():
    class ChangingEmbedder:
        valid = False

        async def embed(self, texts):
            return [[1.0, 0.0] if self.valid or text == "unrelated" else [1.0] for text in texts]

    embedder = ChangingEmbedder()
    g = fresh_graph("tier", embedder=embedder, seeds="embeddings")
    run(g.insert.facts({"entities": [{"type": "Thing", "name": "Match"}]}))
    with pytest.raises(ValidationError, match="embedding vectors must have the same dimensions"):
        run(g.retrieve("unrelated"))
    assert not g._embeddings
    embedder.valid = True
    assert [seed.id for seed in run(g.retrieve("unrelated")).seeds] == ["thing:match"]


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
    terms = run(g.check_answerable("total for invoice lines")).terms
    assert [(t.term, t.matches) for t in terms if t.status == "schema_only"] == [("invoice lines", ["InvoiceLine"])]
    with pytest.raises(ValidationError, match="unknown table 'nope'"):
        Schema.from_tables([{"name": "t", "columns": [{"name": "x_id", "references": "nope"}]}])
    with pytest.raises(ValidationError, match="each table needs a name"):
        Schema.from_tables([{}])


@pytest.mark.parametrize(
    "reference, shown",
    [
        ({"table": "users"}, "{'table': 'users'}"),
        (["users"], "['users']"),
    ],
)
def test_from_tables_rejects_non_string_references_with_a_validation_error(reference, shown):
    with pytest.raises(ValidationError) as exc:
        Schema.from_tables([{"name": "orders", "columns": [{"name": "user_id", "references": reference}]}])
    assert str(exc.value) == f"tables[0].columns[0].references: unknown table {shown}"


def test_from_tables_maps_only_integer_sql_types_to_integer():
    types = [
        "int",
        "INT UNSIGNED",
        "hugeint",
        "point",
        "interval",
        "int4range",
        "integer[]",
        "_int8",
        "ARRAY",
        "tstzrange",
    ]
    schema = Schema.from_tables([{"name": "t", "columns": [{"name": f"c{i}", "type": t} for i, t in enumerate(types)]}])
    assert [p.type for p in schema.entities[0].properties] == ["integer"] * 3 + ["string"] * 7


def test_cli_mcp_and_settings_carry_the_level(capsys):
    g = fresh_graph("tier")
    run(g.insert.facts({"entities": [{"type": "Company", "name": "Acme"}]}))
    assert cli(g, ["retrieve", "Acme", "--seeds", "bm25"], capsys)["tiers"] == {"seeds": "bm25", "traversal": "bfs"}
    light = build_graph(store_settings(level="light"))
    assert light.tiers["resolution"] == "exact"
    run(light.close())
    capped = build_graph(store_settings(max_tier="light", resolver="fuzzy"))
    assert capped.tiers["resolution"] == "exact"
    run(capped.close())
    with pytest.raises(ValidationError, match="level must be one of"):
        build_graph(store_settings(level="huge"))
    with mcp_session("tier", level="light") as srv:
        run(srv.create_entity("Acme", "Company"))
        assert run(srv.retrieve("Acme"))["tiers"] == {"seeds": "bm25", "traversal": "bfs"}


def test_llm_judge_answers_outside_the_write_and_rechecks_what_it_chose():
    judge = WritingLLM({"retired": [1]})
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    judge.write = lambda: g.relations.certify(ACME, by="hr")
    res = run(g.insert.facts({"relations": [works_at("globex", 2022)]}))
    assert len(judge.prompts) == 1 and [w.code for w in res.warnings] == ["certified_kept"]
    assert {r.id for r in run(g.relations.list(from_entity="person:ann")).items} == {ACME, GLOBEX}


def test_llm_judge_drops_a_verdict_when_the_new_relation_changed_while_it_answered():
    judge = WritingLLM({"retired": [1]})
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    judge.write = lambda: g.relations.update(GLOBEX, set_properties={"role": "intern"})
    res = run(g.insert.facts({"relations": [works_at("globex", 2022)]}))
    assert len(judge.prompts) == 1 and res.warnings == []
    assert {r.id for r in run(g.relations.list(from_entity="person:ann")).items} == {ACME, GLOBEX}
    assert run(g.relations.get(GLOBEX)).revision == 2


@pytest.mark.parametrize("retire", [True, False])
def test_llm_judge_sees_a_rival_the_replaced_source_would_retire(retire):
    g = fresh_graph("tier", llm=Judge([1] if retire else []), extraction="regex", contradiction="llm")
    old = run(g.insert.text("Ann works at Acme.", source_id="hr")).relations[0]
    res = run(g.insert.text("Ann works at Globex.", source_id="hr", replace_source=True))
    new = res.relations[0]
    codes = [w.code for w in res.warnings if w.code != "basic_extraction"]
    stored = [v for v in run(g.relations.versions(old.id)) if v.invalidated_at is not None][0]
    if retire:
        assert codes == ["relation_superseded"] and res.source_diff.retired == []
        assert stored.invalidated_by == new.id
    else:
        assert codes == ["fact_retired_by_source"] and res.source_diff.retired == [old.id]
        assert stored.invalidated_by == res.source_version
    assert [r.id for r in run(g.relations.list()).items] == [new.id]


def test_a_deferred_source_replacement_skips_a_version_a_newer_replacement_superseded():
    judge = WritingLLM({"retired": []})
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    run(g.insert.text("Ann works at Acme.", source_id="hr"))
    other = SelfGraph(store=g.store, namespace=g.namespace, extraction="regex")
    newer = []

    async def initech():
        newer.append(await other.insert.text("Ann works at Initech.", source_id="hr", replace_source=True))

    judge.write = initech
    res = run(g.insert.text("Ann works at Globex.", source_id="hr", replace_source=True))
    assert len(judge.prompts) == 1 and len(newer) == 1
    assert {r.to_entity for r in run(g.relations.list()).items} == {"thing:initech"}
    stored = {v["id"]: v.get("replaced_by") for v in run(g.store.match_nodes(g.namespace, "SourceVersion"))}
    assert stored[newer[0].source_version] is None
    assert stored[res.source_version] == newer[0].source_version
    [acme] = [r for r in run(g.relations.list(include_invalidated=True)).items if r.to_entity == "thing:acme"]
    assert acme.invalidated_by == newer[0].source_version
    [initech] = [v for v in run(g.store.match_nodes(g.namespace, "SourceVersion")) if v["id"] == acme.invalidated_by]
    assert acme.invalidated_known_at >= datetime.fromisoformat(initech["created_at"])


class PausedJudge:
    def __init__(self):
        self.asked = asyncio.Event()
        self.release = asyncio.Event()

    async def generate(self, *, system, user, output):
        self.asked.set()
        await asyncio.wait_for(self.release.wait(), timeout=5)
        return output(retired=[])


@pytest.mark.parametrize("restated", [False, True])
@pytest.mark.parametrize("first", ["globex", "initech"])
def test_a_deferred_source_replacement_follows_the_newer_one_past_a_version_appended_while_both_wait(first, restated):
    g = fresh_graph("tier", extraction="regex")
    run(g.insert.text("Ann works at Acme.", source_id="hr"))
    judges = {"globex": PausedJudge(), "initech": PausedJudge()}

    async def scenario():
        tasks = {}
        for company in ("globex", "initech"):
            llm = judges[company]
            graph = SelfGraph(store=g.store, namespace=g.namespace, extraction="regex", llm=llm, contradiction="llm")
            text = f"Ann works at {company.capitalize()}."
            tasks[company] = asyncio.ensure_future(graph.insert.text(text, source_id="hr", replace_source=True))
            await asyncio.wait_for(judges[company].asked.wait(), timeout=5)
        text = "Ann works at Acme. Bob works at Paris." if restated else "Bob works at Paris."
        appended = await g.insert.text(text, source_id="hr")
        for company in (first, ({"globex", "initech"} - {first}).pop()):
            judges[company].release.set()
            await tasks[company]
        return await tasks["initech"], appended

    initech, appended = run(scenario())
    current = {r.to_entity for r in run(g.relations.list()).items}
    assert current == {"thing:initech", "thing:paris"} | ({"thing:acme"} if restated else set())
    stored = {v["id"]: v.get("replaced_by") for v in run(g.store.match_nodes(g.namespace, "SourceVersion"))}
    assert (stored[initech.source_version], stored[appended.source_version]) == (None, None)
    if not restated:
        [acme] = [r for r in run(g.relations.list(include_invalidated=True)).items if r.to_entity == "thing:acme"]
        assert acme.invalidated_by == initech.source_version
        [row] = [v for v in run(g.store.match_nodes(g.namespace, "SourceVersion")) if v["id"] == initech.source_version]
        assert acme.invalidated_known_at >= datetime.fromisoformat(row["created_at"])


class FailingJudge:
    async def generate(self, *, system, user, output):
        raise RuntimeError("provider down")


@pytest.mark.parametrize("via", ["insert", "create"])
def test_a_failed_llm_judge_warns_instead_of_failing_the_committed_write(via, caplog):
    g = fresh_graph("tier", llm=FailingJudge(), extraction="regex", contradiction="llm")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    with caplog.at_level("WARNING", logger="selfgraph"):
        if via == "insert":
            warnings = run(g.insert.facts({"relations": [works_at("globex", 2022)]})).warnings
        else:
            run(g.relations.create("person:ann", "WORKS_AT", "company:globex", event_time="2022-01-01"))
    message = f"the LLM contradiction judge failed, so {GLOBEX} were not judged: RuntimeError: provider down"
    if via == "insert":
        assert [(w.code, w.message) for w in warnings] == [("contradiction_not_judged", message)]
    logged = [r.getMessage() for r in caplog.records if "contradiction_not_judged" in r.getMessage()]
    assert logged == [f"schema warning [contradiction_not_judged]: {message}"]
    assert {r.id for r in run(g.relations.list(from_entity="person:ann")).items} == {ACME, GLOBEX}


@pytest.mark.parametrize("recreated", ["rival", "new"])
def test_llm_judge_drops_a_verdict_when_a_relation_is_created_again_while_it_answered(recreated):
    judge = WritingLLM({"retired": [1]})
    g = fresh_graph("tier", llm=judge, extraction="regex", contradiction="llm")
    run(g.insert.facts({"entities": ANN_ACME_GLOBEX, "relations": [works_at("acme", 2020)]}))
    company, rid = ("acme", ACME) if recreated == "rival" else ("globex", GLOBEX)

    async def recreate():
        await g.relations.delete(rid)
        await g.relations.create(
            "person:ann", "WORKS_AT", f"company:{company}", properties={"role": "temp"}, contradiction="warn"
        )

    judge.write = recreate
    res = run(g.insert.facts({"relations": [works_at("globex", 2022)]}))
    assert len(judge.prompts) == 1 and res.warnings == []
    current = {r.id: r for r in run(g.relations.list(from_entity="person:ann")).items}
    assert set(current) == {ACME, GLOBEX} and (current[rid].revision, current[rid].properties) == (1, {"role": "temp"})


def test_llm_resolver_answers_before_the_write_and_never_asks_inside_it():
    llm = WritingLLM({"same": True})
    g = fresh_graph("tier", llm=llm, resolver="llm")
    run(g.entities.create("Katherine Jones", "Person"))
    llm.write = lambda: g.entities.create("Unrelated", "Thing")
    res = run(g.insert.facts({"entities": [{"type": "Person", "name": "Kathy Jones"}]}))
    assert [(m.absorbed_id, m.survivor_id) for m in res.merges] == [("person:kathy-jones", "person:katherine-jones")]
    assert len(llm.prompts) == 1 and run(g.entities.get("thing:unrelated")) is not None


def test_an_llm_resolver_subclass_runs_as_given_and_asks_the_llm_once():
    class Counting(LLMResolver):
        calls = 0

        async def resolve(self, candidate, existing):
            self.calls += 1
            return await super().resolve(candidate, existing)

    llm = WritingLLM({"same": True})
    g = fresh_graph("tier", llm=llm)
    run(g.entities.create("Katherine Jones", "Person"))
    resolver = Counting(llm)
    res = run(g.insert.facts({"entities": [{"type": "Person", "name": "Kathy Jones"}]}, resolver=resolver))
    assert [(m.absorbed_id, m.survivor_id) for m in res.merges] == [("person:kathy-jones", "person:katherine-jones")]
    assert (len(llm.prompts), resolver.calls) == (1, 2)


def test_an_llm_resolver_subclass_keeps_its_own_resolve():
    class NeverMerge(LLMResolver):
        async def resolve(self, candidate, existing):
            return ResolutionDecision()

    llm = WritingLLM({"same": True})
    g = fresh_graph("tier", llm=llm)
    run(g.entities.create("Katherine Jones", "Person"))
    res = run(g.insert.facts({"entities": [{"type": "Person", "name": "Kathy Jones"}]}, resolver=NeverMerge(llm)))
    assert res.merges == [] and run(g.entities.get("person:kathy-jones")) is not None


def test_a_retried_write_does_not_ask_the_llm_resolver_again(monkeypatch):
    llm = WritingLLM({"same": True})
    g = fresh_graph("tier", llm=llm, resolver="llm")
    run(g.entities.create("Katherine Jones", "Person"))
    upsert, failed = _ops.upsert_entities, []

    async def conflict_once(*args, **kwargs):
        if not failed:
            failed.append(True)
            raise TransientError("transaction conflict")
        return await upsert(*args, **kwargs)

    monkeypatch.setattr(_ops, "upsert_entities", conflict_once)
    res = run(g.insert.facts({"entities": [{"type": "Person", "name": "Kathy Jones"}]}))
    assert failed and len(llm.prompts) == 1 and len(res.merges) == 1


def test_llm_resolver_keeps_the_lexical_decision_when_the_target_changed_after_asking():
    llm = WritingLLM({"same": True})
    g = fresh_graph("tier", llm=llm, resolver="llm")
    run(g.entities.create("Katherine Jones", "Person"))
    llm.write = lambda: g.entities.update("person:katherine-jones", aliases=["KJ"])
    res = run(g.insert.facts({"entities": [{"type": "Person", "name": "Kathy Jones"}]}))
    assert res.merges == [] and len(llm.prompts) == 1
    assert run(g.entities.get("person:kathy-jones")) is not None
