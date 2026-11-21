from __future__ import annotations

import errno
import json
import re
import socket
import unicodedata
from typing import Any, Literal

__all__ = [
    "ErrorCode",
    "SelfGraphError",
    "ValidationError",
    "NotFoundError",
    "ConflictError",
    "ExtractionError",
    "PromptTemplateError",
    "StoreError",
    "TransientError",
    "InternalError",
]


ErrorCode = Literal[
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
    "missing_package",
    "not_found",
    "already_exists",
    "extraction_failed",
    "llm_auth_failed",
    "llm_model_not_found",
    "invalid_llm_output",
    "invalid_prompt_template",
    "query_failed",
    "graph_closed",
    "store_closed",
    "store_unreachable",
    "store_locked",
    "store_auth_failed",
    "database_not_found",
    "wrong_engine",
    "write_too_large",
    "write_conflict",
    "store_busy",
    "internal_error",
]
HINTS: dict[ErrorCode, str] = {
    "invalid_argument": (
        "An argument, input field, or option value is wrong. The message and `field` name it and what it "
        "expected. Fix the value and call again."
    ),
    "unknown_key": (
        "A key or option name is not one the call accepts. Use the name the message suggests after `did you "
        "mean`. Do not drop the value to make the call pass."
    ),
    "invalid_setting": (
        "A graph setting is missing or wrong: `uri`, `store`, `llm_provider`, `llm_model`, `llm_timeout`, "
        "`llm_concurrency`, or the provider in the LLM config. Fix the setting, flag, or `SELFGRAPH_*` "
        "variable the message names."
    ),
    "llm_required": (
        "The call needs an LLM and none is configured. Configure one: the `llm` option, or `--llm-provider` "
        "and `--llm-model` in the CLI and MCP server. Do not lower `level` or turn the feature off to avoid "
        "the LLM unless the user asks."
    ),
    "embedder_required": (
        "The `embeddings` seeds tier needs an embedder. Pass one with the SDK's `embedder` option. Do not "
        "switch to another seeds tier unless the user asks."
    ),
    "schema_required": (
        "Strict schema mode, or exporting the schema, needs a schema. Pass one: the `schema` option, or "
        "`--schema`. Do not switch to schema mode `warn` unless the user asks."
    ),
    "schema_violation": (
        "A write breaks the schema in strict mode. Fix the facts so they match the schema. Do not change the "
        "schema or the schema mode to let the write through; that is the user's decision."
    ),
    "immutable_identity": (
        "The change touches a field that is part of the object's id: an entity's type, a relation's endpoints "
        "and type, or a preference's subject, stance, key, and value. Create a new object instead of updating "
        "this one."
    ),
    "unknown_reference": (
        "The input references an entity or relation that does not exist. Fix the id, or create the object "
        "first when the facts say it exists."
    ),
    "relation_certified": (
        "A certified relation blocks the change. Certification is a person's sign-off, so ask the user before "
        "uncertifying it. Do not uncertify it yourself to make the call pass."
    ),
    "relation_invalidated": (
        "The relation was invalidated (superseded or retired). Act on its current version. Create it again "
        "only when the facts say it holds again."
    ),
    "merge_reverted": "The merge was already reverted. There is nothing left to undo.",
    "invalid_cursor": "The cursor did not come from this listing. Start the listing again without a cursor.",
    "invalid_resolver_decision": (
        "A custom entity resolver returned a bad decision. Return a `ResolutionDecision` whose target is one "
        "of the offered entities, with a confidence and a reason."
    ),
    "read_only_query": (
        "`run_cypher` runs a single read. Write through the typed tools instead. Do not reword the query to "
        "get a write past the guard."
    ),
    "cypher_query_limit": "Shorten the Cypher statement or reduce its delimiter nesting before trying again.",
    "missing_package": (
        "An optional package is not installed. Run the install command in the message, or ask the user to."
    ),
    "not_found": (
        "The object does not exist in the namespace the message names. Check the id and the namespace, and "
        "use the `did you mean` suggestion when there is one. Do not create a placeholder object just to make "
        "the call pass."
    ),
    "already_exists": "An object with this id already exists. Update it, or insert it, which upserts.",
    "extraction_failed": (
        "LLM extraction failed. The message carries the first failure. Check the LLM settings and the "
        "provider, then run the insert again."
    ),
    "llm_auth_failed": (
        "The LLM provider got no API key, or rejected it. Pass `api_key` in the LLM config, or set "
        "`SELFGRAPH_LLM_API_KEY` or the provider's own variable. Do not write the key into source code."
    ),
    "llm_model_not_found": "The provider does not know the model. Check the model name and the provider.",
    "invalid_llm_output": (
        "The model, or a custom LLM client, returned output that does not match the pass's schema. Use "
        "another model, or fix the client."
    ),
    "invalid_prompt_template": (
        "A prompt template is malformed. Keep `{text}` in the user template and use no placeholder other than "
        "`{text}` and `{instructions}`."
    ),
    "query_failed": (
        "The backend rejected a query. The message keeps the engine's reason. Check any Cypher you passed yourself."
    ),
    "graph_closed": "The SelfGraph was closed. Create a new SelfGraph.",
    "store_closed": (
        "The store was closed, and closing a graph closes its store. Create a new store for each SelfGraph."
    ),
    "store_unreachable": (
        "The SDK could not connect to the backend. Check that the server is running and that the address is "
        "right. Running the call again unchanged does not help until the server is up."
    ),
    "store_locked": (
        "Another process (an MCP server or a script) has the embedded Kuzu database open, and Kuzu allows one "
        "process at a time. Close it, or point this one at another path. Do not delete the database's files "
        "to free it."
    ),
    "store_auth_failed": (
        "The backend rejected the credentials, or HydraDB got no token. Pass the right `auth` (CLI and MCP: "
        "`--auth`, or `SELFGRAPH_AUTH`)."
    ),
    "database_not_found": (
        "The database named in the settings does not exist on the server. Fix the name, or ask the user to "
        "create the database."
    ),
    "wrong_engine": "The server at the address is another engine. Pass the store that matches it, such as `neo4j`.",
    "write_too_large": (
        "A single node or edge row is larger than HydraDB accepts in one message. Split large property values "
        "or text. Do not cut data without asking the user."
    ),
    "write_conflict": (
        "A concurrent write conflicted and the SDK's own retries ran out. Run the same call again: ids are "
        "deterministic and inserts are upserts, so a retry does not duplicate anything."
    ),
    "store_busy": "The server timed out or was too busy to take the query. Run the same call again after a moment.",
    "internal_error": (
        "An unexpected error reached the CLI or MCP boundary and was not mapped to a specific code. The message "
        "keeps the original error with any credentials masked. Report it with the message if it persists."
    ),
}
WARNING_HINTS: dict[str, str] = {
    "unknown_entity_type": (
        "An entity's type is not in the schema. Use a type the schema lists, or ask the user to add the type "
        "to the schema."
    ),
    "unknown_relation_type": (
        "A relation's type is not in the schema. Use a type the schema lists, or ask the user to add the type "
        "to the schema."
    ),
    "endpoint_type_violation": (
        "A relation endpoint is not one of the types the schema allows. Check the relation's direction and "
        "its endpoints."
    ),
    "missing_required_property": "A required property is absent or null. Add the property to the facts.",
    "property_type_mismatch": (
        "A property value does not match its declared type. Write the value as the declared type."
    ),
    "cardinality_violation": (
        "An entity has fewer relations of a type in this insert than the schema's `min_count`. Add the "
        "missing relations, or check the schema with the user."
    ),
    "contradiction": (
        "A relation breaks `max_count` against the graph, and both relations stay current. Decide which fact "
        "holds; when the newer one replaces the older, contradiction mode `supersede` retires the older."
    ),
    "contradiction_out_of_order": (
        "A relation just written ranks among the oldest at an endpoint, so it was stored as history, already "
        "invalidated. Check its `event_time` if it should be current."
    ),
    "relation_superseded": (
        "In `supersede` mode, a newer relation retired this one. The message names both ids. Nothing to fix "
        "unless the older fact still holds."
    ),
    "relation_reasserted": (
        "`relations.create` recreated a relation a contradiction retired, as its next revision. Nothing to "
        "fix if the fact holds again."
    ),
    "dropped_off_schema": (
        "In strict mode, `insert.text` dropped an extracted item that breaks the schema or references a "
        "dropped one. The item was not stored; insert it as facts that match the schema if it matters."
    ),
    "entity_merged": (
        "Entity resolution folded an entity into another. Use the survivor's id. Unmerge it if the two are "
        "different things."
    ),
    "merge_self_loop": (
        "A merge would have joined both ends of a relation, so the relation was dropped. Unmerging restores it."
    ),
    "certified_kept": (
        "A certified relation stayed current where a contradiction or a replaced source would have retired "
        "it. Ask the user whether the certification still holds."
    ),
    "certified_dropped": (
        "A write changed a certified relation, so its new revision is not certified. Ask the user to certify "
        "it again if it should be."
    ),
    "fact_retired_by_source": (
        "A replaced source no longer states a relation, so the relation was retired. Nothing to fix if the "
        "source changed on purpose."
    ),
    "extraction_partial_failure": (
        "Some extraction calls or items failed, and the rest was inserted. The message names the failure, the "
        "source, and the chunk. Insert that chunk again once the cause is fixed."
    ),
    "dropped_reserved_relation": (
        "A relation or decision step used a reserved type, so it was dropped. Use another relation type."
    ),
    "prompts_ignored": (
        "`instructions` and `prompts` were ignored, because extraction ran without an LLM. Configure an LLM "
        "for them to apply."
    ),
    "basic_extraction": (
        "Text was extracted with the built-in regex extractor, without an LLM. Configure an LLM when the graph matters."
    ),
    "ner_extraction": (
        "Text was extracted with spaCy NER, without an LLM (Python only). Configure an LLM when the graph matters."
    ),
}
DOCS_URL = "https://github.com/hydra-db/selfgraph/blob/v{version}/docs/errors.md"
AGENT_GUIDE = "site-packages/selfgraph/errors.md"


