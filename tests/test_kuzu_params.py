import pytest
from helpers import run

from selfgraph import SelfGraph, SyncSelfGraph, ValidationError
from selfgraph.stores.kuzu import KuzuStore

pytest.importorskip("kuzu")


def test_empty_param_error_names_the_parameter_and_nested_path(tmp_path):
    g = SelfGraph(KuzuStore(str(tmp_path / "params.kuzu")))
    message = "parameter 'x' is an empty list, which Kuzu cannot type; pass a non-empty list"
    with pytest.raises(ValidationError) as raised:
        run(g.run_cypher("RETURN $x AS x", {"x": []}))
    assert (str(raised.value), raised.value.code, raised.value.field) == (message, "invalid_argument", "x")
    with pytest.raises(ValidationError) as raised:
        run(g.run_cypher("RETURN $x AS x", {"x": {"a": []}}))
    nested = "parameter 'x.a' is an empty list, which Kuzu cannot type; pass a non-empty list"
    assert (str(raised.value), raised.value.code, raised.value.field) == (nested, "invalid_argument", "x")
    with pytest.raises(ValidationError) as raised:
        run(g.run_cypher("RETURN $x AS x", {"x": {"a": {}}}))
    empty_map = "parameter 'x.a' is an empty map, which Kuzu cannot type; pass a non-empty map"
    assert (str(raised.value), raised.value.code, raised.value.field) == (empty_map, "invalid_argument", "x")


def test_nonempty_params_bind_and_a_list_of_empty_maps_is_rejected(tmp_path):
    g = SelfGraph(KuzuStore(str(tmp_path / "params-ok.kuzu")))
    assert run(g.run_cypher("RETURN $x AS x", {"x": [1]})).rows == [{"x": [1]}]
    assert run(g.run_cypher("RETURN $x AS x", {"x": {"a": 1}})).rows == [{"x": {"a": 1}}]
    with pytest.raises(ValidationError, match=r"^parameter 'x\[0\]' is an empty map, which Kuzu cannot type"):
        run(g.run_cypher("RETURN $x AS x", {"x": [{}]}))


def test_empty_param_rejects_through_the_sync_client(tmp_path):
    graph = SyncSelfGraph(KuzuStore(str(tmp_path / "params-sync.kuzu")))
    with pytest.raises(ValidationError, match=r"^parameter 'x' is an empty map, which Kuzu cannot type"):
        graph.run_cypher("RETURN $x AS x", {"x": {}})
    graph.close()
