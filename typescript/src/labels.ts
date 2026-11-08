export const KINDS = ["preference", "disinterest"] as const;

type Kind = (typeof KINDS)[number];

export const L_ENTITY = "Entity";
export const L_PROFILE = "Profile";
export const L_TRACE = "DecisionTrace";
export const L_STEP = "DecisionStep";
export const L_SOURCE = "Source";
export const L_SOURCE_VERSION = "SourceVersion";
export const L_CHUNK = "Chunk";
export const L_EVIDENCE = "Evidence";

export const R_HAS_PROFILE = "HAS_PROFILE";
export const R_PREFERS = "PREFERS";
export const R_AVOIDS = "AVOIDS";
export const R_MADE_DECISION = "MADE_DECISION";
export const R_HAS_STEP = "HAS_STEP";
export const R_FROM = "FROM";
export const R_TO = "TO";
export const R_RESULTED_IN = "RESULTED_IN";
export const R_CONSIDERED = "CONSIDERED";
export const R_HAS_VERSION = "HAS_VERSION";
export const R_HAS_CHUNK = "HAS_CHUNK";

export const LABELS: readonly string[] = [
  L_ENTITY,
  L_PROFILE,
  L_TRACE,
  L_STEP,
  L_SOURCE,
  L_SOURCE_VERSION,
  L_CHUNK,
  L_EVIDENCE,
];

export const EDGE_TYPES: ReadonlySet<string> = new Set([
  R_HAS_PROFILE,
  R_PREFERS,
  R_AVOIDS,
  R_MADE_DECISION,
  R_HAS_STEP,
  R_FROM,
  R_TO,
  R_RESULTED_IN,
  R_CONSIDERED,
  R_HAS_VERSION,
  R_HAS_CHUNK,
]);

const PREFERENCE_EDGES: Readonly<Record<Kind, string>> = { preference: R_PREFERS, disinterest: R_AVOIDS };
export const PREFERENCE_EDGE_TYPES: readonly string[] = Object.values(PREFERENCE_EDGES);
const KIND_OF_EDGE = new Map(Object.entries(PREFERENCE_EDGES).map(([kind, type]) => [type, kind as Kind]));

/**
 * The edge type that stores a preference of the given kind.
 *
 * @param kind (Kind): the preference kind.
 * @return (string): R_PREFERS or R_AVOIDS.
 */
export function preferenceEdgeType(kind: Kind): string {
  return PREFERENCE_EDGES[kind];
}

/**
 * The preference kind an edge type stores, or null when the edge is not a preference.
 *
 * @param type (string): the edge type.
 * @return (Kind | null): the kind.
 */
export function preferenceKindOf(type: string): Kind | null {
  return KIND_OF_EDGE.get(type) ?? null;
}

/**
 * The id of the internal edge that links a parent node to its profile, version, or chunk child.
 *
 * @param edgeType (string): R_HAS_PROFILE, R_HAS_VERSION, or R_HAS_CHUNK; its lowercased letters prefix the id.
 * @param childId (string): the child node id.
 * @return (string): the edge id, e.g. "hasversion:<childId>".
 */
export function childEdgeId(
  edgeType: typeof R_HAS_PROFILE | typeof R_HAS_VERSION | typeof R_HAS_CHUNK,
  childId: string,
): string {
  return `${edgeType.replace(/_/g, "").toLowerCase()}:${childId}`;
}
