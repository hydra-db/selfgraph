import { ValidationError } from "./errors.js";
import { pyRepr } from "./internal/py.js";

export const LEVELS = ["light", "balanced", "max"] as const;
export type Level = (typeof LEVELS)[number];
export const EXTRACTION_TIERS = ["regex", "spacy", "llm"] as const;
export type ExtractionTier = (typeof EXTRACTION_TIERS)[number];
export const SEED_TIERS = ["bm25", "synonyms", "embeddings"] as const;
export type SeedTier = (typeof SEED_TIERS)[number];

export const CAPABILITIES = ["extraction", "resolution", "contradiction", "seeds", "traversal"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const LADDERS: Readonly<Record<Capability, readonly string[]>> = {
  extraction: EXTRACTION_TIERS,
  resolution: ["exact", "default", "fuzzy", "llm"],
  contradiction: ["off", "warn", "supersede", "llm"],
  seeds: SEED_TIERS,
  traversal: ["bfs", "dfs", "ppr"],
};

export const PRESETS: Readonly<Record<Level, Readonly<Record<Capability, string>>>> = {
  light: { extraction: "regex", resolution: "exact", contradiction: "warn", seeds: "bm25", traversal: "bfs" },
  balanced: {
    extraction: "spacy",
    resolution: "default",
    contradiction: "warn",
    seeds: "synonyms",
    traversal: "bfs",
  },
  max: { extraction: "llm", resolution: "llm", contradiction: "llm", seeds: "embeddings", traversal: "ppr" },
};

export const CEILINGS: Readonly<Record<Level, Readonly<Record<Capability, string>>>> = {
  light: { extraction: "regex", resolution: "exact", contradiction: "supersede", seeds: "bm25", traversal: "ppr" },
  balanced: {
    extraction: "spacy",
    resolution: "fuzzy",
    contradiction: "supersede",
    seeds: "synonyms",
    traversal: "ppr",
  },
  max: { extraction: "llm", resolution: "llm", contradiction: "llm", seeds: "embeddings", traversal: "ppr" },
};

/**
 * Reject a level other than light, balanced, or max.
 *
 * @param field (string): the option name, for the error.
 * @param level (unknown): the level.
 */
export function requireLevel(field: string, level: unknown): asserts level is Level {
  if (!(LEVELS as readonly unknown[]).includes(level)) {
    throw new ValidationError(`${field} must be one of ${LEVELS.join(", ")}, got ${pyRepr(level)}`);
  }
}

/**
 * Reject a tier name that is not on a capability's ladder.
 *
 * @param capability (Capability): the ladder name.
 * @param tier (unknown): the tier.
 * @param field (string | null): the option name for the error, or null for the capability name.
 */
export function requireTier(
  capability: Capability,
  tier: unknown,
  field: string | null = null,
): asserts tier is string {
  const ladder = LADDERS[capability];
  if (!(ladder as readonly unknown[]).includes(tier)) {
    throw new ValidationError(`${field || capability} must be one of ${ladder.join(", ")}, got ${pyRepr(tier)}`);
  }
}

/**
 * Lower a tier to the highest one a cost cap allows on its ladder.
 *
 * @param capability (Capability): the ladder name.
 * @param tier (string): the requested tier.
 * @param maxTier (Level): the level whose ceiling caps the ladder.
 * @return (string): the tier, or the ceiling when the tier is above it.
 */
export function clamp(capability: Capability, tier: string, maxTier: Level): string {
  const ladder = LADDERS[capability];
  const ceiling = CEILINGS[maxTier][capability];
  return ladder.indexOf(tier) <= ladder.indexOf(ceiling) ? tier : ceiling;
}
