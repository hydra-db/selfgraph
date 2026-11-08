from __future__ import annotations

import json
import math
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from ._ops import _require_text
from .client import SelfGraph
from .errors import StoreError, ValidationError
from .models import LLMConfig
from .protocols import GraphStore
from .schema import Schema

__all__ = [
    "GraphSettings",
    "build_graph",
    "settings_from_env",
    "to_jsonable",
    "dumps",
    "read_json",
    "read_text",
    "store_kind",
]

STORES = ("neo4j", "cypher", "memgraph", "hydradb", "falkordb", "kuzu")


@dataclass
class GraphSettings:
    store: str | None = None
    uri: str | None = None
    auth: str | None = None
    database: str | None = None
    namespace: str = "default"
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    llm_base_url: str | None = None
    schema: str | Schema | Mapping[str, Any] | None = None
    schema_mode: str | None = None


def settings_from_env(**overrides: Any) -> GraphSettings:
    """Read GraphSettings from SELFGRAPH_* env vars; overrides win when set.

    @param overrides (Any): field values that take precedence over the environment.
    @return (GraphSettings): the resolved settings.
    """

    def pick(key: str, env: str, default: Any = None) -> Any:
        value = overrides.get(key)
        if value is not None:
            return value
        return os.environ.get(env, default)

    return GraphSettings(
        store=pick("store", "SELFGRAPH_STORE"),
        uri=pick("uri", "SELFGRAPH_URI"),
        auth=pick("auth", "SELFGRAPH_AUTH"),
        database=pick("database", "SELFGRAPH_DATABASE"),
        namespace=pick("namespace", "SELFGRAPH_NAMESPACE", "default"),
        llm_provider=pick("llm_provider", "SELFGRAPH_LLM_PROVIDER"),
        llm_model=pick("llm_model", "SELFGRAPH_LLM_MODEL"),
        llm_api_key=pick("llm_api_key", "SELFGRAPH_LLM_API_KEY"),
        llm_base_url=pick("llm_base_url", "SELFGRAPH_LLM_BASE_URL"),
        schema=pick("schema", "SELFGRAPH_SCHEMA"),
        schema_mode=pick("schema_mode", "SELFGRAPH_SCHEMA_MODE"),
    )


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


def present(**fields: Any) -> dict[str, Any]:
    """Keep the fields that are not None, so only those reach an SDK update.

    @param fields (Any): the candidate fields.
    @return (dict[str, Any]): the fields that were given.
    """
    return {key: value for key, value in fields.items() if value is not None}


def _parse_auth(auth: str | None, default_user: str | None = "neo4j") -> tuple[str | None, str] | None:
    """Split 'user:password' auth; a bare token is the password for default_user.

    @param auth (str | None): the auth setting.
    @param default_user (str | None): the user for a bare token.
    @return (tuple[str | None, str] | None): the user and password, or None without auth.
    """
    if not auth:
        return None
    user, sep, secret = auth.partition(":")
    return (user, secret) if sep else (default_user, user)


def store_kind(settings: GraphSettings) -> str:
    """The store name the settings resolve to: the named store, else hydradb with a URI, else kuzu.

    @param settings (GraphSettings): the resolved store configuration.
    @return (str): the lowercase store name.
    """
    return (settings.store or ("hydradb" if settings.uri else "kuzu")).lower()


def _falkor_store(uri: str, settings: GraphSettings) -> GraphStore:
    """A FalkorDB store from host:port or a redis:// URL; auth, else the URL credentials, logs in.

    @param uri (str): the address.
    @param settings (GraphSettings): the resolved auth and database settings.
    @return (GraphStore): the store.
    """
    from urllib.parse import unquote, urlparse

    from .stores.falkordb import FalkorDBStore

    parsed = urlparse(uri if "://" in uri else f"//{uri}")
    if settings.auth:
        username, password = _parse_auth(settings.auth, None)
    else:
        username = unquote(parsed.username) if parsed.username else None
        password = unquote(parsed.password) if parsed.password else None
    credentials = {key: value for key, value in (("username", username), ("password", password)) if value}
    return FalkorDBStore(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        graph=settings.database or "selfgraph",
        **credentials,
    )


def _build_store(settings: GraphSettings) -> GraphStore:
    kind = store_kind(settings)
    if kind not in STORES:
        raise ValidationError(f"unknown store {settings.store!r}; choose one of {', '.join(STORES)}")
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
                "extra: pip install 'selfgraph[kuzu]', or set SELFGRAPH_STORE and SELFGRAPH_URI for a server"
            ) from exc
    if not settings.uri:
        hint = "host:port" if kind == "falkordb" else "a Bolt URI"
        raise ValidationError(f"the {kind!r} store needs {hint} (--uri / SELFGRAPH_URI)")
    auth = _parse_auth(settings.auth)
    if kind in ("neo4j", "cypher", "memgraph"):
        from .stores.cypher import CypherStore, Neo4jStore

        store_cls = Neo4jStore if kind == "neo4j" else CypherStore
        return store_cls(settings.uri, auth=auth, database=settings.database)
    if kind == "falkordb":
        return _falkor_store(settings.uri, settings)
    from .stores.hydradb import HydraDBStore

    return HydraDBStore(settings.uri, auth=auth, database=settings.database)


def _build_llm(settings: GraphSettings) -> LLMConfig | None:
    if not settings.llm_provider and not settings.llm_model:
        return None
    if not (settings.llm_provider and settings.llm_model):
        raise ValidationError("an LLM needs both a provider and a model")
    return LLMConfig(
        provider=settings.llm_provider,
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
    )


def build_graph(settings: GraphSettings) -> SelfGraph:
    """Construct a SelfGraph from settings; does not call initialize.

    @param settings (GraphSettings): the resolved store, LLM, and schema configuration.
    @return (SelfGraph): the constructed graph.
    """
    namespace = "default" if settings.namespace is None else settings.namespace
    _require_text("namespace", namespace)
    return SelfGraph(
        store=_build_store(settings),
        llm=_build_llm(settings),
        namespace=namespace,
        schema=read_json(settings.schema) if isinstance(settings.schema, str) else settings.schema,
        schema_mode=settings.schema_mode or "warn",
    )


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
