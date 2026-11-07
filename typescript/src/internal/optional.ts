import type { SelfGraphError } from "../errors.js";
import { Lazy } from "./lazy.js";

const modules = new Map<string, Lazy<unknown>>();

function packageRoot(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export function isMissing(exc: unknown, name: string): boolean {
  const err = exc as { code?: string; message?: string };
  return (
    (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") &&
    typeof err.message === "string" &&
    err.message.includes(packageRoot(name))
  );
}

/**
 * Import an optional peer dependency once, raising ErrorClass when it is not installed and surfacing any other load error unchanged.
 *
 * @param name (string): the package name.
 * @param message (string): the error message when the package is not installed.
 * @param ErrorClass (new (message: string, options?: { cause?: unknown }) => SelfGraphError): the SelfGraph error type to raise.
 * @return (T): the module namespace.
 */
export async function loadOptional<T = unknown>(
  name: string,
  message: string,
  ErrorClass: new (message: string, options?: { cause?: unknown }) => SelfGraphError,
): Promise<T> {
  let module = modules.get(name);
  if (module === undefined) {
    module = new Lazy(() => import(/* webpackIgnore: true */ /* @vite-ignore */ name));
    modules.set(name, module);
  }
  try {
    return (await module.get()) as T;
  } catch (exc) {
    if (isMissing(exc, name)) throw new ErrorClass(message, { cause: exc });
    throw exc;
  }
}
