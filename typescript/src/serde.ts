import { dumps, loads } from "./internal/json.js";
import { fromIso, toIso } from "./internal/time.js";
import {
  type DecisionStep,
  type DecisionTrace,
  type Entity,
  type Evidence,
  EvidenceSchema,
  type JsonObject,
  type Kind,
  type Preference,
  type Relation,
  type Status,
} from "./models.js";
import type { Props } from "./protocols.js";

/**
 * Normalize evidence to the full stored shape, with every optional field present as null.
 *
 * @param e (Partial<Evidence> & Pick<Evidence, "source_id" | "source_version">): the evidence.
 * @return (Evidence): the normalized evidence.
 */
export function evidenceOf(e: Partial<Evidence> & Pick<Evidence, "source_id" | "source_version">): Evidence {
  return {
    source_id: e.source_id,
    source_version: e.source_version,
    chunk_id: e.chunk_id ?? null,
    quote: e.quote ?? null,
    start_offset: e.start_offset ?? null,
    end_offset: e.end_offset ?? null,
    confidence: e.confidence ?? null,
  };
}

export function encodeEvidenceProps(args: { ns: string; id: string; target_id: string; evidence: Evidence }): Props {
  return { id: args.id, ns: args.ns, target_id: args.target_id, ...evidenceOf(args.evidence) };
}

export function decodeEvidence(props: Props): Evidence {
  return EvidenceSchema.parse(evidenceOf(props as unknown as Evidence));
}

const str = (v: unknown): string => v as string;
const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : (v as string));
const optNum = (v: unknown): number | null => (v === undefined || v === null ? null : Number(v));
const date = (v: unknown): Date => fromIso(v)!;
const count = (v: unknown): number => Math.trunc(Number(v ?? 0)) || 0;

export function encodeEntityProps(args: {
  ns: string;
  id: string;
  type: string;
  name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  properties: JsonObject;
  source_count: number;
  created_at: Date;
  updated_at: Date;
}): Props {
  return {
    id: args.id,
    ns: args.ns,
    type: args.type,
    name: args.name,
    aliases: [...args.aliases],
    external_ids_json: dumps(args.external_ids),
    properties_json: dumps(args.properties),
    source_count: args.source_count,
    created_at: toIso(args.created_at),
    updated_at: toIso(args.updated_at),
  };
}

export function decodeEntity(props: Props): Entity {
  return {
    id: str(props.id),
    type: str(props.type),
    name: str(props.name),
    aliases: [...((props.aliases as string[] | null | undefined) ?? [])],
    external_ids: loads(props.external_ids_json, {}),
    properties: loads(props.properties_json, {}),
    source_count: count(props.source_count),
    created_at: date(props.created_at),
    updated_at: date(props.updated_at),
  };
}

export function encodeRelationProps(args: {
  ns: string;
  id: string;
  revision: number;
  properties: JsonObject;
  event_time: Date | null;
  created_at: Date;
  is_current: boolean;
  source_count: number;
}): Props {
  return {
    id: args.id,
    ns: args.ns,
    revision: args.revision,
    is_current: args.is_current,
    created_at: toIso(args.created_at),
    event_time: toIso(args.event_time),
    properties_json: dumps(args.properties),
    source_count: args.source_count,
  };
}

export function decodeRelation(props: Props, edge: { from_entity: string; to_entity: string; type: string }): Relation {
  return {
    id: str(props.id),
    revision: Math.trunc(Number(props.revision)),
    from_entity: edge.from_entity,
    type: edge.type,
    to_entity: edge.to_entity,
    properties: loads(props.properties_json, {}),
    event_time: fromIso(props.event_time),
    created_at: date(props.created_at),
    is_current: Boolean(props.is_current),
    source_count: count(props.source_count),
  };
}

export function encodePreferenceProps(args: {
  ns: string;
  id: string;
  revision: number;
  subject_entity: string;
  key: string;
  about_entity: string | null;
  strength: number | null;
  properties: JsonObject;
  event_time: Date | null;
  created_at: Date;
  is_current: boolean;
}): Props {
  return {
    id: args.id,
    ns: args.ns,
    revision: args.revision,
    is_current: args.is_current,
    subject_entity: args.subject_entity,
    key: args.key,
    about_entity: args.about_entity,
    strength: args.strength,
    properties_json: dumps(args.properties),
    event_time: toIso(args.event_time),
    created_at: toIso(args.created_at),
  };
}

export function decodePreference(
  props: Props,
  edge: { value_entity: string; profile_id: string; kind: Kind },
): Preference {
  return {
    id: str(props.id),
    revision: Math.trunc(Number(props.revision)),
    profile_id: edge.profile_id,
    subject_entity: str(props.subject_entity),
    kind: edge.kind,
    key: str(props.key),
    value_entity: edge.value_entity,
    about_entity: optStr(props.about_entity),
    strength: optNum(props.strength),
    properties: loads(props.properties_json, {}),
    event_time: fromIso(props.event_time),
    created_at: date(props.created_at),
    is_current: Boolean(props.is_current),
  };
}

export function encodeTraceProps(args: {
  ns: string;
  id: string;
  title: string;
  actor_entity: string | null;
  summary: string | null;
  rationale: string | null;
  status: string;
  outcome_entity: string | null;
  alternative_entities: string[];
  event_time: Date | null;
  created_at: Date;
  updated_at: Date;
}): Props {
  return {
    id: args.id,
    ns: args.ns,
    title: args.title,
    actor_entity: args.actor_entity,
    summary: args.summary,
    rationale: args.rationale,
    status: args.status,
    outcome_entity: args.outcome_entity,
    alternative_entities_json: dumps([...args.alternative_entities]),
    event_time: toIso(args.event_time),
    created_at: toIso(args.created_at),
    updated_at: toIso(args.updated_at),
  };
}

export function decodeTrace(props: Props, steps: DecisionStep[]): DecisionTrace {
  return {
    id: str(props.id),
    actor_entity: optStr(props.actor_entity),
    title: str(props.title),
    summary: optStr(props.summary),
    rationale: optStr(props.rationale),
    status: str(props.status) as Status,
    outcome_entity: optStr(props.outcome_entity),
    alternative_entities: loads(props.alternative_entities_json, []),
    steps,
    event_time: fromIso(props.event_time),
    created_at: date(props.created_at),
    updated_at: date(props.updated_at),
  };
}
