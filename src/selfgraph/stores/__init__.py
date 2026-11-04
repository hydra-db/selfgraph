from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .cypher import CypherStore, Neo4jStore
    from .falkordb import FalkorDBStore
    from .hydradb import HydraDBStore
    from .kuzu import KuzuStore

__all__ = ["CypherStore", "Neo4jStore", "FalkorDBStore", "HydraDBStore", "KuzuStore"]

_LAZY = {
    "CypherStore": ("selfgraph.stores.cypher", "CypherStore"),
    "Neo4jStore": ("selfgraph.stores.cypher", "Neo4jStore"),
    "FalkorDBStore": ("selfgraph.stores.falkordb", "FalkorDBStore"),
    "HydraDBStore": ("selfgraph.stores.hydradb", "HydraDBStore"),
    "KuzuStore": ("selfgraph.stores.kuzu", "KuzuStore"),
}


def __getattr__(name: str):
    if name in _LAZY:
        import importlib

        module_name, attr = _LAZY[name]
        return getattr(importlib.import_module(module_name), attr)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
