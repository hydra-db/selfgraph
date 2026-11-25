import { ValidationError } from "./errors.js";
import { isMissing } from "./internal/optional.js";
import { cpLen, PY_WS_CLASS, pyStrip } from "./internal/py.js";
import { requireInt } from "./validate.js";

export interface Chunk {
  index: number;
  text: string;
  start_offset: number;
  end_offset: number;
}

export interface Encoder {
  encode(text: string, allowedSpecial?: string[] | "all", disallowedSpecial?: string[] | "all"): number[];
  decode(tokens: number[]): string;
}

const CHARS_PER_TOKEN = 4;
const WS_CHAR = new RegExp(`^[${PY_WS_CLASS}]$`, "u");
const AS_SPACE = /[\u0085\ufeff]/g;
const REPLACED = /^(?:\ufffd|[\ud800-\udfff])$/;

let encoder: Encoder | null | undefined;
let loading: Promise<void> | null = null;

export interface Tokenizer {
  countTokens: typeof countTokens;
  chunkText: typeof chunkText;
}

/**
 * The token counter and chunker, after loading the cl100k_base tokenizer from js-tiktoken once; both estimate when it is absent.
 *
 * @return (Tokenizer): countTokens and chunkText bound to the loaded tokenizer or the character fallback.
 */
export async function loadTokenizer(): Promise<Tokenizer> {
  if (encoder === undefined) {
    loading ??= import(/* webpackIgnore: true */ /* @vite-ignore */ "js-tiktoken").then(
      (mod: { getEncoding(name: string): Encoder }) => {
        encoder = mod.getEncoding("cl100k_base");
      },
      (exc: unknown) => {
        if (!isMissing(exc, "js-tiktoken")) {
          loading = null;
          throw exc;
        }
        encoder = null;
      },
    );
    await loading;
  }
  return { countTokens, chunkText };
}

/**
 * Use a specific tokenizer, or null to force the character fallback.
 *
 * @param custom (Encoder | null): an encoder with encode and decode, or null.
 */
export function setTokenizer(custom: Encoder | null): void {
  encoder = custom;
  loading = Promise.resolve();
}

/**
 * Encode text as ordinary text, with U+0085 and U+FEFF as spaces, since the regex engines of the two SDKs disagree on whether they are whitespace.
 *
 * @param enc (Encoder): the tokenizer.
 * @param text (string): the text to encode.
 * @return (number[]): the tokens.
 */
function encode(enc: Encoder, text: string): number[] {
  return enc.encode(text.replace(AS_SPACE, " "), [], []);
}

/**
 * Count tokens with the tokenizer when loaded, falling back to a length estimate.
 *
 * @param text (string): the text to measure.
 * @return (number): the token count.
 */
export function countTokens(text: string): number {
  if (!encoder) return Math.max(1, Math.floor(cpLen(text) / CHARS_PER_TOKEN));
  return encode(encoder, text).length;
}

/**
 * Validate a chunking size is an integer no smaller than the minimum.
 *
 * @param field (string): the parameter name, for the message.
 * @param value (unknown): the value to check.
 * @param minimum (number): the smallest accepted value.
 */
function requireCount(field: string, value: unknown, minimum: number): asserts value is number {
  requireInt(field, value);
  if (value < minimum) throw new ValidationError(`${field} must be at least ${minimum}, got ${value}`);
}

/**
 * Split text into overlapping chunks sized by tokens, falling back to characters cut on whitespace, with code-point offsets.
 *
 * @param text (string): the text to split.
 * @param options ({ max_tokens?: number; overlap_tokens?: number }): the maximum tokens per chunk (at least 1) and the token overlap (0 to max_tokens - 1, default min(64, max_tokens / 4) rounded down).
 * @return (Chunk[]): the chunks, in order.
 */
