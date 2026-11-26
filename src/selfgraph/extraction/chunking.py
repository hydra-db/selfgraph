from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from .._ops import _require_int
from ..errors import ValidationError, error_reason

__all__ = ["Chunk", "chunk_text", "count_tokens"]

_log = logging.getLogger("selfgraph")

_ENCODER = None
_ENCODER_READY = False
_AS_SPACE = str.maketrans("\x85\ufeff", "  ")


def _encoder():
    """Return a cached tiktoken encoder, or None when tiktoken is not installed or cl100k_base fails to load.

    @return (object | None): the encoder, or None.
    """
    global _ENCODER, _ENCODER_READY
    if not _ENCODER_READY:
        _ENCODER_READY = True
        try:
            import tiktoken
        except ImportError:
            return None
        try:
            _ENCODER = tiktoken.get_encoding("cl100k_base")
        except Exception as exc:  # noqa: BLE001
            _log.warning(
                "tiktoken is installed but could not load cl100k_base (%s); token counts and chunks fall back to a "
                "length estimate; set TIKTOKEN_CACHE_DIR to a directory holding the cached encoding to run offline",
                error_reason(exc),
            )
    return _ENCODER


def count_tokens(text: str) -> int:
    """Count tokens with tiktoken when installed, falling back to a length estimate.

    @param text (str): the text to measure.
    @return (int): the token count.
    """
    enc = _encoder()
    if enc is None:
        return max(1, len(text) // 4)
    return len(_encode(enc, text))


def _encode(enc: Any, text: str) -> list[int]:
    """Encode text as ordinary text, so a special token such as <|endoftext|> in it is tokenized and not rejected.

    U+0085 and U+FEFF encode as spaces, since the regex engines of the two SDKs disagree on whether they are whitespace.

    @param enc (Any): the tiktoken encoder.
    @param text (str): the text to encode.
    @return (list[int]): the tokens.
    """
    return enc.encode(text.translate(_AS_SPACE), disallowed_special=())


def _char_bounds(enc: Any, tokens: list[int], text: str) -> list[int]:
    """Map each token boundary to a character offset in text, moving a boundary inside a character to its start.

    @param enc (Any): the tiktoken encoder.
    @param tokens (list[int]): the tokens of text.
    @param text (str): the encoded text.
    @return (list[int]): len(tokens) + 1 character offsets, the first 0 and the last len(text).
    """
    pieces = enc.decode_tokens_bytes(tokens)
    bounds = [0]
    chars = 0
    for piece, after in zip(pieces, pieces[1:], strict=False):
        chars += sum(1 for byte in piece if byte & 0xC0 != 0x80)
        bounds.append(chars - 1 if after and after[0] & 0xC0 == 0x80 else chars)
    bounds.append(len(text))
    return bounds


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

    tokens = _encode(enc, text)
    bounds = _char_bounds(enc, tokens, text)
    step = max_tokens - overlap_tokens
    chunks: list[Chunk] = []
    index = 0
    i = 0
    n = len(tokens)
    while i < n:
        start, end = bounds[i], bounds[min(i + max_tokens, n)]
        piece = text[start:end]
        if piece.strip():
            chunks.append(Chunk(index=index, text=piece, start_offset=start, end_offset=end))
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
    start = len(text) - len(text.lstrip())
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
