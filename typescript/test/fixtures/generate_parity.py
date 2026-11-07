import json
import sys
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel
from selfgraph import _serde, ids
from selfgraph.extraction import chunking
from selfgraph.extraction.basic import _regex_extract
from selfgraph.extraction.extractor import DefaultExtractor, _is_noise_name
from selfgraph.mcp.server import _is_blocked_query
from selfgraph.models import Entity, Evidence, Relation
from selfgraph.resources._common import encode_cursor
from selfgraph.retrieval import _fold, _format_props, _grep_score, _ppr_rank, _select_seeds, _tokens
from selfgraph.stores.hydradb import _sk

NAMES = [
    "Acme",
    "Acme, Inc.",
    "The Acme Corporation",
    "  Jane   Doe ",
    "Zoë Ångström",
    "北京大学",
    "🚀 Rocket Co",
    "O'Reilly Media LLC",
    "the",
    "Co",
    "AT&T",
    "x​y",
    "a﻿b",
    "Tab\tSeparated\x1cName",
    "İstanbul",
    "ΣΊΣΥΦΟΣ",
    "",
    "   ",
    "Group Holdings",
    "acme  llc  ltd",
    "Cafe\u0301 Ole\u0301",
    "Café Olé",
    "हिन्दी विकिपीडिया",
    "The Trial",
    "The Acme Corporation Inc",
    "snake_case_name",
    "Ａｃｍｅ",
]
TYPES = [
    "Person",
    "Big Company",
    "  Org ",
    "ÜberType",
    "a\u3000b",
    "Company",
    "Organization",
    "Work",
    " Bank ",
    "U\u0308ber",
]
REL_TYPES = [
    "works at",
    "WORKS_AT",
    "Works-At!!",
    " _founded_ ",
    "élève de",
    "e\u0301le\u0300ve de",
    "🔥hot",
    "a__b",
    "Kelvin\u212a",
    "straße",
    "!!!",
    "   ",
]
BAD_STRINGS = ["tab\there", "nul\x00", "del\x7f", "c1\x85", "lone\ud800"]
LABELS = ["Entity", "Big Company", "has`tick", "_x9", "9x", "Ünicode"]

JSON_VALUES = [
    {"b": 1, "a": [1, 2.5, None, True], "c": {"z": "é", "y": "🚀"}},
    {"ctrl": 'a\x00b\x1f\x7f\n\t"\\', "big": 9007199254740991, "f": 1e-05, "g": 1e16, "h": 0.1, "neg": -2.5e-07},
    [],
    {},
    {"10": 1, "2": 2, "x": 3},
    "line sep",
    [1.5, 100.25, 3.14159, 2.0e-7, 123456789.125],
]

FLOATS = [0.1, 1.5, 100.0, 1e16, 1e15, 1.2345e-5, 0.0001, 0.00001, 123456789.123, -0.5, 1e300, 5e-324, 2.5e-07]

DATETIMES = [
    datetime(2026, 11, 6, 10, 0, 0, tzinfo=timezone.utc),
    datetime(2026, 11, 6, 10, 0, 0, 123456, tzinfo=timezone.utc),
    datetime(2026, 11, 6, 10, 0, 0, 123000, tzinfo=timezone.utc),
    datetime(1999, 1, 2, 3, 4, 5, 6, tzinfo=timezone.utc),
    datetime(2026, 1, 1, 0, 0, tzinfo=timezone(timedelta(hours=5, minutes=30))),
    datetime(800, 5, 5, 5, 5, 5, tzinfo=timezone.utc),
]

ISO_INPUTS = [
    "2026-11-06T10:00:00+00:00",
    "2026-11-06T10:00:00.123456+00:00",
    "2026-11-06T10:00:00Z",
    "2026-11-06T10:00:00",
    "2026-11-06",
    "2026-11-06T10:00:00.5-02:30",
    "2026-11-06 10:00:00.1234567+00:00",
]

TEXTS = [
    "Jane Doe works at Acme. She met Bob Smith in Paris! Then Acme Corp hired Carol.",
    "Zoë Ångström visited São Paulo. Émile Zola wrote books.",
    "no capitals here at all",
    "Apple Inc. and Microsoft Corp. compete. 3M Company too? Yes. NASA launched Apollo 11.",
    "🚀 Rocket Labs launched from New Zealand. The Team cheered.",
    "He met She. They saw It, This! Those were Acme's. Neo4j and S3 work with GPT-4.",
    "The rain fell. A Storm hit Paris; Berlin, Rome: Madrid! Done?",
]

