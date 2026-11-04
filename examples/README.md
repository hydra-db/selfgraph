# Examples

Runnable scripts. The Kuzu examples need no server.

| Script | What it shows | Run |
|--------|---------------|-----|
| `quickstart.py` | `insert.ontology`, iterate, retrieve. No LLM, no server. | `pip install "selfgraph[kuzu]" && python quickstart.py` |
| `extract_from_text.py` | Text to graph via spaCy NER, no LLM. | `pip install "selfgraph[kuzu,ner]" && python -m spacy download en_core_web_sm && python extract_from_text.py` |
| `sync_quickstart.py` | The same API without async, via `SyncSelfGraph`. | `pip install "selfgraph[kuzu]" && python sync_quickstart.py` |
| `with_llm.py` | LLM extraction and retrieval against a Bolt backend. | `pip install "selfgraph[llm]" && python with_llm.py` |
