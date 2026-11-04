from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TypeVar

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


def decode_cursor(cursor: str | None) -> int:
    """Decode an opaque cursor into its next offset.

    @param cursor (str | None): the opaque cursor; just the next offset as text.
    @return (int): the offset to resume from.
    """
    if not cursor:
        return 0
    try:
        value = int(cursor)
    except (TypeError, ValueError):
        return 0
    return max(value, 0)


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
    next_cursor = str(offset + limit) if has_more else None
    return Page(items=items, next_cursor=next_cursor)
