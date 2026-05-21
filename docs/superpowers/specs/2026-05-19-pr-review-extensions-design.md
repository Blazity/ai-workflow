# PR Review & Pre-Research Extensions - v1 Design

**Status:** draft  
**Date:** 2026-05-20 (revised 2026-05-21)

## Goal

Add two AI-SDK-driven extension points around the existing `agentWorkflow`:

1. **Pre-Research Flow** — a pre-ticket-implementation phase that runs *before*
   the sandbox-based Research/Impl phases. It uses a Vercel AI SDK agentic
   loop (tools + `stopWhen`) to gather external context (web docs, related
   tickets, similar past PRs, linked design docs) and produces a structured
   brief. That brief is threaded into both the existing Research-and-Plan and
   Implementation phases.

2. **PR Review Pipeline** — a GitHub App webhook-triggered review pipeline.
   Runs when a pull request is opened, updated, reopened, or receives a
   configured label. Supports all GitHub PRs, not only Blazebot-created PRs.

The PR review pipeline ships a small check framework plus two built-in check
kinds:

1. `complexity` - deterministic, in-process cyclomatic complexity check.
2. `ai_review` - configurable AI reviewer using the Vercel AI SDK.

Each configured check publishes one GitHub Check Run. Depending on config, a
check can also post PR review comments and GitHub suggested changes.

The existing `agentWorkflow` body keeps its current shape. Pre-Research is a
new opt-in step inserted before sandbox provisioning; the PR review pipeline
is a separate workflow triggered by GitHub webhooks. Both share an `agentic
loop` helper built on the Vercel AI SDK so that tool-using AI work has one
implementation across the codebase.

## Plain-English Model

### Pre-Research

Before the sandbox agent starts, an AI-SDK agent with a tool belt does a short
"librarian" pass: read the ticket, search the web for relevant library/API
docs, fetch the most useful pages, look at related tickets, list similar
recent merged PRs, and write a one-page brief. The brief is then pasted into
the Research prompt and the Implementation prompt so both phases start with
the same shared context. The sandbox agent does not have to leave the
codebase to chase external knowledge.

### Review Pipeline

Think of the review pipeline as a configurable list of reviewers.

Example:

1. Run complexity check.
2. Run file-by-file style review.
3. Run whole-PR quality review that can read the style review findings.
4. Publish the results to GitHub.

Some reviewers inspect each file independently. Some inspect the whole PR. Some
can depend on earlier reviewers. v1 runs checks sequentially in configured
order, but the config still declares dependencies so parallel execution can be
added later without changing the model.

## Non-goals

### Pre-Research

- Replacing the sandbox-based Research-and-Plan phase. Pre-Research only
  *enriches* it; the sandbox phase still decides plan and acceptance.
- Running pre-research inside the sandbox. The whole point is to do
  network-bound research outside the sandbox boot path.
- Writing files back to the repo. Pre-Research produces context only.
- Per-tool fine-grained quotas in v1 — global `max_steps` and total time
  budget is enough.

### Review Pipeline

- GitLab support for this review pipeline.
- `command_check` or shell-command reviewers.
- Running reviewer agents inside Vercel Sandbox.
- Auto-fixing or pushing commits back to the PR.
- Target-repo-owned config. PRs must not be able to change their own review
  rules.
- Hot-reloading config. Config changes require redeploy.

## Pre-Research Flow

Pre-Research is a new opt-in step inside `agentWorkflow` that runs *before*
sandbox provisioning. It uses a Vercel AI SDK agentic loop to gather external
context and produces a structured brief that is fed into the existing
Research-and-Plan and Implementation phase prompts.

### Why a Separate Phase

The existing sandbox-based Research-and-Plan phase already does
codebase-aware planning, but the sandbox is sealed from the open internet by
default and pays a non-trivial provision cost. Pre-Research runs in the host
Vercel Function with network access, before the sandbox is even allocated.
This:

- Avoids sandbox round-trips for purely-external lookups.
- Lets the codebase agent start with the right docs already extracted.
- Caches results across re-runs of the same ticket revision.
- Reuses the same `agentic-loop` helper that `ai_review` checks use for
  whole-PR tool-using review.

### Trigger and Placement

Pre-Research fires when a ticket enters `COLUMN_AI`, inside `agentWorkflow`,
between `fetchAndValidateTicket` and `provisionSandbox`. It is implemented as
a single `"use step"` so its result is durable and replayable.

If Pre-Research is disabled, missing config, or fails with
`on_failure: skip`, `agentWorkflow` continues with `preResearchBrief: null`.
The existing Research prompt is robust to that — Pre-Research is additive,
never required.

### Agentic Loop

Implementation uses the Vercel AI SDK:

- `generateText` from `ai` for the agent loop.
- `stopWhen: stepCountIs(maxSteps)` to bound the loop.
- `tools: { ... }` declaring the allowed tool belt.
- Anthropic provider from `@ai-sdk/anthropic`.

