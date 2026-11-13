from __future__ import annotations

import re
from collections.abc import Callable, Iterable

from .models import TermMatch
from .schema import Schema

__all__ = ["expand_tokens", "match_terms", "stem"]

Tokenize = Callable[[str], set[str]]


def stem(token: str) -> str:
    """Strip a plain plural ending so "customers" and "customer" compare equal.

    @param token (str): a casefolded token.
    @return (str): the token without a trailing plural s.
    """
    if token.endswith("ies") and len(token) > 4:
        return token[:-3] + "y"
    if token.endswith("s") and not token.endswith("ss") and len(token) > 3:
        return token[:-1]
    return token


def _spaced(name: str) -> str:
    """Put spaces at camel-case and underscore boundaries, so InvoiceLine and WORKS_AT read as words.

    @param name (str): the type name.
    @return (str): the name as space-separated words.
    """
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name).replace("_", " ")


def _forms(names: Iterable[str]) -> list[str]:
    """List the distinct surface forms of a term, each also split into words.

    @param names (Iterable[str]): the name, aliases, and synonyms.
    @return (list[str]): the forms, in order.
    """
    return list(dict.fromkeys(form for name in names for form in (name, _spaced(name))))


def match_terms(tokens: set[str], schema: Schema | None, tokenize: Tokenize) -> list[TermMatch]:
    """Find the schema terms a question names: a term matches when every word of one surface form is in the question.

    Entity types, relation types, and definitions are matched by name, alias, and synonym, ignoring case and a
    plain plural ending. A term is listed once, by the first form that matches.

    @param tokens (set[str]): the question's content tokens.
    @param schema (Schema | None): the schema, or None for no terms.
    @param tokenize (Tokenize): splits text into content tokens.
    @return (list[TermMatch]): the matched terms, in schema order.
    """
    if schema is None or not tokens:
        return []
    stems = {stem(t) for t in tokens}
    found: list[TermMatch] = []

    def consider(term: str, kind: str, names: Iterable[str], certified: bool) -> None:
        for form in _forms(names):
            words = {stem(t) for t in tokenize(form)}
            if words and words <= stems:
                hit = sorted(t for t in tokens if stem(t) in words)
                found.append(TermMatch(term=term, kind=kind, matched=form, tokens=hit, certified=certified))
                return

    for entity in schema.entities:
        consider(entity.name, "entity", [entity.name, *entity.aliases, *entity.synonyms], entity.certified)
        for definition in entity.definitions:
            consider(definition.name, "definition", [definition.name, *definition.synonyms], definition.certified)
    for relation in schema.relations:
        consider(relation.type, "relation", [relation.type, *relation.aliases, *relation.synonyms], relation.certified)
    return found


def expand_tokens(tokens: set[str], schema: Schema | None, tokenize: Tokenize) -> set[str]:
    """Add the words of each entity type a question names by alias or synonym, so seeding finds entities of that type.

    A definition adds the words of the entity type it belongs to.

    @param tokens (set[str]): the question's content tokens.
    @param schema (Schema | None): the schema, or None for no expansion.
    @param tokenize (Tokenize): splits text into content tokens.
    @return (set[str]): the tokens with the matched type names added.
    """
    if schema is None:
        return tokens
    owner = {d.name: e.name for e in schema.entities for d in e.definitions}
    out = set(tokens)
    for match in match_terms(tokens, schema, tokenize):
        if match.kind == "entity":
            out |= tokenize(match.term)
        elif match.kind == "definition":
            out |= tokenize(owner[match.term])
    return out
