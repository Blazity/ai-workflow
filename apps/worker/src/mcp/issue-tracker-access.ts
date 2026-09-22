/**
 * The deployment's issue tracker as the MCP tools reach it.
 *
 * ONE decision for the whole surface about a deployment with no usable
 * tracker. The tools used to read `adapters.issueTracker`, a getter that throws
 * a plain error when there is none, so the answer reached the agent as
 * INTERNAL_ERROR, told it nothing it could act on, and spent the idempotency
 * key of every mutation that tried.
 */
import type { ResolvedAdapters } from "../services/vcs/adapters.js";
import { McpPublicError } from "./contracts.js";
import { redactIntegrationVariableNames } from "./integration-redaction.js";

export type ConnectedIssueTracker = Extract<
  ResolvedAdapters["issueTrackerResolution"],
  { ok: true }
>;

const SETTINGS_UNREADABLE =
  "This deployment's integration settings could not be read, so its issue tracker could not be used and nothing was done. Retry shortly.";

/**
 * The tracker, for a tool that cannot do its work without one, or the refusal
 * every such tool answers with.
 *
 * Nothing connected, or two trackers connected and none selected, is an answer
 * about the deployment rather than a failure of the call: VALIDATION_FAILED and
 * not retryable, because no retry succeeds until an admin changes a
 * connection, and the resolution's sentence says where. Settings that could not
 * be read are a failure of the moment: DEPENDENCY_UNAVAILABLE and retryable,
 * with a fixed sentence, because the resolution's own text carries the
 * database's error. Both are raised before any effect, so a mutation gives its
 * key back (`effectNotApplied`), the same terms a dispatch refused for an
 * unusable integration gets (`integration_unavailable` in tools/workflows.ts).
 */
export function requireIssueTracker(adapters: ResolvedAdapters): ConnectedIssueTracker {
  const tracker = adapters.issueTrackerResolution;
  if (tracker.ok) return tracker;
  if (tracker.unreadable) {
    throw new McpPublicError("DEPENDENCY_UNAVAILABLE", SETTINGS_UNREADABLE, true, undefined, true);
  }
  throw new McpPublicError(
    "VALIDATION_FAILED",
    redactIntegrationVariableNames(tracker.reason),
    false,
    undefined,
    true,
  );
}

/** The tracker when there is one, for a tool whose tracker work is optional
 *  (a cancel moves the ticket back only when there is a board to move it on). */
export { issueTrackerIfConnected } from "../services/vcs/adapters.js";
