from __future__ import annotations

import json
import logging
import math
import os
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from ._maintenance import scan_entities, scan_relations
from ._ops import DECISION_CLEARABLE, PREFERENCE_CLEARABLE, invalidated_note, parse_time, require_changes
from ._serde import EDGE_TYPES, LABELS, PREFERENCE_EDGE_TYPES
from .client import SelfGraph
from .errors import STORE_KUZU_HINT, NotFoundError, StoreError, ValidationError, setting_hint, surface_hint
from .extraction.prompts import check_prompts
from .ids import _require_namespace
from .llm.base import check_llm_config
from .models import (
    LLM_CONCURRENCY,
    LLM_TIMEOUT,
    CypherResult,
    ExtractionInstructions,
    ExtractionPrompts,
    InsertResult,
    LLMConfig,
    PruneResult,
    Relation,
    as_input,
    check_options,
)
from .protocols import GraphStore
from .resolution import require_resolver
from .schema import Schema, as_schema, require_contradiction_mode, require_schema_for_mode, require_schema_mode
from .stores._cypher import parse_auth
from .tiers import require_level

__all__ = [
    "SETTING_KEYS",
    "GraphSettings",
    "build_graph",
    "check_settings",
    "settings_from_env",
    "to_jsonable",
    "dumps",
    "read_json",
    "read_text",
    "store_kind",
    "parse_time",
    "require_changes",
    "current_relation",
    "DECISION_CLEARABLE",
    "PREFERENCE_CLEARABLE",
    "surfaced",
    "blank_lexical_tokens",
    "bind_params",
    "ignored_settings",
    "cypher_names",
    "checked_cypher",
]

_log = logging.getLogger("selfgraph")

STORES = ("neo4j", "cypher", "memgraph", "hydradb", "falkordb", "kuzu")
_IGNORED_BY_STORE = {"kuzu": ("auth", "database")}
_FALKOR_SCHEMES = ("redis", "rediss", "falkor", "falkors")
_FALKOR_ADDRESS = "host:port or a redis://, rediss://, falkor://, or falkors:// URL"
_PARAM_REF = re.compile(r"\$(\w+)")
_LINE_TERMINATORS = frozenset("\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029")
_BLANK = "\x00"
_Hinted = TypeVar("_Hinted", InsertResult, PruneResult)


@dataclass
class GraphSettings:
    store: str | None = None
    uri: str | None = None
    auth: str | tuple[str, str] | None = None
    database: str | None = None
    namespace: str = "default"
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    llm_timeout: float | str | None = None
    llm_concurrency: int | str | None = None
    schema: str | Schema | Mapping[str, Any] | None = None
    instructions: str | ExtractionInstructions | Mapping[str, Any] | None = None
    prompts: str | ExtractionPrompts | Mapping[str, Any] | None = None
    schema_mode: str | None = None
    resolver: str | None = None
    contradiction: str | None = None
    level: str | None = None
    max_tier: str | None = None


SETTING_KEYS = tuple(f.name for f in fields(GraphSettings))


def settings_from_env(**overrides: Any) -> GraphSettings:
    """Read GraphSettings from SELFGRAPH_* env vars; overrides win when set.

    @param overrides (Any): field values that take precedence over the environment.
    @return (GraphSettings): the resolved settings.
    """
    check_options("settings_from_env", overrides, SETTING_KEYS)
    values: dict[str, Any] = {}
    for key in SETTING_KEYS:
        value = overrides.get(key)
        values[key] = value if value is not None else os.environ.get(f"SELFGRAPH_{key.upper()}")
    if values["namespace"] is None:
        values["namespace"] = "default"
    return GraphSettings(**values)


def read_text(path: str) -> str:
    """Read a UTF-8 text file, or stdin when the path is '-'.

    @param path (str): the file path, or '-'.
    @return (str): the text.
    """
    try:
        return sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ValidationError(f"cannot read {path!r}: {exc.strerror or exc}") from exc


