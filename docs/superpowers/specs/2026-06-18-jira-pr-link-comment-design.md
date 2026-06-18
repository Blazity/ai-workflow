# Post PR link as a Jira comment when a PR is opened

**Date:** 2026-06-18
**Status:** Approved (design)
**Area:** `apps/worker` — agent workflow

## Problem

When the agent workflow opens a pull request for a ticket, it transitions the
ticket to the AI Review column and announces the PR in Slack (the `pr_ready`
event). It does **not** leave any trace on the Jira ticket itself, so a person
looking at the ticket has no link to the PR.

We want the workflow to leave one Jira comment linking to the PR — and only
one, even though a ticket can be processed multiple times (the review-fix
cycle re-runs the same workflow against the same branch/PR).

## Goal

When the agent workflow opens a **new** PR for a ticket, post exactly **one**
Jira comment linking to that PR. The comment is best-effort: it must never fail
or delay an otherwise-successful run.

## Behavior

- Post the comment **only on the new-PR path** — the `!prContext` branch at
  `apps/worker/src/workflows/agent.ts` (where `createPullRequest` runs).
- On review-fix re-runs `prContext` is non-null, the workflow takes the
  `findPRForBranch` path, and the PR URL is unchanged — so we skip posting.
  This is the de-duplication mechanism: gating on new-PR creation gives exactly
  one comment per ticket with zero extra API calls and no comment scanning.
- Paths that do not open a PR (needs-clarification, failure) post nothing.

## Components

### 1. New step `postPrLinkComment(ticketId, prUrl, prNumber)`

Added to `apps/worker/src/workflows/agent.ts`, following the existing
`"use step"` adapter-wrapper pattern (e.g. `postClarificationAndMoveBack`,
`ensureArthurTaskForTicket`):

```ts
async function postPrLinkComment(
  ticketId: string,
  prUrl: string,
  prNumber: number,
): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  try {
    await issueTracker.postComment(
      ticketId,
      `🤖 Pull request #${prNumber} ready for review:\n${prUrl}`,
    );
  } catch (err) {
    const { logger } = await import("../lib/logger.js");
    logger.warn(
      { ticketId, prUrl, err: errorMessage(err) },
      "pr_link_comment_failed",
    );
  }
}
postPrLinkComment.maxRetries = 0;
```

Design notes:

- **`maxRetries = 0` is deliberate.** Jira's create-comment endpoint
  (`POST /rest/api/3/issue/{id}/comment`) is **not idempotent**. If the comment
  lands but the HTTP response is lost, an automatic retry would create a
  **duplicate** comment — exactly the outcome we're avoiding. Disabling retries
  trades transient-failure resilience for a hard no-duplicate guarantee, which
  is the priority here.
- **Swallow + warn.** The step catches its own errors and logs
  `pr_link_comment_failed`, so it never throws. The PR is already durable and
  Slack still announces it; a missing comment must not turn a successful run
  into a failed one. This mirrors `ensureArthurTaskForTicket` and the label
  update blocks in `postClarificationAndMoveBack` / `clearClarificationLabel`.

### 2. Call site

In the success path of `agentWorkflow`, where the PR is obtained
(currently around `agent.ts:968`):

```ts
const isNewPr = !prContext;
const pr = isNewPr
  ? await createPullRequest(branchName, ticket.title, "")
  : await findPRForBranch(branchName);
prForTelemetry = { url: pr.url, number: pr.id };

if (isNewPr) {
  await postPrLinkComment(ticket.identifier, pr.url, pr.id);
}

const usageReport = formatUsageReport(phaseUsages, priceLookup, activeModel);
await notifyTicket(ticket.identifier, {
  kind: "pr_ready",
  pr: { url: pr.url, number: pr.id },
  usageReport,
});
await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
runOutcome = "success";
```

The comment is posted before `notifyTicket`/`moveTicket`. Ordering is not
functionally significant (the AI Review transition's Jira webhook does not
touch comments); placing it adjacent to PR creation keeps the new-PR logic
together.

## Comment content

Plain text, which `JiraAdapter.postComment` converts to ADF paragraphs (one
paragraph per line). Default wording:

```
🤖 Pull request #<number> ready for review:
<url>
```

The URL is on its own line; Jira renders bare URLs as clickable links.

## Error handling

No new failure paths. The step swallows and warns on failure; `runOutcome`,
telemetry, the Slack notification, and the column transition are all unaffected.

## Testing

- **e2e (CI):** extend `apps/worker/e2e/tier2/us01-clear-ticket-pr.test.ts`.
  After the PR appears, assert that `getTicketComments(ticketKey)` (already
  exported from `e2e/helpers/jira.ts`) contains a comment whose body includes
  the PR URL. This exercises only in CI — local e2e is blocked by the
  Bearer/OAuth token requirement (worker + harness need a Bearer token; the
  local `JIRA_API_TOKEN` is basic-auth).
- **No unit test** for the workflow body: `agentWorkflow` is a `"use workflow"`
  function with no existing unit coverage, and the comment wording is a single
  inline string. No formatter is extracted.

## Out of scope

- Comment-scanning / `getCurrentUserAccountId`-based de-dup (rejected in favor
  of the simpler new-PR gate).
- Comments on review-fix re-runs (e.g. "updated PR with review fixes").
- Comments for non-PR outcomes (clarification, failure) — those already post
  their own comments / notifications where appropriate.
