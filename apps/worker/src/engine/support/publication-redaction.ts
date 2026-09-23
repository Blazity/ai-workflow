/**
 * ONE RULE, enforced where text leaves core: the step that writes or publishes
 * a value applies the whole set of secrets this deployment knows
 * (`knownSecretValues`, services/integrations/secret-values.ts).
 *
 * Workflow scope redacts with the environment half only (it cannot read a
 * stored connection), and an agent writes whatever its sandbox holds, a
 * tracing key an admin stored in the dashboard included (ADR-010 decision 7).
 * So the whole set is applied at the boundaries core owns, rather than at each
 * of the call sites that happen to publish today:
 *
 * 1. The issue tracker adapter, as `resolveActiveIssueTracker` builds it:
 *    `postComment` and `createTicket` (`ISSUE_TRACKER_PUBLICATIONS`). Every
 *    ticket comment core or a block posts, agent-authored ones included.
 * 2. The version control adapter, as `createRepositoryVcsRuntime` builds it:
 *    pull request titles and bodies, comments, review threads, reviews, run
 *    failure notes and gate status summaries (`VCS_PUBLICATIONS`).
 * 3. The messaging sender (`messagingSender().notifyForTicket`), which fails
 *    closed by not sending, because a notification never throws.
 * 4. Core's own logs and rows written from workflow-scope text, each in its
 *    step in steps/ticket-analysis.ts: the run analysis report, the failure
 *    reason's status row, the phase failure and execution error logs, and the
 *    failed-ticket mark.
 *
 * A publication whose set cannot be read is not made with part of it: the
 * adapters throw (the caller's own failure path reports it, as for any failed
 * post), the sender answers "not delivered", and a log or row withholds the
 * text and keeps everything else.
 */

export const ISSUE_TRACKER_PUBLICATIONS: ReadonlySet<string> = new Set([
  "postComment",
  "createTicket",
]);

export const VCS_PUBLICATIONS: ReadonlySet<string> = new Set([
  "createPR",
  "postPRComment",
  "settleReviewThread",
  "postRunFailureNote",
  "updateGateStatus",
  "updateGateStatusDetails",
  "publishPRReview",
]);

/** What a log line or a row carries instead of text that could not be
 *  redacted with the whole set. */
export const WITHHELD_UNREDACTABLE =
  "[withheld: the secrets to redact it with could not be read]";

/**
 * `value` with every secret the deployment knows replaced by a marker. Throws
 * `IntegrationSecretsUnreadableError` when the set cannot be read, so nothing
 * leaves with part of it. Strings and plain objects are redacted; anything
 * else (an abort signal handed to a provider) is passed through untouched.
 */
export async function withKnownSecretsRedacted<T>(value: T): Promise<T> {
  const { knownSecretValues } = await import("../../services/integrations/runtime.js");
  const { redactConfiguredSecretsInJson } = await import("../../run-observability/sanitizer.js");
  return redactConfiguredSecretsInJson(value, await knownSecretValues());
}

/** The same, for a log line or a row that must still be written: `withheld`
 *  stands in for the value when the set cannot be read. */
export async function withKnownSecretsRedactedOr<T>(value: T, withheld: T): Promise<T> {
  try {
    return await withKnownSecretsRedacted(value);
  } catch {
    return withheld;
  }
}

/**
 * The adapter, with the arguments of each method in `publications` redacted
 * before the provider sees them. Every other member is the adapter's own, and
 * a method the adapter does not have is still absent, so a "can this provider
 * do X" check answers exactly as it did.
 */
export function redactingPublications<T extends object>(
  adapter: T,
  publications: ReadonlySet<string>,
): T {
  return new Proxy(adapter, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (typeof property === "string" && publications.has(property)) {
        return async (...args: unknown[]) =>
          (member as (...values: unknown[]) => unknown).apply(
            target,
            await withKnownSecretsRedacted(args),
          );
      }
      return (member as (...values: unknown[]) => unknown).bind(target);
    },
  });
}
