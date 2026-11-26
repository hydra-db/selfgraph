import CASE_IGNORABLE from "@unicode/unicode-15.0.0/Binary_Property/Case_Ignorable/ranges.mjs";
import CASED from "@unicode/unicode-15.0.0/Binary_Property/Cased/ranges.mjs";
import DECIMAL from "@unicode/unicode-15.0.0/General_Category/Decimal_Number/ranges.mjs";
import LETTER from "@unicode/unicode-15.0.0/General_Category/Letter/ranges.mjs";
import NUMBER from "@unicode/unicode-15.0.0/General_Category/Number/ranges.mjs";
import SIMPLE_LOWER from "@unicode/unicode-15.0.0/Simple_Case_Mapping/Lowercase/symbols.mjs";
import SIMPLE_UPPER from "@unicode/unicode-15.0.0/Simple_Case_Mapping/Uppercase/symbols.mjs";
import SPECIAL_LOWER from "@unicode/unicode-15.0.0/Special_Casing/Lowercase/symbols.mjs";
import SPECIAL_UPPER from "@unicode/unicode-15.0.0/Special_Casing/Uppercase/symbols.mjs";

/**
 * Render code point ranges as the body of a regex character class.
 *
 * @param ranges (Array<{ begin: number; end: number }>): the ranges, each with an exclusive end.
 * @return (string): the class body, to place between square brackets in a regex with the u flag.
 */
function charClass(ranges: ReadonlyArray<{ begin: number; end: number }>): string {
  return ranges.map(({ begin, end }) => `\\u{${begin.toString(16)}}-\\u{${(end - 1).toString(16)}}`).join("");
}

export const LETTER_CLASS = charClass(LETTER);
export const ALNUM_CLASS = LETTER_CLASS + charClass(NUMBER);
export const WORD_CLASS = `${ALNUM_CLASS}_`;
export const DECIMAL_CLASS = charClass(DECIMAL);

const CASED_CHAR = new RegExp(`^[${charClass(CASED)}]$`, "u");
const CASE_IGNORABLE_CHAR = new RegExp(`^[${charClass(CASE_IGNORABLE)}]$`, "u");
const LOWER = new Map([...SIMPLE_LOWER, ...SPECIAL_LOWER]);
const UPPER = new Map([...SIMPLE_UPPER, ...SPECIAL_UPPER]);

/**
 * Report whether the capital sigma at an index ends a word, so it lowercases to the final form.
 *
 * @param chars (string[]): the characters of the text holding the sigma.
 * @param index (number): the position of the sigma.
 * @return (boolean): true when a cased letter precedes it and none follows it, ignoring case-ignorable characters.
 */
function finalSigma(chars: string[], index: number): boolean {
  let before = index - 1;
  while (before >= 0 && CASE_IGNORABLE_CHAR.test(chars[before]!)) before--;
  if (before < 0 || !CASED_CHAR.test(chars[before]!)) return false;
  let after = index + 1;
  while (after < chars.length && CASE_IGNORABLE_CHAR.test(chars[after]!)) after++;
  return after === chars.length || !CASED_CHAR.test(chars[after]!);
}

/**
 * Lowercase text with the Unicode 15.0 mappings, whatever Node version runs.
 *
 * @param text (string): the text to lowercase.
 * @return (string): the lowercased text.
 */
export function lower(text: string): string {
  const chars = Array.from(text);
  return chars
    .map((ch, index) => (ch === "\u03a3" ? (finalSigma(chars, index) ? "\u03c2" : "\u03c3") : (LOWER.get(ch) ?? ch)))
    .join("");
}

/**
 * Uppercase text with the Unicode 15.0 mappings, whatever Node version runs.
 *
 * @param text (string): the text to uppercase.
 * @return (string): the uppercased text.
 */
export function upper(text: string): string {
  let out = "";
  for (const ch of text) out += UPPER.get(ch) ?? ch;
  return out;
}
