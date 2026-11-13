from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Collection, Iterable, Mapping
from datetime import datetime
from functools import partial
from typing import Any, NamedTuple, get_args

from . import ids as _ids
from ._serde import (
    EDGE_TYPES,
    L_ENTITY,
    L_EVIDENCE,
    L_MERGE,
    L_PROFILE,
    L_STEP,
    L_TRACE,
    LABELS,
    PREFERENCE_EDGE_TYPES,
    R_CONSIDERED,
    R_FROM,
    R_HAS_PROFILE,
    R_HAS_STEP,
    R_MADE_DECISION,
    R_RESULTED_IN,
    R_TO,
    _dumps,
    _loads,
    aware,
    child_edge_id,
    decode_entity,
    decode_evidence,
    decode_preference,
    decode_relation,
    decode_trace,
    encode_entity_props,
    encode_evidence_props,
    encode_preference_props,
    encode_relation_props,
    encode_trace_props,
    json_iso,
    now,
    preference_edge_type,
    preference_stance_of,
    to_iso,
)
from .errors import ConflictError, NotFoundError, TransientError, ValidationError
from .ids import _has_control, _has_surrogate
from .models import (
    DecisionStep,
    DecisionTrace,
    Entity,
    EntityInput,
    Evidence,
    EvidenceInput,
    Extraction,
    InsertWarning,
    Preference,
    PreferenceInput,
    Relation,
    RelationInput,
    Stance,
    Status,
    as_input,
    check_options,
)

_RESERVED_LABELS = frozenset(t.lower() for t in LABELS)
_NO_DELETES = {
    "deleted_entities": 0,
    "deleted_relation_versions": 0,
    "deleted_decisions": 0,
    "deleted_preference_versions": 0,
}
_ENTITY_UPDATE_FIELDS = ("type", "name", "aliases", "external_ids", "properties", "remove_aliases", "remove_properties")
_DECISION_UPDATE_FIELDS = (
    "title",
    "steps",
    "actor_entity",
    "summary",
    "rationale",
    "outcome_entity",
    "alternative_entities",
    "status",
    "event_time",
)
PREFERENCE_CLEARABLE = ("strength", "about_entity", "event_time")
DECISION_CLEARABLE = (
    "actor_entity",
    "summary",
    "rationale",
    "outcome_entity",
    "alternative_entities",
    "steps",
    "event_time",
)
_MAX_ID_BYTES = 1024
_PAGE = 500
_BATCH = 1000

SchemaCheck = Callable[..., Awaitable[None]]


def _require_id_size(kind: str, oid: str) -> None:
    """Reject an id whose UTF-8 encoding exceeds the storable id size.

    @param kind (str): the object kind, for the message.
    @param oid (str): the id.
    @return (None): nothing; raises ValidationError on an oversized id.
    """
    size = len(oid.encode("utf-8"))
    if size > _MAX_ID_BYTES:
        raise ValidationError(f"{kind} id is too long ({size} bytes); keep ids under {_MAX_ID_BYTES} bytes")


def _require_id_matches_type(eid: str, type: str) -> None:
    """Reject an entity id whose type prefix is not the id form of the entity's type.

    @param eid (str): the canonical entity id.
    @param type (str): the entity type, after schema alias canonicalization.
    @return (None): nothing; raises ValidationError when the prefix and the type differ.
    """
    expected = _ids.slug(_ids.normalize_text(type))
    if eid.split(":", 1)[0] != expected:
        raise ValidationError(f"id {eid!r} does not match type {type!r} (expected prefix '{expected}:')")


def _validate_entity_identity(eid: str, type: str, name: str) -> None:
    """Validate an entity's type, name, and resolved id before writing.

    @param eid (str): the resolved entity id.
    @param type (str): the entity type, used as a backend label.
    @param name (str): the entity name.
    @return (None): nothing; raises ValidationError on an empty, reserved, or oversized identity.
    """
    if not isinstance(eid, str):
        raise ValidationError(f"entity id must be a string, got {eid.__class__.__name__}")
    if not isinstance(type, str) or not isinstance(name, str) or not type.strip() or not name.strip():
        raise ValidationError(
            "entity type and name cannot be empty; an entity needs both, e.g. type='Person', name='Jane Doe'"
        )
    if type.strip().lower() in _RESERVED_LABELS:
        raise ValidationError(f"entity type {type!r} is reserved for internal use; choose another type")
    if "`" in type:
        raise ValidationError("entity type cannot contain a backtick")
    if ":" in type:
        raise ValidationError(f"entity type {type!r} cannot contain ':', which separates an entity id's type and name")
    if _has_control(name) or _has_control(type):
        raise ValidationError("entity type and name cannot contain control or surrogate characters")
    if not all(ch.isalnum() or ch in " _-." for ch in type):
        raise ValidationError(f"entity type {type!r} can only contain letters, digits, spaces, '_', '-', and '.'")
    if _has_control(eid):
        raise ValidationError("entity id cannot contain control or surrogate characters")
    _ids._require_entity_shape(eid)
    prefix_part = eid.split(":", 1)[0]
    if prefix_part.lower() in _ids.RESERVED_ID_PREFIXES:
        raise ValidationError(f"entity id prefix {prefix_part!r} is reserved for internal use")
    _require_id_size("entity", eid)


def _reject_reserved_rel_type(rtype: str, given: str) -> None:
    """Reject a relation type that names one of SelfGraph's internal edge types.

    @param rtype (str): the normalized relation type.
    @param given (str): the type as the caller wrote it, for the message.
    @return (None): nothing; raises ValidationError on a reserved type.
    """
    if rtype in EDGE_TYPES:
        raise ValidationError(f"relation type {given!r} is reserved for internal use; choose another type")


def _validate_strength(strength: float | None) -> None:
    """Validate a preference strength is a real number in the unit interval.

    @param strength (float | None): the strength to check, or None.
    @return (None): nothing; raises ValidationError when non-numeric or out of range.
    """
    if strength is not None:
        _ids._require_unit("preference strength", strength)


_require_text = _ids._require_str


def _require_int(field: str, value: Any) -> None:
    """Validate a value is an integer, excluding bool.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a non-bool integer.
    """
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValidationError(f"{field} must be an integer, got {type(value).__name__}")


def _require_optional_text(field: str, value: Any) -> None:
    """Validate a value is a string or None.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a string or None.
    """
    if value is not None and not isinstance(value, str):
        raise ValidationError(f"{field} must be a string or None, got {type(value).__name__}")
    if value is not None and _has_control(value):
        raise ValidationError(f"{field} cannot contain control or surrogate characters")


def _require_datetime(field: str, value: Any) -> None:
    """Validate a value is a datetime or None.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a datetime.
    """
    if value is None:
        return
    if not isinstance(value, datetime):
        raise ValidationError(f"{field} must be a datetime, got {type(value).__name__}")
    try:
        to_iso(value)
    except (OverflowError, ValueError, OSError) as exc:
        raise ValidationError(f"{field} is outside the representable datetime range") from exc


def parse_time(value: Any, field: str) -> datetime | None:
    """Accept a datetime or ISO 8601 text; a trailing Z or an offset is honored, none means UTC.

    @param value (Any): a datetime, ISO 8601 text, or None.
    @param field (str): the parameter name, for the error.
    @return (datetime | None): the datetime, the parsed timezone-aware time, or None.
    """
    if not isinstance(value, str):
        _require_datetime(field, value)
        return value
    text = f"{value[:-1]}+00:00" if value[-1:] in ("Z", "z") else value
    try:
        parsed = aware(datetime.fromisoformat(text))
    except (TypeError, ValueError) as exc:
        raise ValidationError(
            f"invalid {field}: {value!r} is not an ISO 8601 date or time (e.g. 2024-01-02T03:04:05Z)"
        ) from exc
    _require_datetime(field, parsed)
    return parsed


def _validate_own_id(kind: str, oid: str | None) -> None:
    """Validate a caller-chosen relation, preference, or decision id, which must carry its own kind as prefix.

    @param kind (str): the object kind and required id prefix.
    @param oid (str | None): the id, or None to skip the check.
    @return (None): nothing; raises ValidationError on a bad id.
    """
    if oid is None:
        return
    if not isinstance(oid, str):
        raise ValidationError(f"{kind} id must be a string, got {type(oid).__name__}")
    if not oid:
        raise ValidationError(f"{kind} id cannot be empty")
    if _has_control(oid):
        raise ValidationError(f"{kind} id cannot contain control or surrogate characters")
    _require_id_size(kind, oid)
    prefix = oid.split(":", 1)[0].lower() if ":" in oid else ""
    if prefix != kind:
        raise ValidationError(f"{kind} id must start with '{kind}:', got {oid!r}")
    if not oid.split(":", 1)[1].strip():
        raise ValidationError(f"{kind} id must have a non-empty name after '{kind}:', got {oid!r}")


_STANCES = frozenset(get_args(Stance))
_STATUSES = frozenset(get_args(Status))


def require_changes(changes: dict[str, Any]) -> dict[str, Any]:
    """Reject an update that names no field to change.

    @param changes (dict[str, Any]): the fields the update sets or clears.
    @return (dict[str, Any]): the same fields.
    """
    if not changes:
        raise ValidationError("nothing to update; pass at least one field to change")
    return changes


def _require_clear(method: str, clear: Any, allowed: tuple[str, ...], given: Mapping[str, Any]) -> set[str]:
    """Validate the fields an update clears: each must be clearable and not also given a value.

    @param method (str): the update method, for the error.
    @param clear (Any): the field names to clear.
    @param allowed (tuple[str, ...]): the fields this update can clear.
    @param given (Mapping[str, Any]): the values the update sets, by field.
    @return (set[str]): the fields to clear.
    """
    _require_list("clear", clear)
    for key in clear:
        if key not in allowed:
            raise ValidationError(f"{method} cannot clear {key!r}; clearable fields: {', '.join(allowed)}")
        if given.get(key) is not None:
            raise ValidationError(f"{method} cannot both set and clear {key!r}")
    return set(clear)


def _require_choice(field: str, value: Any, choices: frozenset[str]) -> None:
    """Validate a value is one of the allowed strings.

    @param field (str): the field name for the error message.
    @param value (Any): the value to check.
    @param choices (frozenset[str]): the allowed values.
    @return (None): nothing; raises ValidationError on any other value.
    """
    if not isinstance(value, str) or value not in choices:
        raise ValidationError(f"{field} must be one of {sorted(choices)}, got {value!r}")


def _require_list(name: str, value: Any) -> None:
    """Validate a value is a list of strings, not a bare string or a list with non-strings.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a list of strings.
    """
    if isinstance(value, str) or not isinstance(value, list | tuple):
        raise ValidationError(f"{name} must be a list of strings, got {type(value).__name__}")
    for item in value:
        if not isinstance(item, str):
            raise ValidationError(f"{name} must be a list of strings, got a {type(item).__name__} element")
        if _has_control(item):
            raise ValidationError(f"{name} elements cannot contain control or surrogate characters")


def _require_mapping(name: str, value: Any, *, safe_ints: bool = True) -> None:
    """Validate a value is a mapping.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check.
    @param safe_ints (bool): reject integers outside +/-(2**53 - 1).
    @return (None): nothing; raises ValidationError when not a mapping.
    """
    if not isinstance(value, Mapping):
        raise ValidationError(f"{name} must be a mapping, got {type(value).__name__}")
    for key in value:
        if not isinstance(key, str):
            raise ValidationError(f"{name} keys must be strings, got a {type(key).__name__} key")
    _ids._require_clean_json(name, value, safe_ints=safe_ints)


def _require_json_mapping(name: str, value: Any, *, safe_ints: bool = True) -> None:
    """Validate an optional mapping has string keys and JSON-serializable values, up front.

    Callers that supersede a version before encoding must reject a non-serializable value here,
    before the supersede write, or a mid-write encode failure leaves no current version.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check, or None.
    @param safe_ints (bool): reject integers outside +/-(2**53 - 1); stored values must round-trip in TypeScript.
    @return (None): nothing; raises ValidationError when not a JSON string-keyed mapping or a key is blank.
    """
    if value is None:
        return
    _require_mapping(name, value, safe_ints=safe_ints)
    if any(not key.strip() for key in value):
        raise ValidationError(f"{name} keys cannot be empty or whitespace")
    _dumps(dict(value))


def _canon_props(props: Mapping[str, Any] | None) -> dict[str, Any]:
    """Canonicalize a caller property mapping to the JSON-native form that storage round-trips to.

    A tuple the caller passes is stored and read back as a list, so comparing the raw caller value
    against the decoded current value spuriously reports a change; round-tripping both sides through
    the JSON codec makes the idempotency check see equal values.

    @param props (Mapping[str, Any] | None): caller-supplied properties, possibly holding tuples.
    @return (dict[str, Any]): the mapping with values coerced to their stored JSON-native form.
    """
    if not props:
        return {}
    return _loads(_dumps(dict(props)), {})


def _merge_props(
    base: Mapping[str, Any] | None, changes: Mapping[str, Any] | None, removed: Iterable[str] = ()
) -> dict[str, Any]:
    """Apply property changes over stored properties, where a None value removes its key.

    @param base (Mapping[str, Any] | None): the stored properties, or None for a new object.
    @param changes (Mapping[str, Any] | None): the caller's properties; None values clear keys.
    @param removed (Iterable[str]): further keys to drop.
    @return (dict[str, Any]): the merged properties, with no None-valued key from the changes.
    """
    merged = {**(base or {}), **_canon_props(changes)}
    for key in [*(k for k, v in (changes or {}).items() if v is None), *removed]:
        merged.pop(key, None)
    return merged


def _require_str_mapping(name: str, value: Any) -> None:
    """Validate a value is a mapping of strings to strings.

    @param name (str): the field name for the error message.
    @param value (Any): the value to check.
    @return (None): nothing; raises ValidationError when not a string-to-string mapping.
    """
    _require_mapping(name, value)
    for item in value.values():
        if not isinstance(item, str):
            raise ValidationError(f"{name} must map strings to strings")


