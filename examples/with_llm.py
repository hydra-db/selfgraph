import asyncio

from selfgraph import LLMConfig, Neo4jStore, SelfGraph


async def main() -> None:
    async with SelfGraph(
        store=Neo4jStore("bolt://localhost:7687", auth=("neo4j", "password")),
        llm=LLMConfig(provider="openai", model="gpt-4o-mini"),
    ) as graph:
        await graph.insert.text(
            "Acme acquired Beta Corp in 2021. Jane Doe led the deal.",
            source_id="press-release",
        )
        result = await graph.retrieve("who led the Acme acquisition", strategy="bfs", depth=3)
        print(result.context)


asyncio.run(main())
