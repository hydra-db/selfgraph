# Install

SelfGraph needs Python 3.10 or newer.

```bash
pip install selfgraph
```

The core depends only on `pydantic` and the `neo4j` Bolt driver. BM25 seeding is
built in, so retrieval works on a bare install.

## Extras

Each extra pulls in the dependencies for one feature.

| Extra | Adds |
|-------|------|
| `llm` | Text extraction through any litellm provider. |
| `ner` | LLM-free extraction with spaCy. |
| `tokenizer` | Token-aware chunking and budgets through tiktoken. |
| `falkordb` | The FalkorDB backend. |
| `kuzu` | The embedded Kuzu backend. |
| `mcp` | The MCP server. |
| `all` | Everything above except `ner`. |

```bash
pip install "selfgraph[kuzu]"          # embedded backend, no server
pip install "selfgraph[llm]"           # LLM extraction
pip install "selfgraph[kuzu,ner]"      # LLM-free extraction on an embedded graph
pip install "selfgraph[all]"
```

The `ner` extra installs spaCy but not a model. Download one for the NER path to
run, otherwise extraction falls back to the regex heuristic:

```bash
python -m spacy download en_core_web_sm
```

## CLI and MCP

A bare install gives you the library and the `selfgraph` command. The MCP server
needs the `mcp` extra:

```bash
pip install "selfgraph[mcp]"
```

To run the command in its own isolated environment, use `pipx` or `uv`:

```bash
uv tool install selfgraph
pipx install selfgraph
```
