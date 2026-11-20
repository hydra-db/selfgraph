import { version } from "../package.json";
import { pyRepr } from "./internal/py.js";

export const HINTS = {
  invalid_argument:
    "An argument, input field, or option value is wrong. The message and `field` name it and what it expected. Fix the value and call again.",
  unknown_key:
    "A key or option name is not one the call accepts. Use the name the message suggests after `did you mean`. Do not drop the value to make the call pass.",
  invalid_setting:
    "A graph setting is missing or wrong: `uri`, `store`, `llm_provider`, `llm_model`, `llm_timeout`, `llm_concurrency`, or the provider in the LLM config. Fix the setting, flag, or `SELFGRAPH_*` variable the message names.",
  llm_required:
    "The call needs an LLM and none is configured. Configure one: the `llm` option, or `--llm-provider` and `--llm-model` in the CLI and MCP server. Do not lower `level` or turn the feature off to avoid the LLM unless the user asks.",
  embedder_required:
    "The `embeddings` seeds tier needs an embedder. Pass one with the SDK's `embedder` option. Do not switch to another seeds tier unless the user asks.",
  schema_required:
    "Strict schema mode, or exporting the schema, needs a schema. Pass one: the `schema` option, or `--schema`. Do not switch to schema mode `warn` unless the user asks.",
  schema_violation:
    "A write breaks the schema in strict mode. Fix the facts so they match the schema. Do not change the schema or the schema mode to let the write through; that is the user's decision.",
  immutable_identity:
    "The change touches a field that is part of the object's id: an entity's type, a relation's endpoints and type, or a preference's subject, stance, key, and value. Create a new object instead of updating this one.",
  unknown_reference:
    "The input references an entity or relation that does not exist. Fix the id, or create the object first when the facts say it exists.",
  relation_certified:
    "A certified relation blocks the change. Certification is a person's sign-off, so ask the user before uncertifying it. Do not uncertify it yourself to make the call pass.",
  relation_invalidated:
    "The relation was invalidated (superseded or retired). Act on its current version. Create it again only when the facts say it holds again.",
  merge_reverted: "The merge was already reverted. There is nothing left to undo.",
  invalid_cursor: "The cursor did not come from this listing. Start the listing again without a cursor.",
  invalid_resolver_decision:
    "A custom entity resolver returned a bad decision. Return a `ResolutionDecision` whose target is one of the offered entities, with a confidence and a reason.",
  read_only_query:
    "`run_cypher` runs a single read. Write through the typed tools instead. Do not reword the query to get a write past the guard.",
  missing_package: "An optional package is not installed. Run the install command in the message, or ask the user to.",
  not_found:
    "The object does not exist in the namespace the message names. Check the id and the namespace, and use the `did you mean` suggestion when there is one. Do not create a placeholder object just to make the call pass.",
  already_exists: "An object with this id already exists. Update it, or insert it, which upserts.",
  extraction_failed:
    "LLM extraction failed. The message carries the first failure. Check the LLM settings and the provider, then run the insert again.",
  llm_auth_failed:
    "The LLM provider got no API key, or rejected it. Pass `api_key` in the LLM config, or set `SELFGRAPH_LLM_API_KEY` or the provider's own variable. Do not write the key into source code.",
  llm_model_not_found: "The provider does not know the model. Check the model name and the provider.",
  invalid_llm_output:
    "The model, or a custom LLM client, returned output that does not match the pass's schema. Use another model, or fix the client.",
  invalid_prompt_template:
    "A prompt template is malformed. Keep `{text}` in the user template and use no placeholder other than `{text}` and `{instructions}`.",
  query_failed:
    "The backend rejected a query. The message keeps the engine's reason. Check any Cypher you passed yourself.",
  graph_closed: "The SelfGraph was closed. Create a new SelfGraph.",
  store_closed: "The store was closed, and closing a graph closes its store. Create a new store for each SelfGraph.",
  store_unreachable:
    "The SDK could not connect to the backend. Check that the server is running and that the address is right. Running the call again unchanged does not help until the server is up.",
  store_locked:
    "Another process (an MCP server or a script) has the embedded Kuzu database open, and Kuzu allows one process at a time. Close it, or point this one at another path. Do not delete the database's files to free it.",
  store_auth_failed:
    "The backend rejected the credentials, or HydraDB got no token. Pass the right `auth` (CLI and MCP: `--auth`, or `SELFGRAPH_AUTH`).",
  database_not_found:
    "The database named in the settings does not exist on the server. Fix the name, or ask the user to create the database.",
  wrong_engine: "The server at the address is another engine. Pass the store that matches it, such as `neo4j`.",
  write_too_large:
    "A single node or edge row is larger than HydraDB accepts in one message. Split large property values or text. Do not cut data without asking the user.",
  write_conflict:
    "A concurrent write conflicted and the SDK's own retries ran out. Run the same call again: ids are deterministic and inserts are upserts, so a retry does not duplicate anything.",
  store_busy: "The server timed out or was too busy to take the query. Run the same call again after a moment.",
} as const;
export type ErrorCode = keyof typeof HINTS;
export const WARNING_HINTS: Readonly<Record<string, string>> = {
  unknown_entity_type:
    "An entity's type is not in the schema. Use a type the schema lists, or ask the user to add the type to the schema.",
  unknown_relation_type:
    "A relation's type is not in the schema. Use a type the schema lists, or ask the user to add the type to the schema.",
  endpoint_type_violation:
    "A relation endpoint is not one of the types the schema allows. Check the relation's direction and its endpoints.",
  missing_required_property: "A required property is absent or null. Add the property to the facts.",
  property_type_mismatch: "A property value does not match its declared type. Write the value as the declared type.",
  cardinality_violation:
    "An entity has fewer relations of a type in this insert than the schema's `min_count`. Add the missing relations, or check the schema with the user.",
  contradiction:
    "A relation breaks `max_count` against the graph, and both relations stay current. Decide which fact holds; when the newer one replaces the older, contradiction mode `supersede` retires the older.",
  contradiction_out_of_order:
    "A relation just written ranks among the oldest at an endpoint, so it was stored as history, already invalidated. Check its `event_time` if it should be current.",
  relation_superseded:
    "In `supersede` mode, a newer relation retired this one. The message names both ids. Nothing to fix unless the older fact still holds.",
  relation_reasserted:
    "`relations.create` recreated a relation a contradiction retired, as its next revision. Nothing to fix if the fact holds again.",
  dropped_off_schema:
    "In strict mode, `insert.text` dropped an extracted item that breaks the schema or references a dropped one. The item was not stored; insert it as facts that match the schema if it matters.",
  entity_merged:
    "Entity resolution folded an entity into another. Use the survivor's id. Unmerge it if the two are different things.",
  merge_self_loop:
    "A merge would have joined both ends of a relation, so the relation was dropped. Unmerging restores it.",
  certified_kept:
    "A certified relation stayed current where a contradiction or a replaced source would have retired it. Ask the user whether the certification still holds.",
  certified_dropped:
    "A write changed a certified relation, so its new revision is not certified. Ask the user to certify it again if it should be.",
  fact_retired_by_source:
    "A replaced source no longer states a relation, so the relation was retired. Nothing to fix if the source changed on purpose.",
  extraction_partial_failure:
    "Some extraction calls or items failed, and the rest was inserted. The message names the failure, the source, and the chunk. Insert that chunk again once the cause is fixed.",
  dropped_reserved_relation:
    "A relation or decision step used a reserved type, so it was dropped. Use another relation type.",
  prompts_ignored:
    "`instructions` and `prompts` were ignored, because extraction ran without an LLM. Configure an LLM for them to apply.",
  basic_extraction:
    "Text was extracted with the built-in regex extractor, without an LLM. Configure an LLM when the graph matters.",
  ner_extraction:
    "Text was extracted with spaCy NER, without an LLM (Python only). Configure an LLM when the graph matters.",
};
const DOCS_URL = `https://github.com/hydra-db/selfgraph/blob/ts-v${version}/docs/errors.md`;
const AGENT_GUIDE = "node_modules/@hydradb/selfgraph/errors.md";

