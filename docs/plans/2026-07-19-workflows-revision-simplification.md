# Workflows Revision Simplification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve the agreed Workflows revision behavior while reducing PR #120 below 60,000 added lines and removing unapproved durability machinery.

**Architecture:** Reuse PR #118's workflow versions, run ownership, telemetry, and owned-branch records. Add only compact deployed/layout pointers, one provider-event inbox, Workflow-hook clarification metadata, exact publication heads, and a small Jira transition intent. Human-authored PRs remain review-only; mutation requires exact workflow ownership.

**Tech Stack:** TypeScript, Nitro, Vercel Workflow 4.6, Vercel Sandbox, Drizzle/PostgreSQL, React/Next.js, Vitest, Node test runner.

---

### Task 1: Make `scope:any` genuinely review-only

**Files:**
- Modify: `apps/worker/src/workflow-definition/schema.test.ts`
- Modify: `apps/worker/src/workflow-definition/schema.ts`
- Modify: `apps/worker/src/workflows/agent-trigger-output.test.ts`
- Modify: `apps/worker/src/workflows/workflow-ticket.test.ts`
- Modify: `apps/worker/src/workflows/agent.ts`

**Step 1: Write failing policy tests**

Add one table-driven test proving a `scope:any` PR trigger may reach `fetch_pr_context`, `prepare_workspace`, `review_agent`, `run_checks`, `call_llm`, `post_pr_comment`, Branch, and Loop.

Add one table-driven test proving it cannot reach Implementation, Fix, Generic Agent, pre-PR checks, Finalize, Open PR/MR, or ticket actions. Add a workspace test proving the human PR's current head is checked out without creating or publishing an AI branch.

**Step 2: Verify RED**

Run: `pnpm --filter worker test -- apps/worker/src/workflow-definition/schema.test.ts`

Expected: the Review Agent and Run Checks cases fail because the current policy denies them.

**Step 3: Implement the parameter-aware review policy**

Update the review-safe policy to allow Prepare Workspace, Review Agent, and Run Checks while retaining the explicit deny list for implementation, publication, Generic Agent, and ticket mutation. Preserve runtime revalidation and removal of ticket fields from `scope:any` trigger output.

**Step 4: Verify GREEN**

Run the focused schema, trigger-output, and workflow-ticket suites. Confirm no Jira lookup occurs and no ticket key is synthesized.

**Step 5: Commit**

Commit message: `Constrain human PR workflows to review-only behavior`

### Task 2: Prove the Workflow hook boundary

**Files:**
- Create: `apps/worker/workflow-test-fixtures/clarification-hook/workflow.ts`
- Create: `apps/worker/workflow-sdk-tests/clarification-hook.test.ts`
- Modify: `apps/worker/vitest.run-control-workflow.config.ts`

**Step 1: Write the failing SDK integration**

Create one real Workflow 4.6 fixture that registers a deterministic `createHook()` token, suspends with local state, resumes through `resumeHook()`, and continues once. Cover token conflict and duplicate resume without reproducing application orchestration.

**Step 2: Verify RED**

Run: `pnpm --filter worker test:workflow-sdk`

Expected: the new fixture fails until its hook entry point and test runtime wiring exist.

**Step 3: Verify the deployed retention assumption**

Run a preview smoke that leaves a hook waiting across a redeploy and resumes it. Record the supported waiting duration. If it cannot meet the clarification window, stop the hook-based clarification work and report the blocker; do not remove the current continuation path speculatively.

**Step 4: Commit**

Commit message: `Verify durable clarification hooks`

### Task 3: Simplify definition contracts and deployment lifecycle

**Files:**
- Modify: `apps/worker/src/workflow-definition/block-registry.ts`
- Delete: `apps/worker/src/workflow-definition/block-registry.outputs.test.ts`
- Modify: `apps/worker/src/workflow-definition/block-registry.test.ts`
- Modify: `apps/worker/src/workflow-definition/schema.ts`
- Modify: `apps/worker/src/workflow-definition/store.ts`
- Modify: `apps/worker/src/workflow-definition/store.test.ts`
- Modify: `apps/worker/src/workflow-definition/lifecycle.test.ts`
- Modify: `apps/worker/src/workflow-definition/revisions-lifecycle.integration.test.ts`
- Modify: `apps/dashboard/lib/workflow-editor/binding-options.ts`
- Modify: `apps/dashboard/lib/workflow-editor/binding-options.test.ts`

**Step 1: Preserve only lifecycle invariants**

