# PR #118 workflow review and sync reconciliation

Working register updated after the 2026-07-17 AI Workflow sync. It records the review findings, what the team actually decided in the sync, and what remains open. It is not a replacement design document and no feedback has been posted to GitHub.

Inputs:

- PR #118 final head: `af1898268c758c87902713d23080d7e2b3ed9d8f` (now merged).
- Source of truth: `docs/workflow-workspace/index.html`.
- Supporting context: `docs/superpowers/specs/2026-07-07-workflow-workspace-design.md`.
- Reference implementation: `d33775fedc25edd6eb2364299731b2d384523b8a`.
- Sync transcript: `17-07-2026 — AI-workflow sync.txt`, 2026-07-17, with Artur Sidwa, Filip Maszota, Jakub Jabłoński, and Karol Chudzik.

The sync is not treated as approval of topics that were never raised. A prior review position remains a review position unless the transcript explicitly accepts, rejects, or changes it.

## 2026-07-17 sync summary

### Decisions

1. **Do not maintain a feature-flagged legacy execution fallback.** The proposal to keep definitions editable while a default-off flag continued to execute the old lifecycle was withdrawn. The team chose to avoid two parallel implementations, test the new workflow implementation before customer rollout, and then ship one execution path (`05:58–10:51`). This supersedes the earlier feature-flag request in this review.
2. **Keep the current overall workflow direction.** The implementation was judged broadly consistent with the intended vision; the remaining workflow work was characterized as targeted corrections rather than a redesign (`13:07–14:41`).
3. **Own prompt management inside AI Workflow.** Built-in and custom prompts, search, composition, versioning, and runtime variables such as ticket fields are first-party product capabilities (`15:21–19:36`).
4. **Remove Arthur Engine as a core dependency.** Prompt-injection detection may remain as an optional integration, and Arthur Engine can be reconsidered later only for a concrete need (`16:11–19:36`).
5. **Preserve observability and evaluation capabilities while replacing the dependency.** Tracing and outcome evaluation remain important across models and on-prem deployments. The replacement is not selected; prefer suitable existing tools over rebuilding everything (`17:04–18:07`, `25:39–27:22`).
6. **On-prem deployment belongs on the roadmap.** Larger customers may reject globally hosted code/observability infrastructure. Its architecture and timing remain open (`21:23–22:06`).

### Accepted gaps and follow-up work

- **Post-PR workspace initialization is inconsistent.** The post-PR fixture explicitly requires Prepare workspace while other specialized flows initialize automatically. The inconsistency was accepted as a fix. The exact canonical rule was not restated in the meeting; the earlier design decision remains: specialized agents initialize or reuse their workspace automatically, while explicit Prepare remains available for modular graphs (`13:48–15:00`).
- **GitLab review support is incomplete.** GitLab exists as a provider, but GitLab reviews are not consumed by the workflow path. Karol was asked to inspect and address that gap; the meeting did not define the event mapping, filtering, or broader parity scope (`22:25–23:21`).
- **Execution needs hard safety bounds.** Prevent runaway loops and enforce duration plus token/cost limits. A maximum duration already exists, but the exact limits and stop behavior were not decided (`11:03–11:18`).
- **The editor needs pre-demo visual polish.** Text overflowing from connected block cards was explicitly raised for correction; the transcript does not clearly assign an owner (`28:51–29:01`).
- **The corrected workflow must be tested before customer deployment.** A demo-ready version was wanted near the beginning of the following week (`09:12–10:37`, `27:22–28:33`).

### Raised but not decided

- **One-active-run claim and event waiting.** Karol proposed holding the ticket claim until the entire workflow terminates and retaining incoming PR events until release. The race was explained, but the group moved to the high-level review without explicitly accepting the lock boundary, queue design, compare-by-owner release rule, persistence, ordering, deduplication, or retry behavior (`11:48–13:07`). This remains a review recommendation and discussion item, not a sync decision.
- **Remote MCP versus generated JSON.** The preferred direction was a remotely hosted MCP, co-hosted with AI Workflow and authenticated through the same account, because it can provide interactive creation and validation feedback. JSON copy/paste remains a possible simpler fallback. Authentication, client setup, implementation effort, and on-prem implications still require validation (`23:29–25:39`).
- **Observability/evaluation stack.** The capability is required, but no provider or architecture was selected (`25:39–27:22`).
- **Agent harness and shared memory.** Pi/OpenCode-style harnesses and a memory system compatible across supported harnesses were exploratory future topics, not commitments (`26:50–27:22`).

### Owners and actions

