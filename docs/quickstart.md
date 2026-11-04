# Quickstart

This builds a graph, reads an entity back, iterates a type, and retrieves
context. It uses the embedded Kuzu backend, so there is no server to start and no
LLM to configure.

```bash
pip install "selfgraph[kuzu]"
```

```python
import asyncio

from selfgraph import KuzuStore, SelfGraph


async def main() -> None:
    async with SelfGraph(store=KuzuStore("graph.kuzu")) as graph:
        await graph.insert.ontology({
            "entities": [
                {"id": "person:jane", "type": "Person", "name": "Jane Doe"},
                {"id": "company:acme", "type": "Company", "name": "Acme"},
            ],
            "relations": [
                {"from_entity": "person:jane", "type": "WORKS_AT", "to_entity": "company:acme"},
            ],
        })

        jane = await graph.entities.get("person:jane")
        print(jane.name, jane.type)

        async for company in graph.entities.iterate(type="Company"):
            print(company.name)

        result = await graph.retrieve("who works at Acme")
        print(result.context)


asyncio.run(main())
```

## The graph object

`SelfGraph(store=...)` takes a backend and exposes the write and read API. The
first argument is always a store; see [Backends](backends.md).

`async with` initializes the store on entry and closes it on exit. The store also
initializes on first use, so a plain `SelfGraph(...)` works without the context
manager. Call `await graph.close()` when you are done with it.

The namespace defaults to `default`. Pass `namespace=` to isolate graphs in one
store:

```python
SelfGraph(store=KuzuStore("graph.kuzu"), namespace="tenant-1")
```

## Without async

`SyncSelfGraph` has the same API without `await`:

```python
from selfgraph import KuzuStore, SyncSelfGraph

with SyncSelfGraph(store=KuzuStore("graph.kuzu")) as graph:
    graph.entities.create("Acme", "Company", id="company:acme")
    for company in graph.entities.iterate(type="Company"):
        print(company.name)
```

## From the environment

`from_env` reads `SELFGRAPH_*` variables; `connect` takes the same settings as
keyword arguments. Both build the store and the LLM config for you.

```python
graph = SelfGraph.connect(store="neo4j", uri="bolt://localhost:7687", auth="neo4j:password")
```
