# Workflows revisions — implementation design

Date: 2026-07-17
Status: Approved for implementation through the workflow canvas review, PR #118 review reconciliation, and AIW-92–AIW-103.
Source of truth: `docs/workflow-workspace/index.html`
Supporting context: `docs/pr-118-workflow-review-feedback.md`

## Goal

Correct the merged PR #118 Workflows implementation without replacing its overall architecture. The result must keep workflow definitions editable and observable while making saved data flow explicit, deployments intentional, continuations lossless, provider events safe, and execution bounded.

This work deliberately ships as one pull request because that is the requested delivery shape. It does not include the separate Arthur tenant rollout and general AI Workflow runtime follow-ups tracked after AIW-103.

## Locked product choices

- Branch expressions remain the restricted parsed syntax from PR #118. There is no arbitrary JavaScript block.
- The existing five lifecycle triggers remain; this revision adds a sixth, PR/MR merged.
- Plan approval is final and starts the exact deployed version that produced the plan.
- Definitions persist exact typed bindings rooted at `trigger.*`, `steps.<nodeId>.output.*`, or `run.*`.
- Moving blocks is layout-only. It persists separately and never creates a draft revision or unsaved semantic change.
- Specialized code agents initialize or reuse a workspace. Generic Agent only requires an attached workspace when configured to read or mutate repositories; non-code uses such as the canonical modular planning step run without one. Modular workspace consumers require an explicit Prepare Workspace block or a compatible specialized-agent workspace output.
- Fix Agent owns `fixed | needs_human_input | failed`. Custom classifications use Generic Agent plus Branch.
- Finalize Workspace is the only publication boundary. It does not release the active execution claim.
- External CI and human-review events drive remediation. This revision does not decide whether the legacy product-owned post-PR gate is eventually retained or retired.
- There is one active execution per subject. Events received during that execution are durable and are reconsidered after its terminal release.

## 1. Server-owned block contracts and typed bindings

The shared definition contract gains an `inputs` map on each node. Each entry stores one exact source path, not an inferred connection. A server registry is authoritative for:

- presentation metadata and parameter defaults;
- input names, requiredness, and types;
- output field schemas and status variants;
- ports and failure behavior;
- environmental availability and a non-empty unavailable reason.

The type system is deliberately small and JSON-shaped: string, number, boolean, null, object, array, and unknown. Object and array schemas retain enough structure to validate nested source paths. Generic Agent and Call LLM resolve their dynamic output schema from node parameters.

Deployment validation parses every binding, verifies the source root, rejects prototype keys, resolves the referenced output type, proves that step sources dominate the consumer, and rejects missing, unknown, downstream, or incompatible values. Runtime uses the same parser to resolve inputs before invoking a block. Existing bespoke step-reference parameters are migrated to bindings.

Stored PR #118 definitions are upgraded deterministically when read. New deployments must satisfy the complete binding contract; legacy deployed versions remain loadable through the upgrader.

## 2. Draft, deployment, rollback, and layout lifecycle

`workflow_definitions` owns one mutable semantic draft (`draft`, `draft_revision`) plus independent layout metadata (`layout`, `layout_revision`). `workflow_definition_versions` becomes the append-only set of immutable deployment snapshots. `workflow_definitions.deployed_version` points to the exact snapshot currently selected for dispatch.

- Save Draft accepts a structurally valid graph even when deployment validation reports semantic issues.
- Saves include the expected draft revision and update only the mutable draft; a stale revision is rejected with 409.
- Deploy validates one exact draft revision, appends an immutable deployment snapshot, checks trigger ownership, then atomically selects it as the deployed version.
- Rollback selects a prior immutable revision through the same deployment path and records the selection in deployment history.
- Enable requires a valid deployed revision. Trigger bindings are derived from the deployed revision, never the latest draft.
- Every dispatch resolves and embeds `definitionId` plus `definitionVersion` before starting the run. Approvals and clarification successors preserve that pair.