Write focused tests for: save does not change the deployed pointer; deploy pins one exact version; rollback selects a prior immutable version; layout writes change neither semantic revision nor deployed version; invalid bindings cannot deploy.

**Step 2: Verify the tests expose current representation coupling**

Run the store/lifecycle suites and confirm the new tests fail when they assert reuse of existing version rows without a deployment-history record.

**Step 3: Simplify storage**

Use `workflow_definition_versions` as semantic revision history and deployment snapshots. Keep only `deployedVersion`, `layout`, and `layoutRevision` on the definition row. Remove `workflow_definition_deployments`, duplicated draft JSON/revision state, and built-in-fallback markers that can be derived from absence of stored deployment.

Remove permanent legacy-binding repair state. Upgrade legacy graphs at the read/save boundary and persist the current form on the next explicit save.

**Step 4: Reduce the registry**

Delete the test that copies executor outputs. Make the registry reuse shared block metadata and retain only runtime-owned inputs, outputs, availability, and dynamic schema functions. Keep one catalog-sync test and one executor-contract integration test.

**Step 5: Verify and commit**

Run focused worker and dashboard lifecycle/binding suites, then typecheck both packages.

Commit message: `Simplify workflow definition lifecycle`

### Task 4: Collapse provider deliveries, subject ownership, and pending events

**Files:**
- Modify: `apps/worker/src/db/schema.ts`
- Modify: `apps/worker/src/adapters/run-registry/postgres.ts`
- Modify: `apps/worker/src/adapters/run-registry/postgres.test.ts`
- Modify: `apps/worker/src/lib/dispatch-trigger.ts`
- Modify: `apps/worker/src/lib/dispatch-trigger.test.ts`
- Replace: `apps/worker/src/lib/trigger-delivery-store.ts`
- Modify: `apps/worker/src/lib/trigger-delivery-store.test.ts`
- Delete: `apps/worker/src/lib/pending-trigger-recovery.ts`
- Modify: `apps/worker/src/lib/reconcile.ts`
- Modify: `apps/worker/src/routes/cron/poll.get.ts`
- Modify: `apps/worker/src/workflows/run-ownership-steps.ts`

**Step 1: Write the minimal concurrency tests**

Keep one test each for retry-stable deduplication, current-head rejection, one active owner, owner-only terminal release, one coalesced pending event, and exactly one post-terminal successor. Add a failing test proving no recovery poll is required for a delivery that was never accepted.

**Step 2: Verify RED**

Run dispatch, delivery-store, and run-registry suites. Confirm expectations differ from the current received/accepted/completed reservation protocol.

**Step 3: Implement one compact inbox**

Use one provider-event table for stable delivery identity and pending semantic payload. Keep `subjectKey` separate from nullable `ticketKey`. Use the workflow run ID as owner; remove reservation tokens, parking/cancelling state expansion, provider-call counters, and polling of unaccepted deliveries.

Retain `active_run_sandboxes` with `(subjectKey, runId, sandboxId)` ownership because one run can create multiple sandboxes that all require cleanup.

Authenticate and normalize before insertion, re-read current head before dispatch, and coalesce one pending event only when the subject is actively owned. Release only during terminal cleanup and drain through one owner-checked operation.

**Step 4: Remove recovery machinery and verify**

Remove the cron/reconcile paths that exist only for intermediate delivery states. Run focused webhook, dispatch, ownership, and approval tests.

**Step 5: Commit**

Commit message: `Simplify workflow event ownership`

### Task 5: Resume clarification through a Workflow hook

**Files:**
- Create: `apps/worker/workflow-sdk-tests/clarification-hook-workflow.ts`
- Create: `apps/worker/workflow-sdk-tests/clarification-hook.test.ts`
- Modify: `apps/worker/src/db/clarifications-schema.ts`
- Modify: `apps/worker/src/clarifications/store.ts`
- Modify: `apps/worker/src/clarifications/store.test.ts`
- Modify: `apps/worker/src/routes/api/v1/clarifications/[id]/answer.post.ts`
- Modify: `apps/worker/src/workflows/agent.ts`
- Modify: `apps/worker/src/workflows/clarification-snapshot-steps.ts`
- Delete: `apps/worker/src/clarifications/checkpoint.ts`
- Delete: `apps/worker/src/clarifications/dispatch.ts`
- Delete: `apps/worker/src/clarifications/reconciliation.ts`
- Delete: `apps/worker/src/workflows/clarification-checkpoint-steps.ts`

**Step 1: Add compact clarification metadata**

