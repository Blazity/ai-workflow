# Run analysis report: dashboard and Jira delivery plan

Status: implemented and verified. Written 2026-08-20 from the requirements
captured in Kimi session `session_071099c1-f449-4508-9654-32db45bf5d43` and
implemented from `main` at `0b41be7f`.

## 1. Outcome

After the planning/research phase, a user can see what the bot actually
analyzed without reading worker logs or guessing from the final PR:

- the repositories it inspected and why each was selected;
- the exact branch and base SHA inspected in each repository;
- the concrete files, symbols, commits, PRs, or ticket facts used as evidence;
- repository-expansion requests and the final read/write scope;
- the implementation plan;
- cost, tokens, model, duration, and turns by phase;
- the final PRs/MRs and implementation summary, when publication occurs;
- whether Jira received the research and PR-stage reports.

The full report is durable on the run trace. Jira receives two bounded analysis
comments containing views of the same report:

1. immediately after research completes;
2. in the existing PR-ready comment when a new PR/MR is published.

The report is an audit summary, not hidden reasoning. It must never contain
chain-of-thought, raw stdout/stderr, complete file contents, secrets, sandbox
paths, or session-memory bookkeeping.

## 2. Product decisions already made

The Kimi session asked and answered the three product questions that change the
implementation:

| Question | Decision |
| --- | --- |
| Where is the report visible? | Dashboard and Jira |
| What does it contain? | Repository analysis, evidence, decisions, plan, and costs |
| When is Jira updated? | After research and when the PR/MR is created |

Recommended UX decisions:

- The dashboard is the source of truth and retains the complete safe report.
- Jira contains the same sections but applies a hard comment-size bound. If a
  plan or evidence list does not fit, the comment says exactly what was omitted
  and links to the run trace; it never silently truncates.
- A cost whose price is incomplete is displayed as a lower bound (`$1.23+`),
  never as an exact value or `$0.00`.
- Reports are captured only when a `planning_agent` produces or reuses a plan.
  Workflows without a planning phase keep their current behavior and do not
  receive a fabricated empty report.
- Existing runs are not backfilled. Their trace says that analysis capture was
  not available for that run.

## 3. Existing seams to reuse

Do not build a second observability pipeline. The required facts already exist
at the following points:

- `apps/worker/src/workflows/agent.ts`, `case "planning_agent"` receives the
  successful `ResearchResult` and assigns `ctx.researchPlanMarkdown`.
- `ResearchResult.repositoryEvidence` and `resolutionEvidence` are parsed in
  `apps/worker/src/sandbox/agents/types.ts` but are not persisted today.
- `ctx.selectedRepositories`, `ctx.repositoryExpansion`, and
  `ctx.researchWriteRepositories` retain repository-selection decisions.
- `ctx.workspaceManifest` contains the trusted branch, access mode, and
  `researchBaseSha` for every attached repository.
- `computeUsageTotals()` in `apps/worker/src/sandbox/usage.ts` already applies
  the correct pricing and unknown-cost rules.
- `recordRunUsage()` in
  `apps/worker/src/lib/telemetry/run-telemetry.ts` owns durable per-run cost,
  tokens, phases, and final lifecycle.
- `IssueTrackerAdapter.postComment()` and `JiraAdapter.postComment()` already
  publish Jira comments and return a deep link when available.
- `postPrLinksComment()` in `apps/worker/src/workflows/agent.ts` is the current
  PR-ready Jira comment. Replace that successful-publication call with the
  PR-stage report instead of posting a third Jira comment.
- `RunDetailResponse` feeds both the standalone trace and ticket split view.
  Extending it avoids a second endpoint and an extra browser request.
- `PromptPreview`, `CkCard`, `CkChip`, and the trace layout already provide the
  dashboard primitives needed for the report.
- `sanitizeReplayValue()`, `configuredReplaySecrets()`, and
  `scrubForPublication()` are the existing output-safety boundaries.

## 4. Data contract

Add `apps/shared/contracts/run-analysis.ts`, export it from
`apps/shared/contracts/index.ts`, and place the following public DTOs there.
That file may import `RunPullRequest` from `domain.ts` and
`ReplaySanitizationMetadata` from `run-replay.ts` without creating the circular
dependency that putting these DTOs in `domain.ts` would cause. Keep the report
versioned because it is persisted JSON, but implement only version `1`.