def _require_clean_evidence(ev: EvidenceInput) -> None:
    """Validate one evidence input at the ops tier, since the pydantic model tier is bypassable by mutation.

    @param ev (EvidenceInput): the evidence to validate.
    @return (None): nothing; raises ValidationError on a bad source id, quote, confidence, or offsets.
    """
    if not isinstance(ev, EvidenceInput):
        raise ValidationError(f"evidence must be EvidenceInput objects, got a {type(ev).__name__}")
    _require_text("evidence source_id", ev.source_id)
    _require_optional_text("evidence chunk_id", ev.chunk_id)
    if ev.quote is not None:
        if not isinstance(ev.quote, str):
            raise ValidationError(f"evidence quote must be a string, got {type(ev.quote).__name__}")
        if _has_surrogate(ev.quote):
            raise ValidationError("evidence quote cannot contain unpaired surrogate characters")
    if ev.confidence is not None:
        _ids._require_unit("evidence confidence", ev.confidence, finite=True)
    for name, offset in (("evidence start_offset", ev.start_offset), ("evidence end_offset", ev.end_offset)):
        if offset is None:
            continue
        _require_int(name, offset)
        if offset < 0:
            raise ValidationError(f"{name} cannot be negative, got {offset}")
    if ev.start_offset is not None and ev.end_offset is not None and ev.start_offset > ev.end_offset:
        raise ValidationError(f"evidence start_offset {ev.start_offset} is greater than end_offset {ev.end_offset}")


def evidence_from_inputs(
    inputs: list[EvidenceInput] | tuple[EvidenceInput, ...],
    *,
    source_id: str | None = None,
    source_version: str | None = None,
) -> list[Evidence]:
    """Turn caller-supplied EvidenceInput, or plain mappings of its fields, into stored Evidence.

    @param inputs (list[EvidenceInput] | tuple[EvidenceInput, ...]): evidence to convert.
    @param source_id (str | None): the source being inserted; only evidence citing it takes source_version.
    @param source_version (str | None): the inserted source's version; other evidence gets "<source_id>:manual".
    @return (list[Evidence]): the stored evidence.
    """
    if isinstance(inputs, str | bytes) or not isinstance(inputs, Iterable):
        raise ValidationError(f"evidence must be a list of Evidence objects, got {type(inputs).__name__}")
    out: list[Evidence] = []
    for ev in inputs:
        if isinstance(ev, Mapping):
            ev = as_input(EvidenceInput, ev, "evidence")
        if not isinstance(ev, EvidenceInput):
            raise ValidationError(
                f"evidence must be EvidenceInput objects (selfgraph.EvidenceInput(...)), got a {type(ev).__name__}"
            )
        _require_clean_evidence(ev)
        sv = source_version if source_version and ev.source_id == source_id else f"{ev.source_id}:manual"
        out.append(
            Evidence(
                source_id=ev.source_id,
                source_version=sv,
                chunk_id=ev.chunk_id,
                quote=ev.quote,
                start_offset=ev.start_offset,
                end_offset=ev.end_offset,
                confidence=ev.confidence,
            )
        )
    return out


def relation_evidence(
    inputs: list[EvidenceInput], base: list[Evidence], *, source_id: str | None, source_version: str | None
) -> list[Evidence]:
    """The evidence an inserted relation records: its own, plus the source-level one unless it cites that version.

    @param inputs (list[EvidenceInput]): the relation's explicit evidence.
    @param base (list[Evidence]): the insert's source-level evidence, empty without a source.
    @param source_id (str | None): the inserted source, if any.
    @param source_version (str | None): the inserted source's version, if any.
    @return (list[Evidence]): the evidence to record for the relation.
    """
    own = evidence_from_inputs(inputs, source_id=source_id, source_version=source_version)
    cited = source_version is not None and any(ev.source_version == source_version for ev in own)
    return own if cited else [*base, *own]


def _clean_text(value: Any) -> Any:
    return _ids.normalize_text(value).strip() if isinstance(value, str) else value


def unique_by_id(items: Iterable[Any]) -> list[Any]:
    """Keep one item per id: the last write wins, at the position the id first appeared.

    @param items (Iterable[Any]): models with an id.
    @return (list[Any]): the deduplicated items.
    """
    return list({item.id: item for item in items}.values())