Every deploy or rollback is appended to `workflow_definition_deployments` with actor, selected version, previous version, timestamp, and rollback provenance. Because production uses `neon-http` without interactive transactions, selecting a version, claiming its trigger bindings, recording history, and updating `deployed_version`/`enabled` is one data-modifying SQL CTE. The `(definition_id, deployed_version)` pointer is constrained to an existing immutable version. A fresh seeded ticket definition with no draft or deployed version is the only built-in fallback; migrations turn the current head of every existing enabled definition into its deployed version.

Node coordinates are stored as definition layout metadata and patched independently with a layout-revision CAS and debounce. Reads overlay the current layout onto the semantic draft. Layout writes neither change the draft revision nor enable Deploy.

## 3. Editor validation and availability

The editor consumes the server registry instead of maintaining a second block catalog. Unavailable blocks remain visible, disabled, and explain why. A saved block that becomes unavailable shows the same reason in its inspector and validation result.

Semantic edits clear stale success immediately and call a debounced validation endpoint. Requests are abortable and sequenced so an older response cannot overwrite a newer edit. Invalid graphs may still be saved as drafts, but Deploy remains disabled. Worker JSON or plain-text errors retain their status and useful message through the dashboard proxy.

Existing right-click node deletion and connection deletion stay supported. Long connected-card text retains clipping/ellipsis regression coverage.

## 4. Workspace initialization and clarification continuation

Workspace preparation is extracted into an idempotent `ensureWorkspace` operation. Implementation, workspace-based Review, and Fix agents call it when needed; an already attached workspace is reused. Planning and non-code Generic Agent configurations do not create a code workspace. Workspace-mutating Generic Agent configurations, Run Checks, and Finalize Workspace require the graph to provide Prepare Workspace or a specialized-agent workspace output. Open PR/MR requires successful Finalize output, never a raw workspace.

Clarification targets a pinned successor rather than replaying the graph from its trigger. This design is gated on a real Vercel Sandbox capability probe before persistence code is accepted: create a conflict/untracked fixture, scrub credentials, snapshot it with the target seven-day retention, restore it, verify the git index and files, and delete it. If the deployed Vercel plan cannot perform that lifecycle, AIW-96 remains visibly incomplete rather than shipping a lossy fallback.

After that gate passes:

1. After the waiting agent exits, the runtime captures the exact definition/version, waiting node, prior safe block outputs, trigger payload, workspace manifest, source head, and execution-budget usage.
2. If a workspace exists, runtime credentials are scrubbed and the sandbox is snapshotted. Snapshotting stops the source sandbox, so snapshot, restore, and delete are serializable Workflow steps that pass only IDs/metadata. One snapshot is retained for the pending clarification for seven days; a repeated clarification replaces it. The scrub list covers `/tmp/agent-env*.sh`, Codex auth, Claude auth/config, and tracer credentials.
3. The clarification row is published only after the checkpoint is durable. Snapshot failure fails the run visibly instead of claiming that work was preserved.
4. An answer CAS-hands the subject claim from the parked run to a durable successor reservation. Workflow `start()` may be retried, so each candidate CAS-binds that reservation to its own Workflow run ID on entry; losers exit before side effects and reconciliation retries stale reservations.
5. The winning successor restores the sandbox from the snapshot, injects fresh credentials, registers it under the successor claim, adds it to cleanup tracking, seeds prior outputs, reruns only the waiting agent with the answer, then follows downstream edges. Prior side effects are not replayed.
6. Terminal completion deletes the snapshot. A repeated clarification replaces the checkpoint. An expired or unavailable snapshot produces an actionable recovery error. Reconciliation also expires or repairs orphaned checkpoint rows instead of leaving stale application state.

The same mechanism preserves an unresolved Git merge index so Fix Agent can ask rather than discarding conflict work.

## 5. Safe publication

Finalize Workspace performs an all-repository preflight before any push:

- require a clean tracked, staged, untracked, and conflict-free tree;
- re-read each PR/MR's current head and compare it with the triggering source SHA;
- fetch the remote branch and record the exact expected remote SHA;
- push with `--force-with-lease=refs/heads/<branch>:<expectedSha>`.

