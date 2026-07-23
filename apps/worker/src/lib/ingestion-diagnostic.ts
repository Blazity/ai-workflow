import { randomUUID } from "node:crypto";
import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";
import { logger } from "./logger.js";

export function recordIngestionFailure(
  event: string,
  error: unknown,
  context: Record<string, unknown> = {},
  existingDiagnosticId?: string,
): string {
  const diagnosticId = isIngestionDiagnosticId(existingDiagnosticId)
    ? existingDiagnosticId
    : `${EXECUTION_DIAGNOSTIC_PREFIX}ingest-${randomUUID()}`;
  logger.warn(
    {
      ...context,
      diagnosticId,
      error:
        error instanceof Error
          ? error.stack ?? error.message
          : String(error),
    },
    event,
  );
  return diagnosticId;
}

function isIngestionDiagnosticId(value: string | undefined): value is string {
  return Boolean(value?.startsWith(`${EXECUTION_DIAGNOSTIC_PREFIX}ingest-`));
}
