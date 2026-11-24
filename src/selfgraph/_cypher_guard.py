from .errors import ValidationError

__all__ = ["blank_lexical_tokens", "check_cypher_limits"]

_LINE_TERMINATORS = frozenset("\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029")
_BLANK = "\x00"
_MAX_QUERY_BYTES = 65_536
_MAX_QUERY_DEPTH = 32
_OPENERS = {"(": ")", "[": "]", "{": "}"}


def blank_lexical_tokens(query: str) -> str:
    """Blank strings, quoted identifiers, and comments; leave an unterminated token visible.

    @param query (str): the raw Cypher statement.
    @return (str): the query with each lexical token replaced by one NUL character.
    """
    out: list[str] = []
    i, n = 0, len(query)
    while i < n:
        ch = query[i]
        if ch in "'\"":
            j = i + 1
            while j < n:
                if query[j] == "\\":
                    j += 2
                    continue
                if query[j] == ch:
                    j += 1
                    break
                j += 1
            else:
                break
            out.append(_BLANK)
            i = j
        elif ch == "`":
            j = i + 1
            while j < n:
                if query[j] == "`":
                    if j + 1 < n and query[j + 1] == "`":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            else:
                break
            out.append(_BLANK)
            i = j
        elif ch == "/" and i + 1 < n and query[i + 1] == "*":
            end = query.find("*/", i + 2)
            if end == -1:
                break
            out.append(_BLANK)
            i = end + 2
        elif ch == "/" and i + 1 < n and query[i + 1] == "/":
            j = i + 2
            while j < n and query[j] not in _LINE_TERMINATORS:
                j += 1
            out.append(_BLANK)
            i = j
        else:
            out.append(ch)
            i += 1
    if i < n:
        out.append(query[i:])
    return "".join(out)


def check_cypher_limits(query: str) -> None:
    """Reject queries over the raw Cypher size or delimiter nesting limit.

    @param query (str): the raw Cypher statement.
    @return (None): returns if the query is within both limits.
    """
    if len(query) > _MAX_QUERY_BYTES or len(query.encode("utf-8", errors="surrogatepass")) > _MAX_QUERY_BYTES:
        raise ValidationError(
            f"query exceeds the maximum length of {_MAX_QUERY_BYTES} UTF-8 bytes",
            code="cypher_query_limit",
            field="query",
        )
    closers: list[str] = []
    for char in blank_lexical_tokens(query):
        if char in _OPENERS:
            closers.append(_OPENERS[char])
            if len(closers) > _MAX_QUERY_DEPTH:
                raise ValidationError(
                    f"query exceeds the maximum nesting depth of {_MAX_QUERY_DEPTH}",
                    code="cypher_query_limit",
                    field="query",
                )
        elif closers and char == closers[-1]:
            closers.pop()
