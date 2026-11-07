import {
  type DateTimeInput,
  type DeleteResult,
  type EvidenceInput,
  type JsonObject,
  type Page,
  parseDate,
  type Relation,
} from "../models.js";
import * as ops from "../ops.js";
import { keysOf, rejectUnknown } from "../validate.js";
import { paginate, parseEvidence, Resource } from "./common.js";

export interface RelationCreateOptions {
  id?: string | null;
  properties?: JsonObject | null;
  event_time?: DateTimeInput | null;
  evidence?: readonly EvidenceInput[];
}

export interface RelationListOptions {
  from_entity?: string | null;
  type?: string | null;
  to_entity?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface RelationUpdateOptions {
  set_properties?: JsonObject | null;
  remove_properties?: readonly string[];
  event_time?: DateTimeInput | null;
  evidence?: readonly EvidenceInput[] | null;
}

const UPDATE_KEYS = keysOf<RelationUpdateOptions>({
  set_properties: true,
  remove_properties: true,
  event_time: true,
  evidence: true,
});

export class Relations extends Resource {
  async create(
    fromEntity: string,
    type: string,
    toEntity: string,
    options: RelationCreateOptions = {},
  ): Promise<Relation> {
    const eventTime = parseDate(options.event_time);
    const evidence = parseEvidence(options.evidence ?? []);
    return this.graph.write((tx, ns) =>
      ops.createRelation(tx, ns, {
        from_entity: fromEntity,
        type,
        to_entity: toEntity,
        id: options.id,
        properties: options.properties ?? null,
        event_time: eventTime,
        evidence,
      }),
    );
  }

  async get(id: string): Promise<Relation | null> {
    return this.graph.read((store, ns) => ops.getRelationCurrent(store, ns, id));
  }

  async list(options: RelationListOptions = {}): Promise<Page<Relation>> {
    return this.page(options, (store, ns, window) =>
      ops.listRelations(store, ns, {
        from_entity: options.from_entity,
        type: options.type,
        to_entity: options.to_entity,
        ...window,
      }),
    );
  }

  iterate(options: Omit<RelationListOptions, "cursor"> = {}): AsyncGenerator<Relation> {
    return paginate((cursor) => this.list({ ...options, cursor }));
  }

  /**
   * Create a new version of a relation with merged properties; an unchanged update is a no-op.
   *
   * @param id (string): the relation id.
   * @param options (RelationUpdateOptions): properties to set and remove, a new valid time, and evidence to attach.
   * @return (Relation): the current version.
   */
  async update(id: string, options: RelationUpdateOptions = {}): Promise<Relation> {
    rejectUnknown("relation", options, UPDATE_KEYS);
    const eventTime = parseDate(options.event_time);
    const evidence = options.evidence == null ? null : parseEvidence(options.evidence);
    return this.graph.write((tx, ns) =>
      ops.updateRelation(tx, ns, id, {
        set_properties: options.set_properties ?? null,
        remove_properties: [...(options.remove_properties ?? [])],
        event_time: eventTime,
        evidence,
      }),
    );
  }

  async versions(id: string, options: { newest_first?: boolean } = {}): Promise<Relation[]> {
    return this.graph.read((store, ns) => ops.listRelationVersions(store, ns, id, options.newest_first ?? true));
  }

  /**
   * Delete a relation, all its versions, and any decision trace that uses it as a step.
   *
   * @param id (string): the relation id.
   * @return (DeleteResult): counts of what was removed.
   */
  async delete(id: string): Promise<DeleteResult> {
    return this.graph.write((tx, ns) => ops.deleteRelation(tx, ns, id));
  }
}
