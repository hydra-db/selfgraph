import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone

from selfgraph import EvidenceInput, Extraction, Schema, SelfGraph, ValidationError, _serde, ids
from selfgraph.retrieval import _tokens
from selfgraph.runtime import to_jsonable
from selfgraph.schema import validate_against_schema
from selfgraph.terms import expand_tokens, schema_forms

TERMS_SPEC = {
    "entities": [
        {
            "name": "Company",
            "synonyms": ["employer", "firm"],
            "certified": True,
            "definitions": [{"name": "headcount", "expression": "count(Person)", "synonyms": ["staff size"]}],
        },
        {"name": "Person", "aliases": ["user"], "synonyms": ["staff member"]},
        {"name": "InvoiceLine", "mappings": [{"table": "sales.invoice_lines", "column": "id"}]},
    ],
    "relations": [{"type": "WORKS_AT", "synonyms": ["employed by"], "certified": True}],
}
TERM_QUESTIONS = [
    "What is the staff size of the firm Acme by ad spend?",
    "users employed by employers",
    "which employers hired staff members named Hopper",
    "total for invoice lines and Works At",
    "Zoë ÅNGSTRÖM",
]
TABLES = [
    {
        "name": "sales.invoice_lines",
        "description": "one line of an invoice",
        "columns": [
            {"name": "invoice_id", "type": "bigint", "references": "sales.invoices"},
            {"name": "soldByCustomerId", "references": "Customers"},
            {"name": "extended_price", "type": "numeric(18,2)", "nullable": False, "description": "net"},
            {"name": "note", "type": "varchar", "nullable": True},
            {"name": "is_void", "type": "BOOLEAN"},
            {"name": "payload", "type": "jsonb"},
            {"name": "qty", "type": "smallint"},
            {"name": "pickup", "type": "point"},
            {"name": "lead_time", "type": "interval"},
            {"name": "untyped"},
        ],
    },
    {"name": "sales.invoices", "columns": [{"name": "invoice_date", "type": "date"}, {"name": "id", "type": "uuid"}]},
    {"name": "Customers", "columns": [{"name": "parent_id", "references": "Customers"}]},
    {"name": "addresses", "columns": [{"name": "status_id", "references": "order_statuses"}]},
    {"name": "movies"},
    {"name": "order_statuses"},
    {"name": "Companies", "columns": [{"name": "customer_id", "references": "Customers"}]},
]

SCHEMA_SPEC = {
    "name": "conformance",
    "entities": [
        {
            "name": "Person",
            "description": "a human",
            "aliases": ["user"],
            "properties": [
                {"name": "age", "type": "integer", "required": True},
                {"name": "nickname", "type": "string"},
            ],
        },
        {"name": "Manager", "parent": "Person"},
        {"name": "Company", "aliases": ["org"], "properties": [{"name": "founded", "type": "datetime"}]},
    ],
    "relations": [
        {
            "type": "WORKS_AT",
            "aliases": ["employed by"],
            "from": {"types": ["Person"], "max_count": 1},
            "to": {"types": ["Company"], "min_count": 1},
        },
        {"type": "KNOWS", "aliases": ["is friends with"], "from": {"types": ["Person"]}, "to": {"types": ["Person"]}},
    ],
}

SCHEMA_CASES = [
    {
        "entities": [
            {"id": "manager:m", "type": "Manager", "name": "M", "properties": {"age": 30}},
            {"id": "org:o", "type": "org", "name": "O"},
        ],
        "relations": [{"from_entity": "manager:m", "type": "works at", "to_entity": "org:o"}],
    },
    {
        "entities": [
            {"id": "person:p", "type": "Person", "name": "P"},
            {"id": "thing:x", "type": "Alien", "name": "X"},
            {"id": "company:c", "type": "Company", "name": "C", "properties": {"founded": 5}},
        ],
        "relations": [
            {"id": "relation:r1", "from_entity": "person:p", "type": "WORKS_AT", "to_entity": "company:c"},
            {"id": "relation:r2", "from_entity": "person:p", "type": "WORKS_AT", "to_entity": "company:c"},
            {"id": "relation:r3", "from_entity": "company:c", "type": "WORKS_AT", "to_entity": "company:c"},
            {"id": "relation:r4", "from_entity": "person:p", "type": "LIKES", "to_entity": "company:c"},
        ],
    },
    {
        "entities": [{"id": "manager:z", "type": "Manager", "name": "Z"}],
        "relations": [
            {"from_entity": "manager:z", "type": "WORKS_AT", "to_entity": "org:o"},
            {"from_entity": "manager:z", "type": "employed by", "to_entity": "org:o2"},
            {"from_entity": "company:stored", "type": "KNOWS", "to_entity": "manager:z"},
        ],
    },
]

