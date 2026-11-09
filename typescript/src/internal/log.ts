export type LogLevel = "info" | "warning";
export type Logger = (message: string, level: LogLevel) => void;

const consoleLogger: Logger = (message, level) => {
  if (level === "warning") console.warn(`selfgraph: ${message}`);
};

let current: Logger | null = consoleLogger;

/**
 * Route SelfGraph's diagnostics: a function receives every message and its level, null silences them, undefined restores the default.
 *
 * The default prints warnings to stderr through console.warn with a "selfgraph:" prefix and drops info messages.
 *
 * @param fn (Logger | null | undefined): the logger, null to silence, or undefined for the default.
 * @return (Logger | null): the logger it replaces, to restore later.
 */
export function setLogger(fn: Logger | null | undefined): Logger | null {
  const previous = current;
  current = fn === undefined ? consoleLogger : fn;
  return previous;
}

/**
 * Send one diagnostic to the current logger.
 *
 * @param message (string): the message, without a prefix.
 * @param level (LogLevel): warning, or info for progress.
 */
export function log(message: string, level: LogLevel = "warning"): void {
  current?.(message, level);
}
