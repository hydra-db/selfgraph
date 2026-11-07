import type { z } from "zod";

import { ExtractionError } from "../errors.js";
import { Lazy } from "../internal/lazy.js";
import { loadOptional } from "../internal/optional.js";
import { LLM_DEFAULTS, LLMConfig, type ParsedLLMConfig } from "../models.js";
import type { LLMClient } from "../protocols.js";

type Factory = (settings: Record<string, unknown>) => (modelId: string) => unknown;

type ProviderEntry = readonly [pkg: string, factory: string];

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

async function resolveModel(config: ParsedLLMConfig): Promise<unknown> {
  const provider = config.provider.toLowerCase();
  const prefix = `${config.provider}/`;
  const modelId = config.model.startsWith(prefix) ? config.model.slice(prefix.length) : config.model;
  const settings: Record<string, unknown> = {};
  if (config.api_key != null) settings.apiKey = config.api_key;

  let entry = PROVIDERS[provider];
  if (provider === "ollama" || (entry === undefined && config.base_url != null)) {
    entry = COMPATIBLE;
    settings.name = provider;
    settings.baseURL = config.base_url ?? OLLAMA_BASE_URL;
  } else if (config.base_url != null) {
    settings.baseURL = config.base_url;
  }
  if (entry === undefined) {
    throw new ExtractionError(
      `unknown LLM provider ${JSON.stringify(config.provider)}; use one of ${Object.keys(PROVIDERS).join(", ")}, ` +
        "ollama, set base_url for an OpenAI-compatible endpoint, or pass an AI SDK model as llm",
    );
  }
  const [pkg, factoryName] = entry;
  const mod = await loadOptional<Record<string, unknown>>(
    pkg,
    `the ${config.provider} provider needs 'ai' and '${pkg}'; npm install ai ${pkg}`,
    ExtractionError,
  );
  const factory = mod[factoryName] as Factory | undefined;
  if (typeof factory !== "function") throw new ExtractionError(`${pkg} does not export ${factoryName}`);
  return factory(settings)(modelId);
}

class AISDKClient implements LLMClient {
  private readonly model = new Lazy(() =>
    "model" in this.source ? Promise.resolve(this.source.model) : resolveModel(this.source.config),
  );

  constructor(
    private readonly source: { config: ParsedLLMConfig } | { model: unknown },
    private readonly temperature: number,
    private readonly maxRetries: number,
  ) {}

  /**
   * Call the model and parse its reply into the requested schema, re-asking when the reply does not validate.
   *
   * @param args ({ system: string; user: string; output: z.ZodType<T> }): the system prompt, the user prompt, and the zod schema of the output.
   * @return (T): the parsed structured output.
   */
  async generate<T>(args: { system: string; user: string; output: z.ZodType<T> }): Promise<T> {
    const ai = await loadOptional<{
      generateText: (options: Record<string, unknown>) => Promise<{ output: unknown }>;
      Output: { object: (options: { schema: unknown }) => unknown };
    }>("ai", "LLM extraction needs the 'ai' package (AI SDK 6 or newer); npm install ai", ExtractionError);
    const model = await this.model.get();
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await ai.generateText({
          model,
          system: args.system || undefined,
          prompt: args.user,
          output: ai.Output.object({ schema: args.output }),
          temperature: this.temperature,
          maxRetries: this.maxRetries,
        });
        return args.output.parse(result.output);
      } catch (exc) {
        if (attempt < this.maxRetries && isOutputError(exc)) continue;
        throw exc;
      }
    }
  }
}

/**
 * Build an LLM client that routes to any provider through the matching AI SDK package.
 *
 * @param config (LLMConfig): the provider, model, and connection settings.
 * @return (LLMClient): the client.
 */
export function buildLlmClient(config: LLMConfig): LLMClient {
  const parsed = LLMConfig.parse(config);
  return new AISDKClient({ config: parsed }, parsed.temperature, parsed.max_retries);
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
  if (isLlmClient(llm)) return llm;
  if (isLanguageModel(llm)) return new AISDKClient({ model: llm }, LLM_DEFAULTS.temperature, LLM_DEFAULTS.max_retries);
  return buildLlmClient(llm as LLMConfig);
}
