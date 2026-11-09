# Install

SelfGraph needs Python 3.10 or newer. The core gives you the library and the
`selfgraph` command, and depends only on `pydantic` and the `neo4j` Bolt driver.

```bash
pip install selfgraph
```

To install the command in its own environment, use `uv tool` or `pipx`. Neither
installs extras unless you name them:

```bash
uv tool install "selfgraph[llm,mcp,kuzu]"
pipx install "selfgraph[llm,mcp,kuzu]"
```

## Extras

| Extra | Adds | Needed for |
|-------|------|------------|
| `llm` | Text extraction through any litellm provider. | `insert text` with `--llm-*`, `--resolver llm`. |
| `ner` | LLM-free extraction with spaCy. | spaCy entity types without an LLM. |
| `tokenizer` | Token-aware chunking and budgets through tiktoken. | Exact token counts. Without it, counts are estimated. |
| `falkordb` | The FalkorDB backend. | `--store falkordb`. |
| `kuzu` | The embedded Kuzu backend. | `--store kuzu`, and the default store. |
| `mcp` | The MCP server. | `selfgraph mcp`. |
| `all` | Everything above. | All of the above. |

```bash
pip install "selfgraph[kuzu]"          # embedded backend, no server
pip install "selfgraph[kuzu,ner]"      # LLM-free extraction on an embedded graph
```

The `ner` extra installs spaCy but no model. Without a model, extraction falls
back to the regex pass. Install one:

```bash
python -m spacy download en_core_web_sm
```

For TypeScript, run `npm install @hydradb/selfgraph`. See
[TypeScript](typescript.md#install) for its optional packages.