```ts
export type RunAnalysisStage =
  | "research_complete"
  | "published"
  | "no_change";

export interface RunAnalysisRepository {
  provider: "github" | "gitlab";
  repoPath: string;
  defaultBranch: string;
  researchBranch: string;
  researchBaseSha: string | null;
  access: "read" | "write";
  rationale: string;
}

export interface RunAnalysisRepositoryRequest {
  provider: "github" | "gitlab";
  repoPath: string;
  rationale: string;
}

export interface RunAnalysisPhaseUsage {
  costUsd: number | null;
  tokens: {
    input: number;
    cachedInput: number;
    output: number;
  } | null;
  durationMs: number;
  numTurns: number;
  model: string | null;
}

export interface RunAnalysisUsageSnapshot {
  capturedAt: string;
  costUsd: number;
  costKnown: boolean;
  tokensInput: number | null;
  tokensCached: number | null;
  tokensOutput: number | null;
  phases: Record<string, RunAnalysisPhaseUsage>;
}

export interface RunAnalysisCommentDelivery {
  state: "not_applicable" | "pending" | "posted" | "failed";
  attemptedAt: string | null;
  commentUrl: string | null;
  error: string | null;
}

export interface RunAnalysisReport {
  version: 1;
  runId: string;
  sourceResearchRunId: string;
  stage: RunAnalysisStage;
  researchCompletedAt: string;
  repositories: RunAnalysisRepository[];
  expansionRounds: number;
  repositoryRequests: RunAnalysisRepositoryRequest[];
  writeRepositories: RunAnalysisRepositoryRequest[];
  evidenceStatus: "captured" | "not_retained";
  evidence: string[];
  planMarkdown: string;
  noChangeNeeded: boolean;
  resolutionEvidence: string[];
  publication: {
    prs: RunPullRequest[];
    changeSummary: string;
  } | null;
  usage: {
    research: RunAnalysisUsageSnapshot;
    publication: RunAnalysisUsageSnapshot | null;
    final: RunAnalysisUsageSnapshot | null;
  };
  jira: {
    research: RunAnalysisCommentDelivery;
    pullRequest: RunAnalysisCommentDelivery;
  };
  sanitization: ReplaySanitizationMetadata;
}
```

Add `analysisReport: RunAnalysisReport | null` to `RunDetailResponse` in
`apps/shared/contracts/api.ts`. Every response path and dashboard fallback must
return the key. During a rolling deploy, the dashboard must still read a missing
key as `null` with `data.analysisReport ?? null`.

Contract rules:

- `runId` is the run currently displayed.
- `sourceResearchRunId` equals `runId` for an ordinary run. An approved-plan run
  points it at the earlier run that produced the approved plan.
- `researchBaseSha` is nullable only for a legacy/V1 workspace that genuinely
  did not capture it. Never replace an unknown SHA with the current HEAD.
- Evidence stays an ordered list of safe, human-readable facts. Do not parse
  model prose into guessed paths after the fact.
- `evidenceStatus: "not_retained"` is used only when an approved-plan run can
  recover the approved plan/scope but its source report is unavailable; an
  empty captured evidence list is not mislabeled as lost data.
- `usage.research`, `usage.publication`, and `usage.final` are distinct snapshots;
  later costs must not rewrite what Jira reported earlier.
- Unknown tokens stay `null`. Unknown cost is represented by
  `costKnown: false` plus the priced lower bound in `costUsd`.
- The shipped templates produce one logical plan per run. If a custom graph
  executes another successful planning node later, the durable dashboard report
  advances to the latest plan, while the already-posted research Jira comment
  remains an explicitly timestamped point-in-time snapshot. The PR-stage comment
  carries the latest plan. Editing old Jira comments is outside this slice.

## 5. Persistence and migration

Use one nullable JSONB column on the existing run row.

1. In `apps/worker/src/db/schema.ts`, add:

   ```ts
   analysisReport: jsonb("analysis_report").$type<RunAnalysisReport>(),
   ```

   Place it beside `phases`/`steps`, because the agent workflow owns it just as
   it owns usage and the durable trace.

2. Generate migration `0054_run_analysis_report.sql` with:

   ```sh
   pnpm --filter worker db:generate -- --name run_analysis_report
   ```

   The migration must only add the nullable column. No default, index, table,
   trigger, or historical backfill is needed.

