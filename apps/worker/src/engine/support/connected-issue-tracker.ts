/**
 * What a caller does when the deployment has no usable issue tracker, said
 * at the call site.
 *
 * `Adapters.issueTrackerResolution` carries the tracker or the refusal as data,
 * because no tracker is a state a deployment is allowed to be in (D9) and what
 * it means depends on the work: a ticket step fails, a pull request dispatch
 * never needed one, a best-effort comment is skipped. These two are the only
 * readings, so each caller picks one by name instead of every caller inheriting
 * "fail" from a getter.
 *
 * Pure and alone in a module of its own, so the decision imports nothing that
 * reaches a database: a caller in any tier, and a test that stands in for
 * `createAdapters`, gets the real rule.
 */
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { ResolvedIssueTracker } from "./issue-tracker-runtime.js";

interface HoldsIssueTrackerResolution {
  readonly issueTrackerResolution: ResolvedIssueTracker;
}

/** The tracker when there is one, and nothing when there is not: for a caller
 *  whose tracker work is optional and which has nothing to say about why. */
export function issueTrackerIfConnected(
  adapters: HoldsIssueTrackerResolution,
): IssueTrackerAdapter | undefined {
  return adapters.issueTrackerResolution.ok ? adapters.issueTrackerResolution.adapter : undefined;
}

/**
 * The tracker, or a throw carrying the sentence a person reads when there is
 * none: for a caller whose whole job is a ticket (a ticket step inside a run a
 * ticket started, a ticket webhook), where no tracker is a failure of that job
 * and the caller's own failure path is what reports it.
 */
export function issueTrackerOrThrow(adapters: HoldsIssueTrackerResolution): IssueTrackerAdapter {
  const tracker = adapters.issueTrackerResolution;
  if (!tracker.ok) throw new Error(tracker.reason);
  return tracker.adapter;
}