class SelfGraphError(Exception):
    code: ErrorCode = "invalid_argument"
    field: str | None = None

    def __init__(self, message: str = "", *, code: ErrorCode | None = None, field: str | None = None) -> None:
        """An SDK error with a stable code that names the failure and its repair.

        @param message (str): what happened, with the fix when one applies.
        @param code (ErrorCode | None): the code, or None for the class default.
        @param field (str | None): the argument, key, or setting at fault, when one is.
        """
        super().__init__(message)
        if code is not None:
            self.code = code
        if field is not None:
            self.field = field

    @property
    def hint(self) -> str:
        """How to repair this error's code, as its docs section says.

        @return (str): the repair.
        """
        return HINTS[self.code]

    @property
    def retryable(self) -> bool:
        """Whether the same call can succeed when run again unchanged.

        @return (bool): True for a TransientError.
        """
        return isinstance(self, TransientError)

    @property
    def docs(self) -> str:
        """The docs section for this error's code, at the installed release.

        @return (str): the URL.
        """
        from . import __version__

        return f"{DOCS_URL.format(version=__version__)}#{self.code}"

    @property
    def agent_guide(self) -> str:
        """The same docs section in the copy installed with the package, readable without a network.

        @return (str): the path, relative to the Python environment.
        """
        return f"{AGENT_GUIDE}#{self.code}"

    def to_dict(self) -> dict[str, Any]:
        """The error as JSON-ready fields, as the MCP server returns it.

        @return (dict[str, Any]): error, error_type, code, field when one is at fault, hint, retryable, docs, and
            agent_guide.
        """
        field = {} if self.field is None else {"field": self.field}
        return {
            "error": str(self),
            "error_type": type(self).__name__,
            "code": self.code,
            **field,
            "hint": self.hint,
            "retryable": self.retryable,
            "docs": self.docs,
            "agent_guide": self.agent_guide,
        }


