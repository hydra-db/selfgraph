# Install

SelfGraph needs Python 3.10 or newer. The core depends only on `pydantic` and the
`neo4j` Bolt driver, and gives you the library and the `selfgraph` command.

```bash
pip install selfgraph
uv tool install selfgraph   # or pipx, for the command in its own environment
```

`uv tool install` and `pipx install` install no extras unless you name them, so
add the ones your commands need:

```bash
uv tool install "selfgraph[llm,mcp,kuzu]"
pipx install "selfgraph[llm,mcp,kuzu]"
```

## Extras

| Extra | Adds | Needed for |
|-------|------|------------|
| `llm` | Text extraction through any litellm provider. | `insert text` with `--llm-*`, `--resolver llm`. |
| `ner` | LLM-free extraction with spaCy. | spaCy entity types without an LLM. |
| `tokenizer` | Token-aware chunking and budgets through tiktoken. | Exact token counts; without it, an estimate. |
| `falkordb` | The FalkorDB backend. | `--store falkordb`. |
| `kuzu` | The embedded Kuzu backend. | `--store kuzu`. |
| `mcp` | The MCP server. | `selfgraph mcp`. |
| `all` | Everything above. | All of the above. |

```bash
pip install "selfgraph[kuzu]"          # embedded backend, no server
pip install "selfgraph[kuzu,ner]"      # LLM-free extraction on an embedded graph
```

The `ner` extra installs spaCy but no model. Without one, extraction falls back
to the regex pass:

```bash
python -m spacy download en_core_web_sm
```

For TypeScript, `npm install @hydradb/selfgraph`; see [TypeScript](typescript.md)
for its optional packages.
