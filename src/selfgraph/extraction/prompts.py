from __future__ import annotations

import re

from .._serde import EDGE_TYPES
from ..errors import PromptTemplateError
from ..models import ExtractionInstructions, ExtractionPrompts, PromptTemplate

__all__ = ["DEFAULT_PROMPTS", "render", "check_prompts", "effective_prompt", "effective_instruction"]

_PLACEHOLDER = re.compile(r"\{(text|instructions)\}")
_ANY_PLACEHOLDER = re.compile(r"\{(\w+)\}")
_VARIABLES = ("text", "instructions")


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
    "the connections between the others and makes the graph hard to traverse. "
    f"Never use these reserved relationship types: {', '.join(sorted(EDGE_TYPES))}."
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
    "decision when the text makes an explicit decision with a reason. "
    "Step types use SCREAMING_SNAKE_CASE and never these reserved relationship types: "
    f"{', '.join(sorted(EDGE_TYPES))}. Put the alternatives considered in alternative_names "
    "and the chosen outcome in outcome_name, never as CONSIDERED or RESULTED_IN steps."
)
_DECISION_USER = (
    "Extract every decision from the text below, with its ordered justifying steps.\n"
    '{instructions}\n\nText:\n"""\n{text}\n"""'
)


DEFAULT_PROMPTS = ExtractionPrompts(
    entities=PromptTemplate(system=_ENTITY_SYSTEM, user=_ENTITY_USER, version="entities-v1"),
    relations=PromptTemplate(system=_RELATION_SYSTEM, user=_RELATION_USER, version="relations-v1"),
    preferences=PromptTemplate(system=_PREFERENCE_SYSTEM, user=_PREFERENCE_USER, version="preferences-v1"),
    decisions=PromptTemplate(system=_DECISION_SYSTEM, user=_DECISION_USER, version="decisions-v2"),
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
        template = None if source is None else getattr(source, object_type)
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
        value = None if source is None else getattr(source, object_type)
        if value is not None:
            return value
    return None


def check_template(template: PromptTemplate, name: str | None = None) -> None:
    """Reject a template whose user message lacks {text} or uses a placeholder other than {text} and {instructions}.

    @param template (PromptTemplate): the template to check.
    @param name (str | None): the prompt's key (entities, relations, ...) for the error, else its version.
    @return (None): nothing; raises PromptTemplateError on a bad template.
    """
    label = name or template.version
    if "{text}" not in template.user:
        raise PromptTemplateError(f"prompt {label!r} is missing required variable {{text}}")
    unknown = [v for v in dict.fromkeys(_ANY_PLACEHOLDER.findall(template.user)) if v not in _VARIABLES]
    if unknown:
        noun = "variable" if len(unknown) == 1 else "variables"
        allowed = ", ".join(f"{{{v}}}" for v in _VARIABLES)
        named = ", ".join(f"{{{v}}}" for v in unknown)
        raise PromptTemplateError(f"prompt {label!r} uses unknown {noun} {named}; allowed variables: {allowed}")


def check_prompts(prompts: ExtractionPrompts | None) -> None:
    """Check every template a prompts override sets, so a bad template fails when the graph or extractor is built.

    @param prompts (ExtractionPrompts | None): the overrides, or None.
    @return (None): nothing; raises PromptTemplateError on a bad template.
    """
    if prompts is None:
        return
    for name in type(prompts).model_fields:
        template = getattr(prompts, name)
        if template is not None:
            check_template(template, name)


def render(
    template: PromptTemplate, *, text: str, instructions: str | None, name: str | None = None
) -> tuple[str, str]:
    """Render ``(system, user)``. Raises if ``{text}`` is missing.

    @param template (PromptTemplate): the template to render.
    @param text (str): the document text substituted for ``{text}``.
    @param instructions (str | None): extra instructions substituted or appended.
    @param name (str | None): the prompt's key (entities, relations, ...) for the error, else its version.
    @return (tuple[str, str]): the rendered ``(system, user)`` pair.
    """
    check_template(template, name)
    extra = instructions or ""
    user = _PLACEHOLDER.sub(lambda m: text if m.group(1) == "text" else extra, template.user)
    if extra and "{instructions}" not in template.user:
        user = f"{user}\n\nAdditional instructions:\n{extra}"
    return template.system, user