3. Add
   `apps/worker/src/db/run-analysis-report-migration.test.ts`. Migrate through
   `0053`, insert an existing `workflow_runs` row, apply `0054`, and assert that
   the row survives with `analysis_report IS NULL`. Also migrate a fresh DB
   through `0054` and round-trip one version-1 JSON value.

4. Add `apps/worker/src/run-analysis/store.ts`:

   - `recordRunAnalysisReport(db, report)` upserts by `run_id` and owns only
     `analysis_report` plus `updated_at`. Its insert path sets the minimal run
     identity (`runId`, `workflowId: "wf_agent"`, `workflowName: "Agent"`) so it
     works before cron or terminal telemetry has written the row.
   - `getRunAnalysisReport(db, runId)` returns and version-checks the stored
     report for the approved-plan continuation and returns `null` for an absent
     or unsupported version.
   - `finalizeRunAnalysisUsage(db, runId, finalUsage)` reads the current report,
     returns when none exists, and replaces only `usage.final`. This is called
     after `recordRunUsage()` in terminal telemetry, when no workflow writer can
     still race it.
   - Repeating either function with the same data is a no-op in meaning and
     cannot erase Jira delivery state or an earlier usage snapshot.

Do not create a separate analysis-event table. The feature renders one bounded
summary per run and does not query individual evidence items across runs.

## 6. Build and sanitize the report

Create `apps/worker/src/run-analysis/report.ts` as a pure module with focused
tests in `report.test.ts`.

Required functions:

- `buildResearchAnalysisReport(input)` builds the version-1 report after a
  successful research result.
- `buildApprovedPlanAnalysisReport(input)` copies the source report for a
  `plan_approved` run, changes `runId`, preserves `sourceResearchRunId`, resets
  publication/final usage, and does not claim that research ran twice. If the
  source report is unavailable, build a smaller honest report from
  `approvedPlan.markdown` and `approvedPlan.repositoryScope`; evidence is empty
  and the UI says it was not retained.
- `withAnalysisPublication(report, publication, changeSummary, usage)` returns
  the `published` version without mutating its input.
- `withAnalysisDelivery(report, stage, delivery)` updates only the selected Jira
  delivery slot.
- `parseStoredRunAnalysisReport(value)` accepts version 1 with the required
  structural fields and returns `null` for corrupt or unsupported JSON; neither
  the API nor an approved continuation trusts a cast from JSONB.
- `usageSnapshot(totals, capturedAt)` maps `UsageTotals` without changing null
  or lower-bound semantics.
- `formatResearchAnalysisComment(report, dashboardUrl)` and
  `formatPublishedAnalysisComment(report, dashboardUrl)` produce Jira text.
- `analysisCommentMarker(runId, stage)` returns a deterministic visible marker,
  for example `Arthur report: <runId>:research` or
  `Arthur report: <runId>:pull_request`.
- `hasAnalysisComment(ticket, marker)` performs an exact marker search over
  fetched ticket comments.

Repository mapping must come from trusted server state:

- iterate `ctx.workspaceManifest.repositories`, not model output;
- take provider, repo path, branch, access, and `researchBaseSha` from the
  manifest;
- take selection rationale from the matching `ctx.selectedRepositories` entry;
- compare against `ctx.researchWriteRepositories` only to expose the planner's
  requested write set, never to grant access.

Improve evidence quality without changing the structured-output shape:

- in `apps/worker/src/sandbox/context.ts`, strengthen the Repository Access
  Protocol: every `repositoryEvidence` item must name the exact
  `provider:repo`, file/symbol/commit/PR checked, and the relevant finding;
- in `apps/worker/src/sandbox/agents/types.ts`, add the same description to the
  Zod/manual JSON schema;
- retain the existing `string[]` field and maximum of 50 entries, so Claude and
  Codex protocol compatibility is unchanged.

Safety boundary:

- server-authored provider/repository/branch/SHA fields pass through unchanged;
- send only the model-authored bundle (plan, evidence, resolution evidence,
  rationales, and implementation change summary) through
  `sanitizeReplayValue()` using
  `configuredReplaySecrets()`;
- reject an unavailable or structurally invalid sanitized bundle rather than
  storing the raw fallback;
- persist the returned `ReplaySanitizationMetadata` and display when content was
  redacted or truncated;
- run Jira text through `scrubForPublication()` after formatting;
- cap the durable agent-authored bundle at 64 KiB and each Jira comment at
  20,000 UTF-8 bytes. A bounded Jira comment keeps all headings, repository
  rows, totals, and the dashboard link; it shortens evidence/plan content with
  an explicit `… omitted; open the full run report` note.