def parse_json(text: str, where: str = "") -> Any:
    """Parse JSON text, naming where it came from in the error.

    @param text (str): the JSON text.
    @param where (str): appended to "invalid JSON" in the error, e.g. " in 'graph.json'".
    @return (Any): the parsed value.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"invalid JSON{where}: {exc}") from exc


def read_json(path: str) -> Any:
    """Read and parse a JSON file, or stdin when the path is '-'.

    @param path (str): the file path, or '-'.
    @return (Any): the parsed JSON.
    """
    return parse_json(read_text(path), f" in {path!r}")


def _json_setting(value: Any, what: str) -> Any:
    """Read a JSON setting such as the schema: inline JSON when it starts with "{", else a file path ('-' for stdin).

    @param value (Any): the inline JSON or the path, or an already parsed value, returned as is.
    @param what (str): the setting name, for the error on bad inline JSON.
    @return (Any): the parsed value.
    """
    if not isinstance(value, str):
        return value
    if value.lstrip().startswith("{"):
        return parse_json(value, f" in the inline {what}")
    return read_json(value)


def blank_lexical_tokens(query: str) -> str:
    """Blank string literals, backtick identifiers, and comments with one char scan that matches engine lexing.

    Quoted strings use backslash escaping; a backtick identifier escapes a backtick by doubling it; a line
    comment ends at any engine line terminator (not only newline); a block comment ends at the first '*/'. An
    unterminated token leaves the rest of the query visible so a hidden write keyword is still scanned, which
    makes the guard fail closed rather than desynchronise on a mis-modelled token boundary.

    @param query (str): the raw Cypher statement.
    @return (str): the query with each lexical token replaced by one NUL character.
    """
    out: list[str] = []
    i, n = 0, len(query)
    while i < n:
        ch = query[i]
        if ch in "'\"":
            j = i + 1
            while j < n:
                if query[j] == "\\":
                    j += 2
                    continue
                if query[j] == ch:
                    j += 1
                    break
                j += 1
            else:
                break
            out.append(_BLANK)
            i = j
        elif ch == "`":
            j = i + 1
            while j < n:
                if query[j] == "`":
                    if j + 1 < n and query[j + 1] == "`":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            else:
                break
            out.append(_BLANK)
            i = j
        elif ch == "/" and i + 1 < n and query[i + 1] == "*":
            end = query.find("*/", i + 2)
            if end == -1:
                break
            out.append(_BLANK)
            i = end + 2
        elif ch == "/" and i + 1 < n and query[i + 1] == "/":
            j = i + 2
            while j < n and query[j] not in _LINE_TERMINATORS:
                j += 1
            out.append(_BLANK)
            i = j
        else:
            out.append(ch)
            i += 1
    if i < n:
        out.append(query[i:])
    return "".join(out)


_PATTERN_NAMES = re.compile(
    r"([(\[])\s*(?:[A-Za-z_]\w*)?\s*((?::\s*(?:`[^`]+`|\w+)\s*(?:\|\s*:?\s*(?:`[^`]+`|\w+)\s*)*)+)"
)
_NAME_PART = re.compile(r"`([^`]+)`|(\w+)")
_NAME_LITERAL = re.compile(r"""(?:\.\s*name\s*=|\bname\s*:)\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")""")
_LISTED_NAMES = 20


def cypher_names(query: str) -> tuple[list[str], list[str], list[str]]:
    """Read the node labels, relationship types, and entity name literals a Cypher query matches on.

    Labels come from node patterns, (n:Label), types from relationship patterns, [r:TYPE|OTHER], and names from
    n.name = 'x' or {name: 'x'}. This is a lexical read for advice, not a parse.

    @param query (str): the Cypher query.
    @return (tuple[list[str], list[str], list[str]]): the distinct labels, relationship types, and names, in order.
    """
    labels: dict[str, None] = {}
    types: dict[str, None] = {}
    for opener, names in _PATTERN_NAMES.findall(query):
        for quoted, bare in _NAME_PART.findall(names):
            (labels if opener == "(" else types)[quoted or bare] = None
    literals = {single or double: None for single, double in _NAME_LITERAL.findall(query)}
    return list(labels), list(types), list(literals)