type ErrorFields = {
  error: string;
  error_type: string;
  code: ErrorCode;
  field?: string;
  hint: string;
  retryable: boolean;
  docs: string;
  agent_guide: string;
};

export class SelfGraphError extends Error {
  static readonly code: ErrorCode = "invalid_argument";
  readonly code: ErrorCode;
  readonly field?: string;

  /**
   * An SDK error with a stable code that names the failure and its repair.
   *
   * @param message (string | undefined): what happened, with the fix when one applies.
   * @param options ({ cause?: unknown; code?: ErrorCode; field?: string } | undefined): the cause, the code when not the class default, and the argument, key, or setting at fault, when one is.
   */
  constructor(message?: string, options?: { cause?: unknown; code?: ErrorCode; field?: string }) {
    super(message, options);
    this.name = new.target.name;
    this.code = options?.code ?? (new.target as typeof SelfGraphError).code;
    if (options?.field !== undefined) this.field = options.field;
  }

  /**
   * How to repair this error's code, as its docs section says.
   *
   * @return (string): the repair.
   */
  get hint(): string {
    return HINTS[this.code];
  }

  /**
   * Whether the same call can succeed when run again unchanged.
   *
   * @return (boolean): true for a TransientError.
   */
  get retryable(): boolean {
    return this instanceof TransientError;
  }

