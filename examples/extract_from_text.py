import asyncio

from selfgraph import KuzuStore, SelfGraph


async def main() -> None:
    async with SelfGraph(store=KuzuStore("extract.kuzu")) as graph:
        res = await graph.insert.text("Jane Doe founded Acme in London. Acme later acquired Beta Corp.")
        for warning in res.warnings:
            print("warning:", warning.message)
        print("entities:", [(e.type, e.name) for e in res.entities])
        print("relations:", [(r.from_entity, r.type, r.to_entity) for r in res.relations])


asyncio.run(main())
