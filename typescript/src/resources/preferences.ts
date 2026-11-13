import { NotFoundError } from "../errors.js";
import {
  type DateTimeInput,
  DEFAULT_STANCE,
  type DeleteResult,
  type JsonObject,
  type Page,
  type Preference,
  type Stance,
} from "../models.js";
import * as ops from "../ops.js";
import { checkOptions, keysOf, parseTime } from "../validate.js";
import { paginate, parseStance, Resource, VERSIONS_KEYS } from "./common.js";

export interface PreferenceCreateOptions {
  id?: string | null;
  stance?: Stance;
  about_entity?: string | null;
  strength?: number | null;
  properties?: JsonObject | null;
  event_time?: DateTimeInput | null;
}

export interface PreferenceListOptions {
  key?: string | null;
  stance?: Stance | null;
  cursor?: string | null;
  limit?: number;
}

export interface PreferenceUpdateOptions {
  strength?: number | null;
  properties?: JsonObject | null;
  remove_properties?: readonly string[];
  event_time?: DateTimeInput | null;
  clear?: readonly string[];
}

const CREATE_KEYS = keysOf<PreferenceCreateOptions>({
  id: true,
  stance: true,
  about_entity: true,
  strength: true,
  properties: true,
  event_time: true,
});
const LIST_KEYS = keysOf<PreferenceListOptions>({ key: true, stance: true, cursor: true, limit: true });
const UPDATE_KEYS = keysOf<PreferenceUpdateOptions>({
  strength: true,
  properties: true,
  remove_properties: true,
  event_time: true,
  clear: true,
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
   * @param options (PreferenceCreateOptions): the id, stance, about entity, strength, properties, and valid time.
   * @return (Preference): the created preference.
   */
  async create(
    subjectEntity: string,
    key: string,
    valueEntity: string,
    options: PreferenceCreateOptions = {},
  ): Promise<Preference> {
    checkOptions("preferences.create", options, CREATE_KEYS);
    const stance = parseStance(options.stance ?? DEFAULT_STANCE);
    const eventTime = parseTime(options.event_time, "event_time");
    return this.graph.write((tx, ns) =>
      ops.createPreference(tx, ns, {
        subject_entity: subjectEntity,
        key,
        value_entity: valueEntity,
        id: options.id,
        stance,
        about_entity: options.about_entity,
        strength: options.strength,
        properties: options.properties ?? null,
        event_time: eventTime,
      }),
    );
  }

  async get(id: string): Promise<Preference | null> {
    ops.validateOwnId("preference", id);
    return this.graph.read((store, ns) => ops.getPreference(store, ns, id));
  }

  /**
   * List current preferences, for one subject or, without one, for every subject.
   *
   * @param subjectOrOptions (string | null | PreferenceListOptions): the subject entity id, or the options to list every subject.
   * @param options (PreferenceListOptions): filters by key and stance, a cursor, and the page size.
   * @return (Page<Preference>): a page of preferences.
   */
  async list(
    subjectOrOptions?: string | null | PreferenceListOptions,
    options?: PreferenceListOptions,
  ): Promise<Page<Preference>> {
    const [subject, opts] = splitArgs(subjectOrOptions, options);
    checkOptions("preferences.list", opts, LIST_KEYS);
    return this.pageById("preference", opts, (store, ns, window) =>
      ops.listPreferences(store, ns, {
        subject_entity: subject,
        key: opts.key,
        stance: opts.stance == null ? null : parseStance(opts.stance),
        ...window,
      }),
    );
  }

  /**
   * Yield every match across pages, following the list cursor.
   *
   * @param subjectOrOptions (string | null | object): the subject entity id, or the options.
   * @param options (object): the list filters, and limit: the page size per fetch, not a cap; iteration yields every match.
   * @return (AsyncGenerator<Preference>): every matching preference.
   */
  iterate(
    subjectOrOptions?: string | null | Omit<PreferenceListOptions, "cursor">,
    options?: Omit<PreferenceListOptions, "cursor">,
  ): AsyncGenerator<Preference> {
    const [subject, opts] = splitArgs(subjectOrOptions, options);
    checkOptions(
      "preferences.iterate",
      opts,
      LIST_KEYS.filter((k) => k !== "cursor"),
    );
    return paginate((cursor) => this.list(subject, { ...opts, cursor }));
  }

  /**
   * Every version of a preference.
   *
   * @param id (string): the preference id.
   * @param options ({ newest_first?: boolean }): newest_first (default true).
   * @return (Preference[]): the versions; throws NotFoundError when the id has none.
   */
  async versions(id: string, options: { newest_first?: boolean } = {}): Promise<Preference[]> {
    checkOptions("preferences.versions", options, VERSIONS_KEYS);
    ops.validateOwnId("preference", id);
    const versions = await this.graph.read((store, ns) =>
      ops.listPreferenceVersions(store, ns, id, options.newest_first ?? true),
    );
    if (!versions.length) throw new NotFoundError("Preference", id);
    return versions;
  }

  /**
   * Create a new version of a preference with changed strength or merged properties; an unchanged update is a no-op. Null keeps a field; name it in clear to remove its value instead.
   *
   * @param id (string): the preference id.
   * @param options (PreferenceUpdateOptions): the new strength, properties to merge and remove, valid time, and the fields to clear (strength, about_entity, event_time).
   * @return (Preference): the current version.
   */
  async update(id: string, options: PreferenceUpdateOptions = {}): Promise<Preference> {
    checkOptions("preferences.update", options, UPDATE_KEYS);
    ops.validateOwnId("preference", id);
    const eventTime = parseTime(options.event_time, "event_time");
    return this.graph.write((tx, ns) =>
      ops.updatePreference(tx, ns, id, {
        strength: options.strength,
        properties: options.properties ?? null,
        remove_properties: [...(options.remove_properties ?? [])],
        event_time: eventTime,
        clear: options.clear ?? [],
      }),
    );
  }

  async delete(id: string): Promise<DeleteResult> {
    ops.validateOwnId("preference", id);
    return this.graph.write((tx, ns) => ops.deletePreference(tx, ns, id));
  }
}