GRAPH_TYPES = {"company:stored": "Company", "org:o": "org"}

UNKNOWN_KEY_CASES = [
    ["facts", {"entites": []}],
    ["facts", {"entities": [{"type": "P", "nmae": "x"}]}],
    ["facts", {"entities": [{"type": "P", "name": "x", "b": 1, "a": 2}]}],
    [
        "facts",
        {
            "relations": [
                {"from_entity": "a", "type": "X", "to_entity": "b", "evidence": [{"source_id": "s", "qoute": "q"}]}
            ]
        },
    ],
    ["facts", {"decisions": [{"title": "t", "steps": [], "stauts": "active"}]}],
    ["facts", {"preferences": [{"subject_entity": "a", "key": "k", "value_entity": "b", "strenght": 1}]}],
    ["schema", {"entity_types": []}],
    ["schema", {"entities": [{"name": "A", "properties": [{"name": "x", "requird": True}]}]}],
    ["schema", {"relations": [{"type": "X", "from": {"type": ["A"]}}]}],
    ["schema", {"relations": [{"type": "X", "to": {"max": 1}}]}],
]


def unknown_key_error(kind, value):
    """Parse a value with an unknown key and return the error message.

    @param kind (str): "facts" or "schema".
    @param value (dict): the raw input.
    @return (str): the ValidationError message.
    """
    try:
        (Extraction if kind == "facts" else Schema).model_validate(value)
    except ValidationError as exc:
        return str(exc)
    return "no error"


