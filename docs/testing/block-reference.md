# Workflow engine block reference

Current reference for the 28 server-owned workflow block contracts in nine groups. The executable source is `apps/worker/src/workflow-definition/block-registry.ts`, with graph ports and authorable params in `apps/shared/contracts/workflow-graph.ts`. The dashboard consumes that registry; it does not maintain a second authoritative catalog.

`docs/workflow-workspace/index.html` remains the product-design source of truth for the taxonomy and canonical flows. This file explains how the implemented runtime realizes that design.

## Contract and editor model

- Every registry entry supplies presentation metadata, defaults, typed inputs, a typed output schema, status variants, and `{available, unavailableReason}`.
- Availability is environment- and configuration-aware. Drafts remain editable when a block is unavailable, but the palette, node, validation result, and rejected action must show the reason.
- Inputs are explicit persisted paths from `trigger.*`, `steps.<ancestorId>.output.*`, or `run.*`. Compatible-shape suggestions are editor assistance only.
- Deploy validates params, graph shape, ports, cycles, bindings, provider policy, trigger ownership, and execution budgets against one exact draft revision. Runtime resolves the same paths and validates executor output against the same contract.
- Moving nodes changes layout only. It does not change the semantic draft or deployed version.
- Specialized Implementation, Review, and Fix agents prepare or resume their workspace automatically. Planning is workspace-free. Explicit Prepare is available for modular/custom graphs; Generic Agent requires it only when `workspaceMode` reads or mutates repositories.
- Any agent may return `needs_human_input`. The runtime creates a pinned checkpoint/snapshot continuation and reruns only the waiting agent after an answer; authors do not need to recreate that behavior with a Human Question block.
- Finalize is the sole push boundary. Open PR/MR consumes Finalize's durable `publicationAttemptId`; it never pushes workspace changes. The active-run claim remains held through every downstream block.

## Catalog summary

| Type | Group | Key authored config or required input | Normal statuses | Runtime role |
|---|---|---|---|---|
| `trigger_ticket_ai` | Trigger | none | `fired` | Starts when a configured ticket enters the AI state. |
| `trigger_plan_approved` | Trigger | none | `fired` | Starts the separately pinned implementation path after final approval. |
| `trigger_pr_created` | Trigger | `providers`, `scope` | `fired` | Starts from an allowed opened/reopened PR/MR. |
| `trigger_pr_checks_failed` | Trigger | `providers`, `scope`, exact `checkNames`, GitHub App slugs, GitLab pipeline sources | `fired` | Starts from an allowlisted external CI failure on the current head. |
| `trigger_pr_review` | Trigger | `providers`, `scope`, non-empty `on[]` | `fired` | Starts from selected GitHub review states or external GitLab comments. |
| `trigger_pr_merged` | Trigger | `providers`, `scope` | `fired` | Starts after an allowed PR/MR merge and carries merge metadata. |
| `planning_agent` | Agents | optional provider/model | `ready`, `needs_human_input`, `failed` | Produces a plan or clarification questions without requiring a workspace. |
| `implementation_agent` | Agents | optional provider/model | `implemented`, `needs_human_input`, `failed` | Implements in an implicitly prepared/resumed managed workspace. |
| `review_agent` | Agents | optional provider/model | `reviewed`, `failed` | Reviews the current workspace diff before publication. |
| `fix_agent` | Agents | optional provider/model/instructions/max minutes | `fixed`, `needs_human_input`, `failed` | Applies CI, review, or merge-conflict remediation. `fixed` is its built-in publication classification. |
| `generic_agent` | Agents | prompt, optional declared object schema and `workspaceMode` | `completed`, `needs_human_input`, `failed` | Configurable escape hatch; custom classification is a declared field plus Branch. |
| `prepare_workspace` | Workspace | none | `ok`, `needs_human_input`, `failed` | Explicitly selects repositories and creates/reuses a workspace for modular graphs. |
| `finalize_workspace` | Workspace | optional `checks.<id>` bindings | `finalized`, `failed` | Preflights all repositories, pushes committed changes, and records the durable publication attempt. It does not open PRs. |
| `branch` | Control | restricted `condition` | `ok`, `failed` | Chooses `true` or `false` using parsed expressions over prior outputs. |
| `loop` | Control | `maxAttempts`, `onExhaust` | `ok`, `exhausted` | Bounds the single permitted re-entry point for a cycle. |
| `terminate` | Control | terminal status | `waiting_for_human`, `failed`, `skipped`, `done` | Stops the path with an explicit terminal outcome. |
| `post_ticket_comment` | Ticket | body input/param | `ok`, `failed` | Posts questions, plans, or status to the real ticket. |
| `update_ticket_status` | Ticket | target input/param | `ok` | Moves the real ticket to a configured/discovered provider status. |
| `fetch_pr_context` | VCS | none | `ok`, `failed` | Loads PR/MR comments, checks, conflicts, and normalized remediation context. |
| `open_pr` | VCS | required `publicationAttemptId` binding | `ok`, `failed` | Creates/reuses PRs/MRs from a successful Finalize output; no pushing. |
| `post_pr_comment` | VCS | body input/param | `ok`, `failed` | Posts a summary or response to the selected PRs/MRs. |
| `send_plan_approval` | Human | required plan; optional assumptions | `awaiting_approval`, `failed` | Creates a durable approval item and ends that path. |
| `human_question` | Human | questions; optional suggested answers | `needs_human_input`, `answered`, `failed` | Explicit authoring primitive for a scoped question; agent clarification does not require it. |
| `run_pre_pr_checks` | Utility | `maxFixCycles` | `ok`, `failed` | Existing bounded pre-PR validation/fix gate before publication. |
| `run_checks` | Utility | optional commands | `ok`, `failed` | Runs configured/explicit commands and exposes branchable aggregate/results/failures. |
| `call_llm` | Utility | prompt; optional system/provider/model/output schema | `ok`, `failed` | Focused non-agent LLM transform with an optional declared output contract. |
| `send_slack_message` | Utility | message input/param | `ok`, `skipped` | Sends a milestone to the configured channel or skips when there is nothing applicable to send. |
| `arthur_injection_check` | Arthur | optional content input | `ok`, `flagged`, `skipped` | Optional prompt-injection scan; unavailable when Arthur is not configured. |

