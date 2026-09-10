import { FatalError } from "workflow";

const ACTIVE_RUN_OWNER_ERROR_NAME = "ActiveRunOwnerError";
export const ACTIVE_RUN_OWNER_ERROR_SENTINEL =
  "[ai-workflow/control/active-run-owner/v1]";

/** Terminal exact-owner CAS failure at an irreversible run boundary. */
export class ActiveRunOwnerError extends FatalError {
  constructor(detail = "Provider mutation requires the exact active run owner.") {
    super(`${ACTIVE_RUN_OWNER_ERROR_SENTINEL} ${detail}`);
  }
}

/** The sentinel survives Workflow's FatalError replay. The legacy name/stack
 * branches keep already-recorded runs terminal across this deployment. */
export function isActiveRunOwnerError(error: unknown): error is Error {
  if (typeof error !== "object" || error === null) return false;
  const message = "message" in error && typeof error.message === "string"
    ? error.message
    : "";
  if (
    FatalError.is(error) &&
    message.startsWith(`${ACTIVE_RUN_OWNER_ERROR_SENTINEL} `)
  ) {
    return true;
  }
  // Runs recorded before the sentinel deployment retain only this class name.
  // This deliberately broader branch can be removed after those runs age out.
  if (
    "name" in error &&
    error.name === ACTIVE_RUN_OWNER_ERROR_NAME &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return true;
  }
  if (!FatalError.is(error) || !("stack" in error) || typeof error.stack !== "string") {
    return false;
  }
  const firstLine = error.stack.split("\n", 1)[0]?.trim() ?? "";
  return (
    firstLine === ACTIVE_RUN_OWNER_ERROR_NAME ||
    firstLine.startsWith(`${ACTIVE_RUN_OWNER_ERROR_NAME}:`)
  );
}