| Owner | Action | Transcript status |
|---|---|---|
| Karol | Share the complete workflow review list; implement and test workflow corrections; inspect GitLab review support; publish the existing roadmap. | Committed or assigned (`05:58`, `15:00`, `20:06`, `20:51–23:21`) |
| Filip | Plan and build the first-party prompt library/custom-prompt work and decouple core prompt functionality from Arthur Engine. | In progress/planned (`15:00–15:45`, `20:06`) |
| Jakub | Review the roadmap, coordinate with Diana, and turn it into sequenced tickets/planning artifacts. | Planned by Jakub (`21:23–22:06`, `28:44`) |
| Jakub | Record a workflow demo after the corrections. | Intended for early the following week (`27:22`) |
| Team | Keep workflow implementation discussion visible in the shared workflow thread/channel. | Process request (`29:01–29:34`) |

## Reconciled PR #118 review register

### Superseded by the sync

- **Default-off execution feature flag:** rejected in favor of one tested execution path. Do not implement or continue presenting the legacy fallback as an agreed requirement.

### Product positions established before the sync

These were confirmed during the earlier review conversation but were not revisited in the July 17 sync:

- Branch conditions use PR #118's restricted, parsed JavaScript-style expression syntax. They are not arbitrary JavaScript and must evaluate strictly to a boolean.
- No JavaScript/code step ships in the MVP.
- All five lifecycle trigger types ship first-class in the MVP. Which workflow, if any, claims the PR-created trigger by default remains open.
- Plan approval ships in the MVP. Once accepted, approval is final and immediately starts the pinned implementation path; stopping a later run is a separate operational action.
- Workflow data flow uses explicit, typed input bindings rooted at `trigger.*`, `steps.<nodeId>.output.*`, or `run.*`. The editor may suggest compatible upstream outputs, but the saved definition retains the exact source path.
- Retain automatic run telemetry and live per-block status tracking instead of requiring authors to add a core observability block.

### Workflow changes carried forward

1. **Automatic workspace initialization for specialized agents — accepted gap in sync.** Fix Agent should reuse an explicitly prepared workspace or initialize one automatically. Explicit Prepare workspace remains available for deliberately modular/custom graphs.
2. **GitLab review-event ingestion — accepted gap in sync.** GitLab reviews are not currently consumed; inspect and address that gap. Detailed event mapping, filtering, and provider-availability policy remain earlier review positions or open questions rather than sync decisions.
3. **One-active-run claim — proposed, not decided in sync.** Hold the claim until the complete workflow reaches a terminal state; `open_pr` and `finalize_workspace` must not release it early. Retain actionable events received meanwhile and start them after termination. The implementation and compare-by-owner release semantics still need agreement.
4. **Remediation event safety — earlier review position.** Authenticate provider events; require exact check names and trusted producer/source selectors; filter workflow-authored events and GitLab internal notes; use retry-stable delivery identity; re-read the provider's current head (plus GitLab head-pipeline ID); and ignore passing, cancelled, neutral, skipped, superseded, stale-head, untrusted-source, and otherwise non-actionable events. Jira transition echoes likewise require the stable delivery identifier, exact status changelog destination, and workflow actor identity for the full retry window.
5. **Publication safety — earlier review position.** Re-read the PR/MR head before publishing, require it to equal the triggering source SHA, require a clean committed tree, and use ownership-safe push semantics such as force-with-lease. Never overwrite newer work.
6. **Human clarification recovery — earlier review position.** Preserve unpublished work when Implementation/Fix agents or merge-conflict handling need clarification. The checkpoint, continuation, and Vercel Workflow/Sandbox recovery mechanism remain open.
7. **Definition revisions — earlier review position.** Use a mutable draft, validation, immutable deployed versions, rollback, and execution pinned to the exact version selected at dispatch. Do not make every enabled save immediately live.
8. **Typed bindings — earlier review position.** Replace block-specific step-reference conventions with explicit typed input bindings; deployment rejects missing, unknown, downstream, or type-incompatible sources.
9. **PR subject identity — earlier review position.** Never pass an internal runtime correlation/subject key to Jira as an issue key. Ticket-dependent blocks are unavailable when a trigger has no real ticket context.
10. **Editor behavior — earlier review position plus sync polish.** Moving a block is layout-only and must not dirty the definition. The server registry owns availability and output contracts; every unavailable block shows a reason; worker status/errors survive the dashboard proxy; semantic edits auto-validate without stale success; blocks and connections retain the agreed deletion affordances; connected-card text must not overflow.
11. **Canonical remediation contracts — earlier review position, with workspace inconsistency accepted in sync.** PR #118 already contains only one `V4 · Review & fix after PR` board, so no explainer-board consolidation is required. Fix Agent owns `fixed | needs_human_input | failed`; custom classification uses Generic Agent plus Branch. Finalize workspace is the deterministic publication boundary, not classification, an external CI verdict, or the end of the run.

### Historical review-process findings not raised in the sync

