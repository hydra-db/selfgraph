import type { z } from "zod";

import {
  connectionFailure,
  ExtractionError,
  errorReason,
  KEY_SOURCES,
  settingHint,
  ValidationError,
} from "../errors.js";
import { Lazy } from "../internal/lazy.js";
import { loadOptional } from "../internal/optional.js";
import { comparePy, cpLen, pyRepr } from "../internal/py.js";
import { LLM_DEFAULTS, LLMConfig, type ParsedLLMConfig, parseOrThrow, requireMatchingPrefix } from "../models.js";
import type { LLMClient } from "../protocols.js";
import { didYouMean, suggestKey, typeName } from "../validate.js";

type Factory = (settings: Record<string, unknown>) => (modelId: string) => unknown;

type ProviderEntry = readonly [pkg: string, factory: string];

type ErrorContext = { provider: string; model: string; base_url?: string | null; prebuilt?: boolean };

const PROVIDERS: Record<string, ProviderEntry> = {
  anthropic: ["@ai-sdk/anthropic", "createAnthropic"],
  openai: ["@ai-sdk/openai", "createOpenAI"],
  azure: ["@ai-sdk/azure", "createAzure"],
  google: ["@ai-sdk/google", "createGoogleGenerativeAI"],
  gemini: ["@ai-sdk/google", "createGoogleGenerativeAI"],
  vertex: ["@ai-sdk/google-vertex", "createVertex"],
  vertex_ai: ["@ai-sdk/google-vertex", "createVertex"],
  bedrock: ["@ai-sdk/amazon-bedrock", "createAmazonBedrock"],
  mistral: ["@ai-sdk/mistral", "createMistral"],
  groq: ["@ai-sdk/groq", "createGroq"],
  xai: ["@ai-sdk/xai", "createXai"],
  deepseek: ["@ai-sdk/deepseek", "createDeepSeek"],
  cohere: ["@ai-sdk/cohere", "createCohere"],
  cerebras: ["@ai-sdk/cerebras", "createCerebras"],
  perplexity: ["@ai-sdk/perplexity", "createPerplexity"],
  togetherai: ["@ai-sdk/togetherai", "createTogetherAI"],
  together_ai: ["@ai-sdk/togetherai", "createTogetherAI"],
  fireworks: ["@ai-sdk/fireworks", "createFireworks"],
  fireworks_ai: ["@ai-sdk/fireworks", "createFireworks"],
  openrouter: ["@openrouter/ai-sdk-provider", "createOpenRouter"],
  gateway: ["@ai-sdk/gateway", "createGateway"],
};

const COMPATIBLE: ProviderEntry = ["@ai-sdk/openai-compatible", "createOpenAICompatible"];
const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const GOOGLE_KEY_ENV = ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes start with the ESC control character.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const BAD_KEY = /API[_ ]KEY[_ ]INVALID|api key not valid|(?:valid|invalid|incorrect) api key/i;
const KEY_HINT = `check the API key, set by ${KEY_SOURCES}`;
const MISSING_KEY = /missing .*api key|api_key client option must be set|missing credentials/i;
const KEY_VAR = /\b(?!SELFGRAPH_)[A-Z][A-Z0-9_]*_API_KEY\b/;
const KNOWN_PROVIDERS = [...Object.keys(PROVIDERS), "ollama"];
const SUMMARY_LIMIT = 300;
const RETRYABLE_OUTPUT_ERRORS = [
  "NoObjectGeneratedError",
  "NoOutputGeneratedError",
  "TypeValidationError",
  "JSONParseError",
];

function isOutputError(exc: unknown): boolean {
  const name = String((exc as { name?: unknown } | null)?.name ?? "");
  return name === "ZodError" || RETRYABLE_OUTPUT_ERRORS.some((n) => name.includes(n));
}

/**
 * Report whether a value is an AI SDK language model object.
 *
 * @param value (unknown): the value to test.
 * @return (boolean): true for a model object.
 */
function isLanguageModel(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && typeof (value as { doGenerate?: unknown }).doGenerate === "function"
  );
}

const isLlmClient = (value: object): value is LLMClient => typeof (value as Partial<LLMClient>).generate === "function";

/**
 * Report whether to send a temperature; Gemini models get none, since their sampling parameters are deprecated.
 *
 * @param modelId (string): the model id.
 * @return (boolean): false for any Gemini model.
 */
