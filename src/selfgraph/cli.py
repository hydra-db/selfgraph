from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
import os
import sys
from collections.abc import Callable
from datetime import datetime
from typing import Any, get_args

from .errors import NotFoundError, PromptTemplateError, SelfGraphError, ValidationError, surface_hint
from .models import Kind, Status
from .resolution import ResolverMode
from .resources._common import DEFAULT_PAGE_LIMIT
from .retrieval import STRATEGIES
from .runtime import (
    DECISION_CLEARABLE,
    PREFERENCE_CLEARABLE,
    SETTING_KEYS,
    STORES,
    GraphSettings,
    bind_params,
    build_graph,
    check_settings,
    current_relation,
    dumps,
    ignored_settings,
    parse_json,
    parse_time,
    present,
    read_json,
    read_text,
    require_changes,
    settings_from_env,
    store_kind,
    surfaced,
)
from .schema import ContradictionMode, Schema, SchemaMode
from .tiers import LADDERS, LEVELS

__all__ = ["main", "build_parser"]

_JSON_VALUE = "; KEY=VALUE, VALUE parsed as JSON when valid (so 12345 is a number), else kept as text"
_ISO = "ISO 8601; no offset means UTC"
_QUERY_EXAMPLES = """examples, scoped to one namespace (stored property names differ per backend):
  Neo4j, Memgraph, FalkorDB:
    selfgraph query 'MATCH (n:Entity {ns: $ns}) RETURN n.id, n.name LIMIT 5' --param ns=default
  HydraDB (the SelfGraph id is n.sid):
    selfgraph query 'MATCH (n:Entity {ns: $ns}) RETURN n.sid, n.name LIMIT 5' --param ns=default
  Kuzu (one node table N, the record as JSON in doc):
    selfgraph query "MATCH (n:N {label: 'Entity', ns: \\$ns}) RETURN n.id, n.doc LIMIT 5" --param ns=default"""
_NO_SCHEMA = "no schema set; pass --schema FILE or SELFGRAPH_SCHEMA"
_OBJECT_TYPES = {
    "entities": "Entity",
    "relations": "Relation",
    "preferences": "Preference",
    "decisions": "DecisionTrace",
}
_CONTRADICTION_HELP = "how to handle a contradicting relation; llm also judges with no max_count (default warn)"
_RETIRED_HINT = "use relation versions or relation list --include-invalidated"
_NEO4J_KEYS = ("node_types", "relationship_types", "patterns", "constraints", "nodeTypes", "relationshipTypes")
_LOGGED_WARNINGS = ("basic_extraction", "ner_extraction")
_SCHEMA_HELP = """schema: print the active schema (--schema FILE), or null
schema import [--from neo4j] FILE: convert a Neo4j graph schema
schema export [--to neo4j]: print the active schema as a Neo4j graph schema"""
_USAGE_ERRORS = (ValidationError, PromptTemplateError, FileNotFoundError)
_EVIDENCE_HELP = (
    "evidence as JSON: {source_id, chunk_id?, quote?, start_offset?, end_offset?, confidence?} or an array of them "
    "(repeatable)"
)


class _Text(str):
    pass


def _time(field: str) -> Callable[[str], datetime | None]:
    """An argparse type that parses an ISO 8601 flag with the shared parser.

    @param field (str): the parameter name, for the error.
    @return (Callable[[str], datetime | None]): the converter.
    """

    def convert(value: str) -> datetime | None:
        try:
            return parse_time(value, field)
        except ValidationError as exc:
            raise argparse.ArgumentTypeError(str(exc)) from exc

    return convert


def _kv(pairs: list[str] | None, flag: str, *, text: bool = False) -> dict[str, Any] | None:
    """Parse repeated key=value flags; each value is JSON if it parses, else text.

    @param pairs (list[str] | None): key=value strings to parse.
    @param flag (str): the flag the pairs came from, for the error.
    @param text (bool): keep every value as text instead of parsing JSON.
    @return (dict[str, Any] | None): the parsed mapping, or None when no pairs were given.
    """
    if not pairs:
        return None
    out: dict[str, Any] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep:
            raise ValidationError(f"{flag} expects {'SYSTEM=ID' if text else 'KEY=VALUE'}, got {pair!r}")
        if text:
            out[key] = value
            continue
        try:
            out[key] = json.loads(value)
        except json.JSONDecodeError:
            out[key] = value
    return out