def _squash(text: str) -> str:
    """Collapse whitespace and casefold, so a literal matches a stored name that differs only in case or spacing.

    @param text (str): the text.
    @return (str): the squashed text.
    """
    return " ".join(text.split()).casefold()


async def _cypher_notes(graph: SelfGraph, query: str) -> list[str]:
    """Explain likely mistakes in a Cypher query that found nothing; see checked_cypher.

    @param graph (SelfGraph): the open graph.
    @param query (str): the Cypher query.
    @return (list[str]): one note per suspect label, relationship type, or name literal.
    """
    labels, types, literals = cypher_names(query)
    if not (labels or types or literals):
        return []
    ns = graph.namespace
    entities = await scan_entities(graph.store, ns)
    relations = await scan_relations(graph.store, ns)
    physical = {*LABELS, *EDGE_TYPES, *PREFERENCE_EDGE_TYPES, *getattr(graph.store, "query_labels", ())}
    notes = []
    for kind, used, stored in (
        ("label", labels, sorted({e.type for e in entities})),
        ("relationship type", types, sorted({r.type for r in relations})),
    ):
        listed = ", ".join(stored[:_LISTED_NAMES]) or "none"
        notes += [
            f"{kind} {name!r} is not stored in namespace {ns!r}; stored: {listed}"
            for name in used
            if name not in physical and name not in stored
        ]
    names = {e.name for e in entities}
    squashed: dict[str, str] = {}
    for name in sorted(names):
        squashed.setdefault(_squash(name), name)
    for literal in literals:
        near = squashed.get(_squash(literal))
        if literal not in names and near is not None:
            notes.append(f"no entity in namespace {ns!r} is named {literal!r}, but one is named {near!r}")
    return notes


async def checked_cypher(graph: SelfGraph, query: str, params: Mapping[str, Any] | None) -> CypherResult:
    """Run a Cypher query and, when it returns no rows or fails, explain likely mistakes.

    A note names each label or relationship type the namespace never stored (internal ones and the store's own
    physical names count as stored) and each name literal no entity has exactly while one differs only by letter
    case or spacing. Notes go in the result's warnings, or are appended to the StoreError of a failed query. The
    checks read every entity and relation, so they run only then.

    @param graph (SelfGraph): the open graph.
    @param query (str): the Cypher query.
    @param params (Mapping[str, Any] | None): the query parameters.
    @return (CypherResult): the result, with warnings when it is empty.
    """
    try:
        result = await graph.run_cypher(query, params)
    except StoreError as exc:
        notes = await _cypher_notes(graph, query)
        if notes:
            raise StoreError(f"{exc}; {'; '.join(notes)}") from exc
        raise
    if not result.rows:
        result.warnings = await _cypher_notes(graph, query)
    return result


def bind_params(query: str, params: Mapping[str, Any] | None) -> dict[str, Any]:
    """Check a raw query's $name parameters are all supplied and drop the supplied ones it never references.

    References inside string literals, backtick identifiers, and comments are ignored, so an engine that
    returns null for an unbound parameter or rejects an unused one never sees either.

    @param query (str): the raw Cypher statement.
    @param params (Mapping[str, Any] | None): the supplied parameters, or None.
    @return (dict[str, Any]): the supplied parameters the query references.
    """
    given = dict(params or {})
    referenced = list(dict.fromkeys(_PARAM_REF.findall(blank_lexical_tokens(query))))
    missing = [name for name in referenced if name not in given]
    if missing:
        noun = "parameter" if len(missing) == 1 else "parameters"
        raise ValidationError(f"missing {noun} {', '.join(f'${name}' for name in missing)}")
    return {key: value for key, value in given.items() if key in referenced}


