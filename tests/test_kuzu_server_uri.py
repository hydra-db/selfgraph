import pytest

from selfgraph import KuzuStore
from selfgraph.errors import StoreError

pytest.importorskip("kuzu")


@pytest.mark.parametrize(
    ("uri", "store"),
    [
        ("bolt://u:hunter2@h:1", "Neo4jStore"),
        ("neo4j://h:1", "Neo4jStore"),
        ("memgraph://h:1", "Neo4jStore"),
        ("redis://h:1", "FalkorDBStore"),
        ("falkor://h:1", "FalkorDBStore"),
        ("falkors://h:1", "FalkorDBStore"),
        ("hydradb://h:1", "HydraDBStore"),
        ("https://u:hunter2@h:1", "a server store"),
    ],
)
def test_a_server_uri_is_refused_and_names_the_store_for_its_scheme(uri, store):
    with pytest.raises(StoreError) as raised:
        KuzuStore(uri)
    assert raised.value.code == "invalid_setting"
    assert raised.value.field == "uri"
    assert store in str(raised.value)
    assert "hunter2" not in str(raised.value)