def _dedup_list(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _alias_list(name: str, items: Iterable[str]) -> list[str]:
    """Dedup an entity's aliases after cleaning each like a name, dropping blank ones and any equal to the name.

    @param name (str): the entity name.
    @param items (Iterable[str]): the aliases.
    @return (list[str]): the trimmed, NFC-normalized aliases, order preserved, without duplicates, blanks, or the name
        itself ignoring case.
    """
    own = _clean_text(name).casefold()
    aliases = _dedup_list(_clean_text(a) for a in items)
    return [a for a in aliases if not isinstance(a, str) or (a and a.casefold() != own)]


async def _paged(fetch: Callable[..., Any], cap: int | None = None, page: int = _PAGE) -> list:
    """Call a skip/limit list function page by page until it runs dry or reaches the cap.

    @param fetch (Callable[..., Awaitable[list]]): the list call, given skip and limit as keywords.
    @param cap (int | None): the most rows to read, or None for all.
    @param page (int): the rows to read per call.
    @return (list): every row read, in store order.
    """
    out: list = []
    while cap is None or len(out) < cap:
        batch = await fetch(skip=len(out), limit=page)
        out.extend(batch)
        if len(batch) < page:
            break
    return out


async def _keyset(fetch: Callable[[str | None, int], Awaitable[list]], page: int = _PAGE) -> AsyncIterator[list]:
    """Yield the pages of an id-ordered read, each resuming after the last id read, until it runs dry.

    @param fetch (Callable[[str | None, int], Awaitable[list]]): the read, given the id to resume after (None to
        start) and the page size; it returns node property maps or models with an id, in id order.
    @param page (int): the rows to read per call.
    @return (AsyncIterator[list]): each non-empty page, in id order.
    """
    after: str | None = None
    while True:
        rows = await fetch(after, page)
        if rows:
            yield rows
        if len(rows) < page:
            return
        last = rows[-1]
        after = last["id"] if isinstance(last, dict) else last.id


def _batches(items: list) -> list[list]:
    """Split a list into consecutive batches of at most _BATCH items.

    @param items (list): the items to split.
    @return (list[list]): the batches, in order.
    """
    return [items[i : i + _BATCH] for i in range(0, len(items), _BATCH)]


async def _nodes_where(
    runner: Any, ns: str, label: str, key: str, values: list, *, equals: dict | None = None
) -> list[dict]:
    """Read every node of one label whose property is one of some values, a batch of values per paged query.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param label (str): node label.
    @param key (str): the property.
    @param values (list): the accepted values.
    @param equals (dict | None): exact property matches every node must also have.
    @return (list[dict]): the node property maps.
    """
    rows: list[dict] = []
    for batch in _batches(values):
        rows += await _paged(partial(runner.match_nodes, ns, label, equals=equals, any_of={key: batch}), page=_BATCH)
    return rows


async def _nodes_by_id(runner: Any, ns: str, label: str, ids: list[str]) -> dict[str, dict]:
    """Fetch the stored properties of many nodes of one label by id, a batch per query.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param label (str): node label.
    @param ids (list[str]): the node ids.
    @return (dict[str, dict]): each found node's properties by id.
    """
    found: dict[str, dict] = {}
    for batch in _batches(ids):
        for props in await runner.match_nodes(ns, label, any_of={"id": batch}, limit=len(batch)):
            found[props["id"]] = props
    return found


async def _plan_evidence(
    runner: Any, ns: str, items: list[tuple[str, Evidence]], *, new_targets: set[str]
) -> tuple[list[tuple[str, dict]], dict[str, int]]:
    """Find which evidence records are not stored yet and how many distinct sources each target gains.

    Records are looked up by id first; only a target missing a record is then checked for any record from that
    source. A target with no stored version has no stored evidence, so targets in new_targets skip both lookups.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param items (list[tuple[str, Evidence]]): (target id, evidence) pairs to record.
    @param new_targets (set[str]): targets known to have no stored evidence.
    @return (tuple[list[tuple[str, dict]], dict[str, int]]): the records to write, and the sources gained per target.
    """
    pending: dict[str, tuple[str, Evidence]] = {}
    for target, ev in items:
        evid = _ids.evidence_id(
            target, ev.source_id, ev.source_version, ev.chunk_id, ev.quote, ev.start_offset, ev.end_offset
        )
        pending.setdefault(evid, (target, ev))
    known = [evid for evid, (target, _) in pending.items() if target not in new_targets]
    stored_ids = set(await _nodes_by_id(runner, ns, L_EVIDENCE, known))
    by_source: dict[str, dict[str, None]] = {}
    for evid in known:
        if evid not in stored_ids:
            target, ev = pending[evid]
            by_source.setdefault(ev.source_id, {})[target] = None
    seen: set[tuple[str, str]] = set()
    for source_id, targets in by_source.items():
        rows = await _nodes_where(runner, ns, L_EVIDENCE, "target_id", list(targets), equals={"source_id": source_id})
        seen |= {(props["target_id"], source_id) for props in rows}
    records: list[tuple[str, dict]] = []
    gained: dict[str, int] = {}
    for evid, (target, ev) in pending.items():
        if evid in stored_ids:
            continue
        records.append((evid, encode_evidence_props(ns=ns, id=evid, target_id=target, evidence=ev)))
        if (target, ev.source_id) not in seen:
            seen.add((target, ev.source_id))
            gained[target] = gained.get(target, 0) + 1
    return records, gained


async def _write_evidence(runner: Any, ns: str, records: list[tuple[str, dict]]) -> None:
    if records:
        await runner.upsert_nodes(ns, L_EVIDENCE, records)


async def list_evidence(runner: Any, ns: str, target_id: str, *, kind: str, skip: int, limit: int) -> list[Evidence]:
    """List the evidence records supporting one entity or relation, ordered by evidence id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param target_id (str): the entity or relation id.
    @param kind (str): "entity" or "relation", for validation and the not-found error.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @return (list[Evidence]): the evidence; raises NotFoundError when the first page is empty and the target is unknown.
    """
    if kind == "entity":
        target_id = _ids.canonical_entity_id(target_id)
    else:
        _ids._require_str(f"{kind} id", target_id)
    rows = await runner.match_nodes(
        ns, L_EVIDENCE, equals={"target_id": target_id}, order_by="id", skip=skip, limit=limit
    )
    if not rows and skip == 0:
        if kind == "entity":
            exists = await runner.node_exists(ns, L_ENTITY, target_id)
        else:
            exists = await relation_exists(runner, ns, target_id)
        if not exists:
            raise NotFoundError("Entity" if kind == "entity" else "Relation", target_id)
    return [decode_evidence(r) for r in rows]


async def _delete_evidence(runner: Any, ns: str, target_id: str) -> None:
    await runner.delete_nodes_by(ns, L_EVIDENCE, equals={"target_id": target_id})


async def _entity_known(runner: Any, ns: str, eid: str, known: set[str] | frozenset[str]) -> bool:
    if not isinstance(eid, str):
        raise ValidationError(f"entity reference must be a string id, got {type(eid).__name__}")
    if _has_control(eid):
        raise ValidationError("entity reference cannot contain control or surrogate characters")
    return eid in known or await runner.node_exists(ns, L_ENTITY, eid)


async def _require_endpoints(
    runner: Any, ns: str, from_id: str, to_id: str, hint: str, known: set[str] | frozenset[str] = frozenset()
) -> None:
    """Raise a ValidationError naming each relation endpoint that is neither in known nor in the graph.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_id (str): the source entity id.
    @param to_id (str): the destination entity id.
    @param hint (str): the advice appended to the error.
    @param known (set[str] | frozenset[str]): entity ids that count as present.
    @return (None): nothing; raises ValidationError when an endpoint is missing.
    """
    missing = [
        f"{end}={eid!r}"
        for end, eid in (("from", from_id), ("to", to_id))
        if not await _entity_known(runner, ns, eid, known)
    ]
    if missing:
        raise ValidationError(
            f"relation endpoint{'s' if len(missing) > 1 else ''} not found ({', '.join(missing)}); {hint}"
        )


async def _require_entity(
    runner: Any, ns: str, eid: str | None, context: str, known: set[str] | frozenset[str] = frozenset()
) -> None:
    if eid is not None and not await _entity_known(runner, ns, eid, known):
        raise ValidationError(f"{context} references unknown entity {eid!r}")


async def _require_preference_refs(
    runner: Any, ns: str, value_entity: str, about_entity: str | None, known: set[str] | frozenset[str] = frozenset()
) -> None:
    await _require_entity(runner, ns, value_entity, "preference", known)
    await _require_entity(runner, ns, about_entity, "preference about_entity", known)


async def _require_trace_refs(
    runner: Any,
    ns: str,
    actor_entity: str | None,
    outcome_entity: str | None,
    alternative_entities: Iterable[str],
    known: set[str] | frozenset[str] = frozenset(),
) -> None:
    await _require_entity(runner, ns, actor_entity, "decision actor_entity", known)
    await _require_entity(runner, ns, outcome_entity, "decision outcome_entity", known)
    for alt in alternative_entities:
        await _require_entity(runner, ns, alt, "decision alternative_entity", known)


def _canonical_refs(facts: Extraction) -> Extraction:
    """Canonicalise every explicit entity id and entity reference in facts with canonical_entity_id.

    @param facts (Extraction): the facts, with list collections.
    @return (Extraction): a copy whose entity ids and references are canonical.
    """
    c = _ids._canonical_id

    def alternatives(dec: Any) -> Any:
        items = dec.alternative_entities
        return [c(a) for a in items] if isinstance(items, list | tuple) else items

    return facts.model_copy(
        update={
            "entities": [e.model_copy(update={"id": c(e.id)}) for e in facts.entities],
            "relations": [
                r.model_copy(update={"from_entity": c(r.from_entity), "to_entity": c(r.to_entity)})
                for r in facts.relations
            ],
            "preferences": [
                p.model_copy(
                    update={
                        "subject_entity": c(p.subject_entity),
                        "value_entity": c(p.value_entity),
                        "about_entity": c(p.about_entity),
                    }
                )
                for p in facts.preferences
            ],
            "decisions": [
                d.model_copy(
                    update={
                        "actor_entity": c(d.actor_entity),
                        "outcome_entity": c(d.outcome_entity),
                        "alternative_entities": alternatives(d),
                    }
                )
                for d in facts.decisions
            ],
        }
    )


async def validate_facts(
    runner: Any, ns: str, facts: Extraction, rewrite: Callable[[Extraction], Extraction] | None = None
) -> Extraction:
    """Check every reference in facts before any write so a bad reference fails atomically.

    Explicit entity ids and entity references are canonicalized first (see canonical_entity_id), and entity
    identities checked, before the rewrite.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param facts (Extraction): the facts whose references are checked.
    @param rewrite (Callable[[Extraction], Extraction] | None): applied after id canonicalization and before the
        reference checks, such as the schema's type alias canonicalization, so references in either form resolve.
    @return (Extraction): the facts with canonical entity ids; raises ValidationError on the first unresolved
        reference.
    """
    for name, collection in (
        ("entities", facts.entities),
        ("relations", facts.relations),
        ("preferences", facts.preferences),
        ("decisions", facts.decisions),
    ):
        if not isinstance(collection, list | tuple):
            raise ValidationError(f"facts {name} must be a list, got {type(collection).__name__}")
    facts = _canonical_refs(facts)
    entity_ids = [ent.id or _ids.entity_id(ent.type, ent.name) for ent in facts.entities]
    for eid, ent in zip(entity_ids, facts.entities, strict=True):
        _validate_entity_identity(eid, ent.type, ent.name)
    if rewrite is not None:
        facts = rewrite(facts)
        entity_ids = [ent.id or _ids.entity_id(ent.type, ent.name) for ent in facts.entities]
    for eid, ent in zip(entity_ids, facts.entities, strict=True):
        _require_id_matches_type(eid, ent.type)
    entities = set(entity_ids)
    relations = {rel.id or _ids.relation_id(rel.from_entity, rel.type, rel.to_entity) for rel in facts.relations}

    for item in (*facts.entities, *facts.relations, *facts.preferences):
        if item.properties is None:
            raise ValidationError("properties must be a mapping, got NoneType")
        _require_json_mapping("properties", item.properties)
    for ent in facts.entities:
        _require_str_mapping("external_ids", ent.external_ids)
        _require_list("entity aliases", ent.aliases)

    for rel in facts.relations:
        _validate_own_id("relation", rel.id)
        _require_datetime("relation event_time", rel.event_time)
        _reject_reserved_rel_type(_ids.normalize_rel_type(rel.type), rel.type)
        if not isinstance(rel.evidence, list | tuple):
            raise ValidationError(f"relation evidence must be a list, got {type(rel.evidence).__name__}")
        for ev in rel.evidence:
            _require_clean_evidence(ev)
        await _require_endpoints(
            runner,
            ns,
            rel.from_entity,
            rel.to_entity,
            "endpoints must be entity ids ('type:name') listed in these facts' entities or already in the graph. "
            "Ids are canonicalized; compute one with selfgraph.entity_id(type, name)",
            entities,
        )

    for pref in facts.preferences:
        _validate_own_id("preference", pref.id)
        _require_datetime("preference event_time", pref.event_time)
        _require_choice("preference stance", pref.stance, _STANCES)
        _require_text("preference key", pref.key)
        _validate_strength(pref.strength)
        if not await _entity_known(runner, ns, pref.subject_entity, entities):
            raise ValidationError(f"preference references unknown subject entity {pref.subject_entity!r}")
        await _require_preference_refs(runner, ns, pref.value_entity, pref.about_entity, entities)

    for dec in facts.decisions:
        _validate_own_id("decision", dec.id)
        _require_datetime("decision event_time", dec.event_time)
        _require_choice("decision status", dec.status, _STATUSES)
        _require_text("decision title", dec.title)
        _require_optional_text("decision summary", dec.summary)
        _require_optional_text("decision rationale", dec.rationale)
        _require_list("decision steps", dec.steps)
        _require_list("decision alternative_entities", dec.alternative_entities)
        for rel_id in dec.steps:
            if rel_id not in relations and not await relation_exists(runner, ns, rel_id):
                raise ValidationError(f"decision step references unknown relation {rel_id!r}")
        await _require_trace_refs(runner, ns, dec.actor_entity, dec.outcome_entity, dec.alternative_entities, entities)
    return facts


async def get_entity(runner: Any, ns: str, eid: str) -> Entity | None:
    """Fetch one entity by id, or None.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (Entity | None): the entity, or None.
    """
    eid = _ids.canonical_entity_id(eid)
    props = await runner.get_node(ns, L_ENTITY, eid)
    return decode_entity(props) if props else None


async def upsert_entities(
    runner: Any,
    ns: str,
    ents: list[EntityInput],
    *,
    evidence: list[Evidence],
    created_at: datetime,
) -> list[Entity]:
    """Insert-semantics upsert of many entities: keep stored names, record new surface forms as aliases, merge the rest.

    Entities are read and written in batches; a repeated id merges into the earlier input, as sequential upserts would.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param ents (list[EntityInput]): entities to upsert, in order.
    @param evidence (list[Evidence]): evidence recorded for every entity.
    @param created_at (datetime): timestamp for created and updated fields.
    @return (list[Entity]): each input's stored entity, in input order.
    """
    keyed = []
    for ent in ents:
        etype = _clean_text(ent.type)
        ename = _clean_text(ent.name)
        eid = ent.id or _ids.entity_id(etype, ename)
        _validate_entity_identity(eid, etype, ename)
        keyed.append((eid, etype, ename, ent))
    eids = _dedup_list(eid for eid, *_ in keyed)
    for eid in eids:
        await runner.lock_node(ns, L_ENTITY, eid)
    stored = {eid: decode_entity(p) for eid, p in (await _nodes_by_id(runner, ns, L_ENTITY, eids)).items()}
    records, gained = await _plan_evidence(
        runner, ns, [(eid, ev) for eid in eids for ev in evidence], new_targets=set(eids) - set(stored)
    )

    current: dict[str, Entity] = dict(stored)
    writes: dict[str, dict] = {}
    out: list[Entity] = []
    for eid, etype, ename, ent in keyed:
        prev = current.get(eid)
        sources = (prev.source_count if prev is not None else 0) + gained.pop(eid, 0)
        if prev is None:
            props = encode_entity_props(
                ns=ns,
                id=eid,
                type=etype,
                name=ename,
                aliases=_alias_list(ename, ent.aliases),
                external_ids=dict(ent.external_ids),
                properties=_merge_props(None, ent.properties),
                source_count=sources,
                created_at=created_at,
                updated_at=created_at,
            )
        else:
            merged_aliases = _alias_list(prev.name, [*prev.aliases, *ent.aliases, ename])
            merged_external = {**prev.external_ids, **ent.external_ids}
            merged_properties = _merge_props(prev.properties, ent.properties)
            if (
                etype == prev.type
                and merged_aliases == prev.aliases
                and merged_external == prev.external_ids
                and merged_properties == prev.properties
                and sources == prev.source_count
            ):
                out.append(prev)
                continue
            props = encode_entity_props(
                ns=ns,
                id=eid,
                type=etype,
                name=prev.name,
                aliases=merged_aliases,
                external_ids=merged_external,
                properties=merged_properties,
                source_count=sources,
                created_at=prev.created_at,
                updated_at=created_at,
                relevance=prev.relevance,
                relevance_at=prev.relevance_at,
            )
        writes[eid] = props
        current[eid] = decode_entity(props)
        out.append(current[eid])

    for props in writes.values():
        await _precheck_write(runner, props)
    for eid, props in writes.items():
        if eid in stored and props["type"] != stored[eid].type:
            await runner.remove_node_label(ns, L_ENTITY, eid, stored[eid].type)
    by_type: dict[str, list[tuple[str, dict]]] = {}
    for eid, props in writes.items():
        by_type.setdefault(props["type"], []).append((eid, props))
    for etype, rows in by_type.items():
        await runner.upsert_nodes(ns, L_ENTITY, rows, extra_label=etype)
    await _write_evidence(runner, ns, records)
    return out


async def create_entity(
    runner: Any,
    ns: str,
    *,
    name: str,
    type: str,
    id: str | None = None,
    aliases: list[str] | None = None,
    external_ids: dict[str, str] | None = None,
    properties: dict[str, Any] | None = None,
    schema_check: SchemaCheck | None = None,
) -> Entity:
    """Create one entity, failing if its id already exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param name (str): entity name.
    @param type (str): entity type.
    @param id (str | None): explicit id, else derived.
    @param aliases (list[str] | None): aliases.
    @param external_ids (dict[str, str] | None): external ids.
    @param properties (dict[str, Any] | None): properties.
    @param schema_check (SchemaCheck | None): checks the entity against the schema before the write.
    @return (Entity): the created entity.
    """
    _require_text("entity type", type)
    _require_text("entity name", name)
    type = _clean_text(type)
    name = _clean_text(name)
    eid = _ids._canonical_id(id) or _ids.entity_id(type, name)
    _validate_entity_identity(eid, type, name)
    _require_id_matches_type(eid, type)
    if aliases is not None:
        _require_list("aliases", aliases)
    if external_ids is not None:
        _require_str_mapping("external_ids", external_ids)
    _require_json_mapping("properties", properties)
    properties = _merge_props(None, properties)
    if schema_check is not None:
        subject = EntityInput(id=eid if id else None, type=type, name=name, properties=properties)
        await schema_check(runner, Extraction(entities=[subject]))
    await runner.lock_node(ns, L_ENTITY, eid)
    if await runner.node_exists(ns, L_ENTITY, eid):
        raise ConflictError("Entity", eid)
    ts = now()
    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=type,
        name=name,
        aliases=_alias_list(name, aliases or []),
        external_ids=dict(external_ids or {}),
        properties=properties,
        source_count=0,
        created_at=ts,
        updated_at=ts,
    )
    await runner.upsert_node(ns, L_ENTITY, eid, props, extra_label=type)
    return decode_entity(props)


async def update_entity(
    runner: Any,
    ns: str,
    eid: str,
    *,
    schema_check: SchemaCheck | None = None,
    remove_external_ids: Iterable[str] = (),
    schema_types: Collection[str] = (),
    **fields: Any,
) -> Entity:
    """Update an entity's fields, replacing scalars and merging collections.

    Scalar fields (name, type) replace the stored value; collection fields
    (aliases, external_ids, properties) merge into what is already stored, so a
    partial update never silently drops keys. This matches insert, which merges.
    A type that differs from the stored one only in case or spacing keeps the stored
    type, unless it is a schema type name.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @param schema_check (SchemaCheck | None): checks the resulting entity against the schema before the write, given
        the stored entity too so only violations the update introduces count.
    @param remove_external_ids (Iterable[str]): external id keys to drop, used by unmerge.
    @param schema_types (Collection[str]): the schema's entity type names, which a case-only type change may adopt.
    @param fields (Any): fields to change (name, type, aliases, external_ids, properties).
    @return (Entity): the updated entity; raises ValidationError when no field is given.
    """
    check_options("entities.update", fields, _ENTITY_UPDATE_FIELDS)
    require_changes(fields)
    eid = _ids.canonical_entity_id(eid)
    existing = await get_entity(runner, ns, eid)
    if existing is None:
        raise NotFoundError("Entity", eid)
    for key in ("aliases", "remove_aliases", "remove_properties"):
        if key in fields:
            _require_list(key, fields[key])
    if "properties" in fields:
        _require_json_mapping("properties", fields["properties"])
    if "external_ids" in fields:
        _require_str_mapping("external_ids", fields["external_ids"])
    if "type" in fields:
        _require_text("entity type", fields["type"])
    if "name" in fields:
        _require_text("entity name", fields["name"])
    await runner.lock_node(ns, L_ENTITY, eid)
    existing = await get_entity(runner, ns, eid)
    if existing is None:
        raise TransientError(f"entity {eid!r} was changed concurrently; retry")
    new_type = _clean_text(fields["type"]) if "type" in fields else existing.type
    if _ids.slug(new_type) != _ids.slug(_ids.normalize_text(existing.type)):
        raise ValidationError(f"type is part of the id {eid!r}; create a new entity to change its type")
    if new_type not in schema_types:
        new_type = existing.type
    new_name = _clean_text(fields["name"]) if "name" in fields else existing.name
    _validate_entity_identity(eid, new_type, new_name)
    removed = {_clean_text(a) for a in fields.get("remove_aliases", ())}
    aliases = [a for a in _alias_list(new_name, [*existing.aliases, *fields.get("aliases", ())]) if a not in removed]
    properties = _merge_props(existing.properties, fields.get("properties"), fields.get("remove_properties", ()))
    external_ids = {**existing.external_ids, **fields.get("external_ids", {})}
    for key in remove_external_ids:
        external_ids.pop(key, None)
    if schema_check is not None:
        subject = EntityInput(id=eid, type=new_type, name=new_name, properties=properties)
        stored = EntityInput(id=eid, type=existing.type, name=existing.name, properties=existing.properties)
        await schema_check(runner, Extraction(entities=[subject]), Extraction(entities=[stored]))
    if (
        new_type == existing.type
        and new_name == existing.name
        and aliases == existing.aliases
        and external_ids == existing.external_ids
        and properties == existing.properties
    ):
        return existing
    props = encode_entity_props(
        ns=ns,
        id=eid,
        type=new_type,
        name=new_name,
        aliases=aliases,
        external_ids=external_ids,
        properties=properties,
        source_count=existing.source_count,
        created_at=existing.created_at,
        updated_at=now(),
        relevance=existing.relevance,
        relevance_at=existing.relevance_at,
    )
    await _precheck_write(runner, props)
    if new_type != existing.type:
        await runner.remove_node_label(ns, L_ENTITY, eid, existing.type)
    await runner.upsert_node(ns, L_ENTITY, eid, props, extra_label=new_type)
    return decode_entity(props)


