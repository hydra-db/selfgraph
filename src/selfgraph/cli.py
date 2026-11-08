from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import fields
from datetime import datetime
from typing import Any, get_args

from .errors import SelfGraphError, ValidationError
from .models import Kind, Status
from .resources._common import DEFAULT_PAGE_LIMIT
from .retrieval import STRATEGIES
from .runtime import (
    STORES,
    GraphSettings,
    build_graph,
    dumps,
    parse_json,
    present,
    read_json,
    read_text,
    settings_from_env,
    store_kind,
)
from .schema import SchemaMode

__all__ = ["main", "build_parser"]

_JSON_VALUE = "; VALUE is parsed as JSON when valid (so 12345 is a number), else kept as text"


def _kv(pairs: list[str] | None, *, text: bool = False) -> dict[str, Any] | None:
    """Parse repeated key=value flags; each value is JSON if it parses, else text.

    @param pairs (list[str] | None): key=value strings to parse.
    @param text (bool): keep every value as text instead of parsing JSON.
    @return (dict[str, Any] | None): the parsed mapping, or None when no pairs were given.
    """
    if not pairs:
        return None
    out: dict[str, Any] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep:
            raise ValidationError(f"expected key=value, got {pair!r}")
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


async def _version(graph, args):
    import selfgraph

    return {"selfgraph": selfgraph.__version__}


async def _schema(graph, args):
    return graph.schema