`arthur_trace` is retired. The stored-definition upgrader removes it and splices only its old normal output path. Core run/block telemetry is automatic; Arthur tracing policy beyond the injection block is future work.

## Trigger policy

### Shared PR/MR scope

Every PR/MR trigger has `providers: (github | gitlab)[]` and `scope: workflow_owned | any`.

- `workflow_owned` requires durable correlation matching provider, repository, PR/MR, source branch, current head, and target branch plus a valid ticket lookup. A branch prefix or pending publication intent is not proof. It may feed ticket and workspace-mutating blocks.
- `any` uses `pr:<provider>:<repo>#<number>` as the subject and has no synthetic `ticketKey`. In this revision it is review-safe only: deployment and runtime reject paths into Fix, Finalize, Open PR/MR, ticket actions, or other branch mutations.
- Correlated workflow-owned PR events use the same `ticket:<ticketProvider>:<ticketKey>` claim as the originating ticket workflow.

### Failed checks

`trigger_pr_checks_failed` consumes provider outcomes; it does not execute checks or publish competing statuses.

- A draft may have an empty `checkNames` selection, but Deploy rejects it.
- GitHub events must match an exact selected check and allowed App slug; the default trusted slug is `github-actions`.
- GitLab pipelines must match an allowed source; the default is `merge_request_event`.
- The worker confirms the provider's current PR/MR head. GitLab also confirms that the event pipeline is the MR's current-head pipeline.
- Passing, cancelled, skipped, neutral, superseded, stale-head, and untrusted outcomes start nothing.

### Reviews

`trigger_pr_review.on` is enforced before dispatch.

- GitHub supports selected `changes_requested` and `commented` submitted reviews.
- GitLab Note Hooks map eligible external merge-request notes to `commented` only. GitLab does not emit a reliable changes-requested event, so a GitLab definition must include `commented`; selecting only `changes_requested` is unavailable and Deploy rejects it.
- System, internal, confidential, malformed, and workflow-authored notes/reviews fail closed at both route and normalization boundaries.
- Selecting `commented` requires an unambiguous configured bot identity for every selected provider so bot responses cannot recursively trigger remediation.

### Merged tickets

GitHub merged `pull_request.closed` and GitLab merged Merge Request Hooks normalize to `trigger_pr_merged`. With `workflow_owned` scope, the output includes the real correlated ticket and may feed Update Ticket Status.

Before the move, runtime records a short-lived transition intent containing the ticket, run, exact destination, and authenticated workflow actor. Only the matching Jira destination/actor/webhook identity consumes it, preventing the workflow's own transition from cancelling the still-running workflow. Provider retries are idempotent; unrelated human moves retain normal cancellation behavior.

### Delivery, claims, and pending events

- Webhook authentication and local definition/selector checks happen before durable receipt.
- A locally eligible event is stored as `received` before external enrichment, then becomes `accepted` after repository/current-head/ownership checks. Transient enrichment or capacity failures remain recoverable by the local poller.
- Provider delivery identity makes redelivery idempotent. GitLab uses `webhook-id`, then `Idempotency-Key`, then an event-UUID-plus-body hash; the webhook configuration UUID is not a delivery key.
- Claims use owner compare-and-set and are released only by the matching owner at terminal cleanup. Concurrent failed checks merge; distinct review identities remain distinct. Pending events are revalidated and drained after terminal release rather than acknowledged and lost.

## Workspace, clarification, and publication

### Specialized versus explicit workspace preparation