async def list_entities(
    runner: Any,
    ns: str,
    *,
    type: str | None,
    name: str | None,
    skip: int,
    limit: int,
    canonical: Callable[[str], str] | None = None,
    after: str | None = None,
) -> list[Entity]:
    """List entities, optionally filtered by type and exact name.

    The type filter ignores letter case, as entity ids do, and compares both sides after canonical (the schema's
    alias canonicalization) when given. Stores match properties exactly, so a type filter reads entities in id
    order and filters them here.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param type (str | None): type filter.
    @param name (str | None): exact name filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @param canonical (Callable[[str], str] | None): maps a type to its schema type name, or None for no schema.
    @param after (str | None): list only entities whose id sorts after this one, for keyset paging.
    @return (list[Entity]): the entities.
    """
    _require_optional_text("type filter", type)
    _require_optional_text("name filter", name)
    equals: dict[str, Any] = {}
    if name is not None:
        equals["name"] = _clean_text(name)
    fetch = partial(runner.match_nodes, ns, L_ENTITY, equals=equals, order_by="id", id_gt=after)
    if type is None:
        return [decode_entity(r) for r in await fetch(skip=skip, limit=limit)]

    def key(etype: str) -> str:
        etype = _clean_text(etype)
        return (canonical(etype) if canonical is not None else etype).casefold()

    wanted = key(type)
    found: list[dict] = []
    read = 0
    while len(found) < skip + limit:
        rows = await fetch(skip=read, limit=_BATCH)
        read += len(rows)
        found.extend(r for r in rows if key(r["type"]) == wanted)
        if len(rows) < _BATCH:
            break
    return [decode_entity(r) for r in found[skip : skip + limit]]


async def _delete_steps(runner: Any, ns: str, tid: str) -> None:
    for step in await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP):
        await runner.delete_node(ns, L_STEP, step["id"])


async def _delete_trace_quietly(runner: Any, ns: str, tid: str) -> bool:
    """Delete a decision trace and its steps when it still exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (bool): True when a trace was removed.
    """
    if not await runner.node_exists(ns, L_TRACE, tid):
        return False
    await _delete_steps(runner, ns, tid)
    await runner.delete_node(ns, L_TRACE, tid)
    return True


async def _traces_touching_relations(runner: Any, ns: str, rids: list[str]) -> set[str]:
    """Find decision traces that use any of some relations as one of their steps.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rids (list[str]): relation ids.
    @return (set[str]): owning trace ids.
    """
    return {_ids.trace_of_step(s["id"]) for s in await _nodes_where(runner, ns, L_STEP, "relation_id", rids)}


async def _traces_touching_entities(runner: Any, ns: str, eids: list[str]) -> set[str]:
    """Find decision traces that reference any of some entities as actor, outcome, or step endpoint.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eids (list[str]): entity ids.
    @return (set[str]): referencing trace ids.
    """
    tids: set[str] = set()
    for label, keys in ((L_TRACE, ("actor_entity", "outcome_entity")), (L_STEP, ("from_entity", "to_entity"))):
        for key in keys:
            nodes = await _nodes_where(runner, ns, label, key, eids)
            tids |= {n["id"] if label == L_TRACE else _ids.trace_of_step(n["id"]) for n in nodes}
    return tids


async def _repoint_steps(runner: Any, ns: str, tids: Iterable[str], moved: Mapping[str, str]) -> None:
    """Point the steps of decision traces at the new ids of relations that moved, in trace id order.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tids (Iterable[str]): the trace ids to rewrite.
    @param moved (Mapping[str, str]): each moved relation id to its new id.
    @return (None): nothing.
    """
    for tid in sorted(tids):
        trace = await get_trace(runner, ns, tid)
        if trace is not None:
            await update_trace(runner, ns, tid, steps=[moved.get(s.relation_id, s.relation_id) for s in trace.steps])


async def delete_entity(runner: Any, ns: str, eid: str) -> dict[str, int]:
    """Delete an entity and everything attached to it, including the merge records it survived or was absorbed in.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): entity id.
    @return (dict[str, int]): counts of what was removed.
    """
    eid = _ids.canonical_entity_id(eid)
    if not await runner.node_exists(ns, L_ENTITY, eid):
        raise NotFoundError("Entity", eid)
    return await delete_entities(runner, ns, [eid])


async def _edges_into(
    runner: Any, ns: str, from_label: str, to_label: str | None, side: str, ids: list[str], **filters: Any
) -> list[dict]:
    """Read every version of the edges from one label anchored at a list of endpoints, a batch per query.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_label (str): source node label.
    @param to_label (str | None): destination node label, or None for any.
    @param side (str): "from_in" or "to_in", which endpoint the ids anchor.
    @param ids (list[str]): the endpoint ids.
    @param filters (Any): further match_edges filters, such as type or current_only.
    @return (list[dict]): the edge rows.
    """
    rows: list[dict] = []
    for batch in _batches(ids):
        fetch = partial(runner.match_edges, ns, from_label=from_label, to_label=to_label, **filters, **{side: batch})
        rows += await _paged(fetch, page=_BATCH)
    return rows


async def _preferences_about(runner: Any, ns: str, eids: set[str]) -> list[dict]:
    """Read the current preferences whose about_entity is one of some entities.

    One entity is matched by property; several read every current preference once and filter here.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eids (set[str]): entity ids.
    @return (list[dict]): the current preference edge rows.
    """
    fetch = partial(runner.match_edges, ns, from_label=L_PROFILE, current_only=True)
    if len(eids) == 1:
        return await _paged(partial(fetch, equals={"about_entity": next(iter(eids))}), page=_BATCH)
    return [e for e in await _paged(fetch, page=_BATCH) if e["props"].get("about_entity") in eids]


async def _delete_nodes_where(runner: Any, ns: str, label: str, key: str, values: list[str]) -> None:
    """Detach-delete every node of one label whose property is one of some values, a batch per query.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param label (str): node label.
    @param key (str): the property.
    @param values (list[str]): the accepted values.
    @return (None): nothing.
    """
    doomed = [n["id"] for n in await _nodes_where(runner, ns, label, key, values)]
    for batch in _batches(doomed):
        await runner.delete_nodes(ns, label, batch)


async def delete_entities(runner: Any, ns: str, eids: list[str]) -> dict[str, int]:
    """Delete many entities and everything attached to them, reading and deleting in batches.

    The result matches deleting them one by one: their relations with every version and the relations' evidence,
    decisions that reference an entity or use one of those relations as a step, their profiles and the preferences
    pointing at them, their evidence, and the merge records they survived or were absorbed in. A considered
    alternative is dropped from a decision that is kept, and a kept preference about a deleted entity loses its
    about_entity in a new version. Ids that are not stored are skipped.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eids (list[str]): canonical entity ids.
    @return (dict[str, int]): counts of what was removed.
    """
    counts = dict(_NO_DELETES)
    eids = list(await _nodes_by_id(runner, ns, L_ENTITY, _dedup_list(eids)))
    if not eids:
        return counts
    doomed = set(eids)
    versions = [
        e
        for side in ("from_in", "to_in")
        for e in await _edges_into(runner, ns, L_ENTITY, L_ENTITY, side, eids)
        if _is_relation_type(e["type"])
    ]
    seen = {(edge["props"]["id"], _revision(edge)) for edge in versions}
    rids = _dedup_list(rid for rid, _ in seen)
    counts["deleted_relation_versions"] = len(seen)
    trace_ids = await _traces_touching_entities(runner, ns, eids) | await _traces_touching_relations(runner, ns, rids)
    counts["deleted_decisions"] = sum([await _delete_trace_quietly(runner, ns, tid) for tid in sorted(trace_ids)])
    considered: dict[str, set[str]] = {}
    for edge in await _edges_into(runner, ns, L_TRACE, L_ENTITY, "to_in", eids, type=R_CONSIDERED):
        considered.setdefault(edge["from_id"], set()).add(edge["to_id"])
    for tid, alternatives in sorted(considered.items()):
        trace = None if tid in trace_ids else await get_trace(runner, ns, tid)
        if trace is not None:
            remaining = [a for a in trace.alternative_entities if a not in alternatives]
            if remaining != list(trace.alternative_entities):
                await update_trace(runner, ns, tid, alternative_entities=remaining)

    profiles = list(await _nodes_by_id(runner, ns, L_PROFILE, [_ids.profile_id(eid) for eid in eids]))
    gone_profiles = set(profiles)
    counts["deleted_preference_versions"] = len(await _edges_into(runner, ns, L_PROFILE, None, "from_in", profiles))
    for pref in await _preferences_about(runner, ns, doomed):
        if pref["to_id"] not in doomed and pref["from_id"] not in gone_profiles:
            await update_preference(
                runner,
                ns,
                pref["props"]["id"],
                strength=None,
                properties=None,
                remove_properties=[],
                event_time=None,
                clear=["about_entity"],
            )
    counts["deleted_preference_versions"] += sum(
        e["type"] in PREFERENCE_EDGE_TYPES and e["from_id"] not in gone_profiles
        for e in await _edges_into(runner, ns, L_PROFILE, L_ENTITY, "to_in", eids)
    )
    for batch in _batches(profiles):
        await runner.delete_nodes(ns, L_PROFILE, batch)
    await _delete_nodes_where(runner, ns, L_EVIDENCE, "target_id", rids)
    for batch in _batches(eids):
        await runner.delete_nodes(ns, L_ENTITY, batch)
    await _delete_nodes_where(runner, ns, L_EVIDENCE, "target_id", eids)
    for side in ("survivor_id", "absorbed_id"):
        await _delete_nodes_where(runner, ns, L_MERGE, side, eids)
    counts["deleted_entities"] = len(eids)
    return counts


async def delete_relations(runner: Any, ns: str, rids: list[str]) -> dict[str, int]:
    """Delete many relations with every version, skipping ids that are not stored.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rids (list[str]): relation ids.
    @return (dict[str, int]): counts of what was removed.
    """
    counts = dict(_NO_DELETES)
    for rid in rids:
        if await relation_exists(runner, ns, rid):
            for key, value in (await delete_relation(runner, ns, rid)).items():
                counts[key] += value
    return counts


def _is_relation_type(rtype: str) -> bool:
    """Report whether an edge type is a user relation rather than a reserved internal edge.

    @param rtype (str): the edge type.
    @return (bool): True when the edge is a user relation.
    """
    return rtype not in EDGE_TYPES


def _is_preference_type(rtype: str) -> bool:
    """Report whether an edge type is a preference edge.

    @param rtype (str): the edge type.
    @return (bool): True when the edge is a preference.
    """
    return rtype in PREFERENCE_EDGE_TYPES


def _relation_of(edge: dict) -> Relation:
    return decode_relation(edge["props"], from_entity=edge["from_id"], to_entity=edge["to_id"], type=edge["type"])


def _preference_of(edge: dict) -> Preference:
    stance = preference_stance_of(edge["type"]) or "preference"
    return decode_preference(edge["props"], value_entity=edge["to_id"], profile_id=edge["from_id"], stance=stance)


async def _typed_edge_versions(runner: Any, ns: str, eid: str, keep: Callable[[str], bool]) -> list[dict]:
    """Return the stored versions of an edge whose type is kept, so a lookup never crosses edge types.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): edge id.
    @param keep (Callable[[str], bool]): predicate selecting the edge type for this object kind.
    @return (list[dict]): the matching edge versions, empty when the id names a different edge type.
    """
    return [e for e in await runner.list_edge_versions(ns, eid) if keep(e["type"])]


async def get_relation_current(runner: Any, ns: str, rid: str) -> Relation | None:
    """Fetch the current version of a relation by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (Relation | None): the current version, or None.
    """
    _ids._require_str("relation id", rid)
    edge = await runner.get_current_edge(ns, rid)
    if edge is None or not _is_relation_type(edge["type"]):
        return None
    return _relation_of(edge)


async def relation_exists(runner: Any, ns: str, rid: str) -> bool:
    """Report whether any version of a relation (not another edge type) exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (bool): True when a relation with this id exists.
    """
    return bool(await _typed_edge_versions(runner, ns, rid, _is_relation_type))


async def list_relation_versions(runner: Any, ns: str, rid: str, *, newest_first: bool) -> list[Relation]:
    """Return every version of a relation.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @param newest_first (bool): order newest first when True.
    @return (list[Relation]): the versions.
    """
    _ids._require_str("relation id", rid)
    rels = [_relation_of(e) for e in await _typed_edge_versions(runner, ns, rid, _is_relation_type)]
    return rels[::-1] if newest_first else rels


async def _write_relation_version(
    runner: Any, ns: str, from_id: str, rtype: str, to_id: str, props: dict, *, retire: bool
) -> Relation:
    """Write a relation version as the current one, retiring the previous current version when there is one.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_id (str): source entity id.
    @param rtype (str): relation type.
    @param to_id (str): destination entity id.
    @param props (dict): the encoded version.
    @param retire (bool): True when an existing current version must be flipped first.
    @return (Relation): the written version.
    """
    if retire:
        await _precheck_write(runner, props)
        await runner.update_current_edge(ns, props["id"], {"is_current": False})
    _reject_reserved_rel_type(rtype, rtype)
    if not await runner.create_edge(ns, rtype, L_ENTITY, from_id, L_ENTITY, to_id, props):
        hint = "create the entities first, then reference them by id ('type:name')"
        await _require_endpoints(runner, ns, from_id, to_id, hint)
        raise ValidationError(f"relation endpoints not found (from={from_id!r}, to={to_id!r}); {hint}")
    return decode_relation(props, from_entity=from_id, to_entity=to_id, type=rtype)


