import type { DeleteResult, Entity, Evidence, JsonObject, Page } from "../models.js";
import * as ops from "../ops.js";
import { type PageOptions, paginate, Resource } from "./common.js";

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

export class Entities extends Resource {
  async create(name: string, type: string, options: EntityCreateOptions = {}): Promise<Entity> {
    return this.graph.write((tx, ns) => ops.createEntity(tx, ns, { name, type, ...options }, this.graph.schemaCheck));
  }

  async get(id: string): Promise<Entity | null> {
    return this.graph.read((store, ns) => ops.getEntity(store, ns, id));
  }

  async list(options: EntityListOptions = {}): Promise<Page<Entity>> {
    return this.page(options, (store, ns, window) =>
      ops.listEntities(store, ns, {
        type: options.type,
        name: options.name,
        ...window,
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
    return this.page(options, (store, ns, window) =>
      ops.listEvidence(store, ns, id, "entity", window.skip, window.limit),
    );
  }

  iterate(options: Omit<EntityListOptions, "cursor"> = {}): AsyncGenerator<Entity> {
    return paginate((cursor) => this.list({ ...options, cursor }));
  }

  /**
   * Update an entity: name and type replace, aliases/external_ids/properties merge, and remove_aliases / remove_properties drop entries.
   *
   * @param id (string): the entity id.
   * @param fields (EntityUpdateFields): name, type, aliases, external_ids, properties, remove_aliases, remove_properties.
   * @return (Entity): the updated entity.
   */
  async update(id: string, fields: EntityUpdateFields): Promise<Entity> {
    return this.graph.write((tx, ns) => ops.updateEntity(tx, ns, id, fields, this.graph.schemaCheck));
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