The loader/runtime supplies specialized code agents with a workspace even when the graph does not draw Prepare. Planning remains valid with no workspace. Explicit Prepare exists for modular graphs that need visible control before Generic Agent, Run checks, or other workspace operations.

The canonical remediation flow is:

```text
PR checks failed ─┐
                  ├─> Fetch PR context -> Fix -> Finalize -> Post PR comment
PR review ────────┘
```

There is no explicit Prepare or readiness Branch. `fixed` follows Fix's normal output; `needs_human_input` creates a pinned continuation; `failed` follows failure policy.

### Pinned clarification

When an agent needs input, runtime persists the exact definition/version, waiting node, trigger payload, prior safe outputs, budget state, subject/claim ownership, workspace manifest/source head, and snapshot metadata. It scrubs old credentials, snapshots the sandbox, and retains the checkpoint while waiting.

The Vercel capability probe passed on 2026-07-17 with committed changes, an untracked file, `UU` conflict state, and all three unresolved git-index stages. The winning successor restores from the serializable snapshot ID, injects fresh credentials, reruns only the waiting agent, and continues downstream. Duplicate successors cannot both win. Terminal cleanup removes the snapshot and sandbox; reconciliation repairs/flags orphaned or expired checkpoints.

### Finalize and Open PR/MR

Finalize:

1. Checks required bound check results.
2. Re-reads current remote/source heads and refuses to overwrite newer work.
3. Requires a clean committed tree and no unresolved conflicts.
4. Preflights all repositories before the first push.
5. Persists expected and pushed heads in a durable publication attempt.
6. Pushes changes and reports partial multi-repository outcomes without fabricating complete success.

Open PR/MR accepts only the successful `publicationAttemptId`. It creates or finds provider PRs/MRs idempotently and durably reconciles ambiguous provider timeouts, ledger writes, and ownership correlation. Only an authenticated current opened/reopened event may exact-CAS the pending PR identity. The run claim remains active through subsequent comments, ticket moves, and notifications.

## Definition lifecycle and budgets

- **Save Draft:** compare-and-set on `draftRevision`; changes editable semantic state only.
- **Layout save:** compare-and-set on `layoutRevision`; never dirties or rewrites the semantic draft.
- **Validate:** deterministic, side-effect-free, and cheap enough for debounced editor validation after semantic edits.
- **Deploy:** validates one exact draft revision, appends an immutable version/deployment record, checks trigger ownership, and atomically selects `deployedVersion`.
- **Rollback:** selects an existing immutable version with `expectedDeployedVersion` and records rollback provenance. It does not copy or rewrite history.
- **Dispatch:** captures definition ID/version in the run input; later edits/deployments cannot drift the run.

Definitions may set positive `maxDurationMs`, `maxTokens`, and `maxCostUsd`. Duration defaults to the job timeout; token/cost are unset unless authored. Active duration excludes human wait time and carries through pinned continuation. Token totals include input, cached input, and output usage. Configured token/cost limits fail closed if authoritative usage or pricing is unavailable. A phase may overrun because current harnesses report final usage at completion, but no later block starts; telemetry records the measured terminal reason.

## Availability reasons

The registry currently explains at least these unavailable states:

- no VCS provider configured, or selected providers not configured;
- GitLab review configuration without `commented`;
- missing GitHub/GitLab bot identity for comment-trigger recursion filtering;
- missing selected/default Claude or Codex credentials for agent blocks;
- missing selected/default LLM credentials for Call LLM;
- invalid/unsupported declared output schema;
- Slack not configured;
- Arthur Engine not configured.

Client-side rules may add more specific reasons, but they must not replace or hide the server reason.

## Verification map

- Registry/contracts/bindings: `block-registry*.test.ts`, `bindings.test.ts`, `conditions.test.ts`, `schema*.test.ts`, executor contract tests.
- Editor behavior: dashboard `validation-controller`, `graph-edit`, `editor-actions`, `layout-save`, `serialize`, binding-option, param, and API proxy tests.
- Immutable lifecycle/pinning: store/lifecycle/route tests and `revisions-lifecycle.integration.test.ts`.
- Provider normalization/filtering: `trigger-events.test.ts`, GitHub/GitLab webhook route tests, dispatch/delivery/recovery tests.
- Claims/cancellation: owner-CAS, pending drain, reconciliation, cancel-run, and active-run migration tests.
- Clarification/workspaces: checkpoint, dispatch, reconciliation, snapshot, runtime, sandbox cleanup, and merge-conflict state tests.
- Publication: Finalize, workspace-publication, publication store/recovery, PR correlation, and VCS adapter tests.
- Merged movement: merged normalizer/route tests plus ticket-transition intent/routing/step tests.
- Budgets/telemetry: run-budget, agent-budget, telemetry integration, and snapshot collection tests.

The full release gate and deployed smoke sequence are maintained in `docs/testing/e2e-workflow-test-plan.md`.
