import asyncio
import unicodedata

import pytest
from helpers import extracting_llm, make_store

from selfgraph import SelfGraph


def test_promoted_preference_key_uses_canonical_type():
    async def check():
        llm = extracting_llm([("Person", "Ann"), ("DB", "HydraDB")], [("Ann", "PREFERS", "HydraDB")])
        async with SelfGraph(
            make_store(),
            llm=llm,
            resolver="exact",
            schema={"entities": [{"name": "Person"}, {"name": "Database", "aliases": ["DB"]}]},
        ) as graph:
            first = await graph.insert.text("Ann likes HydraDB.")
            llm.responses.update(
                extracting_llm([("Person", "Ann"), ("Database", "HydraDB")], [("Ann", "PREFERS", "HydraDB")]).responses
            )
            second = await graph.insert.text("Ann likes HydraDB.")
            assert first.preferences[0].key == second.preferences[0].key == "database"
            assert first.preferences[0].id == second.preferences[0].id
            assert len((await graph.preferences.list()).items) == 1

    asyncio.run(check())


@pytest.mark.parametrize("name", ["μαΐου", "αΰπνία"])
@pytest.mark.parametrize("form", ["NFC", "NFD"])
@pytest.mark.parametrize("uppercase_stored", [False, True])
def test_retrieve_greek_casefold(name, form, uppercase_stored):
    async def check():
        stored = unicodedata.normalize(form, name.upper() if uppercase_stored else name)
        query = unicodedata.normalize(form, name if uppercase_stored else name.upper())
        async with SelfGraph(make_store()) as graph:
            entity = await graph.entities.create(stored, "Word")
            result = await graph.retrieve(query)
            assert [seed.id for seed in result.seeds] == [entity.id]

    asyncio.run(check())