  /**
   * The docs section for this error's code, at the installed release.
   *
   * @return (string): the URL.
   */
  get docs(): string {
    return `${DOCS_URL}#${this.code}`;
  }

  /**
   * The same docs section in the copy installed with the package, readable without a network.
   *
   * @return (string): the path, relative to the project root.
   */
  get agentGuide(): string {
    return `${AGENT_GUIDE}#${this.code}`;
  }

  /**
   * The error as JSON-ready fields, as the MCP server returns it.
   *
   * @return (ErrorFields): error, error_type, code, field when one is at fault, hint, retryable, docs, and agent_guide.
   */
  toJSON(): ErrorFields {
    return {
      error: this.message,
      error_type: this.name,
      code: this.code,
      ...(this.field === undefined ? {} : { field: this.field }),
      hint: this.hint,
      retryable: this.retryable,
      docs: this.docs,
      agent_guide: this.agentGuide,
    };
  }
}

export class ValidationError extends SelfGraphError {}

class ObjectError extends SelfGraphError {
  /**
   * An error about one stored object, naming its type and id.
   *
   * @param object_type (string): the object type, e.g. "Entity".
   * @param object_id (string): the object id.
   * @param state (string): what is wrong with it, e.g. "does not exist".
   * @param message (string | undefined): a message that replaces the default one.
   */
  constructor(
    readonly object_type: string,
    readonly object_id: string,
    state: string,
    message?: string,
  ) {
    super(message || `${object_type} ${pyRepr(object_id)} ${state}`);
  }
}

export class NotFoundError extends ObjectError {
  static override readonly code: ErrorCode = "not_found";

  /**
   * An error for an object that does not exist, naming its namespace and the closest existing id.
   *
   * @param objectType (string): the object type, such as "Entity".
   * @param objectId (string): the id that was looked up.
   * @param message (string | undefined): a message that replaces the default one.
   * @param options ({ namespace?: string; suggestion?: string | null } | undefined): the namespace that was searched, and the closest existing id when one is close.
   */
  constructor(
    objectType: string,
    objectId: string,
    message?: string,
    options: { namespace?: string; suggestion?: string | null } = {},
  ) {
    const where = options.namespace === undefined ? "" : ` in namespace ${pyRepr(options.namespace)}`;
    const guess = options.suggestion == null ? "" : `; did you mean ${pyRepr(options.suggestion)}?`;
    super(objectType, objectId, `does not exist${where}${guess}`, message);
  }
}

export class ConflictError extends ObjectError {
  static override readonly code: ErrorCode = "already_exists";

  constructor(objectType: string, objectId: string) {
    super(objectType, objectId, "already exists");
  }
}

export class ExtractionError extends SelfGraphError {
  static override readonly code: ErrorCode = "extraction_failed";
}

export class PromptTemplateError extends SelfGraphError {
  static override readonly code: ErrorCode = "invalid_prompt_template";
}

export class StoreError extends SelfGraphError {
  static override readonly code: ErrorCode = "query_failed";
}

export class TransientError extends StoreError {
  static override readonly code: ErrorCode = "write_conflict";
}

