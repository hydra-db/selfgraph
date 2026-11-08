from __future__ import annotations

import base64
import binascii
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any, TypeVar

from .._ops import _require_int
from ..errors import ValidationError
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


def encode_cursor(offset: int) -> str:
    """Encode an offset as an opaque cursor.

    @param offset (int): the next offset.
    @return (str): the opaque cursor.
    """
    return base64.urlsafe_b64encode(str(offset).encode("ascii")).decode("ascii")


def decode_cursor(cursor: str | None) -> int:
    """Decode an opaque cursor into its next offset.

    @param cursor (str | None): the opaque cursor from a previous page, or None to start.
    @return (int): the offset to resume from.
    """
    if cursor is not None and not isinstance(cursor, str):
        raise ValidationError(f"cursor must be a string, got {type(cursor).__name__}")
    if not cursor:
        return 0
    try:
        value = int(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except (ValueError, binascii.Error):
        raise ValidationError(f"invalid cursor {cursor!r}") from None
    if value < 0 or value >= _MAX_OFFSET:
        raise ValidationError(f"invalid cursor {cursor!r}")
    return value


_MAX_LIMIT = 1000
DEFAULT_PAGE_LIMIT = 50


class Resource:
    def __init__(self, client: SelfGraph) -> None:
        self._c = client

    async def _page(
        self, op: Callable[..., Awaitable[list[T]]], *args: Any, cursor: str | None, limit: int, **filters: Any
    ) -> Page[T]:
        """Fetch one page: validate the limit and cursor, read limit + 1 rows, and set the next cursor.

        @param op (Callable[..., Awaitable[list[T]]]): the _ops list read, called as op(reader, namespace, *args, ...).
        @param args (Any): positional arguments after the namespace.
        @param cursor (str | None): the opaque cursor from a previous page, or None to start.
        @param limit (int): the page size.
        @param filters (Any): filter keyword arguments forwarded to op.
        @return (Page[T]): the page; the extra row only signals a next page.
        """
        _require_int("limit", limit)
        if limit < 1:
            raise ValidationError(f"limit must be >= 1, got {limit}")
        if limit > _MAX_LIMIT:
            raise ValidationError(f"limit must be <= {_MAX_LIMIT}, got {limit}")
        offset = decode_cursor(cursor)
        rows = await op(await self._c._reader(), self._c.namespace, *args, skip=offset, limit=limit + 1, **filters)
        next_cursor = encode_cursor(offset + limit) if len(rows) > limit else None
        return Page(items=rows[:limit], next_cursor=next_cursor)
