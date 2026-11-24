import { ValidationError } from "../errors.js";

const LINE_TERMINATORS = new Set(["\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);
export const BLANK = "\x00";
const MAX_QUERY_BYTES = 65_536;
const MAX_QUERY_DEPTH = 32;
const OPENERS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

/**
 * Blank strings, quoted identifiers, and comments; leave an unterminated token visible.
 *
 * @param query (string): the raw Cypher statement.
 * @return (string): the query with lexical tokens replaced.
 */
export function blankLexicalTokens(query: string): string {
  const out: string[] = [];
  const n = query.length;
  let i = 0;
  while (i < n) {
    const ch = query[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (query[j] === "\\") {
          j += 2;
          continue;
        }
        if (query[j] === ch) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) break;
      out.push(BLANK);
      i = j;
    } else if (ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (query[j] === "`") {
          if (j + 1 < n && query[j + 1] === "`") {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) break;
      out.push(BLANK);
      i = j;
    } else if (ch === "/" && i + 1 < n && query[i + 1] === "*") {
      const end = query.indexOf("*/", i + 2);
      if (end === -1) break;
      out.push(BLANK);
      i = end + 2;
    } else if (ch === "/" && i + 1 < n && query[i + 1] === "/") {
      let j = i + 2;
      while (j < n && !LINE_TERMINATORS.has(query[j]!)) j += 1;
      out.push(BLANK);
      i = j;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  if (i < n) out.push(query.slice(i));
  return out.join("");
}

/**
 * Reject queries over the raw Cypher size or delimiter nesting limit.
 *
 * @param query (string): the raw Cypher statement.
 * @return (void): returns if the query is within both limits.
 */
export function checkCypherLimits(query: string): void {
  if (query.length > MAX_QUERY_BYTES || Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    throw new ValidationError(`query exceeds the maximum length of ${MAX_QUERY_BYTES} UTF-8 bytes`, {
      code: "cypher_query_limit",
      field: "query",
    });
  }
  const closers: string[] = [];
  for (const char of blankLexicalTokens(query)) {
    const closer = OPENERS.get(char);
    if (closer !== undefined) {
      closers.push(closer);
      if (closers.length > MAX_QUERY_DEPTH) {
        throw new ValidationError(`query exceeds the maximum nesting depth of ${MAX_QUERY_DEPTH}`, {
          code: "cypher_query_limit",
          field: "query",
        });
      }
    } else if (char === closers.at(-1)) {
      closers.pop();
    }
  }
}