Pseudocode:

```ts
// src/lib/pre-research.ts
import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { buildPreResearchTools } from "./agentic-loop.js";

export async function runPreResearch(
  input: PreResearchInput,
): Promise<PreResearchBrief | null> {
  "use step";
  const { text, steps, usage, finishReason } = await generateText({
    model: anthropic(input.config.model),
    system: input.systemPrompt,
    prompt: input.userPrompt,
    tools: buildPreResearchTools(input.config, input.adapters),
    stopWhen: stepCountIs(input.config.max_steps),
    experimental_telemetry: { isEnabled: true },
  });
  return parsePreResearchBrief(text, { steps, usage });
}
runPreResearch.maxRetries = 1;
```

Confirm exact AI SDK exports against current docs at implementation time —
`stopWhen`, `stepCountIs`, and `tool()` shapes have changed across AI SDK
versions.

### Tool Belt

Tools are pure functions backed by existing adapters or fetch. None of them
write to the repo or to GitHub. Each tool is small, deterministic in shape,
and returns at most a configured-size budget of bytes.

v1 tool kinds:

- `web_search` — search the web. Implementation choice TBD (provider-defined
  search if available on the model; otherwise a thin wrapper over a
  configured search backend such as Tavily/Brave/Linkup).
- `fetch_url` — fetch a URL, strip boilerplate, return readable content
  capped at `max_fetch_bytes`.
- `search_codebase` — file-name / content grep through the VCS adapter
  (`vcs.searchCode` to be added).
- `read_file_at_ref` — read file content at the base branch ref through the
  VCS adapter.
- `query_tracker` — search related tickets via the issue tracker adapter.
- `search_past_prs` — list merged PRs whose title/body match, via VCS
  adapter.

Tool whitelisting lives in config. Unknown tool names in config fail
validation at startup.

### Config

```yaml
preResearch:
  enabled: true

  scope:
    mode: all # all | label | branch_prefix
    label: deep-research
    branch_prefix: blazebot/

  model: claude-sonnet-4-5
  max_steps: 12
  max_duration_seconds: 180

  prompt:
    source: builtin # arthur | local | builtin
    name: pre-research

  tools:
    - web_search
    - fetch_url
    - search_codebase
    - read_file_at_ref
    - query_tracker
    - search_past_prs

  limits:
    max_references: 20
    max_brief_bytes: 16000
    max_fetch_bytes: 30000

  cache:
    mode: per_ticket_revision_hash # none | per_ticket_revision_hash
    ttl_seconds: 86400

  on_failure: skip # skip | fail

  pass_to:
    - research
    - impl
```

Rules:

- `enabled: false` short-circuits the step.
- `scope` mirrors the review-pipeline `scope` semantics, but for tickets:
  `all` runs for every ticket entering `COLUMN_AI`; `label` runs only if the
  ticket carries the configured label; `branch_prefix` runs only when the
  derived branch name starts with the configured prefix.
- `pass_to` controls which downstream context assemblers receive the brief.
- `on_failure: skip` makes Pre-Research best-effort.
- `on_failure: fail` makes Pre-Research blocking: a failed step moves the
  ticket back to `COLUMN_BACKLOG` and emits a `failed` notification with
  `phase: pre_research`.

### Output Structure

The agent loop must emit structured output. v1 parses a single JSON object
at the tail of the model's text (same convention as the existing parsers in
`src/sandbox/agents/`), or — preferred — uses `generateObject` for the final
summarization step after the agent loop finishes its tool calls.

```ts
// src/lib/pre-research-types.ts
export interface PreResearchReference {
  title: string;
  url: string;
  source: "web" | "tracker" | "vcs" | "pr";
  relevance: string;
  excerpt?: string;
}

export interface PreResearchBrief {
  brief_markdown: string;
  references: PreResearchReference[];
  open_questions: string[];
  used_tools: string[];
  cache_key: string;
  model: string;
  config_hash: string;
  usage: PhaseUsage | null;
}
```

`brief_markdown` is the only field threaded directly into downstream
prompts. The rest is structured metadata for logging, caching, and the
Slack/Jira notification payload.

### Threading Output Into Downstream Phases

The Pre-Research brief is passed into the existing context assemblers in
`src/sandbox/context.ts`:

- `assembleResearchPlanContext({ ..., preResearchBrief })`
- `assembleImplementationContext({ ..., preResearchBrief })`

Both assemblers gain an optional `preResearchBrief?: string` field. When
present, they prepend a clearly-delimited block to the prompt:

```text
<pre_research_brief>
{brief_markdown}
</pre_research_brief>
```

The Research and Implementation prompts in `src/lib/prompts.ts` are updated
to instruct the sandbox agent how to use the brief: trust it as additional
context, but verify any code-level claims against the repository.

