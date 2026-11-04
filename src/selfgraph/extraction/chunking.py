from __future__ import annotations

from dataclasses import dataclass

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


def chunk_text(text: str, *, max_tokens: int = 512, overlap_tokens: int = 64) -> list[Chunk]:
    """Split text into overlapping chunks sized by tokens, falling back to characters.

    @param text (str): the text to split.
    @param max_tokens (int): the maximum tokens per chunk.
    @param overlap_tokens (int): the token overlap between consecutive chunks.
    @return (list[Chunk]): the chunks, in order.
    """
    if max_tokens <= 0:
        raise ValueError("max_tokens must be positive")
    if not text.strip():
        return []
    overlap_tokens = max(0, min(overlap_tokens, max_tokens - 1))

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
    """Split text into overlapping chunks sized by characters, cutting on whitespace.

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
            window = text[start:end]
            cut = max(window.rfind(" "), window.rfind("\n"))
            if cut > size // 2:
                end = start + cut + 1
        piece = text[start:end]
        if piece.strip():
            chunks.append(Chunk(index=index, text=piece, start_offset=start, end_offset=end))
            index += 1
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return chunks