async def _init(graph, args):
    await graph.initialize()
    return {"ok": True, "store": args.store, "namespace": args.namespace}


def _installed_version() -> str:
    import selfgraph

    return selfgraph.__version__


async def _version(graph, args):
    return {"selfgraph": _installed_version()}


async def _schema(graph, args):
    if graph.schema is None:
        print(f"note: {_NO_SCHEMA}", file=sys.stderr)
    return graph.schema


async def _retrieve(graph, args):
    result = await graph.retrieve(
        " ".join(args.query),
        strategy=args.strategy,
        depth=args.depth,
        k=args.k,
        max_nodes=args.max_nodes,
        budget_tokens=args.budget_tokens,
        as_of=args.as_of,
        seeds=args.seeds,
    )
    return _Text(result.context) if args.context_only else result


async def _prune(graph, args):
    return surfaced(
        await graph.maintenance.prune(
            min_relevance=args.min_relevance,
            older_than=args.older_than,
            types=args.type,
            relation_types=args.relation_type,
            dry_run=not args.apply,
        )
    )


def _metadata(items: list[str] | None) -> dict[str, Any] | None:
    """Parse repeated --metadata values: each a JSON object, or a KEY=VALUE pair, merged in order.

    @param items (list[str] | None): the flag values.
    @return (dict[str, Any] | None): the metadata, or None when none was given.
    """
    if not items:
        return None
    out: dict[str, Any] = {}
    for item in items:
        if item.lstrip().startswith("{"):
            out.update(parse_json(item, " in --metadata"))
        else:
            out.update(_kv([item], "--metadata"))
    return out


def _evidence(items: list[str] | None) -> list[Any] | None:
    """Parse repeated --evidence values: each a JSON evidence object, or a JSON array of them.

    @param items (list[str] | None): the flag values.
    @return (list[Any] | None): the evidence records, or None when none was given.
    """
    if not items:
        return None
    out: list[Any] = []
    for item in items:
        value = parse_json(item, " in --evidence")
        out.extend(value if isinstance(value, list) else [value])
    return out


def _add_evidence(p: argparse.ArgumentParser, verb: str = "") -> None:
    p.add_argument("--evidence", action="append", metavar="JSON", help=f"{verb}{_EVIDENCE_HELP}")


def _add_versions(sub: Any, resource: str, noun: str) -> None:
    """Add a versions subcommand that lists every version of a relation or preference, newest first by default.

    @param sub (Any): the resource's subparsers.
    @param resource (str): the graph attribute, e.g. "relations".
    @param noun (str): the resource name for the help, e.g. "relation".
    """
    p = sub.add_parser("versions", help=f"list every version of a {noun}, newest first")
    p.add_argument("id")
    p.add_argument("--oldest-first", action="store_true", help="list the oldest version first")
    p.set_defaults(func=lambda g, a: getattr(g, resource).versions(a.id, newest_first=not a.oldest_first))


def _inserted(result: Any) -> Any:
    """Print each insert warning to stderr as one "code: message" line, except those the library already logged.

    @param result (Any): the insert result.
    @return (Any): the same result, its warnings worded for the CLI.
    """
    for w in surfaced(result).warnings:
        if w.code not in _LOGGED_WARNINGS:
            print(f"selfgraph: {w.code}: {w.message}", file=sys.stderr)
    return result


async def _schema_import(graph, args):
    data = read_json(args.path)
    if isinstance(data, dict) and {"entities", "relations"} & data.keys() and not set(_NEO4J_KEYS) & data.keys():
        raise ValidationError(
            f"{args.path!r} looks like a SelfGraph schema, not a Neo4j one; pass it as --schema instead"
        )
    return Schema.from_neo4j_ontology(data)


async def _schema_export(graph, args):
    if graph.schema is None:
        raise ValidationError(f"no schema to export; {_NO_SCHEMA}")
    return graph.schema.to_neo4j_ontology()


def _add_list_paging(p: argparse.ArgumentParser) -> None:
    p.add_argument("--cursor", help="opaque cursor from a previous page's next_cursor")
    p.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_PAGE_LIMIT,
        help=f"page size (default {DEFAULT_PAGE_LIMIT}); pass the printed next_cursor as --cursor for the next page",
    )


