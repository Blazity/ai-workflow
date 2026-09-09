# Jira PR-link Comment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent workflow opens a new PR for a ticket, post exactly one Jira comment linking to that PR.

**Architecture:** Add a best-effort `"use step"` function `postPrLinkComment` to the agent workflow that calls `issueTracker.postComment`. Invoke it only on the new-PR branch of the success path so review-fix re-runs (which reuse the existing PR) never re-post — that gating is the de-duplication mechanism.

**Tech Stack:** TypeScript, Vercel Workflow DevKit (`"use workflow"` / `"use step"`), Nitro, vitest. Jira via the existing `IssueTrackerAdapter`.

## Global Constraints

- The new step must follow the existing `"use step"` pattern in `agent.ts`: deferred `await import(...)` inside the step body only (the workflow bundler cannot tolerate top-level adapter/logger imports).
- `postPrLinkComment.maxRetries = 0` — Jira's create-comment POST is not idempotent; retries risk duplicate comments. Do not enable retries.
- The step must never throw: catch internally and `logger.warn(..., "pr_link_comment_failed")`. A comment failure must not change `runOutcome` or fail the run.
- Comment wording (verbatim): `🤖 Pull request #<number> ready for review:\n<url>`.
- Post only when the PR is newly created (the `!prContext` branch). Never on review-fix re-runs or non-PR exit paths (clarification, failure).
- Local e2e cannot run (worker + harness need a Bearer/OAuth token; the local `JIRA_API_TOKEN` is basic-auth). The e2e assertion is verified in CI via `pnpm --filter worker test:e2e:agent`.

---

### Task 1: Add `postPrLinkComment` step and wire it into the success path

**Files:**
- Modify: `apps/worker/src/workflows/agent.ts` (add step after `findPRForBranch`, ~line 429; wire call site at ~line 968)

**Interfaces:**
- Consumes: `createStepAdapters()` from `../lib/step-adapters.js` → `{ issueTracker }`; `issueTracker.postComment(id: string, comment: string): Promise<string | null>`; `errorMessage(err: unknown): string` (already defined at `agent.ts:526`); `logger` from `../lib/logger.js`.
- Produces: `postPrLinkComment(ticketId: string, prUrl: string, prNumber: number): Promise<void>` — best-effort, never throws.

- [ ] **Step 1: Add the step function**

In `apps/worker/src/workflows/agent.ts`, immediately after the `findPRForBranch` function (the block ending at the `return pr;` / closing brace around line 429), add:

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

- [ ] **Step 2: Wire the call site**

In the success path (the `POST-PHASES: Push & PR` section), replace the existing PR-acquisition block:

```ts
      const pr = !prContext
        ? await createPullRequest(branchName, ticket.title, "")
        : await findPRForBranch(branchName);
      prForTelemetry = { url: pr.url, number: pr.id };
```

with:

```ts
      const isNewPr = !prContext;
      const pr = isNewPr
        ? await createPullRequest(branchName, ticket.title, "")
        : await findPRForBranch(branchName);
      prForTelemetry = { url: pr.url, number: pr.id };

      // Leave a one-time Jira comment linking to the PR, only when we just
      // opened it. On review-fix re-runs the PR already exists and its URL is
      // unchanged, so gating on new-PR creation yields exactly one comment per
      // ticket. Best-effort: postPrLinkComment never throws.
      if (isNewPr) {
        await postPrLinkComment(ticket.identifier, pr.url, pr.id);
      }
```

