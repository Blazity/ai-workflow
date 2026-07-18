# End-to-End Test Plan: Workflow Revisions

Scope: AIW-92 through AIW-103 on `codex/workflows-revisions`.

This plan verifies the revised workflow editor and runtime without relying on the state of an old preview deployment. Deterministic integration tests are the release gate. A deployed browser/provider smoke complements them after the target environment, credentials, repository, and webhook subscriptions are confirmed.

## 0. Invariants under test

- **One execution path.** There is no feature-flagged legacy workflow executor. A saved draft does not affect runs; only an explicitly deployed immutable version can be selected for dispatch.
- **Draft, layout, and deployment are independent.** Semantic Save Draft advances `draftRevision`; moving blocks advances only `layoutRevision`; Deploy and Rollback select immutable versions using compare-and-set guards.
- **Dispatch is pinned.** Once accepted, a run executes the exact deployed definition/version it captured even if a newer draft is saved or another version is deployed.
- **Specialized agents own workspace convenience.** Planning can run without a workspace. Implementation, Review, and Fix prepare or resume one automatically when necessary. Explicit Prepare remains available for modular/custom graphs.
- **Finalize and Open PR/MR are separate.** Finalize is the only push boundary and returns a durable publication attempt. Open PR/MR consumes that attempt and creates or reuses provider PRs/MRs; it does not push workspace changes.
- **Clarification is a pinned continuation.** The runtime snapshots unpublished work, stores prior safe outputs and the waiting node, hands the claim to one successor, restores with fresh credentials, and reruns only that waiting agent. It does not restart from the ticket trigger. The real Vercel snapshot/restore/expiry and git-index probe passed on 2026-07-17.
- **Provider events fail closed.** GitHub/GitLab events are authenticated, filtered by the deployed definition's providers/scope/selectors, checked against the current head, stored durably, deduplicated, and coalesced by subject/head/trigger.
- **One claim per durable subject.** Correlated workflow-owned PR events share the ticket subject; arbitrary review-safe PR events use a PR subject and never synthesize a Jira ticket key. Claims remain held through the final downstream block.
- **Execution is bounded.** `maxDurationMs`, `maxTokens`, and `maxCostUsd` are part of the immutable definition. Active duration excludes human wait time; configured usage limits fail closed when usage or pricing is unavailable.

## 1. Current block catalog

The server-owned registry contains 28 blocks across nine groups:

- Triggers: ticket assigned to AI, plan approved, PR/MR created, checks failed, review submitted, PR/MR merged.
- Agents: Planning, Implementation, Review, Fix, Generic.
- Workspace: Prepare, Finalize.
- Control: Branch, Loop, Terminate.
- Ticket: Post comment, Update status.
- VCS: Fetch PR context, Open PR/MR, Post PR comment.
- Human: Send plan for approval, Human question.
- Utility: Pre-PR checks, Run checks, Call LLM, Send Slack message.
- Arthur: Prompt injection check.

`arthur_trace` is retired and upgraded out of stored legacy definitions. Core run/block telemetry is automatic.

## 2. Prerequisites

### 2.1 Deterministic verification

- Install repository dependencies and use the test database harness; do not point local tests at a shared preview database.
- Provide no live provider credentials to deterministic suites. Provider, sandbox, Jira, and Slack boundaries are mocked or exercised through adapters.
- Confirm dashboard tests are discovered by the repository-wide test command.

### 2.2 Optional deployed smoke

- Use a dedicated worker/database environment and a repository to which the configured GitHub App and/or GitLab token are intentionally scoped.
- Configure a dashboard origin and editor/admin account.
- Register Jira, GitHub, and GitLab webhooks needed by the selected rows. GitLab review coverage requires Comments/Note Hooks; merged and created coverage requires Merge Request Hooks; failed-check coverage requires Pipeline Hooks.
- Configure unambiguous bot identities for providers selected by comment-trigger definitions.
- Use inexpensive models and explicit spending limits for live agent runs.

## 3. Definitions used by the matrix

| Key | Shape | Trigger types |
|---|---|---|
| **D-V1 delivery** | ticket -> Planning -> Implementation -> Pre-PR checks -> Finalize -> Open PR -> ticket status -> Slack | `trigger_ticket_ai` |
| **D-V2 modular** | ticket -> Generic/Branch/Prepare/Generic/Run checks/Loop/Finalize/Open PR | `trigger_ticket_ai` |
| **D-V3 approval** | ticket -> Planning -> Send approval; plan approved -> Implementation -> Finalize -> Open PR | `trigger_ticket_ai`, `trigger_plan_approved` |
| **D-V4 remediation** | failed checks/review -> Fetch context -> Fix -> Finalize -> PR comment | `trigger_pr_checks_failed`, `trigger_pr_review` |
| **D-V5 merged** | PR/MR merged -> Update ticket status -> optional Slack | `trigger_pr_merged` |

