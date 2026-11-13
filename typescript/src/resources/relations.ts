import { judgeContradictions } from "../contradiction.js";
import { NotFoundError } from "../errors.js";
import { pyStrip } from "../internal/py.js";
import type {
  DateTimeInput,
  DeleteResult,
  Evidence,
  EvidenceInput,
  InsertWarning,
  JsonObject,
  Page,
  Relation,
} from "../models.js";
import * as ops from "../ops.js";
import { type ContradictionMode, canonicalRelationType, warnSchema } from "../schema.js";
import { checkOptions, keysOf, parseTime } from "../validate.js";
import { PAGE_KEYS, type PageOptions, paginate, parseEvidence, Resource, VERSIONS_KEYS } from "./common.js";

export interface RelationCreateOptions {
  id?: string | null;
  properties?: JsonObject | null;
  event_time?: DateTimeInput | null;
  evidence?: readonly EvidenceInput[];
  contradiction?: ContradictionMode | null;
}

export interface RelationListOptions {
  from_entity?: string | null;
  type?: string | null;
  to_entity?: string | null;
  cursor?: string | null;
  limit?: number;
  include_invalidated?: boolean;
}

export interface RelationUpdateOptions {
  set_properties?: JsonObject | null;
  remove_properties?: readonly string[];
  event_time?: DateTimeInput | null;
  evidence?: readonly EvidenceInput[] | null;
}

const CREATE_KEYS = keysOf<RelationCreateOptions>({
  id: true,
  properties: true,
  event_time: true,
  evidence: true,
  contradiction: true,
});
const LIST_KEYS = keysOf<RelationListOptions>({
  from_entity: true,
  type: true,
  to_entity: true,
  cursor: true,
  limit: true,
  include_invalidated: true,
});
const UPDATE_KEYS = keysOf<RelationUpdateOptions>({
  set_properties: true,
  remove_properties: true,
  event_time: true,
  evidence: true,
});

export class Relations extends Resource {
  /**
   * Create a relation, or reassert one a contradiction invalidated, as a new current version.
   *
   * A reassertion carries exactly the given properties and emits a "relation_reasserted" warning naming the retired revision.
   *
   * Under contradiction mode llm the cardinality rules run as supersede, then the LLM judges older rival relations and retires the ones the new relation makes untrue.
   *
   * In strict schema mode a max_count conflict with the stored graph throws ValidationError, unless the contradiction mode is supersede, which retires the older relation instead, or off, which skips max_count checks.
   *
   * @param fromEntity (string): the source entity id.
   * @param type (string): the relation type, normalized to UPPER_SNAKE; a schema alias becomes the schema's type.
   * @param toEntity (string): the destination entity id.
   * @param options (RelationCreateOptions): an explicit id, properties, event time, evidence, and a per-call contradiction mode whose warnings go to stderr.
   * @return (Relation): the created relation; throws ConflictError when the id already exists.
   */
  async create(
    fromEntity: string,
    type: string,
    toEntity: string,
    options: RelationCreateOptions = {},
  ): Promise<Relation> {
    checkOptions("relations.create", options, CREATE_KEYS);
    const eventTime = parseTime(options.event_time, "event_time");
    const evidence = parseEvidence(options.evidence ?? []);
    const { judged, ...conflicts } = this.graph.contradictionFor(options.contradiction, this.graph.schema);
    const strict = this.graph.schemaMode === "strict" && conflicts.contradiction === "warn";
    const rtype = typeof type === "string" && pyStrip(type) ? canonicalRelationType(type, this.graph.schema) : type;
    const { llm } = this.graph.tiers;
    const warnings: InsertWarning[] = [];
    const rel = await this.graph.write(async (tx, ns) => {
      warnings.length = 0;
      const created = await ops.createRelation(
        tx,
        ns,
        {
          from_entity: fromEntity,
          type: rtype,
          to_entity: toEntity,
          id: options.id,
          properties: options.properties ?? null,
          event_time: eventTime,
          evidence,
        },
        this.graph.schemaCheck,
        { ...conflicts, ...(strict && { contradiction: "strict" }), warnings },
      );
      if (judged && llm !== null) warnings.push(...(await judgeContradictions(tx, ns, llm, [created], conflicts.caps)));
      return created;
    });
    warnSchema(warnings);
    return rel;
  }

