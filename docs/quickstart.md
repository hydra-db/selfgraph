# Quickstart

Build a graph, read an entity back, iterate a type, and retrieve context. This
uses the embedded Kuzu backend, so there is no server to start and no LLM to
configure.

```bash
pip install "selfgraph[kuzu]"
```

```python
import asyncio

from selfgraph import KuzuStore, SelfGraph


async def main() -> None:
    async with SelfGraph(store=KuzuStore("graph.kuzu")) as graph:
        await graph.insert.facts({
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

`SelfGraph(store=...)` takes a [backend](backends.md).

- `async with` initializes the store on entry and closes it on exit.
- Without `async with`, the store initializes on first use. Call
  `await graph.close()` yourself.
- `namespace=` (default `default`) keeps several graphs in one store.

`SyncSelfGraph` has the same API without `await`:

```python
from selfgraph import KuzuStore, SyncSelfGraph

with SyncSelfGraph(store=KuzuStore("graph.kuzu")) as graph:
    graph.entities.create("Acme", "Company", id="company:acme")
```

To build the store and LLM config from settings or environment variables, use
`SelfGraph.connect(store=..., uri=..., auth=...)` or `SelfGraph.from_env()`. See
[From settings](backends.md#from-settings).
