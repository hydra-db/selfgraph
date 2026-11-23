"""Store constructors reject misspelled options with unknown_key."""

import pytest
from helpers import run

from selfgraph import SelfGraphError
from selfgraph.stores.cypher import CypherStore, Neo4jStore
from selfgraph.stores.hydradb import HydraDBStore
from selfgraph.stores.kuzu import KuzuStore


def test_kuzu_store_rejects_unknown_options(tmp_path):
    # The option check reads the allowed names from kuzu.Database, so without
    # the kuzu package there is nothing to validate against; the backends jobs
    # do not install it, and the missing-package error is the right answer there.
    pytest.importorskip("kuzu")
    with pytest.raises(SelfGraphError) as exc:
        KuzuStore(str(tmp_path / "g.kuzu"), buffer_pool=1)
    assert (exc.value.code, exc.value.to_dict()["field"]) == ("unknown_key", "buffer_pool")
    assert str(exc.value) == (
        "unknown option 'buffer_pool' for KuzuStore (valid options: buffer_pool_size, max_num_threads, "
        "compression, lazy_init, read_only, max_db_size, auto_checkpoint, checkpoint_threshold)"
    )
    assert not (tmp_path / "g.kuzu").exists()
    store = KuzuStore(str(tmp_path / "g.kuzu"), max_db_size=1 << 24)
    run(store.close())


@pytest.mark.parametrize("store_cls", [Neo4jStore, CypherStore, HydraDBStore])
def test_bolt_stores_reject_unknown_options(store_cls):
    with pytest.raises(SelfGraphError) as exc:
        store_cls("bolt://h:1", bogus=1)
    assert (exc.value.code, exc.value.to_dict()["field"]) == ("unknown_key", "bogus")
    assert str(exc.value) == f"unknown option 'bogus' for {store_cls.__name__}"
    store = store_cls("bolt://h:1", connection_timeout=5)
    run(store.close())