def surfaced(result: _Hinted) -> _Hinted:
    """Reword an insert result's warnings, or a prune result's note, for the CLI and MCP server, which take settings
    from flags or the environment.

    @param result (InsertResult | PruneResult): the insert or prune result.
    @return (InsertResult | PruneResult): the same result.
    """
    if isinstance(result, InsertResult):
        for warning in result.warnings:
            warning.message = surface_hint(warning.message)
    elif result.note is not None:
        result.note = surface_hint(result.note)
    return result


def present(**fields: Any) -> dict[str, Any]:
    """Keep the fields that are not None, so only those reach an SDK update.

    @param fields (Any): the candidate fields.
    @return (dict[str, Any]): the fields that were given.
    """
    return {key: value for key, value in fields.items() if value is not None}


def store_kind(settings: GraphSettings) -> str:
    """The store name the settings resolve to: the named store, else hydradb with a URI, else kuzu.

    @param settings (GraphSettings): the resolved store configuration.
    @return (str): the lowercase store name.
    """
    return (settings.store or ("hydradb" if settings.uri else "kuzu")).lower()


def ignored_settings(settings: GraphSettings) -> list[str]:
    """The connection settings that are set but ignored by the store the settings resolve to.

    @param settings (GraphSettings): the resolved store configuration.
    @return (list[str]): the ignored setting names, such as "database" for kuzu.
    """
    return [key for key in _IGNORED_BY_STORE.get(store_kind(settings), ()) if getattr(settings, key)]


def _require_server_uri(kind: str, uri: str) -> None:
    """Reject a scheme-less URI that looks like a file path for a server store, which is a Kuzu path by mistake.

    @param kind (str): the resolved store name.
    @param uri (str): the configured URI.
    @return (None): nothing; raises ValidationError on a path.
    """
    if "://" not in uri and (uri.endswith(".kuzu") or "/" in uri or os.sep in uri):
        raise ValidationError(
            f"{uri!r} is not a URI for the {kind!r} store; this looks like a Kuzu path; {STORE_KUZU_HINT}"
        )


def _falkor_address(uri: str) -> tuple[Any, int | None, bool]:
    """Parse a FalkorDB address: host:port, or a redis://, rediss://, falkor://, or falkors:// URL.

    @param uri (str): the address.
    @return (tuple[Any, int | None, bool]): the parsed URL, its port (None when absent), and whether it asks for
        TLS (rediss:// or falkors://).
    """
    from urllib.parse import urlparse

    scheme = uri.partition("://")[0].lower() if "://" in uri else ""
    if scheme and scheme not in _FALKOR_SCHEMES:
        raise ValidationError(f"invalid FalkorDB address {uri!r}: the 'falkordb' store expects {_FALKOR_ADDRESS}")
    parsed = urlparse(uri if scheme else f"//{uri}")
    try:
        port = parsed.port
    except ValueError:
        port = 0
    if port == 0:
        raise ValidationError(f"invalid FalkorDB address {uri!r}: expected host:port with a port from 1 to 65535")
    return parsed, port, scheme in ("rediss", "falkors")


def _falkor_store(uri: str, settings: GraphSettings) -> GraphStore:
    """A FalkorDB store from host:port or a redis:// style URL; auth, else the URL credentials, logs in.

    @param uri (str): the address.
    @param settings (GraphSettings): the resolved auth and database settings.
    @return (GraphStore): the store.
    """
    from urllib.parse import unquote

    from .stores.falkordb import FalkorDBStore

    parsed, port, tls = _falkor_address(uri)
    if settings.auth:
        username, password = parse_auth(settings.auth, None)
    else:
        username = unquote(parsed.username) if parsed.username else None
        password = unquote(parsed.password) if parsed.password else None
    credentials: dict[str, Any] = {k: v for k, v in (("username", username), ("password", password)) if v}
    if tls:
        credentials["ssl"] = True
    return FalkorDBStore(
        host=parsed.hostname or "localhost",
        port=port or 6379,
        graph=settings.database or "selfgraph",
        **credentials,
    )