The `pass_to` config controls which assemblers receive the brief, so it is
possible to run Pre-Research that informs only Research, only Impl, or both.

### Cache Identity

A cached Pre-Research brief is valid only when all of these match:

- ticket identifier
- ticket revision hash (title + description + acceptance criteria + ordered
  comment IDs)
- config hash (model + prompt source/hash + enabled tools + limits)
- AI SDK adapter version

Cache lives in Redis (the same run registry KV used elsewhere) under
`ai_workflow:preresearch:<ticket_id>:<rev_hash>:<config_hash>` with the
configured TTL. Cache miss is silent; cache hit is logged.

Config or prompt changes invalidate the cache.

### Cancellation and Limits

- The step honors `runRegistry` cancellation between agent steps.
- `max_duration_seconds` is enforced as a wall-clock deadline; the agent
  loop's `stopWhen` also enforces `max_steps`.
- Tools fail fast on transient errors and return a structured error to the
  model so it can decide to continue or stop.
- `max_fetch_bytes` and `max_brief_bytes` are hard caps; overflow is
  truncated with a visible notice in the brief.

### Observability

`runPreResearch` follows the existing `agentWorkflow` step convention:

- Bind `logger.child({ ticket_identifier, step: "preResearch" })` at the top
  of the step.
- Log `pre_research: start` with `model`, `max_steps`, `enabled_tools`,
  `cache_hit` flag.
- Log per-tool-call summaries at `debug` level — tool name, byte sizes in
  and out, latency. Do not log full tool output.
- Log `pre_research: done` with `step_count`, `reference_count`,
  `finish_reason`, `usage`, `duration_ms`.
- On error, log `pre_research: failed` with `err.message` and `step_count`.
- Per-step OpenTelemetry spans are emitted via
  `experimental_telemetry: { isEnabled: true }` on the AI SDK call. These
  flow into the existing Vercel observability drain configured for the
  agent workflow.

### Notification

Pre-Research success/failure is added to the existing Slack/Jira
notification rendering as a sub-status under `started`:

- On success: a one-liner with reference count and used-tool list.
- On `on_failure: skip` failure: a one-liner explaining the skip; the
  workflow keeps running.
- On `on_failure: fail` failure: emits the existing `failed` event with
  `phase: pre_research`.

Usage tokens/cost are added to the `phaseUsages` map under the key
`Pre-Research` so the formatted usage report at the end of the run includes
this phase.

### Sharing the Agentic Loop With Review

The `ai_review` check (whole-PR mode in particular) benefits from the same
tool-using AI SDK loop. v1 extracts a shared helper at
`src/lib/agentic-loop.ts` that takes a `tools`, `model`, `prompt`, and
`stopWhen` config and returns parsed output plus usage. Pre-Research and
`ai_review` both depend on this helper, so any future tool added (e.g. a
new VCS query) is immediately available to both.

## GitHub App Webhook

v1 uses the GitHub App's native webhook, not repository-level webhooks.

GitHub App setup must enable:

- Webhook active.
- Payload URL: `/webhooks/vcs/github/pull-request`.
- Webhook secret stored as `GITHUB_WEBHOOK_SECRET`.
- Subscribed event: `pull_request`.

The handler accepts these `pull_request` actions:

- `opened`
- `synchronize`
- `reopened`
- `labeled`

The handler ignores other actions.

Security rules:

- Verify `X-Hub-Signature-256` using `GITHUB_WEBHOOK_SECRET`.
- Reject invalid signatures with `401`.
- Reject events from repos other than the configured deployment repo.
- v1 is single-repo-per-deployment, even if the GitHub App is installed on more
  than one repository.

GitHub App permissions must include:

- `Pull requests: read & write` - read PR metadata, post review comments.
- `Checks: read & write` - create and update Check Runs.
- `Contents: read` - read file contents when an AI check opts into it.
- `Issues: read` - read labels and issue-style PR comments if needed.
- `Metadata: read` - GitHub mandatory permission.

Existing deployments that also push code may still need stronger permissions,
but the review pipeline itself should not require content write access.

## Config

`workflow.config.yaml` lives in the ai-workflow deployment repo root.

Config is loaded and validated at startup. Invalid config should fail startup.
Config changes require redeploy.

Example:

```yaml
version: 1

review:
  enabled: true

  scope:
    mode: all # all | label | branch_prefix
    label: ai-review
    branch_prefix: blazebot/

  triggers:
    - opened
    - synchronize
    - reopened
    - labeled

  default_ignore:
    - "**/dist/**"
    - "**/build/**"
    - "**/coverage/**"
    - "**/vendor/**"
    - "**/*.generated.*"
    - "**/*.lock"
    - "pnpm-lock.yaml"
    - "package-lock.json"

  limits:
    max_changed_files: 25
    max_total_diff_bytes: 80000
    max_file_content_bytes: 30000
    max_check_annotations: 50
    max_review_comments: 10
    max_suggestions: 5

  checks:
    - id: complexity
      kind: complexity
      name: "AI / Complexity"
      enabled: true
      blocking: false
      fail_on: critical
      params:
        files: "**/*.{ts,tsx,js,jsx}"
        ignore:
          - "**/*.test.ts"
          - "**/*.test.tsx"
        max_cyclomatic: 10

    - id: style-per-file
      kind: ai_review
      name: "AI / Style"
      enabled: true
      blocking: false
      fail_on: warning
      comments:
        enabled: true
        severity_threshold: warning
        suggestions: true
        suggestions_threshold: warning
      cache:
        mode: per_file_content_hash # none | per_file_content_hash
        reuse_previous_annotations: true
      params:
        mode: per_file # per_file | whole_pr
        model: claude-sonnet-4-5
        prompt:
          source: arthur # arthur | local | builtin
          name: style-review
          tag: production
        data:
          - file_diff
          - file_content
        limits:
          max_files: 15
          max_file_diff_bytes: 12000
          max_file_content_bytes: 20000
          max_findings: 20

    - id: quality-whole-pr
      kind: ai_review
      name: "AI / Quality"
      enabled: true
      blocking: true
      fail_on: critical
      needs:
        - style-per-file
      skip_on_dependency_failure: true
      comments:
        enabled: true
        severity_threshold: critical
        suggestions: false
      cache:
        mode: none
      params:
        mode: whole_pr
        model: claude-sonnet-4-5
        prompt:
          source: local
          path: .blazebot/review-prompts/quality.md
        data:
          - diff
          - changed_files
          - prior_comments
          - prior_findings
          - ticket
          - acceptance_criteria
```

### Scope

`review.scope.mode` controls which PRs are reviewed.

- `all` - review every PR for the configured repo.
- `label` - review PRs that have the configured label. The `labeled` webhook
  action triggers review when the label is added after PR creation.
- `branch_prefix` - review PRs whose head branch starts with the configured
  prefix.

For v1, scope is a top-level review filter. Per-check scope can be added later
if real clients need it.

### Severity

Use one severity scale everywhere:

- `info`
- `warning`
- `critical`

The same scale controls:

- Check Run annotations.
- PR review comments.
- Suggested changes.
- Blocking Check Run failure thresholds.

### Blocking

Checks may be blocking.

Rules:

- No findings: Check Run conclusion is `success`.
- Findings below `fail_on`: conclusion is `neutral`.
- `blocking: false`: findings do not fail the Check Run.
- `blocking: true` and at least one finding severity is at or above `fail_on`:
  conclusion is `failure`.
- Internal check error: publish an error Check Run. If `blocking: true`, use
  `failure`; otherwise use `neutral`.

Severity ordering:

```text
info < warning < critical
```

### Comments And Suggestions

Each check can opt into PR review comments.

```yaml
comments:
  enabled: true
  severity_threshold: warning
  suggestions: true
  suggestions_threshold: warning
```

Rules:

- Check Run annotations are the primary output.
- PR comments are optional and thresholded.
- Suggested changes are optional and thresholded.
- Suggested changes are allowed only for small, exact replacements anchored to
  changed diff lines.
- If a finding cannot be anchored cleanly to a changed diff line, publish a
  normal comment or Check Run annotation instead.
- Comment bodies include hidden idempotency markers so Workflow retries do not
  duplicate comments.

Suggested-change comment shape:

````md
This does not match the configured style.

```suggestion
const value = formatPrice(amount);
```

<!-- ai-workflow:finding:<fingerprint> -->
````

### Dependencies

Checks can depend on earlier checks:

```yaml
needs:
  - style-per-file
skip_on_dependency_failure: true
```

v1 runs checks sequentially in configured order.

Rules:

- A check can read results from checks listed in `needs`.
- In v1, `needs` must reference earlier checks in the configured order.
- If a dependency failed and `skip_on_dependency_failure` is true, skip the
  dependent check and publish a neutral Check Run explaining why.
- Independent checks continue after another check fails.
- Config validation rejects cycles and references to unknown check IDs.

### Limits

Default v1 limits are intentionally small:

```yaml
review:
  limits:
    max_changed_files: 25
    max_total_diff_bytes: 80000
    max_file_content_bytes: 30000
    max_check_annotations: 50
    max_review_comments: 10
    max_suggestions: 5
```

AI checks can override narrower per-check limits:

```yaml
params:
  limits:
    max_files: 15
    max_file_diff_bytes: 12000
    max_file_content_bytes: 20000
    max_findings: 20
```

Limit behavior:

