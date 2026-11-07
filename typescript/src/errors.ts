import { pyRepr } from "./internal/py.js";

export class SelfGraphError extends Error {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends SelfGraphError {}

class ObjectError extends SelfGraphError {
  /**
   * An error about one stored object, naming its type and id.
   *
   * @param object_type (string): the object type, e.g. "Entity".
   * @param object_id (string): the object id.
   * @param state (string): what is wrong with it, e.g. "does not exist".
   */
  constructor(
    readonly object_type: string,
    readonly object_id: string,
    state: string,
  ) {
    super(`${object_type} ${pyRepr(object_id)} ${state}`);
  }
}

export class NotFoundError extends ObjectError {
  constructor(objectType: string, objectId: string) {
    super(objectType, objectId, "does not exist");
  }
}

export class ConflictError extends ObjectError {
  constructor(objectType: string, objectId: string) {
    super(objectType, objectId, "already exists");
  }
}

export class ExtractionError extends SelfGraphError {}

export class PromptTemplateError extends SelfGraphError {}

export class StoreError extends SelfGraphError {}

export class TransientError extends StoreError {}

/**
 * The message of a thrown value, or its text when it is not an Error.
 *
 * @param exc (unknown): the thrown value.
 * @return (string): the message.
 */
export function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