def _build_store(settings: GraphSettings) -> GraphStore:
    kind = store_kind(settings)
    for key in ignored_settings(settings):
        _log.warning("%s is ignored by store %s", key, kind)
    if kind == "kuzu":
        from .stores.kuzu import KuzuStore

        path = settings.uri or os.path.join(os.path.expanduser("~"), ".selfgraph", "default.kuzu")
        try:
            return KuzuStore(path)
        except StoreError as exc:
            if settings.store:
                raise
            raise ValidationError(
                "no store configured, so SelfGraph defaults to the embedded Kuzu backend, which needs the kuzu "
                'extra: pip install "selfgraph[kuzu]", or set SELFGRAPH_STORE and SELFGRAPH_URI for a server'
            ) from exc
    if kind in ("neo4j", "cypher", "memgraph"):
        from .stores.cypher import CypherStore, Neo4jStore

        store_cls = Neo4jStore if kind == "neo4j" else CypherStore
        return store_cls(settings.uri, auth=settings.auth, database=settings.database)
    if kind == "falkordb":
        return _falkor_store(settings.uri, settings)
    from .stores.hydradb import HydraDBStore

    return HydraDBStore(settings.uri, auth=settings.auth, database=settings.database)


def _llm_timeout(value: float | str | None) -> float:
    """Parse the LLM timeout setting: seconds as a positive number, default 120.

    @param value (float | str | None): the setting, or None for the default.
    @return (float): the timeout in seconds.
    """
    if value is None or value == "":
        return LLM_TIMEOUT
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = math.nan
    if not seconds > 0 or math.isinf(seconds):
        raise ValidationError(f"llm_timeout must be a positive number of seconds, got {value!r}")
    return seconds


def _llm_concurrency(value: int | str | None) -> int:
    """Parse the LLM concurrency setting: how many chunks extract at once, a positive integer, default 4.

    @param value (int | str | None): the setting, or None for the default.
    @return (int): the number of chunks.
    """
    if value is None or value == "":
        return LLM_CONCURRENCY
    text = value.strip() if isinstance(value, str) else value
    if isinstance(text, str) and text.lstrip("+").isdecimal():
        text = int(text)
    if type(text) is not int or text < 1:
        raise ValidationError(f"llm_concurrency must be a positive integer, got {value!r}")
    return text


def _build_llm(settings: GraphSettings) -> LLMConfig | None:
    if not settings.llm_provider and not settings.llm_model:
        return None
    provider = settings.llm_provider
    if not provider and settings.llm_model and "/" in settings.llm_model:
        provider = settings.llm_model.partition("/")[0]
    if not settings.llm_model:
        raise ValidationError(f"an LLM needs a model; pass {setting_hint('llm_model')}, e.g. gpt-4o-mini")
    if not provider:
        raise ValidationError(
            f"an LLM needs a provider; pass {setting_hint('llm_provider')}, or a provider-prefixed "
            "model such as openai/gpt-4o-mini"
        )
    return LLMConfig(
        provider=provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        timeout=_llm_timeout(settings.llm_timeout),
        concurrency=_llm_concurrency(settings.llm_concurrency),
    )


