from __future__ import annotations

import re

__all__ = ["context_payload"]


def context_payload(text: str, *, source: bool = False) -> str:
    """Contain stored content before admitting it to an LLM prompt's SDK-owned structure.

    @param text (str): a source passage or assembled graph record, never its trust header.
    @param source (bool): preserve passage lines and label each as source data.
    @return (str): display-safe content with no unlabelled physical lines.
    """
    rendered = [
        "".join(
            f"\\u{ord(c):04x}"
            if (ord(c) < 32 and c != "\t")
            or 127 <= ord(c) <= 159
            or ord(c) in (0x061C, 0x200E, 0x200F)
            or 0x202A <= ord(c) <= 0x202E
            or 0x2066 <= ord(c) <= 0x2069
            else c
            for c in row
        )
        for row in re.split(r"\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]", text)
    ]
    return "\n".join("SOURCE | " + row for row in rendered) if source else "\\n".join(rendered)
