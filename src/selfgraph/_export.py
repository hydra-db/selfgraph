from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Any

from ._serde import _dumps
from .errors import ValidationError
from .ids import normalize_rel_type
from .models import DecisionTrace, Entity, Preference, Relation

if TYPE_CHECKING:
    from .schema import Schema

_log = logging.getLogger("selfgraph")

OSSIE_VERSION = "0.3.0.dev0"
_OSSIE_TYPES = {
    "string": "String",
    "integer": "Integer",
    "float": "Float",
    "boolean": "Boolean",
    "datetime": "DateTime",
    "json": "String",
}
_UNSAFE = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f]')


def _left_out(kind: str, name: str, fields: dict[str, Any]) -> None:
    """Log the set fields of a schema term that an Ossie document has no place for.

    @param kind (str): the term's kind, such as "entity type".
    @param name (str): the term's name.
    @param fields (dict[str, Any]): each field's description with its value; only set ones are logged.
    @return (None): nothing.
    """
    lost = [field for field, value in fields.items() if value]
    if lost:
        _log.warning("ossie export: the %s of %s %s are left out", ", ".join(lost), kind, name)


def to_ossie(schema: Schema) -> dict[str, Any]:
    """Render a schema as an Apache Ossie ontology document (spec 0.3.0.dev0).

    Each entity type becomes an EntityType concept that extends its parent. Each property becomes a ManyToOne
    relationship to the matching built-in value type. Each relation type becomes a relationship under every one of
    its from types, one per to type (Any when it lists none), named by its type plus the to type when there are
    several; it is ManyToOne when from max_count is 1 and OneToOne when to max_count is 1 too. A relation type with
    no from types is left out, as Ossie declares a relationship under a concept. Relation properties, aliases,
    synonyms, definitions, mappings, certified flags, required flags, and min counts have no Ossie form and are left
    out too; each omission is logged.

    @param schema (Schema): the schema.
    @return (dict[str, Any]): the Ossie document; JSON is valid YAML, so it can be written as either.
    """
    if not schema.entities:
        raise ValidationError("an Ossie ontology needs at least one concept; the schema declares no entity types")
    concepts: dict[str, dict[str, Any]] = {}
    for entity in schema.entities:
        concept: dict[str, Any] = {"concept": entity.name, "type": "EntityType"}
        if entity.description:
            concept["description"] = entity.description
        if entity.parent:
            concept["extends"] = [entity.parent]
        concept["relationships"] = [
            {
                "name": prop.name,
                **({"description": prop.description} if prop.description else {}),
                "roles": [{"concept": _OSSIE_TYPES[prop.type]}],
                "multiplicity": "ManyToOne",
                "verbalizes": [f"{{{entity.name}}} has {prop.name} {{{_OSSIE_TYPES[prop.type]}}}"],
            }
            for prop in entity.properties
        ]
        concepts[entity.name] = concept
        _left_out(
            "entity type",
            entity.name,
            {
                "aliases": entity.aliases,
                "synonyms": entity.synonyms,
                "mappings": entity.mappings,
                "definitions": entity.definitions,
                "certified flag": entity.certified,
                "required flags": any(p.required for p in entity.properties),
            },
        )
    for relation in schema.relations:
        rtype = normalize_rel_type(relation.type)
        if not relation.from_.types:
            _log.warning("ossie export: relation %s has no from types, so it is left out", rtype)
            continue
        _left_out(
            "relation",
            rtype,
            {
                "properties": relation.properties,
                "aliases": relation.aliases,
                "synonyms": relation.synonyms,
                "certified flag": relation.certified,
                "min counts": relation.from_.min_count is not None or relation.to.min_count is not None,
            },
        )
        words = rtype.lower().replace("_", " ")
        targets = relation.to.types or ["Any"]
        multiplicity = {}
        if relation.from_.max_count == 1:
            multiplicity = {"multiplicity": "OneToOne" if relation.to.max_count == 1 else "ManyToOne"}
        for source in relation.from_.types:
            for target in targets:
                role: dict[str, str] = {"concept": target}
                placeholder = target
                if target == source:
                    role["name"] = "other"
                    placeholder = f"{target}:other"
                concepts.setdefault(source, {"concept": source, "type": "EntityType", "relationships": []})
                concepts[source]["relationships"].append(
                    {
                        "name": rtype if len(targets) == 1 else f"{rtype}_{target}",
                        **({"description": relation.description} if relation.description else {}),
                        "roles": [role],
                        **multiplicity,
                        "verbalizes": [f"{{{source}}} {words} {{{placeholder}}}"],
                    }
                )
    ontology = []
    for concept in concepts.values():
        if not concept["relationships"]:
            del concept["relationships"]
        ontology.append(concept)
    return {"version": OSSIE_VERSION, "name": schema.name or "selfgraph", "ontology": ontology}


def _stem(text: str) -> str:
    """Make a note file name from text, replacing the characters file systems or Obsidian links reject.

    @param text (str): the name.
    @return (str): the file name without extension, or "" when nothing usable is left.
    """
    return _UNSAFE.sub("-", text).strip().strip(".").strip()


