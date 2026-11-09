import { LLM_HINT } from "../errors.js";
import { log } from "../internal/log.js";
import { PY_WS_CLASS, pyStrip } from "../internal/py.js";
import { insertWarning, type ParsedDocument, type ParsedOntology } from "../models.js";
import type { Extractor } from "../protocols.js";
import { assembleOntology, FALLBACK_TYPE, type RawEntity, type RawRelation, WarningSink } from "./extractor.js";

const WORD = "[\\p{L}\\p{N}_&.'\\-]";
const CAP = new RegExp(`[A-Z]${WORD}*(?:[${PY_WS_CLASS}]+[A-Z]${WORD}*)*`, "gu");
const SENT = new RegExp(`(?<=[.!?])[${PY_WS_CLASS}]+`, "u");
const STOPNAMES = new Set(
  "the a an he she it they we you i this that these those there here his her their our your its".split(" "),
);

/**
 * Heuristic, LLM-free extraction: capitalised runs become entities and neighbours in a sentence are related.
 *
 * @param text (string): the text to extract from.
 * @return ({ entities: RawEntity[]; relations: RawRelation[] }): the raw entities and relations.
 */
function regexExtract(text: string): { entities: RawEntity[]; relations: RawRelation[] } {
  const entities: RawEntity[] = [];
  const relations: RawRelation[] = [];
  for (const sentence of text.split(SENT)) {
    const raw = Array.from(sentence.matchAll(CAP), (m) => pyStrip(pyStrip(m[0]), ".,;:!?"));
    const names = [...new Set(raw.filter((n) => n && !STOPNAMES.has(n.toLowerCase())))];
    entities.push(...names.map((name) => ({ type: FALLBACK_TYPE, name })));
    for (let i = 0; i + 1 < names.length; i++) {
      relations.push({ from_name: names[i]!, type: "RELATED_TO", to_name: names[i + 1]! });
    }
  }
  return { entities, relations };
}

export class BasicExtractor extends WarningSink implements Extractor {
  async extract(document: ParsedDocument): Promise<ParsedOntology> {
    const { entities, relations } = regexExtract(document.text);
    const message = `extracted without an LLM using heuristic regex; for model-based extraction, ${LLM_HINT}`;
    log(`basic_extraction: ${message}`);
    this.warnings = [insertWarning("basic_extraction", message)];
    return assembleOntology(entities, relations, [], []);
  }
}