  /**
   * Fetch the current version of a relation.
   *
   * @param id (string): the relation id.
   * @return (Relation | null): the current version, or null when the id is unknown or a contradiction retired it; versions and list({ include_invalidated: true }) still return a retired relation.
   */
  async get(id: string): Promise<Relation | null> {
    ops.validateOwnId("relation", id);
    return this.graph.read((store, ns) => ops.getRelationCurrent(store, ns, id));
  }

  async list(options: RelationListOptions = {}): Promise<Page<Relation>> {
    checkOptions("relations.list", options, LIST_KEYS);
    return this.pageById("relation", options, (store, ns, window) =>
      ops.listRelations(store, ns, {
        from_entity: options.from_entity,
        type: options.type,
        to_entity: options.to_entity,
        include_invalidated: options.include_invalidated,
        ...window,
      }),
    );
  }

  /**
   * Yield every match across pages, following the list cursor.
   *
   * @param options (object): the list filters, and limit: the page size per fetch, not a cap; iteration yields every match.
   * @return (AsyncGenerator<Relation>): every matching relation.
   */
  iterate(options: Omit<RelationListOptions, "cursor"> = {}): AsyncGenerator<Relation> {
    checkOptions(
      "relations.iterate",
      options,
      LIST_KEYS.filter((k) => k !== "cursor"),
    );
    return paginate((cursor) => this.list({ ...options, cursor }));
  }

  /**
   * Create a new version of a relation with merged properties; an unchanged update is a no-op.
   *
   * @param id (string): the relation id.
   * @param options (RelationUpdateOptions): properties to set and remove, a new valid time, and evidence records to add.
   * @return (Relation): the current version.
   */
  async update(id: string, options: RelationUpdateOptions = {}): Promise<Relation> {
    checkOptions("relations.update", options, UPDATE_KEYS);
    ops.validateOwnId("relation", id);
    const eventTime = parseTime(options.event_time, "event_time");
    const evidence = options.evidence == null ? null : parseEvidence(options.evidence);
    return this.graph.write((tx, ns) =>
      ops.updateRelation(
        tx,
        ns,
        id,
        {
          set_properties: options.set_properties ?? null,
          remove_properties: [...(options.remove_properties ?? [])],
          event_time: eventTime,
          evidence,
        },
        this.graph.schemaCheck,
      ),
    );
  }

  /**
   * List the evidence records supporting a relation across all its versions.
   *
   * @param id (string): the relation id.
   * @param options (PageOptions): the cursor and page size.
   * @return (Page<Evidence>): evidence ordered by evidence id; throws NotFoundError for an unknown relation.
   */
  async evidence(id: string, options: PageOptions = {}): Promise<Page<Evidence>> {
    checkOptions("relations.evidence", options, PAGE_KEYS);
    ops.validateOwnId("relation", id);
    return this.page(options, (store, ns, window) =>
      ops.listEvidence(store, ns, id, "relation", window.skip, window.limit),
    );
  }

  /**
   * List every version of a relation, retired ones included.
   *
   * @param id (string): the relation id.
   * @param options ({ newest_first?: boolean }): newest_first (default true).
   * @return (Relation[]): the versions; throws NotFoundError when the id has none.
   */
  async versions(id: string, options: { newest_first?: boolean } = {}): Promise<Relation[]> {
    checkOptions("relations.versions", options, VERSIONS_KEYS);
    ops.validateOwnId("relation", id);
    const versions = await this.graph.read((store, ns) =>
      ops.listRelationVersions(store, ns, id, options.newest_first ?? true),
    );
    if (!versions.length) throw new NotFoundError("Relation", id);
    return versions;
  }

  /**
   * Delete a relation, all its versions, and any decision trace that uses it as a step.
   *
   * @param id (string): the relation id.
   * @return (DeleteResult): counts of what was removed.
   */
  async delete(id: string): Promise<DeleteResult> {
    ops.validateOwnId("relation", id);
    return this.graph.write((tx, ns) => ops.deleteRelation(tx, ns, id));
  }
}