PROPS = [
    {},
    {
        "since": 2020,
        "role": "CTO",
        "active": True,
        "ratio": 1.5,
        "none": None,
        "tags": ["a", "b"],
        "nested": {"k": "it's"},
    },
]


class _Dump(BaseModel):
    when: datetime


def dt_case(dt):
    return {"iso": _serde.to_iso(dt), "str": str(dt), "pydantic": _Dump(when=dt).model_dump(mode="json")["when"]}


def attempt(fn, *args):
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001
        return {"error": type(exc).__name__}


CYPHER = [
    "MATCH (n) RETURN n",
    "match (n:Entity) where n.ns = $ns return n.id as id",
    "OPTIONAL MATCH (n) RETURN n",
    "WITH 1 AS x RETURN x",
    "UNWIND [1,2] AS x RETURN x",
    "RETURN 1",
    "  \n RETURN 1",
    "SHOW INDEXES",
    "EXPLAIN MATCH (n) RETURN n",
    "PROFILE MATCH (n) RETURN n",
    "CREATE (n) RETURN n",
    "MATCH (n) DETACH DELETE n",
    "MATCH (n) SET n.x = 1",
    "MERGE (n:X) RETURN n",
    "MATCH (n) REMOVE n.x",
    "DROP CONSTRAINT x",
    "CALL db.labels()",
    "MATCH (n) CALL { CREATE (m) } RETURN n",
    "MATCH (n) FOREACH (x IN [1] | CREATE (m))",
    "LOAD CSV FROM 'x' AS row RETURN row",
    "BEGIN",
    "TERMINATE TRANSACTIONS 'x'",
    "MATCH (n) WHERE n.name = 'CREATE' RETURN n",
    'MATCH (n) WHERE n.name = "DELETE it" RETURN n',
    "MATCH (n) RETURN n.set AS set",
    "MATCH (n:Create) RETURN n",
    "MATCH (n) RETURN n AS create",
    "MATCH (n) RETURN {merge: 1, delete: 2} AS m",
    "MATCH (n) WHERE n.x = $create RETURN n",
    "MATCH (n) /* CREATE */ RETURN n",
    "MATCH (n) // DELETE\nRETURN n",
    "MATCH (n) // DELETE\u2028CREATE (m) RETURN n",
    "MATCH (n) RETURN n // trailing comment CREATE",
    "MATCH (`CREATE` {x: 1}) RETURN 1",
    "MATCH (n) WHERE n.x = 'it\\'s CREATE' RETURN n",
    "MATCH (n) WHERE n.x = 'unterminated CREATE (m)",
    "MATCH (n) /* unterminated CREATE",
    "MATCH (n) RETURN n; CREATE (m)",
    "USE other MATCH (n) RETURN n",
    "MATCH (n) RETURN n UNION MATCH (m) CREATE (x) RETURN m",
    "",
    "   ",
    "foo",
]


FUZZ_ATOMS = [
    "MATCH",
    "match",
    "RETURN",
    "CREATE",
    "create",
    "CrEaTe",
    "\u017fet",
    "SET",
    "DELETE",
    "DETACH",
    "MERGE",
    "CALL",
    "WITH",
    "UNWIND",
    "OPTIONAL",
    "AS",
    "as",
    "USE",
    "LOAD",
    "(n)",
    "(n:Label)",
    "(`CREATE`)",
    "{create: 1}",
    "{a:1, set: 2}",
    "n.set",
    ":Create",
    "$create",
    "'CREATE'",
    '"DELETE"',
    "'it\\'s'",
    "'unterminated",
    '"unterm',
    "`bt``x`",
    "/* CREATE */",
    "/* open",
    "// DELETE\n",
    "// x\u2028",
    "// x\u2029CREATE",
    "\u0085",
    "\n",
    " ",
    "\t",
    "\x1c",
    ";",
    "UNION",
    "SHOW",
    "EXPLAIN",
    "PROFILE",
    "TERMINATE",
    "BEGIN",
    "\u00e9CREATE",
    "CREATE\u00e9",
    "_CREATE",
    "\u212aeep",
    "x",
    "[1,2]",
    "FOREACH",
    "COPY",
    "WHERE",
    "n.x = 1",
    "-->",
    "\x00",
]


def cypher_fuzz():
    import random

    rng = random.Random(7)
    out = {}
    while len(out) < 1000:
        q = "".join(rng.choice([" ", "", "  "]) + rng.choice(FUZZ_ATOMS) for _ in range(rng.randint(0, 9)))
        out[q] = _is_blocked_query(q)
    return out


