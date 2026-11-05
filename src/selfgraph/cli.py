from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from .errors import SelfGraphError, ValidationError
from .runtime import STORES, GraphSettings, build_graph, dumps, settings_from_env

__all__ = ["main", "build_parser"]


def _kv(pairs: list[str] | None) -> dict[str, Any]:
    """Parse repeated key=value flags; each value is JSON if it parses, else text.

    @param pairs (list[str] | None): key=value strings to parse.
    @return (dict[str, Any]): the parsed mapping.
    """
    out: dict[str, Any] = {}
    for pair in pairs or []:
        key, sep, value = pair.partition("=")
        if not sep:
            raise ValidationError(f"expected key=value, got {pair!r}")
        try:
            out[key] = json.loads(value)
        except json.JSONDecodeError:
            out[key] = value
    return out


def _json_or_none(text: str | None) -> dict[str, Any] | None:
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"invalid JSON: {exc}") from exc


def _read_json_arg(path: str) -> Any:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"invalid JSON in {path!r}: {exc}") from exc


async def _init(graph, args):
    await graph.initialize()
    return {"ok": True, "store": args.store, "namespace": args.namespace}


async def _version(graph, args):
    import selfgraph

    return {"selfgraph": selfgraph.__version__}


async def _query(graph, args):
    return await graph.run_cypher(args.cypher, _kv(args.param))


async def _retrieve(graph, args):
    return await graph.retrieve(
        args.query,
        strategy=args.strategy,
        depth=args.depth,
        k=args.k,
        max_nodes=args.max_nodes,
        budget_tokens=args.budget_tokens,
    )


async def _insert_text(graph, args):
    return await graph.insert.text(args.text, source_id=args.source_id, metadata=_json_or_none(args.metadata))


async def _insert_ontology(graph, args):
    return await graph.insert.ontology(_read_json_arg(args.path), source_id=args.source_id)


async def _entity_create(graph, args):
    return await graph.entities.create(
        args.name,
        args.type,
        id=args.id,
        aliases=args.alias or None,
        properties=_kv(args.prop) or None,
    )


async def _entity_get(graph, args):
    return await graph.entities.get(args.id)


async def _entity_list(graph, args):
    return await graph.entities.list(type=args.type, name=args.name, cursor=args.cursor, limit=args.limit)


async def _entity_update(graph, args):
    fields: dict[str, Any] = {}
    if args.name is not None:
        fields["name"] = args.name
    if args.type is not None:
        fields["type"] = args.type
    if args.alias:
        fields["aliases"] = args.alias
    if args.prop:
        fields["properties"] = _kv(args.prop)
    return await graph.entities.update(args.id, **fields)


async def _entity_delete(graph, args):
    return await graph.entities.delete(args.id)


async def _relation_create(graph, args):
    return await graph.relations.create(
        args.from_entity,
        args.type,
        args.to_entity,
        id=args.id,
        properties=_kv(args.prop) or None,
    )


async def _relation_get(graph, args):
    return await graph.relations.get(args.id)


async def _relation_list(graph, args):
    return await graph.relations.list(
        from_entity=args.from_entity,
        type=args.type,
        to_entity=args.to_entity,
        cursor=args.cursor,
        limit=args.limit,
    )


async def _relation_versions(graph, args):
    return await graph.relations.versions(args.id)


async def _relation_update(graph, args):
    return await graph.relations.update(
        args.id,
        set_properties=_kv(args.set) or None,
        remove_properties=args.remove or (),
    )


async def _relation_delete(graph, args):
    return await graph.relations.delete(args.id)


async def _preference_create(graph, args):
    return await graph.preferences.create(
        args.subject,
        args.key,
        args.value,
        kind=args.kind,
        strength=args.strength,
        properties=_kv(args.prop) or None,
    )


async def _preference_get(graph, args):
    return await graph.preferences.get(args.id)


async def _preference_list(graph, args):
    return await graph.preferences.list(
        args.subject, key=args.key, kind=args.kind, cursor=args.cursor, limit=args.limit
    )


async def _preference_update(graph, args):
    return await graph.preferences.update(args.id, strength=args.strength, properties=_kv(args.prop) or None)


async def _preference_delete(graph, args):
    return await graph.preferences.delete(args.id)


async def _decision_create(graph, args):
    return await graph.decisions.create(
        args.title,
        steps=args.step or [],
        id=args.id,
        actor_entity=args.actor,
        summary=args.summary,
        rationale=args.rationale,
        outcome_entity=args.outcome,
        alternative_entities=args.alternative or (),
        status=args.status,
    )


async def _decision_get(graph, args):
    return await graph.decisions.get(args.id)


async def _decision_list(graph, args):
    return await graph.decisions.list(actor_entity=args.actor, status=args.status, cursor=args.cursor, limit=args.limit)


