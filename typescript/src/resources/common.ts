import type { GraphAccess } from "../access.js";
import { ValidationError } from "../errors.js";
import { NON_ASCII, pyRepr } from "../internal/py.js";
import { type Evidence, EvidenceInput, Kind, type Page, parseOrThrow, Status } from "../models.js";
import { evidenceFromInputs } from "../ops.js";
import type { GraphPrimitives } from "../protocols.js";
import { pyTypeName, requireInt } from "../validate.js";

const MAX_OFFSET = 2 ** 31;
const MAX_LIMIT = 1000;
export const DEFAULT_PAGE_LIMIT = 50;
const B64URL = /[A-Za-z0-9\-_=]/;

/**
 * Encode an offset as an opaque cursor (base64 of the decimal offset).
 *
 * @param offset (number): the next offset.
 * @return (string): the cursor.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "ascii").toString("base64");
}

/**
 * Decode an opaque cursor into its next offset, rejecting anything that is not a cursor this SDK wrote.
 *
 * @param cursor (unknown): the cursor from a previous page, or null to start.
 * @return (number): the offset to resume from.
 */
export function decodeCursor(cursor: unknown): number {
  if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
    throw new ValidationError(`cursor must be a string, got ${pyTypeName(cursor)}`);
  }
  if (!cursor) return 0;
  const invalid = new ValidationError(`invalid cursor ${pyRepr(cursor)}`);
  if (NON_ASCII.test(cursor)) throw invalid;
  const data = Array.from(cursor)
    .filter((ch) => B64URL.test(ch))
    .join("");
  if (data.length % 4 !== 0) throw invalid;
  const text = Buffer.from(data, "base64url").toString("latin1");
  if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(text)) throw invalid;
  const value = Number.parseInt(text.replace(/_/g, ""), 10);
  if (!(value >= 0 && value < MAX_OFFSET)) throw invalid;
  return value;
}

/**
 * Yield every item across pages by following the list cursor.
 *
 * @param list ((cursor: string | null) => Promise<Page<T>>): a list function taking a cursor.
 * @return (AsyncGenerator<T>): every item across all pages.
 */
export async function* paginate<T>(list: (cursor: string | null) => Promise<Page<T>>): AsyncGenerator<T> {
  let cursor: string | null = null;
  for (;;) {
    const page = await list(cursor);
    yield* page.items;
    if (page.next_cursor === null) return;
    cursor = page.next_cursor;
  }
}

export const parseKind = (value: unknown): Kind => parseOrThrow(Kind, value, "kind");

export const parseStatus = (value: unknown): Status => parseOrThrow(Status, value, "status");

export const parseEvidence = (inputs: readonly EvidenceInput[]): Evidence[] => {
  if (!Array.isArray(inputs)) throw new ValidationError("evidence must be a list of Evidence objects");
  return evidenceFromInputs(inputs.map((ev) => parseOrThrow(EvidenceInput, ev, "evidence")));
};

export interface PageOptions {
  cursor?: string | null;
  limit?: number;
}

export abstract class Resource {
  constructor(protected readonly graph: GraphAccess) {}

  /**
   * Fetch one page: validate the limit (1 to 1000) and cursor, read limit + 1 rows, and set the next cursor; the extra row only signals a next page.
   *
   * @param options (PageOptions): the cursor and page size.
   * @param fetch ((store: GraphPrimitives, ns: string, window: { skip: number; limit: number }) => Promise<T[]>): the list read.
   * @return (Page<T>): the page.
   */
  protected async page<T>(
    options: PageOptions,
    fetch: (store: GraphPrimitives, ns: string, window: { skip: number; limit: number }) => Promise<T[]>,
  ): Promise<Page<T>> {
    const limit: unknown = options.limit ?? DEFAULT_PAGE_LIMIT;
    requireInt("limit", limit);
    if (limit < 1) throw new ValidationError(`limit must be >= 1, got ${limit}`);
    if (limit > MAX_LIMIT) throw new ValidationError(`limit must be <= ${MAX_LIMIT}, got ${limit}`);
    const offset = decodeCursor(options.cursor);
    const rows = await this.graph.read((store, ns) => fetch(store, ns, { skip: offset, limit: limit + 1 }));
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null };
  }
}
