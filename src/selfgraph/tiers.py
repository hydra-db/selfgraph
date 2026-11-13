from __future__ import annotations

from typing import Literal, get_args

from .errors import ValidationError

__all__ = [
    "CEILINGS",
    "LADDERS",
    "LEVELS",
    "PRESETS",
    "ExtractionTier",
    "Level",
    "SeedTier",
    "clamp",
    "require_level",
    "require_tier",
]

Level = Literal["light", "balanced", "max"]
ExtractionTier = Literal["regex", "spacy", "llm"]
SeedTier = Literal["bm25", "synonyms", "embeddings"]

LEVELS: tuple[str, ...] = get_args(Level)

LADDERS: dict[str, tuple[str, ...]] = {
    "extraction": get_args(ExtractionTier),
    "resolution": ("exact", "default", "fuzzy", "llm"),
    "contradiction": ("off", "warn", "supersede", "llm"),
    "seeds": get_args(SeedTier),
    "traversal": ("bfs", "dfs", "ppr"),
}

PRESETS: dict[str, dict[str, str]] = {
    "light": {
        "extraction": "regex",
        "resolution": "exact",
        "contradiction": "warn",
        "seeds": "bm25",
        "traversal": "bfs",
    },
    "balanced": {
        "extraction": "spacy",
        "resolution": "default",
        "contradiction": "warn",
        "seeds": "synonyms",
        "traversal": "bfs",
    },
    "max": {
        "extraction": "llm",
        "resolution": "llm",
        "contradiction": "llm",
        "seeds": "embeddings",
        "traversal": "ppr",
    },
}

CEILINGS: dict[str, dict[str, str]] = {
    "light": {
        "extraction": "regex",
        "resolution": "exact",
        "contradiction": "supersede",
        "seeds": "bm25",
        "traversal": "ppr",
    },
    "balanced": {
        "extraction": "spacy",
        "resolution": "fuzzy",
        "contradiction": "supersede",
        "seeds": "synonyms",
        "traversal": "ppr",
    },
    "max": {name: ladder[-1] for name, ladder in LADDERS.items()},
}


def require_level(field: str, level: object) -> None:
    """Reject a level other than light, balanced, or max.

    @param field (str): the option name, for the error.
    @param level (object): the level.
    @return (None): nothing; raises ValidationError on anything else.
    """
    if level not in LEVELS:
        raise ValidationError(f"{field} must be one of {', '.join(LEVELS)}, got {level!r}")


def require_tier(capability: str, tier: object, field: str | None = None) -> None:
    """Reject a tier name that is not on a capability's ladder.

    @param capability (str): the ladder name.
    @param tier (object): the tier.
    @param field (str | None): the option name for the error, or None for the capability name.
    @return (None): nothing; raises ValidationError on anything else.
    """
    ladder = LADDERS[capability]
    if tier not in ladder:
        raise ValidationError(f"{field or capability} must be one of {', '.join(ladder)}, got {tier!r}")


def clamp(capability: str, tier: str, max_tier: str) -> str:
    """Lower a tier to the highest one a cost cap allows on its ladder.

    @param capability (str): the ladder name.
    @param tier (str): the requested tier.
    @param max_tier (str): the level whose ceiling caps the ladder.
    @return (str): the tier, or the ceiling when the tier is above it.
    """
    ladder = LADDERS[capability]
    ceiling = CEILINGS[max_tier][capability]
    return tier if ladder.index(tier) <= ladder.index(ceiling) else ceiling