FOLD_TEXTS = [
    "Straße STRASSE",
    "ǅ ǆ Ǆ",
    "ΣΊΣΥΦΟΣ σίσυφος ς",
    "ꭰꭱ ᏸ Ᏸ",
    "İstanbul ı",
    "ﬃ ﬁ ﬀ",
    "Café Cafe\u0301",
    "世界 東京タワー",
    "Ｆｕｌｌ",
    "हिन्दी",
    "n x y Z 3 a_b c-d",
    "K Kelvin\u212a Å\u212b",
    "ŉ ǰ ΐ",
]
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def ent(eid, name, sources=(), aliases=(), props=None):
    ev = [Evidence(source_id=s, source_version=f"{s}:v") for s in sources]
    return Entity(
        id=eid,
        type="Thing",
        name=name,
        aliases=list(aliases),
        properties=props or {},
        evidence=ev,
        created_at=T0,
        updated_at=T0,
    )


def rel(a, b, sources=(), rid=None):
    ev = [Evidence(source_id=s, source_version=f"{s}:v") for s in sources]
    return Relation(
        id=rid or f"r:{a}>{b}",
        revision=1,
        from_entity=a,
        type="R",
        to_entity=b,
        created_at=T0,
        is_current=True,
        evidence=ev,
    )


SEED_ENTITIES = [
    ent("t:acme", "Acme", sources=["s1", "s2", "s3", "s4", "s5"]),
    ent("t:acme-labs", "Acme Labs", sources=["s1"]),
    ent("t:tokyo", "東京タワー", sources=["s2"]),
    ent("t:cafe", "Café Olé", aliases=["Cafe"], sources=[]),
    ent("t:n", "N", sources=["s1"]),
    ent("t:strasse", "Hauptstraße", props={"city": "Berlin"}),
]
SEED_QUERIES = ["acme", "acme labs", "東京", "café", "n", "STRASSE berlin", "a", "nothing here"]

PPR_GRAPHS = {
    "chain": ([("a", 1.0)], ["a", "b", "c", "d"], [rel("a", "b"), rel("b", "c"), rel("c", "d")]),
    "star_ties": (
        [("hub", 2.0)],
        ["hub", "x", "y", "z", "w"],
        [rel("hub", "x"), rel("hub", "y"), rel("hub", "z"), rel("w", "hub")],
    ),
    "weighted": (
        [("a", 1.0), ("e", 0.5)],
        ["a", "b", "c", "d", "e"],
        [rel("a", "b", ["s1", "s2", "s3"]), rel("a", "c"), rel("b", "d"), rel("c", "d"), rel("d", "e", ["s1", "s1"])],
    ),
    "isolated": ([("a", 1.0), ("q", 1.0)], ["a", "b", "q", "lone"], [rel("a", "b")]),
    "self_loop": ([("a", 1.0)], ["a", "b"], [rel("a", "a"), rel("a", "b")]),
    "no_seed_mass": ([("zz", 1.0)], ["b", "a", "c"], [rel("a", "b")]),
    "two_seeds_tie": (
        [("a", 1.0), ("b", 1.0)],
        ["a", "b", "m", "n2"],
        [rel("a", "m"), rel("b", "m"), rel("a", "n2"), rel("b", "n2")],
    ),
}


def ppr_cases():
    out = {}
    for name, (seeds, nodes, rels) in PPR_GRAPHS.items():
        seed_objs = [(ent(i, i), s) for i, s in seeds]
        out[name] = {
            "seeds": [[i, s] for i, s in seeds],
            "nodes": nodes,
            "relations": [r.model_dump(mode="json") for r in rels],
            "ranks": _ppr_rank(seed_objs, nodes, rels),
        }
    return out


def chunk_cases():
    long_text = (
        "Alpha beta gamma delta. " * 40
        + "Emoji 🚀 rockets and café au lait. " * 30
        + "\n\nNew paragraph with Ünïcödé text and more words to split on whitespace. " * 25
    )
    by_chars = [c.__dict__ for c in chunking._chunk_by_chars(long_text, size=200, overlap=40)]
    by_tokens = [c.__dict__ for c in chunking.chunk_text(long_text, max_tokens=64, overlap_tokens=8)]
    return {
        "text": long_text,
        "by_chars": by_chars,
        "by_tokens": by_tokens,
        "count_tokens": [chunking.count_tokens(t) for t in TEXTS],
    }