class ValidationError(SelfGraphError):
    pass


class NotFoundError(SelfGraphError):
    code: ErrorCode = "not_found"

    def __init__(
        self,
        object_type: str,
        object_id: str,
        message: str | None = None,
        *,
        namespace: str | None = None,
        suggestion: str | None = None,
    ) -> None:
        """An error for an object that does not exist, naming its namespace and the closest existing id.

        @param object_type (str): the object type, such as "Entity".
        @param object_id (str): the id that was looked up.
        @param message (str | None): a message that replaces the default one.
        @param namespace (str | None): the namespace that was searched.
        @param suggestion (str | None): the closest existing id, when one is close.
        """
        self.object_type = object_type
        self.object_id = object_id
        where = "" if namespace is None else f" in namespace {namespace!r}"
        guess = "" if suggestion is None else f"; did you mean {suggestion!r}?"
        super().__init__(message or f"{object_type} {object_id!r} does not exist{where}{guess}")


class ConflictError(SelfGraphError):
    code: ErrorCode = "already_exists"

    def __init__(self, object_type: str, object_id: str) -> None:
        self.object_type = object_type
        self.object_id = object_id
        super().__init__(f"{object_type} {object_id!r} already exists")


class ExtractionError(SelfGraphError):
    code: ErrorCode = "extraction_failed"