Tests must cover configured secrets, token/JWT-like values, sandbox paths,
session-memory text, Unicode byte limits, unknown cost, missing SHA, 50 evidence
items, and deterministic output for identical input.

## 7. Capture the report in the workflow

Make surgical changes in `apps/worker/src/workflows/agent.ts` and
`apps/worker/src/workflows/blocks/types.ts`.

### 7.1 Workflow state

Add `analysisReport: RunAnalysisReport | null` to `EngineCtx` and initialize it
to `null`. Add two workflow step wrappers in `agent.ts`:

- `recordRunAnalysisReportStep(report)` dynamically imports the DB/store module
  and persists the report;
- `postRunAnalysisCommentStep(ticketKey, report, stage, owner)`
  enforces `assertActiveRunOwner`, fetches the ticket, skips when the marker
  already exists, builds the URL with the existing
  `ticketRunUrl(env.DASHBOARD_ORIGIN, ticketKey, report.runId)`, then calls
  `issueTracker.postComment()`.

The comment step returns `RunAnalysisCommentDelivery`. Give it two retries. A
retry first fetches the ticket and recognizes a comment whose POST succeeded but
whose response was lost. After the retry budget, the caller records a sanitized
`failed` delivery and continues the run; reporting must not block code delivery.
Run-control/ownership errors still rethrow.

### 7.2 Ordinary research completion

Inside `case "planning_agent"`, after a completed research result has passed
repository-expansion, clarification, failure, and false-no-change checks:

1. assign `ctx.researchPlanMarkdown` and the final write set as today;
2. compute the research usage snapshot from `runPhaseUsages` and
   `runPhaseModels` with the already-resolved `priceLookup`;
3. build `ctx.analysisReport` from the final manifest, repository state, research
   result, and usage;
4. persist it before any external comment;
5. for ticket-backed runs, publish the research Jira comment, apply the returned
   delivery state, and persist again;
6. return the existing planning block output unchanged.

Persist-before-publish guarantees that a Jira link never points to a report that
does not exist. A crash after Jira publication is resolved by the deterministic
marker when the step replays.

### 7.3 No-change completion

The existing `no_change_needed` branch currently posts
`buildResolutionEvidenceComment()` and exits before downstream blocks. Replace
that standalone evidence comment with the research analysis comment:

- set `stage: "no_change"`;
- include the plan/body and `resolutionEvidence`;
- set `publication: null` and PR delivery to `not_applicable`;
- retain the current ticket move and notification behavior.

This produces one Jira report, not the old evidence comment plus a new duplicate.

### 7.4 Approved-plan continuation

An approval creates a new workflow run. Preserve the research provenance across
that boundary:

- add optional `sourceRunId?: string` to the `approvedPlan` payload in
  `apps/worker/src/workflows/agent-input.ts`;
- set it from `approval.runId` in
  `apps/worker/src/approvals/dispatch.ts`;
- load that run's report during approved-run setup and initialize
  `ctx.analysisReport` through `buildApprovedPlanAnalysisReport()`;
- persist the cloned/fallback report under the new run ID before implementation
  starts;
- do not repost the research Jira comment; copy its delivery state;
- show both run IDs in the dashboard when they differ.

Update the existing input/dispatch tests so older serialized input without the
field remains readable by treating it as optional at normalization boundaries.

### 7.5 PR/MR publication

In `case "open_pr"`, after `publication.status === "published"`:

1. keep the current telemetry PR assignment;
2. if `ctx.analysisReport` exists, add PRs, `ctx.changeSummary`, and the
   publication usage snapshot, then persist;
3. when at least one PR is new, publish the PR-stage analysis comment;
4. apply/persist its delivery result;
5. skip the existing `postPrLinksComment()` success call because the new comment
   already includes every PR/MR link;
6. if no analysis report exists, retain `postPrLinksComment()` exactly as the
   compatibility fallback.

Keep the existing partial-publication failure comment unchanged. A failed
publication does not claim `stage: "published"`.

### 7.6 Final usage

In `recordRunTelemetryStep()`, call `finalizeRunAnalysisUsage()` after
`recordRunUsage()`. Use the same authoritative `totals` passed to terminal
telemetry, including repo-memory distillation. This makes dashboard totals match
the cost screen while preserving the earlier research/publication snapshots.

