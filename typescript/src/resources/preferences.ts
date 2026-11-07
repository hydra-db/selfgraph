import {
  type DateTimeInput,
  DEFAULT_KIND,
  type DeleteResult,
  type JsonObject,
  type Kind,
  type Page,
  type Preference,
  parseDate,
} from "../models.js";
import * as ops from "../ops.js";
import { keysOf, rejectUnknown } from "../validate.js";
import { paginate, parseKind, Resource } from "./common.js";

export interface PreferenceCreateOptions {
  id?: string | null;
  kind?: Kind;
  about_entity?: string | null;
  strength?: number | null;
  properties?: JsonObject | null;
  event_time?: DateTimeInput | null;
}

export interface PreferenceListOptions {
  key?: string | null;
  kind?: Kind | null;
  cursor?: string | null;
  limit?: number;
}

export interface PreferenceUpdateOptions {
  strength?: number | null;
  properties?: JsonObject | null;
  remove_properties?: readonly string[];
  event_time?: DateTimeInput | null;
}

const UPDATE_KEYS = keysOf<PreferenceUpdateOptions>({
  strength: true,
  properties: true,
  remove_properties: true,
  event_time: true,
});

function splitArgs<O extends object>(
  subjectOrOptions: string | null | undefined | O,
  options: O | undefined,
): [string | null, O] {
  if (subjectOrOptions !== null && typeof subjectOrOptions === "object") return [null, subjectOrOptions];
  return [subjectOrOptions ?? null, options ?? ({} as O)];
}

export class Preferences extends Resource {
  /**
   * Record that an entity prefers or avoids a value entity for a key, with optional strength 0 to 1.
   *
   * @param subjectEntity (string): the subject entity id.
   * @param key (string): the preference dimension, e.g. "database".
   * @param valueEntity (string): the value entity id.
   * @param options (PreferenceCreateOptions): the id, kind, about entity, strength, properties, and valid time.
   * @return (Preference): the created preference.
   */
  async create(
    subjectEntity: string,
    key: string,
    valueEntity: string,
    options: PreferenceCreateOptions = {},
  ): Promise<Preference> {
    const kind = parseKind(options.kind ?? DEFAULT_KIND);
    const eventTime = parseDate(options.event_time);
    return this.graph.write((tx, ns) =>
      ops.createPreference(tx, ns, {
        subject_entity: subjectEntity,
        key,
        value_entity: valueEntity,
        id: options.id,
        kind,
        about_entity: options.about_entity,
        strength: options.strength,
        properties: options.properties ?? null,
        event_time: eventTime,
      }),
    );
  }

  async get(id: string): Promise<Preference | null> {
    return this.graph.read((store, ns) => ops.getPreference(store, ns, id));
  }

  /**
   * List current preferences, for one subject or, without one, for every subject.
   *
   * @param subjectOrOptions (string | null | PreferenceListOptions): the subject entity id, or the options to list every subject.
   * @param options (PreferenceListOptions): filters by key and kind, a cursor, and the page size.
   * @return (Page<Preference>): a page of preferences.
   */
  async list(
    subjectOrOptions?: string | null | PreferenceListOptions,
    options?: PreferenceListOptions,
  ): Promise<Page<Preference>> {
    const [subject, opts] = splitArgs(subjectOrOptions, options);
    return this.page(opts, (store, ns, window) =>
      ops.listPreferences(store, ns, {
        subject_entity: subject,
        key: opts.key,
        kind: opts.kind == null ? null : parseKind(opts.kind),
        ...window,
      }),
    );
  }

  iterate(
    subjectOrOptions?: string | null | Omit<PreferenceListOptions, "cursor">,
    options?: Omit<PreferenceListOptions, "cursor">,
  ): AsyncGenerator<Preference> {
    const [subject, opts] = splitArgs(subjectOrOptions, options);
    return paginate((cursor) => this.list(subject, { ...opts, cursor }));
  }

  /**
   * Every version of a preference.
   *
   * @param id (string): the preference id.
   * @param options ({ newest_first?: boolean }): newest_first (default true).
   * @return (Preference[]): the versions.
   */
  async versions(id: string, options: { newest_first?: boolean } = {}): Promise<Preference[]> {
    return this.graph.read((store, ns) => ops.listPreferenceVersions(store, ns, id, options.newest_first ?? true));
  }

  /**
   * Create a new version of a preference with changed strength or merged properties; an unchanged update is a no-op.
   *
   * @param id (string): the preference id.
   * @param options (PreferenceUpdateOptions): the new strength, properties to merge and remove, and valid time.
   * @return (Preference): the current version.
   */
  async update(id: string, options: PreferenceUpdateOptions = {}): Promise<Preference> {
    rejectUnknown("preference", options, UPDATE_KEYS);
    const eventTime = parseDate(options.event_time);
    return this.graph.write((tx, ns) =>
      ops.updatePreference(tx, ns, id, {
        strength: options.strength,
        properties: options.properties ?? null,
        remove_properties: [...(options.remove_properties ?? [])],
        event_time: eventTime,
      }),
    );
  }

  async delete(id: string): Promise<DeleteResult> {
    return this.graph.write((tx, ns) => ops.deletePreference(tx, ns, id));
  }
}