- Ignore generated/vendor/build/lock files before applying file limits.
- Per-file AI checks do not run on deleted files.
- Oversized per-file diffs are skipped for that file.
- Oversized file content is skipped rather than truncated.
- Whole-PR diff can be truncated with a visible coverage notice.
- Limit overflow produces a Check Run coverage notice. It must not be silent.
- Findings beyond `max_findings` are summarized instead of posted individually.
- Comments and suggestions stop at their configured caps.

GitHub Check Run annotations have API limits. v1 must cap annotations and put
overflow details in the Check Run summary/text.

## Extension Model

The framework has two pieces:

1. A `Check` interface.
2. A registry keyed by `kind`.

The workflow executor dispatches through the registry. It should not branch on
specific check kinds.

```ts
// src/lib/checks/types.ts
import type { z } from "zod";

export type Severity = "info" | "warning" | "critical";

export interface FindingLocation {
  path: string;
  start_line: number;
  end_line?: number;
}

export interface RelatedLocation {
  path: string;
  start_line?: number;
  note?: string;
}

export interface SuggestedChange {
  path: string;
  start_line: number;
  end_line: number;
  replacement: string;
}

export interface Finding {
  severity: Severity;
  message: string;
  primary_location?: FindingLocation;
  related_locations?: RelatedLocation[];
  suggestion?: SuggestedChange;
  fingerprint: string;
}

export interface CheckResult {
  summary: string;
  findings: Finding[];
  notices: string[];
  cache_manifest?: CheckCacheManifest;
}

export interface CheckCacheManifest {
  cache_version: 1;
  check_id: string;
  config_hash: string;
  files: Record<string, {
    content_hash: string;
    status: "completed" | "skipped" | "failed";
    finding_count: number;
    previous_check_run_id?: number;
  }>;
}

export interface PRContext {
  owner: string;
  repo: string;
  pr_number: number;
  pr_url: string;
  base_sha: string;
  head_sha: string;
  labels: string[];
}

export type RequestedReviewData = Record<string, unknown>;

export interface CheckContext {
  pr: PRContext;
  requested_data: RequestedReviewData;
  dependency_results: Record<string, CheckResult>;
  previous_cache?: CheckCacheManifest;
}

export interface Check<TParams = unknown> {
  readonly kind: string;
  readonly paramsSchema: z.ZodType<TParams>;
  run(params: TParams, ctx: CheckContext): Promise<CheckResult>;
}
```

`CheckContext` contains only allow-listed review data assembled by the workflow:

- repo owner/name
- PR number and URL
- base/head refs and SHAs
- labels
- changed files
- file patches
- full PR diff when requested
- file contents when requested
- prior PR comments when requested
- optional ticket and acceptance criteria
- prior findings from checks listed in `needs`
- previous check cache if enabled

Checks do not fetch arbitrary data themselves. The workflow owns data access.

### Registry

```ts
// src/lib/checks/registry.ts
import { aiReviewCheck } from "./ai-review.js";
import { complexityCheck } from "./complexity.js";

export const CHECKS = {
  [aiReviewCheck.kind]: aiReviewCheck,
  [complexityCheck.kind]: complexityCheck,
};
```

v1 registered kinds:

- `ai_review`
- `complexity`

No other kind is accepted by the v1 config schema.

## AI Review Check

`ai_review` supports two modes:

- `per_file` - runs once per eligible changed file and aggregates results into
  one Check Run.
- `whole_pr` - runs once for the whole PR.

Per-file mode is appropriate for:

- style
- local code quality
- small security checks
- file-specific conventions
- checks that benefit from per-file caching

Whole-PR mode is appropriate for:

- cross-file behavior
- architecture
- integration issues
- acceptance criteria
- consistency across files
- reviewing prior findings from per-file checks

### Prompt Sources

Prompts are explicit:

```yaml
prompt:
  source: arthur
  name: style-review
  tag: production
```

```yaml
prompt:
  source: local
  path: .blazebot/review-prompts/style.md
```

```yaml
prompt:
  source: builtin
  name: pr-review
```

Rules:

- `arthur` fetches a named prompt by tag.
- `local` loads a prompt file from the ai-workflow deployment repo.
- `builtin` uses checked-in fallback prompts for built-in examples only.
- Client-defined reviewers should use `arthur` or `local`.
- AI cache identity must include prompt source and prompt hash/version.

### Data Selection

AI checks receive only the data they request.

Examples:

```yaml
data:
  - diff
```

```yaml
data:
  - file_diff
  - file_content
```

```yaml
data:
  - diff
  - changed_files
  - prior_comments
  - prior_findings
  - ticket
  - acceptance_criteria
```

Supported v1 data keys:

- `diff`
- `file_diff`
- `file_content`
- `changed_files`
- `prior_comments`
- `prior_findings`
- `ticket`
- `acceptance_criteria`

`ticket` and `acceptance_criteria` are optional. All-PR review must work without
Jira context. Blazebot PRs may get richer context if the branch/ticket can be
resolved.