def _claim(options: list[str], taken: set[str]) -> str:
    """Pick the first file name not taken yet, ignoring case, numbering the last option when all are taken.

    @param options (list[str]): the candidate file names, best first.
    @param taken (set[str]): the casefolded names already used, updated in place.
    @return (str): the chosen file name.
    """
    stem = next((s for s in options if s and s.casefold() not in taken), None)
    n = 2
    while stem is None:
        candidate = f"{options[-1] or 'note'} {n}"
        stem = None if candidate.casefold() in taken else candidate
        n += 1
    taken.add(stem.casefold())
    return stem


def _props(properties: dict[str, Any]) -> str:
    """Format properties as one JSON object, or nothing when there are none.

    @param properties (dict[str, Any]): the properties.
    @return (str): " " plus the JSON object, or "".
    """
    return f" {_dumps(properties)}" if properties else ""


def obsidian_vault(
    entities: list[Entity],
    relations: list[Relation],
    preferences: list[Preference],
    decisions: list[DecisionTrace],
) -> dict[str, str]:
    """Render a graph as an Obsidian vault: one Markdown note per entity and one per decision.

    An entity note is named after the entity, then after its name and type, then its id, when names collide
    ignoring case; it has the id, type, and aliases as front matter, then its properties, its outgoing relations and
    preferences as wiki links, and its decisions. Obsidian derives backlinks, so incoming links are not repeated.
    Decision notes go in decisions/. Values are written as JSON, which is valid YAML.

    @param entities (list[Entity]): the entities, in id order.
    @param relations (list[Relation]): the current relations.
    @param preferences (list[Preference]): the current preferences.
    @param decisions (list[DecisionTrace]): the decisions.
    @return (dict[str, str]): each note's path relative to the vault, with its Markdown.
    """
    taken: set[str] = set()
    stems = {
        e.id: _claim([_stem(e.name), _stem(f"{e.name} ({e.type})"), _stem(e.id)], taken)
        for e in sorted(entities, key=lambda e: e.id)
    }

    def link(eid: str) -> str:
        return f"[[{stems[eid]}]]" if eid in stems else eid

    outgoing: dict[str, list[str]] = {}
    for r in sorted(relations, key=lambda r: (r.from_entity, r.type, r.to_entity, r.id)):
        line = f"- {r.type} {link(r.to_entity)}{_props(r.properties)}"
        outgoing.setdefault(r.from_entity, []).append(line)
    for p in sorted(preferences, key=lambda p: (p.subject_entity, p.key, p.id)):
        verb = "prefers" if p.stance == "preference" else "avoids"
        strength = "" if p.strength is None else f" (strength {p.strength})"
        line = f"- {verb} {link(p.value_entity)} for {p.key}{strength}"
        outgoing.setdefault(p.subject_entity, []).append(line)
    taken = set()
    decision_stems = {d.id: _claim([_stem(d.title), _stem(d.id)], taken) for d in sorted(decisions, key=lambda d: d.id)}
    made: dict[str, list[str]] = {}
    for d in decisions:
        if d.actor_entity:
            made.setdefault(d.actor_entity, []).append(f"- [[decisions/{decision_stems[d.id]}]]")
    vault: dict[str, str] = {}
    for e in sorted(entities, key=lambda e: e.id):
        lines = ["---", f"id: {_dumps(e.id)}", f"type: {_dumps(e.type)}"]
        if e.aliases:
            lines.append(f"aliases: {_dumps(e.aliases)}")
        lines += ["---", f"# {e.name}"]
        for title, body in (
            ("Properties", [f"- {k}: {_dumps(v)}" for k, v in sorted(e.properties.items())]),
            ("Links", outgoing.get(e.id, [])),
            ("Decisions", sorted(made.get(e.id, []))),
        ):
            if body:
                lines += ["", f"## {title}", *body]
        vault[f"{stems[e.id]}.md"] = "\n".join(lines) + "\n"
    for d in sorted(decisions, key=lambda d: d.id):
        lines = ["---", f"id: {_dumps(d.id)}", f"status: {_dumps(d.status)}", "---", f"# {d.title}"]
        facts = [(label, link(eid)) for label, eid in (("Actor", d.actor_entity), ("Outcome", d.outcome_entity)) if eid]
        if d.alternative_entities:
            facts.append(("Alternatives", ", ".join(link(a) for a in d.alternative_entities)))
        facts += [(label, text) for label, text in (("Summary", d.summary), ("Rationale", d.rationale)) if text]
        if facts:
            lines += ["", *(f"- {label}: {text}" for label, text in facts)]
        if d.steps:
            ordered = sorted(d.steps, key=lambda s: s.order)
            steps = [
                f"{n}. {link(s.from_entity)} to {link(s.to_entity)} ({s.relation_id})" for n, s in enumerate(ordered, 1)
            ]
            lines += ["", "## Steps", *steps]
        vault[f"decisions/{decision_stems[d.id]}.md"] = "\n".join(lines) + "\n"
    return vault