D-V4 is the one canonical remediation flow. It contains no explicit Prepare, readiness Branch, internal post-PR validation, or second explainer topology. Fix returns `fixed | needs_human_input | failed`; only `fixed` follows the normal edge to Finalize.

## 4. Acceptance matrix

### Tier 0 — authoritative contracts and typed data flow

1. Fetch the registry and assert every catalog block has presentation, defaults, input schema, output schema, status variants, availability, and an unavailable reason when unavailable.
2. Author explicit bindings from `trigger.*`, `steps.<node>.output.*`, and `run.*`; validate compatible scalar, object, array, optional, and discriminated-status paths.
3. Reject unknown paths, forward/non-ancestor references, incompatible types, unbound required inputs, and unsafe object keys before deployment.
4. Execute an accepted graph and assert runtime resolves exactly the paths deployment validation accepted.
5. Confirm layout coordinates are not part of the semantic definition or deployment snapshot.

Primary deterministic coverage: `block-registry*.test.ts`, `bindings.test.ts`, `conditions.test.ts`, `schema*.test.ts`, `interpreter*.test.ts`, and `revisions-lifecycle.integration.test.ts`.

### Tier 1 — editor and immutable lifecycle

1. Create or duplicate a definition and edit its semantic draft.
2. After every semantic edit, verify debounced validation replaces stale results; there is no required manual Validate step in the normal editor flow. Direct `POST /api/v1/workflow-definitions/:id/validate` remains a cheap, side-effect-free API.
3. Verify unavailable palette blocks and rejected actions display their server or local reason.
4. Right-click a node and delete it; right-click a connection and delete it. Confirm dependent bindings are cleared or reported invalid.
5. Move one or more nodes. Verify the semantic dirty state does not change and `PATCH /:id/layout` advances only `layoutRevision`.
6. Save Draft with `expectedDraftRevision`. Verify live dispatch remains on the prior `deployedVersion`.
7. Deploy with `expectedDraftRevision` and `expectedDeployedVersion`. Verify a new immutable version and deployment audit row are created atomically.
8. Save another draft while a run is active. Verify the run remains pinned to the captured version.
9. Roll back with `{version, expectedDeployedVersion}`. Verify rollback selects an existing immutable version and records provenance without rewriting history.
10. Exercise stale draft/layout/deployment compare-and-set values and trigger-ownership conflicts; each must return an actionable conflict.

Primary deterministic coverage: dashboard `validation-controller`, `graph-edit`, `editor-actions`, `layout-save`, `serialize`, and API proxy tests; worker lifecycle/store/route tests and `revisions-lifecycle.integration.test.ts`.

### Tier 2 — canonical delivery, approval, and remediation

1. Run D-V1 and verify specialized agents materialize a workspace without an explicit Prepare node; Planning remains workspace-free.
2. Verify Pre-PR checks are the bounded internal gate before Finalize, while report-oriented Run checks expose branchable results without owning post-PR CI truth.
3. Verify Finalize preflights every repository, records expected/pushed heads, and performs the push; Open PR/MR only consumes `publicationAttemptId` and creates/reuses PRs.
4. Run D-V3. Approval ends the planning path; accepting is final and starts the separately pinned implementation path. Approval is not revocable after dispatch.
5. Run D-V4 from both a failed-check and review event. Fix reuses or implicitly prepares the workspace and reaches Finalize only on `status: fixed`.
6. Return `needs_human_input` or `failed` from Fix and verify the built-in runtime paths run without an authored Human Question/readiness Branch.

### Tier 3 — clarification, cancellation, and cleanup

1. Start an agent with committed, untracked, and unresolved merge-index work, then return `needs_human_input`.
2. Verify the checkpoint stores subject, owner, definition/version, waiting node, trigger payload, safe prior outputs, cumulative budget state, workspace manifest/source head, snapshot ID/expiry, and cleanup state.
3. Answer once. Verify one successor wins compare-and-set, restores the snapshot with fresh credentials, seeds prior outputs, reruns only the waiting agent, and follows downstream edges without replaying earlier comments or other side effects.
4. Retry the answer/dispatch and verify it cannot execute twice. Expired or missing snapshots must produce an actionable recovery failure.
5. Cancel before dispatch, during an agent, during snapshotting, during publication recovery, and after completion. Verify owner-scoped cancellation is idempotent and cannot cancel a successor/new owner.
6. Verify terminal completion/cancellation deletes snapshots, stops sandboxes, releases only the matching claim, and leaves no orphan cleanup state. Reconciliation repairs recoverable intermediate rows.

Primary deterministic coverage: clarification checkpoint/dispatch/reconciliation/runtime/snapshot suites, cancel-run suites, sandbox cleanup suites, and cancellation migration tests.