class PromptTemplateError(SelfGraphError):
    code: ErrorCode = "invalid_prompt_template"


class StoreError(SelfGraphError):
    code: ErrorCode = "query_failed"


class TransientError(StoreError):
    code: ErrorCode = "write_conflict"


class InternalError(SelfGraphError):
    code: ErrorCode = "internal_error"


CLOSED_MESSAGE = "this SelfGraph is closed; create a new SelfGraph to keep using the store"
LLM_HINT = "pass llm= to SelfGraph (or set SELFGRAPH_LLM_PROVIDER and SELFGRAPH_LLM_MODEL)"
EMBEDDER_HINT = "pass embedder= to SelfGraph"
STORE_CLOSED_MESSAGE = "this store is closed; create a new store for each SelfGraph"
TOKEN_HINT = "pass auth=TOKEN to HydraDBStore (or set SELFGRAPH_AUTH)"
STORE_KUZU_HINT = 'pass store="kuzu" (or SELFGRAPH_STORE=kuzu)'
OTHER_ENGINE_HINT = 'pass store="neo4j" (or store="memgraph")'
DECAY_HINT = "run maintenance.decay(dry_run=False) first"
KEY_SOURCES = "api_key in the llm config (or SELFGRAPH_LLM_API_KEY)"


def needs_llm(what: str) -> ValidationError:
    """The error for a feature that needs an LLM when none is configured.

    @param what (str): the feature, such as "level 'max'".
    @return (ValidationError): the error, with code llm_required.
    """
    return ValidationError(f"{what} needs an LLM: {LLM_HINT}", code="llm_required")


def internal_error(exc: BaseException, *uris: str | None) -> InternalError:
    """Wrap an unexpected error that reached a boundary as a coded InternalError with every URI's credentials masked.

    @param exc (BaseException): the unmapped error.
    @param uris (str | None): the configured URIs to mask, such as the store URI and the LLM base_url.
    @return (InternalError): the coded error, safe to print.
    """
    return InternalError(redact_uris(f"{type(exc).__name__}: {exc}", *uris))


def setting_hint(key: str) -> str:
    """Name a connect or from_env setting with its environment variable, as library messages do.

    @param key (str): the setting name, such as "llm_model".
    @return (str): the hint, such as "llm_model= (or SELFGRAPH_LLM_MODEL)", which the CLI rewords to its flag.
    """
    return f"{key}= (or SELFGRAPH_{key.upper()})"


_SURFACE_HINTS = (
    (LLM_HINT, "pass --llm-provider and --llm-model (or SELFGRAPH_LLM_*)"),
    (EMBEDDER_HINT, "which only the SDK can take; use --seeds bm25 or synonyms here"),
    (TOKEN_HINT, "pass --auth TOKEN (or SELFGRAPH_AUTH)"),
    (STORE_KUZU_HINT, "pass --store kuzu (or SELFGRAPH_STORE=kuzu)"),
    (OTHER_ENGINE_HINT, "pass --store neo4j (or memgraph)"),
    (DECAY_HINT, "run maintenance decay --apply first"),
    (KEY_SOURCES, "--llm-api-key (or SELFGRAPH_LLM_API_KEY)"),
    *(
        (setting_hint(key), f"--{key.replace('_', '-')} (or SELFGRAPH_{key.upper()})")
        for key in ("uri", "llm_provider", "llm_model")
    ),
)