def _revision(edge: dict) -> int:
    return int(edge["props"]["revision"])


def _keep_newest(found: dict[str, dict], edge: dict) -> None:
    """Keep an edge version by id when it has a higher revision than the one kept so far.

    @param found (dict[str, dict]): the newest edge row by id, updated in place.
    @param edge (dict): the edge version.
    @return (None): nothing.
    """
    kept = found.get(edge["props"]["id"])
    if kept is None or _revision(edge) > _revision(kept):
        found[edge["props"]["id"]] = edge


async def _newest_edge(runner: Any, ns: str, eid: str, keep: Callable[[str], bool]) -> dict | None:
    """Return the highest revision of an edge whose type is kept, current or not.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param eid (str): edge id.
    @param keep (Callable[[str], bool]): predicate selecting the edge type for this object kind.
    @return (dict | None): the newest edge version, or None when no such edge exists.
    """
    return max(await _typed_edge_versions(runner, ns, eid, keep), key=_revision, default=None)


def invalidated_note(rel: Relation) -> str:
    """Describe which relation retired a relation and when, for errors about a relation that is not current.

    @param rel (Relation): the retired version.
    @return (str): the description.
    """
    return f"relation {rel.id} was invalidated by {rel.invalidated_by} at {json_iso(rel.invalidated_at)}"


def _require_same_ends(rid: str, stored: tuple[str, str, str], given: tuple[str, str, str]) -> None:
    """Reject a write that would change the endpoints or type of an existing relation.

    @param rid (str): the relation id.
    @param stored (tuple[str, str, str]): the stored (from, type, to).
    @param given (tuple[str, str, str]): the written (from, type, to).
    @return (None): nothing; raises ValidationError when they differ.
    """
    if stored != given:
        raise ValidationError(
            f"relation {rid!r} already exists with different endpoints/type; "
            "endpoints and type are immutable; create a new relation to change them"
        )


async def _lock_current(
    runner: Any, ns: str, oid: str, kind: str, get: Callable[..., Any], keep: Callable[[str], bool], lock_on: Callable
) -> Any:
    """Return the current version of a relation or preference, read again under its lock so no writer slips in.

    An object whose newest version carries invalidated_at was retired by a contradiction, which is a settled state
    and raises ValidationError; any other object with versions but no current one is mid-write and raises
    TransientError so the caller retries.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param oid (str): the relation or preference id.
    @param kind (str): "relation" or "preference", for the errors.
    @param get (Callable[..., Any]): reads the current version, or None.
    @param keep (Callable[[str], bool]): predicate selecting the edge type for this object kind.
    @param lock_on (Callable): maps the current version to the (label, id) node to lock.
    @return (Any): the current version, under the lock.
    """
    before = await get(runner, ns, oid)
    if before is None:
        latest = await _newest_edge(runner, ns, oid, keep)
        if latest is None:
            raise NotFoundError(kind.capitalize(), oid)
        if latest["props"].get("invalidated_at"):
            raise ValidationError(f"{invalidated_note(_relation_of(latest))}; create it again to reassert it")
        raise TransientError(f"{kind} {oid!r} has no current version right now (concurrent write); retry")
    await runner.lock_node(ns, *lock_on(before))
    current = await get(runner, ns, oid)
    if current is None:
        raise TransientError(f"{kind} {oid!r} was changed concurrently; retry")
    return current


async def _precheck_write(runner: Any, props: Mapping[str, Any]) -> None:
    """Ask the store whether an encoded write fits its limits before any prior state is mutated.

    This keeps a multi-step write (retire-then-add a version, or ensure-profile-then-add an edge) atomic on
    auto-commit backends: a store size limit is checked up front, so the first write never commits ahead of a
    second write that would fail.

    @param runner (Any): graph runner.
    @param props (Mapping[str, Any]): the encoded properties about to be written.
    @return (None): nothing; raises when the store would reject the write.
    """
    check = getattr(runner, "check_doc_size", None)
    if check is not None:
        check(props)


async def _current_relations(runner: Any, ns: str, keyed: list[tuple[str, RelationInput]]) -> dict[str, dict]:
    """Fetch the current version of many relations, or the newest version of one that has no current version.

    A derived relation id fixes its endpoints, so its stored versions are among its source entity's relations; an
    explicit id may name a relation between other entities, so one not found that way is looked up by id. Only
    source entities with a relation not found current are read again across all versions, so an insert of new
    relations from new entities costs one query.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param keyed (list[tuple[str, RelationInput]]): (relation id, input) pairs.
    @return (dict[str, dict]): each found relation's current edge row, else its newest edge row, by id.
    """
    wanted = {rid for rid, _ in keyed}
    found: dict[str, dict] = {}
    for current_only in (True, False):
        pending = _dedup_list(rel.from_entity for rid, rel in keyed if rid not in found)
        for edge in await _edges_into(runner, ns, L_ENTITY, L_ENTITY, "from_in", pending, current_only=current_only):
            if edge["props"]["id"] in wanted and _is_relation_type(edge["type"]):
                _keep_newest(found, edge)
        wanted -= set(found)
    for rid, rel in keyed:
        if rel.id is not None and rid not in found:
            edge = await _newest_edge(runner, ns, rid, _is_relation_type)
            if edge is not None:
                found[rid] = edge
    return found


class RelationCap(NamedTuple):
    canonical: str
    types: tuple[str, ...]
    limits: tuple[tuple[str, int], ...]


def effective_time(version: Relation | Preference | DecisionTrace) -> datetime:
    """The time a relation, preference, or decision took effect: its event time, else its creation time.

    @param version (Relation | Preference | DecisionTrace): the version.
    @return (datetime): the effective time.
    """
    return aware(version.event_time or version.created_at)


def _rank(rel: Relation) -> tuple[datetime, int, datetime]:
    """Order a relation among others at one endpoint: by effective time, then revision, then creation time.

    @param rel (Relation): the relation version.
    @return (tuple[datetime, int, datetime]): the sort key, newer last.
    """
    return effective_time(rel), rel.revision, aware(rel.created_at)


class Contradictions:
    def __init__(
        self,
        caps: Mapping[str, RelationCap],
        mode: str,
        current: Iterable[Relation],
        history: Iterable[Relation] = (),
    ) -> None:
        """Track the current relations at every endpoint a schema max_count constrains.

        @param caps (Mapping[str, RelationCap]): the max_count limits by normalized relation type and alias.
        @param mode (str): "warn" keeps both relations of a conflict, "supersede" retires the older ones, "strict"
            raises ValidationError.
        @param current (Iterable[Relation]): the stored current relations at the constrained endpoints.
        @param history (Iterable[Relation]): the newest version of each relation a contradiction retired there.
        """
        self._caps = caps
        self._mode = mode
        self._groups: dict[tuple[str, str, str], dict[str, tuple]] = {}
        self._past: dict[tuple[str, str, str], dict[str, tuple]] = {}
        self._where: dict[str, dict[tuple[str, str, str], None]] = {}
        self._order: dict[str, int] = {}
        self._dirty: dict[tuple[str, str, str], int] = {}
        for rel in history:
            for key, _ in self._slots(rel.type, rel.from_entity, rel.to_entity):
                self._past.setdefault(key, {})[rel.id] = _rank(rel)
        for rel in current:
            for key, _ in self._slots(rel.type, rel.from_entity, rel.to_entity):
                self._seat(key, rel.id, _rank(rel))

    def _slots(self, rtype: str, from_entity: str, to_entity: str) -> list[tuple[tuple[str, str, str], int]]:
        """List the constrained endpoint groups a relation belongs to, with each group's max_count.

        @param rtype (str): the normalized relation type.
        @param from_entity (str): the source entity id.
        @param to_entity (str): the destination entity id.
        @return (list[tuple[tuple[str, str, str], int]]): ((canonical type, side, endpoint), max_count) pairs.
        """
        cap = self._caps.get(rtype)
        if cap is None:
            return []
        return [
            ((cap.canonical, side, from_entity if side == "from" else to_entity), limit) for side, limit in cap.limits
        ]

    def _seat(self, key: tuple[str, str, str], rid: str, rank: tuple) -> None:
        self._groups.setdefault(key, {})[rid] = rank
        self._past.get(key, {}).pop(rid, None)
        self._where.setdefault(rid, {})[key] = None

    def _drop(self, rid: str) -> None:
        for key in self._where.pop(rid, {}):
            self._past.setdefault(key, {})[rid] = self._groups[key].pop(rid)

    def admit(self, rid: str, rtype: str, from_entity: str, to_entity: str, rank: tuple) -> list[InsertWarning]:
        """Record a relation becoming current at every constrained endpoint.

        A conflict is more than max_count current relations of one type at one endpoint. In warn mode both are
        kept and a "contradiction" warning names the others. In strict mode the conflict raises ValidationError. In
        supersede mode the endpoint is resolved by settle once the whole write is admitted.

        @param rid (str): the relation id.
        @param rtype (str): the normalized relation type.
        @param from_entity (str): the source entity id.
        @param to_entity (str): the destination entity id.
        @param rank (tuple): the relation's rank, from _rank.
        @return (list[InsertWarning]): the warn-mode contradiction warnings.
        """
        warnings: list[InsertWarning] = []
        slots = self._slots(rtype, from_entity, to_entity)
        for key, limit in slots:
            group = self._groups.get(key, {})
            if self._mode == "supersede":
                self._dirty[key] = limit
                continue
            if rid in group or len(group) + 1 <= limit:
                continue
            canonical, side, endpoint = key
            if self._mode == "strict":
                raise ValidationError(
                    f"relation {rid} would exceed max_count {limit} for {canonical} at {side} entity {endpoint} "
                    f"(current: {', '.join(group)}); schema_mode 'strict' rejects it; use "
                    "contradiction='supersede' to retire the older relation instead"
                )
            warnings.append(
                InsertWarning(
                    code="contradiction",
                    message=f"relation {rid} contradicts current {canonical} relation(s) {', '.join(group)} "
                    f"at {side} entity {endpoint} (max_count {limit})",
                )
            )
        self._order.setdefault(rid, len(self._order) + 1)
        for key, _ in slots:
            self._seat(key, rid, rank)
        return warnings

    def settle(self) -> tuple[dict[str, tuple[str, datetime]], list[InsertWarning]]:
        """Retire the oldest current relations beyond max_count at every endpoint a supersede-mode write touched.

        The current relations at an endpoint, the ones just written included, rank by effective time, then
        revision, then creation time, and all but the newest max_count are retired. A retired relation is
        invalidated by the fact that displaced it in time order, the max_count-th newer fact at the endpoint with
        retired history counted, at that fact's effective time. Each retired relation gets one warning:
        "contradiction_out_of_order" when it was written by this write after that fact was current, else
        "relation_superseded".

        @return (tuple[dict[str, tuple[str, datetime]], list[InsertWarning]]): each retired relation id with the
            id that invalidated it and when, and the warnings.
        """
        retired: dict[str, tuple[str, datetime]] = {}
        warnings: list[InsertWarning] = []
        for key, limit in self._dirty.items():
            group = self._groups.get(key, {})
            ranked = sorted(group, key=lambda o: (group[o], o), reverse=True)
            canonical, side, endpoint = key
            for old in ranked[limit:]:
                facts = {**self._past.get(key, {}), **group}
                mine = (facts[old], old)
                newer = sorted((facts[o], o) for o in facts if (facts[o], o) > mine)
                (at, _, _), by = newer[limit - 1]
                retired[old] = (by, at)
                self._drop(old)
                if self._order.get(by, 0) < self._order.get(old, 0):
                    keeper = ranked[limit - 1]
                    warnings.append(
                        InsertWarning(
                            code="contradiction_out_of_order",
                            message=f"relation {old} is older than current {canonical} relation {keeper} "
                            f"at {side} entity {endpoint}, so {keeper} stays current",
                        )
                    )
                else:
                    warnings.append(
                        InsertWarning(
                            code="relation_superseded",
                            message=f"relation {old} was superseded by {by}, a newer {canonical} relation "
                            f"at {side} entity {endpoint} (max_count {limit})",
                        )
                    )
        self._dirty.clear()
        return retired, warnings


async def require_max_count(
    runner: Any, ns: str, caps: Mapping[str, RelationCap] | None, relations: Iterable[RelationInput]
) -> None:
    """Reject relations that would exceed a schema max_count, against the stored graph or each other, before writing.

    Strict schema mode runs this unless the contradiction mode is supersede, which resolves the conflict instead.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param caps (Mapping[str, RelationCap] | None): the max_count limits, or None without a schema.
    @param relations (Iterable[RelationInput]): the relations about to be written.
    @return (None): nothing; raises ValidationError on the first relation over a max_count.
    """
    keyed = []
    for rel in relations:
        rtype = _ids.normalize_rel_type(rel.type)
        keyed.append((rel.id or _ids.relation_id(rel.from_entity, rtype, rel.to_entity), rtype, rel))
    tracker, _ = await _contradiction_check(
        runner, ns, "strict", caps, [(rtype, rel.from_entity, rel.to_entity) for _, rtype, rel in keyed]
    )
    at = now()
    for rid, rtype, rel in keyed if tracker is not None else ():
        tracker.admit(rid, rtype, rel.from_entity, rel.to_entity, (at, 0, at))


def _retired(edge: dict, by: str, at: datetime) -> dict:
    """Mark a relation version as no longer current because a newer relation superseded it.

    @param edge (dict): the current edge row.
    @param by (str): the id of the relation that superseded it.
    @param at (datetime): the superseding relation's effective time.
    @return (dict): the edge row with its version retired.
    """
    props = {**edge["props"], "is_current": False, "invalidated_at": to_iso(at), "invalidated_by": by}
    return {**edge, "props": props}


