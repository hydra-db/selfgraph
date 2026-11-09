from __future__ import annotations

from dataclasses import dataclass

from .._ops import _require_int
from ..errors import ValidationError

__all__ = ["Chunk", "chunk_text", "count_tokens"]

_ENCODER = None
_ENCODER_READY = False


def _encoder():
    """Return a cached tiktoken encoder, or None when tiktoken is unavailable.

    @return (object | None): the encoder, or None.
    """
    global _ENCODER, _ENCODER_READY
    if not _ENCODER_READY:
        _ENCODER_READY = True
        try:
            import tiktoken

            _ENCODER = tiktoken.get_encoding("cl100k_base")
        except Exception:  # noqa: BLE001  # pragma: no cover
            _ENCODER = None
    return _ENCODER


def count_tokens(text: str) -> int:
    """Count tokens with tiktoken when installed, falling back to a length estimate.

    @param text (str): the text to measure.
    @return (int): the token count.
    """
    enc = _encoder()
    if enc is None:
        return max(1, len(text) // 4)
    return len(enc.encode(text))


@dataclass(frozen=True)
class Chunk:
    index: int
    text: str
    start_offset: int
    end_offset: int


def _require_count(field: str, value: object, *, minimum: int) -> None:
    """Validate a chunking size is an integer no smaller than the minimum.

    @param field (str): the parameter name, for the message.
    @param value (object): the value to check.
    @param minimum (int): the smallest accepted value.
    @return (None): nothing; raises ValidationError on a non-integer or a value below the minimum.
    """
    _require_int(field, value)
    if value < minimum:
        raise ValidationError(f"{field} must be at least {minimum}, got {value}")


def chunk_text(text: str, *, max_tokens: int = 512, overlap_tokens: int | None = None) -> list[Chunk]:
    """Split text into overlapping chunks sized by tokens, falling back to characters cut on whitespace.

    @param text (str): the text to split.
    @param max_tokens (int): the maximum tokens per chunk, at least 1.
    @param overlap_tokens (int | None): the token overlap between consecutive chunks, from 0 to max_tokens - 1, or
        None for min(64, max_tokens // 4).
    @return (list[Chunk]): the chunks, in order.
    """
    _require_count("max_tokens", max_tokens, minimum=1)
    if overlap_tokens is None:
        overlap_tokens = min(64, max_tokens // 4)
    _require_count("overlap_tokens", overlap_tokens, minimum=0)
    if overlap_tokens >= max_tokens:
        raise ValidationError(f"overlap_tokens ({overlap_tokens}) must be smaller than max_tokens ({max_tokens})")
    if not text.strip():
        return []

    enc = _encoder()
    if enc is None:
        return _chunk_by_chars(text, size=max_tokens * 4, overlap=overlap_tokens * 4)

    tokens = enc.encode(text)
    step = max_tokens - overlap_tokens
    chunks: list[Chunk] = []
    index = 0
    i = 0
    n = len(tokens)
    while i < n:
        piece = enc.decode(tokens[i : i + max_tokens])
        start = len(enc.decode(tokens[:i]))
        if piece.strip():
            chunks.append(Chunk(index=index, text=piece, start_offset=start, end_offset=start + len(piece)))
            index += 1
        if i + max_tokens >= n:
            break
        i += step
    return chunks


def _chunk_by_chars(text: str, *, size: int, overlap: int) -> list[Chunk]:
    """Split text into overlapping chunks sized by characters, starting and ending each on a word boundary.

    A chunk ends at the last whitespace within its size, and the next one starts at the first word that begins
    inside the overlap; a single word longer than the size is cut.

    @param text (str): the text to split.
    @param size (int): the maximum characters per chunk.
    @param overlap (int): the character overlap between consecutive chunks.
    @return (list[Chunk]): the chunks, in order.
    """
    size = max(1, size)
    overlap = max(0, min(overlap, size - 1))
    chunks: list[Chunk] = []
    start = 0
    n = len(text)
    index = 0
    while start < n:
        end = min(start + size, n)
        if end < n:
            cut = end
            while cut > start and not text[cut].isspace():
                cut -= 1
            if cut > start:
                end = cut
        piece = text[start:end]
        if piece.strip():
            chunks.append(Chunk(index=index, text=piece, start_offset=start, end_offset=end))
            index += 1
        if end >= n:
            break
        nxt = max(end - overlap, start + 1)
        while nxt < end and not text[nxt - 1].isspace():
            nxt += 1
        while nxt < n and text[nxt].isspace():
            nxt += 1
        start = nxt
    return chunks