_CONNECT_CODES = {
    errno.ECONNREFUSED: "connection refused",
    errno.ECONNRESET: "connection reset",
    errno.EHOSTUNREACH: "host unreachable",
    errno.ETIMEDOUT: "connection timed out",
}
_LOOKUP_CODES = {socket.EAI_NONAME: "host not found", socket.EAI_AGAIN: "host lookup failed"}
_DANGLING = re.compile(r":[\s.]*$")
_DRIVER_BOILERPLATE = re.compile(
    r"(?:Connection Failed\. )?Please ensure that your database is listening on the correct host and port[^.]*\. "
    r"Note that the default encryption setting has changed in Neo4j 4\.0\.(?: See the docs for more information\.)?\s*"
)


def surface_hint(message: str) -> str:
    """Reword a library message for the CLI and MCP server, which take the LLM from flags or the environment.

    @param message (str): the library message.
    @return (str): the message with the library setting hints (llm=, auth=, store=, uri=, llm_model=, and the like)
        replaced by the flag hints.
    """
    for library, surface in _SURFACE_HINTS:
        message = message.replace(library, surface)
    return message


_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
_AT_SIGNS = ("@", "\uff20", "\ufe6b")


def split_scheme(uri: str) -> tuple[str, str]:
    """Split a URI into its scheme and the rest, taking a scheme only when the URI starts with one followed by ://.

    @param uri (str): the URI, such as bolt://host:7687 or host:7687.
    @return (tuple[str, str]): the scheme, empty when there is none, and the text after its ://, or the whole URI.
    """
    match = _SCHEME.match(uri)
    return (uri[: match.end() - 3], uri[match.end() :]) if match else ("", uri)


UNENCODED_USERINFO = (
    "the store URI has an unencoded character in its user or password; "
    "percent-encode it (/ as %2F, ? as %3F, # as %23, @ as %40, [ as %5B, ] as %5D)"
)


def _uri_authority(uri: str) -> tuple[str, str]:
    """Split off a URI's scheme and find its authority.

    @param uri (str): the URI, with or without a scheme.
    @return (tuple[str, str]): the text after the scheme's :// (the whole URI when it has no scheme), and the authority
        at its start, which runs to the first /, ? or #.
    """
    rest = split_scheme(uri)[1]
    return rest, re.split(r"[/?#]", rest, maxsplit=1)[0]


def _nfkc_separator(authority: str) -> bool:
    """Whether an authority holds non-ASCII text that NFKC turns into a /, ?, #, @, :, [ or ].

    urlsplit refuses a netloc whose text NFKC turns into a /, ?, #, @ or : with a ValueError that quotes it, and other
    parsers read such a character as part of the host, so a fullwidth ＠ sends the password to the DNS resolver.

    @param authority (str): the URI text between the scheme's :// and the first /, ? or #.
    @return (bool): true when one of its characters is non-ASCII and NFKC-normalizes to text holding a separator.
    """
    return any(not c.isascii() and re.search(r"[/?#@:\[\]]", unicodedata.normalize("NFKC", c)) for c in authority)


def require_encoded_userinfo(uri: str) -> None:
    """Reject a URI whose user or password holds an unencoded /, ?, #, @, [ or ], before any driver reads it.

    Drivers read such a URI as another host, port, path, or query and repeat pieces of the password in their errors,
    so the message names the problem without quoting the URI. Brackets around an IPv6 host stay valid.

    @param uri (str): the store URI, with or without a scheme.
    @return (None): nothing; raises ValidationError when the text between the scheme and the last @ (counting the
        fullwidth ＠ and small ﹫) holds a /, ?, #, [ or ], the authority holds more than one @, or the authority holds
        a character that NFKC turns into one of / ? # @ : [ ].
    """
    rest, authority = _uri_authority(uri)
    userinfo = rest[: max(max(rest.rfind(at) for at in _AT_SIGNS), 0)]
    if re.search(r"[/?#\[\]]", userinfo) or authority.count("@") > 1 or _nfkc_separator(authority):
        raise ValidationError(UNENCODED_USERINFO, code="invalid_setting", field="uri")