async def _contradiction_check(
    runner: Any,
    ns: str,
    contradiction: str,
    caps: Mapping[str, RelationCap] | None,
    ends: Iterable[tuple[str, str, str]],
) -> tuple[Contradictions | None, dict[str, dict]]:
    """Prepare the contradiction check for a write, reading the current relations it can conflict with.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param contradiction (str): "off", "warn", "supersede", or "strict".
    @param caps (Mapping[str, RelationCap] | None): the max_count limits, or None without a schema.
    @param ends (Iterable[tuple[str, str, str]]): (normalized type, source id, destination id) of each write.
    @return (tuple[Contradictions | None, dict[str, dict]]): the tracker, or None when off, and each current
        relation's edge row at the constrained endpoints by id, in read order.
    """
    if contradiction == "off" or not caps:
        return None, {}
    found: dict[str, dict] = {}
    seen: set[tuple[str, str, str]] = set()
    for rtype, from_entity, to_entity in ends:
        cap = caps.get(rtype)
        for side, _ in cap.limits if cap else ():
            endpoint = from_entity if side == "from" else to_entity
            for stored in cap.types:
                if (side, endpoint, stored) in seen:
                    continue
                seen.add((side, endpoint, stored))
                anchor = {"from_id": endpoint} if side == "from" else {"to_id": endpoint}
                fetch = partial(runner.match_edges, ns, from_label=L_ENTITY, to_label=L_ENTITY, type=stored)
                for edge in await _paged(partial(fetch, **anchor), page=_BATCH):
                    _keep_newest(found, edge)
    existing = {rid: e for rid, e in found.items() if e["props"]["is_current"]}
    history = [
        _relation_of(e) for e in found.values() if not e["props"]["is_current"] and e["props"].get("invalidated_at")
    ]
    return Contradictions(caps, contradiction, [_relation_of(e) for e in existing.values()], history), existing


async def upsert_relations(
    runner: Any,
    ns: str,
    items: list[tuple[RelationInput, list[Evidence]]],
    *,
    default_event_time: datetime | None,
    created_at: datetime,
    contradiction: str = "off",
    caps: Mapping[str, RelationCap] | None = None,
    warnings: list[InsertWarning] | None = None,
) -> list[Relation]:
    """Insert-semantics upsert of many relations: merge properties, versioning on change, recording evidence.

    Relations are read and written in batches; a repeated id applies after the earlier input, as sequential
    upserts would. A relation invalidated by a contradiction is reasserted, as a new current revision, by an input
    whose effective time is at or after its invalidation; an earlier input restates history and leaves it retired.
    A superseded relation is retired in place: its version keeps its revision and gains invalidated_at and
    invalidated_by, so the version list shows exactly the writes that happened. In supersede mode each constrained
    endpoint the batch touches is settled once after the whole batch (see Contradictions.settle): an input older than
    the relations it conflicts with is written already invalidated. New versions are written before any retirement,
    so a failed write never leaves an endpoint without its current relation.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param items (list[tuple[RelationInput, list[Evidence]]]): relations to upsert with their evidence, in order.
    @param default_event_time (datetime | None): fallback event time.
    @param created_at (datetime): timestamp.
    @param contradiction (str): "off", "warn", or "supersede", applied where caps set a max_count.
    @param caps (Mapping[str, RelationCap] | None): the schema's max_count limits by relation type.
    @param warnings (list[InsertWarning] | None): receives the contradiction warnings.
    @return (list[Relation]): each input's stored version, in input order.
    """
    keyed = []
    for rel, evidence in items:
        _validate_own_id("relation", rel.id)
        rtype = _ids.normalize_rel_type(rel.type)
        _reject_reserved_rel_type(rtype, rtype)
        keyed.append((rel.id or _ids.relation_id(rel.from_entity, rtype, rel.to_entity), rtype, rel, evidence))
    for from_entity in _dedup_list(rel.from_entity for _, _, rel, _ in keyed):
        await runner.lock_node(ns, L_ENTITY, from_entity)
    rids = _dedup_list(rid for rid, *_ in keyed)
    stored = await _current_relations(runner, ns, [(rid, rel) for rid, _, rel, _ in keyed])
    records, gained = await _plan_evidence(
        runner,
        ns,
        [(rid, ev) for rid, _, _, evidence in keyed for ev in evidence],
        new_targets=set(rids) - set(stored),
    )
    tracker, existing = await _contradiction_check(
        runner, ns, contradiction, caps, [(rtype, rel.from_entity, rel.to_entity) for _, rtype, rel, _ in keyed]
    )

    current: dict[str, dict] = dict(stored)
    writes: dict[tuple[str, int], dict] = {}
    retires: dict[tuple[str, int], dict] = {}
    out: list[tuple[str, int, Relation]] = []
    for rid, rtype, rel, _ in keyed:
        event_time = rel.event_time or default_event_time
        effective = aware(event_time or created_at)
        edge = current.get(rid)
        write = True
        if edge is None:
            props = encode_relation_props(
                ns=ns,
                id=rid,
                revision=1,
                properties=_merge_props(None, rel.properties),
                event_time=event_time,
                created_at=created_at,
                is_current=True,
                source_count=gained.pop(rid, 0),
            )
            edge = {"props": props, "from_id": rel.from_entity, "to_id": rel.to_entity, "type": rtype}
        else:
            _require_same_ends(
                rid, (edge["from_id"], edge["type"], edge["to_id"]), (rel.from_entity, rtype, rel.to_entity)
            )
            prev = _relation_of(edge)
            sources = prev.source_count + gained.pop(rid, 0)
            merged_properties = _merge_props(prev.properties, rel.properties)
            reassert = not prev.is_current and (prev.invalidated_at is None or effective >= prev.invalidated_at)
            unchanged = prev.properties == merged_properties and to_iso(prev.event_time) == to_iso(event_time)
            if unchanged and not reassert:
                write = sources != prev.source_count
                props = {**edge["props"], "source_count": sources}
            else:
                if prev.is_current:
                    writes[(rid, prev.revision)] = {**edge["props"], "is_current": False}
                props = encode_relation_props(
                    ns=ns,
                    id=rid,
                    revision=prev.revision + 1,
                    properties=merged_properties,
                    event_time=event_time,
                    created_at=created_at,
                    is_current=prev.is_current or reassert,
                    source_count=sources,
                    invalidated_at=None if prev.is_current or reassert else prev.invalidated_at,
                    invalidated_by=None if prev.is_current or reassert else prev.invalidated_by,
                )
            edge = {**edge, "props": props}
        if tracker is not None and props["is_current"]:
            found = tracker.admit(rid, rtype, rel.from_entity, rel.to_entity, _rank(_relation_of(edge)))
            if warnings is not None:
                warnings.extend(found)
        if write:
            writes[(rid, props["revision"])] = props
        current[rid] = edge
        out.append((rid, props["revision"], _relation_of(edge)))
    ended, found = tracker.settle() if tracker is not None else ({}, [])
    if warnings is not None:
        warnings.extend(found)
    for old, (by, at) in ended.items():
        gone = _retired(current.get(old) or existing[old], by, at)
        key = (old, gone["props"]["revision"])
        (writes if key in writes else retires)[key] = gone["props"]
        current[old] = gone

    for props in [*writes.values(), *retires.values()]:
        await _precheck_write(runner, props)
    for batch in (writes, retires):
        rows = []
        for (rid, _), props in batch.items():
            edge = current[rid]
            rows.append((edge["type"], edge["from_id"], edge["to_id"], props))
        if rows:
            await runner.create_edges(ns, L_ENTITY, L_ENTITY, rows)
    await _write_evidence(runner, ns, records)
    final = {**writes, **retires}
    result = []
    for rid, revision, rel in out:
        props = final.get((rid, revision))
        result.append(rel if props is None else _relation_of({**current[rid], "props": props}))
    return result


async def create_relation(
    runner: Any,
    ns: str,
    *,
    from_entity: str,
    type: str,
    to_entity: str,
    id: str | None,
    properties: dict[str, Any] | None,
    event_time: datetime | None,
    evidence: list[Evidence],
    schema_check: SchemaCheck | None = None,
    contradiction: str = "off",
    caps: Mapping[str, RelationCap] | None = None,
    warnings: list[InsertWarning] | None = None,
) -> Relation:
    """Create one relation version, failing if the id already exists unless a contradiction invalidated it.

    Creating an invalidated relation again reasserts it as a new current revision with exactly the given properties,
    nothing carried over from the retired one, and adds a "relation_reasserted" warning. Without event_time the
    effective time is the creation time. The new version is written before any relation it supersedes is retired; in
    supersede mode one older than the current relations it conflicts with is written already invalidated.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_entity (str): source entity id.
    @param type (str): relation type.
    @param to_entity (str): destination entity id.
    @param id (str | None): explicit id, else derived.
    @param properties (dict[str, Any] | None): relation properties.
    @param event_time (datetime | None): valid time.
    @param evidence (list[Evidence]): evidence.
    @param schema_check (SchemaCheck | None): checks the relation against the schema before the write.
    @param contradiction (str): "off", "warn", "supersede", or "strict" (raise), applied where caps set a max_count.
    @param caps (Mapping[str, RelationCap] | None): the schema's max_count limits by relation type.
    @param warnings (list[InsertWarning] | None): receives the contradiction warnings.
    @return (Relation): the created relation.
    """
    _require_text("relation from_entity", from_entity)
    _require_text("relation type", type)
    _require_text("relation to_entity", to_entity)
    from_entity, to_entity = _ids._canonical_id(from_entity), _ids._canonical_id(to_entity)
    _require_json_mapping("properties", properties)
    properties = _merge_props(None, properties)
    event_time = parse_time(event_time, "event_time")
    rtype = _ids.normalize_rel_type(type)
    _validate_own_id("relation", id)
    rid = id or _ids.relation_id(from_entity, rtype, to_entity)
    if schema_check is not None:
        subject = RelationInput(id=id, from_entity=from_entity, type=rtype, to_entity=to_entity, properties=properties)
        await schema_check(runner, Extraction(relations=[subject]))
    await runner.lock_node(ns, L_ENTITY, from_entity)
    newest = await _newest_edge(runner, ns, rid, _is_relation_type)
    prior = None if newest is None else _relation_of(newest)
    if prior is not None:
        if prior.is_current or prior.invalidated_at is None:
            raise ConflictError("Relation", rid)
        _require_same_ends(rid, (prior.from_entity, prior.type, prior.to_entity), (from_entity, rtype, to_entity))
    records, gained = await _plan_evidence(
        runner, ns, [(rid, ev) for ev in evidence], new_targets=set() if prior else {rid}
    )
    created_at = now()
    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=prior.revision + 1 if prior else 1,
        properties=properties,
        event_time=event_time,
        created_at=created_at,
        is_current=True,
        source_count=(prior.source_count if prior else 0) + gained.get(rid, 0),
    )
    tracker, existing = await _contradiction_check(runner, ns, contradiction, caps, [(rtype, from_entity, to_entity)])
    retires = []
    if tracker is not None:
        edge = {"props": props, "from_id": from_entity, "to_id": to_entity, "type": rtype}
        found = tracker.admit(rid, rtype, from_entity, to_entity, _rank(_relation_of(edge)))
        ended, settled = tracker.settle()
        if warnings is not None:
            warnings.extend([*found, *settled])
        retires = [_retired(existing[old], by, at) for old, (by, at) in ended.items() if old != rid]
        if rid in ended:
            props = _retired(edge, *ended[rid])["props"]
    for write in [props, *(edge["props"] for edge in retires)]:
        await _precheck_write(runner, write)
    rel = await _write_relation_version(runner, ns, from_entity, rtype, to_entity, props, retire=False)
    if retires:
        await runner.create_edges(
            ns, L_ENTITY, L_ENTITY, [(e["type"], e["from_id"], e["to_id"], e["props"]) for e in retires]
        )
    await _write_evidence(runner, ns, records)
    if prior is not None and warnings is not None:
        warnings.append(
            InsertWarning(
                code="relation_reasserted",
                message=f"{invalidated_note(prior)} (revision {prior.revision}); reasserted as revision "
                f"{rel.revision} with exactly the given properties",
            )
        )
    return rel


async def update_relation(
    runner: Any,
    ns: str,
    rid: str,
    *,
    set_properties: dict[str, Any] | None,
    remove_properties: list[str],
    event_time: datetime | None,
    evidence: list[Evidence] | None,
    schema_check: SchemaCheck | None = None,
) -> Relation:
    """Create a new version of a relation with changed properties.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @param set_properties (dict[str, Any] | None): properties to set.
    @param remove_properties (list[str]): property keys to drop.
    @param event_time (datetime | None): new valid time.
    @param evidence (list[Evidence] | None): evidence to merge.
    @param schema_check (SchemaCheck | None): checks the resulting relation against the schema before the write, given
        the stored version too so only violations the update introduces count.
    @return (Relation): the new current version; raises ValidationError for a relation a contradiction invalidated.
    """
    _require_json_mapping("set_properties", set_properties)
    _require_list("remove_properties", remove_properties)
    given = {
        "set_properties": set_properties,
        "remove_properties": remove_properties or None,
        "event_time": event_time,
        "evidence": evidence,
    }
    require_changes({k: v for k, v in given.items() if v is not None})
    event_time = parse_time(event_time, "event_time")
    current = await _lock_current(
        runner, ns, rid, "relation", get_relation_current, _is_relation_type, lambda rel: (L_ENTITY, rel.from_entity)
    )
    new_props = _merge_props(current.properties, set_properties, remove_properties)
    if schema_check is not None:
        subject = RelationInput(
            id=rid,
            from_entity=current.from_entity,
            type=current.type,
            to_entity=current.to_entity,
            properties=new_props,
        )
        stored = subject.model_copy(update={"properties": current.properties})
        await schema_check(runner, Extraction(relations=[subject]), Extraction(relations=[stored]))
    new_event_time = event_time if event_time is not None else current.event_time
    records, gained = await _plan_evidence(runner, ns, [(rid, ev) for ev in evidence or []], new_targets=set())
    sources = current.source_count + gained.get(rid, 0)

    if new_props == current.properties and to_iso(new_event_time) == to_iso(current.event_time):
        if sources != current.source_count:
            await runner.update_current_edge(ns, rid, {"source_count": sources})
            current.source_count = sources
        await _write_evidence(runner, ns, records)
        return current

    props = encode_relation_props(
        ns=ns,
        id=rid,
        revision=current.revision + 1,
        properties=new_props,
        event_time=new_event_time,
        created_at=now(),
        is_current=True,
        source_count=sources,
    )
    rel = await _write_relation_version(
        runner, ns, current.from_entity, current.type, current.to_entity, props, retire=True
    )
    await _write_evidence(runner, ns, records)
    return rel