export function chunkText(text: string, options: { max_tokens?: number; overlap_tokens?: number } = {}): Chunk[] {
  const maxTokens = options.max_tokens ?? 512;
  requireCount("max_tokens", maxTokens, 1);
  const overlapTokens = options.overlap_tokens ?? Math.min(64, Math.floor(maxTokens / 4));
  requireCount("overlap_tokens", overlapTokens, 0);
  if (overlapTokens >= maxTokens) {
    throw new ValidationError(`overlap_tokens (${overlapTokens}) must be smaller than max_tokens (${maxTokens})`);
  }
  if (!pyStrip(text)) return [];

  if (!encoder) return chunkByChars(text, maxTokens * CHARS_PER_TOKEN, overlapTokens * CHARS_PER_TOKEN);

  const tokens = encode(encoder, text);
  const cps = Array.from(text);
  const bounds = charBounds(encoder, tokens, cps);
  const step = maxTokens - overlapTokens;
  const chunks: Chunk[] = [];
  let index = 0;
  const n = tokens.length;
  for (let i = 0; i < n; i += step) {
    const start = bounds[i] as number;
    const end = bounds[Math.min(i + maxTokens, n)] as number;
    const piece = cps.slice(start, end).join("");
    if (pyStrip(piece)) {
      chunks.push({ index, text: piece, start_offset: start, end_offset: end });
      index++;
    }
    if (i + maxTokens >= n) break;
  }
  return chunks;
}

/**
 * Map each token boundary to a code-point offset in the text, moving a boundary inside a character to its start.
 *
 * @param enc (Encoder): the tokenizer.
 * @param tokens (number[]): the tokens of the text.
 * @param cps (string[]): the text's code points.
 * @return (number[]): tokens.length + 1 code-point offsets, the first 0 and the last cps.length.
 */
function charBounds(enc: Encoder, tokens: number[], cps: string[]): number[] {
  const bounds = [0];
  let run = 0;
  let offset = 0;
  for (let end = 1; end <= tokens.length; end++) {
    const piece = enc.decode(tokens.slice(run, end));
    const length = cpLen(piece);
    if (end < tokens.length && piece.endsWith("\ufffd")) {
      const source = cps[offset + length - 1] ?? "";
      if (!REPLACED.test(source)) continue;
      const next = tokens[end] as number;
      if (enc.decode(tokens.slice(run, end + 1)) !== piece + enc.decode([next])) continue;
    }
    for (let cut = run + 1; cut < end; cut++) {
      bounds.push(offset + Math.max(0, cpLen(enc.decode(tokens.slice(run, cut))) - 1));
    }
    offset += length;
    bounds.push(offset);
    run = end;
  }
  bounds[bounds.length - 1] = cps.length;
  return bounds;
}

/**
 * Split text into overlapping chunks sized by characters, starting and ending each on a word boundary.
 *
 * @param text (string): the text to split.
 * @param sizeIn (number): the maximum characters per chunk.
 * @param overlapIn (number): the character overlap between consecutive chunks.
 * @return (Chunk[]): the chunks, in order.
 */
export function chunkByChars(text: string, sizeIn: number, overlapIn: number): Chunk[] {
  const cps = Array.from(text);
  const space = cps.map((ch) => WS_CHAR.test(ch));
  const size = Math.max(1, sizeIn);
  const overlap = Math.max(0, Math.min(overlapIn, size - 1));
  const chunks: Chunk[] = [];
  const n = cps.length;
  let start = 0;
  while (start < n && space[start]) start++;
  let index = 0;
  while (start < n) {
    let end = Math.min(start + size, n);
    if (end < n) {
      let cut = end;
      while (cut > start && !space[cut]) cut--;
      if (cut > start) end = cut;
    }
    const piece = cps.slice(start, end).join("");
    if (pyStrip(piece)) {
      chunks.push({ index, text: piece, start_offset: start, end_offset: end });
      index++;
    }
    if (end >= n) break;
    let next = Math.max(end - overlap, start + 1);
    while (next < end && !space[next - 1]) next++;
    while (next < n && space[next]) next++;
    start = next;
  }
  return chunks;
}