def _add_list_paging(p: argparse.ArgumentParser) -> None:
    p.add_argument("--cursor", help="opaque cursor from a previous page's next_cursor")
    p.add_argument("--limit", type=int, default=DEFAULT_PAGE_LIMIT, help=f"max items (default {DEFAULT_PAGE_LIMIT})")


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

    def run(graph, args):
        page = {"cursor": args.cursor, "limit": args.limit} if paged else {}
        return getattr(getattr(graph, resource), action)(args.id, **page)

    p.set_defaults(func=run)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="selfgraph",
        description="Build and read a SelfGraph knowledge graph.",
    )
    parser.add_argument(
        "--store",
        default=None,
        choices=STORES,
        help=(
            "backend: hydradb, neo4j, cypher, memgraph, falkordb, or kuzu "
            "(default $SELFGRAPH_STORE, else embedded kuzu, or hydradb with --uri)"
        ),
    )
    parser.add_argument("--uri", default=None, help="Bolt URI for neo4j/cypher/hydradb, host:port for falkordb")
    parser.add_argument("--auth", default=None, help="'user:password', or a bare token (user neo4j)")
    parser.add_argument("--database", default=None, help="database name for Bolt stores")
    parser.add_argument("--namespace", default=None, help="graph namespace (default 'default')")
    parser.add_argument("--llm-provider", default=None, help="any litellm provider, e.g. anthropic, openai, ollama")
    parser.add_argument("--llm-model", default=None)
    parser.add_argument("--llm-api-key", default=None)
    parser.add_argument("--llm-base-url", default=None)
    parser.add_argument("--schema", default=None, help="schema JSON file applied to every insert")
    parser.add_argument("--schema-mode", default=None, choices=get_args(SchemaMode), help="default warn")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create the store's ID constraints").set_defaults(func=_init)
    sub.add_parser("version", help="print the installed version").set_defaults(func=_version)
    sub.add_parser("mcp", help="run the MCP server over stdio").set_defaults(func=None)
    sub.add_parser("schema", help="print the active schema").set_defaults(func=_schema)

    query_help = "run one raw Cypher statement; it can write and is not scoped to the namespace"
    q = sub.add_parser("query", help=query_help, description=query_help)
    q.add_argument("cypher")
    q.add_argument("--param", action="append", metavar="KEY=VALUE", help=f"query parameter (repeatable){_JSON_VALUE}")
    q.set_defaults(func=lambda g, a: g.run_cypher(a.cypher, _kv(a.param) or {}))

    rt = sub.add_parser("retrieve", help="retrieve graph context for a query")
    rt.add_argument("query")
    rt.add_argument(
        "--strategy", choices=STRATEGIES, default="bfs", help="traversal order, or ppr for PageRank ranking"
    )
    rt.add_argument("--depth", type=int, default=3, help="traversal hops (default 3)")
    rt.add_argument("--k", type=int, default=20, help="seed count (default 20)")
    rt.add_argument("--max-nodes", type=int, default=200, help="entity cap (default 200)")
    rt.add_argument("--budget-tokens", type=int, default=3000, help="context budget (default 3000)")
    rt.set_defaults(
        func=lambda g, a: g.retrieve(
            a.query, strategy=a.strategy, depth=a.depth, k=a.k, max_nodes=a.max_nodes, budget_tokens=a.budget_tokens
        )
    )

    ins = sub.add_parser("insert", help="insert text or an ontology").add_subparsers(dest="what", required=True)
    it = ins.add_parser("text", help="extract an ontology from text (LLM if configured, else NER or regex)")
    it.add_argument("text", help="the text, or '-' for stdin")
    it.add_argument("--source-id")
    it.add_argument("--event-time", type=datetime.fromisoformat, help="when the text's facts became true (ISO 8601)")
    it.add_argument("--metadata", help="JSON object of source metadata")
    it.set_defaults(
        func=lambda g, a: g.insert.text(
            read_text("-") if a.text == "-" else a.text,
            source_id=a.source_id,
            event_time=a.event_time,
            metadata=None if a.metadata is None else parse_json(a.metadata),
        )
    )

    io = ins.add_parser("ontology", help="insert a ready ontology (JSON file or '-' for stdin)")
    io.add_argument("path")
    io.add_argument("--source-id")
    io.set_defaults(func=lambda g, a: g.insert.ontology(read_json(a.path), source_id=a.source_id))

    ent = sub.add_parser("entity", help="create/get/list/evidence/update/delete entities").add_subparsers(
        dest="action", required=True
    )
    ec = ent.add_parser("create")
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
            external_ids=_kv(a.external_id, text=True),
            properties=_kv(a.prop),
        )
    )
    _id_command(ent, "entities", "get")
    el = ent.add_parser("list")
    el.add_argument("--type")
    el.add_argument("--name")
    _add_list_paging(el)
    el.set_defaults(func=lambda g, a: g.entities.list(type=a.type, name=a.name, cursor=a.cursor, limit=a.limit))
    _id_command(ent, "entities", "evidence", paged=True, help="list the evidence supporting an entity")
    eu = ent.add_parser("update")
    eu.add_argument("id")
    eu.add_argument("--name")
    eu.add_argument("--type")
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
                external_ids=_kv(a.external_id, text=True),
                properties=_kv(a.prop),
                remove_aliases=a.remove_alias,
                remove_properties=a.remove_prop,
            ),
        )
    )
    _id_command(ent, "entities", "delete")

    rel = sub.add_parser("relation", help="create/get/list/versions/evidence/update/delete relations").add_subparsers(
        dest="action", required=True
    )
    rc = rel.add_parser("create")
    rc.add_argument("from_entity", metavar="FROM")
    rc.add_argument("type", metavar="TYPE")
    rc.add_argument("to_entity", metavar="TO")
    rc.add_argument("--id")
    rc.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"property (repeatable){_JSON_VALUE}")
    rc.add_argument("--event-time", type=datetime.fromisoformat, help="when the fact became true (ISO 8601)")
    rc.set_defaults(
        func=lambda g, a: g.relations.create(
            a.from_entity, a.type, a.to_entity, id=a.id, properties=_kv(a.prop), event_time=a.event_time
        )
    )
    _id_command(rel, "relations", "get")
    rl = rel.add_parser("list")
    rl.add_argument("--from", dest="from_entity")
    rl.add_argument("--type")
    rl.add_argument("--to", dest="to_entity")
    _add_list_paging(rl)
    rl.set_defaults(
        func=lambda g, a: g.relations.list(
            from_entity=a.from_entity, type=a.type, to_entity=a.to_entity, cursor=a.cursor, limit=a.limit
        )
    )
    _id_command(rel, "relations", "versions")
    _id_command(rel, "relations", "evidence", paged=True, help="list the evidence supporting a relation")
    ru = rel.add_parser("update", help="make a new version with changed properties")
    ru.add_argument("id")
    ru.add_argument("--set", action="append", metavar="KEY=VALUE", help=f"set property (repeatable){_JSON_VALUE}")
    ru.add_argument("--remove", action="append", metavar="KEY", help="remove property (repeatable)")
    ru.add_argument("--event-time", type=datetime.fromisoformat, help="when the new version became true (ISO 8601)")
    ru.set_defaults(
        func=lambda g, a: g.relations.update(
            a.id, set_properties=_kv(a.set), remove_properties=a.remove or (), event_time=a.event_time
        )
    )
    _id_command(rel, "relations", "delete")

    pref = sub.add_parser("preference", help="create/get/list/versions/update/delete preferences").add_subparsers(
        dest="action", required=True
    )
    pc = pref.add_parser("create")
    pc.add_argument("subject", help="subject entity id")
    pc.add_argument("key")
    pc.add_argument("value", help="value entity id (an existing entity, e.g. tool:hydradb)")
    pc.add_argument("--id")
    pc.add_argument("--kind", choices=get_args(Kind), default="preference")
    pc.add_argument("--about", help="entity id the preference is about")
    pc.add_argument("--strength", type=float)
    pc.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"property (repeatable){_JSON_VALUE}")
    pc.add_argument("--event-time", type=datetime.fromisoformat, help="when the preference became true (ISO 8601)")
    pc.set_defaults(
        func=lambda g, a: g.preferences.create(
            a.subject,
            a.key,
            a.value,
            id=a.id,
            kind=a.kind,
            about_entity=a.about,
            strength=a.strength,
            properties=_kv(a.prop),
            event_time=a.event_time,
        )
    )
    _id_command(pref, "preferences", "get")
    pl = pref.add_parser("list")
    pl.add_argument("subject", nargs="?", help="subject entity id (omit to list every subject)")
    pl.add_argument("--key")
    pl.add_argument("--kind", choices=get_args(Kind))
    _add_list_paging(pl)
    pl.set_defaults(
        func=lambda g, a: g.preferences.list(a.subject, key=a.key, kind=a.kind, cursor=a.cursor, limit=a.limit)
    )
    pu = pref.add_parser("update")
    pu.add_argument("id")
    pu.add_argument("--strength", type=float)
    pu.add_argument("--prop", action="append", metavar="KEY=VALUE", help=f"set property (repeatable){_JSON_VALUE}")
    pu.add_argument("--remove-prop", action="append", metavar="KEY", help="remove a property (repeatable)")
    pu.add_argument("--event-time", type=datetime.fromisoformat, help="when the new version became true (ISO 8601)")
    pu.set_defaults(
        func=lambda g, a: g.preferences.update(
            a.id,
            strength=a.strength,
            properties=_kv(a.prop),
            remove_properties=a.remove_prop or (),
            event_time=a.event_time,
        )
    )
    _id_command(pref, "preferences", "versions")
    _id_command(pref, "preferences", "delete")

    dec = sub.add_parser("decision", help="create/get/list/update/delete decision traces").add_subparsers(
        dest="action", required=True
    )
    dc = dec.add_parser("create")
    dc.add_argument("title")
    dc.add_argument("--step", action="append", help="relation id, in order (repeatable)")
    dc.add_argument("--id")
    dc.add_argument("--actor", help="actor entity id")
    dc.add_argument("--summary")
    dc.add_argument("--rationale")
    dc.add_argument("--outcome", help="outcome entity id")
    dc.add_argument("--alternative", action="append", help="alternative entity id (repeatable)")
    dc.add_argument("--status", choices=get_args(Status), default="completed")
    dc.add_argument("--event-time", type=datetime.fromisoformat, help="when the decision was made (ISO 8601)")
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
    _id_command(dec, "decisions", "get")
    dl = dec.add_parser("list")
    dl.add_argument("--actor", help="actor entity id")
    dl.add_argument("--status", choices=get_args(Status))
    _add_list_paging(dl)
    dl.set_defaults(
        func=lambda g, a: g.decisions.list(actor_entity=a.actor, status=a.status, cursor=a.cursor, limit=a.limit)
    )
    dupd = dec.add_parser("update")
    dupd.add_argument("id")
    dupd.add_argument("--title")
    dupd.add_argument("--summary")
    dupd.add_argument("--rationale")
    dupd.add_argument("--status", choices=get_args(Status))
    dupd.add_argument("--step", action="append", help="replace steps (repeatable, ordered)")
    dupd.add_argument("--actor", help="actor entity id")
    dupd.add_argument("--outcome", help="outcome entity id")
    dupd.add_argument("--alternative", action="append", help="replace alternative entity ids (repeatable)")
    dupd.add_argument("--event-time", type=datetime.fromisoformat, help="when the decision was made (ISO 8601)")
    dupd.set_defaults(
        func=lambda g, a: g.decisions.update(
            a.id,
            **present(
                title=a.title,
                summary=a.summary,
                rationale=a.rationale,
                status=a.status,
                steps=a.step,
                actor_entity=a.actor,
                outcome_entity=a.outcome,
                alternative_entities=a.alternative,
                event_time=a.event_time,
            ),
        )
    )
    _id_command(dec, "decisions", "delete")

    return parser


async def dispatch(graph, args: argparse.Namespace) -> int:
    """Run one parsed command against an open graph and print its JSON result.

    @param graph (SelfGraph | None): the open graph to run the command against.
    @param args (argparse.Namespace): the parsed command and its options.
    @return (int): the process exit code.
    """
    print(dumps(await args.func(graph, args)))
    return 0


async def _amain(args: argparse.Namespace, settings: GraphSettings) -> int:
    if args.command == "version":
        return await dispatch(None, args)
    graph = build_graph(settings)
    try:
        return await dispatch(graph, args)
    finally:
        await graph.close()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = settings_from_env(**{f.name: getattr(args, f.name) for f in fields(GraphSettings)})
    args.store, args.namespace = store_kind(settings), settings.namespace
    try:
        if args.command == "mcp":
            from .mcp.server import run_stdio

            run_stdio(settings)
            return 0
        return asyncio.run(_amain(args, settings))
    except ValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (BrokenPipeError, KeyboardInterrupt):
        return 130
    except (SelfGraphError, FileNotFoundError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
