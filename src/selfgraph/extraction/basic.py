from __future__ import annotations

import re

from ..models import EntityInput, InsertWarning, Ontology, ParsedDocument
from .extractor import DefaultExtractor, _RelOut, _WarningSink

__all__ = ["BasicExtractor"]

_SPACY = None
_SPACY_READY = False
_TYPE_MAP = {
    "PERSON": "Person",
    "ORG": "Organization",
    "GPE": "Place",
    "LOC": "Place",
    "PRODUCT": "Product",
    "EVENT": "Event",
    "WORK_OF_ART": "Work",
    "FAC": "Facility",
    "NORP": "Group",
    "LAW": "Law",
    "LANGUAGE": "Language",
}
_CAP = re.compile(r"[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*")
_SENT = re.compile(r"(?<=[.!?])\s+")


def _nlp():
    global _SPACY, _SPACY_READY
    if not _SPACY_READY:
        _SPACY_READY = True
        try:
            import spacy

            _SPACY = spacy.load("en_core_web_sm")
        except Exception:  # noqa: BLE001  # pragma: no cover
            _SPACY = None
    return _SPACY


def _spacy_extract(nlp, text: str):
    doc = nlp(text)
    entities = [EntityInput(type=_TYPE_MAP.get(e.label_, "Entity"), name=e.text) for e in doc.ents]
    tok_ent = {i: e for e in doc.ents for i in range(e.start, e.end)}

    def ent_for(token):
        for node in token.subtree:
            if node.i in tok_ent:
                return tok_ent[node.i]
        return None

    relations = []
    for tok in doc:
        if tok.pos_ != "VERB":
            continue
        subjects = [c for c in tok.children if c.dep_ in ("nsubj", "nsubjpass")]
        objects = [c for c in tok.children if c.dep_ in ("dobj", "attr", "dative", "oprd")]
        for prep in (c for c in tok.children if c.dep_ == "prep"):
            objects += [c for c in prep.children if c.dep_ == "pobj"]
        for subj in subjects:
            se = ent_for(subj)
            if se is None:
                continue
            for obj in objects:
                oe = ent_for(obj)
                if oe is not None and oe.text != se.text:
                    relations.append(_RelOut(from_name=se.text, type=tok.lemma_.upper(), to_name=oe.text))
    return entities, relations


def _regex_extract(text: str):
    entities, relations = [], []
    for sentence in _SENT.split(text):
        names = list(dict.fromkeys(m.group(0).strip() for m in _CAP.finditer(sentence)))
        entities.extend(EntityInput(type="Entity", name=name) for name in names)
        relations.extend(
            _RelOut(from_name=a, type="RELATED_TO", to_name=b) for a, b in zip(names, names[1:], strict=False)
        )
    return entities, relations


class BasicExtractor(_WarningSink):
    def __init__(self) -> None:
        self._warnings: list[InsertWarning] = []

    async def extract(self, document: ParsedDocument) -> Ontology:
        nlp = _nlp()
        if nlp is not None:
            entities, relations = _spacy_extract(nlp, document.text)
            engine = "spaCy NER"
        else:
            entities, relations = _regex_extract(document.text)
            engine = "heuristic regex; install the 'ner' extra for spaCy NER"
        self._warnings = [InsertWarning(code="basic_extraction", message=f"extracted without an LLM using {engine}")]
        return DefaultExtractor._assemble(entities, relations, [], [])