### AI SDK

Implementation uses the Vercel AI SDK:

- `generateObject` from `ai`
- Anthropic provider from `@ai-sdk/anthropic`

Model IDs are config strings. Implementation must confirm the accepted provider
model IDs against current AI SDK docs before shipping.

Structured AI output schema:

```ts
{
  summary: string;
  findings: Array<{
    severity: "info" | "warning" | "critical";
    message: string;
    primary_location?: {
      path: string;
      start_line: number;
      end_line?: number;
    };
    related_locations?: Array<{
      path: string;
      start_line?: number;
      note?: string;
    }>;
    suggestion?: {
      path: string;
      start_line: number;
      end_line: number;
      replacement: string;
    };
  }>;
}
```

The implementation derives stable finding fingerprints from check ID, head SHA,
path, line range, severity, message, and suggestion content.

## Complexity Check

The `complexity` check:

- Looks only at changed files matching `params.files`.
- Applies global and per-check ignore patterns.
- Uses the TypeScript compiler API to parse JavaScript/TypeScript files.
- Computes cyclomatic complexity from the full function body.
- Reports only functions whose declaration/body overlaps changed diff lines.
- Maps each finding to one Check Run annotation when possible.

Default threshold:

```yaml
max_cyclomatic: 10
```

Runtime note: because the complexity check imports the TypeScript compiler API at
runtime, `typescript` should be a production dependency if the bundler does not
include dev dependencies in the deployed server bundle.

## Cache And Reuse

Cache is explicit opt-in per check.

```yaml
cache:
  mode: none
```

```yaml
cache:
  mode: per_file_content_hash
  reuse_previous_annotations: true
```

v1 cache source of truth is previous GitHub Check Run output. Do not add a
separate Redis/Postgres cache for v1 unless GitHub output proves insufficient.

### Cache Identity

A cached per-file AI result is valid only when all of these match:

- repo
- PR number
- check ID
- check kind
- AI mode
- model
- prompt source and prompt hash/version
- relevant params hash
- file path
- file content hash

Config or prompt changes invalidate cache.

### Cache Manifest

Each Check Run may include a machine-readable cache manifest in `output.text`.

Example:

```md
<!-- ai-workflow-cache
{
  "cache_version": 1,
  "check_id": "style-per-file",
  "config_hash": "sha256:...",
  "files": {
    "src/Button.tsx": {
      "content_hash": "sha256:...",
      "status": "completed",
      "finding_count": 2,
      "previous_check_run_id": 123456789
    }
  }
}
-->
```

On a new review, the workflow:

1. Lists recent commits for the PR.
2. Finds the latest previous completed Check Run for the same check ID.
3. Parses the cache manifest.
4. Reuses entries whose cache identity still matches.
5. Treats missing, invalid, or too-large cache manifests as cache misses.

If `reuse_previous_annotations` is true, the workflow can fetch annotations from
the previous Check Run and copy still-valid annotations to the new Check Run for
unchanged files.

PR review comments are not blindly reposted. Comment bodies include hidden
finding markers, and the workflow skips posting a comment if the same marker is
already present on the PR.

## Workflow

High-level flow:

```text
GitHub App pull_request webhook
  -> src/routes/webhooks/vcs/github/pull-request.post.ts
  -> verify HMAC and repo/action/scope
  -> start reviewWorkflow(prNumber, headSha, action)
  -> assemble PRContext
  -> run configured checks sequentially
  -> publish one Check Run per check
  -> optionally publish PR review comments/suggestions
```

### Webhook Route

Responsibilities:

1. Read raw body.
2. Verify `X-Hub-Signature-256`.
3. Parse payload.
4. Ignore unsupported actions.
5. Reject non-configured repo.
6. Apply scope filter from config.
7. Start `reviewWorkflow`.
8. Return `200` quickly after enqueueing.

The route should pass only serializable workflow arguments:

```ts
{
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  action: string;
}
```

The workflow re-fetches PR data by API. It should not trust the webhook payload
as the complete PR context.

### Review Workflow

The workflow body should orchestrate only. I/O and heavy work live in `"use
step"` functions.

Steps:

1. Load validated config.
2. Fetch PR metadata, labels, changed files, diff, prior comments, and optional
   ticket context.
3. Apply default ignore patterns and limits.
4. For each enabled check in configured order:
   - verify dependencies are complete
   - find existing Check Run for the same check/head SHA
   - skip exact duplicate deliveries when possible
   - create or update the Check Run to `in_progress`
   - load previous Check Run cache if configured
   - run the check
   - map findings to annotations/comments/suggestions
   - update the Check Run to completed
5. Continue independent checks after failures.

Check Run idempotency:

```text
external_id = ai-workflow:<configHash>:<checkId>:<headSha>
```