def extract_cases():
    out = []
    for text in TEXTS:
        entities, relations = _regex_extract(text)
        ontology = DefaultExtractor._assemble(entities, relations, [], [])
        out.append({"text": text, "ontology": ontology.model_dump(mode="json")})
    return out


def main():
    out = {
        "slug": {t: attempt(ids.slug, t) for t in TYPES + NAMES},
        "entity_id": [[t, n, attempt(ids.entity_id, t, n)] for t in TYPES for n in NAMES],
        "normalize_rel_type": {t: ids.normalize_rel_type(t) for t in REL_TYPES if t.strip(" !")},
        "relation_id": [
            ["person:jane", t, "company:acme", ids.relation_id("person:jane", t, "company:acme")]
            for t in REL_TYPES
            if t.strip(" !")
        ],
        "preference_id": [
            [s, k, key, v, ids.preference_id(s, k, key, v)]
            for s, k, key, v in [
                ("person:jane", "preference", "database", "db:hydradb"),
                ("x", "disinterest", "", "🚀"),
            ]
        ],
        "decision_id": [
            [a, t, ids.decision_id(a, t)]
            for a, t in [(None, "Pick DB"), ("", "Pick DB"), ("person:jane", "Pick DB"), ("a", "bc"), ("ab", "c")]
        ],
        "source_version_id": ids.source_version_id("notes", "abc"),
        "source_node_id": ids.source_node_id("notes"),
        "bad_strings": {
            b: [attempt(ids.entity_id, "Person", b), attempt(ids.normalize_rel_type, b)] for b in BAD_STRINGS
        },
        "rel_type_errors": {t: attempt(ids.normalize_rel_type, t) for t in REL_TYPES},
        "nfc_ids": [
            ids.preference_id("person:jane", "preference", "cafe\u0301", "x:y"),
            ids.preference_id("person:jane", "preference", "café", "x:y"),
            ids.decision_id(None, "Cafe\u0301"),
            ids.decision_id(None, "Café"),
        ],
        "cursors": {str(n): encode_cursor(n) for n in [0, 1, 50, 999, 123456789]},
        "cypher_blocked": {q: _is_blocked_query(q) for q in CYPHER},
        "cypher_fuzz": cypher_fuzz(),
        "content_hash": {t: ids.content_hash(t.encode("utf-8")) for t in TEXTS},
        "quote_label": {label: ids.quote_label(label) for label in LABELS},
        "dumps_sorted": [[v, _serde._dumps(v)] for v in JSON_VALUES],
        "dumps_default": [[v, json.dumps(v, default=str)] for v in JSON_VALUES],
        "float_repr": [[f, repr(f)] for f in FLOATS],
        "datetimes": [dt_case(dt) for dt in DATETIMES],
        "from_iso": {s: _serde.to_iso(_serde.from_iso(s)) for s in ISO_INPUTS},
        "format_props": [[p, _format_props(p)] for p in PROPS],
        "tokens": {t: sorted(_tokens(t)) for t in TEXTS + FOLD_TEXTS},
        "fold": {t: _fold(t) for t in FOLD_TEXTS},
        "grep": [
            [sorted(_tokens(q)), _fold(t), _grep_score(_tokens(q), _fold(t))]
            for q in SEED_QUERIES
            for t in ["acme labs inc", "東京タワー", "n"]
        ],
        "seed_entities": [e.model_dump(mode="json") for e in SEED_ENTITIES],
        "seeds": {
            q: [[e.id, round(s, 12)] for e, s in _select_seeds(SEED_ENTITIES, _tokens(q), 20)] for q in SEED_QUERIES
        },
        "ppr": ppr_cases(),
        "noise": {
            n: _is_noise_name(n)
            for n in [
                "3M",
                "$5",
                "Apollo 11",
                "one two three four five six seven",
                "abc 12 34",
                "Jane",
                "Neo4j",
                "S3",
                "GPT-4",
                "42",
                "3.14",
                "  ",
                "$$$",
                "北京",
                "١٢٣",
            ]
        },
        "sk": [
            [ns, sid, str(_sk(ns, sid))]
            for ns, sid in [("default", "person:jane"), ("x", "🚀"), ("default", "a|WORKS_AT|b|None|None")]
        ],
        "chunks": chunk_cases(),
        "extract": extract_cases(),
    }
    json.dump(out, sys.stdout, ensure_ascii=True, indent=1)


if __name__ == "__main__":
    main()
