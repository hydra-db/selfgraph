import asyncio

from selfgraph import KuzuStore, SelfGraph


async def main() -> None:
    async with SelfGraph(store=KuzuStore("quickstart.kuzu")) as graph:
        await graph.insert.ontology(
            {
                "entities": [
                    {"id": "person:jane", "type": "Person", "name": "Jane Doe"},
                    {"id": "company:acme", "type": "Company", "name": "Acme"},
                    {"id": "company:beta", "type": "Company", "name": "Beta Corp"},
                ],
                "relations": [
                    {
                        "from_entity": "person:jane",
                        "type": "WORKS_AT",
                        "to_entity": "company:acme",
                        "properties": {"title": "CEO"},
                    },
                    {"from_entity": "company:acme", "type": "ACQUIRED", "to_entity": "company:beta"},
                ],
            }
        )

        jane = await graph.entities.get("person:jane")
        print("entity:", jane.name, jane.type)

        print("companies:")
        async for company in graph.entities.iterate(type="Company"):
            print(" -", company.name)

        result = await graph.retrieve("who runs Acme and what did they acquire")
        print("\ncontext:\n", result.context)


asyncio.run(main())
