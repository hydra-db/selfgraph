import COMMON from "@unicode/unicode-15.0.0/Case_Folding/C/symbols.mjs";
import FULL from "@unicode/unicode-15.0.0/Case_Folding/F/symbols.mjs";

const TABLE = new Map<string, string>([...COMMON, ...FULL]);

/**
 * Full Unicode case folding (statuses C and F), pinned to Unicode 15.0 so folded keys stay stable.
 *
 * @param text (string): the text to fold.
 * @return (string): the casefolded text.
 */
export function casefold(text: string): string {
  let out = "";
  for (const ch of text) out += TABLE.get(ch) ?? ch;
  return out;
}
