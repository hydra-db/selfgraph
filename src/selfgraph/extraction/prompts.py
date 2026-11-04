from __future__ import annotations

from ..errors import PromptTemplateError
from ..models import ExtractionInstructions, ExtractionPrompts, PromptTemplate

__all__ = ["DEFAULT_PROMPTS", "render", "effective_prompt", "effective_instruction"]


_ENTITY_SYSTEM = (
    "You extract entities for a knowledge graph. An entity is a distinct real-world "
    "thing: a person, company, product, place, concept, or document. For each entity "
    "return a concise canonical name and a short Type (e.g. Person, Company, Product). "
    "Do not invent entities that are not supported by the text."
)
_ENTITY_USER = 'Extract every entity from the text below.\n{instructions}\n\nText:\n"""\n{text}\n"""'

_RELATION_SYSTEM = (
    "You extract directed relationships between entities for a knowledge graph. "
    "Use SCREAMING_SNAKE_CASE relationship types (e.g. WORKS_AT, FOUNDED, REQUIRES). "
    "Reference entities by the same names used in the text. Capture an event_time only "
    "when the text states when the relationship held. "
    "Connect entities directly to each other when the text relates them; do not route "
    "every relationship through one central entity, since a hub-and-spoke shape hides "
    "the connections between the others and makes the graph hard to traverse."
)
_RELATION_USER = (
    "Extract every relationship from the text below as (from, TYPE, to) triples.\n"
    '{instructions}\n\nText:\n"""\n{text}\n"""'
)

_PREFERENCE_SYSTEM = (
    "You extract preferences and disinterests from text. A preference records that a "
    "subject prefers (kind='preference') or avoids (kind='disinterest') a value entity, "
    "for some key (the dimension, e.g. 'database'). Only extract preferences that are "
    "explicitly supported by the text."
)
_PREFERENCE_USER = (
    'Extract every preference or disinterest from the text below.\n{instructions}\n\nText:\n"""\n{text}\n"""'
)

_DECISION_SYSTEM = (
    "You extract decision traces. A decision records that an actor decided something, "
    "the ordered relationships that justify it (as (from, TYPE, to) step triples), the "
    "outcome entity, the alternatives considered, and a short rationale. Only extract a "
    "decision when the text makes an explicit decision with a reason."
)
_DECISION_USER = (
    "Extract every decision from the text below, with its ordered justifying steps.\n"
    '{instructions}\n\nText:\n"""\n{text}\n"""'
)


DEFAULT_PROMPTS = ExtractionPrompts(
    entities=PromptTemplate(system=_ENTITY_SYSTEM, user=_ENTITY_USER, version="entities-v1"),
    relations=PromptTemplate(system=_RELATION_SYSTEM, user=_RELATION_USER, version="relations-v1"),
    preferences=PromptTemplate(system=_PREFERENCE_SYSTEM, user=_PREFERENCE_USER, version="preferences-v1"),
    decisions=PromptTemplate(system=_DECISION_SYSTEM, user=_DECISION_USER, version="decisions-v1"),
)


def effective_prompt(
    object_type: str,
    *,
    client_prompts: ExtractionPrompts | None,
    call_prompts: ExtractionPrompts | None,
) -> PromptTemplate:
    """Resolve the template for ``object_type``: per-call > client > default.

    @param object_type (str): the object type to resolve a template for.
    @param client_prompts (ExtractionPrompts | None): client-level overrides.
    @param call_prompts (ExtractionPrompts | None): per-call overrides.
    @return (PromptTemplate): the resolved template.
    """
    for source in (call_prompts, client_prompts, DEFAULT_PROMPTS):
        if source is None:
            continue
        template = getattr(source, object_type)
        if template is not None:
            return template
    raise PromptTemplateError(f"no prompt template for {object_type!r}")


def effective_instruction(
    object_type: str,
    *,
    client_instructions: ExtractionInstructions | None,
    call_instructions: ExtractionInstructions | None,
) -> str | None:
    """Per-call instructions replace client instructions for that call.

    @param object_type (str): the object type to resolve instructions for.
    @param client_instructions (ExtractionInstructions | None): client-level instructions.
    @param call_instructions (ExtractionInstructions | None): per-call instructions.
    @return (str | None): the resolved instruction text, if any.
    """
    for source in (call_instructions, client_instructions):
        if source is None:
            continue
        value = getattr(source, object_type)
        if value is not None:
            return value
    return None


def render(template: PromptTemplate, *, text: str, instructions: str | None) -> tuple[str, str]:
    """Render ``(system, user)``. Raises if ``{text}`` is missing.

    @param template (PromptTemplate): the template to render.
    @param text (str): the document text substituted for ``{text}``.
    @param instructions (str | None): extra instructions substituted or appended.
    @return (tuple[str, str]): the rendered ``(system, user)`` pair.
    """
    if "{text}" not in template.user:
        raise PromptTemplateError(f"prompt {template.version!r} is missing required variable {{text}}")
    extra = instructions or ""
    user = template.user.replace("{text}", text)
    if "{instructions}" in user:
        user = user.replace("{instructions}", extra)
    elif extra:
        user = f"{user}\n\nAdditional instructions:\n{extra}"
    return template.system, user
