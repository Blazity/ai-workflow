# AIW-182–190 workflow acceptance follow-ups

Date: 2026-07-27

This document is the persistent implementation record for the six-PR stack
approved after the workflow-v2 acceptance review. The locked product decisions
remain in `2026-07-23-ai-workflow-improvements-decisions.md`.

## Delivery stack

| PR | Branch | Jira | Base | Migration |
|---|---|---|---|---|
| 1 | `codex/aiw-184-189-run-start-lifecycle` | AIW-184, AIW-189 | `origin/main` | Startup metadata |
| 2 | `codex/aiw-183-workflow-values` | AIW-183 | PR 1 | No |
| 3 | `codex/aiw-182-187-harness-capabilities` | AIW-182, AIW-187 | PR 2 | Capability cache |
| 4 | `codex/aiw-185-188-loop-parallelism` | AIW-185, AIW-188 | PR 3 | No |
| 5 | `codex/aiw-186-review-fix-template` | AIW-186 | PR 4 | No |
| 6 | `codex/aiw-190-post-pr-review` | AIW-190 | PR 5 | PR checks and review publications |

All work uses clean worktrees. No more than three PRs are ready for review at
once; completed descendants may remain drafts.

## Shared contracts

### Workflow value bindings

V2 supports a single reference, an ordered reference list, or a literal.
`reference_list` is valid only for array inputs, every member must be guaranteed
and compatible with the array item schema, and runtime preserves authored
order.

Catalog generation, picker presentation, deployment validation, Branch,
Transform, typed inputs, and mixed text share one compatibility decision. Its
reasons are graph unavailability, optional presence, nullability, type mismatch,
or an unsupported destination.

### Review Result

Review Agent, Fix Agent, Post PR review, catalog compatibility, and runtime
validation derive from one code-owned contract:

- decision: `approve` or `request_changes`;
- findings: file, description, critical or suggestion severity, and optional
  start/end line;
- optional feedback.

An end line requires a start line and cannot precede it. Structurally compatible
custom agent outputs may contain extra fields, but runtime projects only the
canonical fields.

### Compatibility

- Workflow Definition v1 remains readable and executable unchanged.
- Pre-release v2 profile serialization, Loop carry data, trigger set, and review
  actions may change directly.
- Immutable Harness Profile v1 versions retain their historical
  provider-default behavior.
- Duplicate provider/model fields in pre-release v2 drafts normalize to the
  selected profile.

## PR 1 — Dispatch ownership and startup watchdog

- Reserve the exact subject and owner, start the hosted Workflow, then bind the
  returned run ID and insert the minimal run row in one transaction.
- Report `started` only after the transaction commits.
- Accept an identical dispatcher or workflow-entry bind as idempotent success.
- If binding loses ownership, record and cancel only the orphan candidate and
  return a retryable dispatch error.
- Use the same start boundary for tickets, PR triggers, approvals, and manual
  dispatch.
- Add `entry_started_at`, `startup_deadline_at`, `diagnostic_id`, and a partial
  watchdog index to `workflow_runs`.
- Give each successful start a deadline exactly ten minutes later.
- Mark application entry only when the first ownership step actually begins.
- Reconcile due nonterminal rows whose entry marker is absent, including rows
  whose active ownership disappeared.
- Close exact active ownership, cancel the hosted Workflow, drain resources, and
  retry transient failures. Mark failure only after terminal confirmation.
- Use the safe reason `Workflow did not start within 10 minutes.` and a
  diagnostic ID.
- Provide a dry-run-first cleanup command for the six confirmed production run
  IDs. Apply mode must re-check the exact deployment, pending first ownership
  step at attempt zero, missing entry marker, and nonterminal hosted status.

## PR 2 — Open PR outputs and workflow-value compatibility

- Make `prs`, `prUrl`, and `prNumber` required after successful Open PR
  continuation; missing primary PR data is an execution failure.
- Mixed text accepts guaranteed required non-null strings, string enums,
  numbers, and integers. Numeric formatting uses locale-independent
  `String(number)`.
- Do not coerce text to numbers or accept booleans, arrays, objects, null, or
  maybe-missing values.
- Scalar transforms require guaranteed required non-null values of their
  expected type. Build object keeps its explicit omission/default behavior.
- Remove the global Unavailable section. Keep disabled rows in their normal
  step and schema order with muted presentation and the exact reason.
- Disabled rows remain searchable and keyboard reachable but cannot be
  selected.
- Deduplicate canonical references and distinguish **Entire output** from a
  nested field named **Output**.
- Preserve invalid existing bindings until the author removes or replaces them.

## PR 3 — Capability-driven Harness Profiles

- Add an organization-scoped, authenticated, no-store capability endpoint keyed
  by provider and exact pinned CLI version.
- Codex discovers the paginated `model/list` catalog from the exact isolated
  app-server. Claude discovers organization-visible models from the Anthropic
  Models API; the adapter supplies only capability details the provider cannot
  expose reliably.