def check_settings(settings: GraphSettings) -> GraphSettings:
    """Validate every setting without a store or LLM call, so a bad one fails before any command runs.

    The schema, instructions, and prompts are read (inline JSON, a file, or '-' for stdin) and validated here,
    prompt placeholders included, so the returned settings carry them parsed and nothing reads them twice.

    @param settings (GraphSettings): the resolved settings.
    @return (GraphSettings): the settings with the schema, instructions, and prompts parsed.
    """
    _require_namespace("default" if settings.namespace is None else settings.namespace)
    if settings.uri is not None and not settings.uri.strip():
        raise ValidationError(f"uri cannot be empty; omit {setting_hint('uri')} to use the default store")
    kind = store_kind(settings)
    if kind not in STORES:
        raise ValidationError(f"unknown store {settings.store!r}; choose one of {', '.join(STORES)}")
    if kind != "kuzu":
        if not settings.uri:
            address = _FALKOR_ADDRESS if kind == "falkordb" else "a Bolt URI"
            raise ValidationError(f"the {kind!r} store needs {address}; pass {setting_hint('uri')}")
        _require_server_uri(kind, settings.uri)
        if kind == "falkordb":
            _falkor_address(settings.uri)
    require_schema_mode(settings.schema_mode or "warn")
    require_level("level", settings.level or "balanced")
    require_level("max_tier", settings.max_tier or "max")
    if settings.contradiction is not None:
        require_contradiction_mode(settings.contradiction)
    if settings.resolver is not None:
        require_resolver(settings.resolver)
    _llm_timeout(settings.llm_timeout)
    _llm_concurrency(settings.llm_concurrency)
    llm = _build_llm(settings)
    if llm is not None:
        check_llm_config(llm)
    schema = as_schema(_json_setting(settings.schema, "schema"))
    require_schema_for_mode(settings.schema_mode, schema)
    instructions = as_input(
        ExtractionInstructions, _json_setting(settings.instructions, "instructions"), "instructions"
    )
    prompts = as_input(ExtractionPrompts, _json_setting(settings.prompts, "prompts"), "prompts")
    check_prompts(prompts)
    return replace(settings, schema=schema, instructions=instructions, prompts=prompts)


def build_graph(settings: GraphSettings) -> SelfGraph:
    """Construct a SelfGraph from settings; does not call initialize.

    @param settings (GraphSettings): the resolved store, LLM, and schema configuration.
    @return (SelfGraph): the constructed graph.
    """
    settings = check_settings(settings)
    namespace = "default" if settings.namespace is None else settings.namespace
    return SelfGraph(
        store=_build_store(settings),
        llm=_build_llm(settings),
        instructions=settings.instructions,
        prompts=settings.prompts,
        namespace=namespace,
        schema=settings.schema,
        schema_mode=settings.schema_mode or "warn",
        resolver=settings.resolver,
        contradiction=settings.contradiction,
        level=settings.level or "balanced",
        max_tier=settings.max_tier or "max",
    )


async def current_relation(graph: SelfGraph, rid: str, hint: str) -> Relation | None:
    """Fetch the current version of a relation, failing with who retired it when a contradiction did.

    @param graph (SelfGraph): the graph.
    @param rid (str): the relation id.
    @param hint (str): how to read a retired relation on this surface, appended to the error.
    @return (Relation | None): the current version, or None when the id has no version.
    """
    rel = await graph.relations.get(rid)
    if rel is not None:
        return rel
    try:
        latest = (await graph.relations.versions(rid))[0]
    except NotFoundError:
        return None
    if latest.invalidated_at is None:
        return None
    raise NotFoundError("Relation", rid, f"{invalidated_note(latest)}; {hint}")


def to_jsonable(obj: Any) -> Any:
    """Turn an SDK return value (model, page, list, counts) into JSON-ready data.

    @param obj (Any): the SDK return value to convert.
    @return (Any): JSON-ready data.
    """
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    if obj is None or isinstance(obj, str | int | float | bool):
        return obj
    if isinstance(obj, BaseModel):
        return to_jsonable(obj.model_dump(mode="json", by_alias=True))
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [to_jsonable(v) for v in obj]
    return obj


def dumps(obj: Any) -> str:
    """JSON string for any SDK return value, stable and non-ASCII-safe.

    @param obj (Any): the SDK return value to serialise.
    @return (str): the JSON string.
    """
    return json.dumps(to_jsonable(obj), indent=2, ensure_ascii=False, default=str)