If report finalization fails, log `run_analysis_final_usage_failed` and preserve
the run outcome. Do not retry or rewrite the report from raw workflow state in
the terminal path.

## 8. Jira comment specification

Both comments use plain text/markdown compatible with the existing Jira ADF
conversion. Do not add an HTML renderer or provider-specific rich-text model.

Research comment sections, in order:

1. `Arthur research complete` plus the run dashboard URL;
2. `Repositories analyzed` with provider/path, read/write, branch@short-SHA, and
   rationale;
3. `What was checked` with ordered evidence;
4. `Decisions` with expansion count/requests and final write repositories;
5. `Implementation plan`;
6. `Usage so far` with total and per-phase cost/tokens/duration/model;
7. the deterministic marker.

PR-stage comment sections, in order:

1. `Arthur pull requests ready` plus all PR/MR links;
2. `Implemented` using the scrubbed `ctx.changeSummary`;
3. a compact repository/evidence summary and the complete plan while it fits;
4. `Usage at publication`;
5. the dashboard URL for the full/final report;
6. the deterministic marker.

Idempotency assertions:

- retrying a stage with the same run ID creates zero additional comments;
- a research marker never suppresses the PR-stage marker;
- two different runs for the same ticket do not suppress one another;
- an approved-plan run does not repost its source run's research comment;
- a lost `postComment()` response is recovered by refetching and matching the
  marker.

## 9. Run-detail API

Extend the existing read path; do not add `/analysis`.

1. Update `RunDetailParts` and `fetchRunDetailFromDb()` in
   `apps/worker/src/db/queries/run-detail-read.ts` to return the stored report.
2. The route `apps/worker/src/routes/api/v1/runs/[runId].get.ts` must attach that
   report whether the step waterfall comes from Postgres or the live Workflow
   world. The report always comes from Postgres.
3. Add `analysisReport: null` to `EMPTY`, both successful response branches,
   and `runDetailFallback()`.
4. Keep `Cache-Control: private, no-store`; the report contains private repo
   names and sanitized analysis and must not enter a shared cache.
5. Do not expose raw workflow observations, artifact logs, workspace paths, or
   ticket comments through this field.

Add assertions to:

- `apps/worker/src/db/queries/run-detail-read.test.ts` for report round-trip and
  legacy null;
- new `apps/worker/src/routes/api/v1/runs/run-detail.test.ts` for DB report +
  live world steps, DB-only fallback, unknown run, and auth/no-store behavior;
- `apps/dashboard/lib/api/fallbacks` tests for the nullable fallback.

## 10. Dashboard UX

Create
`apps/dashboard/components/cockpit/screens/run-analysis-report.tsx` and render it
from `TraceDetail` in `trace.tsx` after the error/clarification cards and before
workflow replay or the legacy step timeline.

The component is one `CkCard` titled `Analysis report` with:

- a stage chip (`Research complete`, `No change needed`, or `PR/MR published`),
  capture time, and source-research-run link when it differs from the current
  run;
- four top-line values: repositories inspected, evidence items, expansion
  rounds, and final/current cost;
- a responsive repository table showing repository, access, research ref, and
  selection reason;
- expandable sections for `What was checked`, `Decisions`, and
  `Implementation plan`;
- an explicit `Source evidence was not retained` state when
  `evidenceStatus === "not_retained"`, distinct from a captured empty list;
- plan rendering through the existing read-only `PromptPreview` rather than a
  new markdown dependency;
- a usage table with Research, Publication, and Final columns. Missing snapshots
  render `Not reached`, and unknown cost renders a lower-bound label;
- PR/MR links and the implementation summary when published;
- small delivery indicators for the two analysis comments, including a safe
  failure message and `Automatic retries exhausted` copy when exhausted;
- a visible warning when sanitization redacted or truncated content.

For a null report:

- hide the card while a planning-capable run is still before research;
- for a terminal historical run, show one compact line above the trace:
  `Analysis report was not captured for this run.`;
- do not show the historical message for workflows whose definition has no
  planning phase unless that distinction is already available in the response.
  If it is not available, prefer hiding the card over guessing.

Responsive/accessibility requirements:

- repository rows stack below the desktop breakpoint;
- expand/collapse controls are real buttons with `aria-expanded`;
- no horizontal page overflow from plan code blocks, SHAs, or repo paths;
- stage and delivery status use text in addition to color;
- keyboard focus follows existing cockpit focus styles.