async def _decision_update(graph, args):
    fields: dict[str, Any] = {}
    if args.title is not None:
        fields["title"] = args.title
    if args.summary is not None:
        fields["summary"] = args.summary
    if args.rationale is not None:
        fields["rationale"] = args.rationale
    if args.status is not None:
        fields["status"] = args.status
    if args.step:
        fields["steps"] = args.step
    if args.actor is not None:
        fields["actor_entity"] = args.actor
    if args.outcome is not None:
        fields["outcome_entity"] = args.outcome
    return await graph.decisions.update(args.id, **fields)


async def _decision_delete(graph, args):
    return await graph.decisions.delete(args.id)


def _add_list_paging(p: argparse.ArgumentParser) -> None:
    p.add_argument("--cursor", help="opaque cursor from a previous page's next_cursor")
    p.add_argument("--limit", type=int, default=50, help="max items (default 50)")


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
            "backend: hydradb, neo4j, cypher, falkordb, or kuzu "
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

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create the store's ID constraints").set_defaults(func=_init)
    sub.add_parser("version", help="print the installed version").set_defaults(func=_version)
    sub.add_parser("mcp", help="run the MCP server over stdio").set_defaults(func=None)

    q = sub.add_parser("query", help="run one Cypher statement")
    q.add_argument("cypher")
    q.add_argument("--param", action="append", metavar="KEY=VALUE", help="query parameter (repeatable)")
    q.set_defaults(func=_query)

    rt = sub.add_parser("retrieve", help="retrieve graph context for a query")
    rt.add_argument("query")
    rt.add_argument("--strategy", choices=["bfs", "dfs"], default="bfs", help="traversal order")
    rt.add_argument("--depth", type=int, default=3, help="traversal hops (default 3)")
    rt.add_argument("--k", type=int, default=20, help="seed count (default 20)")
    rt.add_argument("--max-nodes", type=int, default=200, help="entity cap (default 200)")
    rt.add_argument("--budget-tokens", type=int, default=3000, help="context budget (default 3000)")
    rt.set_defaults(func=_retrieve)

    ins = sub.add_parser("insert", help="insert text or an ontology").add_subparsers(dest="what", required=True)
    it = ins.add_parser("text", help="extract an ontology from text (LLM if configured, else NER or regex)")
    it.add_argument("text")
    it.add_argument("--source-id")
    it.add_argument("--metadata", help="JSON object of source metadata")
    it.set_defaults(func=_insert_text)

    io = ins.add_parser("ontology", help="insert a ready ontology (JSON file or '-' for stdin)")
    io.add_argument("path")
    io.add_argument("--source-id")
    io.set_defaults(func=_insert_ontology)

    ent = sub.add_parser("entity", help="create/get/list/delete entities").add_subparsers(dest="action", required=True)
    ec = ent.add_parser("create")
    ec.add_argument("--name", required=True)
    ec.add_argument("--type", required=True)
    ec.add_argument("--id")
    ec.add_argument("--alias", action="append", help="alias (repeatable)")
    ec.add_argument("--prop", action="append", metavar="KEY=VALUE", help="property (repeatable)")
    ec.set_defaults(func=_entity_create)
    eg = ent.add_parser("get")
    eg.add_argument("id")
    eg.set_defaults(func=_entity_get)
    el = ent.add_parser("list")
    el.add_argument("--type")
    el.add_argument("--name")
    _add_list_paging(el)
    el.set_defaults(func=_entity_list)
    eu = ent.add_parser("update")
    eu.add_argument("id")
    eu.add_argument("--name")
    eu.add_argument("--type")
    eu.add_argument("--alias", action="append", help="replace aliases (repeatable)")
    eu.add_argument("--prop", action="append", metavar="KEY=VALUE", help="set property (repeatable)")
    eu.set_defaults(func=_entity_update)
    ed = ent.add_parser("delete")
    ed.add_argument("id")
    ed.set_defaults(func=_entity_delete)

    rel = sub.add_parser("relation", help="create/get/list/versions/delete relations").add_subparsers(
        dest="action", required=True
    )
    rc = rel.add_parser("create")
    rc.add_argument("from_entity", metavar="FROM")
    rc.add_argument("type", metavar="TYPE")
    rc.add_argument("to_entity", metavar="TO")
    rc.add_argument("--id")
    rc.add_argument("--prop", action="append", metavar="KEY=VALUE", help="property (repeatable)")
    rc.set_defaults(func=_relation_create)
    rg = rel.add_parser("get")
    rg.add_argument("id")
    rg.set_defaults(func=_relation_get)
    rl = rel.add_parser("list")
    rl.add_argument("--from", dest="from_entity")
    rl.add_argument("--type")
    rl.add_argument("--to", dest="to_entity")
    _add_list_paging(rl)
    rl.set_defaults(func=_relation_list)
    rv = rel.add_parser("versions")
    rv.add_argument("id")
    rv.set_defaults(func=_relation_versions)
    ru = rel.add_parser("update", help="make a new version with changed properties")
    ru.add_argument("id")
    ru.add_argument("--set", action="append", metavar="KEY=VALUE", help="set property (repeatable)")
    ru.add_argument("--remove", action="append", metavar="KEY", help="remove property (repeatable)")
    ru.set_defaults(func=_relation_update)
    rd = rel.add_parser("delete")
    rd.add_argument("id")
    rd.set_defaults(func=_relation_delete)

    pref = sub.add_parser("preference", help="create/get/list/delete preferences").add_subparsers(
        dest="action", required=True
    )
    pc = pref.add_parser("create")
    pc.add_argument("subject", help="subject entity id")
    pc.add_argument("key")
    pc.add_argument("value", help="value entity id")
    pc.add_argument("--kind", choices=["preference", "disinterest"], default="preference")
    pc.add_argument("--strength", type=float)
    pc.add_argument("--prop", action="append", metavar="KEY=VALUE", help="property (repeatable)")
    pc.set_defaults(func=_preference_create)
    pg = pref.add_parser("get")
    pg.add_argument("id")
    pg.set_defaults(func=_preference_get)
    pl = pref.add_parser("list")
    pl.add_argument("subject", help="subject entity id")
    pl.add_argument("--key")
    pl.add_argument("--kind", choices=["preference", "disinterest"])
    _add_list_paging(pl)
    pl.set_defaults(func=_preference_list)
    pu = pref.add_parser("update")
    pu.add_argument("id")
    pu.add_argument("--strength", type=float)
    pu.add_argument("--prop", action="append", metavar="KEY=VALUE", help="set property (repeatable)")
    pu.set_defaults(func=_preference_update)
    pd = pref.add_parser("delete")
    pd.add_argument("id")
    pd.set_defaults(func=_preference_delete)

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
    dc.add_argument("--status", choices=["active", "completed", "reversed"], default="completed")
    dc.set_defaults(func=_decision_create)
    dg = dec.add_parser("get")
    dg.add_argument("id")
    dg.set_defaults(func=_decision_get)
    dl = dec.add_parser("list")
    dl.add_argument("--actor", help="actor entity id")
    dl.add_argument("--status", choices=["active", "completed", "reversed"])
    _add_list_paging(dl)
    dl.set_defaults(func=_decision_list)
    dupd = dec.add_parser("update")
    dupd.add_argument("id")
    dupd.add_argument("--title")
    dupd.add_argument("--summary")
    dupd.add_argument("--rationale")
    dupd.add_argument("--status", choices=["active", "completed", "reversed"])
    dupd.add_argument("--step", action="append", help="replace steps (repeatable, ordered)")
    dupd.add_argument("--actor", help="actor entity id")
    dupd.add_argument("--outcome", help="outcome entity id")
    dupd.set_defaults(func=_decision_update)
    dd = dec.add_parser("delete")
    dd.add_argument("id")
    dd.set_defaults(func=_decision_delete)

    return parser


