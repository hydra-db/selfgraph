import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ValidationError } from "./errors.js";
import { pyRepr } from "./internal/py.js";
import type { LLMConfig } from "./models.js";
import type { GraphStore } from "./protocols.js";
import { CypherStore, Neo4jStore } from "./stores/cypher.js";
import { FalkorDBStore } from "./stores/falkordb.js";
import { HydraDBStore } from "./stores/hydradb.js";
import { KuzuStore } from "./stores/kuzu.js";

export { version } from "../package.json";

export interface GraphSettings {
  store: string | null;
  uri: string | null;
  auth: string | null;
  database: string | null;
  namespace: string;
  llm_provider: string | null;
  llm_model: string | null;
  llm_api_key: string | null;
  llm_base_url: string | null;
}

export const DEFAULT_SETTINGS: Readonly<GraphSettings> = Object.freeze({
  store: null,
  uri: null,
  auth: null,
  database: null,
  namespace: "default",
  llm_provider: null,
  llm_model: null,
  llm_api_key: null,
  llm_base_url: null,
});

const ENV: Record<keyof GraphSettings, string> = {
  store: "SELFGRAPH_STORE",
  uri: "SELFGRAPH_URI",
  auth: "SELFGRAPH_AUTH",
  database: "SELFGRAPH_DATABASE",
  namespace: "SELFGRAPH_NAMESPACE",
  llm_provider: "SELFGRAPH_LLM_PROVIDER",
  llm_model: "SELFGRAPH_LLM_MODEL",
  llm_api_key: "SELFGRAPH_LLM_API_KEY",
  llm_base_url: "SELFGRAPH_LLM_BASE_URL",
};

/**
 * Read GraphSettings from SELFGRAPH_* environment variables; overrides win when set.
 *
 * @param overrides (Partial<GraphSettings>): field values that take precedence over the environment.
 * @param env (Record<string, string | undefined>): the environment to read, defaulting to process.env.
 * @return (GraphSettings): the resolved settings.
 */
export function settingsFromEnv(
  overrides: Partial<GraphSettings> = {},
  env: Record<string, string | undefined> = process.env,
): GraphSettings {
  const out: GraphSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(ENV) as Array<keyof GraphSettings>) {
    const value = overrides[key] ?? env[ENV[key]];
    if (value != null) Object.assign(out, { [key]: value });
  }
  return out;
}

function parseAuth(auth: string | null): [string, string] | null {
  if (!auth) return null;
  const i = auth.indexOf(":");
  if (i < 0) return ["neo4j", auth];
  return [auth.slice(0, i), auth.slice(i + 1)];
}

const boltOptions = (settings: GraphSettings) => ({ auth: parseAuth(settings.auth), database: settings.database });

/**
 * A FalkorDB store from "host:port" or a redis:// URL.
 *
 * @param uri (string): the address.
 * @return (GraphStore): the store.
 */
function falkorStore(uri: string): GraphStore {
  const url = new URL(uri.includes("://") ? uri : `redis://${uri}`);
  const host = url.hostname.replace(/^\[|\]$/g, "") || "localhost";
  return new FalkorDBStore(host, url.port ? Number(url.port) : 6379);
}

const SERVER_STORES: Record<string, { address: string; build: (uri: string, settings: GraphSettings) => GraphStore }> =
  {
    neo4j: { address: "a Bolt URI", build: (uri, s) => new Neo4jStore(uri, boltOptions(s)) },
    cypher: { address: "a Bolt URI", build: (uri, s) => new CypherStore(uri, boltOptions(s)) },
    hydradb: { address: "a Bolt URI", build: (uri, s) => new HydraDBStore(uri, boltOptions(s)) },
    falkordb: { address: "host:port", build: falkorStore },
  };

export const STORES: readonly string[] = [...Object.keys(SERVER_STORES), "kuzu"];

/**
 * Construct the store the settings name without connecting; unnamed, a URI means HydraDB and no URI an embedded Kuzu file under ~/.selfgraph.
 *
 * @param settings (GraphSettings): the resolved store configuration.
 * @return (GraphStore): the store.
 */
export function buildStore(settings: GraphSettings): GraphStore {
  const kind = (settings.store || (settings.uri ? "hydradb" : "kuzu")).toLowerCase();
  if (kind === "kuzu") {
    let path = settings.uri;
    if (!path) {
      path = join(homedir(), ".selfgraph", "default.kuzu");
      mkdirSync(dirname(path), { recursive: true });
    }
    return new KuzuStore(path);
  }
  const server = SERVER_STORES[kind];
  if (server === undefined) {
    throw new ValidationError(`unknown store ${pyRepr(settings.store)}; choose one of ${STORES.join(", ")}`);
  }
  if (!settings.uri) {
    throw new ValidationError(`the ${pyRepr(kind)} store needs ${server.address} (--uri / SELFGRAPH_URI)`);
  }
  return server.build(settings.uri, settings);
}

/**
 * The LLM configuration the settings name, or null when none is set.
 *
 * @param settings (GraphSettings): the resolved LLM configuration.
 * @return (LLMConfig | null): the LLM configuration.
 */
export function buildLlm(settings: GraphSettings): LLMConfig | null {
  if (!settings.llm_provider && !settings.llm_model) return null;
  if (!(settings.llm_provider && settings.llm_model))
    throw new ValidationError("an LLM needs both a provider and a model");
  return {
    provider: settings.llm_provider,
    model: settings.llm_model,
    api_key: settings.llm_api_key,
    base_url: settings.llm_base_url,
  };
}
