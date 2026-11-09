import {
  type DateTimeInput,
  DEFAULT_STATUS,
  type DecisionTrace,
  type DeleteResult,
  type Page,
  type Status,
} from "../models.js";
import * as ops from "../ops.js";
import { checkOptions, keysOf, parseTime } from "../validate.js";
import { paginate, parseStatus, Resource } from "./common.js";

export interface DecisionCreateOptions {
  steps?: Iterable<string>;
  id?: string | null;
  actor_entity?: string | null;
  summary?: string | null;
  rationale?: string | null;
  outcome_entity?: string | null;
  alternative_entities?: Iterable<string>;
  status?: Status;
  event_time?: DateTimeInput | null;
}

export interface DecisionListOptions {
  actor_entity?: string | null;
  status?: Status | null;
  cursor?: string | null;
  limit?: number;
}

export interface DecisionUpdateFields {
  title?: string;
  steps?: Iterable<string>;
  actor_entity?: string | null;
  summary?: string | null;
  rationale?: string | null;
  outcome_entity?: string | null;
  alternative_entities?: Iterable<string>;
  status?: Status;
  event_time?: DateTimeInput | null;
  clear?: readonly string[];
}

const CREATE_KEYS = keysOf<DecisionCreateOptions>({
  steps: true,
  id: true,
  actor_entity: true,
  summary: true,
  rationale: true,
  outcome_entity: true,
  alternative_entities: true,
  status: true,
  event_time: true,
});
const LIST_KEYS = keysOf<DecisionListOptions>({ actor_entity: true, status: true, cursor: true, limit: true });
const UPDATE_KEYS = keysOf<DecisionUpdateFields>({
  title: true,
  steps: true,
  actor_entity: true,
  summary: true,
  rationale: true,
  outcome_entity: true,
  alternative_entities: true,
  status: true,
  event_time: true,
  clear: true,
});

export class Decisions extends Resource {
  /**
   * Record a decision trace over existing relations.
   *
   * @param title (string): the decision title.
   * @param options (DecisionCreateOptions): steps (ids of existing relations in order, default none), the id, actor, summary, rationale, outcome, alternatives, status, and valid time.
   * @return (DecisionTrace): the recorded trace.
   */
  async create(title: string, options: DecisionCreateOptions = {}): Promise<DecisionTrace> {
    checkOptions("decisions.create", options, CREATE_KEYS);
    const status = parseStatus(options.status ?? DEFAULT_STATUS);
    const eventTime = parseTime(options.event_time, "event_time");
    return this.graph.write((tx, ns) =>
      ops.createTrace(tx, ns, {
        title,
        steps: [...(options.steps ?? [])],
        id: options.id,
        actor_entity: options.actor_entity,
        summary: options.summary,
        rationale: options.rationale,
        outcome_entity: options.outcome_entity,
        alternative_entities: [...(options.alternative_entities ?? [])],
        status,
        event_time: eventTime,
      }),
    );
  }

  async get(id: string): Promise<DecisionTrace | null> {
    ops.validateOwnId("decision", id);
    return this.graph.read((store, ns) => ops.getTrace(store, ns, id));
  }

  async list(options: DecisionListOptions = {}): Promise<Page<DecisionTrace>> {
    checkOptions("decisions.list", options, LIST_KEYS);
    return this.pageById("decision", options, (store, ns, window) =>
      ops.listTraces(store, ns, {
        actor_entity: options.actor_entity,
        status: options.status == null ? null : parseStatus(options.status),
        ...window,
      }),
    );
  }

  /**
   * Yield every match across pages, following the list cursor.
   *
   * @param options (object): the list filters, and limit: the page size per fetch, not a cap; iteration yields every match.
   * @return (AsyncGenerator<DecisionTrace>): every matching decision trace.
   */
  iterate(options: Omit<DecisionListOptions, "cursor"> = {}): AsyncGenerator<DecisionTrace> {
    checkOptions(
      "decisions.iterate",
      options,
      LIST_KEYS.filter((k) => k !== "cursor"),
    );
    return paginate((cursor) => this.list({ ...options, cursor }));
  }

  /**
   * Update a decision trace, rewriting its structure; omitted fields keep their value and null clears an optional one.
   *
   * @param id (string): the trace id.
   * @param fields (DecisionUpdateFields): the fields to change, and clear: fields to clear (actor_entity, summary, rationale, outcome_entity, event_time to null; alternative_entities, steps to []).
   * @return (DecisionTrace): the updated trace.
   */
  async update(id: string, fields: DecisionUpdateFields): Promise<DecisionTrace> {
    checkOptions("decisions.update", fields, UPDATE_KEYS);
    ops.validateOwnId("decision", id);
    const out: ops.UpdateTraceFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === "steps" || key === "alternative_entities")
        (out as Record<string, unknown>)[key] = [...(value as Iterable<string>)];
      else if (key === "status") out.status = parseStatus(value);
      else if (key === "event_time") out.event_time = parseTime(value, "event_time");
      else (out as Record<string, unknown>)[key] = value;
    }
    return this.graph.write((tx, ns) => ops.updateTrace(tx, ns, id, out));
  }

  async delete(id: string): Promise<DeleteResult> {
    ops.validateOwnId("decision", id);
    return this.graph.write((tx, ns) => ops.deleteTrace(tx, ns, id));
  }
}