If GitHub redelivers the same webhook for the same head SHA, the workflow should
find the existing Check Run by external ID and avoid duplicate work.

If a newer SHA arrives while an older review is running, the older review may
complete for the older SHA. GitHub will show latest-SHA checks as current.

No debounce/coalescing beyond same-SHA dedupe in v1.

## GitHub Output Mapping

### Check Runs

Each configured check creates one Check Run.

The Check Run output includes:

- human summary
- coverage notices
- findings summary
- annotations up to configured cap
- hidden cache manifest when enabled

Annotation mapping:

- `info` -> `notice`
- `warning` -> `warning`
- `critical` -> `failure`

If a finding has no valid `primary_location`, include it in the Check Run
summary/text only.

`related_locations` are rendered in the message/body text. GitHub annotations
and PR comments still anchor to one primary location.

### PR Review Comments

When enabled:

- post comments only for findings at or above `comments.severity_threshold`
- respect `max_review_comments`
- dedupe by hidden finding marker
- include related locations in the body
- include suggested changes only when valid and under `max_suggestions`

v1 should prefer a batched PR review when practical, rather than many separate
API calls.

## VCS Adapter Additions

Add GitHub support for:

- fetch PR metadata by number
- get PR files, statuses, patches, and changed line ranges
- get full PR diff
- get file content at a ref
- list PR commits
- list Check Runs for a ref
- create Check Run
- update Check Run
- list Check Run annotations
- list PR review comments
- create PR review comments or a batched PR review

GitLab adapter methods for this pipeline throw `NotSupported` in v1.

## File Changes

| Path | Change |
| --- | --- |
| `workflow.config.yaml` | new deployment-owned review and pre-research config |
| `src/lib/workflow-config.ts` | new Zod schema (review + preResearch), startup loader, config hash |
| `src/lib/agentic-loop.ts` | new shared AI SDK agent loop helper used by Pre-Research and ai_review |
| `src/lib/pre-research.ts` | new Pre-Research step, AI SDK loop wiring, brief parser |
| `src/lib/pre-research-types.ts` | new types for `PreResearchBrief`, references, cache identity |
| `src/lib/pre-research-tools.ts` | new tool belt: web_search, fetch_url, search_codebase, read_file_at_ref, query_tracker, search_past_prs |
| `src/lib/pre-research-cache.ts` | new Redis-backed cache helpers keyed by ticket-revision hash |
| `src/sandbox/context.ts` | thread optional `preResearchBrief` into research and impl assemblers |
| `src/lib/prompts.ts` | update research/impl prompt scaffolding to handle `<pre_research_brief>` block; add built-in pre-research prompt and built-in PR review fallback |
| `src/workflows/agent.ts` | insert `runPreResearch` step before `provisionSandbox`; pass brief through to context assemblers; record usage under `Pre-Research` |
| `src/lib/checks/types.ts` | new check/result/finding/cache types |
| `src/lib/checks/registry.ts` | new built-in check registry |
| `src/lib/checks/complexity.ts` | new complexity check |
| `src/lib/checks/ai-review.ts` | new AI review check (uses `agentic-loop.ts`) |
| `src/lib/checks/cache.ts` | new Check Run cache manifest helpers |
| `src/lib/pr-context.ts` | new PR context assembly helpers |
| `src/workflows/review.ts` | new durable review workflow |
| `src/routes/webhooks/vcs/github/pull-request.post.ts` | new GitHub App webhook route |
| `src/adapters/vcs/types.ts` | add PR review/check-run methods + `searchCode`, `searchMergedPRs` for Pre-Research tools |
| `src/adapters/vcs/github.ts` | implement GitHub methods (including code search and merged-PR search) |
| `src/adapters/vcs/gitlab.ts` | throw `NotSupported` for review pipeline methods; implement code search + merged-MR search if cheap, otherwise `NotSupported` |
| `src/workflows/prompts-step.ts` | support named prompt loading for review checks and Pre-Research |
| `env.ts` | add `GITHUB_WEBHOOK_SECRET`, optional `WORKFLOW_CONFIG_PATH`, optional `WEB_SEARCH_API_KEY` |
| `package.json` | add `ai`, `@ai-sdk/anthropic`, `yaml`; ensure runtime TS compiler availability |
| `SETUP.md` | document GitHub App webhook, permissions, Pre-Research opt-in, and config examples |

## Implementation Order

Pre-Research and the Review Pipeline share `agentic-loop.ts`. Build the
shared helper once, then layer the two features on top.

1. Add config schema (review + preResearch), config hash, and startup
   validation.
2. Add shared check/finding/cache types and empty registry.
3. Add `src/lib/agentic-loop.ts` — the shared AI SDK loop helper with
   `tools`, `stopWhen`, structured output parsing, and usage extraction.
4. Add Pre-Research types, tool belt, cache helpers, and the
   `runPreResearch` step. Land its mocked-AI-SDK unit tests before wiring
   into `agentWorkflow`.
