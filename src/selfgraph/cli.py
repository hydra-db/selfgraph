from __future__ import annotations

import argparse
import asyncio
import dataclasses
import errno
import logging
import os
import re
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, NoReturn, get_args

from . import _ops
from ._install import AGENTS, apply_changes, plan_install, server_command
from .errors import (
    WARNING_HINTS,
    NotFoundError,
    SelfGraphError,
    ValidationError,
    internal_error,
    redact_uris,
    surface_hint,
)
from .models import Stance, Status
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
    checked_cypher,
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
schema export [--to neo4j|ossie]: print the active schema as a Neo4j graph schema or an Apache Ossie ontology"""
_USAGE_CODES = frozenset(
    {
        "invalid_argument",
        "unknown_key",
        "invalid_setting",
        "llm_required",
        "embedder_required",
        "schema_required",
        "schema_violation",
        "immutable_identity",
        "unknown_reference",
        "relation_certified",
        "relation_invalidated",
        "merge_reverted",
        "invalid_cursor",
        "invalid_resolver_decision",
        "read_only_query",
        "cypher_query_limit",
        "invalid_prompt_template",
    }
)
_EVIDENCE_HELP = (
    "evidence as JSON: {source_id, chunk_id?, quote?, start_offset?, end_offset?, confidence?} or an array of them "
    "(repeatable)"
)


class _Text(str):
    pass


_FAILED_COMMAND: list[str | None] = [None]


class _Parser(argparse.ArgumentParser):
    """An argument parser whose flag errors carry SelfGraph's code, field, and hint.

    argparse normally prints a usage dump for an invalid `type=` or `choices=`.
    Those failures are the same invalid_argument the API reports, so they go
    through `error_text` like every other usage error.
    """

    def error(self, message: str) -> NoReturn:
        """Raise a coded error for an invalid flag value instead of printing usage.

        @param message (str): argparse's description of the bad value.
        @return (NoReturn): never returns; raises ValidationError.
        """
        match = _ARGUMENT_ERROR.search(message)
        flag = match.group(1) if match else None
        if match and "invalid int value" in message:
            kind = "an integer"
        elif match and "invalid float value" in message:
            kind = "a number"
        else:
            kind = None
        if match and kind is not None:
            value = message.rsplit(": ", 1)[-1]
            text = f"{flag} expects {kind}, got {value}"
        elif match and "invalid choice" in message:
            _, _, detail = message.partition(": ")
            value, _, choices = detail.removeprefix("invalid choice: ").partition(" (choose from ")
            text = f"{flag} got {value}; choose from {_unquote_choices(choices.rstrip(')'))}"
        elif match:
            text = message.removeprefix(f"argument {flag}: ")
        else:
            text = message
        field = flag.removeprefix("--").replace("-", "_") if flag else None
        code = "invalid_setting" if flag in _SETTING_FLAGS else "invalid_argument"
        _FAILED_COMMAND[0] = self.prog
        raise ValidationError(text, code=code, field=field)


def _unquote_choices(choices: str) -> str:
    """Drop the quotes argparse puts around each choice, so the text matches the TypeScript CLI.

    @param choices (str): the choices as argparse prints them, such as "'a', 'b'".
    @return (str): the choices joined by commas, such as "a, b".
    """
    return ", ".join(part.strip().strip("'\"") for part in choices.split(","))


_ARGUMENT_ERROR = re.compile(r"argument (--[\w-]+):")
_ARGUMENT_VALUE = re.compile(r"^(?:argument --[\w-]+: )?(?:invalid \w+ value|invalid choice):? ?")
_SETTING_FLAGS = frozenset({"--store", "--schema-mode", "--resolver", "--contradiction", "--level", "--max-tier"})


def _time(field: str) -> Callable[[str], datetime | None]:
    """An argparse type that parses an ISO 8601 flag with the shared parser.

    @param field (str): the parameter name, for the error.
    @return (Callable[[str], datetime | None]): the converter.
    """

    def convert(value: str) -> datetime | None:
        try:
            return parse_time(value, field)
        except ValidationError as exc:
            raise ValidationError(str(exc), field=field) from exc

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
            out[key] = parse_json(value, field=key)
        except ValidationError:
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
        known_at=args.known_at,
        seeds=args.seeds,
        skip_hubs=args.skip_hubs,
    )
    return _Text(result.context) if args.context_only else result


async def _diff(graph, args):
    result = await graph.diff(args.since, args.until)
    if args.json:
        return result
    lines = [f"Changes ({result.since.isoformat()}, {result.until.isoformat()}]"]
    lines += [f"Note: {limitation}" for limitation in result.limitations]
    lines += [f"+ entity {e.id}" for e in result.entities_created]
    for mark, relations in (("+", result.relations_added), ("~", result.relations_revised)):
        lines += [
            f"{mark} relation {r.id} revision {r.revision}: {r.from_entity} -[{r.type}]-> {r.to_entity}"
            for r in relations
        ]
    lines += [
        f"- relation {r.id}: {r.from_entity} -[{r.type}]-> {r.to_entity} invalidated_by={r.invalidated_by}"
        for r in result.relations_retired
    ]
    for action, relations in (("certified", result.relations_certified), ("uncertified", result.relations_uncertified)):
        lines += [f"* {action} relation {r.id} revision {r.revision}" for r in relations]
    for mark, preferences in (("+", result.preferences_added), ("~", result.preferences_revised)):
        lines += [
            f"{mark} preference {p.id} revision {p.revision}: {p.subject_entity} {p.key} -> {p.value_entity}"
            for p in preferences
        ]
    for mark, decisions in (("+", result.decisions_created), ("~", result.decisions_updated)):
        lines += [f"{mark} decision {d.id}: {d.title}" for d in decisions]
    lines += [f"+ merge {m.id}: {m.absorbed_id} into {m.survivor_id}" for m in result.entities_merged]
    lines += [f"- merge {m.id}: {m.absorbed_id} out of {m.survivor_id}" for m in result.entities_unmerged]
    lines += [f"+ source {v.source_id} version {v.id}" for v in result.source_versions_added]
    lines.append(
        f"{len(result.entities_created)} entities created, {len(result.relations_added)} relations added, "
        f"{len(result.relations_revised)} revised, {len(result.relations_retired)} retired, "
        f"{len(result.relations_certified)} certified, {len(result.relations_uncertified)} uncertified, "
        f"{len(result.preferences_added)} preferences added, {len(result.preferences_revised)} revised, "
        f"{len(result.decisions_created)} decisions created, {len(result.decisions_updated)} updated, "
        f"{len(result.entities_merged)} merges, {len(result.entities_unmerged)} unmerges, "
        f"{len(result.source_versions_added)} source versions added"
    )
    return _Text("\n".join(lines))


async def _prune(graph, args):
    return surfaced(
        await graph.maintenance.prune(
            min_relevance=args.min_relevance,
            older_than=args.older_than,
            types=args.type,
            relation_types=args.relation_type,
            include_certified=args.include_certified,
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
            out.update(parse_json(item, " in --metadata", "metadata"))
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
        value = parse_json(item, " in --evidence", "evidence")
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
    """Log each insert warning as one "code: message" line, except those the library already logged.

    @param result (Any): the insert result.
    @return (Any): the same result, its warnings worded for the CLI.
    """
    for w in surfaced(result).warnings:
        if w.code not in _LOGGED_WARNINGS:
            logging.getLogger("selfgraph").warning("%s: %s", w.code, w.message)
    return result


async def _schema_import(graph, args):
    data = read_json(args.path, "path")
    if isinstance(data, dict) and {"entities", "relations"} & data.keys() and not set(_NEO4J_KEYS) & data.keys():
        raise ValidationError(
            f"{args.path!r} looks like a SelfGraph schema, not a Neo4j one; pass it as --schema instead"
        )
    return Schema.from_neo4j_ontology(data)


async def _schema_export(graph, args):
    if graph.schema is None:
        raise ValidationError(f"no schema to export; {_NO_SCHEMA}", code="schema_required")
    return graph.schema.to_ossie() if args.target == "ossie" else graph.schema.to_neo4j_ontology()


async def _export_obsidian(graph, args):
    folder = Path(args.directory)
    notes = await graph.export_obsidian()
    try:
        for path, text in notes.items():
            target = folder / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
    except OSError as exc:
        code = exc.errno
        if code == errno.EEXIST and exc.filename is not None and Path(exc.filename) != folder:
            code = errno.ENOTDIR
        kind = {
            errno.EEXIST: "file exists",
            errno.ENOTDIR: "not a directory",
            errno.EACCES: "permission denied",
            errno.EPERM: "permission denied",
            errno.ENOENT: "no such directory",
        }.get(code)
        raise ValidationError(
            f"cannot write the vault to {str(folder)!r}: {kind or exc.strerror or exc}", field="directory"
        ) from exc
    return {"directory": str(folder), "notes": len(notes)}


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
            if resource == "entities":
                raise await _ops.missing_entity(graph.store, graph.namespace, args.id)
            raise NotFoundError(_OBJECT_TYPES[resource], args.id, namespace=graph.namespace)
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
    parser = _Parser(
        prog="selfgraph",
        description="Build and read a SelfGraph knowledge graph. Connection flags may come before or after the "
        "subcommand.",
    )
    parser.add_argument("-V", "--version", action="version", version=_installed_version())
    _add_globals(parser)

    sub = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)

    sub.add_parser(
        "init", help="check the connection and create the store's indexes or constraints where the backend has them"
    ).set_defaults(func=_init)
    sub.add_parser("version", help="print the installed version").set_defaults(func=_version)
    mcp_help = "run the MCP server over stdio; it honours the global options listed below"
    mcp = sub.add_parser("mcp", help="run the MCP server over stdio", description=mcp_help)
    _add_globals(mcp, nested=True, listed=True)
    mcp.set_defaults(func=None)
    install_help = (
        "add the MCP server to an agent's config; the global options given here go into its env as SELFGRAPH_* "
        "variables"
    )
    ins = sub.add_parser("install", help="add the MCP server to an agent's config", description=install_help)
    agents_help = f"{', '.join(AGENTS)} (default: every agent whose config folder exists)"
    ins.add_argument("agents", nargs="*", metavar="AGENT", help=agents_help)
    ins.add_argument("--global", dest="user", action="store_true", help="write the user-level config")
    ins.add_argument("--dry-run", action="store_true", help="print what would change and write nothing")
    _add_globals(ins, nested=True, listed=True)
    ins.set_defaults(func=None)
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
    se = sca.add_parser("export", help="print the active schema (--schema) as a Neo4j graph schema or Ossie ontology")
    se.add_argument("--to", dest="target", choices=["neo4j", "ossie"], default="neo4j", help="the target format")
    se.set_defaults(func=_schema_export)

    sub.add_parser(
        "readiness", help="check the store is reachable and the namespace holds data, with counts and lint"
    ).set_defaults(func=lambda g, a: g.readiness())
    ca = sub.add_parser(
        "check-answerable", help="judge whether the graph holds what a question asks about; words join into one"
    )
    ca.add_argument("question", nargs="+")
    ca.add_argument(
        "--term", action="append", help="a key phrase to check instead of the question's words (repeatable)"
    )
    ca.add_argument("--as-of", type=_time("as_of"), help=f"judge the graph as of this time ({_ISO})")
    ca.add_argument("--known-at", type=_time("known_at"), help=f"judge only what the graph held at this time ({_ISO})")
    ca.add_argument("--depth", type=int, default=3, help="most hops between matched entities (default 3)")
    ca.set_defaults(
        func=lambda g, a: g.check_answerable(
            " ".join(a.question), terms=a.term, as_of=a.as_of, known_at=a.known_at, depth=a.depth
        )
    )
    ex = sub.add_parser("export", help="export the graph").add_subparsers(dest="target", required=True)
    eo = ex.add_parser("obsidian", help="write the namespace as an Obsidian vault of Markdown notes into DIRECTORY")
    eo.add_argument("directory")
    eo.set_defaults(func=_export_obsidian)

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
    q.set_defaults(func=lambda g, a: checked_cypher(g, a.cypher, bind_params(a.cypher, _kv(a.param, "--param"))))

    diff = sub.add_parser("diff", help="list stored changes by known time, in (since, until]")
    diff.add_argument("--since", required=True, type=_time("since"), help="exclusive known-time lower bound (ISO 8601)")
    diff.add_argument("--until", type=_time("until"), help="inclusive known-time upper bound (ISO 8601; default now)")
    diff.add_argument("--json", action="store_true", help="print structured changes instead of a summary")
    diff.set_defaults(func=_diff)

    rt = sub.add_parser("retrieve", help="retrieve graph context for a query; unquoted words join into one query")
    rt.add_argument("query", nargs="+")
    rt.add_argument("--strategy", choices=STRATEGIES, default=None, help="traversal order, or ppr for PageRank ranking")
    rt.add_argument("--seeds", choices=LADDERS["seeds"], default=None, help="seeding tier (default: the level's)")
    rt.add_argument("--depth", type=int, default=3, help="traversal hops (default 3)")
    rt.add_argument("--k", type=int, default=20, help="seed count (default 20)")
    rt.add_argument("--max-nodes", type=int, default=200, help="entity cap (default 200)")
    rt.add_argument("--budget-tokens", type=int, default=3000, help="context budget (default 3000)")
    rt.add_argument("--as-of", type=_time("as_of"), help=f"read the graph as of this time ({_ISO})")
    rt.add_argument("--known-at", type=_time("known_at"), help=f"read only what the graph held at this time ({_ISO})")
    rt.add_argument("--skip-hubs", action="store_true", help="do not walk through entities with 50 or more relations")
    rt.add_argument("--context-only", action="store_true", help="print only the context text, not the JSON result")
    rt.set_defaults(func=_retrieve)

    mt = sub.add_parser("maintenance", help="decay (score relevance), prune, or deduplicate relations")
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
    mp.add_argument(
        "--include-certified", action="store_true", help="also remove certified relations and the entities they connect"
    )
    mp.add_argument("--apply", action="store_true", help="remove what the plan lists")
    mp.set_defaults(func=_prune)
    mc = mta.add_parser("dedupe-relations", help="merge duplicate parallel relations; prints the plan unless --apply")
    mc.add_argument("--apply", action="store_true", help="merge the groups the plan lists")
    mc.set_defaults(func=lambda g, a: g.maintenance.dedupe_relations(dry_run=not a.apply))

    ins = sub.add_parser("insert", help="insert text or facts").add_subparsers(dest="what", required=True)
    it = ins.add_parser("text", help="extract facts from text (LLM if configured, else NER or regex)")
    it.add_argument("text", help="the text, or '-' for stdin")
    it.add_argument("--source-id")
    it.add_argument("--event-time", type=_time("event_time"), help=f"when the text's facts became true ({_ISO})")
    it.add_argument(
        "--metadata",
        action="append",
        metavar="JSON|KEY=VALUE",
        help=f"source metadata: a JSON object, or KEY=VALUE pairs (repeatable){_JSON_VALUE}",
    )
    it.add_argument(
        "--replace-source",
        action="store_true",
        help="the text replaces --source-id's earlier versions: retire relations only they stated",
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
                replace_source=a.replace_source,
            )
        )

    it.set_defaults(func=insert_text)

    io = ins.add_parser("facts", help="insert ready facts (JSON file or '-' for stdin)")
    io.add_argument("path", help="the facts JSON file, or '-' to read it from stdin")
    io.add_argument("--source-id")
    io.add_argument(
        "--event-time",
        type=_time("event_time"),
        help=f"default event time for relations, preferences, and decisions without their own ({_ISO})",
    )
    _add_call_overrides(io)

    async def insert_facts(g, a):
        return _inserted(
            await g.insert.facts(
                read_json(a.path, "path"),
                source_id=a.source_id,
                event_time=a.event_time,
                resolver=a.call_resolver,
                contradiction=a.call_contradiction,
            )
        )

    io.set_defaults(func=insert_facts)

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

    rel = sub.add_parser(
        "relation", help="create/get/list/versions/evidence/update/certify/delete relations"
    ).add_subparsers(dest="action", required=True)
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
    rce = rel.add_parser("certify", help="mark a current relation as verified, so nothing retires it automatically")
    rce.add_argument("id")
    rce.add_argument("--by", required=True, help="who verified it")
    rce.set_defaults(func=lambda g, a: g.relations.certify(a.id, by=a.by))
    _id_command(rel, "relations", "uncertify", help="remove a relation's certification")
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
    pc.add_argument("--stance", choices=get_args(Stance), default="preference")
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
            stance=a.stance,
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
    pl.add_argument("--stance", choices=get_args(Stance))
    _add_list_paging(pl)
    pl.set_defaults(
        func=lambda g, a: g.preferences.list(a.subject, key=a.key, stance=a.stance, cursor=a.cursor, limit=a.limit)
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
    def __init__(self, level: int) -> None:
        """A handler that prints library diagnostics, with a warning code's hint the first time the code appears.

        @param level (int): the lowest level to print.
        """
        super().__init__(level)
        self._hinted: set[str] = set()

    def emit(self, record: logging.LogRecord) -> None:
        """Print a library diagnostic to the current stderr.

        @param record (logging.LogRecord): the record.
        @return (None): nothing.
        """
        message = record.getMessage()
        code = message.partition(": ")[0]
        hint = "" if code in self._hinted or code not in WARNING_HINTS else f"\nhint: {WARNING_HINTS[code]}"
        self._hinted.add(code)
        print(f"selfgraph: {surface_hint(message)}{hint}", file=sys.stderr, flush=True)


def _command_path(parser: argparse.ArgumentParser, args: argparse.Namespace | None) -> str:
    """Name the subcommand that ran, such as "selfgraph relation certify".

    @param parser (argparse.ArgumentParser): the CLI parser.
    @param args (argparse.Namespace | None): the parsed command, or None when parsing itself failed.
    @return (str): the command.
    """
    words = ["selfgraph"]
    while sub := next((a for a in parser._actions if isinstance(a, argparse._SubParsersAction)), None):
        name = getattr(args, sub.dest, None) if args is not None else None
        if name is None:
            break
        words.append(name)
        parser = sub.choices[name]
    return " ".join(words)


def error_text(exc: SelfGraphError, command: str) -> str:
    """Format an error for stderr: the code and message, the command, the field at fault, the hint, and both links.

    @param exc (SelfGraphError): the error.
    @param command (str): the command that failed, such as "selfgraph relation certify".
    @return (str): the lines.
    """
    lines = [f"error[{exc.code}]: {surface_hint(str(exc)).rstrip()}", f"command: {command}"]
    if exc.field is not None:
        lines.append(f"field: {exc.field}")
    lines += [f"hint: {exc.hint}", f"docs: {exc.docs}", f"agent guide: {exc.agent_guide}"]
    return "\n".join(lines)


def _install(args: argparse.Namespace, settings: dict[str, str]) -> int:
    """Add the MCP server to each agent's config and print one line per file.

    @param args (argparse.Namespace): the parsed install command.
    @param settings (dict[str, str]): the settings given as flags that the store does not ignore.
    @return (int): the process exit code.
    """
    command, server_args = server_command()
    changes = plan_install(
        args.agents,
        user=args.user,
        command=command,
        args=server_args,
        settings=settings,
        cwd=Path.cwd(),
        home=Path.home(),
    )
    print("\n".join(apply_changes(changes, dry_run=args.dry_run)), flush=True)
    return 0


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


def _utf8_stdio() -> None:
    """Make stdout and stderr write UTF-8 whatever the locale or `PYTHONIOENCODING` chose.

    Windows opens a piped stream with the ANSI code page, so a name outside it made `print` raise after the command had
    already committed, and one inside it came out as bytes that are not UTF-8. Each stream keeps its error handler, so
    stderr still escapes a message it cannot encode with `backslashreplace` rather than losing it.
    """
    sys.stdout.reconfigure(encoding="utf-8", errors=sys.stdout.errors)
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")


def main(argv: list[str] | None = None) -> int:
    _utf8_stdio()
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except ValidationError as exc:
        failed = _FAILED_COMMAND[0]
        _FAILED_COMMAND[0] = None
        print(error_text(exc, failed or _command_path(parser, None)), file=sys.stderr)
        return 2
    flags = {key: getattr(args, key, None) for key in SETTING_KEYS}
    settings = settings_from_env(**flags)
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
        if args.command == "install":
            return _install(args, {key: v for key, v in flags.items() if v is not None and key not in ignored})
        return asyncio.run(_run_with_diagnostics(args, settings))
    except BrokenPipeError:
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 141
    except KeyboardInterrupt:
        return 130
    except (SelfGraphError, FileNotFoundError, RuntimeError) as exc:
        command = _command_path(parser, args)
        if isinstance(exc, SelfGraphError):
            print(error_text(exc, command), file=sys.stderr)
            return 2 if _is_usage_error(exc) else 1
        if isinstance(exc, FileNotFoundError):
            masked = redact_uris(str(exc), settings.uri, settings.llm_base_url)
            print(f"error: {surface_hint(masked).rstrip()}", file=sys.stderr)
            return 2
        print(error_text(internal_error(exc, settings.uri, settings.llm_base_url), command), file=sys.stderr)
        return 1


def _is_usage_error(exc: BaseException) -> bool:
    """Whether a failed command was given invalid input or settings, which exits with code 2.

    The code decides, not the class: `invalid_setting` is raised as both ValidationError and StoreError, and both must
    exit 2 so a script telling "fix your settings" from "the server failed" branches on the code.

    @param exc (BaseException): the error that ended the command.
    @return (bool): True when the command exits 2.
    """
    return isinstance(exc, SelfGraphError) and exc.code in _USAGE_CODES


if __name__ == "__main__":
    sys.exit(main())