def _id_command(sub: Any, resource: str, action: str, *, paged: bool = False, **kwargs: Any) -> None:
    """Add a subcommand that takes an id and calls graph.<resource>.<action>(id).

    @param sub (Any): the resource's subparsers.
    @param resource (str): the graph attribute, e.g. "entities".
    @param action (str): the subcommand and method name.
    @param paged (bool): add --cursor and --limit and pass them through.
    @param kwargs (Any): add_parser options such as help.
    """
    p = sub.add_parser(action, **kwargs)
    p.add_argument("id")
    if paged:
        _add_list_paging(p)

    async def run(graph, args):
        page = {"cursor": args.cursor, "limit": args.limit} if paged else {}
        if (resource, action) == ("relations", "get"):
            result = await current_relation(graph, args.id, _RETIRED_HINT)
        else:
            result = await getattr(getattr(graph, resource), action)(args.id, **page)
        if result is None and action == "get":
            raise NotFoundError(_OBJECT_TYPES[resource], args.id)
        return result

    p.set_defaults(func=run)


def _add_contradiction(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--contradiction",
        dest="call_contradiction",
        default=None,
        choices=get_args(ContradictionMode),
        help=_CONTRADICTION_HELP,
    )


def _add_call_overrides(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--resolver",
        dest="call_resolver",
        default=None,
        choices=get_args(ResolverMode),
        help="entity resolution for this insert (default: the global --resolver)",
    )
    _add_contradiction(p)


def _add_globals(p: argparse.ArgumentParser, *, nested: bool = False, listed: bool = False) -> None:
    """Add the connection flags; a subcommand gets them too, unlisted and without defaults, so they work after it.

    @param p (argparse.ArgumentParser): the parser to add them to.
    @param nested (bool): add them to a subcommand, keeping any flag of the same name it already defines.
    @param listed (bool): show them in the subcommand's help.
    """
    flags: list[tuple[str, dict[str, Any]]] = [
        (
            "--store",
            {
                "choices": STORES,
                "help": "backend: hydradb, neo4j, cypher, memgraph, falkordb, or kuzu "
                "(default $SELFGRAPH_STORE, else embedded kuzu, or hydradb with --uri)",
            },
        ),
        ("--uri", {"help": "Bolt URI for neo4j/cypher/hydradb, host:port for falkordb, file path for kuzu"}),
        (
            "--auth",
            {
                "help": "'user:password', or a bare token (user neo4j); falkordb takes 'user:password' or a bare "
                "password for the default user; ignored by kuzu"
            },
        ),
        (
            "--database",
            {
                "help": "Bolt: database name (default: server default); FalkorDB: graph name (default selfgraph); "
                "ignored by kuzu"
            },
        ),
        ("--namespace", {"help": "graph namespace (default 'default')"}),
        ("--llm-provider", {"help": "any litellm provider, e.g. anthropic, openai, ollama"}),
        ("--llm-model", {"help": "the model; a provider-prefixed one such as openai/gpt-4o-mini sets the provider"}),
        ("--llm-api-key", {}),
        ("--llm-base-url", {}),
        ("--llm-timeout", {"help": "seconds to wait for each LLM call (default 120)"}),
        ("--llm-concurrency", {"help": "chunks to extract at once, each running four LLM calls (default 4)"}),
        ("--schema", {"help": "schema JSON file applied to every insert, or inline JSON when it starts with '{'"}),
        ("--instructions", {"help": "extraction instructions JSON file, or inline JSON when it starts with '{'"}),
        ("--prompts", {"help": "extraction prompt templates JSON file, or inline JSON when it starts with '{'"}),
        ("--schema-mode", {"choices": get_args(SchemaMode), "help": "default warn; strict needs --schema"}),
        (
            "--resolver",
            {"choices": get_args(ResolverMode), "help": "entity resolution on insert (default: by level)"},
        ),
        ("--contradiction", {"choices": get_args(ContradictionMode), "help": _CONTRADICTION_HELP}),
        ("--level", {"choices": LEVELS, "help": "sets every capability's default tier (default balanced)"}),
        ("--max-tier", {"choices": LEVELS, "help": "cost cap no capability climbs past (default max)"}),
    ]
    for flag, options in flags:
        if not nested:
            p.add_argument(flag, default=None, **options)
        elif flag not in p._option_string_actions:
            shown = options.get("help") if listed else argparse.SUPPRESS
            p.add_argument(flag, default=argparse.SUPPRESS, choices=options.get("choices"), help=shown)


