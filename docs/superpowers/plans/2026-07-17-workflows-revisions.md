# Workflows revisions implementation plan

> Execute on `codex/workflows-revisions` in `/Users/karol/Desktop/ai-workflow/.worktrees/workflows-revisions`. Use test-driven development: add one focused failing test, confirm the expected failure, implement the smallest production change, and rerun the focused suite before proceeding. Move a Jira issue to In Progress only when its slice starts and to Review only after its acceptance tests pass. Do not modify the user's dirty primary checkout.

Goal: implement AIW-92–AIW-103 as one reviewable GitHub pull request on top of merged PR #118/#119.

Architecture: `docs/superpowers/specs/2026-07-17-workflows-revisions-design.md`.

Baseline evidence: `pnpm -r test` passes on `82e143b` (dashboard 124 tests; worker 1,635 tests).

The order below is dependency-driven. Subject identity precedes workspace/publication refactors, owner-CAS precedes clarification handoff, and budgets precede clarification checkpoint serialization.

## Task 0 — Preserve the reconciled product context

Files:

- Add `docs/pr-118-workflow-review-feedback.md` from the primary checkout.
- Update `docs/superpowers/specs/2026-07-07-workflow-workspace-design.md` and `docs/workflow-workspace/index.html` with the approved revisions.
- Add this plan, the implementation design, and the canvas regression test.

Verification:

- Run `node --test docs/workflow-workspace/index.test.mjs` unconditionally.
- Run `git diff --check` and confirm the unrelated primary-checkout `pnpm-workspace.yaml` change is absent.

## Task 1 — AIW-92: authoritative contracts and typed bindings

Files:

- Modify shared workflow domain/graph/API contracts.
- Add worker `workflow-definition/block-registry.ts` and `bindings.ts` with focused tests.
- Modify schema, interpreter, block types/executors, definition routes, and adjacent tests.

Steps:

1. Add failing tests for a registry entry for every block, exact source-path syntax, nested type lookup, prototype-key rejection, dynamic output schemas, and non-empty unavailable reasons.
2. Add the small JSON-shaped value schema and `node.inputs`; make the server registry authoritative for metadata, defaults, ports, inputs, outputs, availability, and reasons.
3. Add failing validation tests for missing/unknown inputs, invalid roots, self/downstream/non-dominating references, and type mismatch.
4. Implement one parser/type resolver shared by deployment validation and runtime.
5. Add failing interpreter tests proving `trigger`, `steps`, and `run` values reach executors; migrate bespoke `planFromStep`, `contentFromStep`, and `requiredChecks` references.
6. Expose the registry through the definition editor-options API and run focused shared/worker tests plus typecheck.

Acceptance:

- Every block has one server-owned contract, invalid data flow is rejected before deployment, and runtime resolves exactly the paths validation accepted.

## Task 2 — AIW-94: mutable draft, immutable deployment, rollback, and pinning

Database migration `0020`:

- Add `workflow_definitions.draft`, `draft_revision`, `layout`, `layout_revision`, and `deployed_version`.
- Treat `workflow_definition_versions` as immutable deployment snapshots.
- Add append-only `workflow_definition_deployments` with actor, selected/previous version, timestamp, action, and rollback provenance.
- Add integrity for `(definition_id, deployed_version)` → immutable version.
- Backfill the current head as draft and as the deployed version for currently enabled definitions; retain only the fresh seeded ticket definition with no stored version as built-in fallback.

Steps:

1. Add failing migration/store tests for draft CAS, layout CAS, deployment history, backfill, and fallback.
2. Save Draft updates only the mutable draft at `expectedDraftRevision`; structural validity is required but deploy-grade issues are allowed.
3. Add failing deploy/rollback tests for invalid graph, unavailable blocks, trigger conflicts, stale expected draft, exact version selection, and enable-without-deployment.
4. Implement deploy/rollback/enable as one data-modifying SQL CTE because `neon-http` has no interactive transactions. The statement validates expected state, inserts/selects an immutable version, replaces trigger bindings, records history, and updates the deployed pointer/enabled state atomically.
5. Add failing dispatch tests proving direct ticket, PR, and approval entries embed `definitionId` + exact `definitionVersion` before Workflow `start()`. Clarification and pending-event pinning are verified in their dependent slices.
6. Add worker and dashboard routes/tests for Save Draft, Validate, Deploy, Rollback, layout PATCH, and draft/deployed/history response fields.

