# Provider Event Freshness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix provider payload/freshness races, isolate pending events by deployed version, restore transition-intent migration coverage, and preserve old review-trigger drafts.

**Architecture:** Normalize stable provider identities at ingress, enrich/revalidate mutable provider state immediately before dispatch, and encode semantic isolation in the pending-event key. Keep storage upgrades deterministic and migrations additive.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM/PostgreSQL, Octokit, GitLab API client.

---

### Task 1: GitLab authoritative source head

**Files:**
- Modify: `apps/worker/src/lib/trigger-events.test.ts`
- Modify: `apps/worker/src/lib/dispatch-trigger.test.ts`
- Modify: `apps/worker/src/lib/trigger-events.ts`
- Modify: `apps/worker/src/lib/dispatch-trigger.ts`

1. Add a documented Pipeline Hook fixture with no `merge_request.last_commit` and assert normalization retains pipeline identity without inventing a head.
2. Run the focused tests and confirm the dispatch regression fails.
3. Enrich the accepted GitLab event with the authoritative MR head and require exact current pipeline ID.
4. Re-run focused tests.

### Task 2: GitHub same-SHA rerun freshness

**Files:**
- Modify: `apps/worker/src/lib/trigger-events.test.ts`
- Modify: `apps/worker/src/lib/dispatch-trigger.test.ts`
- Modify: `apps/worker/src/adapters/vcs/github.test.ts`
- Modify: `apps/worker/src/lib/trigger-events.ts`
- Modify: `apps/worker/src/adapters/vcs/types.ts`
- Modify: `apps/worker/src/adapters/vcs/github.ts`
- Modify: `apps/worker/src/lib/dispatch-trigger.ts`
- Modify: `apps/worker/src/workflows/agent-input.ts`

1. Add failing tests for stable check-run identity and a successful same-SHA rerun invalidating a queued failure.
2. Run focused tests and verify the expected failures.
3. Add the minimal authoritative latest-check query and matching/invalidation logic.
4. Re-run focused tests.

### Task 3: Pending-event identity and newest GitLab payload

**Files:**
- Modify: `apps/worker/src/lib/trigger-delivery-store.test.ts`
- Modify: `apps/worker/src/lib/trigger-delivery-store.ts`
- Modify: `apps/worker/src/db/schema.ts`
- Add: `apps/worker/drizzle/0025_*.sql`
- Add: `apps/worker/drizzle/meta/0025_snapshot.json`
- Modify: `apps/worker/drizzle/meta/_journal.json`

1. Add failing store tests proving different definition/version pins remain separate and a later GitLab pipeline is the representative payload.
2. Run the store test and verify the version-isolation failure.
3. Extend the pending primary key and all lookup/delete identities with definition ID/version; preserve newest compatible provider payload.
4. Re-run store and dispatch tests.
5. Generate the migration only after trusted-publication's corrected cumulative `0024` is rebased.

### Task 4: Stored review-state compatibility

**Files:**
- Modify: `apps/worker/src/workflow-definition/schema.test.ts`
- Modify: `apps/worker/src/workflow-definition/schema.ts`

1. Add a failing upgrade test for stored `trigger_pr_review.on: []`.
2. Verify the test fails because the upgraded graph remains structurally invalid.
3. Normalize only the empty stored array to the existing runtime default.
4. Re-run schema tests.

### Task 5: Transition-intent migration

**Files:**
- Add to the same `0025` migration and snapshot from Task 3.
- Modify migration replay tests/config only if the repository already has a migration verification hook.

1. Assert the post-`0024` schema lacks the required actor/webhook identity columns.
2. Add only `actor_account_id`, `webhook_identifier`, and the unique webhook-identifier index, including a safe backfill for existing short-lived rows.
3. Replay migrations from `0024` and compare to the Drizzle schema.

### Task 6: Verification and commit

1. Run focused Vitest files for trigger events, dispatch, delivery store, VCS adapters, and workflow schema.
2. Run worker typecheck and the relevant broader worker test target.
3. Inspect the diff for unrelated changes.
4. Commit the verified implementation.