5. Thread `preResearchBrief` through `assembleResearchPlanContext` and
   `assembleImplementationContext`; update Research/Impl prompt scaffolds.
6. Wire `runPreResearch` into `agentWorkflow` between
   `fetchAndValidateTicket` and `provisionSandbox`. Add the
   `Pre-Research` entry in `phaseUsages`.
7. Add GitHub adapter methods for PR data, Check Runs, annotations, review
   comments, code search, and merged-PR search.
8. Add webhook route with HMAC verification, repo filtering, action
   filtering, and scope filtering.
9. Add PR context assembly with ignore handling, changed-line mapping,
   limits, and optional ticket enrichment.
10. Add complexity check and tests.
11. Add AI review check on top of `agentic-loop.ts`, with mocked AI SDK
    tests for `per_file` and `whole_pr`.
12. Add Check Run cache manifest read/write and reuse tests.
13. Add review workflow orchestration, dependency handling, idempotency,
    and error isolation.
14. Update setup docs and run a manual end-to-end test on a preview
    deployment: one ticket exercising Pre-Research + sandbox phases, then a
    PR exercising the review pipeline.

## Tests

### Pre-Research

- config parsing for `preResearch`: enabled flag, scope modes, tool
  whitelist, limits
- unknown tool name in config rejected at startup
- `enabled: false` short-circuits the step and returns `null`
- scope filtering: `all` runs, `label` only runs when label present,
  `branch_prefix` only runs when branch starts with prefix
- agentic loop respects `stopWhen` step cap and wall-clock deadline
- `runRegistry` cancellation between steps aborts the loop cleanly
- structured output parser tolerates trailing/leading non-JSON noise
- cache hit returns the previous brief without invoking the model
- cache key invalidates when prompt source/hash, model, or enabled-tool set
  changes
- `on_failure: skip` lets the workflow continue with `preResearchBrief =
  null`
- `on_failure: fail` moves the ticket back to `COLUMN_BACKLOG` and emits a
  `failed` event with `phase: pre_research`
- `pass_to` controls which assemblers receive the brief
- usage tokens land in `phaseUsages["Pre-Research"]`
- tool belt: `fetch_url` respects `max_fetch_bytes`; `search_codebase` and
  `read_file_at_ref` go through the VCS adapter; tools return structured
  errors on transient failures
- assembled Research/Impl prompts include the `<pre_research_brief>` block
  when present and omit it when absent

### Review Pipeline

- config parsing and invalid config failures
- unknown check kind rejection
- dependency cycle rejection
- scope filtering: `all`, `label`, `branch_prefix`
- webhook HMAC validation
- unsupported action ignored
- non-configured repo rejected
- same-SHA dedupe
- complexity check only reports changed functions
- per-file AI skips deleted files and oversized files
- whole-PR AI handles missing ticket context
- prior findings are passed to dependent checks
- blocking/fail-on conclusion mapping
- comment/suggestion thresholding and caps
- comment dedupe marker behavior
- Check Run cache manifest parse failures become cache misses
- per-file content hash cache invalidates when config/prompt/model changes
- `ai_review` and Pre-Research share `agentic-loop.ts` — same helper
  exercised by both test suites

## Rollout

Default rollout should be dark:

```yaml
review:
  enabled: false
```

First production rollout:

1. Enable for one repo.
2. Start with `scope.mode: label`.
3. Add label to a test PR.
4. Verify Check Runs, annotations, comments, suggestions, and cache behavior.
5. Switch to `scope.mode: all` only after noise/cost is acceptable.

## Open Questions

1. Confirm current AI SDK Anthropic model IDs and the exact agentic-loop API
   surface (`generateText`, `stopWhen`, `stepCountIs`, `tool()`,
   `experimental_telemetry`) against current AI SDK docs at implementation
   time. Several have shifted between AI SDK versions.
2. Decide whether `Issues: read` is enough or `Issues: write` is needed if we
   later add issue-style PR comments. v1 should prefer PR review comments.
3. Validate GitHub Check Run `output.text` size limits against real cache
   manifests. If too small, cache should degrade to miss rather than adding
   a separate store in v1.
4. Choose the v1 `web_search` backend for Pre-Research. Options: AI SDK
   provider-defined search (if available on the chosen model), or a thin
   wrapper over Tavily / Brave / Linkup behind `WEB_SEARCH_API_KEY`. v1
   should ship with exactly one and treat the choice as configurable later.
5. Decide whether Pre-Research should also fire on the review pipeline (so
   non-Blazebot PRs get a pre-review research brief), or stay
   ticket-scoped. v1 keeps it ticket-scoped to limit blast radius.
6. Confirm Redis cache TTLs and key prefixes against the existing
   `AI_WORKFLOW_KV` schema before shipping.
