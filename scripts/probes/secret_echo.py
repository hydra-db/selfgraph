#!/usr/bin/env python3
import argparse
import asyncio
import io
import os
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "src"))

DEAD_URI = "bolt://127.0.0.1:1"

PASSWORDS = [
    "plainTOKEN0END",
    "pa/ss?TOKEN1END#frag",
    "user@TOKEN2END:host",
    "x$&TOKEN3END",
    "ｆｕｌTOKEN4END",
    "[TOKEN5END]://",
    "'\"TOKEN6END\\",
]


def _chain_text(exc):
    """Render an exception, its repr, and its full cause and context chain as text.

    @param exc (BaseException): the raised exception.
    @return (str): everything a careless caller might print or log.
    """
    parts = [str(exc), repr(exc)]
    parts.extend(traceback.format_exception(type(exc), exc, exc.__traceback__))
    seen = set()
    cursor = exc
    while cursor is not None and id(cursor) not in seen:
        seen.add(id(cursor))
        parts.append(repr(cursor))
        parts.append(str(cursor))
        cursor = cursor.__cause__ or cursor.__context__
    return "\n".join(parts)


async def _api_direct(store_kind, uri, password):
    """Open a store with a marker password through the SDK and capture the failure text.

    @param store_kind (str): the bolt store kind.
    @param uri (str): the dead bolt uri.
    @param password (str): the marker password.
    @return (str): the captured text.
    """
    import selfgraph

    stores = {"neo4j": selfgraph.Neo4jStore, "hydradb": selfgraph.HydraDBStore, "cypher": selfgraph.CypherStore}
    out = io.StringIO()
    try:
        with redirect_stdout(out), redirect_stderr(out):
            graph = selfgraph.SelfGraph(store=stores[store_kind](uri, auth=("neo4j", password)))
            await graph.entities.list()
    except Exception as exc:  # noqa: BLE001
        return out.getvalue() + _chain_text(exc)
    return out.getvalue()


async def _api_settings(store_kind, uri, password, embed):
    """Build a graph from settings, with the password embedded in the uri when asked, and capture the failure.

    @param store_kind (str): the bolt store kind.
    @param uri (str): the dead bolt uri.
    @param password (str): the marker password.
    @param embed (bool): embed the credential in the uri instead of the auth field.
    @return (str): the captured text.
    """
    from selfgraph.runtime import GraphSettings, build_graph, check_settings

    out = io.StringIO()
    if embed:
        settings = GraphSettings(store=store_kind, uri=f"bolt://neo4j:{password}@127.0.0.1:1")
    else:
        settings = GraphSettings(store=store_kind, uri=uri, auth=f"neo4j:{password}")
    try:
        with redirect_stdout(out), redirect_stderr(out):
            check_settings(settings)
            graph = build_graph(settings)
            await graph.entities.list()
    except Exception as exc:  # noqa: BLE001
        return out.getvalue() + _chain_text(exc)
    return out.getvalue()


def _text(stream):
    """Read everything written to a stream made by _cli.

    @param stream (io.TextIOWrapper): the stream.
    @return (str): the text.
    """
    return stream.buffer.getvalue().decode("utf-8")


def _cli(store_kind, uri, password):
    """Run the CLI against the dead store with a marker password and capture both streams.

    @param store_kind (str): the bolt store kind.
    @param uri (str): the dead bolt uri.
    @param password (str): the marker password.
    @return (str): stdout and stderr.
    """
    from selfgraph.cli import main

    out, err = (io.TextIOWrapper(io.BytesIO(), encoding="utf-8", write_through=True) for _ in range(2))
    argv = ["--store", store_kind, "--uri", uri, "--auth", f"neo4j:{password}", "entity", "list"]
    try:
        with redirect_stdout(out), redirect_stderr(err):
            main(argv)
    except Exception as exc:  # noqa: BLE001
        return _text(out) + _text(err) + _chain_text(exc)
    return _text(out) + _text(err)


async def _mcp(store_kind, uri, password):
    """Configure the MCP server with a marker password, call a tool, and capture the failure.

    @param store_kind (str): the bolt store kind.
    @param uri (str): the dead bolt uri.
    @param password (str): the marker password.
    @return (str): the captured text.
    """
    from selfgraph.mcp import server
    from selfgraph.runtime import GraphSettings

    out = io.StringIO()
    try:
        with redirect_stdout(out), redirect_stderr(out):
            await server.configure(GraphSettings(store=store_kind, uri=uri, auth=f"neo4j:{password}"))
            await server.list_entities()
    except Exception as exc:  # noqa: BLE001
        text = out.getvalue() + _chain_text(exc)
    else:
        text = out.getvalue()
    finally:
        try:
            await server.close()
        except Exception:  # noqa: BLE001
            pass
    return text


async def run(store_kind):
    """Run every entry point for every marker password and collect any leaks.

    @param store_kind (str): the bolt store kind to probe.
    @return (list[tuple[str, str, str]]): (path, password, token) for each leak.
    """
    leaks = []
    for password in PASSWORDS:
        token = password[password.index("TOKEN") : password.index("END") + 3]
        checks = [
            ("api.direct", await _api_direct(store_kind, DEAD_URI, password)),
            ("api.settings", await _api_settings(store_kind, DEAD_URI, password, embed=False)),
            ("api.uri_embedded", await _api_settings(store_kind, DEAD_URI, password, embed=True)),
            ("cli", _cli(store_kind, DEAD_URI, password)),
            ("mcp", await _mcp(store_kind, DEAD_URI, password)),
        ]
        for path, text in checks:
            if token in text or password in text:
                leaks.append((path, password, token))
    return leaks


def main(argv=None):
    """Scan the bolt credential paths for a leaked marker password.

    @param argv (list[str] | None): command line arguments.
    @return (int): 0 when nothing leaked, 1 otherwise.
    """
    parser = argparse.ArgumentParser(description="Force connection failures with a marker password and grep for it.")
    parser.add_argument("--store", default="neo4j", choices=["neo4j", "hydradb", "cypher"], help="bolt store kind")
    args = parser.parse_args(argv)
    leaks = asyncio.run(run(args.store))
    print(f"secret-echo scan: store {args.store}, {len(PASSWORDS)} passwords, 5 paths each")
    print("       target is a dead port (127.0.0.1:1); no real server is contacted")
    if leaks:
        for path, password, token in leaks:
            print(f"[LEAK] {path}: marker {token!r} appeared in output for password {password!r}")
        print(f"\nsecret-echo scan: FAIL, {len(leaks)} leak(s); mask the credential in that path")
        return 1
    print("       no marker reached stdout, stderr, or any exception in the chain")
    print("\nsecret-echo scan: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
