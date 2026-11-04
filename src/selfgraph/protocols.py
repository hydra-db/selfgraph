from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from typing import Protocol, TypeVar, runtime_checkable

from .models import CypherResult, JsonValue, Ontology, ParsedDocument

__all__ = ["LLMClient", "Extractor", "GraphStore"]

T = TypeVar("T")


@runtime_checkable
class LLMClient(Protocol):
    async def generate(self, *, system: str, user: str, output: type[T]) -> T: ...


@runtime_checkable
class Extractor(Protocol):
    async def extract(self, document: ParsedDocument) -> Ontology: ...


@runtime_checkable
class GraphStore(Protocol):
    async def initialize(self) -> None:
        """Create the ID constraints and any indexes the store needs."""
        ...

    async def run_cypher(self, query: str, params: Mapping[str, JsonValue] | None = None) -> CypherResult:
        """Run a single Cypher statement and return its rows.

        @param query (str): the Cypher statement to run.
        @param params (Mapping[str, JsonValue] | None): query parameters.
        @return (CypherResult): the resulting rows.
        """
        ...

    def transaction(self) -> AbstractAsyncContextManager["GraphStore"]:
        """Group writes so an insert or relation update is all-or-nothing.

        @return (AbstractAsyncContextManager["GraphStore"]): a context manager
            whose ``run_cypher`` joins the transaction; it commits on clean exit
            and rolls back if the block raises.
        """
        ...