def _settings_from_args(args: argparse.Namespace) -> GraphSettings:
    return settings_from_env(
        store=args.store,
        uri=args.uri,
        auth=args.auth,
        database=args.database,
        namespace=args.namespace,
        llm_provider=args.llm_provider,
        llm_model=args.llm_model,
        llm_api_key=args.llm_api_key,
        llm_base_url=args.llm_base_url,
    )


async def dispatch(graph, args: argparse.Namespace) -> int:
    """Run one parsed command against an open graph and print its JSON result.

    @param graph: the open graph to run the command against.
    @param args (argparse.Namespace): the parsed command and its options.
    @return (int): the process exit code.
    """
    result = await args.func(graph, args)
    print(dumps(result))
    return 0


async def _amain(args: argparse.Namespace, settings: GraphSettings) -> int:
    if args.command == "version":
        print(dumps(await _version(None, args)))
        return 0

    graph = build_graph(settings)
    try:
        return await dispatch(graph, args)
    finally:
        close = getattr(graph.store, "close", None)
        if close is not None:
            maybe = close()
            if asyncio.iscoroutine(maybe):
                await maybe


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = _settings_from_args(args)
    args.store, args.namespace = settings.store, settings.namespace
    try:
        if args.command == "mcp":
            from .mcp.server import run_stdio

            run_stdio(settings)
            return 0
        return asyncio.run(_amain(args, settings))
    except ValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except SelfGraphError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (BrokenPipeError, KeyboardInterrupt):
        return 130
    except (FileNotFoundError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