const sendsTemperature = (modelId: string): boolean => !modelId.toLowerCase().includes("gemini");

/**
 * Unwrap the AI SDK retry wrapper to the error of its last attempt.
 *
 * @param exc (unknown): the thrown value.
 * @return (unknown): the underlying error.
 */
function lastAttempt(exc: unknown): unknown {
  const wrapper = exc as { name?: unknown; lastError?: unknown } | null;
  return wrapper?.name === "AI_RetryError" && wrapper.lastError !== undefined ? wrapper.lastError : exc;
}

/**
 * Summarize an error as "ErrorType: first line", unwrapping retry wrappers, stripping ANSI codes, and capping the length; a connection error anywhere in the chain reads as its root cause, such as "connection refused 127.0.0.1:11434".
 *
 * @param exc (unknown): the thrown value.
 * @return (string): the one-line summary.
 */
export function summarizeError(exc: unknown): string {
  const err = lastAttempt(exc);
  const failure = connectionFailure(err);
  if (failure) return failure;
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  const first =
    message
      .replace(ANSI, "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const line = !first || /:[\s.]*$/.test(first) ? errorReason(err).replace(ANSI, "") : first;
  const text = `${name}: ${line}`;
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT - 3)}...`;
}

/**
 * Map an error no retry can fix (missing or bad key, denied access, unknown model) to one clear error.
 *
 * @param exc (unknown): the thrown value.
 * @param config ({ provider: string; model: string; base_url?: string | null }): the LLM settings, for the message.
 * @return (ExtractionError | null): the error to throw, or null when the call may succeed on retry or another chunk.
 */
function fatalError(exc: unknown, config: ErrorContext): ExtractionError | null {
  const err = lastAttempt(exc) as {
    name?: unknown;
    statusCode?: unknown;
    message?: unknown;
    responseBody?: unknown;
  } | null;
  const name = String(err?.name ?? "");
  const status = err?.statusCode;
  const message = `${String(err?.message ?? "")} ${String(err?.responseBody ?? "")}`;
  const provider = config.provider;
  const options = { cause: exc };
  if (name === "AI_LoadAPIKeyError" || MISSING_KEY.test(message)) {
    const envVar = KEY_VAR.exec(message)?.[0];
    if (config.prebuilt) {
      const set = envVar ? `set ${envVar}` : "set the provider package's key variable";
      return new ExtractionError(
        `no API key for LLM provider ${provider}: SelfGraph cannot pass a key to a prebuilt AI SDK model; ` +
          `${set}, or pass apiKey when you create the provider`,
        options,
      );
    }
    const google = ["google", "gemini"].includes(provider.toLowerCase());
    const keyVar = google ? `${GOOGLE_KEY_ENV.slice(0, -1).join(", ")}, or ${GOOGLE_KEY_ENV.at(-1)}` : envVar;
    const own = keyVar ? `the provider's ${keyVar} variable` : "the provider's own key variable";
    return new ExtractionError(`no API key for LLM provider ${provider}: pass ${KEY_SOURCES}, or set ${own}`, options);
  }
  if (name === "GatewayAuthenticationError" || status === 401 || BAD_KEY.test(message)) {
    return new ExtractionError(`LLM authentication failed for provider ${provider}: ${KEY_HINT}`, options);
  }
  if (name === "GatewayForbiddenError" || status === 403) {
    return new ExtractionError(
      `LLM access denied for provider ${provider} and model ${JSON.stringify(config.model)}: ${KEY_HINT}`,
      options,
    );
  }
  if (["AI_NoSuchModelError", "GatewayModelNotFoundError", "GatewayNotFoundError"].includes(name) || status === 404) {
    const where = config.base_url ? ` at ${config.base_url}` : "";
    return new ExtractionError(
      `LLM model ${JSON.stringify(config.model)} was not found for provider ${provider}${where}: ` +
        `check ${settingHint("llm_model")} and the provider`,
      options,
    );
  }
  return null;
}

/**
 * Reject a provider with no AI SDK package unless base_url names an OpenAI-compatible endpoint, suggesting the closest one.
 *
 * @param config (ParsedLLMConfig): the parsed LLM settings.
 */
