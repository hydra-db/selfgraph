import asyncio
import json
import os
import sys
from datetime import datetime, timezone

from selfgraph import EvidenceInput, SelfGraph, ids
from selfgraph.runtime import to_jsonable

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

ZOE = ids.entity_id("Person", "Zoë Ångström")

ONTOLOGY = {
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
            "kind": "disinterest",
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


async def write(graph):
    out = {}
    out["ontology"] = to_jsonable(await graph.insert.ontology(ONTOLOGY, source_id="spec"))
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
    out["ent_update"] = to_jsonable(
        await graph.entities.update("company:acme", aliases=["ACME", "Acme Co"], properties={"hq": "Paris", "n": 3})
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
    await graph.entities.create("Temp Thing", "Thing", properties={"k": "v"})
    await graph.relations.create("thing:temp-thing", "TOUCHES", "company:acme")
    await graph.preferences.create("thing:temp-thing", "color", "company:acme", strength=1.0)
    out["ent_delete"] = to_jsonable(await graph.entities.delete("thing:temp-thing"))
    out["rel_delete"] = to_jsonable(await graph.relations.delete(ids.relation_id(ZOE, "KNOWS", "person:jane-doe")))
    return out


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
    source_versions = await store.match_nodes(ns, "SourceVersion")
    chunks = {
        sv["id"]: await store.child_nodes(ns, "SourceVersion", sv["id"], "HAS_CHUNK", "Chunk", order_by="index")
        for sv in source_versions
    }
    retrieval = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", depth=2)
    ppr = await graph.retrieve("what did Grace Hopper write about COBOL and Jane", strategy="ppr", depth=3, max_nodes=4)
    dfs = await graph.retrieve("Zoë ÅNGSTRÖM acme", strategy="dfs", depth=2)
    tight = {
        walk: await graph.retrieve("Grace Hopper COBOL Jane acme", strategy=walk, k=1, depth=4, max_nodes=3)
        for walk in ("bfs", "dfs")
    }
    return to_jsonable(
        {
            "entities": sorted(entities, key=lambda e: e.id),
            "relations": dict(sorted(relations.items())),
            "preferences": preferences,
            "preference_versions": dict(sorted(preference_versions.items())),
            "sources": sorted(sources, key=lambda s: s["id"]),
            "decisions": decisions,
            "raw_entities": raw_entities,
            "source_versions": sorted(source_versions, key=lambda s: s["id"]),
            "chunks": dict(sorted(chunks.items())),
            "retrieval": {"seeds": retrieval.seeds, "context": retrieval.context},
            "retrieval_ppr": {
                "seeds": ppr.seeds,
                "context": ppr.context,
                "entities": [e.id for e in ppr.subgraph.entities],
            },
            "retrieval_dfs": {"seeds": dfs.seeds, "context": dfs.context},
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
    cmd, store_name, ns = sys.argv[1], sys.argv[2], sys.argv[3]
    kuzu_path = sys.argv[4] if len(sys.argv) > 4 else None
    graph = SelfGraph(store=STORES[store_name](kuzu_path), namespace=ns)
    try:
        await graph.initialize()
        result = await write(graph) if cmd == "write" else await dump(graph, ns)
    finally:
        await graph.close()
    json.dump(result, sys.stdout, sort_keys=True, ensure_ascii=False)


if __name__ == "__main__":
    asyncio.run(main())