Store questions, hook token, snapshot ID/status/expiry, and cleanup state. Keep interpreter outputs, budget state, and ownership in the suspended Workflow run rather than serializing them into PostgreSQL.

**Step 2: Resume the same run**

Snapshot the scrubbed sandbox, publish the clarification only after snapshot durability, await the hook, restore with fresh credentials, and continue from the waiting block without replaying earlier side effects. The answer route authorizes the request and calls `resumeHook()`.

**Step 3: Delete successor/parking machinery and verify**

Keep one full suspend/snapshot/resume integration, one expiry/cleanup test, and one answer race test. Remove exhaustive intermediate-state matrices.

**Step 4: Commit**

Commit message: `Resume workflow clarification with durable hooks`

### Task 6: Make publication direct and ownership-safe

**Files:**
- Modify: `apps/worker/src/workflows/workspace-publication.ts`
- Modify: `apps/worker/src/workflows/workspace-publication.test.ts`
- Modify: `apps/worker/src/workflows/blocks/finalize-workspace.ts`
- Modify: `apps/worker/src/workflows/repository-prs.ts`
- Modify: `apps/worker/src/db/queries/workflow-owned-branches.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.ts`
- Modify: `apps/worker/src/sandbox/trusted-workspace-publisher.test.ts`
- Delete: `apps/worker/src/publication/store.ts`
- Delete: `apps/worker/src/publication/store.test.ts`

**Step 1: Keep the publication invariants as tests**

Write/retain one test each for dirty/conflicted trees, stale PR head, changed remote head, exact force-with-lease arguments, all-repository preflight, ambiguous PR creation lookup, and ownership recorded only after exact-head validation.

**Step 2: Verify the tests fail against the ledger-free API**

Change the test-facing publication contract first so it returns finalized branch metadata directly; confirm current ledger-dependent expectations fail.

**Step 3: Implement direct publication**

Reduce the trusted publisher to manifest validation, clean/conflict/current-head checks, all-repository preflight, and exact force-with-lease push. Finalize returns expected/pushed heads. Open PR/MR consumes only finalized output and performs lookup-before-create. Persist exact published head and target branch on existing workflow-owned branch records.

**Step 4: Delete the ledger and retry state machine**

Remove publication-attempt stores, trusted publisher wrappers, and their recovery loops. Provider failures remain Workflow step failures; deterministic stale/lease failures are terminal.

**Step 5: Verify and commit**

Run publication, Finalize, Open PR, and owned-branch suites.

Commit message: `Simplify safe workflow publication`

### Task 7: Reduce Jira transition handling to actor filtering or one self-echo intent

**Files:**
- Modify: `apps/worker/src/lib/ticket-transition-intent-store.ts`
- Modify: `apps/worker/src/lib/ticket-transition-intent-store.test.ts`
- Modify: `apps/worker/src/lib/ticket-transition.ts`
- Modify: `apps/worker/src/routes/webhooks/jira.post.ts`
- Modify: `apps/worker/src/routes/webhooks/jira.post.test.ts`
- Delete: `apps/worker/src/lib/ticket-label-mutation.ts`
- Delete: `apps/worker/src/lib/ticket-label-mutation.test.ts`
- Delete: `apps/worker/src/lib/ticket-cancellation-reconciliation.ts`
- Delete: `apps/worker/src/routes/api/v1/runs/[runId]/cancel.post.ts`
- Delete: `apps/dashboard/app/api/runs/[runId]/cancel/route.ts`

**Step 1: Write the actor-bound behavioral tests**

Prove a status change authored by the configured workflow Jira account does not cancel the run, while an unmatched human move does. Missing or ambiguous actor identity must fail safely.

**Step 2: Verify whether actor filtering is sufficient**

Exercise the real Jira webhook shape and adapter identity. If actor identity is reliable, delete transition-intent persistence. Only retain a compact intent when the evidence shows actor filtering cannot distinguish the echo.

**Step 3: Implement the minimum proven mechanism**

Prefer direct actor filtering. If an intent is necessary, store only ticket, destination, actor, expiry, and consumed timestamp immediately before the Jira call. Use owner-checked active-run cancellation for unmatched human moves.

**Step 4: Remove unrelated protocols**

Delete label intents, cancellation fences, reconciliation versions, provider-call tracking, and unwired cancel routes. Clarification/approval labels return to best-effort behavior.

**Step 5: Verify and commit**

Run Jira webhook, transition, active-run, clarification-label, and approval-label focused suites.

Commit message: `Simplify workflow ticket transition safety`

### Task 8: Squash the unshipped database history