Add component coverage in
`apps/dashboard/components/cockpit/screens/run-analysis-report.test.tsx` and one
integration assertion in the existing `trace-replay.test.tsx` for placement.
Cover full, research only, no-change, approved-source, unknown cost,
redacted/truncated, Jira failure, mobile markup, and null report cases.

## 11. Verification order

Run focused proof first:

```sh
pnpm --filter worker exec vitest run \
  src/run-analysis/report.test.ts \
  src/run-analysis/store.test.ts \
  src/db/run-analysis-report-migration.test.ts \
  src/db/queries/run-detail-read.test.ts \
  src/lib/telemetry/run-telemetry.test.ts

pnpm --filter ai-workflow-dashboard test
pnpm --filter worker typecheck
pnpm --filter ai-workflow-dashboard typecheck
```

Then run repository gates:

```sh
pnpm test
pnpm typecheck
pnpm build
```

Preview smoke test with one disposable Jira ticket:

1. Start a ticket-backed run with two selected repositories.
2. Verify the research comment appears once and links to a dashboard report
   that already exists.
3. Verify repository paths, branch/SHA, rationale, evidence, plan, and research
   costs agree with the run.
4. Let the run publish a PR/MR; verify the existing PR-ready comment is replaced
   by one PR-stage analysis comment, not supplemented by a third analysis
   comment.
5. Replay/retry both publication steps and verify comment counts do not change.
6. Verify final dashboard cost matches `workflow_runs.cost_usd`, including the
   lower-bound presentation when `cost_known = false`.
7. Put a fake configured secret in model-authored evidence and verify it appears
   nowhere in Postgres API output, dashboard HTML, or Jira.

## 12. Acceptance criteria

- [ ] A ticket-backed planning run persists a report immediately after research,
      before implementation begins.
- [ ] The report names every inspected repository with provider, access,
      rationale, research branch, and real captured SHA (or explicit unknown).
- [ ] Evidence identifies concrete checked locations/findings and is capped at
      50 safe entries.
- [ ] The dashboard shows evidence, decisions, full safe plan, repository scope,
      PRs, change summary, and research/publication/final usage snapshots.
- [ ] Jira receives exactly one research report and exactly one PR-stage report
      for a successful new-PR run. Pickup, clarification, and failure comments
      remain separate existing behavior and are not counted as analysis reports.
- [ ] The PR-stage report replaces the current PR-links-only success comment;
      it does not create a third comment.
- [ ] A no-change run receives one research/no-change report and no PR-stage
      comment.
- [ ] Plan approval preserves the source research run and does not repost the
      research comment.
- [ ] Comment replay, worker retry, and a lost POST response do not create
      duplicates.
- [ ] Jira failure is visible in the dashboard but never changes the code-delivery
      outcome.
- [ ] Unknown tokens/cost remain unknown and are never rendered as zero/exact.
- [ ] Raw logs, chain-of-thought, secrets, sandbox paths, and session-memory
      bookkeeping are absent from storage and both user surfaces.
- [ ] Old runs and workflows without planning continue to render and execute
      unchanged.
- [ ] The migration is nullable, reversible at the application layer, and needs
      no backfill.

## 13. Explicit non-goals and stop condition

Do not include in this feature:

- raw agent stdout/stderr or downloadable research transcripts;
- chain-of-thought or a request to make models reveal it;
- a new run-analysis page, search index, event store, export format, or admin
  configuration;
- editing or approving the plan from the report card;
- cross-run/ticket analytics over evidence;
- report backfill for historical runs;
- Slack delivery or changes to PR body templates;
- reports fabricated for workflows that never ran a planning agent.

Stop when all acceptance criteria pass and the preview smoke proves exactly two
idempotent analysis-report comments in Jira. Additional report filters, exports,
analytics, and customizable templates require separate product decisions.

## 14. Rollout and rollback

1. Apply migration `0054` first; it is additive and does not affect old workers.
2. Deploy worker and dashboard in the same release. A new worker is compatible
   with the old dashboard; the new dashboard treats a temporarily missing field
   as null during rolling deployment.
3. Watch existing structured logs plus:
   `run_analysis_report_recorded`, `run_analysis_comment_posted`,
   `run_analysis_comment_skipped_duplicate`, and
   `run_analysis_comment_failed`. Do not add a metrics service for this slice.
4. Roll back by reverting the writer/API/UI. Leave the nullable column in place;
   dropping it is unnecessary and would destroy recoverable reports.