def _finish(p: argparse.ArgumentParser) -> None:
    """Give every subcommand the connection flags, so they work after it.

    @param p (argparse.ArgumentParser): the parser whose subcommands to finish.
    """
    for action in p._actions:
        if isinstance(action, argparse._SubParsersAction):
            for child in action.choices.values():
                _add_globals(child, nested=True)
                _finish(child)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="selfgraph",
        description="Build and read a SelfGraph knowledge graph. Connection flags may come before or after the "
        "subcommand.",
    )
    parser.add_argument("-V", "--version", action="version", version=_installed_version())
    _add_globals(parser)

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser(
        "init", help="check the connection and create the store's indexes or constraints where the backend has them"
    ).set_defaults(func=_init)
    sub.add_parser("version", help="print the installed version").set_defaults(func=_version)
    mcp_help = "run the MCP server over stdio; it honours the global options listed below"
    mcp = sub.add_parser("mcp", help="run the MCP server over stdio", description=mcp_help)
    _add_globals(mcp, nested=True, listed=True)
    mcp.set_defaults(func=None)
    sc = sub.add_parser(
        "schema",
        help="print the active schema, or import or export a Neo4j graph schema",
        description=_SCHEMA_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sc.set_defaults(func=_schema)
    sca = sc.add_subparsers(dest="schema_action")
    si = sca.add_parser("import", help="convert a Neo4j graph schema JSON file, or '-' for stdin, and print it")
    si.add_argument("path")
    si.add_argument("--from", dest="source", choices=["neo4j"], default="neo4j", help="the source format (neo4j)")
    si.set_defaults(func=_schema_import)
    se = sca.add_parser("export", help="print the active schema (--schema) as a Neo4j graph schema")
    se.add_argument("--to", dest="target", choices=["neo4j"], default="neo4j", help="the target format (neo4j)")
    se.set_defaults(func=_schema_export)

    query_help = "run one raw Cypher statement; it can write and is not scoped to the namespace"
    q = sub.add_parser(
        "query",
        help=query_help,
        description=query_help,
        epilog=_QUERY_EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    q.add_argument("cypher")
    q.add_argument("--param", action="append", metavar="KEY=VALUE", help=f"query parameter (repeatable){_JSON_VALUE}")
    q.set_defaults(func=lambda g, a: g.run_cypher(a.cypher, bind_params(a.cypher, _kv(a.param, "--param"))))

    rt = sub.add_parser("retrieve", help="retrieve graph context for a query; unquoted words join into one query")
    rt.add_argument("query", nargs="+")
    rt.add_argument("--strategy", choices=STRATEGIES, default=None, help="traversal order, or ppr for PageRank ranking")
    rt.add_argument("--seeds", choices=LADDERS["seeds"], default=None, help="seeding tier (default: the level's)")
    rt.add_argument("--depth", type=int, default=3, help="traversal hops (default 3)")
    rt.add_argument("--k", type=int, default=20, help="seed count (default 20)")
    rt.add_argument("--max-nodes", type=int, default=200, help="entity cap (default 200)")
    rt.add_argument("--budget-tokens", type=int, default=3000, help="context budget (default 3000)")
    rt.add_argument("--as-of", type=_time("as_of"), help=f"read the graph as of this time ({_ISO})")
    rt.add_argument("--context-only", action="store_true", help="print only the context text, not the JSON result")
    rt.set_defaults(func=_retrieve)

    cv = sub.add_parser("coverage", help="report which words of a question the schema and graph can ground")
    cv.add_argument("question", nargs="+")
    cv.set_defaults(func=lambda g, a: g.coverage(" ".join(a.question)))

    mt = sub.add_parser("maintenance", help="decay (score relevance), prune, or consolidate duplicate relations")
    mta = mt.add_subparsers(dest="action", required=True)
    md = mta.add_parser(
        "decay", help="score every entity and relation by recency and frequency; prints them unless --apply"
    )
    md.add_argument("--half-life-days", type=float, default=30, help="days after which recency halves (default 30)")
    md.add_argument("--now", type=_time("now"), help=f"reference time ({_ISO}; default now)")
    md.add_argument("--apply", action="store_true", help="write the scores")
    md.set_defaults(
        func=lambda g, a: g.maintenance.decay(half_life_days=a.half_life_days, now=a.now, dry_run=not a.apply)
    )
    mp = mta.add_parser("prune", help="remove low-relevance or old items; prints the plan unless --apply")
    mp.add_argument("--min-relevance", type=float, help="remove items whose relevance is below this")
    mp.add_argument("--older-than", type=_time("older_than"), help=f"remove items last touched before this ({_ISO})")
    mp.add_argument("--type", action="append", help="only consider entities of this type (repeatable)")
    mp.add_argument("--relation-type", action="append", help="only consider relations of this type (repeatable)")
    mp.add_argument("--apply", action="store_true", help="remove what the plan lists")
    mp.set_defaults(func=_prune)
    mc = mta.add_parser("consolidate", help="merge duplicate parallel relations; prints the plan unless --apply")
    mc.add_argument("--apply", action="store_true", help="merge the groups the plan lists")
    mc.set_defaults(func=lambda g, a: g.maintenance.consolidate(dry_run=not a.apply))

    ins = sub.add_parser("insert", help="insert text or an ontology").add_subparsers(dest="what", required=True)
    it = ins.add_parser("text", help="extract an ontology from text (LLM if configured, else NER or regex)")
    it.add_argument("text", help="the text, or '-' for stdin")
    it.add_argument("--source-id")
    it.add_argument("--event-time", type=_time("event_time"), help=f"when the text's facts became true ({_ISO})")
    it.add_argument(
        "--metadata",
        action="append",
        metavar="JSON|KEY=VALUE",
        help=f"source metadata: a JSON object, or KEY=VALUE pairs (repeatable){_JSON_VALUE}",
    )
    _add_call_overrides(it)

    async def insert_text(g, a):
        return _inserted(
            await g.insert.text(
                read_text("-") if a.text == "-" else a.text,
                source_id=a.source_id,
                event_time=a.event_time,
                metadata=_metadata(a.metadata),
                resolver=a.call_resolver,
                contradiction=a.call_contradiction,
            )
        )

    it.set_defaults(func=insert_text)

    io = ins.add_parser("ontology", help="insert a ready ontology (JSON file or '-' for stdin)")
    io.add_argument("path", help="the ontology JSON file, or '-' to read it from stdin")
    io.add_argument("--source-id")
    io.add_argument(
        "--event-time",
        type=_time("event_time"),
        help=f"default event time for relations, preferences, and decisions without their own ({_ISO})",
    )
    _add_call_overrides(io)

    async def insert_ontology(g, a):
        return _inserted(
            await g.insert.ontology(
                read_json(a.path),
                source_id=a.source_id,
                event_time=a.event_time,
                resolver=a.call_resolver,
                contradiction=a.call_contradiction,
            )
        )

    io.set_defaults(func=insert_ontology)

    ent = sub.add_parser(
        "entity", help="create/get/list/evidence/merges/unmerge/update/delete entities"
    ).add_subparsers(dest="action", required=True)
    ec = ent.add_parser("create", help="create an entity")
    ec.add_argument("--name", required=True)
    ec.add_argument("--type", required=True)
    ec.add_argument("--id")
    ec.add_argument("--alias", action="append", help="alias (repeatable)")
    ec.add_argument("--external-id", action="append", metavar="SYSTEM=ID", help="external id (repeatable)")
    ec.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"property (repeatable){_JSON_VALUE}")
    ec.set_defaults(
        func=lambda g, a: g.entities.create(
            a.name,
            a.type,
            id=a.id,
            aliases=a.alias,
            external_ids=_kv(a.external_id, "--external-id", text=True),
            properties=_kv(a.prop, "--prop"),
        )
    )
    _id_command(ent, "entities", "get", help="print one entity")
    el = ent.add_parser("list", help="list entities, filtered by type or name")
    el.add_argument("--type")
    el.add_argument("--name", help="exact, case-sensitive match on the current name")
    _add_list_paging(el)
    el.set_defaults(func=lambda g, a: g.entities.list(type=a.type, name=a.name, cursor=a.cursor, limit=a.limit))
    _id_command(ent, "entities", "evidence", paged=True, help="list the evidence supporting an entity")
    _id_command(ent, "entities", "merges", paged=True, help="list the entities merged into an entity")
    _id_command(ent, "entities", "unmerge", help="reverse a merge by merge id")
    eu = ent.add_parser("update", help="change an entity's name, type, aliases, external ids, or properties")
    eu.add_argument("id")
    eu.add_argument("--name")
    eu.add_argument("--type", help="change the type's case or spacing only (the type is part of the id)")
    eu.add_argument("--alias", action="append", help="add an alias (repeatable)")
    eu.add_argument("--external-id", action="append", metavar="SYSTEM=ID", help="set an external id (repeatable)")
    eu.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"set property (repeatable){_JSON_VALUE}")
    eu.add_argument("--remove-alias", action="append", metavar="ALIAS", help="remove an alias (repeatable)")
    eu.add_argument("--remove-prop", action="append", metavar="KEY", help="remove a property (repeatable)")
    eu.set_defaults(
        func=lambda g, a: g.entities.update(
            a.id,
            **present(
                name=a.name,
                type=a.type,
                aliases=a.alias,
                external_ids=_kv(a.external_id, "--external-id", text=True),
                properties=_kv(a.prop, "--prop"),
                remove_aliases=a.remove_alias,
                remove_properties=a.remove_prop,
            ),
        )
    )
    _id_command(ent, "entities", "delete", help="delete an entity with its relations, preferences, and decisions")

    rel = sub.add_parser("relation", help="create/get/list/versions/evidence/update/delete relations").add_subparsers(
        dest="action", required=True
    )
    rc = rel.add_parser("create", help="create a relation between two entities")
    rc.add_argument("from_entity", metavar="FROM")
    rc.add_argument("type", metavar="TYPE")
    rc.add_argument("to_entity", metavar="TO")
    rc.add_argument("--id")
    rc.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"property (repeatable){_JSON_VALUE}")
    rc.add_argument("--event-time", type=_time("event_time"), help=f"when the fact became true ({_ISO})")
    _add_evidence(rc)
    _add_contradiction(rc)
    rc.set_defaults(
        func=lambda g, a: g.relations.create(
            a.from_entity,
            a.type,
            a.to_entity,
            id=a.id,
            properties=_kv(a.prop, "--prop"),
            event_time=a.event_time,
            evidence=_evidence(a.evidence) or (),
            contradiction=a.call_contradiction,
        )
    )
    _id_command(rel, "relations", "get", help="print the current version of a relation")
    rl = rel.add_parser("list", help="list current relations, filtered by endpoint or type")
    rl.add_argument("--from", dest="from_entity")
    rl.add_argument("--type")
    rl.add_argument("--to", dest="to_entity")
    rl.add_argument("--include-invalidated", action="store_true", help="also list relations a contradiction retired")
    _add_list_paging(rl)
    rl.set_defaults(
        func=lambda g, a: g.relations.list(
            from_entity=a.from_entity,
            type=a.type,
            to_entity=a.to_entity,
            cursor=a.cursor,
            limit=a.limit,
            include_invalidated=a.include_invalidated,
        )
    )
    _add_versions(rel, "relations", "relation")
    _id_command(rel, "relations", "evidence", paged=True, help="list the evidence supporting a relation")
    ru = rel.add_parser("update", help="make a new version with changed properties")
    ru.add_argument("id")
    ru.add_argument(
        "--set", "--prop", action="append", metavar="KEY=VALUE", help=f"set property (repeatable){_JSON_VALUE}"
    )
    ru.add_argument(
        "--remove",
        "--remove-prop",
        action="append",
        metavar="KEY",
        help="remove property (repeatable; ignored if absent)",
    )
    ru.add_argument("--event-time", type=_time("event_time"), help=f"when the new version became true ({_ISO})")
    _add_evidence(ru, "add ")
    ru.set_defaults(
        func=lambda g, a: g.relations.update(
            a.id,
            **require_changes(
                present(
                    set_properties=_kv(a.set, "--set"),
                    remove_properties=a.remove,
                    event_time=a.event_time,
                    evidence=_evidence(a.evidence),
                )
            ),
        )
    )
    _id_command(
        rel, "relations", "delete", help="delete a relation, its versions, and decision traces that use it as a step"
    )

    pref = sub.add_parser("preference", help="create/get/list/versions/update/delete preferences").add_subparsers(
        dest="action", required=True
    )
    pc = pref.add_parser("create", help="create a preference of a subject for a value entity")
    pc.add_argument("subject", help="subject entity id")
    pc.add_argument("key")
    pc.add_argument("value", help="value entity id (an existing entity, e.g. tool:hydradb)")
    pc.add_argument("--id")
    pc.add_argument("--kind", choices=get_args(Kind), default="preference")
    pc.add_argument("--about", help="entity id the preference is about")
    pc.add_argument("--strength", type=float)
    pc.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"property (repeatable){_JSON_VALUE}")
    pc.add_argument("--event-time", type=_time("event_time"), help=f"when the preference became true ({_ISO})")
    pc.set_defaults(
        func=lambda g, a: g.preferences.create(
            a.subject,
            a.key,
            a.value,
            id=a.id,
            kind=a.kind,
            about_entity=a.about,
            strength=a.strength,
            properties=_kv(a.prop, "--prop"),
            event_time=a.event_time,
        )
    )
    _id_command(pref, "preferences", "get", help="print the current version of a preference")
    pl = pref.add_parser("list", help="list current preferences, for one subject or all")
    pl.add_argument("subject", nargs="?", help="subject entity id (omit to list every subject)")
    pl.add_argument("--key")
    pl.add_argument("--kind", choices=get_args(Kind))
    _add_list_paging(pl)
    pl.set_defaults(
        func=lambda g, a: g.preferences.list(a.subject, key=a.key, kind=a.kind, cursor=a.cursor, limit=a.limit)
    )
    pu = pref.add_parser("update", help="make a new version with a changed strength or properties")
    pu.add_argument("id")
    pu.add_argument("--strength", type=float)
    pu.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"set property (repeatable){_JSON_VALUE}")
    pu.add_argument("--remove-prop", action="append", metavar="KEY", help="remove a property (repeatable)")
    pu.add_argument("--event-time", type=_time("event_time"), help=f"when the new version became true ({_ISO})")
    pu.add_argument(
        "--clear",
        action="append",
        choices=PREFERENCE_CLEARABLE,
        metavar="FIELD",
        help=f"clear a field (repeatable): {', '.join(PREFERENCE_CLEARABLE)}",
    )
    pu.set_defaults(
        func=lambda g, a: g.preferences.update(
            a.id,
            **require_changes(
                present(
                    strength=a.strength,
                    properties=_kv(a.prop, "--prop"),
                    remove_properties=a.remove_prop,
                    event_time=a.event_time,
                    clear=a.clear,
                )
            ),
        )
    )
    _add_versions(pref, "preferences", "preference")
    _id_command(pref, "preferences", "delete", help="delete a preference and its versions")

    dec = sub.add_parser("decision", help="create/get/list/update/delete decision traces").add_subparsers(
        dest="action", required=True
    )
    dc = dec.add_parser("create", help="record a decision trace over ordered relation steps")
    dc.add_argument("title")
    dc.add_argument("--step", action="append", help="relation id, in order (repeatable; default no steps)")
    dc.add_argument("--id")
    dc.add_argument("--actor", help="actor entity id")
    dc.add_argument("--summary")
    dc.add_argument("--rationale")
    dc.add_argument("--outcome", help="outcome entity id")
    dc.add_argument("--alternative", action="append", help="alternative entity id (repeatable)")
    dc.add_argument("--status", choices=get_args(Status), default="completed")
    dc.add_argument("--event-time", type=_time("event_time"), help=f"when the decision was made ({_ISO})")
    dc.set_defaults(
        func=lambda g, a: g.decisions.create(
            a.title,
            steps=a.step or [],
            id=a.id,
            actor_entity=a.actor,
            summary=a.summary,
            rationale=a.rationale,
            outcome_entity=a.outcome,
            alternative_entities=a.alternative or (),
            status=a.status,
            event_time=a.event_time,
        )
    )
    _id_command(dec, "decisions", "get", help="print one decision trace")
    dl = dec.add_parser("list", help="list decision traces, filtered by actor or status")
    dl.add_argument("--actor", help="actor entity id")
    dl.add_argument("--status", choices=get_args(Status))
    _add_list_paging(dl)
    dl.set_defaults(
        func=lambda g, a: g.decisions.list(actor_entity=a.actor, status=a.status, cursor=a.cursor, limit=a.limit)
    )
    dupd = dec.add_parser("update", help="change a decision trace's fields or steps")
    dupd.add_argument("id")
    dupd.add_argument("--title")
    dupd.add_argument("--summary")
    dupd.add_argument("--rationale")
    dupd.add_argument("--status", choices=get_args(Status))
    dupd.add_argument("--step", action="append", help="replace steps (repeatable, ordered; --clear steps empties them)")
    dupd.add_argument("--actor", help="actor entity id")
    dupd.add_argument("--outcome", help="outcome entity id")
    dupd.add_argument("--alternative", action="append", help="replace alternative entity ids (repeatable)")
    dupd.add_argument("--event-time", type=_time("event_time"), help=f"when the decision was made ({_ISO})")
    dupd.add_argument(
        "--clear",
        action="append",
        choices=DECISION_CLEARABLE,
        metavar="FIELD",
        help=f"clear a field (repeatable): {', '.join(DECISION_CLEARABLE)}",
    )
    dupd.set_defaults(
        func=lambda g, a: g.decisions.update(
            a.id,
            **require_changes(
                present(
                    title=a.title,
                    summary=a.summary,
                    rationale=a.rationale,
                    status=a.status,
                    steps=a.step,
                    actor_entity=a.actor,
                    outcome_entity=a.outcome,
                    alternative_entities=a.alternative,
                    event_time=a.event_time,
                    clear=a.clear,
                )
            ),
        )
    )
    _id_command(dec, "decisions", "delete", help="delete a decision trace")

    _finish(parser)
    return parser


