import {
  type DateTimeInput,
  DEFAULT_STATUS,
  type DecisionTrace,
  type DeleteResult,
  type Page,
  parseDate,
  type Status,
} from "../models.js";
import * as ops from "../ops.js";
import { paginate, parseStatus, Resource } from "./common.js";

export interface DecisionCreateOptions {
  steps: Iterable<string>;
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
}

export class Decisions extends Resource {
  async create(title: string, options: DecisionCreateOptions): Promise<DecisionTrace> {
    const status = parseStatus(options.status ?? DEFAULT_STATUS);
    const eventTime = parseDate(options.event_time);
    return this.graph.write((tx, ns) =>
      ops.createTrace(tx, ns, {
        title,
        steps: [...options.steps],
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
    return this.graph.read((store, ns) => ops.getTrace(store, ns, id));
  }

  async list(options: DecisionListOptions = {}): Promise<Page<DecisionTrace>> {
    return this.page(options, (store, ns, window) =>
      ops.listTraces(store, ns, {
        actor_entity: options.actor_entity,
        status: options.status == null ? null : parseStatus(options.status),
        ...window,
      }),
    );
  }

  iterate(options: Omit<DecisionListOptions, "cursor"> = {}): AsyncGenerator<DecisionTrace> {
    return paginate((cursor) => this.list({ ...options, cursor }));
  }

  /**
   * Update a decision trace, rewriting its structure; omitted fields keep their value and null clears an optional one.
   *
   * @param id (string): the trace id.
   * @param fields (DecisionUpdateFields): the fields to change.
   * @return (DecisionTrace): the updated trace.
   */
  async update(id: string, fields: DecisionUpdateFields): Promise<DecisionTrace> {
    const out: ops.UpdateTraceFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === "steps" || key === "alternative_entities")
        (out as Record<string, unknown>)[key] = [...(value as Iterable<string>)];
      else if (key === "status") out.status = parseStatus(value);
      else if (key === "event_time") out.event_time = parseDate(value as DateTimeInput | null);
      else (out as Record<string, unknown>)[key] = value;
    }
    return this.graph.write((tx, ns) => ops.updateTrace(tx, ns, id, out));
  }

  async delete(id: string): Promise<DeleteResult> {
    return this.graph.write((tx, ns) => ops.deleteTrace(tx, ns, id));
  }
}