Acceptance:

- Saving cannot alter live execution, Deploy/Rollback intentionally select immutable snapshots, and an already-dispatched run cannot drift.

## Task 3 — AIW-97: provider envelope, subject identity, durable dedupe, and pending events

Database migration `0022`:

- Change `active_runs` to primary `subject_key` with nullable `ticket_key`, an owner token/reservation, nullable bound run ID, state, and timestamps.
- Add durable normalized trigger deliveries with unique provider delivery identity.
- Add one coalesced pending semantic event per subject/head/trigger type.
- Add subject metadata to run telemetry while keeping failed-ticket and Slack-thread rows ticket-specific.

Steps:

1. Add failing normalization tests for provider, producer, delivery, repository, PR/MR, exact head, explicit `scope: workflow_owned | any`, actionable outcomes, bot filtering, allowlists, and current-head mismatch.
2. Add provider-neutral input with stable `subjectKey` and optional real `ticketKey`. Ticket triggers and durably correlated workflow-owned PRs use `ticket:<ticketProvider>:<ticketKey>`; arbitrary PRs use `pr:<vcsProvider>:<repoPath>#<prNumber>`. Remove unconditional Jira fetches from PR-only runs.
3. Add failing store tests for delivery uniqueness and semantic coalescing with merged failed checks and distinct review identities.
4. Authenticate first, then persist a normalized `received` delivery with its pinned deployed definition/version before external enrichment. Prove `workflow_owned` through durable branch/publication correlation matching provider/repository/PR/branch/current head plus a valid ticket lookup; never trust a prefix. Advance the delivery to `accepted` only after re-reading the current head and completing enrichment; local recovery resumes transient failures, and redelivery returns the stored state/result.
5. Make `any` review-safe: deploy validation rejects ticket actions, Fix, Finalize, Open PR/MR, and all other branch-mutating paths. Old violating definitions fail closed at runtime.
6. Add focused webhook, workflow, store, and telemetry tests.

Acceptance:

- Synthetic subjects never reach Jira, stale/non-actionable events start nothing, and authenticated locally eligible deliveries are durable/idempotent before external enrichment.

## Task 4 — AIW-99: owner-CAS claims, terminal release, and pending drain

Steps:

1. Add failing registry tests for reservation acquisition, candidate bind, loser exit, owner-only handoff/release, and no blind overwrite.
2. Make every dispatch reserve the subject before `start()`; each workflow candidate CAS-binds its own run ID on entry. Reconciliation retries stale reservations.
3. Add failing tests showing Open PR, Finalize, ticket movement, and notifications do not release ownership mid-run; remove mid-run unregisters.
4. Return a boolean from owner-matching compare-and-delete. Only the owner that performs terminal release may drain the oldest pending event.
5. Revalidate a pending event's head, dispatch its stored pinned deployed version, and leave it pending on capacity/new-owner races.
6. Add crash-recovery drain to reconciliation and poll cron; add tests for one post-terminal start, capacity retention, and successor-stomp prevention.

Acceptance:

- The claim lasts through the final block, retries cannot replace an owner, and actionable concurrent events are delayed rather than lost.

## Task 5 — AIW-95: specialized workspace semantics and Fix output

Steps:

1. Add failing tests for idempotent `ensureWorkspace`, specialized implicit preparation, non-code Generic without workspace, workspace-mutating Generic with explicit preparation, and attached-workspace reuse.
2. Extract `ensureWorkspace(ctx)` and make explicit Prepare a thin executor.
3. Narrow/remove virtual Prepare injection: Implementation, workspace Review, and Fix ensure; modular workspace consumers fail clearly without Prepare/bound output; Planning creates no code workspace.
4. Add failing Fix Agent tests for `fixed`, `needs_human_input`, and `failed` plus registry output compatibility.
5. Return canonical workspace/commit/conflict output and update V4 to omit explicit Prepare.

Acceptance:

- Canonical V4 is trigger → context → Fix → Finalize, Fix success is `fixed`, and modular planning remains workspace-free.

## Task 6 — AIW-102: active duration, token, and cost budgets

Database migration `0021`:

- Add the structured terminal budget failure to run telemetry. Budget limits remain part of the immutable workflow definition snapshot.

Steps:

1. Add failing schema tests for omitted/partial budgets and invalid values. Duration defaults to `JOB_TIMEOUT_MS`; token/cost stay unset.
2. Add `run-budget.ts` tests for active elapsed time, `input + cached_input + output`, direct/price-derived cost, exact-limit pass, over-limit failure, and missing usage/pricing fail-closed when the corresponding cap is configured.
3. Read wall clock only inside memoized Workflow steps. Before/during/after blocks, sleep/poll for at most remaining duration and terminate the sandbox process on expiry.
4. Check cumulative token/cost after each metered agent or Call LLM phase and before the next block; include Call LLM models in price prefetch.
5. Persist usage and deterministic `budget_exceeded`/`budget_unverifiable` telemetry, skip downstream side effects, then use normal terminal cleanup/drain.

Acceptance:

- No block starts after an observed cap, duration can interrupt work, and configured token/cost caps cannot pass unknown usage.

## Task 7 — AIW-96: preserved clarification and merge-conflict work

Capability gate result (2026-07-17): passed against the configured Vercel project. A seven-day snapshot preserved the committed tree, an untracked file, `UU` conflict status, and all three unresolved Git index stages after restoration from only a JSON-serialized snapshot ID. Scrubbed Codex, Claude, Arthur, tracer, and `/tmp/agent-env*.sh` credentials stayed absent; fresh credentials could be injected after restore. All probe sandboxes were stopped and snapshots deleted. `sandbox.snapshot()` can return while the source still reports `snapshotting`, so production must poll `Sandbox.get()` until `stopped` before publishing the checkpoint.

Capability gate:

1. Against the configured Vercel environment, create a Sandbox with committed, untracked, and unresolved-index fixtures.
2. Scrub `/tmp/agent-env*.sh`, Codex auth, Claude auth/config, and tracer credentials.
3. Snapshot with seven-day expiration, verify the source stops, restore from only the serializable snapshot ID, verify files/index, inject fresh credentials, then delete.
4. If the real plan cannot do this, leave AIW-96 In Progress with evidence; do not ship a replay/lossy substitute.

Database migration `0023` after the gate passes:

- Extend clarification checkpoints with subject, pinned definition/version, waiting node, trigger payload, safe prior outputs, cumulative budget state, workspace manifest/source head, snapshot metadata/expiry, cleanup state, and successor reservation.

Steps:

1. Add failing checkpoint/store tests, including expiry/orphan reconciliation.
2. Add serializable snapshot/restore/delete Workflow steps. Snapshot stops the source; restored sandboxes receive fresh credentials, registry ownership, and cleanup tracking.
3. Publish the clarification only after the waiting agent stops and checkpoint/snapshot are durable.
4. Add interpreter tests that seed prior outputs, rerun only the waiting agent with the answer, and follow downstream edges without replaying predecessors.
5. CAS-handoff the parked owner to a successor reservation; retry-safe candidates bind on entry and losers exit before side effects.
6. Verify edits and unresolved merge index survive; terminal/repeated clarifications delete or replace snapshots.

Acceptance:

- No unpublished work is lost, no prior side effect is replayed, and successor retries cannot execute twice.

## Task 8 — AIW-100: exact-head, clean-tree, durable publication

Database migration `0024`:

- Add durable publication attempts with run/block, overall status, and per-repository expected head, pushed head, PR result, and failure.

Steps:

1. Add failing tests for dirty/staged/untracked/conflicted trees, stale PR head, remote drift, lease rejection, and all-repository preflight.
2. Add provider current-head lookup and record exact expected remote SHA per repository.
3. Preflight every repository before any push; require a clean committed/conflict-free tree. Memory-only change policy remains separate AIW-107 scope.
4. Replace `--force` with exact `--force-with-lease`; classify lease rejection as terminal stale/concurrent and never auto-retry.
5. Split current combined publication: Finalize alone pushes and records the durable attempt; Open PR/MR accepts only successful Finalize output and only creates PRs/MRs.
6. Record provider/network partial publication durably, create no PRs, and report no success.
7. Reconcile PR/MR existence before creation and after ambiguous errors. Keep transient Open PR/MR failures in `creating_prs` and retry inside the owning workflow with capped durable backoff bounded by run duration/cancellation; only deterministic safety failures become terminal.

Acceptance:

