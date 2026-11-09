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

function encode(enc: Encoder, text: string): number[] {
  return enc.encode(text, [], []);
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
  const step = maxTokens - overlapTokens;
  const chunks: Chunk[] = [];
  let index = 0;
  const n = tokens.length;
  for (let i = 0; i < n; i += step) {
    const piece = encoder.decode(tokens.slice(i, i + maxTokens));
    const start = cpLen(encoder.decode(tokens.slice(0, i)));
    if (pyStrip(piece)) {
      chunks.push({ index, text: piece, start_offset: start, end_offset: start + cpLen(piece) });
      index++;
    }
    if (i + maxTokens >= n) break;
  }
  return chunks;
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