**Files:**
- Delete: `apps/worker/drizzle/0020_*.sql` through `apps/worker/drizzle/0035_*.sql`
- Delete: `apps/worker/drizzle/meta/0020_snapshot.json` through `0035_snapshot.json`
- Modify: `apps/worker/drizzle/meta/_journal.json`
- Create: `apps/worker/drizzle/0020_workflows_revision.sql`
- Create: `apps/worker/drizzle/meta/0020_snapshot.json`
- Modify: `apps/worker/src/db/schema.ts`
- Modify: `apps/worker/src/db/clarifications-schema.ts`
- Replace migration-specific tests under `apps/worker/src/db/*migration.test.ts` with `apps/worker/src/db/workflows-revision-migration.test.ts`

**Step 1: Write one upgrade test from migration `0019`**

Create representative PR #118 definitions, versions, active runs, clarifications, workflow runs, and owned branches. Apply the new migration and assert backfill, constraints, retained data, and absence of removed tables/functions/triggers.

**Step 2: Verify RED**

Run the new migration test before creating `0020_workflows_revision.sql` and confirm it fails because the migration does not exist.

**Step 3: Generate one final migration**

Align Drizzle schema with the simplified runtime, remove `0020`-`0035`, and generate one migration/snapshot from `0019`. Review SQL manually; preserve user data and avoid intermediate-branch compatibility.

**Step 4: Verify migration integrity**

Run the new upgrade test, all DB store suites, `pnpm --filter worker exec drizzle-kit check`, and `git diff --check`.

**Step 5: Commit**

Commit message: `Squash workflows revision migration`

### Task 9: Consolidate tests, documentation, and CI

**Files:**
- Delete: `docs/workflow-workspace/index.test.mjs`
- Modify: `docs/workflow-workspace/index.html`
- Delete: `docs/pr-118-workflow-review-feedback.md`
- Delete: `docs/superpowers/plans/2026-07-17-workflows-revisions.md`
- Delete: `docs/superpowers/specs/2026-07-17-workflows-revisions-design.md`
- Revert this branch's changes to `docs/superpowers/specs/2026-07-07-workflow-workspace-design.md`
- Modify/delete duplicated suites identified by Tasks 1-7
- Modify: `.github/workflows/ci.yml` only if PR-specific serialization remains
- Modify: `apps/worker/vitest.config.ts`
- Delete: `apps/worker/vitest.run-control-workflow.config.ts` if the retained SDK hook test can use the canonical Workflow test configuration

**Step 1: Measure before deletion**

Record total additions, test additions, generated migration additions, and the 20 largest files.

**Step 2: Delete false-confidence tests**

Remove prose regex, copied executor output, forwarding-wrapper, source-scan, intermediate snapshot-chain, and duplicate state-matrix tests. Preserve the canonical behavior tests listed in the design.

Delete suites dedicated only to removed parking/handoff, owner-reservation, publication-ledger, label-fence, cancellation-reconciliation, run-cancel, and intermediate-migration protocols. Revert `cancel-run.test.ts` and `reconcile.test.ts` to their `origin/main` behavior before adding only tests required by the retained terminal-release flow.

**Step 3: Reconcile the source of truth**

Update the canvas to describe the simplified architecture and review-only human PR scope. Remove duplicate prose rather than adding another full specification.

**Step 4: Remove test-only CI machinery**

Restore standard test execution unless a focused, reproducible resource limit still requires serialization after consolidation.

**Step 5: Verify and commit**

Run worker/dashboard focused suites and `git diff --check`.

Commit message: `Consolidate workflows revision coverage`

### Task 10: Full verification and diff-budget gate

**Files:**
- Modify only files required by failures attributable to the simplification

**Step 1: Run fresh verification**

Run:

- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run build`
- `pnpm --filter worker test:workflow-sdk`
- `pnpm --filter worker exec drizzle-kit check`
- `git diff --check`

**Step 2: Browser smoke the editor**

Verify auto-validation, unavailable reasons, layout-only movement, node/edge deletion, Save Draft, Deploy, Rollback, and `scope:any` review-only authoring.

**Step 3: Enforce the size target**

Compare `origin/main...HEAD`. The PR must have fewer than 60,000 additions. If it exceeds the target, remove duplication or split deferred work; do not weaken retained safety invariants merely to hit the number.

**Step 4: Request final review**

Run spec-compliance and strict code-quality reviews. Resolve all high/medium findings and rerun affected plus full checks.

**Step 5: Commit and push**

Commit any verified final corrections, push `codex/workflows-revisions`, and update PR #120's summary and verification evidence.
