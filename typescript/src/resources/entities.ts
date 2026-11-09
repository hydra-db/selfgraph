import type { DeleteResult, Entity, Evidence, JsonObject, MergeRecord, Page, UnmergeResult } from "../models.js";
import * as ops from "../ops.js";
import { listMerges, unmerge } from "../resolution.js";
import { canonicalEntityRef, canonicalEntityType } from "../schema.js";
import { checkOptions, keysOf } from "../validate.js";
import { PAGE_KEYS, type PageOptions, paginate, Resource } from "./common.js";

export interface EntityCreateOptions {
  id?: string | null;
  aliases?: readonly string[] | null;
  external_ids?: Record<string, string> | null;
  properties?: JsonObject | null;
}

export interface EntityListOptions {
  type?: string | null;
  name?: string | null;
  cursor?: string | null;
  limit?: number;
}

export type EntityUpdateFields = ops.UpdateEntityFields;

const CREATE_KEYS = keysOf<EntityCreateOptions>({ id: true, aliases: true, external_ids: true, properties: true });
const LIST_KEYS = keysOf<EntityListOptions>({ type: true, name: true, cursor: true, limit: true });

export class Entities extends Resource {
  /**
   * Create one entity, deriving its id as type:name unless options.id is given.
   *
   * @param name (string): the entity name.
   * @param type (string): the entity type; a schema alias becomes the schema's type name before the id is derived.
   * @param options (EntityCreateOptions): an explicit id, whose prefix naming the type's schema alias becomes the schema type's id form; aliases, external ids, and properties.
   * @return (Entity): the created entity.
   */
  async create(name: string, type: string, options: EntityCreateOptions = {}): Promise<Entity> {
    checkOptions("entities.create", options, CREATE_KEYS);
    const schema = this.graph.schema;
    const cleaned = typeof type === "string" ? ops.cleanText(type) : type;
    const canonical = typeof cleaned === "string" ? canonicalEntityType(cleaned, schema) : cleaned;
    const id = typeof cleaned === "string" ? canonicalEntityRef(options.id, cleaned, schema) : options.id;
    return this.graph.write((tx, ns) =>
      ops.createEntity(tx, ns, { name, type: canonical, ...options, id }, this.graph.schemaCheck),
    );
  }

  async get(id: string): Promise<Entity | null> {
    return this.graph.read((store, ns) => ops.getEntity(store, ns, id));
  }

  /**
   * List entities, optionally filtered by type and exact name.
   *
   * @param options (EntityListOptions): the type filter, which ignores letter case and, with a schema, matches an alias's type; the exact name filter; the cursor and page size.
   * @return (Page<Entity>): entities ordered by id.
   */
  async list(options: EntityListOptions = {}): Promise<Page<Entity>> {
    checkOptions("entities.list", options, LIST_KEYS);
    const schema = this.graph.schema;
    return this.pageById("entity", options, (store, ns, window) =>
      ops.listEntities(store, ns, {
        type: options.type,
        name: options.name,
        ...window,
        canonical: (type) => canonicalEntityType(type, schema),
      }),
    );
  }

  /**
   * List the evidence records supporting an entity, one per source, version, chunk, and quote.
   *
   * @param id (string): the entity id.
   * @param options (PageOptions): the cursor and page size.
   * @return (Page<Evidence>): evidence ordered by evidence id; throws NotFoundError for an unknown entity.
   */
  async evidence(id: string, options: PageOptions = {}): Promise<Page<Evidence>> {
    checkOptions("entities.evidence", options, PAGE_KEYS);
    return this.page(options, (store, ns, window) =>
      ops.listEvidence(store, ns, id, "entity", window.skip, window.limit),
    );
  }

  /**
   * List the merge records of entities that entity resolution folded into this one.
   *
   * @param id (string): the surviving entity id.
   * @param options (PageOptions): the cursor and page size.
   * @return (Page<MergeRecord>): records ordered by merge id; throws NotFoundError for an unknown entity.
   */
  async merges(id: string, options: PageOptions = {}): Promise<Page<MergeRecord>> {
    checkOptions("entities.merges", options, PAGE_KEYS);
    return this.page(options, (store, ns, window) => listMerges(store, ns, id, window.skip, window.limit));
  }

  /**
   * Reverse one merge: recreate the absorbed entity, drop the aliases it added, and move its references back.
   *
   * @param mergeId (string): the merge record id, from entities.merges or InsertResult.merges.
   * @return (UnmergeResult): the reverted record, the recreated entity, the survivor, and what moved back.
   */
  async unmerge(mergeId: string): Promise<UnmergeResult> {
    return this.graph.write((tx, ns) => unmerge(tx, ns, mergeId));
  }

  /**
   * Yield every match across pages, following the list cursor.
   *
   * @param options (object): the list filters, and limit: the page size per fetch, not a cap; iteration yields every match.
   * @return (AsyncGenerator<Entity>): every matching entity.
   */
  iterate(options: Omit<EntityListOptions, "cursor"> = {}): AsyncGenerator<Entity> {
    checkOptions(
      "entities.iterate",
      options,
      LIST_KEYS.filter((k) => k !== "cursor"),
    );
    return paginate((cursor) => this.list({ ...options, cursor }));
  }

  /**
   * Update an entity: name and type replace, aliases/external_ids/properties merge, and remove_aliases / remove_properties drop entries.
   *
   * A type that differs only in case or spacing keeps the stored type; with a schema, a type naming a schema type or
   * alias stores the schema's type name.
   *
   * @param id (string): the entity id.
   * @param fields (EntityUpdateFields): name, type, aliases, external_ids, properties, remove_aliases, remove_properties.
   * @return (Entity): the updated entity.
   */
  async update(id: string, fields: EntityUpdateFields): Promise<Entity> {
    const schema = this.graph.schema;
    const given =
      schema !== null && typeof fields?.type === "string"
        ? { ...fields, type: canonicalEntityType(ops.cleanText(fields.type), schema) }
        : fields;
    const types = new Set(schema?.entities.map((t) => t.name) ?? []);
    return this.graph.write((tx, ns) => ops.updateEntity(tx, ns, id, given, this.graph.schemaCheck, [], types));
  }

  /**
   * Delete an entity, its relations and preferences, and any decision trace that references it.
   *
   * @param id (string): the entity id.
   * @return (DeleteResult): counts of what was removed.
   */
  async delete(id: string): Promise<DeleteResult> {
    return this.graph.write((tx, ns) => ops.deleteEntity(tx, ns, id));
  }
}