A stale head or lease rejection is terminal and is never sent through an automated push-retry/fix loop. All repositories preflight before the first push. Provider/network failure can still make a cross-provider push physically partial, but the run creates no PRs, reports no success, and records every repository's expected head, pushed head, PR result, and failure in a durable publication-attempt record.

Finalize pushes branches and emits the durable publication attempt plus finalized branch metadata. Open PR/MR consumes only that successful output to create PRs/MRs; it cannot push or accept a raw workspace, so the two blocks cannot duplicate publication.

## 6. Provider events, subject identity, and pending dispatch

Webhook authentication remains the first gate. After authentication, normalization, and local definition/selector checks, a delivery receives a durable `received` record before provider-current-head, ownership, or ticket enrichment. Successful enrichment advances it to `accepted` before dispatch; transient enrichment failures remain `received` for the local recovery poller. Delivery identity is unique per provider, so redelivery is idempotent. GitLab uses `webhook-id`, then `Idempotency-Key`; when neither exists it hashes `X-Gitlab-Event-UUID + NUL + raw body`. `X-Gitlab-Webhook-UUID` identifies the webhook configuration and is never a delivery key.

Event normalization includes provider, producer, repository, PR/MR number, head SHA, pipeline ID where available, and delivery ID. Failed-check triggers require at least one exact check name; trusted-source defaults are GitHub App slug `github-actions` and GitLab pipeline source `merge_request_event`. Name and source selectors fail closed, while human-authored review feedback excludes AI Workflow's own comments and GitLab internal notes. Passing, cancelled, neutral, skipped, superseded, non-terminal, stale-head, and otherwise non-actionable results start nothing. The provider API re-reads the current PR/MR head both before immediate dispatch and before a queued delivery starts; GitLab additionally requires the event pipeline ID to equal the merge request's current head-pipeline ID.

The run registry uses a `subjectKey` for serialization and stores nullable real ticket context separately. PR/MR input carries `ticketKey?: string`, and telemetry records both fields. A workflow-owned branch supplies a real ticket key; an allowed arbitrary PR/MR does not. Runtime never sends a synthetic subject key to Jira, and failed-ticket/Slack-thread storage remains ticket-specific.

Each PR/MR trigger has an explicit `scope: "workflow_owned" | "any"`. `workflow_owned` is proven by a durable workflow-owned branch/publication record that matches provider, repository, PR/MR, branch, and current head plus a valid ticket lookup; a branch-name prefix alone is never proof. It guarantees correlated ticket context and permits downstream ticket and workspace-mutating blocks. `any` leaves the ticket optional and is review-safe in this revision: deployment rejects paths from it into ticket actions, Fix, Finalize, Open PR/MR, or other branch-mutating blocks. Runtime fails closed if a legacy definition violates the rule. Whether a later explicit policy may mutate arbitrary human-authored branches remains an open product decision.

Canonical serialization keys are namespaced and stable: ticket triggers and their durably correlated workflow-owned PRs use `ticket:<ticketProvider>:<ticketKey>` so they share one claim; arbitrary PRs use `pr:<vcsProvider>:<repoPath>#<prNumber>`. Neither form is substituted for the optional real `ticketKey`.

Claims are acquired as durable reservation IDs, then CAS-bound by the winning Workflow run on entry; registry writes never blindly overwrite an owner. When a subject is already claimed, the authenticated actionable delivery is folded into one pending semantic event per subject, exact head, and trigger type rather than being acknowledged and lost. Failed-check sets are merged and distinct review identities are retained. Only an owner-matching terminal compare-and-delete may drain the oldest pending semantic event. A race with a new owner leaves it pending for that owner's terminal drain. Each pending event is revalidated against the current head, so stale same-head events become ignored after a fix publishes a new SHA.

Clarification is non-terminal: it retains the claim and hands it to its pinned successor. Plan approval ends its planning path and releases normally; the approved trigger starts a separately pinned path.

## 7. GitLab reviews and merged ticket transitions

