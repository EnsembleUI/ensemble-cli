/* eslint-disable no-console */

export interface CliError {
  code?: string;
  message: string;
  hint?: string;
  /**
   * Underlying error or metadata for debugging.
   * Not printed by default unless debug mode is enabled.
   */
  cause?: unknown;
}

export interface PrintCliErrorOptions {
  /**
   * When true, include stack traces and raw causes in output.
   * This flag is typically derived from a `--debug` CLI flag or `DEBUG=1` env.
   */
  debug?: boolean;
}

export function isCliError(value: unknown): value is CliError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CliError>;
  return typeof candidate.message === 'string';
}

export function toCliError(err: unknown): CliError {
  if (isCliError(err)) return err;
  if (err instanceof Error) {
    return {
      message: err.message,
      cause: err,
    };
  }
  if (typeof err === 'string') {
    return {
      message: err,
      cause: err,
    };
  }
  return {
    message: 'An unknown error occurred.',
    cause: err,
  };
}

/**
 * Normalize a boolean-like debug flag, combining CLI options and environment.
 *
 * - When the option is explicitly true, debug is enabled.
 * - Otherwise, DEBUG env is inspected for common truthy values.
 */
export function resolveDebugFlag(fromOption: boolean | undefined): boolean {
  if (fromOption === true) return true;

  const env = process.env.DEBUG;
  if (!env) return false;

  const normalized = env.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Normalize verbose flag handling across commands and helpers.
 *
 * - When the option is explicitly set, it wins.
 * - Otherwise, VERBOSE / ENSEMBLE_VERBOSE env vars may enable verbose mode.
 */
export function resolveVerboseFlag(fromOption: boolean | undefined): boolean {
  if (typeof fromOption === 'boolean') return fromOption;

  const env = process.env.ENSEMBLE_VERBOSE ?? process.env.VERBOSE;
  if (!env) return false;

  const normalized = env.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Print a CLI-friendly error message.
 *
 * By default, only the primary message (and optional hint) are shown.
 * When debug mode is enabled, stack traces and raw causes are also printed.
 */
export function printCliError(err: unknown, options: PrintCliErrorOptions = {}): void {
  const cliError = toCliError(err);
  const debugEnabled = resolveDebugFlag(options.debug);

  console.error(cliError.message);
  if (cliError.hint) {
    console.error(cliError.hint);
  }

  if (!debugEnabled) return;

  const cause = cliError.cause ?? (err instanceof Error ? err : undefined);
  if (cause instanceof Error) {
    if (cause.stack) {
      console.error(cause.stack);
    } else {
      console.error(cause);
    }
  } else if (cause !== undefined) {
    console.error('Cause:', cause);
  }
}
