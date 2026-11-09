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

`SelfGraph(store=...)` takes a [backend](backends.md). `async with` initializes
the store on entry and closes it on exit; without it, the store initializes on
first use and you call `await graph.close()` yourself. Pass `namespace=` (default
`default`) to keep several graphs in one store.

`SyncSelfGraph` has the same API without `await`:

```python
from selfgraph import KuzuStore, SyncSelfGraph

with SyncSelfGraph(store=KuzuStore("graph.kuzu")) as graph:
    graph.entities.create("Acme", "Company", id="company:acme")
```

`SelfGraph.connect(store=..., uri=..., auth=...)` and `SelfGraph.from_env()` build
the store and LLM config from settings; see [From settings](backends.md#from-settings).
