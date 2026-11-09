import json
import sys
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel

from selfgraph import _serde, ids
from selfgraph._maintenance import relevance_score
from selfgraph._ops import Contradictions, version_as_of
from selfgraph.extraction import chunking
from selfgraph.extraction.basic import _regex_extract
from selfgraph.extraction.extractor import DefaultExtractor, _is_noise_name, _RelOut
from selfgraph.mcp.server import _is_blocked_query
from selfgraph.models import Entity, EntityInput, Evidence, Preference, Relation
from selfgraph.resolution import DefaultResolver, distinct_names, jaro_winkler, name_similarity, token_jaccard
from selfgraph.resources._common import encode_cursor
from selfgraph.retrieval import _fold, _format_props, _grep_score, _ppr_rank, _select_seeds, _tokens
from selfgraph.schema import Schema, contradiction_caps
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
    "worksAt",
    "WorksAt",
    "HTTPServer",
    "isPartOf2Things",
    "already_SNAKE_case",
    "ÉcoleDe",
]
ENTITY_ID_INPUTS = [
    "T:X",
    "t:x",
    " Person : Jane  Doe ",
    "Person:Cafe\u0301",
    "PERSON:Café Olé",
    "doc:A:B",
    "Big Company:Acme, Inc.",
    "İstanbul:ΣΊΣΥΦΟΣ",
    "no-colon",
    ":x",
    "x:",
    "person: ",
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
    "MATCH (n) WITH n LIMIT 1 INSERT (m:X) RETURN 1",
    "WITH 1 AS x \\u0043REATE (m:X) RETURN 1",
    "WITH 1 AS x \\U00000043REATE (m:X) RETURN 1",
    "WITH 1 AS x // \\u000a CREATE (m:X) RETURN 1",
    "WITH 1 AS x /* \\u002a/ CREATE (m:X) /* */ RETURN 1",
    "MATCH (n) WHERE n.x = 'a\\u0027 CREATE (m:X) //' RETURN 1",
    "RETURN `a\\u0060 AS y",
    "RETURN '\\\\\\u0027' AS x",
    "RETURN '\\\\u0027' AS x",
    "MATCH (n) WHERE n.path = 'C:\\\\users' RETURN n",
    "WITH 1 AS x \\ CREATE (m:X) RETURN 1",
    "UNWIND [1] AS as WITH as CREATE (m:X) RETURN 1",
    "MATCH (n) WHERE n:as CREATE (m:X) RETURN 1",
    "MATCH (n) RETURN n AS `create`",
    "SHOW TRANSACTIONS YIELD transactionId AS t TERMINATE TRANSACTIONS t YIELD transactionId AS z RETURN z",
    "RETURN 1; ANALYZE GRAPH",
    "RETURN 1; MATCH (n) RETURN n;",
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
    "INSERT",
    "TERMINATE",
    "as",
    "\\u0043REATE",
    "\\\\u",
    "\\",
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
EVIDENCE_KEY = ("source_id", "source_version", "chunk_id", "quote", "start_offset", "end_offset")
EVIDENCE_CASES = [
    ("person:jane", Evidence(source_id="notes", source_version="sv:abc")),
    ("person:jane", Evidence(source_id="notes", source_version="sv:abc", chunk_id="sv:abc:chunk:0")),
    (
        "relation:r1",
        Evidence(source_id="m", source_version="m:manual", quote="Zoë 北京 🚀", start_offset=0, end_offset=12),
    ),
    ("relation:r1", Evidence(source_id="m", source_version="m:manual", quote="", start_offset=None, end_offset=0)),
    ("t:x", Evidence(source_id="a", source_version="bc", confidence=0.5)),
]


def ent(eid, name, sources=(), aliases=(), props=None):
    return Entity(
        id=eid,
        type="Thing",
        name=name,
        aliases=list(aliases),
        properties=props or {},
        source_count=len(set(sources)),
        created_at=T0,
        updated_at=T0,
    )


def rel(a, b, sources=(), rid=None):
    return Relation(
        id=rid or f"r:{a}>{b}",
        revision=1,
        from_entity=a,
        type="R",
        to_entity=b,
        created_at=T0,
        is_current=True,
        source_count=len(set(sources)),
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


EPOCH = datetime(2024, 1, 1, tzinfo=timezone.utc)


def day(n, micros=0):
    return EPOCH + timedelta(days=n, microseconds=micros)


def version(revision, created, *, event=None, invalidated=None, by=None, rid="relation:r", ends=None):
    """Build a relation version for the temporal cases.

    @param revision (int): the revision.
    @param created (datetime): the creation time.
    @param event (datetime | None): the event time.
    @param invalidated (datetime | None): when a contradiction retired it.
    @param by (str | None): the superseding relation id.
    @param rid (str): the relation id.
    @param ends (tuple[str, str, str] | None): (from, type, to), default person:ann WORKS_AT company:acme.
    @return (Relation): the version.
    """
    frm, rtype, to = ends or ("person:ann", "WORKS_AT", "company:acme")
    return Relation(
        id=rid,
        revision=revision,
        from_entity=frm,
        type=rtype,
        to_entity=to,
        event_time=event,
        created_at=created,
        is_current=invalidated is None,
        invalidated_at=invalidated,
        invalidated_by=by,
    )


AS_OF_CASES = {
    "revisions": ([version(1, day(0)), version(2, day(10))], [-1, 0, 5, 10, 20]),
    "invalidated": ([version(1, day(0), invalidated=day(5), by="relation:x")], [4, 5, 6]),
    "reasserted": (
        [version(1, day(0), invalidated=day(5), by="relation:x"), version(2, day(8))],
        [4, 6, 8, 9],
    ),
    "backdated": (
        [version(1, day(0)), version(2, day(10), event=day(-3), invalidated=day(20), by="relation:x")],
        [-4, -2, 1, 15, 25],
    ),
    "tie": ([version(1, day(1), event=day(0)), version(2, day(2), event=day(0))], [0]),
    "unsorted": ([version(2, day(10)), version(1, day(0))], [5, 10]),
}


def as_of_cases():
    out = {}
    for name, (versions, probes) in AS_OF_CASES.items():
        picked = {}
        for probe in probes:
            for micros in (-1, 0):
                at = day(probe, micros)
                got = version_as_of(versions, at)
                picked[_serde.to_iso(at)] = None if got is None else got.revision
        out[name] = {"versions": [v.model_dump(mode="json") for v in versions], "picked": picked}
    pref = Preference(
        id="preference:p",
        revision=1,
        profile_id="profile:x",
        subject_entity="person:ann",
        kind="preference",
        key="db",
        value_entity="db:x",
        created_at=day(0),
        is_current=True,
    )
    out["preference"] = {
        "versions": [pref.model_dump(mode="json")],
        "picked": {_serde.to_iso(day(n)): getattr(version_as_of([pref], day(n)), "revision", None) for n in (-1, 0)},
    }
    return out


CONTRADICTION_SCHEMA = {
    "relations": [
        {"type": "WORKS_AT", "aliases": ["employed by", "CEO_OF"], "from": {"max_count": 1}},
        {"type": "CEO_OF", "from": {"max_count": 1}, "to": {"max_count": 1}},
        {"type": "MEMBER_OF", "from": {"max_count": 2}},
        {"type": "KNOWS", "aliases": ["meets"]},
        {"type": "MEETS"},
    ]
}


def admit(rid, rtype, frm, to, effective):
    return [rid, rtype, frm, to, _serde.to_iso(effective)]


CONTRADICTION_CASES = {
    "warn": (
        "warn",
        [version(1, day(0), rid="relation:acme")],
        [admit("relation:globex", "WORKS_AT", "person:ann", "company:globex", day(3))],
    ),
    "supersede": (
        "supersede",
        [version(1, day(0), rid="relation:acme")],
        [admit("relation:globex", "WORKS_AT", "person:ann", "company:globex", day(3))],
    ),
    "out_of_order": (
        "supersede",
        [version(1, day(10), rid="relation:globex", ends=("person:ann", "WORKS_AT", "company:globex"))],
        [admit("relation:acme", "WORKS_AT", "person:ann", "company:acme", day(0))],
    ),
    "out_of_order_max_two": (
        "supersede",
        [
            version(1, day(5), rid="relation:a", ends=("person:ann", "MEMBER_OF", "club:a")),
            version(1, day(7, 3), rid="relation:b", ends=("person:ann", "MEMBER_OF", "club:b")),
        ],
        [
            admit("relation:c", "MEMBER_OF", "person:ann", "club:c", day(1)),
            admit("relation:d", "MEMBER_OF", "person:ann", "club:d", day(6)),
        ],
    ),
    "same_instant": (
        "supersede",
        [version(1, day(0, 7), rid="relation:acme")],
        [admit("relation:globex", "WORKS_AT", "person:ann", "company:globex", day(0, 7))],
    ),
    "max_two": (
        "supersede",
        [
            version(1, day(0), rid="relation:a", ends=("person:ann", "MEMBER_OF", "club:a")),
            version(1, day(1), rid="relation:b", ends=("person:ann", "MEMBER_OF", "club:b")),
        ],
        [
            admit("relation:c", "MEMBER_OF", "person:ann", "club:c", day(2)),
            admit("relation:d", "MEMBER_OF", "person:ann", "club:d", day(3)),
            admit("relation:d", "MEMBER_OF", "person:ann", "club:d", day(4)),
        ],
    ),
    "ties_by_id": (
        "supersede",
        [
            version(1, day(0), rid="relation:x", ends=("person:ann", "WORKS_AT", "company:x")),
            version(1, day(0), rid="relation:w", ends=("person:ann", "WORKS_AT", "company:w")),
        ],
        [admit("relation:z", "WORKS_AT", "person:ann", "company:z", day(1))],
    ),
    "both_sides": (
        "supersede",
        [version(1, day(0), rid="relation:ceo", ends=("person:ann", "CEO_OF", "company:acme"))],
        [
            admit("relation:bob", "CEO_OF", "person:bob", "company:acme", day(1)),
            admit("relation:ann2", "CEO_OF", "person:ann", "company:globex", day(2)),
            admit("relation:bob2", "CEO_OF", "person:bob", "company:globex", day(3)),
        ],
    ),
    "alias_and_unconstrained": (
        "warn",
        [version(1, day(0), rid="relation:emp", ends=("person:ann", "EMPLOYED_BY", "company:acme"))],
        [
            admit("relation:w", "WORKS_AT", "person:ann", "company:globex", day(1)),
            admit("relation:k1", "KNOWS", "person:ann", "person:bob", day(1)),
            admit("relation:k2", "MEETS", "person:ann", "person:cy", day(1)),
        ],
    ),
    "next_newer": (
        "supersede",
        [
            version(1, day(0), rid="relation:a", ends=("person:ann", "WORKS_AT", "company:a")),
            version(1, day(1), rid="relation:b", ends=("person:ann", "WORKS_AT", "company:b")),
            version(1, day(3), rid="relation:c", ends=("person:ann", "WORKS_AT", "company:c")),
        ],
        [admit("relation:a", "WORKS_AT", "person:ann", "company:a", day(0))],
    ),
    "batch": (
        "warn",
        [],
        [
            admit("relation:a", "WORKS_AT", "person:ann", "company:a", day(0)),
            admit("relation:b", "WORKS_AT", "person:ann", "company:b", day(0)),
            admit("relation:c", "WORKS_AT", "person:ann", "company:c", day(0)),
        ],
    ),
}


def contradiction_cases():
    caps = contradiction_caps(Schema.model_validate(CONTRADICTION_SCHEMA))
    out = {
        "schema": CONTRADICTION_SCHEMA,
        "caps": {name: [cap.canonical, list(cap.types), [list(x) for x in cap.limits]] for name, cap in caps.items()},
        "cases": {},
    }
    for name, (mode, existing, admits) in CONTRADICTION_CASES.items():
        tracker = Contradictions(caps, mode, existing)
        results = []
        for rid, rtype, frm, to, effective in admits:
            at = _serde.from_iso(effective)
            warnings = tracker.admit(rid, rtype, frm, to, (at, 1, at))
            ended, settled = tracker.settle()
            retired = {old: [by, _serde.to_iso(when)] for old, (by, when) in ended.items()}
            results.append([retired, [[w.code, w.message] for w in [*warnings, *settled]]])
        out["cases"][name] = {
            "mode": mode,
            "existing": [v.model_dump(mode="json") for v in existing],
            "admits": admits,
            "results": results,
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


ASSEMBLE_ENTITIES = [{"type": "Company", "name": "Acme"}, {"type": "Person", "name": "Soham"}]
ASSEMBLE_RELATIONS = [
    {"from_name": "Soham", "type": "WORKS_AT", "to_name": "Acme Inc."},
    {"from_name": "soham", "type": "KNOWS", "to_name": "Jane Doe"},
]


def assemble_case():
    ontology = DefaultExtractor._assemble(
        [EntityInput(**e) for e in ASSEMBLE_ENTITIES], [_RelOut(**r) for r in ASSEMBLE_RELATIONS], [], []
    )
    return {
        "entities": ASSEMBLE_ENTITIES,
        "relations": ASSEMBLE_RELATIONS,
        "ontology": ontology.model_dump(mode="json"),
    }


SIMILAR_PAIRS = [
    ("MARTHA", "MARHTA"),
    ("DWAYNE", "DUANE"),
    ("DIXON", "DICKSONX"),
    ("Jonathan Smith", "Jonathon Smith"),
    ("Jon Smyth", "John Smith"),
    ("New York Times", "The New York Times"),
    ("Zoë Ångström", "Zoe Angstrom"),
    ("Cafe\u0301 Ole\u0301", "café olé"),
    ("İstanbul", "istanbul"),
    ("ΣΊΣΥΦΟΣ", "σίσυφος"),
    ("Straße", "STRASSE"),
    ("北京大学", "北京"),
    ("🚀 Rocket Co", "Rocket Co"),
    ("a", ""),
    ("", ""),
    ("  Acme  ", "acme"),
    ("Apple", "Apex"),
]

RESOLVE_EXISTING = [
    {"id": "company:big-blue", "type": "Company", "name": "Big Blue", "external_ids": {"ticker": "IBM"}},
    {"id": "company:ibm-research", "type": "Company", "name": "IBM Research", "aliases": ["IBM Labs"]},
    {"id": "person:jonathan-smith", "type": "Person", "name": "Jonathan Smith"},
    {"id": "person:b", "type": "Person", "name": "B", "aliases": ["Sam"]},
    {"id": "person:a", "type": "Person", "name": "A", "aliases": ["Sam"]},
    {"id": "person:zoe", "type": "Person", "name": "Zoë Ångström", "aliases": ["ΣΊΣΥΦΟΣ"]},
    {"id": "person:employee1", "type": "Person", "name": "Employee1"},
    {"id": "project:project-12", "type": "Project", "name": "Project 12"},
    {"id": "server:server00", "type": "Server", "name": "Server00"},
    {"id": "product:model-a", "type": "Product", "name": "Model A"},
    {"id": "person:robert-johnson", "type": "Person", "name": "Robert Johnson", "external_ids": {"lei": "7"}},
    {"id": "person:katherine-zorkdefault", "type": "Person", "name": "Katherine Zorkdefault"},
    {"id": "person:jonathan-smithers", "type": "Person", "name": "Jonathan Smithers"},
    {"id": "person:jonny", "type": "Person", "name": "Jon Nyström", "aliases": ["Jonny S"]},
]

RESOLVE_CANDIDATES = [
    {"type": "Company", "name": "Big Blue"},
    {"type": "Company", "name": "IBM", "external_ids": {"ticker": "IBM"}},
    {"type": "Company", "name": "IBM", "external_ids": {"ticker": "MSFT"}},
    {"type": "Company", "name": "ibm labs"},
    {"type": "Company", "name": "IBMR", "aliases": ["IBM Research"]},
    {"type": "Person", "name": "Jonathon Smith"},
    {"type": "Person", "name": "Jonathan Smyth"},
    {"type": "Company", "name": "Jonathan Smith"},
    {"type": "Person", "name": "Sam"},
    {"type": "Person", "name": "σίσυφος"},
    {"type": "Person", "name": "Zoe Angstrom"},
    {"id": "x:custom", "type": "Person", "name": "Nobody"},
    {"type": "Person", "name": "Employee2"},
    {"type": "Person", "name": "Employee 1"},
    {"type": "Project", "name": "Project 13"},
    {"type": "Server", "name": "Server01"},
    {"type": "Server", "name": "Server0"},
    {"type": "Product", "name": "Model B"},
    {"type": "Product", "name": "Model  A"},
    {"type": "Thing", "name": "robert johnson"},
    {"type": "Thing", "name": "Robert Johnsen"},
    {"type": "Thing", "name": "Bob", "external_ids": {"lei": "7"}},
    {"type": "Thing", "name": "RJ", "aliases": ["Robert Johnson"]},
    {"type": "Person", "name": "Katherine Zorkfuzzy"},
    {"type": "Person", "name": "Jonathon Smithers"},
    {"type": "Person", "name": "Jon Smithers"},
    {"type": "Person", "name": "Janie", "aliases": ["Jonny S"]},
    {"type": "Person", "name": "Jonathan Smithers Jr"},
]

DISTINCT_PAIRS = [
    ("Employee1", "Employee2"),
    ("Employee 1", "employee1"),
    ("Project 12", "Project 13"),
    ("Server00", "Server0"),
    ("Model A", "Model B"),
    ("John F Kennedy", "John Kennedy"),
    ("John F Kennedy", "John K Kennedy"),
    ("Area 51 Unit 7", "Unit 7 Area 51"),
    ("Café 2", "CAFÉ 2"),
    ("Katherine Zorkfuzzy", "Katherine Zorkdefault"),
    ("Jon Smithers", "Jonathan Smithers"),
    ("J Smithers", "Jon Smithers"),
    ("New York Times", "The New York Times"),
    ("Jane Dow", "Jane Doe"),
    ("Jonathan Smyth", "Jonathan Smith"),
    ("Zoë Ångström", "Zoe Angstrom"),
    ("Ⅻ Legion", "XII Legion"),
    ("Route ٣", "Route 3"),
    ("Bobby Tables Jr", "Bobby Tables"),
    ("Bobby Tables Jr.", "bobby tables jr"),
    ("Henry Ford II", "Henry Ford III"),
    ("John Smith Sr", "John Smith IV"),
    ("", ""),
]


def resolution_cases():
    at = datetime(2024, 1, 1, tzinfo=timezone.utc)
    existing = [Entity(created_at=at, updated_at=at, **e) for e in RESOLVE_EXISTING]
    decide = []
    for raw in RESOLVE_CANDIDATES:
        candidate = EntityInput(**raw)
        for fuzzy, threshold in ((False, 0.92), (True, 0.92), (True, 0.97)):
            decision = DefaultResolver(fuzzy=fuzzy, threshold=threshold).decide(candidate, existing)
            decide.append([raw, fuzzy, threshold, decision.model_dump()])
    return {
        "jaro_winkler": [[a, b, jaro_winkler(a, b)] for a, b in SIMILAR_PAIRS],
        "token_jaccard": [[a, b, token_jaccard(a, b)] for a, b in SIMILAR_PAIRS],
        "name_similarity": [[a, b, name_similarity(a, b)] for a, b in SIMILAR_PAIRS],
        "distinct": [[a, b, distinct_names(a, b)] for a, b in DISTINCT_PAIRS],
        "distinct_low": [[a, b, distinct_names(a, b, 0.8)] for a, b in DISTINCT_PAIRS],
        "existing": RESOLVE_EXISTING,
        "decide": decide,
        "merge_id": [[s, a, ids.entity_merge_id(s, a)] for s, a in [("company:ibm", "company:big-blue"), ("x", "🚀")]],
    }


RELEVANCE_CASES = [
    (["2026-01-01T00:00:00+00:00"], "2026-01-01T00:00:00+00:00", 30, 0),
    (["2026-01-01T00:00:00+00:00", None], "2026-01-31T00:00:00+00:00", 30, 1),
    (["2025-11-02T00:00:00+00:00", "2026-01-01T00:00:00+00:00"], "2026-03-02T00:00:00+00:00", 30, 3),
    (["2026-01-06T00:00:00+00:00"], "2026-01-01T00:00:00+00:00", 30, 0),
    (["2026-01-01T00:00:00+00:00"], "2026-01-01T00:00:00+00:00", 30, 63),
    (["2026-01-01T00:00:00.999999+00:00"], "2026-01-01T00:00:01.000500+00:00", 0.00001, 0),
    (["2024-02-29T12:34:56.789+00:00", "2025-06-01T08:00:00.123456+00:00"], "2026-11-08T10:00:00+00:00", 400, 12),
    (["2020-01-01T00:00:00+00:00"], "2026-11-08T10:00:00.5+00:00", 3000, 1000000),
    ([None, "2026-11-08T09:59:59.999+00:00"], "2026-11-08T10:00:00+00:00", 365, 2),
]

NEO4J_SCHEMAS = [
    {
        "node_types": [
            {
                "label": "Person",
                "description": "A human",
                "aliases": ["Human"],
                "properties": [
                    {"name": "name", "type": "STRING", "description": "full name"},
                    {"name": "born", "type": "DATE"},
                    {"name": "where", "type": "POINT", "required": True},
                    {"name": "tags", "type": "LIST"},
                ],
                "additional_properties": True,
            },
            "Company",
        ],
        "relationship_types": [{"label": "WORKS_FOR", "properties": [{"name": "since", "type": "INTEGER"}]}],
        "patterns": [
            ["Person", "WORKS_FOR", "Company"],
            {"source": "Company", "relationship": "OWNS", "target": "Company"},
            ["Person", "WORKS_FOR", "Person"],
        ],
        "constraints": [
            {"type": "EXISTENCE", "property_names": ["name"], "node_type": "Person"},
            {"type": "KEY", "property_names": ["since"], "relationship_type": "WORKS_FOR"},
            {"type": "UNIQUENESS", "property_name": "name", "node_type": "Person"},
        ],
        "additional_patterns": False,
    },
    {"node_types": [], "patterns": [["A", "R", "B"], ["C", "R", "D"]]},
]


def neo4j_cases():
    out = []
    for data in NEO4J_SCHEMAS:
        schema = Schema.from_neo4j_ontology(data)
        out.append(
            {
                "input": data,
                "schema": schema.model_dump(mode="json", by_alias=True),
                "export": schema.to_neo4j_ontology(),
            }
        )
    return out


def main():
    out = {
        "slug": {t: attempt(ids.slug, t) for t in TYPES + NAMES},
        "entity_id": [[t, n, attempt(ids.entity_id, t, n)] for t in TYPES for n in NAMES],
        "normalize_rel_type": {t: ids.normalize_rel_type(t) for t in REL_TYPES if t.strip(" !")},
        "canonical_entity_id": [[e, attempt(ids.canonical_entity_id, e)] for e in ENTITY_ID_INPUTS],
        "relation_id": [
            ["person:jane", t, "company:acme", ids.relation_id("person:jane", t, "company:acme")]
            for t in REL_TYPES
            if t.strip(" !")
        ],
        "preference_id": [
            [s, k, key, v, attempt(ids.preference_id, s, k, key, v)]
            for s, k, key, v in [
                ("person:jane", "preference", "database", "db:hydradb"),
                ("x", "disinterest", "", "🚀"),
            ]
        ],
        "decision_id": [
            [a, t, attempt(ids.decision_id, a, t)]
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
        "key_cursors": {
            i: encode_cursor(i) for i in ["person:ada", "company:caf\u00e9 \U0001f680", "relation:a>b?c~d", "x:??>>>"]
        },
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
        "evidence_id": [
            [target, ev.model_dump(), ids.evidence_id(target, *[ev.model_dump()[k] for k in EVIDENCE_KEY])]
            for target, ev in EVIDENCE_CASES
        ],
        "sk": [
            [ns, sid, str(_sk(ns, sid))]
            for ns, sid in [("default", "person:jane"), ("x", "🚀"), ("default", "a|WORKS_AT|b|None|None")]
        ],
        "chunks": chunk_cases(),
        "extract": extract_cases(),
        "assemble": assemble_case(),
        "as_of": as_of_cases(),
        "contradictions": contradiction_cases(),
        "resolution": resolution_cases(),
        "relevance": [
            [
                stamps,
                now,
                half_life,
                signal,
                relevance_score([_serde.from_iso(t) for t in stamps], _serde.from_iso(now), half_life, signal),
            ]
            for stamps, now, half_life, signal in RELEVANCE_CASES
        ],
        "neo4j_schema": neo4j_cases(),
    }
    json.dump(out, sys.stdout, ensure_ascii=True, indent=1)


if __name__ == "__main__":
    main()
