import pytest
from helpers import run

from selfgraph import KuzuStore
from selfgraph.errors import StoreError

pytest.importorskip("kuzu")

VALUES = [
    ("RETURN 9007199254740992 AS v", "9007199254740992"),
    ("RETURN 9007199254740993 AS v", "9007199254740993"),
    ("RETURN -9223372036854775808 AS v", "-9223372036854775808"),
    ("RETURN cast(18446744073709551615 AS UINT64) AS v", "18446744073709551615"),
    ("RETURN cast(12 AS INT128) AS v", 12),
    ("RETURN cast('1.50' AS DECIMAL(5,2)) AS v", 1.5),
    ("RETURN cast('0.0000001' AS DECIMAL(10,7)) AS v", 1e-07),
    ("RETURN cast('0.000000000000000000000000000000000001' AS DECIMAL(38,38)) AS v", 1e-36),
    ("RETURN timestamp('2024-01-01 12:34:56.789123') AS v", "2024-01-01T12:34:56.789123Z"),
    ("RETURN timestamp('1969-12-31 23:59:59.999999') AS v", "1969-12-31T23:59:59.999999Z"),
    ("RETURN cast('2024-01-01 12:34:56+05:30' AS TIMESTAMP_TZ) AS v", "2024-01-01T07:04:56Z"),
    ("RETURN cast('2024-01-01 12:34:56.789123456' AS TIMESTAMP_NS) AS v", "2024-01-01T12:34:56.789123Z"),
    ("RETURN interval('1 year 2 months 3 days 4 hours') AS v", "P423DT4H"),
    ("RETURN interval('1 day') AS v", "P1D"),
    ("RETURN interval('1500 milliseconds') AS v", "PT1.5S"),
    ("RETURN interval('1 microsecond') AS v", "PT0.000001S"),
    ("RETURN timestamp('2024-01-01') - timestamp('2024-01-02 00:00:01.5') AS v", "-P1DT1.5S"),
    ("RETURN union_value(a := 9007199254740993) AS v", "9007199254740993"),
    ("RETURN [1, 9007199254740993, NULL] AS v", [1, "9007199254740993", None]),
    (
        "RETURN {a: 9007199254740993, b: interval('1 day'), c: union_value(x := 's'), d: cast('1.50' AS DECIMAL(5,2))} AS v",
        {"a": "9007199254740993", "b": "P1D", "c": "s", "d": 1.5},
    ),
    ("RETURN map([1], [9007199254740993]) AS v", {"1": "9007199254740993"}),
    ("RETURN map([date('2024-01-02')], [interval('1 day')]) AS v", {"2024-01-02": "P1D"}),
    ("RETURN map([cast('0.0000001' AS DECIMAL(10,7))], [1]) AS v", {"0.0000001": 1}),
]


@pytest.fixture
def store(tmp_path):
    kuzu = KuzuStore(str(tmp_path / "values.kuzu"))
    yield kuzu
    run(kuzu.close())


@pytest.mark.parametrize(("query", "value"), VALUES, ids=[query[7:] for query, _ in VALUES])
def test_run_cypher_returns_the_value_exactly(store, query, value):
    rows = run(store.run_cypher(query)).rows
    assert rows == [{"v": value}]
    assert type(rows[0]["v"]) is type(value)


@pytest.mark.parametrize(
    "query",
    [
        "RETURN cast('-0.05' AS DECIMAL(5,2)) AS v",
        "RETURN cast('-0.001' AS DECIMAL(5,3)) AS v",
        "RETURN [cast('-0.05' AS DECIMAL(5,2))] AS v",
        "RETURN {a: cast('-0.05' AS DECIMAL(5,2))} AS v",
    ],
)
def test_run_cypher_refuses_a_negative_decimal_kuzu_cannot_return(store, query):
    with pytest.raises(StoreError) as raised:
        run(store.run_cypher(query))
    assert raised.value.code == "inexact_value"
    assert str(raised.value) == "Kuzu cannot return a negative DECIMAL between -0.1 and 0"


def test_prepared_queries_bind_new_values_and_release_old_connections(store, tmp_path):
    async def check():
        query = "RETURN $value AS value"
        for value in (1, 20, -3):
            assert (await store._run(query, {"value": value})).rows == [{"value": value}]
        first = store._conn
        store._statements = 500
        assert (await store._run(query, {"value": 4})).rows == [{"value": 4}]
        assert store._conn is not first
        assert store._plans_conn is store._conn
        second = KuzuStore(str(tmp_path / "values.kuzu"))
        try:
            plan = store._plans[query]
            await second.run_cypher("CREATE NODE TABLE CacheInvalidation(id INT64, PRIMARY KEY(id))")
            assert (await store._run(query, {"value": 5})).rows == [{"value": 5}]
            assert store._plans[query] is not plan
        finally:
            await second.close()
        await store.close()
        assert not store._plans

    run(check())


def test_prepared_query_retention_is_bounded(store):
    async def check():
        for index in range(80):
            result = await store._run(f"RETURN $value + {index} AS value", {"value": 2})
            assert result.rows == [{"value": index + 2}]
        assert len(store._plans) <= 64
        await store.run_cypher("RETURN 0 AS value")
        assert not store._plans

    run(check())