- PR #118 should have been split into reviewable stacked PRs so CodeRabbit and humans could review it effectively. Because #118 is now merged, apply this as a process constraint to substantial follow-up work rather than pretending the original PR can still be split.
- The review found that the required root test job passed a quoted `**/*.test.ts` glob literally instead of discovering dashboard tests. The sync did not discuss it; re-check current CI before opening a follow-up.
- `AGENT_ALLOWED_REPOS` should remain fail-open and outside workflows scope. If defense-in-depth allowlisting is wanted, motivate and ship it separately. The sync did not discuss it.

## Post-merge Arthur validation investigation (2026-07-17)

Status: investigation complete; remediation is not implemented yet. This section preserves the evidence and the concrete follow-up list. New Jira tickets should be drafted only after the workflow-revision scope is agreed.

Sources:

- [Slack thread with Jan Lewandowski](https://blazity.slack.com/archives/C0AKTDHG2CF/p1784279332028999?thread_ts=1784279332.028999&cid=C0AKTDHG2CF)
- Formal review case: [`UP-4697`](https://blazity.atlassian.net/browse/UP-4697) / [`arthur-engine#1935`](https://github.com/arthur-ai/arthur-engine/pull/1935) / branch `blazebot/up-4697`
- Manual Jira retry shown in the screenshot: [`UP-4694`](https://blazity.atlassian.net/browse/UP-4694) / [`arthur-engine#1939`](https://github.com/arthur-ai/arthur-engine/pull/1939)
- Arthur tenant deployment inspected: [`Blazity/ai-workflow-arthur@bdeed3f6`](https://github.com/Blazity/ai-workflow-arthur/tree/bdeed3f6a79e57c9ef2b9dfe7a6da32f68b77a6e)
- Merged PR #118 E2E notes already established that the GitHub App's review/check subscriptions targeted the demo worker only (`docs/testing/e2e-findings.md`, section 7e, once this checkout is updated to the merged tree).

### Trace A: formal Request Changes did not dispatch remediation

1. Jan submitted a formal `CHANGES_REQUESTED` review on `arthur-engine#1935` at `2026-07-17T10:09:25Z` (`12:09:25 CEST`). Its inline comment requested changing the overlapping “Last Updated” header offset to `150`.
2. No matching `POST /webhooks/github` appeared in the Arthur worker logs around `10:07–10:12Z`. The review therefore did not reach the observable Arthur worker endpoint. The remaining external ambiguity is whether the App lacked the `Pull request review` subscription for that installation or sent it to another worker URL; GitHub App Recent Deliveries is the authoritative place to distinguish those cases.
3. The Arthur tenant was still deployed from `ai-workflow-arthur@bdeed3f6` (June 29), not from the merged PR #118 implementation. Its GitHub webhook route accepts only `x-github-event: pull_request`; even a correctly delivered `pull_request_review` event would be ignored as `not_pull_request_event`.
4. PR #118's current code can normalize and dispatch review events, but dispatch also requires an enabled definition containing `trigger_pr_review`. The migration seeds only the ticket-triggered default, so a current deployment without a configured review definition returns `no_definition` rather than starting remediation.
5. Jan manually committed the requested `120 → 150` change to PR #1935 at `10:45:52Z`. That commit is evidence of the requested product change, not evidence that AI Workflow handled the review.

### Trace B: the screenshot and Jira retry exposed separate runtime bugs

The screenshot did not show the review case above. Run `wrun_01KXQSGTQ4PPZY594N4VW9GCMX` resolves to `UP-4694` / PR #1939, while the formal Request Changes review was `UP-4697` / PR #1935. The two traces must not be combined when validating a fix.

1. The first `UP-4694` retry started around `12:21 CEST`. The Implementation Agent returned the logical failure `Agent returned non-structured result`; Slack reported that failure at `12:29`.
2. The workflow trace nevertheless displayed `Success`: it completed 36 workflow steps, then parsed the agent result, unregistered the run, moved the ticket, sent the notification, and tore down the sandbox. The agent's `result: failed` is handled as ordinary workflow completion, so the workflow engine records success even though implementation failed.
3. The deployed Claude adapter emits the generic message whenever a result event lacks schema-valid `structured_output` and its fallback result is not a string. It discards the useful event subtype, envelope, and schema error. The Claude CLI is also installed unpinned in each sandbox, leaving the output contract vulnerable to client-version drift.
4. A second run, `wrun_01KXQTCDRNGE7ZM7EAQHWZBSKN`, started around `12:36` and reported the PR ready around `12:43`. Its only commit, `d67e55c`, changed `blazebot/memory/UP-4694.md`; it made no product-code change. The publication guard treats any commit as sufficient, so a memory-only commit can incorrectly qualify as successful remediation.
5. Cumulative historical run labels were not the correlation bug. The old deployment intentionally retained them; merged PR #118 uses `workflow_runs.ticket_key` as the authoritative subject and removed run-label routing.

### Remediation TODO

#### P0 — make Request Changes reach and start the intended workflow

- [ ] Deploy merged workflow code to the Arthur tenant worker and dashboard; verify the deployed repository and exact source SHA instead of assuming the central deployment updated the tenant.
- [ ] Verify the Arthur GitHub App installation subscribes to `Pull request review` and targets the Arthur tenant's `/webhooks/github`, then inspect or replay the event in Recent Deliveries.
- [ ] Create and enable the canonical Arthur remediation definition containing `trigger_pr_review`, or deliberately seed one as part of tenant setup.
- [ ] Repeat a human `changes_requested` review and verify, end to end: a 2xx delivery, `UP-4697` correlation, definition match, remediation run creation, relevant PR-head mutation, and no ticket-column workaround.
- [ ] Add the Arthur tenant review-trigger smoke test to deployment verification so demo-only wiring cannot be mistaken for tenant readiness.

#### P1 — make failures truthful and diagnosable

- [ ] Preserve the Claude result event subtype, raw envelope shape, and structured-output schema error in diagnostics; do not collapse every mismatch into `Agent returned non-structured result`.
- [ ] Pin or explicitly validate the Claude CLI/output-protocol version used in sandboxes.
- [ ] Propagate a block or agent's logical `failed` result to failed run status in the workflow UI and telemetry, while still running deterministic cleanup in `finally`/compensation paths.
- [ ] Add visibility for review events ignored as `no_definition`, `other_repo`, `coalesced`, stale, or bot-authored so “nothing happened” is explainable.

#### P1 — reject false remediation success

- [ ] Strengthen the publication invariant: a memory-only commit must not count as a fix. Require a task-relevant non-memory diff (and, for PR remediation, an actual change against the current PR head) before publishing success.
- [ ] Re-read and validate the exact PR head before publication, then use ownership-safe push semantics so remediation cannot overwrite newer work.
- [ ] Add regression coverage for structured-output failure, logical failed-run status, and memory-only commits.

### Completion evidence required

- GitHub Recent Deliveries and Arthur worker logs show the same review delivery and accepted webhook response.
- The run record names the expected ticket, repository, PR, source head, trigger definition, and terminal result.
- A forced agent-output mismatch produces a failed run with actionable diagnostics.
- A memory-only commit is rejected and cannot produce a “PR ready” notification.
- A real requested change updates the expected PR head and leaves the ticket transition under the selected workflow's control.

## Open design discussions

1. **Ownership of post-PR checks and AI review.** First establish whether the current `post-pr-gate.yaml` is used and valuable. Then choose whether to retain it, replace useful behavior with an editable `PR created → Review Agent` workflow, or retire it in favor of repository CI/external reviewers. This was not discussed in the sync.
2. **Automatic review of arbitrary human-authored PRs.** If retained, constrain it to review-safe behavior and supply PR intent/context; fix the synthetic correlation-key-as-`ticketKey` bug. Otherwise remove the mode and synthetic-key path. This was not discussed in the sync.
3. **GitHub CI failure timing.** Choose reacting to each failed `check_run` versus a terminal workflow/check-suite result containing the complete sibling-failure set, and define how later sibling failures are retained. This was not discussed in the sync.
4. **One-active-run claim and pending events.** Decide the claim boundary and whether MVP needs a durable queue or one safely coalesced pending event per subject/head. This was proposed but not decided in the sync.
5. **Human clarification continuation.** Decide how an answer resumes execution without replaying side effects and how unpublished work survives stopped compute. Verify the approach against actual Vercel Workflow and Sandbox capabilities. This was not discussed in the sync.
6. **MCP workflow authoring.** Validate same-account authentication, remote hosting, validation feedback, client setup, and on-prem behavior; decide whether generated JSON remains a supported fallback.
7. **Observability and evaluation replacement.** Select an Arthur-independent stack supporting multiple models, future harnesses, and on-prem deployments before removing the existing capability.
8. **On-prem and harness architecture.** Sequence on-prem delivery and later decide supported agent harnesses plus a cross-harness memory contract.

## Valid gaps not yet discussed

These remain useful later-design questions, but neither the earlier review conversation nor this sync established a user/team position:

- Jira-only versus Jira + Linear launch coverage.
- Exact review-event taxonomy: ordinary comments, unresolved threads, selected mentions, or formal review submissions.
- Webhook-redelivery-only versus polling/reconciliation for events never received.
- Detailed multi-repository partial-publication and ticket-status policy.
- Whether pull requests need end-to-end jobs before merge instead of the current `merge_group`-only coverage.
- One global trigger owner versus repository/provider/environment-scoped deployments.
- Detailed workspace TTL, keep-last, warm-snapshot, and secret-scrubbing policy beyond the already-discussed preservation, cleanup, and feasibility requirements.