async def list_relations(
    runner: Any,
    ns: str,
    *,
    from_entity: str | None,
    type: str | None,
    to_entity: str | None,
    skip: int,
    limit: int,
    from_in: list[str] | None = None,
    to_in: list[str] | None = None,
    include_invalidated: bool = False,
    after: str | None = None,
) -> list[Relation]:
    """List current relations, optionally filtered by endpoints and type.

    With include_invalidated, the newest version of each relation a contradiction invalidated is listed too, in
    id order with the current ones; this reads every version matching the filters.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param from_entity (str | None): source filter.
    @param type (str | None): type filter.
    @param to_entity (str | None): destination filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @param from_in (list[str] | None): keep only relations whose source is in this list.
    @param to_in (list[str] | None): keep only relations whose destination is in this list.
    @param include_invalidated (bool): also list invalidated relations.
    @param after (str | None): list only relations whose id sorts after this one, for keyset paging.
    @return (list[Relation]): the current relations, and the invalidated ones when asked.
    """
    _require_optional_text("from_entity filter", from_entity)
    _require_optional_text("type filter", type)
    _require_optional_text("to_entity filter", to_entity)
    from_entity, to_entity = _ids._canonical_id(from_entity), _ids._canonical_id(to_entity)
    for name, ids in (("from_in filter", from_in), ("to_in filter", to_in)):
        if ids is not None:
            _require_list(name, ids)
    fetch = partial(
        runner.match_edges,
        ns,
        from_label=L_ENTITY,
        to_label=L_ENTITY,
        type=_ids.normalize_rel_type(type) if type else None,
        from_id=from_entity,
        to_id=to_entity,
        from_in=from_in,
        to_in=to_in,
        current_only=not include_invalidated,
        order_by="id",
        id_gt=after,
    )
    if not include_invalidated:
        return [_relation_of(r) for r in await fetch(skip=skip, limit=limit)]
    newest: dict[str, dict] = {}
    for edge in await _paged(fetch, page=_BATCH):
        _keep_newest(newest, edge)
    rows = [e for e in newest.values() if e["props"]["is_current"] or e["props"].get("invalidated_at")]
    return [_relation_of(r) for r in rows[skip : skip + limit]]


def version_as_of(versions: Iterable[Any], as_of: datetime) -> Any:
    """Pick the version of a relation or preference that was valid at a point in time.

    The picked version is the highest revision whose effective time is at or before as_of, so a later write overrides
    earlier ones from its effective time on. It is valid unless the first invalidation recorded at or after its
    revision happened at or before as_of.

    @param versions (Iterable[Relation | Preference]): every version of one relation or preference.
    @param as_of (datetime): the point in time.
    @return (Relation | Preference | None): the version valid at as_of, or None.
    """
    ordered = sorted(versions, key=lambda v: v.revision)
    picked = None
    for version in ordered:
        if effective_time(version) <= as_of:
            picked = version
    if picked is None:
        return None
    for version in ordered:
        ended = getattr(version, "invalidated_at", None)
        if version.revision >= picked.revision and ended is not None:
            return picked if ended > as_of else None
    return picked


def _pick_as_of(edges: list[dict], decode: Callable[[dict], Any], as_of: datetime) -> list[Any]:
    """Group edge versions by id in read order and keep the version of each valid at a point in time.

    @param edges (list[dict]): the edge versions.
    @param decode (Callable[[dict], Any]): turns an edge row into a Relation or Preference.
    @param as_of (datetime): the point in time.
    @return (list[Any]): the valid versions, one per id at most.
    """
    versions: dict[str, list[Any]] = {}
    for edge in edges:
        versions.setdefault(edge["props"]["id"], []).append(decode(edge))
    picked = [version_as_of(group, as_of) for group in versions.values()]
    return [version for version in picked if version is not None]


async def relations_as_of(
    runner: Any, ns: str, as_of: datetime, *, from_in: list[str] | None = None, to_in: list[str] | None = None
) -> list[Relation]:
    """Read every version of the relations starting or ending at some entities, as each stood at a point in time.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param as_of (datetime): the point in time.
    @param from_in (list[str] | None): keep relations whose source is in this list.
    @param to_in (list[str] | None): keep relations whose destination is in this list.
    @return (list[Relation]): the relations valid at as_of, in id order.
    """
    fetch = partial(
        runner.match_edges, ns, from_label=L_ENTITY, to_label=L_ENTITY, from_in=from_in, to_in=to_in, order_by="id"
    )
    edges = [e for e in await _paged(fetch) if _is_relation_type(e["type"])]
    return _pick_as_of(edges, _relation_of, as_of)


async def preferences_as_of(runner: Any, ns: str, as_of: datetime) -> list[Preference]:
    """Read every version of every preference, as each stood at a point in time.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param as_of (datetime): the point in time.
    @return (list[Preference]): the preferences valid at as_of, in id order.
    """
    fetch = partial(runner.match_edges, ns, from_label=L_PROFILE, to_label=None, order_by="id")
    edges = [e for e in await _paged(fetch) if _is_preference_type(e["type"])]
    return _pick_as_of(edges, _preference_of, as_of)


async def delete_relation(runner: Any, ns: str, rid: str) -> dict[str, int]:
    """Delete a relation and all of its versions.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param rid (str): relation id.
    @return (dict[str, int]): counts of what was removed.
    """
    _ids._require_str("relation id", rid)
    if not await relation_exists(runner, ns, rid):
        raise NotFoundError("Relation", rid)
    trace_ids = await _traces_touching_relations(runner, ns, [rid])
    n = await runner.delete_edges(ns, rid)
    await _delete_evidence(runner, ns, rid)
    deleted_decisions = sum([await _delete_trace_quietly(runner, ns, tid) for tid in trace_ids])
    return {**_NO_DELETES, "deleted_relation_versions": n, "deleted_decisions": deleted_decisions}


async def _ensure_profile(runner: Any, ns: str, subject_id: str, created_at: datetime) -> str:
    pid = _ids.profile_id(subject_id)
    if await runner.node_exists(ns, L_PROFILE, pid):
        return pid
    if not await runner.node_exists(ns, L_ENTITY, subject_id):
        raise ValidationError(f"preference references unknown subject entity {subject_id!r}")
    await runner.upsert_node(
        ns,
        L_PROFILE,
        pid,
        {"id": pid, "ns": ns, "subject_entity": subject_id, "created_at": to_iso(created_at)},
    )
    await runner.create_edge(
        ns,
        R_HAS_PROFILE,
        L_ENTITY,
        subject_id,
        L_PROFILE,
        pid,
        {"ns": ns, "id": child_edge_id(R_HAS_PROFILE, pid), "revision": 1},
    )
    return pid


async def _write_preference_version(
    runner: Any, ns: str, profile_id: str, value_entity: str, stance: str, props: dict, *, retire: bool
) -> Preference:
    """Write a preference version as the current one, retiring the previous current version when there is one.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param profile_id (str): the subject's profile id.
    @param value_entity (str): value entity id.
    @param stance (str): preference or disinterest.
    @param props (dict): the encoded version.
    @param retire (bool): True when an existing current version must be flipped first.
    @return (Preference): the written version.
    """
    if retire:
        await _precheck_write(runner, props)
        await runner.update_current_edge(ns, props["id"], {"is_current": False})
    await runner.create_edge(ns, preference_edge_type(stance), L_PROFILE, profile_id, L_ENTITY, value_entity, props)
    return decode_preference(props, value_entity=value_entity, profile_id=profile_id, stance=stance)


async def get_preference(runner: Any, ns: str, pid: str) -> Preference | None:
    """Fetch the current version of a preference by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (Preference | None): the current version, or None.
    """
    _ids._require_str("preference id", pid)
    edge = await runner.get_current_edge(ns, pid)
    if edge is None or not _is_preference_type(edge["type"]):
        return None
    return _preference_of(edge)


async def preference_exists(runner: Any, ns: str, pid: str) -> bool:
    """Report whether any version of a preference (not another edge type) exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (bool): True when a preference with this id exists.
    """
    return bool(await _typed_edge_versions(runner, ns, pid, _is_preference_type))


async def upsert_preference(
    runner: Any,
    ns: str,
    pref: PreferenceInput,
    *,
    default_event_time: datetime | None,
    created_at: datetime,
) -> Preference:
    """Insert-semantics upsert of a preference: merge properties, versioning on change.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pref (PreferenceInput): preference to upsert.
    @param default_event_time (datetime | None): fallback event time.
    @param created_at (datetime): timestamp.
    @return (Preference): the stored current version.
    """
    _validate_strength(pref.strength)
    _validate_own_id("preference", pref.id)
    pid = pref.id or _ids.preference_id(pref.subject_entity, pref.stance, pref.key, pref.value_entity)
    event_time = pref.event_time or default_event_time
    await _require_preference_refs(runner, ns, pref.value_entity, pref.about_entity)
    profile_id = await _ensure_profile(runner, ns, pref.subject_entity, created_at)

    await runner.lock_node(ns, L_PROFILE, profile_id)
    current = await get_preference(runner, ns, pid)
    if current is not None and (
        current.subject_entity != pref.subject_entity
        or current.stance != pref.stance
        or current.key != _ids.normalize_text(pref.key)
        or current.value_entity != pref.value_entity
    ):
        raise ValidationError(
            f"preference {pid!r} already exists with different subject/stance/key/value; "
            "these identify the preference and are immutable; create a new preference to change them"
        )
    merged_props = _merge_props(current.properties if current is not None else None, pref.properties)
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=1 if current is None else current.revision + 1,
        subject_entity=pref.subject_entity,
        key=_ids.normalize_text(pref.key),
        about_entity=pref.about_entity,
        strength=pref.strength,
        properties=merged_props,
        event_time=event_time,
        created_at=created_at,
        is_current=True,
    )

    if (
        current is not None
        and current.strength == pref.strength
        and current.about_entity == pref.about_entity
        and current.properties == merged_props
        and to_iso(current.event_time) == to_iso(event_time)
    ):
        return current
    return await _write_preference_version(
        runner, ns, profile_id, pref.value_entity, pref.stance, props, retire=current is not None
    )


async def create_preference(
    runner: Any,
    ns: str,
    *,
    subject_entity: str,
    key: str,
    value_entity: str,
    id: str | None,
    stance: str,
    about_entity: str | None,
    strength: float | None,
    properties: dict[str, Any] | None,
    event_time: datetime | None,
) -> Preference:
    """Create one preference, failing if its id already exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param subject_entity (str): subject entity id.
    @param key (str): preference key.
    @param value_entity (str): value entity id.
    @param id (str | None): explicit id, else derived.
    @param stance (str): preference or disinterest.
    @param about_entity (str | None): entity the preference is about.
    @param strength (float | None): strength.
    @param properties (dict[str, Any] | None): properties.
    @param event_time (datetime | None): valid time.
    @return (Preference): the created preference.
    """
    _require_choice("preference stance", stance, _STANCES)
    _validate_strength(strength)
    _require_text("preference subject_entity", subject_entity)
    _require_text("preference key", key)
    _require_text("preference value_entity", value_entity)
    subject_entity, value_entity, about_entity = map(_ids._canonical_id, (subject_entity, value_entity, about_entity))
    key = _ids.normalize_text(key)
    _require_json_mapping("properties", properties)
    properties = _merge_props(None, properties)
    event_time = parse_time(event_time, "event_time")
    _validate_own_id("preference", id)
    pid = id or _ids.preference_id(subject_entity, stance, key, value_entity)
    await _require_preference_refs(runner, ns, value_entity, about_entity)
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=1,
        subject_entity=subject_entity,
        key=key,
        about_entity=about_entity,
        strength=strength,
        properties=properties,
        event_time=event_time,
        created_at=now(),
        is_current=True,
    )
    await _precheck_write(runner, props)
    profile_id = await _ensure_profile(runner, ns, subject_entity, now())
    await runner.lock_node(ns, L_PROFILE, profile_id)
    if await preference_exists(runner, ns, pid):
        raise ConflictError("Preference", pid)
    return await _write_preference_version(runner, ns, profile_id, value_entity, stance, props, retire=False)


async def update_preference(
    runner: Any,
    ns: str,
    pid: str,
    *,
    strength: float | None,
    properties: dict[str, Any] | None,
    remove_properties: list[str],
    event_time: datetime | None,
    clear: Iterable[str] = (),
) -> Preference:
    """Create a new version of a preference, merging properties like entities and relations.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @param strength (float | None): new strength.
    @param properties (dict[str, Any] | None): properties to merge in.
    @param remove_properties (list[str]): property keys to drop.
    @param event_time (datetime | None): new valid time.
    @param clear (Iterable[str]): fields to clear: strength, about_entity, or event_time.
    @return (Preference): the new current version.
    """
    _validate_strength(strength)
    _require_json_mapping("properties", properties)
    _require_list("remove_properties", remove_properties)
    event_time = parse_time(event_time, "event_time")
    cleared = _require_clear(
        "preferences.update", clear, PREFERENCE_CLEARABLE, {"strength": strength, "event_time": event_time}
    )
    given = {
        "strength": strength,
        "properties": properties,
        "remove_properties": remove_properties or None,
        "event_time": event_time,
        "clear": cleared or None,
    }
    require_changes({k: v for k, v in given.items() if v is not None})
    current = await _lock_current(
        runner, ns, pid, "preference", get_preference, _is_preference_type, lambda pref: (L_PROFILE, pref.profile_id)
    )
    new_strength = None if "strength" in cleared else strength if strength is not None else current.strength
    new_props = _merge_props(current.properties, properties, remove_properties)
    new_event_time = None if "event_time" in cleared else event_time if event_time is not None else current.event_time
    new_about = None if "about_entity" in cleared else current.about_entity
    if (
        new_strength == current.strength
        and new_about == current.about_entity
        and new_props == current.properties
        and to_iso(new_event_time) == to_iso(current.event_time)
    ):
        return current
    props = encode_preference_props(
        ns=ns,
        id=pid,
        revision=current.revision + 1,
        subject_entity=current.subject_entity,
        key=current.key,
        about_entity=new_about,
        strength=new_strength,
        properties=new_props,
        event_time=new_event_time,
        created_at=now(),
        is_current=True,
    )
    return await _write_preference_version(
        runner, ns, current.profile_id, current.value_entity, current.stance, props, retire=True
    )