- Use a ten-second discovery timeout and fifteen-minute fresh-cache window.
- Return a safe stale organization cache after live failure; return 503 when no
  cache exists. Stale catalogs cannot publish a profile version.
- Cache normalized catalogs by organization, provider, and CLI version without
  credentials or secret-bearing provider payloads.
- Add manifest v2 while preserving immutable manifest v1 behavior.
- V2 stores the model, reasoning selection and effective effort, standard or
  advertised speed tier, supported Codex verbosity, compaction mode and
  threshold, and the exact capability snapshot/hash used for publication.
- Context size is read-only. Custom compaction requires known context.
- Claude supports default, percentage threshold, and disabled compaction.
  Codex supports default and a percentage-derived token threshold, but not
  disabled.
- Runtime applies every published setting explicitly; unsupported settings
  block publication.
- Dashboard controls come only from the catalog. Historical unavailable models
  remain visible and are never silently replaced.
- The exact pinned Harness Profile version becomes the sole provider/model
  source for v2 agents across save, restore, duplication, copy/paste, and
  Undo/Redo.

## PR 4 — Loop-scoped values and parallel Review isolation

- Make authoring availability follow scheduler activation scopes.
- The initially entered part of a Loop region executes in the owner scope;
  retries receive separate child activations.
- A value is available only when its producer precedes the consumer on every
  relevant path in the same activation. Guaranteed pre-Loop values remain
  available in descendants.
- Never fall back to previous or sibling iterations. Unexpected missing
  current-iteration data fails safely.
- Add typed explicit Loop carry values. Resolve and freeze them at the boundary,
  then expose only those values under
  `steps.<loopId>.output.values.<name>` in the next child activation.
- Refresh carry on each boundary and never leak arbitrary Loop-child state
  after exit.
- Keep three workspace modes: none, isolated reader for Review Agent, and
  exclusive writer for mutating or not-provably-read-only blocks.
- Allow reader/reader concurrency; reject reader/writer and writer/writer unless
  explicitly ordered or mutually exclusive.
- Fan-out reviewers each receive a disposable read-only workspace from the same
  immutable fingerprint, without publication credentials or writable remotes.
- Review sandboxes are never merged into the canonical workspace and are
  cleaned up on every terminal path.

## PR 5 — Reviewed ticket workflow

- Add fixed `reviewResults: ReviewResult[]` to Fix Agent through
  `reference_list`; keep external human `reviewFeedback` separate.
- Revalidate every review result and compile the ordered list into a delimited
  prompt section.
- Add the editable **Reviewed ticket workflow** template:
  ticket trigger, workspace, planning, implementation, three parallel reviews,
  one visible all-approved Branch, checks/finalization/Open PR on approval, and
  Loop/Fix/re-review on rejection.
- Carry the three exact current Review Results through the Loop.
- Allow three retries after the initial review.
- Exhaustion sends Slack and terminates the workflow explicitly as failed.
- Keep every block, prompt, condition, mapping, and connection visible and
  editable.

## PR 6 — Post-PR checks and review publishing

- Add v2 PR created, PR ready, and PR updated triggers with equivalent GitHub
  and GitLab normalization.
- Created includes drafts; Ready covers non-draft open/reopen and draft-to-ready;
  Updated fires only when the head SHA changes.
- Manual dispatch resolves the selected deployed trigger against the exact
  current head.
- A newer head supersedes the previous review run, closes its pending checks,
  drains/cancels its exact owner, and prevents stale publication.
- Add visible Create PR check and Complete PR check actions using an opaque
  same-run, same-head reference. Provider IDs remain server-side.
- Persist external checks and review publications/comments with durable retry
  intent and idempotency.
- Every terminal path closes pending checks with the appropriate conclusion.
  Normal workflow completion with an uncompleted check becomes a clear
  configuration failure.
- Add Post PR review with a non-empty ordered list of compatible Review Results.
- Validate and normalize results, hash the publication, fetch the exact diff,
  publish safe changed-line findings inline, and move unsafe/unlocatable
  findings into the summary.
- Approve only when every source approves. GitHub uses one review with inline
  comments; GitLab uses equivalent discussions, summary note, and supported
  approval state.
- Return the combined decision, summary, inline count, and fallback count.
- Add the editable **Post-PR review** template with PR ready and PR updated
  triggers, Create check, exact-head workspace, three parallel reviewers, Post
  review, Branch, and successful/failed check completion.
- Route normalized events through one coordinator so a workflow definition and
  the legacy YAML gate can never both claim the same event/head.

## Verification and delivery

Each PR re-checks Jira scope and assignment, moves its tickets to In Progress
when work starts, links the PR and exact checks, and moves tickets to Review only
after implementation and automation are green. Tickets reach Done only after
merge; AIW-189 additionally waits for confirmed production cleanup.

Migrations are tested from a fresh database and from the previous stack
revision. Each PR runs focused unit/component/integration coverage, repository
`pnpm test` and `pnpm typecheck`, and the relevant orchestration, capacity,
harness-profile, and agent E2E suites. Browser QA is left to the user. Newly
found acceptance bugs become separate Jira follow-ups.
