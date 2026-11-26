import { writeFileSync } from "node:fs";
import CASE_IGNORABLE from "@unicode/unicode-15.0.0/Binary_Property/Case_Ignorable/ranges.mjs";
import CASED from "@unicode/unicode-15.0.0/Binary_Property/Cased/ranges.mjs";
import FOLD_COMMON from "@unicode/unicode-15.0.0/Case_Folding/C/code-points.mjs";
import FOLD_FULL from "@unicode/unicode-15.0.0/Case_Folding/F/code-points.mjs";
import DECIMAL from "@unicode/unicode-15.0.0/General_Category/Decimal_Number/ranges.mjs";
import LETTER from "@unicode/unicode-15.0.0/General_Category/Letter/ranges.mjs";
import NUMBER from "@unicode/unicode-15.0.0/General_Category/Number/ranges.mjs";
import SIMPLE_LOWER from "@unicode/unicode-15.0.0/Simple_Case_Mapping/Lowercase/code-points.mjs";
import SIMPLE_UPPER from "@unicode/unicode-15.0.0/Simple_Case_Mapping/Uppercase/code-points.mjs";
import SPECIAL_LOWER from "@unicode/unicode-15.0.0/Special_Casing/Lowercase/code-points.mjs";
import SPECIAL_UPPER from "@unicode/unicode-15.0.0/Special_Casing/Uppercase/code-points.mjs";

const WIDTH = 113;
const OUTPUT = new URL("../../src/selfgraph/_unicode_data.py", import.meta.url);

/**
 * Overlay code point mappings in order, so a later map wins, and drop every code point that maps to itself.
 *
 * @param maps (Map<number, number | number[]>[]): the maps to overlay, lowest priority first.
 * @return ([number, number[]][]): the remaining mappings sorted by code point.
 */
function overlay(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [cp, target] of map) merged.set(cp, Array.isArray(target) ? target : [target]);
  }
  return [...merged].filter(([cp, target]) => target.length !== 1 || target[0] !== cp).sort((a, b) => a[0] - b[0]);
}

/**
 * Write each range of code points as one hexadecimal token, a single code point or the first and last joined by a hyphen.
 *
 * @param ranges ({ begin: number, end: number }[]): ranges with an exclusive end.
 * @return (string[]): the tokens.
 */
function rangeTokens(ranges) {
  return ranges.map(({ begin, end }) =>
    end - begin === 1 ? begin.toString(16) : `${begin.toString(16)}-${(end - 1).toString(16)}`,
  );
}

/**
 * Write a mapping as tokens, folding a run of single code point targets with a constant source step and offset into one token.
 *
 * @param entries ([number, number[]][]): the mappings sorted by code point.
 * @return (string[]): the tokens, each a source, an optional last source and step, a colon, and the first target.
 */
function mappingTokens(entries) {
  const tokens = [];
  const hex = (cp) => cp.toString(16);
  for (let i = 0; i < entries.length; ) {
    const [cp, target] = entries[i];
    const next = entries[i + 1];
    const step = next && target.length === 1 && next[1].length === 1 ? next[0] - cp : 0;
    if (step === 0 || next[1][0] - target[0] !== step) {
      tokens.push(`${hex(cp)}:${target.map(hex).join(".")}`);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (
      j < entries.length &&
      entries[j][1].length === 1 &&
      entries[j][0] - entries[j - 1][0] === step &&
      entries[j][1][0] - entries[j - 1][1][0] === step
    ) {
      j += 1;
    }
    tokens.push(`${hex(cp)}-${hex(entries[j - 1][0])}${step > 1 ? `/${step}` : ""}:${hex(target[0])}`);
    i = j;
  }
  return tokens;
}

/**
 * Render tokens as a parenthesised Python string literal, wrapped at the output width.
 *
 * @param name (string): the Python constant name.
 * @param tokens (string[]): the space-separated tokens.
 * @return (string): the Python assignment.
 */
function pythonString(name, tokens) {
  const lines = [];
  let line = "";
  for (const token of tokens) {
    if (line && line.length + token.length + 1 > WIDTH) {
      lines.push(`${line} `);
      line = "";
    }
    line += line ? ` ${token}` : token;
  }
  lines.push(line);
  return `${name} = (\n${lines.map((text) => `    "${text}"`).join("\n")}\n)\n`;
}

const tables = [
  ["LETTER_RANGES", rangeTokens(LETTER)],
  ["NUMBER_RANGES", rangeTokens(NUMBER)],
  ["DECIMAL_RANGES", rangeTokens(DECIMAL)],
  ["CASED_RANGES", rangeTokens(CASED)],
  ["CASE_IGNORABLE_RANGES", rangeTokens(CASE_IGNORABLE)],
  ["LOWER_TABLE", mappingTokens(overlay(SIMPLE_LOWER, SPECIAL_LOWER))],
  ["UPPER_TABLE", mappingTokens(overlay(SIMPLE_UPPER, SPECIAL_UPPER))],
  ["FOLD_TABLE", mappingTokens(overlay(FOLD_COMMON, FOLD_FULL))],
];

writeFileSync(OUTPUT, `${tables.map(([name, tokens]) => pythonString(name, tokens)).join("\n\n")}`);