function requireProvider(config: ParsedLLMConfig): void {
  const provider = config.provider.toLowerCase();
  if (KNOWN_PROVIDERS.includes(provider) || config.base_url != null) return;
  const hint = didYouMean(suggestKey(provider, [...KNOWN_PROVIDERS].sort(comparePy), cpLen(provider) < 5 ? 1 : 2));
  throw new ValidationError(
    `unknown LLM provider ${pyRepr(config.provider)}: use one of ${KNOWN_PROVIDERS.join(", ")}, set base_url for an ` +
      `OpenAI-compatible endpoint, or pass an AI SDK model as llm${hint}`,
  );
}

/**
 * The AI SDK package and factory that serve a configured provider: its own package, else the OpenAI-compatible one for ollama or a base_url.
 *
 * @param config (ParsedLLMConfig): the parsed LLM settings.
 * @return (ProviderEntry): the package name and factory export.
 */
function providerEntry(config: ParsedLLMConfig): ProviderEntry {
  return usesCompatible(config) ? COMPATIBLE : PROVIDERS[config.provider.toLowerCase()]!;
}

const usesCompatible = (config: ParsedLLMConfig): boolean =>
  config.provider.toLowerCase() === "ollama" ||
  (PROVIDERS[config.provider.toLowerCase()] === undefined && config.base_url != null);

/**
 * Wrap fetch to report each call's connection failure, or null on a response, so an error the AI SDK replaces (an abort during a retry delay) can still name its root cause.
 *
 * @param record ((error: unknown) => void): receives the connection error of a failed call, or null.
 * @return (typeof fetch): the wrapped fetch.
 */
function recordingFetch(record: (error: unknown) => void): typeof fetch {
  return async (input, init) => {
    try {
      const response = await fetch(input, init);
      record(null);
      return response;
    } catch (error) {
      if (connectionFailure(error)) record(error);
      throw error;
    }
  };
}

/**
 * Create the AI SDK model a config names, its provider calling through a fetch that records connection failures.
 *
 * @param config (ParsedLLMConfig): the parsed LLM settings.
 * @param record ((error: unknown) => void): receives each call's connection error, or null.
 * @return (Promise<unknown>): the language model.
 */
async function resolveModel(config: ParsedLLMConfig, record: (error: unknown) => void): Promise<unknown> {
  const provider = config.provider.toLowerCase();
  const prefix = `${config.provider}/`;
  const modelId = config.model.startsWith(prefix) ? config.model.slice(prefix.length) : config.model;
  const settings: Record<string, unknown> = { fetch: recordingFetch(record) };
  if (config.api_key != null) settings.apiKey = config.api_key;
  else if (provider === "google" || provider === "gemini") {
    const fallback = GOOGLE_KEY_ENV.map((name) => process.env[name]).find(Boolean);
    if (fallback) settings.apiKey = fallback;
  }

  const [pkg, factoryName] = providerEntry(config);
  if (usesCompatible(config)) {
    settings.name = provider;
    settings.baseURL = config.base_url ?? OLLAMA_BASE_URL;
  } else if (config.base_url != null) {
    settings.baseURL = config.base_url;
  }
  const mod = await loadOptional<Record<string, unknown>>(
    pkg,
    `the ${config.provider} provider needs 'ai' and '${pkg}'; npm install ai ${pkg}`,
    ExtractionError,
  );
  const factory = mod[factoryName] as Factory | undefined;
  if (typeof factory !== "function") throw new ExtractionError(`${pkg} does not export ${factoryName}`);
  const instance = factory(settings) as ((modelId: string) => unknown) & { chat?: (modelId: string) => unknown };
  if (provider === "openai" && config.base_url != null && typeof instance.chat === "function") {
    return instance.chat(modelId);
  }
  return instance(modelId);
}

class AISDKClient implements LLMClient {
  private connectionError: unknown = null;
  private readonly model = new Lazy(() =>
    "model" in this.source
      ? Promise.resolve(this.source.model)
      : resolveModel(this.source.config, (error) => {
          this.connectionError = error;
        }),
  );

  constructor(
    private readonly source: { config: ParsedLLMConfig } | { model: unknown; provider: string; modelId: string },
    private readonly temperature: number,
    private readonly maxRetries: number,
    private readonly timeout: number | null,
    readonly concurrency: number = LLM_DEFAULTS.concurrency,
  ) {}

