from __future__ import annotations

import base64
import binascii
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any, TypeVar

from .._ops import _require_int
from ..errors import ValidationError
from ..ids import _has_control
from ..models import Page

if TYPE_CHECKING:
    from ..client import SelfGraph

T = TypeVar("T")


async def paginate(list_fn: Callable[..., Awaitable[Page[T]]], **filters) -> AsyncIterator[T]:
    """Yield every item across pages by following the list cursor.

    @param list_fn (Callable[..., Awaitable[Page[T]]]): a resource list method.
    @param filters: filter and limit keyword arguments forwarded to list_fn.
    @return (AsyncIterator[T]): every matching item across all pages.
    """
    cursor = None
    while True:
        page = await list_fn(cursor=cursor, **filters)
        for item in page.items:
            yield item
        if page.next_cursor is None:
            return
        cursor = page.next_cursor


_MAX_OFFSET = 2**31


def encode_cursor(position: int | str) -> str:
    """Encode an offset, or the last id a keyset page returned, as an opaque cursor.

    @param position (int | str): the next offset or the last id seen.
    @return (str): the opaque cursor.
    """
    return base64.urlsafe_b64encode(str(position).encode("utf-8")).decode("ascii")


def _cursor_text(cursor: str | None, valid: Callable[[str], bool]) -> str | None:
    """Decode a cursor's text, requiring the exact encoding encode_cursor writes and a position valid accepts.

    @param cursor (str | None): the opaque cursor from a previous page, or None to start.
    @param valid (Callable[[str], bool]): whether the decoded text is a position this list pages by.
    @return (str | None): the encoded position, or None to start.
    """
    if cursor is None:
        return None
    if not isinstance(cursor, str):
        raise ValidationError(f"cursor must be a string, got {type(cursor).__name__}")
    try:
        text = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
    except (ValueError, binascii.Error):
        raise ValidationError(f"invalid cursor {cursor!r}") from None
    if not text or encode_cursor(text) != cursor or not valid(text):
        raise ValidationError(f"invalid cursor {cursor!r}")
    return text


def decode_cursor(cursor: str | None) -> int:
    """Decode an opaque cursor into its next offset.

    @param cursor (str | None): the opaque cursor from a previous page, or None to start.
    @return (int): the offset to resume from.
    """
    text = _cursor_text(cursor, lambda t: t.isascii() and t.isdecimal() and str(int(t)) == t and int(t) < _MAX_OFFSET)
    return 0 if text is None else int(text)


def decode_key_cursor(cursor: str | None, kind: str) -> str | None:
    """Decode an opaque keyset cursor into the last id the previous page returned.

    @param cursor (str | None): the opaque cursor from a previous page, or None to start.
    @param kind (str): the id kind the list pages by; entity accepts any 'type:name' id, others need their own prefix.
    @return (str | None): the id to resume after, or None to start.
    """

    def valid(text: str) -> bool:
        prefix, colon, name = text.partition(":")
        return bool(
            colon
            and prefix.strip()
            and name.strip()
            and not _has_control(text)
            and (kind == "entity" or prefix.lower() == kind)
        )

    return _cursor_text(cursor, valid)


_MAX_LIMIT = 1000
DEFAULT_PAGE_LIMIT = 50


class Resource:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def _page(
        self,
        op: Callable[..., Awaitable[list[T]]],
        *args: Any,
        cursor: str | None,
        limit: int,
        by_id: str | None = None,
        **filters: Any,
    ) -> Page[T]:
        """Fetch one page: validate the limit and cursor, read limit + 1 rows, and set the next cursor.

        A keyset page resumes after the last id the previous page returned, so deletes and inserts between pages
        neither skip nor repeat an item; an offset page resumes at a row count.

        @param op (Callable[..., Awaitable[list[T]]]): the _ops list read, called as op(reader, namespace, *args, ...).
        @param args (Any): positional arguments after the namespace.
        @param cursor (str | None): the opaque cursor from a previous page, or None to start.
        @param limit (int): the page size.
        @param by_id (str | None): the id kind to page by id (op takes after), or None to page by offset.
        @param filters (Any): filter keyword arguments forwarded to op.
        @return (Page[T]): the page; the extra row only signals a next page.
        """
        _require_int("limit", limit)
        if limit < 1:
            raise ValidationError(f"limit must be >= 1, got {limit}")
        if limit > _MAX_LIMIT:
            raise ValidationError(f"limit must be <= {_MAX_LIMIT}, got {limit}")
        reader, ns = await self._c._reader(), self._c.namespace
        if by_id is not None:
            after = decode_key_cursor(cursor, by_id)
            rows = await op(reader, ns, *args, skip=0, limit=limit + 1, after=after, **filters)
            next_cursor = encode_cursor(rows[limit - 1].id) if len(rows) > limit else None
        else:
            offset = decode_cursor(cursor)
            rows = await op(reader, ns, *args, skip=offset, limit=limit + 1, **filters)
            next_cursor = encode_cursor(offset + limit) if len(rows) > limit else None
        return Page(items=rows[:limit], next_cursor=next_cursor)