export const LLM_HINT = "pass llm in the SelfGraph options (or set SELFGRAPH_LLM_PROVIDER and SELFGRAPH_LLM_MODEL)";
export const STORE_CLOSED_MESSAGE = "this store is closed; create a new store for each SelfGraph";
export const TOKEN_HINT = "pass auth: TOKEN in the HydraDBStore options (or set SELFGRAPH_AUTH)";
export const STORE_KUZU_HINT = 'pass store: "kuzu" (or SELFGRAPH_STORE=kuzu)';
export const OTHER_ENGINE_HINT = 'pass store: "neo4j" (or store: "memgraph")';
export const DECAY_HINT = "run maintenance.decay({ dry_run: false }) first";
export const KEY_SOURCES = "api_key in the llm config (or SELFGRAPH_LLM_API_KEY)";

/**
 * The error for a feature that needs an LLM when none is configured.
 *
 * @param what (string): the feature, such as "level 'max'".
 * @return (ValidationError): the error, with code llm_required.
 */
export function needsLlm(what: string): ValidationError {
  return new ValidationError(`${what} needs an LLM: ${LLM_HINT}`, { code: "llm_required" });
}

/**
 * Name a connect or fromEnv setting with its environment variable, as library messages do.
 *
 * @param key (string): the setting name, such as "llm_model".
 * @return (string): the hint, such as "the llm_model option (or SELFGRAPH_LLM_MODEL)", which the CLI rewords to its flag.
 */
export function settingHint(key: string): string {
  return `the ${key} option (or SELFGRAPH_${key.toUpperCase()})`;
}

const SURFACE_HINTS: ReadonlyArray<readonly [string, string]> = [
  [LLM_HINT, "pass --llm-provider and --llm-model (or SELFGRAPH_LLM_*)"],
  [TOKEN_HINT, "pass --auth TOKEN (or SELFGRAPH_AUTH)"],
  [STORE_KUZU_HINT, "pass --store kuzu (or SELFGRAPH_STORE=kuzu)"],
  [OTHER_ENGINE_HINT, "pass --store neo4j (or memgraph)"],
  [DECAY_HINT, "run maintenance decay --apply first"],
  [KEY_SOURCES, "--llm-api-key (or SELFGRAPH_LLM_API_KEY)"],
  ...["uri", "llm_provider", "llm_model"].map(
    (key) => [settingHint(key), `--${key.replaceAll("_", "-")} (or SELFGRAPH_${key.toUpperCase()})`] as const,
  ),
];
const DRIVER_BOILERPLATE =
  /(?:Connection Failed\. )?Please ensure that your database is listening on the correct host and port[^.]*\. Note that the default encryption setting has changed in Neo4j 4\.0\.(?: See the docs for more information\.)?\s*/g;

/**
 * Reword a library message for the CLI and MCP server, which take the LLM from flags or the environment.
 *
 * @param message (string): the library message.
 * @return (string): the message with the library setting hints (llm, auth, store, uri, llm_model, and the like) replaced by the flag hints.
 */
export function surfaceHint(message: string): string {
  return SURFACE_HINTS.reduce((text, [library, surface]) => text.replaceAll(library, surface), message);
}

/**
 * Split a URI into its scheme and the rest, taking a scheme only when the URI starts with one followed by ://.
 *
 * @param uri (string): the URI, such as bolt://host:7687 or host:7687.
 * @return ([string, string]): the scheme, empty when there is none, and the text after its ://, or the whole URI.
 */
export function splitScheme(uri: string): [string, string] {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(uri);
  return match ? [uri.slice(0, match[0].length - 3), uri.slice(match[0].length)] : ["", uri];
}

const AT_SIGNS = ["@", "\uff20", "\ufe6b"];

export const UNENCODED_USERINFO =
  "the store URI has an unencoded character in its user or password; " +
  "percent-encode it (/ as %2F, ? as %3F, # as %23, @ as %40, [ as %5B, ] as %5D)";

/**
 * Split off a URI's scheme and find its authority.
 *
 * @param uri (string): the URI, with or without a scheme.
 * @return ([string, string]): the text after the scheme's :// (the whole URI when it has no scheme), and the authority
 *   at its start, which runs to the first /, ? or #.
 */