  /**
   * The error to report for a failed call: an abort (the timeout firing, often during a retry delay, which hides the attempt's error) becomes the last connection failure, else a timeout naming its length.
   *
   * @param exc (unknown): the thrown value.
   * @return (unknown): the error to report.
   */
  private rootCause(exc: unknown): unknown {
    if ((exc as { name?: unknown } | null)?.name !== "AbortError") return exc;
    if (this.connectionError !== null) return this.connectionError;
    if (this.timeout === null) return exc;
    const timeout = new Error(`LLM call timed out after ${this.timeout}s`, { cause: exc });
    timeout.name = "TimeoutError";
    return timeout;
  }

  /**
   * Call the model and parse its reply into the requested schema, re-asking when the reply does not validate.
   *
   * @param args ({ system: string; user: string; output: z.ZodType<T> }): the system prompt, the user prompt, and the zod schema of the output.
   * @return (T): the parsed structured output.
   */
  async generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T> {
    if (typeof (args.output as { safeParse?: unknown } | null)?.safeParse !== "function") {
      throw new ValidationError("output must be a zod schema");
    }
    const ai = await loadOptional<{
      generateText: (options: Record<string, unknown>) => Promise<{ output: unknown }>;
      Output: { object: (options: { schema: unknown }) => unknown };
    }>(
      "ai",
      `LLM extraction needs the 'ai' package (AI SDK 6 or newer); npm install ai${
        "config" in this.source ? ` ${providerEntry(this.source.config)[0]}` : ""
      }`,
      ExtractionError,
    );
    const model = await this.model.get();
    const config: ErrorContext =
      "config" in this.source
        ? this.source.config
        : { provider: this.source.provider, model: this.source.modelId, prebuilt: true };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await ai.generateText({
          model,
          system: args.system || undefined,
          prompt: args.user,
          output: ai.Output.object({ schema: args.output }),
          temperature: sendsTemperature(config.model) ? this.temperature : undefined,
          maxRetries: this.maxRetries,
          abortSignal: this.timeout === null ? undefined : AbortSignal.timeout(this.timeout * 1000),
        });
        return args.output.parse(result.output);
      } catch (exc) {
        if (attempt < this.maxRetries && isOutputError(exc)) continue;
        const cause = this.rootCause(exc);
        throw fatalError(cause, config) ?? cause;
      }
    }
  }
}

/**
 * Parse an LLM config and reject a model prefix that conflicts with the provider or a provider with no AI SDK package.
 *
 * @param config (LLMConfig): the provider, model, and connection settings.
 * @return (ParsedLLMConfig): the parsed settings.
 */
export function checkLlmConfig(config: LLMConfig): ParsedLLMConfig {
  const parsed = parseOrThrow(LLMConfig, config, "llm config");
  requireMatchingPrefix(parsed.provider, parsed.model, parsed.base_url);
  requireProvider(parsed);
  return parsed;
}

/**
 * Build an LLM client that routes to any provider through the matching AI SDK package.
 *
 * @param config (LLMConfig): the provider, model, and connection settings.
 * @return (LLMClient): the client.
 */
export function buildLlmClient(config: LLMConfig): LLMClient {
  const parsed = checkLlmConfig(config);
  return new AISDKClient(
    { config: parsed },
    parsed.temperature,
    parsed.max_retries,
    parsed.timeout,
    parsed.concurrency,
  );
}

export type LLMArg = LLMConfig | LLMClient | object | null | undefined;

/**
 * Normalise the llm argument: an LLMConfig, an LLMClient, or an AI SDK model object.
 *
 * @param llm (LLMArg): the llm argument.
 * @return (LLMClient | null): the client, or null.
 */
export function resolveLlm(llm: LLMArg): LLMClient | null {
  if (llm == null) return null;
  if (typeof llm === "object" && isLlmClient(llm)) return llm;
  if (isLanguageModel(llm)) {
    const { provider, modelId } = llm as { provider?: unknown; modelId?: unknown };
    return new AISDKClient(
      { model: llm, provider: String(provider ?? "ai-sdk"), modelId: String(modelId ?? "") },
      LLM_DEFAULTS.temperature,
      LLM_DEFAULTS.max_retries,
      LLM_DEFAULTS.timeout,
    );
  }
  if (typeof llm === "object" && ("provider" in llm || "model" in llm)) return buildLlmClient(llm as LLMConfig);
  throw new ValidationError(
    "llm must be an LLMConfig ({ provider, model, api_key?, base_url?, timeout? }), an AI SDK language model, or an " +
      `LLMClient with a generate({ system, user, output }) function; got ${typeName(llm)}`,
  );
}