Leave the existing `formatUsageReport` / `notifyTicket({ kind: "pr_ready" })` / `moveTicket(env.COLUMN_AI_REVIEW)` / `runOutcome = "success"` lines that follow unchanged.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter worker typecheck`
Expected: PASS (exit 0, no type errors). This is the local gate — the new step's deferred-import shape mirrors every other step, and workflow bundling is verified at deploy/CI build time.

- [ ] **Step 4: Run the worker unit suite to confirm no regressions**

Run: `pnpm --filter worker test`
Expected: PASS. (No existing unit test covers `agentWorkflow`; this confirms the edit didn't break adjacent modules.)

- [ ] **Step 5: Stage the change**

```bash
git add apps/worker/src/workflows/agent.ts
git commit -m "feat: comment PR link on the Jira ticket when a PR is opened"
```

(If you prefer to stage commits yourself, run only `git add` and leave the commit to the user.)

---

### Task 2: Assert the Jira comment in the US-01 e2e test

**Files:**
- Modify: `apps/worker/e2e/tier2/us01-clear-ticket-pr.test.ts`

**Interfaces:**
- Consumes: `getTicketComments(ticketKey): Promise<Array<{ author: string; body: string }>>` (already exported from `../helpers/jira.js`); `waitFor` (already imported); `pr.url` from `findPR` (the GitHub `html_url`, identical to the workflow's `pr.url`).
- Produces: nothing (test-only).

- [ ] **Step 1: Import the comments helper**

In `apps/worker/e2e/tier2/us01-clear-ticket-pr.test.ts`, add `getTicketComments` to the existing import from `../helpers/jira.js`:

```ts
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  getTicketComments,
  deleteTicket,
} from "../helpers/jira.js";
```

- [ ] **Step 2: Add the comment assertion**

After the existing block that waits for the ticket to reach `COLUMN_AI_REVIEW` (step 7 in the test) and before the Redis-cleanup wait (step 8), insert:

```ts
    // 7b. Jira ticket has a single comment linking to the PR
    const prCommentBody = await waitFor(
      async () => {
        const comments = await getTicketComments(ticketKey);
        const match = comments.filter((c) => c.body.includes(pr.url));
        return match.length === 1 ? match[0].body : null;
      },
      { description: `PR-link comment on ${ticketKey}`, timeoutMs: 60_000 },
    );
    expect(prCommentBody).toContain(`#${prNumber}`);
    expect(prCommentBody).toContain("ready for review");
```

(`pr` and `prNumber` are already in scope from the earlier `findPR` wait. Requiring exactly one matching comment guards the de-dup contract.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter worker typecheck`
Expected: PASS (exit 0). The test references only already-exported helpers and in-scope variables.

- [ ] **Step 4: Note on running the e2e**

The US-01 e2e cannot run locally (the worker + harness require a Bearer/OAuth Jira token; the local `JIRA_API_TOKEN` is basic-auth). It runs in CI via:

`pnpm --filter worker test:e2e:agent`

Confirm the assertion is satisfied there once the branch is pushed.

- [ ] **Step 5: Stage the change**

```bash
git add apps/worker/e2e/tier2/us01-clear-ticket-pr.test.ts
git commit -m "test(e2e): assert PR-link comment on the Jira ticket in US-01"
```

(If you prefer to stage commits yourself, run only `git add` and leave the commit to the user.)

---

## Self-Review

**Spec coverage:**
- "Post only on new-PR path" → Task 1 Step 2 (`if (isNewPr)`).
- "New step `postPrLinkComment`, swallow + warn, `maxRetries = 0`" → Task 1 Step 1.
- "Comment wording" → Task 1 Step 1 (verbatim string).
- "No new failure paths / never fail the run" → Task 1 Step 1 (internal try/catch).
- "e2e assertion in US-01, CI-only" → Task 2.
- "No unit test for the workflow body" → respected (Task 1 adds none; Step 4 only runs the existing suite).
- Out-of-scope items (comment scanning, re-run comments, non-PR comments) → not implemented.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — all code shown in full.

**Type consistency:** `postPrLinkComment(ticketId, prUrl, prNumber)` signature matches its call site `postPrLinkComment(ticket.identifier, pr.url, pr.id)`. `errorMessage` and `logger` references match existing `agent.ts` usage. `getTicketComments` return shape (`{ author, body }`) matches the assertion. `pr.url` (workflow) and `findPR(...).url` (e2e) are both the GitHub `html_url`.
