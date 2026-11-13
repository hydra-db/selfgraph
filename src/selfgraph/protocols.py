from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from typing import Protocol, TypeVar, runtime_checkable

from .models import CypherResult, JsonValue, Ontology, ParsedDocument

__all__ = ["LLMClient", "Extractor", "Embedder", "GraphStore"]

T = TypeVar("T")


@runtime_checkable
class LLMClient(Protocol):
    async def generate(self, *, system: str, user: str, output: type[T]) -> T:
        """Return structured output for one prompt.

        Extraction calls this once per pass for each chunk (entities, relations, preferences, decisions),
        each with a different output model, so the reply must match the model it is given; a mismatch raises
        ExtractionError naming the pass.

        @param system (str): the system prompt.
        @param user (str): the user prompt.
        @param output (type[T]): the pydantic model the reply must validate against, such as one with a
            "relations" list.
        @return (T): an instance of output, or a mapping that validates against it.
        """
        ...


@runtime_checkable
class Extractor(Protocol):
    async def extract(self, document: ParsedDocument) -> Ontology: ...


@runtime_checkable
class Embedder(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one vector per text, in order, all of one length.

        @param texts (list[str]): the texts to embed.
        @return (list[list[float]]): the vectors.
        """
        ...


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
