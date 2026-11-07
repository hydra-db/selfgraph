# Errors

Every error SelfGraph raises is a `SelfGraphError`, so one except clause catches
them all.

```python
from selfgraph import SelfGraphError

try:
    await graph.entities.delete("person:missing")
except SelfGraphError as exc:
    print(exc)
```

## Hierarchy

| Exception | Raised when |
|-----------|-------------|
| `SelfGraphError` | Base class for every error below. |
| `ValidationError` | An argument or ontology fails validation. |
| `NotFoundError` | A required record does not exist. |
| `ConflictError` | A write conflicts with the current state. |
| `ExtractionError` | Text extraction fails, or an LLM dependency is missing. |
| `PromptTemplateError` | An extraction prompt template is malformed. |
| `StoreError` | The backend rejects a query or a connection fails. |
| `TransientError` | A `StoreError` from a write conflict on Neo4j or Memgraph that still failed after the SDK's retries; retry it. |

Catch the specific class when you want to handle one case, and `SelfGraphError`
when you want to handle all of them.

```python
from selfgraph import NotFoundError

try:
    await graph.relations.update("rel-id", set_properties={"title": "Chair"})
except NotFoundError:
    ...
```
