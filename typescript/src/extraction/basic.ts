import UPPERCASE from "@unicode/unicode-15.0.0/Binary_Property/Uppercase/code-points.mjs";
import { LLM_HINT } from "../errors.js";
import { log } from "../internal/log.js";
import { MARK_CLASS } from "../internal/marks.js";
import { PY_WS_CLASS, pySplit, pySplitLines, pyStrip } from "../internal/py.js";
import { lower, WORD_CLASS } from "../internal/unicode.js";
import { insertWarning, type ParsedDocument, type ParsedExtraction } from "../models.js";
import type { Extractor } from "../protocols.js";
import { assembleExtraction, FALLBACK_TYPE, type RawEntity, type RawRelation, WarningSink } from "./extractor.js";

const WORD = `[${WORD_CLASS}${MARK_CLASS}&.'\\-]`;
const UPPER = `[${UPPERCASE.map((cp) => `\\u{${cp.toString(16)}}`).join("")}]`;
const CAP = new RegExp(`${UPPER}${WORD}*(?:[${PY_WS_CLASS}]+${UPPER}${WORD}*)*`, "gu");
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
    const found = pySplitLines(sentence).flatMap((line) => Array.from(line.matchAll(CAP), (m) => m[0]));
    const raw = found.map((n) => pyStrip(pySplit(n).join(" "), ".,;:!?"));
    const names = [...new Set(raw.filter((n) => n && !STOPNAMES.has(lower(n))))];
    entities.push(...names.map((name) => ({ type: FALLBACK_TYPE, name })));
    for (let i = 0; i + 1 < names.length; i++) {
      relations.push({ from_name: names[i]!, type: "RELATED_TO", to_name: names[i + 1]! });
    }
  }
  return { entities, relations };
}

export class NERExtractor extends WarningSink implements Extractor {
  readonly tier = "regex";

  async extract(document: ParsedDocument): Promise<ParsedExtraction> {
    const { entities, relations } = regexExtract(document.text);
    const message = `extracted without an LLM using heuristic regex; for model-based extraction, ${LLM_HINT}`;
    log(`basic_extraction: ${message}`);
    this.warnings = [insertWarning("basic_extraction", message)];
    return assembleExtraction(entities, relations, [], [], this.warnings);
  }
}