GitLab merge-request Note Hooks normalize only external, non-system notes to the common `commented` review payload, with configured event and bot-author filtering at both the route and normalizer. Internal/confidential notes fail closed. The actionable contract is GitHub changes requested and comments, but GitLab comments only. GitLab Request Changes remains unsupported because GitLab does not emit a reliable delivery that distinguishes that transition, and the worker does not infer it from mutable reviewer state. Deployment therefore rejects a GitLab `trigger_pr_review` that selects `changes_requested`, while GitHub continues to support both `changes_requested` and `commented`. A commented trigger requires an unambiguous bot identity for every selected provider, and every review trigger retains at least one selected review state. The editor surfaces these provider limits instead of advertising inert selectors. Which supported selectors should be enabled by default remains open. Provider-specific payload parsing stays behind the common trigger contract.

GitHub `pull_request.closed` with `merged=true` and GitLab's merged merge-request event normalize to `trigger_pr_merged`. The trigger can feed Update Ticket Status. Editor status choices are fetched from the configured ticket provider/project and deduplicated; configured AI Review/Backlog values are only a fallback when provider discovery fails.

The merged event carries a real ticket only when correlation succeeds. Before Update Ticket Status calls the provider, it records a two-hour transition intent containing the ticket, owning run, exact destination, and authenticated workflow actor account ID. Jira echoes are consumed only from an exact status changelog destination with the same actor and stable `X-Atlassian-Webhook-Identifier`; retries with that identifier remain idempotent for the full provider retry window. Missing or mismatched identity fails closed, and unmatched human moves keep the existing cancellation behavior. The active claim remains until all downstream notification blocks finish.

## 8. Execution budgets

Definitions include optional execution limits: `maxDurationMs`, `maxTokens`, and `maxCostUsd`. Duration defaults to the existing `JOB_TIMEOUT_MS` (30 minutes today). Token and cost remain unset until an operator chooses them; the meeting explicitly did not select spend thresholds, so this revision does not invent organization-wide defaults.

Deploy rejects non-positive or invalid values. Runtime records active elapsed duration and cumulative usage in the checkpoint; human waiting time is excluded, while active time and usage carry into a clarification successor. It checks remaining duration before every block, during agent polling, and after every block. Replay-safe wall-clock reads occur inside memoized Workflow steps; polling sleeps for at most the remaining duration and terminates the sandbox process on expiry. Token usage is `input + cached_input + output` across every metered phase. Token and cost usage are checked after every usage-reporting agent/LLM phase and before starting the next block. A configured token cap fails closed if authoritative usage is absent. A configured cost cap fails closed if usage or pricing is unavailable. Price lookup covers agent blocks and Call LLM models. Because the current CLI protocols report authoritative usage at phase completion, a single phase may consume beyond its remaining token/cost allowance; no later block runs and the terminal reason includes the measured overage. This is the enforceable boundary until all supported harnesses expose streaming usage cancellation.

Budget exhaustion follows one deterministic built-in failure path, is persisted in block/run telemetry, releases the claim at terminal cleanup, and then drains pending events.

## Compatibility and rollout

- Database migrations backfill every enabled definition's deployed version from its current immutable head.
- Existing definitions are upgraded on read and rewritten as the current schema on their next draft save.
- The built-in fallback remains available only for the ticket trigger when no stored definition has ever been deployed, preserving fresh-install behavior.
- No feature-flagged legacy execution fork is added; the reconciled decision is one tested execution path.
- AIW-103 requires focused integration coverage for edit/validate/save/deploy/rollback, pinned dispatch, clarification restore, stale publication, delivery dedupe/pending drain, GitLab review, merged transition, and budget termination, followed by the full repository test/typecheck/build suite and a browser editor smoke.

## Out of scope

- Deciding the long-term fate of the legacy post-PR gate.
- MCP workflow authoring.
- Arthur observability replacement or Arthur tenant rollout.
- General failed-run truth, Claude protocol diagnostics, memory-only runtime bugs outside the Finalize invariant, and VCS mention re-entry.
- On-prem snapshot replacement and long-term workspace retention policy.