def _uri_userinfo(uri: str) -> tuple[int, str]:
    """Locate the user and password of a URI inside its authority.

    @param uri (str): the URI, with or without a scheme.
    @return (tuple[int, str]): the offset where the userinfo starts and the userinfo, which runs to the last @ before
        the first /, ? or # after any scheme, counting the fullwidth ＠ and small ﹫ that NFKC turns into @ (parsers
        that normalize read them as the separator); the userinfo is empty when the authority has none.
    """
    rest, authority = _uri_authority(uri)
    end = max(authority.rfind(at) for at in _AT_SIGNS)
    return len(uri) - len(rest), authority[: max(end, 0)]


def mask_uri(uri: str) -> str:
    """Hide the user and password of a URI so a message can show it.

    @param uri (str): the URI, such as redis://user:pass@host:6379.
    @return (str): the URI with its userinfo replaced by ***, such as redis://***@host:6379.
    """
    start, userinfo = _uri_userinfo(uri)
    return f"{uri[:start]}***{uri[start + len(userinfo) :]}" if userinfo else uri


def redact_uri(text: str, uri: str | None) -> str:
    """Replace the user and password of a URI with *** wherever a message shows them, raw or escaped.

    @param text (str): the message, which may quote the URI or repeat a driver's text about it.
    @param uri (str | None): the configured URI.
    @return (str): the message with each raw, repr, or JSON rendering of the whole URI replaced by the same rendering
        of the masked URI, then each such rendering of the userinfo before its separator replaced by ***.
    """
    if not uri:
        return text
    start, userinfo = _uri_userinfo(uri)
    if not userinfo:
        return text
    masked = mask_uri(uri)
    for render in (repr, lambda s: json.dumps(s, ensure_ascii=False), str):
        text = text.replace(render(uri), render(masked))
    at = uri[start + len(userinfo)]
    for form in (userinfo, repr(userinfo)[1:-1], json.dumps(userinfo, ensure_ascii=False)[1:-1]):
        text = text.replace(f"{form}{at}", f"***{at}")
    return text


def redact_uris(text: str, *uris: str | None) -> str:
    """Mask the userinfo of each configured URI wherever a message shows it.

    @param text (str): the message.
    @param uris (str | None): the configured URIs, such as the store URI and the LLM base_url; None entries are skipped.
    @return (str): the message with every URI's credentials replaced by ***.
    """
    for uri in uris:
        text = redact_uri(text, uri)
    return text


def _connect_failure(exc: BaseException | None, seen: set[int]) -> str:
    """The plain-words connection failure ("connection refused") of the first known errno in a cause chain.

    @param exc (BaseException | None): the error.
    @param seen (set[int]): ids of errors already visited.
    @return (str): the phrase, or "" when no known errno is present.
    """
    if exc is None or id(exc) in seen:
        return ""
    seen.add(id(exc))
    codes = _LOOKUP_CODES if isinstance(exc, socket.gaierror) else _CONNECT_CODES
    phrase = codes.get(getattr(exc, "errno", None))
    return phrase or _connect_failure(exc.__cause__ or exc.__context__, seen)


def connection_reason(exc: BaseException) -> str:
    """Describe a failed connection in plain words ("connection refused") when the cause chain says which.

    @param exc (BaseException): the raised error.
    @return (str): the phrase, or the error's reason.
    """
    return _connect_failure(exc, set()) or error_reason(exc)


def error_reason(exc: BaseException) -> str:
    """Describe an error, filling an empty or dangling reason from its cause chain or errno, minus trailing dots.

    @param exc (BaseException): the raised error.
    @return (str): the reason, or the error type name when nothing says more.
    """
    seen: set[int] = set()

    def reason(err: BaseException | None) -> str:
        if err is None or id(err) in seen:
            return ""
        seen.add(id(err))
        text = _DRIVER_BOILERPLATE.sub("", " ".join(str(err).split()))
        head = text.rstrip(" .:;,")
        if head and not _DANGLING.search(text):
            return head
        inner = _connect_failure(err, set()) or reason(err.__cause__ or err.__context__)
        return f"{head}: {inner}" if head and inner else head or inner

    return reason(exc) or type(exc).__name__