async def list_preference_versions(runner: Any, ns: str, pid: str, *, newest_first: bool) -> list[Preference]:
    """Return every version of a preference.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @param newest_first (bool): order newest first when True.
    @return (list[Preference]): the versions.
    """
    _ids._require_str("preference id", pid)
    prefs = [_preference_of(e) for e in await _typed_edge_versions(runner, ns, pid, _is_preference_type)]
    return prefs[::-1] if newest_first else prefs


async def list_preferences(
    runner: Any,
    ns: str,
    *,
    subject_entity: str | None,
    key: str | None,
    stance: str | None,
    skip: int,
    limit: int,
    after: str | None = None,
) -> list[Preference]:
    """List current preferences, optionally scoped to one subject.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param subject_entity (str | None): subject entity id, or None for every subject.
    @param key (str | None): key filter.
    @param stance (str | None): preference or disinterest filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @param after (str | None): list only preferences whose id sorts after this one, for keyset paging.
    @return (list[Preference]): the current preferences.
    """
    _require_optional_text("subject_entity filter", subject_entity)
    _require_optional_text("key filter", key)
    if stance is not None:
        _require_choice("preference stance", stance, _STANCES)
    equals: dict[str, Any] = {}
    if subject_entity is not None:
        equals["subject_entity"] = _ids._canonical_id(subject_entity)
    if key is not None:
        equals["key"] = _ids.normalize_text(key)
    etype = preference_edge_type(stance) if stance is not None else None
    rows = await runner.match_edges(
        ns,
        from_label=L_PROFILE,
        to_label=None,
        type=etype,
        current_only=True,
        equals=equals,
        order_by="id",
        skip=skip,
        limit=limit,
        id_gt=after,
    )
    return [_preference_of(r) for r in rows]


async def delete_preference(runner: Any, ns: str, pid: str) -> dict[str, int]:
    """Delete a preference and all of its versions.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param pid (str): preference id.
    @return (dict[str, int]): counts of what was removed.
    """
    _ids._require_str("preference id", pid)
    if not await preference_exists(runner, ns, pid):
        raise NotFoundError("Preference", pid)
    return {**_NO_DELETES, "deleted_preference_versions": await runner.delete_edges(ns, pid)}


async def _read_steps(runner: Any, ns: str, tid: str) -> list[DecisionStep]:
    rows = await runner.child_nodes(ns, L_TRACE, tid, R_HAS_STEP, L_STEP, order_by="order")
    return [
        DecisionStep(
            order=int(r["order"]),
            relation_id=r["relation_id"],
            from_entity=r["from_entity"],
            to_entity=r["to_entity"],
        )
        for r in sorted(rows, key=lambda r: int(r["order"]))
    ]


async def get_trace(runner: Any, ns: str, tid: str) -> DecisionTrace | None:
    """Fetch one decision trace by id.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (DecisionTrace | None): the trace, or None.
    """
    _ids._require_str("decision id", tid)
    props = await runner.get_node(ns, L_TRACE, tid)
    if props is None:
        return None
    return decode_trace(props, await _read_steps(runner, ns, tid))


async def _resolve_steps(runner: Any, ns: str, step_rel_ids: list[str]) -> list[DecisionStep]:
    """Resolve decision step relation ids to their latest versions, so a step can name a retired relation.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param step_rel_ids (list[str]): ordered relation ids.
    @return (list[DecisionStep]): the steps; raises ValidationError for an id with no version.
    """
    steps: list[DecisionStep] = []
    for order, rel_id in enumerate(step_rel_ids):
        edge = await _newest_edge(runner, ns, rel_id, _is_relation_type)
        if edge is None:
            raise ValidationError(f"decision step references unknown relation {rel_id!r}")
        steps.append(
            DecisionStep(order=order, relation_id=rel_id, from_entity=edge["from_id"], to_entity=edge["to_id"])
        )
    return steps


async def upsert_trace(
    runner: Any,
    ns: str,
    *,
    tid: str | None,
    title: str,
    step_rel_ids: list[str],
    actor_entity: str | None,
    summary: str | None,
    rationale: str | None,
    outcome_entity: str | None,
    alternative_entities: list[str],
    status: str,
    event_time: datetime | None,
    created_at: datetime,
    create: bool = False,
) -> DecisionTrace:
    """Insert-semantics upsert of a decision trace and its structure.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str | None): explicit id, else derived.
    @param title (str): trace title.
    @param step_rel_ids (list[str]): ordered relation ids for the steps.
    @param actor_entity (str | None): actor entity id.
    @param summary (str | None): summary.
    @param rationale (str | None): rationale.
    @param outcome_entity (str | None): outcome entity id.
    @param alternative_entities (list[str]): alternative entity ids.
    @param status (str): status.
    @param event_time (datetime | None): valid time.
    @param created_at (datetime): timestamp.
    @param create (bool): raise ConflictError, after every input is checked, when the trace already exists.
    @return (DecisionTrace): the stored trace.
    """
    _require_choice("decision status", status, _STATUSES)
    _require_text("decision title", title)
    title = _ids.normalize_text(title)
    if actor_entity is not None:
        _require_text("decision actor_entity", actor_entity)
    _require_optional_text("decision summary", summary)
    _require_optional_text("decision rationale", rationale)
    _require_list("decision steps", step_rel_ids)
    _require_list("alternative_entities", alternative_entities)
    event_time = parse_time(event_time, "event_time")
    _validate_own_id("decision", tid)
    actor_entity, outcome_entity = _ids._canonical_id(actor_entity), _ids._canonical_id(outcome_entity)
    alternative_entities = _dedup_list(map(_ids._canonical_id, alternative_entities))
    tid = tid or _ids.decision_id(actor_entity, title)
    await _require_trace_refs(runner, ns, actor_entity, outcome_entity, alternative_entities)
    steps = await _resolve_steps(runner, ns, step_rel_ids)
    await runner.lock_node(ns, L_TRACE, tid)
    existing = await get_trace(runner, ns, tid)
    if create and existing is not None:
        raise ConflictError("DecisionTrace", tid)
    if existing is not None and (
        existing.title == title
        and existing.actor_entity == actor_entity
        and existing.summary == summary
        and existing.rationale == rationale
        and existing.status == status
        and existing.outcome_entity == outcome_entity
        and list(existing.alternative_entities) == alternative_entities
        and to_iso(existing.event_time) == to_iso(event_time)
        and [s.relation_id for s in existing.steps] == [s.relation_id for s in steps]
    ):
        return existing
    made_at = existing.created_at if existing is not None else created_at
    props = encode_trace_props(
        ns=ns,
        id=tid,
        title=title,
        actor_entity=actor_entity,
        summary=summary,
        rationale=rationale,
        status=status,
        outcome_entity=outcome_entity,
        alternative_entities=alternative_entities,
        event_time=event_time,
        created_at=made_at,
        updated_at=created_at,
    )
    await _precheck_write(runner, props)
    if existing is not None:
        await _delete_steps(runner, ns, tid)
        for rtype in (R_MADE_DECISION, R_RESULTED_IN, R_CONSIDERED):
            await runner.delete_edges_touching_by_type(ns, L_TRACE, tid, rtype)
    await runner.upsert_node(ns, L_TRACE, tid, props)
    if actor_entity is not None:
        await runner.create_edge(ns, R_MADE_DECISION, L_ENTITY, actor_entity, L_TRACE, tid, {"ns": ns})
    if outcome_entity is not None:
        await runner.create_edge(ns, R_RESULTED_IN, L_TRACE, tid, L_ENTITY, outcome_entity, {"ns": ns})
    for alt in alternative_entities:
        await runner.create_edge(ns, R_CONSIDERED, L_TRACE, tid, L_ENTITY, alt, {"ns": ns})
    for step in steps:
        sid = _ids.step_id(tid, step.order)
        await runner.upsert_node(
            ns,
            L_STEP,
            sid,
            {
                "id": sid,
                "ns": ns,
                "relation_id": step.relation_id,
                "order": step.order,
                "from_entity": step.from_entity,
                "to_entity": step.to_entity,
            },
        )
        await runner.create_edge(ns, R_HAS_STEP, L_TRACE, tid, L_STEP, sid, {"ns": ns, "order": step.order})
        await runner.create_edge(ns, R_FROM, L_STEP, sid, L_ENTITY, step.from_entity, {"ns": ns})
        await runner.create_edge(ns, R_TO, L_STEP, sid, L_ENTITY, step.to_entity, {"ns": ns})
    return decode_trace(props, steps)


async def create_trace(
    runner: Any,
    ns: str,
    *,
    title: str,
    steps: list[str],
    id: str | None,
    actor_entity: str | None,
    summary: str | None,
    rationale: str | None,
    outcome_entity: str | None,
    alternative_entities: list[str],
    status: str,
    event_time: datetime | None,
) -> DecisionTrace:
    """Create one decision trace, failing if its id already exists.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param title (str): trace title.
    @param steps (list[str]): ordered relation ids.
    @param id (str | None): explicit id, else derived.
    @param actor_entity (str | None): actor entity id.
    @param summary (str | None): summary.
    @param rationale (str | None): rationale.
    @param outcome_entity (str | None): outcome entity id.
    @param alternative_entities (list[str]): alternative entity ids.
    @param status (str): status.
    @param event_time (datetime | None): valid time.
    @return (DecisionTrace): the created trace.
    """
    _require_text("decision title", title)
    if actor_entity is not None:
        _require_text("decision actor_entity", actor_entity)
    _validate_own_id("decision", id)
    return await upsert_trace(
        runner,
        ns,
        tid=id,
        title=title,
        step_rel_ids=steps,
        actor_entity=actor_entity,
        summary=summary,
        rationale=rationale,
        outcome_entity=outcome_entity,
        alternative_entities=alternative_entities,
        status=status,
        event_time=event_time,
        created_at=now(),
        create=True,
    )


async def update_trace(runner: Any, ns: str, tid: str, *, clear: Iterable[str] = (), **fields: Any) -> DecisionTrace:
    """Update a decision trace, rewriting its structure; an omitted field keeps its value and None clears it.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @param clear (Iterable[str]): fields to clear: actor_entity, summary, rationale, outcome_entity, or event_time
        to None, alternative_entities or steps to [].
    @param fields (Any): fields to change.
    @return (DecisionTrace): the updated trace.
    """
    check_options("decisions.update", fields, _DECISION_UPDATE_FIELDS)
    for field in _require_clear("decisions.update", clear, DECISION_CLEARABLE, fields):
        fields[field] = [] if field in ("alternative_entities", "steps") else None
    require_changes(fields)
    await runner.lock_node(ns, L_TRACE, tid)
    existing = await get_trace(runner, ns, tid)
    if existing is None:
        raise NotFoundError("DecisionTrace", tid)
    return await upsert_trace(
        runner,
        ns,
        tid=tid,
        title=fields.get("title", existing.title),
        step_rel_ids=fields["steps"] if "steps" in fields else [s.relation_id for s in existing.steps],
        actor_entity=fields.get("actor_entity", existing.actor_entity),
        summary=fields.get("summary", existing.summary),
        rationale=fields.get("rationale", existing.rationale),
        outcome_entity=fields.get("outcome_entity", existing.outcome_entity),
        alternative_entities=fields.get("alternative_entities", existing.alternative_entities),
        status=fields.get("status", existing.status),
        event_time=fields.get("event_time", existing.event_time),
        created_at=now(),
    )


async def list_traces(
    runner: Any,
    ns: str,
    *,
    actor_entity: str | None,
    status: str | None,
    skip: int,
    limit: int,
    after: str | None = None,
) -> list[DecisionTrace]:
    """List decision traces, optionally filtered by actor and status.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param actor_entity (str | None): actor filter.
    @param status (str | None): status filter.
    @param skip (int): rows to skip.
    @param limit (int): maximum rows.
    @param after (str | None): list only traces whose id sorts after this one, for keyset paging.
    @return (list[DecisionTrace]): the traces.
    """
    _require_optional_text("actor_entity filter", actor_entity)
    _require_optional_text("status filter", status)
    equals: dict[str, Any] = {}
    if actor_entity is not None:
        equals["actor_entity"] = _ids._canonical_id(actor_entity)
    if status is not None:
        _require_choice("decision status", status, _STATUSES)
        equals["status"] = status
    rows = await runner.match_nodes(ns, L_TRACE, equals=equals, order_by="id", skip=skip, limit=limit, id_gt=after)
    return [decode_trace(props, await _read_steps(runner, ns, props["id"])) for props in rows]


async def delete_trace(runner: Any, ns: str, tid: str) -> dict[str, int]:
    """Delete a decision trace and its steps.

    @param runner (Any): graph runner.
    @param ns (str): namespace.
    @param tid (str): trace id.
    @return (dict[str, int]): counts of what was removed.
    """
    _ids._require_str("decision id", tid)
    if not await _delete_trace_quietly(runner, ns, tid):
        raise NotFoundError("DecisionTrace", tid)
    return {**_NO_DELETES, "deleted_decisions": 1}