def neo4j_export_warnings():
    """Export a schema holding every field the Neo4j ontology cannot carry, and return what it logs.

    @return (str): the logged warning lines joined by newlines, empty when the export logs nothing.
    """
    lines: list[str] = []

    class _Sink(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(record.getMessage())

    sink = _Sink()
    logger = logging.getLogger("selfgraph")
    logger.addHandler(sink)
    try:
        Schema.model_validate(NEO4J_LOSS_SPEC).to_neo4j_ontology()
    finally:
        logger.removeHandler(sink)
    return "\n".join(lines)


def schema_warnings():
    """Validate each schema case and return its warnings as code and message pairs, plus unknown-key errors.

    @return (dict): one list of {code, message} per case, one message per unknown-key case, the schema drafted from tables, the schema term forms, the expanded tokens per question, and the fields the Neo4j export drops.
    """
    schema = Schema.model_validate(SCHEMA_SPEC)
    cases = [Extraction.model_validate(case) for case in SCHEMA_CASES]
    return {
        "warnings": [
            [
                {"code": w.code, "message": w.message}
                for w in validate_against_schema(facts, schema, graph_types=GRAPH_TYPES)
            ]
            for facts in cases
        ],
        "unknown_keys": [unknown_key_error(kind, value) for kind, value in UNKNOWN_KEY_CASES],
        "tables": to_jsonable(Schema.from_tables(TABLES, name="sales")),
        "term_forms": to_jsonable(schema_forms(Schema.model_validate(TERMS_SPEC))),
        "neo4j_dropped": neo4j_export_warnings(),
        "terms": [
            sorted(expand_tokens(_tokens(q), terms, _tokens))
            for terms in [Schema.model_validate(TERMS_SPEC)]
            for q in TERM_QUESTIONS
        ],
    }


STORES = {
    "neo4j": lambda p: __import__("selfgraph").Neo4jStore(
        os.environ.get("SG_NEO4J_URI", "bolt://localhost:7687"),
        auth=("neo4j", os.environ.get("SG_NEO4J_PASSWORD", "testpassword123")),
    ),
    "memgraph": lambda p: __import__("selfgraph").CypherStore(
        os.environ.get("SG_MEMGRAPH_URI", "bolt://localhost:7688")
    ),
    "falkordb": lambda p: __import__("selfgraph").FalkorDBStore(
        host="localhost", port=int(os.environ.get("SG_FALKOR_PORT", "6380")), graph="selfgraph_conformance"
    ),
    "hydradb": lambda p: __import__("selfgraph").HydraDBStore(
        os.environ.get("SG_HYDRADB_URI", "bolt://127.0.0.1:17688"),
        auth=("neo4j", os.environ.get("SG_HYDRADB_TOKEN", "local-dev-auth-token-32-characters-long")),
    ),
    "kuzu": lambda p: __import__("selfgraph").KuzuStore(p),
}

SUPERSEDE_SCHEMA = {
    "entities": [{"name": "Person"}, {"name": "Company"}],
    "relations": [
        {
            "type": "WORKS_AT",
            "from": {"types": ["Person"], "max_count": 1},
            "to": {"types": ["Company"], "max_count": 1},
        }
    ],
}

ZOE = ids.entity_id("Person", "Zoë Ångström")

FACTS = {
    "entities": [
        {
            "type": "Person",
            "name": "Jane Doe",
            "aliases": ["JD", "J. Doe"],
            "properties": {"title": "CTO", "score": 1.5, "tags": ["a", "é"], "meta": {"x": None, "ok": True}},
        },
        {"type": "Company", "name": "Acme, Inc.", "external_ids": {"crunchbase": "acme-inc"}},
        {"type": "Database", "name": "HydraDB"},
        {"type": "Database", "name": "Postgres"},
        {"type": "Person", "name": "Zoë Ångström"},
        {"type": "Person", "name": "राम"},
        {"type": "Person", "name": "रीमा"},
    ],
    "relations": [
        {
            "from_entity": "person:jane-doe",
            "type": "works at",
            "to_entity": "company:acme",
            "properties": {"since": 2020, "note": "x"},
        },
        {
            "from_entity": "company:acme",
            "type": "USES",
            "to_entity": "database:hydradb",
            "event_time": "2024-03-01T12:30:00.654321Z",
        },
        {"from_entity": ZOE, "type": "KNOWS", "to_entity": "person:jane-doe"},
        {"from_entity": ids.entity_id("Person", "रीमा"), "type": "रहती है", "to_entity": "database:postgres"},
    ],
    "preferences": [
        {
            "subject_entity": "person:jane-doe",
            "key": "database",
            "value_entity": "database:hydradb",
            "strength": 0.9,
            "about_entity": "company:acme",
        },
        {
            "subject_entity": "person:jane-doe",
            "stance": "disinterest",
            "key": "database",
            "value_entity": "database:postgres",
        },
    ],
    "decisions": [
        {
            "title": "Pick HydraDB",
            "actor_entity": "person:jane-doe",
            "steps": [ids.relation_id("company:acme", "USES", "database:hydradb")],
            "outcome_entity": "database:hydradb",
            "alternative_entities": ["database:postgres"],
            "rationale": "temporal history",
            "summary": "chose a graph",
        }
    ],
}

TEXT = "Grace Hopper joined Remington Rand. Grace Hopper wrote COBOL. Zoë Ångström met Ada Lovelace in 北京."


NEO4J_LOSS_SPEC = {
    "name": "conformance",
    "entities": [
        {
            "name": "Person",
            "aliases": ["Human"],
            "synonyms": ["individual"],
            "certified": True,
            "mappings": [{"source": "crm", "table": "users"}],
            "definitions": [{"name": "seniority", "expression": "count(Job)"}],
        },
        {"name": "Org"},
        {"name": "Company", "parent": "Org"},
    ],
    "relations": [
        {
            "type": "OWNS",
            "synonyms": ["holds"],
            "certified": True,
            "from": {"types": ["Person"]},
            "to": {"types": ["Company"]},
        }
    ],
}


async def write(graph):
    out = {}
    out["facts"] = to_jsonable(await graph.insert.facts(FACTS, source_id="spec"))
    out["text"] = to_jsonable(
        await graph.insert.text(TEXT, source_id="notes", metadata={"author": "conformance", "n": 1, "f": 0.5})
    )
    works_at = ids.relation_id("person:jane-doe", "WORKS_AT", "company:acme")
    out["rel_update"] = to_jsonable(
        await graph.relations.update(
            works_at, set_properties={"since": 2021, "title": "CTO"}, remove_properties=["note"]
        )
    )
    pref = ids.preference_id("person:jane-doe", "preference", "database", "database:hydradb")
    out["pref_update"] = to_jsonable(await graph.preferences.update(pref, strength=0.25))
    dec = ids.decision_id("person:jane-doe", "Pick HydraDB")
    out["dec_update"] = to_jsonable(await graph.decisions.update(dec, status="active", rationale=None))
    restated = {"title": "Pick HydraDB", "actor_entity": "person:jane-doe"}
    out["dec_restate"] = to_jsonable(await graph.insert.facts({"decisions": [restated]}))
    out["rel_restate"] = to_jsonable(
        await graph.insert.facts(
            {
                "relations": [
                    {"from_entity": "company:acme", "type": "USES", "to_entity": "database:hydradb"},
                ]
            }
        )
    )
    out["pref_restate"] = to_jsonable(
        await graph.insert.facts(
            {
                "preferences": [
                    {
                        "subject_entity": "person:jane-doe",
                        "key": "database",
                        "value_entity": "database:hydradb",
                    }
                ]
            }
        )
    )
    out["ent_update"] = to_jsonable(
        await graph.entities.update("company:acme", aliases=["ACME", "Acme Co"], properties={"hq": "Paris", "n": 3})
    )
    out["ent_type_case"] = to_jsonable(
        await graph.insert.facts({"entities": [{"type": "company", "name": "Acme, Inc."}]})
    )
    out["rel_create"] = to_jsonable(
        await graph.relations.create(
            "thing:grace-hopper",
            "PIONEERED",
            "thing:cobol",
            properties={"year": 1959},
            event_time=datetime(1959, 5, 28, 9, 0, 0, 123456, tzinfo=timezone.utc),
            evidence=[
                EvidenceInput(source_id="manual", quote="wrote COBOL", start_offset=1, end_offset=5, confidence=0.75)
            ],
        )
    )
    out["rel_evidence"] = to_jsonable(
        await graph.relations.update(
            ids.relation_id("thing:grace-hopper", "PIONEERED", "thing:cobol"),
            evidence=[EvidenceInput(source_id="manual2", quote="again", confidence=0.5)],
        )
    )
    await graph.entities.create("Temp Thing", "Thing", properties={"k": "v"})
    await graph.relations.create(
        "thing:temp-thing",
        "TOUCHES",
        "company:acme",
        id="relation:touch-a",
        properties={"active": 1, "flags": [False], "count": 1},
    )
    await graph.relations.create(
        "thing:temp-thing",
        "TOUCHES",
        "company:acme",
        id="relation:touch-b",
        properties={"active": True, "flags": [0], "count": 1.0},
    )
    out["dedupe_conflicts"] = (await graph.maintenance.dedupe_relations()).groups[0].conflicts
    await graph.preferences.create("thing:temp-thing", "color", "company:acme", strength=1.0)
    try:
        await graph.entities.create("Unsafe", "Thing", properties={"n": 2**53})
        out["unsafe_integer"] = "accepted"
    except ValidationError as exc:
        out["unsafe_integer"] = str(exc)
    out["ent_delete"] = to_jsonable(await graph.entities.delete("thing:temp-thing"))
    out["rel_delete"] = to_jsonable(await graph.relations.delete(ids.relation_id(ZOE, "KNOWS", "person:jane-doe")))
    out["repeated_merges"] = {}
    first = {
        "type": "Person",
        "name": "Bob",
        "aliases": ["Bobby"],
        "external_ids": {"crm": "C1"},
        "properties": {"one": 1},
    }
    later = {
        "type": "Person",
        "name": "Bob",
        "aliases": ["Robbie"],
        "external_ids": {"crm": "C2"},
        "properties": {"two": 2},
    }
    for mode, batches in (("one_insert", [[first, later]]), ("across_inserts", [[first], [later]])):
        resolved = SelfGraph(store=graph.store, namespace=f"{graph.namespace}_{mode}", resolver="default")
        await resolved.insert.facts(
            {"entities": [{"type": "Person", "name": "Robert", "aliases": ["Bob"], "properties": {"one": 0}}]}
        )
        for batch in [*batches, batches[-1]]:
            await resolved.insert.facts({"entities": batch})
        record = (await resolved.entities.merges("person:robert")).items[0]
        merged = await resolved.entities.get("person:robert")
        restored = await resolved.entities.unmerge(record.id)
        out["repeated_merges"][mode] = to_jsonable(
            {"absorbed": record.absorbed, "merged": merged, "restored": restored.entity, "survivor": restored.survivor}
        )
    out["retrieval_overflow"] = await overflow(graph)
    return out


async def supersede(graph):
    """Supersede relations capped at both endpoints, with facts arriving out of order across batches.

    Two facts then move to an earlier time, one restated by an insert and one through relations.update, so each
    stops displacing the relation it retired.

    @param graph (SelfGraph): a graph with a two-sided max_count schema and contradiction="supersede".
    @return (dict): each relation's versions, newest first, and the warning codes of each insert, before and after
        the moves.
    """
    people = [{"type": "Person", "name": n} for n in ("Ann", "Bob")]
    companies = [{"type": "Company", "name": n} for n in ("Acme", "Globex", "Initech")]
    await graph.insert.facts({"entities": [*people, *companies]})

    def link(person, company, year):
        return {
            "from_entity": f"person:{person}",
            "type": "WORKS_AT",
            "to_entity": f"company:{company}",
            "event_time": datetime(year, 1, 1, tzinfo=timezone.utc),
        }

    batches = [
        [link("ann", "acme", 2020)],
        [link("ann", "initech", 2026)],
        [link("ann", "globex", 2024), link("bob", "acme", 2022)],
    ]
    out = {"warnings": []}
    for batch in batches:
        result = await graph.insert.facts({"relations": batch})
        out["warnings"].append([w.code for w in result.warnings])

    async def versions():
        rows = {}
        for person, company in (("ann", "acme"), ("ann", "globex"), ("ann", "initech"), ("bob", "acme")):
            rid = ids.relation_id(f"person:{person}", "WORKS_AT", f"company:{company}")
            rows[rid] = [
                [
                    v.revision,
                    v.is_current,
                    v.invalidated_by,
                    _serde.json_iso(v.invalidated_at) if v.invalidated_at else None,
                ]
                for v in await graph.relations.versions(rid)
            ]
        return rows

    out["versions"] = await versions()
    restated = await graph.insert.facts({"relations": [link("ann", "initech", 2023)]})
    globex = ids.relation_id("person:ann", "WORKS_AT", "company:globex")
    updated = await graph.relations.update(globex, event_time=datetime(2021, 1, 1, tzinfo=timezone.utc))
    out["moved"] = {
        "warnings": [w.code for w in restated.warnings],
        "updated": [updated.revision, updated.is_current, updated.invalidated_by],
        "versions": await versions(),
    }
    return out


async def overflow(graph):
    """Retrieve under a budget where a near line fits, the next overflows under any counter, and short lines remain.

    @param graph (SelfGraph): the conformance graph, whose store holds a separate namespace for this case.
    @return (dict): the context at the tight budget and at the default one.
    """
    g = SelfGraph(store=graph.store, namespace=f"{graph.namespace}_budget")
    for name in ("Ann", "Bob", "Cid"):
        await g.entities.create(name, "Person", id=f"person:{name.lower()}")
    await g.relations.create("person:ann", "KNOWS", "person:bob")
    await g.relations.create("person:bob", "KNOWS", "person:cid", properties={"note": "met at the old harbour " * 20})
    tight = await g.retrieve("Ann", k=1, depth=2, budget_tokens=12)
    full = await g.retrieve("Ann", k=1, depth=2)
    return {"tight": tight.context, "full": full.context}


async def all_evidence(list_fn, oid):
    """Read every page of an entity's or relation's evidence, two items at a time.

    @param list_fn (Callable): entities.evidence or relations.evidence.
    @param oid (str): the entity or relation id.
    @return (list): all the evidence.
    """
    out, cursor = [], None
    while True:
        page = await list_fn(oid, cursor=cursor, limit=2)
        out.extend(page.items)
        if page.next_cursor is None:
            return out
        cursor = page.next_cursor


async def dump(graph, ns):
    store = graph.store
    entities = [e async for e in graph.entities.iterate(limit=3)]
    relations = {}
    async for r in graph.relations.iterate(limit=3):
        relations[r.id] = await graph.relations.versions(r.id, newest_first=False)
    preferences = {}
    for e in entities:
        preferences[e.id] = [p async for p in graph.preferences.iterate(e.id)]
    preference_versions = {
        p.id: await graph.preferences.versions(p.id, newest_first=False) async for p in graph.preferences.iterate()
    }
    sources = await store.match_nodes(ns, "Source")
    decisions = [d async for d in graph.decisions.iterate()]
    raw_entities = {e.id: await store.get_node(ns, "Entity", e.id) for e in entities}
    evidence = {e.id: await all_evidence(graph.entities.evidence, e.id) for e in entities}
    evidence.update({rid: await all_evidence(graph.relations.evidence, rid) for rid in relations})
    raw_evidence = await store.match_nodes(ns, "Evidence")
    source_versions = await store.match_nodes(ns, "SourceVersion")
    chunks = {
        sv["id"]: await store.child_nodes(ns, "SourceVersion", sv["id"], "HAS_CHUNK", "Chunk", order_by="index")
        for sv in source_versions
    }
    retrieval = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", depth=2)
    ppr = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", strategy="ppr", depth=3, max_nodes=4)
    dfs = await graph.retrieve("Zoë ÅNGSTRÖM acme", strategy="dfs", depth=2)
    marks = await graph.retrieve("रीमा कहाँ रहती है?", depth=1)
    tight = {
        walk: await graph.retrieve("Grace Hopper COBOL Jane acme", strategy=walk, k=1, depth=4, max_nodes=3)
        for walk in ("bfs", "dfs")
    }
    termed = SelfGraph(store=store, namespace=ns, schema=TERMS_SPEC, extraction="regex")
    answerable = [await termed.check_answerable(q) for q in TERM_QUESTIONS]
    seeded = {
        tier: await termed.retrieve("which employers hired staff members named Hopper", seeds=tier, depth=0)
        for tier in ("bm25", "synonyms")
    }
    pruned = await termed.maintenance.prune(older_than=datetime.now(timezone.utc), types=["User", "DATABASE"])
    return to_jsonable(
        {
            "answerable": answerable,
            "prune_types": pruned,
            "retrieval_seeded": {tier: {"seeds": r.seeds, "tiers": r.tiers} for tier, r in seeded.items()},
            "tiers": termed.tiers,
            "entities": sorted(entities, key=lambda e: e.id),
            "relations": dict(sorted(relations.items())),
            "preferences": preferences,
            "preference_versions": dict(sorted(preference_versions.items())),
            "sources": sorted(sources, key=lambda s: s["id"]),
            "decisions": decisions,
            "raw_entities": raw_entities,
            "evidence": evidence,
            "raw_evidence": sorted(raw_evidence, key=lambda r: r["id"]),
            "source_versions": sorted(source_versions, key=lambda s: s["id"]),
            "chunks": dict(sorted(chunks.items())),
            "retrieval": {"seeds": retrieval.seeds, "context": retrieval.context},
            "retrieval_ppr": {
                "seeds": ppr.seeds,
                "context": ppr.context,
                "entities": [e.id for e in ppr.subgraph.entities],
            },
            "retrieval_dfs": {"seeds": dfs.seeds, "context": dfs.context},
            "retrieval_marks": {"seeds": marks.seeds, "context": marks.context},
            "retrieval_tight": {
                walk: {
                    "entities": [e.id for e in r.subgraph.entities],
                    "relations": [x.id for x in r.subgraph.relations],
                }
                for walk, r in tight.items()
            },
        }
    )


async def main():
    cmd = sys.argv[1]
    if cmd == "schema":
        json.dump(schema_warnings(), sys.stdout, sort_keys=True, ensure_ascii=False)
        return
    store_name, ns = sys.argv[2], sys.argv[3]
    kuzu_path = sys.argv[4] if len(sys.argv) > 4 else None
    options = {"schema": SUPERSEDE_SCHEMA, "contradiction": "supersede"} if cmd == "supersede" else {}
    graph = SelfGraph(store=STORES[store_name](kuzu_path), namespace=ns, **options)
    try:
        await graph.initialize()
        if cmd == "supersede":
            result = await supersede(graph)
        else:
            result = await write(graph) if cmd == "write" else await dump(graph, ns)
    finally:
        await graph.close()
    json.dump(result, sys.stdout, sort_keys=True, ensure_ascii=False)


if __name__ == "__main__":
    asyncio.run(main())
