from __future__ import annotations

import base64
import binascii
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TypeVar

from .._ops import _require_int
from ..errors import ValidationError
from ..models import Page

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


def page_offset(cursor: str | None, limit: int) -> int:
    """Validate a page limit and resolve the cursor to its start offset.

    @param cursor (str | None): the opaque cursor from a previous page, or None to start.
    @param limit (int): the requested page size.
    @return (int): the offset to resume from.
    """
    _require_int("limit", limit)
    if limit < 1:
        raise ValidationError(f"limit must be >= 1, got {limit}")
    if limit > _MAX_LIMIT:
        raise ValidationError(f"limit must be <= {_MAX_LIMIT}, got {limit}")
    return decode_cursor(cursor)


def make_page(rows: list[T], offset: int, limit: int) -> Page[T]:
    """Build a page from ``limit + 1`` fetched rows.

    @param rows (list[T]): fetched rows; the extra row (if present) signals a next
        page without a second query and is dropped from the returned items.
    @param offset (int): the current offset.
    @param limit (int): the page size.
    @return (Page[T]): the page of items with its next cursor.
    """
    has_more = len(rows) > limit
    items = rows[:limit]
    next_cursor = encode_cursor(offset + limit) if has_more else None
    return Page(items=items, next_cursor=next_cursor)
