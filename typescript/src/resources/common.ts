import type { GraphAccess } from "../access.js";
import { ValidationError } from "../errors.js";
import { pyRepr, pyStrip } from "../internal/py.js";
import { type Evidence, EvidenceInput, Kind, type Page, parseOrThrow, Status } from "../models.js";
import { evidenceFromInputs } from "../ops.js";
import type { GraphPrimitives } from "../protocols.js";
import { hasControl, keysOf, requireInt, typeName } from "../validate.js";

const MAX_OFFSET = 2 ** 31;
const MAX_LIMIT = 1000;
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Encode an offset, or the last id a keyset page returned, as an opaque cursor (URL-safe base64 with padding).
 *
 * @param position (number | string): the next offset or the last id seen.
 * @return (string): the cursor.
 */
export function encodeCursor(position: number | string): string {
  return Buffer.from(String(position), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Decode a cursor's text, requiring the exact encoding encodeCursor writes and a position valid accepts.
 *
 * @param cursor (unknown): the cursor from a previous page, or null to start.
 * @param valid ((text: string) => boolean): whether the decoded text is a position this list pages by.
 * @return (string | null): the encoded position, or null to start.
 */
function cursorText(cursor: unknown, valid: (text: string) => boolean): string | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "string") throw new ValidationError(`cursor must be a string, got ${typeName(cursor)}`);
  const invalid = new ValidationError(`invalid cursor ${pyRepr(cursor)}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(cursor, "base64url"));
  } catch {
    throw invalid;
  }
  if (!text || encodeCursor(text) !== cursor || !valid(text)) throw invalid;
  return text;
}

/**
 * Decode an opaque cursor into its next offset, rejecting anything that is not a cursor this SDK wrote.
 *
 * @param cursor (unknown): the cursor from a previous page, or null to start.
 * @return (number): the offset to resume from.
 */
export function decodeCursor(cursor: unknown): number {
  const text = cursorText(
    cursor,
    (t) => /^\d+$/.test(t) && String(Number.parseInt(t, 10)) === t && Number.parseInt(t, 10) < MAX_OFFSET,
  );
  return text === null ? 0 : Number.parseInt(text, 10);
}

/**
 * Decode an opaque keyset cursor into the last id the previous page returned.
 *
 * @param cursor (unknown): the cursor from a previous page, or null to start.
 * @param kind (string): the id kind the list pages by; entity accepts any 'type:name' id, others need their own prefix.
 * @return (string | null): the id to resume after, or null to start.
 */
export function decodeKeyCursor(cursor: unknown, kind: string): string | null {
  return cursorText(cursor, (text) => {
    const colon = text.indexOf(":");
    const prefix = text.slice(0, colon);
    return (
      colon >= 0 &&
      !!pyStrip(prefix) &&
      !!pyStrip(text.slice(colon + 1)) &&
      !hasControl(text) &&
      (kind === "entity" || prefix.toLowerCase() === kind)
    );
  });
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

export const PAGE_KEYS = keysOf<PageOptions>({ cursor: true, limit: true });
export const VERSIONS_KEYS = ["newest_first"];

/**
 * Validate a page size: an integer from 1 to 1000, default 50.
 *
 * @param options (PageOptions): the page options.
 * @return (number): the page size.
 */
function pageLimit(options: PageOptions): number {
  const limit: unknown = options.limit ?? DEFAULT_PAGE_LIMIT;
  requireInt("limit", limit);
  if (limit < 1) throw new ValidationError(`limit must be >= 1, got ${limit}`);
  if (limit > MAX_LIMIT) throw new ValidationError(`limit must be <= ${MAX_LIMIT}, got ${limit}`);
  return limit;
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
    const limit = pageLimit(options);
    const offset = decodeCursor(options.cursor);
    const rows = await this.graph.read((store, ns) => fetch(store, ns, { skip: offset, limit: limit + 1 }));
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null };
  }

  /**
   * Fetch one keyset page: like page, but resume after the last id the previous page returned, so deletes and inserts between pages neither skip nor repeat an item.
   *
   * @param kind (string): the id kind the list pages by.
   * @param options (PageOptions): the cursor and page size.
   * @param fetch ((store: GraphPrimitives, ns: string, window: { skip: number; limit: number; after: string | null }) => Promise<T[]>): the list read.
   * @return (Page<T>): the page.
   */
  protected async pageById<T extends { id: string }>(
    kind: string,
    options: PageOptions,
    fetch: (
      store: GraphPrimitives,
      ns: string,
      window: { skip: number; limit: number; after: string | null },
    ) => Promise<T[]>,
  ): Promise<Page<T>> {
    const limit = pageLimit(options);
    const after = decodeKeyCursor(options.cursor, kind);
    const rows = await this.graph.read((store, ns) => fetch(store, ns, { skip: 0, limit: limit + 1, after }));
    return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.id) : null };
  }
}
