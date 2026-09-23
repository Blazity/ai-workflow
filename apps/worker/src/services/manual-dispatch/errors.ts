import type { ManualDispatchBlockerCode } from "@shared/contracts";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { ResolvedIssueTracker } from "../../engine/support/issue-tracker-runtime.js";

export class ManualDispatchError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ManualDispatchBlockerCode,
    message: string,
  ) {
    super(message);
    this.name = "ManualDispatchError";
  }
}

/**
 * The tracker a manual dispatch needs, or the refusal that says why there is
 * none.
 *
 * Called only where the dispatch really reads a ticket: a ticket input, the
 * ticket a workflow-owned pull request was opened for, and the move into the
 * AI column. A pull request dispatch whose trigger accepts any pull request
 * never calls it, so it starts on a deployment with no tracker at all.
 *
 * `integration_unavailable` in both cases, because both are refused before
 * anything is reserved or moved, and that is the code whose MCP mapping gives
 * the idempotency key back. The status tells the two apart: 409 for nothing
 * usable (an admin has to connect or choose one, and the resolution's sentence
 * says where), 503 for settings that could not be read, with a fixed sentence
 * because the resolution's own carries the database's error text, and which a
 * queued dispatch's recovery retries on the next tick instead of failing.
 */
export function issueTrackerForDispatch(resolution: ResolvedIssueTracker): IssueTrackerAdapter {
  if (resolution.ok) return resolution.adapter;
  if (resolution.refusal === "unreadable") {
    throw settingsUnreadableForDispatch("the issue tracker could not be used");
  }
  throw new ManualDispatchError(409, "integration_unavailable", resolution.reason);
}

/**
 * The refusal for a dispatch that needed this deployment's integration
 * settings and could not read them, whichever part of the dispatch asked.
 *
 * 503 and `integration_unavailable`, for the reasons above: nothing was
 * reserved, a retry is the fix, and a queued dispatch's recovery retries it on
 * the next tick. Never the refusal for "not configured", which sends a person
 * to connect something that is connected.
 */
export function settingsUnreadableForDispatch(consequence: string): ManualDispatchError {
  return new ManualDispatchError(
    503,
    "integration_unavailable",
    `This deployment's integration settings could not be read, so ${consequence} and nothing was dispatched. Try again shortly.`,
  );
}
