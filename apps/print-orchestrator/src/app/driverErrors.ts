import { AppError, JobError, PrinterConnectionError } from "../core/errors";
import { PrinterCommandError } from "../infra/printers/status";

/**
 * Maps a failure from a printer driver call onto the API error taxonomy, one
 * rule everywhere: a {@link PrinterCommandError} is the device/driver refusing
 * the operation (wrong state, missing file, unconfigured light) → a 409
 * {@link JobError} with the driver's own message; anything else means we could
 * not talk to the device at all → a 502 {@link PrinterConnectionError} naming
 * the printer. An {@link AppError} passes through untouched, so validation
 * failures raised before/inside the call keep their own status and code.
 */
export function toDriverError(printerId: string, error: unknown): Error {
  if (error instanceof AppError) return error;
  if (error instanceof PrinterCommandError) return new JobError(error.message);
  // The short driver message goes to the client; keep the whole original error
  // as `cause` for server-side diagnostics (never serialized to the client).
  return new PrinterConnectionError(
    printerId,
    error instanceof Error ? error.message : String(error),
    { cause: error }
  );
}

/** Runs one driver operation, rethrowing failures via {@link toDriverError}. */
export async function runDriverOperation<T>(
  printerId: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDriverError(printerId, error);
  }
}