- Newer remote work cannot be overwritten, publication state survives the run, and Finalize/Open PR cannot duplicate pushes or PR creation.

## Task 9 — AIW-101: merged trigger and self-safe ticket transitions

Database migration `0025`:

- Add short-lived workflow transition intents keyed by ticket/run/destination with consume/expiry state.

Steps:

1. Add failing contract/schema/editor tests for `trigger_pr_merged`, trigger-level ownership scope, and provider-backed status values.
2. Normalize GitHub closed+merged and GitLab merged MR events with exact head/merge metadata.
3. Fetch/deduplicate configured ticket-project statuses; use configured columns only if discovery fails.
4. Replace the two-value target enum with provider status identifiers and resolve a currently valid transition at execution.
5. Require `scope: workflow_owned` for the canonical merged → Update Ticket Status graph, giving it guaranteed ticket context.
6. Record transition intent before moving; matching Jira webhook consumes it without cancellation, unmatched human movement keeps existing cancellation behavior.

Acceptance:

- A configured merged workflow moves its correlated ticket once and cannot cancel its own still-running workflow.

## Task 10 — AIW-98: configurable GitLab review events

Steps:

1. Add failing tests for configured Note Hook comments, bot/system filtering, wrong project, stale head, duplicate delivery, and malformed payload.
2. Normalize GitLab comments to the same review payload as GitHub comments and reuse AIW-97 authentication, scope, head verification, dedupe, coalescing, and pending dispatch.
3. Reject GitLab definitions selecting `changes_requested` with a precise provider-capability reason. GitHub retains `changes_requested`; GitLab reviewer state must not be inferred from the mutable reviewers API.
4. Require a configured provider-specific bot identity for comment triggers so missing or ambiguous identity configuration fails closed rather than allowing workflow-authored recursion.

Acceptance:

- Explicitly configured GitHub/GitLab comments reach one trigger contract without workflow-authored recursion, GitHub changes-requested reviews remain supported, and unsupported GitLab changes-requested definitions fail before deployment.

## Task 11 — AIW-93: editor auto-validation, availability, and layout-only editing

Steps:

1. Add worker tests for structured validation and draft-valid/deploy-invalid graphs; expose a read-only endpoint reusing registry/schema/binding validation.
2. Add dashboard proxy tests preserving JSON/plain-text worker 400/409/500 status and useful messages.
3. Add serializer tests proving coordinate-only changes are non-semantic; persist layout through its independent CAS endpoint.
4. Add validation-state tests for debounce, stale-success clearing, abort, and response ordering; Save Draft stays available while invalid and Deploy waits for current successful validation.
5. Consume the server registry in palette/inspector. Unavailable blocks remain visible with non-empty reasons.
6. Add registry-driven input-binding controls in the inspector. Authors can select compatible `trigger.*`, dominating `steps.<id>.output.*`, and `run.*` sources (including safe variadic inputs), edit an existing exact path, and repair a migrated legacy binding without hand-editing JSON.
7. Retain right-click node deletion, connection deletion, and connected-card clipping with focused regressions.

Acceptance:

- Semantic edits auto-validate without stale results, movement never dirties the draft, every declared input can be authored in the UI, and every unavailable/error state explains itself.

## Task 12 — AIW-103: end-to-end verification and one-PR delivery

1. Add deterministic integration coverage for typed flow; draft/validate/deploy/pin/rollback; subject/dedupe/claim drain; workspace/checkpoint; publication; merged transition; supported GitHub/GitLab review events and provider limitations; and every budget outcome.
2. Run all focused suites, then fresh full verification:
   - `pnpm run typecheck`
   - `pnpm run test`
   - `pnpm run build`
   - `node --test docs/workflow-workspace/index.test.mjs`
   - `git diff --check`
3. Confirm dashboard tests are discovered/counted.
4. Start locally and browser-smoke unavailable reasons, auto-validation, movement, node/edge deletion, Save Draft, Deploy, and Rollback.
5. Request final code review, fix all high/medium findings, and rerun affected plus full checks.
6. Move every passing ticket to Review; leave a genuinely unmet capability-gated ticket In Progress with evidence.
7. Commit intentionally, push `codex/workflows-revisions`, and open one GitHub PR linking AIW-92–AIW-103.

Final acceptance: the one PR contains every verified revision, fresh test evidence, and accurate Jira assignment/status state.
