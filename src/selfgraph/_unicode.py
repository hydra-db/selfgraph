from __future__ import annotations

import re

from ._marks import char_class
from ._unicode_data import (
    CASE_IGNORABLE_RANGES,
    CASED_RANGES,
    DECIMAL_RANGES,
    FOLD_TABLE,
    LETTER_RANGES,
    LOWER_TABLE,
    NUMBER_RANGES,
    UPPER_TABLE,
)

LETTER_CLASS = char_class(LETTER_RANGES)
ALNUM_CLASS = LETTER_CLASS + char_class(NUMBER_RANGES)
WORD_CLASS = ALNUM_CLASS + "_"
DECIMAL_CLASS = char_class(DECIMAL_RANGES)

_CASED = re.compile(f"[{char_class(CASED_RANGES)}]")
_CASE_IGNORABLE = re.compile(f"[{char_class(CASE_IGNORABLE_RANGES)}]")


def _decode(table: str) -> dict[int, str]:
    """Expand a mapping table into a translation table from code point to replacement text.

    @param table (str): space-separated hexadecimal tokens, source[-last][/step]:target[.target], where a range maps
        each source to the target moved by the same distance.
    @return (dict[int, str]): the replacement text of each mapped code point.
    """
    mapping: dict[int, str] = {}
    for token in table.split():
        span, _, target = token.partition(":")
        span, _, step = span.partition("/")
        first, _, last = span.partition("-")
        stride = int(step or 1)
        for offset, cp in enumerate(range(int(first, 16), int(last or first, 16) + 1, stride)):
            mapping[cp] = "".join(chr(int(part, 16) + offset * stride) for part in target.split("."))
    return mapping


_LOWER = _decode(LOWER_TABLE)
_UPPER = _decode(UPPER_TABLE)
_FOLD = _decode(FOLD_TABLE)


def _final_sigma(text: str, index: int) -> bool:
    """Report whether the capital sigma at an index ends a word, so it lowercases to the final form.

    @param text (str): the text holding the sigma.
    @param index (int): the position of the sigma.
    @return (bool): True when a cased letter precedes it and none follows it, ignoring case-ignorable characters.
    """
    before = index - 1
    while before >= 0 and _CASE_IGNORABLE.match(text[before]):
        before -= 1
    if before < 0 or not _CASED.match(text[before]):
        return False
    after = index + 1
    while after < len(text) and _CASE_IGNORABLE.match(text[after]):
        after += 1
    return after == len(text) or not _CASED.match(text[after])


def lower(text: str) -> str:
    """Lowercase text with the Unicode 15.0 mappings, whatever Python version runs.

    @param text (str): the text to lowercase.
    @return (str): the lowercased text.
    """
    parts = text.split("Σ")
    pieces = [parts[0].translate(_LOWER)]
    offset = len(parts[0])
    for part in parts[1:]:
        pieces.append("ς" if _final_sigma(text, offset) else "σ")
        pieces.append(part.translate(_LOWER))
        offset += len(part) + 1
    return "".join(pieces)


def upper(text: str) -> str:
    """Uppercase text with the Unicode 15.0 mappings, whatever Python version runs.

    @param text (str): the text to uppercase.
    @return (str): the uppercased text.
    """
    return text.translate(_UPPER)


def casefold(text: str) -> str:
    """Casefold text with the Unicode 15.0 full folding, whatever Python version runs.

    @param text (str): the text to fold.
    @return (str): the casefolded text.
    """
    return text.translate(_FOLD)