### Tier 4 — GitHub/GitLab triggers, selectors, and pending events

1. **Created/merged:** accept GitHub opened/reopened/merged PRs and GitLab opened/reopened/merged MRs selected by `providers`; ignore other actions.
2. **Failed checks:** require at least one exact check name before deployment. Enforce GitHub App slug and GitLab pipeline-source allowlists, current source head, and current GitLab MR head-pipeline ID. Ignore passing, cancelled, skipped, neutral, superseded, stale-head, and untrusted results.
3. **Review:** GitHub supports selected `changes_requested` and `commented`; GitLab supports external `commented` Note Hooks only. Reject a GitLab definition that selects `changes_requested`. Ignore bot-authored/system/internal/confidential notes and workflow-authored echoes at both route and normalizer boundaries.
4. **Scope:** `workflow_owned` requires durable provider/repository/PR/source-branch/current-head/target-branch correlation plus a real ticket lookup. A prefix or pending intent is insufficient. `any` has no synthetic ticket and cannot reach branch- or ticket-mutating blocks.
5. Persist an authenticated locally eligible delivery as `received`, enrich it to `accepted`, and verify provider redelivery is idempotent. Transient enrichment/capacity failures remain recoverable by the local poller.
6. Fire multiple actionable events while the subject is claimed. Verify failed-check sets merge, distinct reviews remain distinct, stale events are revalidated, and the oldest pending semantic event drains only after owner-matching terminal release.

### Tier 5 — merged ticket movement

1. Deploy D-V5 with `scope: workflow_owned` and a discovered Jira destination.
2. Merge the correlated GitHub PR and GitLab MR variants. Verify the common `trigger_pr_merged` payload carries merge SHA/time and the real ticket.
3. Before moving the ticket, verify a short-lived transition intent records ticket, run, exact destination, and workflow actor.
4. Deliver the matching Jira changelog/webhook identifier and verify it consumes the intent without cancelling the still-running workflow. Retries remain idempotent for the provider retry window.
5. Deliver mismatched actor/destination/identifier and unrelated human moves. They must not consume the intent; existing human-move cancellation behavior remains intact.
6. Verify Slack or any later block completes before the active claim is released.

### Tier 6 — publication safety and recovery

1. Refuse Finalize when the remote source head changed, the tree is dirty/uncommitted, a conflict remains unresolved, or a branch is outside the selected ownership policy.
2. Persist a publication attempt before push. In multi-repository runs, preflight every repository before the first push and record any partial success without reporting overall success.
3. Inject an ambiguous provider create timeout and transient publication-ledger/ownership failures. Reconcile by exact provider/repository/source head/target branch and journal the single PR/MR before continuing.
4. Verify only an authenticated current opened/reopened event can exact-CAS a pending PR identity. Check/review and wrong-target events cannot establish ownership.
5. Keep the owning claim during capped recovery; cancellation or duration exhaustion interrupts recovery without fabricating success or deleting a previously confirmed PR.

### Tier 7 — budgets and telemetry

1. Validate positive `maxDurationMs`, `maxTokens`, and `maxCostUsd`; reject invalid limits at deployment.
2. Verify active duration excludes the clarification wait and carries into the successor. Expiry during polling terminates the sandbox process and starts no later block.
3. Count input + cached-input + output tokens across agent and Call LLM phases. Exact-limit use passes; measured overage prevents the next block.
4. Derive cost from authoritative usage/pricing. Configured token/cost limits fail closed with `budget_unverifiable` when required usage or pricing is absent.
5. Assert run/block telemetry records pinned definition/version, subject, provider/model, cumulative usage, duration, terminal budget reason, and cleanup/drain completion.

### Tier 8 — deployed browser/provider smoke

1. Load the editor and inspect unavailable reasons.
2. Add/configure/delete a node, add/delete an edge, and observe automatic validation after each semantic edit.
3. Move blocks and confirm no semantic unsaved-change indicator appears; reload and confirm layout persisted.
4. Save Draft, Deploy, create another draft, and Rollback. Confirm the displayed draft/deployed revisions and version history are correct.
5. Execute one pinned D-V1 run, one GitHub or GitLab D-V4 event, one clarification continuation, and one D-V5 merge in the dedicated environment. Capture run IDs, provider delivery IDs, PR/MR URLs, ticket transitions, and terminal telemetry.

## 5. Release verification

Run from a clean worktree after the focused suites pass:

```bash
pnpm run typecheck
pnpm run test
pnpm run build
node --test docs/workflow-workspace/index.test.mjs
git diff --check
```

The release is not accepted from unit coverage alone: confirm dashboard tests are counted and record the Tier 8 browser smoke or an explicit environment blocker. Provider credentials, preview aliases, and historical deployment IDs are environment evidence, not permanent assumptions in this plan.