async def dispatch(graph, args: argparse.Namespace) -> int:
    """Run one parsed command against an open graph and print its JSON result.

    @param graph (SelfGraph | None): the open graph to run the command against.
    @param args (argparse.Namespace): the parsed command and its options.
    @return (int): the process exit code.
    """
    result = await args.func(graph, args)
    print(result if isinstance(result, _Text) else dumps(result), flush=True)
    return 0


class _StderrHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        """Print a library diagnostic to the current stderr.

        @param record (logging.LogRecord): the record.
        @return (None): nothing.
        """
        print(f"selfgraph: {surface_hint(record.getMessage())}", file=sys.stderr, flush=True)


async def _run_with_diagnostics(args: argparse.Namespace, settings: GraphSettings) -> int:
    """Run a command showing the library's warnings and progress (such as 'extracting chunk 3/12') on stderr.

    @param args (argparse.Namespace): the parsed command.
    @param settings (GraphSettings): the resolved settings.
    @return (int): the process exit code.
    """
    logger = logging.getLogger("selfgraph")
    handler, level = _StderrHandler(logging.INFO), logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        if args.command == "version":
            return await dispatch(None, args)
        graph = build_graph(settings)
        try:
            return await dispatch(graph, args)
        finally:
            await graph.close()
    finally:
        logger.removeHandler(handler)
        logger.setLevel(level)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = settings_from_env(**{key: getattr(args, key, None) for key in SETTING_KEYS})
    args.store, args.namespace = store_kind(settings), settings.namespace
    ignored = ignored_settings(settings) if args.command != "version" else []
    for key in ignored:
        if getattr(args, key, None) is not None:
            print(f"warning: --{key} is ignored by store {args.store}", file=sys.stderr)
    settings = dataclasses.replace(settings, **dict.fromkeys(ignored))
    try:
        settings = check_settings(settings)
        if args.command == "mcp":
            from .mcp.server import run_stdio

            run_stdio(settings)
            return 0
        return asyncio.run(_run_with_diagnostics(args, settings))
    except BrokenPipeError:
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 141
    except KeyboardInterrupt:
        return 130
    except (SelfGraphError, FileNotFoundError, RuntimeError) as exc:
        print(f"error: {surface_hint(str(exc)).rstrip()}", file=sys.stderr)
        return 2 if isinstance(exc, _USAGE_ERRORS) else 1


if __name__ == "__main__":
    sys.exit(main())