function uriAuthority(uri: string): [string, string] {
  const rest = splitScheme(uri)[1];
  return [rest, rest.split(/[/?#]/, 1)[0] ?? ""];
}

/**
 * Whether an authority holds non-ASCII text that NFKC turns into a /, ?, #, @, :, [ or ].
 *
 * Python's urlsplit refuses a netloc whose text NFKC turns into a /, ?, #, @ or : with a ValueError that quotes it,
 * and other parsers read such a character as part of the host, so a fullwidth ＠ sends the password to the DNS resolver.
 *
 * @param authority (string): the URI text between the scheme's :// and the first /, ? or #.
 * @return (boolean): true when one of its characters is non-ASCII and NFKC-normalizes to text holding a separator.
 */
function nfkcSeparator(authority: string): boolean {
  return Array.from(authority).some(
    (char) => char.codePointAt(0)! >= 0x80 && /[/?#@:[\]]/.test(char.normalize("NFKC")),
  );
}

/**
 * Reject a URI whose user or password holds an unencoded /, ?, #, @, [ or ], before any driver reads it.
 *
 * Drivers read such a URI as another host, port, path, or query and repeat pieces of the password in their errors,
 * so the message names the problem without quoting the URI. Brackets around an IPv6 host stay valid.
 *
 * @param uri (string): the store URI, with or without a scheme.
 * @return (void): nothing; throws ValidationError when the text between the scheme and the last @ (counting the
 *   fullwidth ＠ and small ﹫) holds a /, ?, #, [ or ], the authority holds more than one @, or the authority holds a
 *   character that NFKC turns into one of / ? # @ : [ ].
 */
export function requireEncodedUserinfo(uri: string): void {
  const [rest, authority] = uriAuthority(uri);
  const userinfo = rest.slice(0, Math.max(...AT_SIGNS.map((at) => rest.lastIndexOf(at)), 0));
  if (/[/?#[\]]/.test(userinfo) || authority.split("@").length > 2 || nfkcSeparator(authority)) {
    throw new ValidationError(UNENCODED_USERINFO, { code: "invalid_setting", field: "uri" });
  }
}

/**
 * Locate the user and password of a URI inside its authority.
 *
 * @param uri (string): the URI, with or without a scheme.
 * @return ([number, string]): the offset where the userinfo starts and the userinfo, which runs to the last @ before
 *   the first /, ? or # after any scheme, counting the fullwidth ＠ and small ﹫ that NFKC turns into @ (parsers that
 *   normalize read them as the separator); the userinfo is empty when the authority has none.
 */
function uriUserinfo(uri: string): [number, string] {
  const [rest, authority] = uriAuthority(uri);
  const end = Math.max(...AT_SIGNS.map((at) => authority.lastIndexOf(at)));
  return [uri.length - rest.length, authority.slice(0, Math.max(end, 0))];
}

/**
 * Hide the user and password of a URI so a message can show it.
 *
 * @param uri (string): the URI, such as redis://user:pass@host:6379.
 * @return (string): the URI with its userinfo replaced by ***, such as redis://***@host:6379.
 */
export function maskUri(uri: string): string {
  const [start, userinfo] = uriUserinfo(uri);
  return userinfo ? `${uri.slice(0, start)}***${uri.slice(start + userinfo.length)}` : uri;
}

/**
 * Replace the user and password of a URI with *** wherever a message shows them, raw or escaped.
 *
 * @param text (string): the message, which may quote the URI or repeat a driver's text about it.
 * @param uri (string | null | undefined): the configured URI.
 * @return (string): the message with each raw, repr, or JSON rendering of the whole URI replaced by the same
 *   rendering of the masked URI, then each such rendering of the userinfo before its separator replaced by ***.
 */
export function redactUri(text: string, uri: string | null | undefined): string {
  if (!uri) return text;
  const [start, userinfo] = uriUserinfo(uri);
  if (!userinfo) return text;
  const masked = maskUri(uri);
  const renders = [pyRepr, JSON.stringify, String] as ((value: string) => string)[];
  const whole = renders.reduce((out, render) => out.replaceAll(render(uri), () => render(masked)), text);
  const at = uri.charAt(start + userinfo.length);
  return [userinfo, pyRepr(userinfo).slice(1, -1), JSON.stringify(userinfo).slice(1, -1)].reduce(
    (out, form) => out.replaceAll(`${form}${at}`, () => `***${at}`),
    whole,
  );
}

/**
 * The message of a thrown value, or its text when it is not an Error.
 *
 * @param exc (unknown): the thrown value.
 * @return (string): the message.
 */
export function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * Render control characters as backslash escapes, the way repr shows quoted input.
 *
 * Engine error text can quote the query, so a raw escape byte in it would run in a
 * terminal or log viewer. Newline, carriage return, and tab get their short forms;
 * other C0/C1 controls, DEL, and lone surrogates get \xNN or \uNNNN.
 *
 * @param text (string): the text, such as an engine error message.
 * @return (string): the text with control characters escaped.
 */
export function escapeControls(text: string): string {
  return Array.from(text, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
      return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
    }
    return ch;
  }).join("");
}

const CONNECT_CODES: Readonly<Record<string, string>> = {
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ENOTFOUND: "host not found",
  EAI_AGAIN: "host lookup failed",
  EHOSTUNREACH: "host unreachable",
  ETIMEDOUT: "connection timed out",
};

const CAUSED_BY = /Caused by: \w+ (E[A-Z_]+)\b/;

type ErrorLinks = {
  code?: unknown;
  cause?: unknown;
  errors?: unknown;
  socketError?: unknown;
  address?: unknown;
  port?: unknown;
};

/**
 * The errors behind an error: its cause, a node-redis socketError, and AggregateError members.
 *
 * @param err (unknown): the error.
 * @return (unknown[]): the inner errors.
 */
function innerErrors(err: unknown): unknown[] {
  const e = err as ErrorLinks;
  return [e.cause, e.socketError, ...(Array.isArray(e.errors) ? e.errors : [])].filter((x) => x != null);
}

/**
 * The first error in a chain that carries a known connection error code.
 *
 * @param exc (unknown): the error.
 * @param seen (Set<unknown>): errors already visited.
 * @return (ErrorLinks | null): the error, or null when no known code is present.
 */
function connectError(exc: unknown, seen = new Set<unknown>()): ErrorLinks | null {
  if (exc == null || seen.has(exc)) return null;
  seen.add(exc);
  const code = (exc as ErrorLinks).code;
  if (typeof code === "string" && CONNECT_CODES[code] !== undefined) return exc as ErrorLinks;
  return innerErrors(exc).reduce<ErrorLinks | null>((found, inner) => found ?? connectError(inner, seen), null);
}

/**
 * The connection failure of an error chain with the address it failed on, such as "connection refused 127.0.0.1:11434".
 *
 * @param exc (unknown): the error.
 * @return (string): the failure, or "" when the chain holds no connection error.
 */
export function connectionFailure(exc: unknown): string {
  const err = connectError(exc);
  if (err === null) return "";
  const phrase = CONNECT_CODES[err.code as string]!;
  return typeof err.address === "string" ? `${phrase} ${err.address}${err.port ? `:${err.port}` : ""}` : phrase;
}

/**
 * Describe a failed connection in plain words ("connection refused") when the error chain, or a Bolt driver's "Caused by" text, says which.
 *
 * @param exc (unknown): the thrown value.
 * @return (string): the phrase, or the error's reason.
 */
export function connectionReason(exc: unknown): string {
  const code = connectError(exc)?.code ?? CAUSED_BY.exec(errorMessage(exc))?.[1];
  return CONNECT_CODES[code as string] ?? errorReason(exc);
}

/**
 * The reason an error gives, with an empty or dangling reason (such as "Cannot connect to API: ") filled in from a connection error code in its chain, else its causes, and with no trailing punctuation.
 *
 * @param exc (unknown): the thrown value.
 * @return (string): the reason, or the error name when nothing says more.
 */
export function errorReason(exc: unknown): string {
  const seen = new Set<unknown>();
  const reason = (err: unknown): string => {
    if (err == null || seen.has(err)) return "";
    seen.add(err);
    const text = errorMessage(err).split(/\s+/).join(" ").trim().replace(DRIVER_BOILERPLATE, "");
    const head = text.replace(/[\s.:;,]+$/, "");
    if (head && !/:[\s.]*$/.test(text)) return head;
    const code = (err as ErrorLinks).code;
    const found = connectError(err);
    const inner =
      (found && CONNECT_CODES[found.code as string]) ||
      innerErrors(err).reduce<string>((found, x) => found || reason(x), "") ||
      (typeof code === "string" ? code : "");
    return head && inner ? `${head}: ${inner}` : head || inner;
  };
  return reason(exc) || (exc instanceof Error ? exc.name : String(exc));
}
