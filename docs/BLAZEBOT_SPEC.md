# Blazebot Service Specification

Status: Draft v2

Purpose: Define a workflow-driven automation service that picks up tickets, implements features
end-to-end inside isolated sandboxes, and delivers merge-ready pull requests for human approval.

## 1. Problem Statement

Blazebot is a long-running, workflow-driven automation service that watches an issue tracker for
tickets assigned to AI, implements features end-to-end inside isolated sandboxes (Vercel Sandbox
or Docker containers), and delivers merge-ready pull requests for human approval.

The service solves four operational problems:

- It turns ticket implementation into a fully automated pipeline — from assignment through TDD,
  code review, conflict resolution, and PR delivery — without manual intervention.
- It isolates agent execution in per-ticket sandboxes so agent commands cannot affect production
  infrastructure or other tickets.
- It manages ticket lifecycle directly — moving tickets between columns, posting clarification
  questions, and notifying users — as first-class service behavior.
- It enforces quality through mandatory TDD and an iterative review loop (AI review → human
  review → agent fix → re-review) before any PR reaches a human for final approval.

Important boundary:

- Blazebot owns the full lifecycle from ticket pickup to merge-ready PR.
- The coding agent inside the sandbox focuses on implementation — it does not manage ticket state,
  PR creation, or review coordination.
- A successful run ends with a PR ready for human review.

## 2. Goals and Non-Goals

### 2.1 Goals

- Receive ticket events via webhooks and dispatch work through a durable workflow engine
  (`workflow/api` + `@workflow/world-postgres`) with bounded concurrency.
- Maintain authoritative orchestration state in Postgres for dispatch, retries, and audit.
- Recover orchestrator state from service restarts using Postgres as the single source of truth — no
  filesystem-based recovery needed. Individual agent runs are stateless — each run spins up a fresh
  sandbox, fetches context from the tracker, and tears down on completion. Postgres recovery applies
  to the orchestrator knowing which tickets are in-flight and what workflow state to resume from.
- Spin up isolated sandboxes per ticket (Vercel Sandbox or Docker containers) with scoped Git
  permissions.
- Enforce TDD — integration and e2e tests are required, not optional.
- Run iterative code review loops (AI review → human feedback → agent fix) until clean.
- Handle conflict resolution (merge target branch, resolve conflicts, re-review).
- Manage two ticket transitions directly: move to **AI Review** when implementation passes
  self-review, and move to **Backlog** when clarification is needed.
- Notify users via messaging adapter (Slack/Teams) when user action is required (e.g., clarification
  needed, PR ready for review).
- Support clarification flow — commit work-in-progress, tear down container, post questions on
  ticket, and resume in a fresh container with full conversation history when answered.
- Support adapter modularity — all external integrations behind isolated interfaces so swapping
  e.g. Jira → Linear or Slack → Teams is a single-module replacement.
- Design for self-hosting — users provide their own API keys (issue tracker, VCS, messaging, AI
  model) and run the service on their own infrastructure. The project is intended to be open source.

### 2.2 Non-Goals

- Rich multi-tenant control plane or SaaS UI.
- General-purpose CI/CD or workflow engine.
- Running agents outside sandboxes (bare-metal execution).
- Replacing human final approval on PRs.
- Built-in IDE or code editor.
- Prescribing a specific dashboard or terminal UI implementation.

## 3. System Overview

### 3.1 Main Components

1. **Webhook Receiver** (Nitro)
   - Receives ticket events from issue tracker (Jira/Linear).
   - Validates payloads (HMAC-SHA256 verification via `x-hub-signature` header).
   - Delegates to adapter for normalization, routes to orchestrator for workflow dispatch.

2. **Issue Tracker Adapter**
   - Reads ticket data (description, acceptance criteria, comments, labels).
   - Writes ticket transitions (→ AI Review, → Backlog).
   - Posts clarifying questions as ticket comments.
   - Parses and validates incoming webhooks into normalized events.

3. **Messaging Adapter**
   - Sends status notifications via ChatSDK (`chat` + platform adapters like `@chat-adapter/slack`).
   - Pings users on clarification requests.
   - ChatSDK provides unified multi-platform support (Slack, Discord, Teams, etc.) through a single
     `Chat` instance with pluggable platform adapters.

4. **VCS Adapter**
   - Creates feature branches.
   - Creates pull requests.
   - Fetches PR comments (liked + human-written).
   - Reports PR conflict status.

5. **Orchestrator** (Webhook Router + Workflow Helpers)
   - Decides what action to take based on normalized webhook events and current workflow state.
   - Starts durable workflows (`implementation`, `review_fix`) via the workflow framework.
   - Manages concurrency limits.
   - Handles stale job protection (cancel on contradicting webhook + verify at job start + polling
     fallback for missed webhooks and stuck jobs).
   - Deduplicates webhooks — ignores duplicate events for tickets already `queued`/`implementing`.

6. **Sandbox Provider** (pluggable)
   - Two implementations: **Vercel Sandbox** (active) and **Docker** (available, currently disabled
     in code but with full Dockerfile and guard scripts in `docker/sandbox/`).
   - Clones the repo at the feature branch.
   - Writes `requirements.md` into the sandbox with assembled context.
   - Installs and runs the Claude Code CLI.
   - Pushes the feature branch after the agent completes.
   - Tears down sandboxes after every run.
   - Cleans up orphaned sandboxes on service startup.

7. **Agent Runner** (integrated into Sandbox Provider)
   - Launches Claude Code CLI inside the sandbox via
     `claude --print --output-format json --json-schema <schema> --model <model> --dangerously-skip-permissions`
     with `requirements.md` piped to stdin.
   - Reads structured output (JSON schema enforced) to determine outcome.
   - Timeout enforced by the sandbox provider.

8. **Persistence Layer** (Drizzle + Postgres)
   - Stores ticket orchestration state and run attempts.
   - Single source of truth for recovery after service restarts.
   - Strict data boundary: Postgres holds only orchestration state, reporting, and observability
     data. No ticket content, client code, or confidential data is ever stored — that stays in the
     issue tracker and VCS as the source of truth.

9. **Logging & Observability**
   - Structured JSON logs with ticket/run context.
   - Dashboard, metrics, and token tracking deferred.

### 3.2 Abstraction Layers

1. **Adapter Layer** — Issue tracker, messaging, VCS adapters (all behind interfaces, swappable).
2. **Orchestration Layer** — Workflow dispatch, concurrency, retries, ticket state decisions.
3. **Execution Layer** — Sandbox lifecycle, agent runner, provider management.
4. **Persistence Layer** — Postgres state (orchestration + workflow engine).
5. **Observability Layer** — Logging, metrics, optional dashboard.

### 3.3 External Dependencies

MVP:

- Issue tracker API (Jira).
- Messaging via ChatSDK (Slack adapter via `@chat-adapter/slack`; Discord, Teams available via
  additional adapters).
- VCS API (GitHub via Octokit).
- Sandbox runtime (Vercel Sandbox via `@vercel/sandbox`, or Docker engine).
- Postgres (orchestration state + workflow engine state via `@workflow/world-postgres`).
- Coding agent (Claude Code CLI — `@anthropic-ai/claude-code`).

Deferred: Linear, GitLab. Additional messaging platforms (Discord, Teams) are available via
ChatSDK adapters — install the corresponding `@chat-adapter/*` package.

## 4. Core Domain Model

### 4.1 Ticket (DB Record — Orchestration State)

Fields:

- `id` — UUID, primary key.
- `external_id` — tracker-issued key (e.g., `PROJ-123`).
- `identifier` — human-readable display key.
- `source` — enum: `jira` | `linear`.
- `state` — last known tracker column/status (updated by webhooks).
- `workflow_state` — Blazebot's internal lifecycle state (see Section 7).
- `assignee` — user who triggered the AI run (stored for audit; not used for notifications in MVP).
- `branch_name` — feature branch for this ticket.
- `pr_id` — pull request number as string (set after PR creation).
- `current_run_id` — reference to active run attempt. All historical run attempts are persisted and
  queryable via `RunAttempt.ticket_id` for audit and visibility. Set to `null` when a run completes.
- `created_at`
- `updated_at`
- Unique constraint on `(external_id, source)`.

Ticket content (title, description, acceptance criteria, comments, labels) is always fetched fresh
from the tracker API — never stored in the database.

### 4.2 Run Attempt

One execution attempt for one ticket.

Fields:

- `id` — UUID, primary key.
- `ticket_id` — **indexed** (frequently queried for run history per ticket).
- `attempt_number` — 1 for first, increments on retry.
- `type` — `implementation`, `review_fix`, `conflict_resolution`.
- `status` — `pending`, `preparing_sandbox`, `running`, `succeeded`, `failed`, `timed_out`,
  `clarification_needed`, `cancelled`.
- `workflow_run_id` — workflow framework run ID (for cancellation and tracking).
- `container_id` — sandbox/container reference (Vercel sandbox ID or Docker container ID).
- `branch_name`
- `started_at`
- `finished_at`
- `error` — failure reason if any.

Retries are handled by the maintenance polling loop — stuck or failed jobs are detected and
re-enqueued with a new workflow run, respecting `JOB_MAX_RETRIES`. No custom retry entity needed.

## 5. Agent Prompt Contract

Prompt files live in the Blazebot service repository at `packages/app/prompts/` and are read by the
orchestrator during context assembly. The assembled `requirements.md` (which includes the prompt
content) is written into the sandbox before the agent starts.

- `packages/app/prompts/implement.md` — initial implementation prompt.
- `packages/app/prompts/review-fix.md` — fixing review feedback + resolving merge conflicts.

The agent also picks up repo-level instruction files (`CLAUDE.md`, `AGENTS.md`) from the client's
repository at runtime. These are maintained by the client and provide general coding conventions.
Blazebot prompts provide task-specific instructions only.

Prompt files are:

- Versioned in the Blazebot repo — changes go through normal PRs.
- Self-contained — no composition or inheritance between them.
- Pure prompt content — no runtime config.
- Must include agent constraints — scope limits (only modify files relevant to the ticket, no
  refactoring outside acceptance criteria, no architectural changes unless explicitly requested).
  These constraints are the primary mechanism for preventing agent scope creep.
- Must instruct the agent to handle comment overrides — a ticket comment prefixed with `[OVERRIDE]`
  negates or supersedes a previous comment. This prevents content poisoning where conflicting
  instructions from different commenters cause the agent to do the wrong thing. The agent should
  treat the latest `[OVERRIDE]` comment as authoritative over prior conflicting instructions.

When resuming after clarification, `packages/app/prompts/implement.md` is used again. The Q&A context
comes from ticket comments (fetched fresh), not from the prompt file.

If a prompt file is missing, the run fails with a clear error.

The coding agent uses a default model for all runs. Model routing (per-ticket model selection based
on labels or complexity) is deferred.

## 6. Configuration

All runtime config lives in environment variables, validated at startup. Changes require service
restart. In-flight jobs finish with the config they started with; new jobs pick up new config after
restart.

Key config groups (validated via `@t3-oss/env-core` + Zod at startup):

- **Sandbox:** provider (`SANDBOX_PROVIDER`: `docker` | `vercel`), Docker image (`DOCKER_IMAGE`),
  memory limit (`SANDBOX_MEMORY_MB`), Vercel credentials (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
  `VERCEL_PROJECT_ID`), vCPUs (`VERCEL_SANDBOX_VCPUS`), concurrency limit
  (`MAX_CONCURRENT_AGENTS`), job timeout (`JOB_TIMEOUT_MS`).
- **Issue Tracker:** adapter kind (`ISSUE_TRACKER_KIND`), project key (`JIRA_PROJECT_KEY`),
  credentials (`JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`), webhook secret
  (`JIRA_WEBHOOK_SECRET`).
- **Messaging:** adapter kind (`MESSAGING_KIND`), credentials (`SLACK_BOT_TOKEN`,
  `SLACK_DEFAULT_CHANNEL` as channel ID).
- **VCS:** adapter kind (`VCS_KIND`), credentials (`GITHUB_TOKEN`, `GITHUB_REPO_OWNER`,
  `GITHUB_REPO_NAME`, `GITHUB_BASE_BRANCH`).
- **Agent:** Claude Code auth (`CLAUDE_CODE_OAUTH_TOKEN`), model (`CLAUDE_MODEL`, default
  `claude-opus-4-6`), developer mode (`DEVELOPER_MODE`).
- **Polling:** poll interval (`POLL_INTERVAL_MS`, default 5 min), stuck threshold
  (`STUCK_JOB_THRESHOLD_MS`, default `JOB_TIMEOUT_MS × 2`), max retries (`JOB_MAX_RETRIES`).
- **Board columns:** configurable column names (`COLUMN_AI`, `COLUMN_AI_REVIEW`, `COLUMN_BACKLOG`).
- **Infrastructure:** Postgres connection (`DATABASE_URL`), workflow engine Postgres
  (`WORKFLOW_POSTGRES_URL`).

If required config is missing or invalid, the service fails startup with a clear error.

## 7. Orchestration State Machine

### 7.1 Ticket Workflow States

1. `queued` — webhook received, job enqueued.
2. `implementing` — agent working on implementation + self-review.
3. `clarification_pending` — waiting for user answers, container torn down.
4. `awaiting_review` — PR created, container torn down, waiting for human.
5. `fixing_feedback` — agent fixing review comments + self-review + conflict resolution + CI.
6. `completed` — PR ready for human final approval.
7. `failed` — unrecoverable failure.

### 7.2 Transitions

```text
queued → implementing                    (sandbox spun up, branch created)
implementing → clarification_pending     (agent needs answers, sandbox torn down)
implementing → awaiting_review           (PR created, sandbox torn down)
implementing → failed                    (unrecoverable error)
clarification_pending → queued           (user answers, moves ticket back to AI column)
awaiting_review → queued                 (human moves ticket back to AI column for fixes)
queued → fixing_feedback                 (sandbox spun up for review-fix workflow)
fixing_feedback → awaiting_review        (fixes done, re-review)
fixing_feedback → failed                 (unrecoverable error)
failed → queued                          (ticket moved back to AI column, or polling retry)
any → failed                             (max retries exhausted, or contradicting webhook)
```

Note: `clarification_pending` and `awaiting_review` first transition through `queued` before
reaching `implementing` or `fixing_feedback` — the webhook handler sets `queued`, then starts
the workflow which transitions to the active state.

### 7.3 Sandbox Lifecycle

Sandboxes are alive only during `implementing` and `fixing_feedback`. Torn down on every other
transition. On service startup, orphaned sandboxes from previous runs are cleaned up.

### 7.4 Retry Strategy

- Retries are driven by the **maintenance polling loop**, not by built-in queue backoff.
- The polling loop (`maintenanceLoop` workflow) runs every `POLL_INTERVAL_MS` (default 5 min) and
  detects failed or stuck tickets.
- Failed tickets still in the AI column are re-enqueued automatically.
- Stuck tickets (past `STUCK_JOB_THRESHOLD_MS`) are cancelled, marked `timed_out`, and re-enqueued.
- Total attempts are counted via `run_attempts` rows — after `JOB_MAX_RETRIES + 1` total attempts,
  the ticket transitions to `failed` permanently.
- Notifications are sent when a stuck job is recovered or retries are exhausted.

## 8. Event Handling and Job Dispatch

### 8.1 Trigger Events

1. **Ticket moved to AI column** → check workflow state in DB:
   - No record → first time, insert ticket row, start `implementation` workflow.
   - `clarification_pending` → set `queued`, start `implementation` workflow.
   - `awaiting_review` → set `queued`, start `review_fix` workflow.
   - `failed` → set `queued`, start `implementation` workflow (retry).
   - `queued` or `implementing` → **ignore** (duplicate webhook).
2. **Ticket moved out of AI column** (from AI or AI Review) → cancel active workflow run, tear
   down sandbox, set ticket to `failed`.
   - Self-transitions are ignored: `awaiting_review` → AI Review and
     `clarification_pending` → Backlog are recognized as Blazebot-initiated moves and skipped.

Blazebot-initiated transitions (not webhook triggers):

- → **AI Review** (`COLUMN_AI_REVIEW`) when PR is ready.
- → **Backlog** (`COLUMN_BACKLOG`) when clarification is needed.

### 8.2 Concurrency Control

- `MAX_CONCURRENT_AGENTS` — global limit on running sandboxes.
- Managed by the workflow framework.

### 8.3 Stale Job Protection

- **Layer 1 — Webhook cancellation:** On contradicting webhook (ticket moved out of AI), cancel
  the active workflow run via the workflow framework, tear down the sandbox, and mark the ticket
  `failed`.
- **Layer 2 — Job-start verification:** At workflow start, fetch current ticket state from
  tracker — silently skip (return null) if no longer in AI column.
- **Layer 3 — Polling fallback:** A durable `maintenanceLoop` workflow runs every
  `POLL_INTERVAL_MS` (default 5 min) performing two checks:
  - **Missed webhooks:** JQL search against tracker for tickets in AI column, cross-referenced
    with DB. Tickets not in DB are inserted and enqueued. Tickets in `failed` state are
    re-enqueued (respecting `JOB_MAX_RETRIES`).
  - **Stuck jobs:** Tickets in `queued`/`implementing`/`fixing_feedback` past
    `STUCK_JOB_THRESHOLD_MS` (default `JOB_TIMEOUT_MS × 2`) are recovered — workflow cancelled,
    sandbox torn down, run marked `timed_out`, new workflow started (respecting
    `JOB_MAX_RETRIES`). Stuck `fixing_feedback` tickets are re-enqueued as `review_fix`; others
    as `implementation`.

- All three layers combined eliminate race conditions, missed webhooks, and silently stuck jobs.

## 9. Sandbox Management

### 9.1 Sandbox Provider Interface

The sandbox is managed through a pluggable `SandboxProvider` interface:

```typescript
interface SandboxProvider {
  runSandbox(options: SandboxOptions): Promise<SandboxResult>;
  pushBranch(handle: string, branchName: string): Promise<{ pushed: boolean; output: string }>;
  teardown(handle: string): Promise<void>;
  cleanupOrphans(): Promise<void>;
}
```

Two providers are implemented:

- **Vercel Sandbox** (`@vercel/sandbox`) — currently active. Creates cloud sandboxes with
  configurable vCPUs, git source cloning, and managed timeouts.
- **Docker** (`dockerode`) — available in `docker/sandbox/` with full Dockerfile, entrypoint, and
  guard scripts. Currently disabled in the provider factory but fully functional.

### 9.2 Sandbox Setup

#### Vercel Provider

1. Creates a sandbox via `Sandbox.create()` with git source (shallow clone at feature branch).
2. Runtime: `node22`, configurable vCPUs (`VERCEL_SANDBOX_VCPUS`, default 2).
3. Environment injected: `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_MODEL`, `GITHUB_TOKEN`.
4. Writes `requirements.md` into the sandbox filesystem.
5. Installs Claude Code CLI globally: `npm install -g @anthropic-ai/claude-code`.
6. Runs the agent (see Section 10).
7. After agent completion, pushes via `git push origin HEAD:<branchName>` inside the sandbox.
8. Stops the sandbox.

#### Docker Provider

1. Creates a container from a pre-built image (`blazebot-sandbox`, based on `node:20-slim`).
2. Mounts a temp directory with `requirements.md` as read-only at `/inject`.
3. Entrypoint (`entrypoint.sh`) clones the repo, checks out the branch, copies requirements,
   and launches Claude Code CLI.
4. Git guard script (`git-guard.sh`) overrides the `git` binary to block `checkout`, `switch`,
   and `push` — all other git operations pass through to `/usr/bin/git`.
5. Claude Code Stop hook (`commit-guard.sh`) blocks the agent from finishing if there are
   uncommitted changes — forces the agent to commit or discard before exiting.
6. Push is done after agent completion by committing the stopped container to an image and
   running a new container that executes `git push`.
7. Container memory limit configurable via `SANDBOX_MEMORY_MB` (default 4096 MB).

### 9.3 Context Assembly per Run Type

- **`implementation`**: ticket content (fetched fresh, including all comments) +
  `packages/app/prompts/implement.md`.
- **`review_fix`**: ticket content (fetched fresh, including all comments), PR review comments
  (separated into "liked" from approved reviews vs. other comments), conflict info if applicable,
  and `packages/app/prompts/review-fix.md`.

### 9.4 Teardown

Sandbox is destroyed after every run — no sandbox survives between workflow states. On service
startup, the `orphan-cleanup` plugin calls `provider.cleanupOrphans()` to stop any stale sandboxes
from previous runs.

### 9.5 Safety Invariants

- Agent Git permissions scoped to its feature branch only.
- Sandbox is isolated — no access to production infrastructure or other sandboxes.
- Docker provider: agent runs as non-root user (`kasin-it`), git operations restricted by guard
  scripts.
- Vercel provider: sandbox has `GITHUB_TOKEN` for push; orchestrator creates the branch before
  sandbox spin-up via VCS adapter.

## 10. Agent Runner

### 10.1 Launch

The agent is launched inside the sandbox as the Claude Code CLI:

```bash
claude --print --output-format json --json-schema '<schema>' \
  --model "$CLAUDE_MODEL" --dangerously-skip-permissions < requirements.md
```

- `requirements.md` is piped to stdin.
- `--output-format json` with `--json-schema` enforces structured output.
- `--dangerously-skip-permissions` allows the agent to run without interactive permission prompts.
- Agent stdout is not logged — it may contain client code and confidential ticket data. Only
  anonymized, structured events (start, exit code, duration) are logged.
- Timeout enforced via sandbox provider (`JOB_TIMEOUT_MS`, default 10 min).
- Docker provider also supports `DEVELOPER_MODE` — uses `--output-format stream-json --verbose`
  piped through `format-stream.sh` for human-readable real-time output.

### 10.2 Agent Signals

The agent returns structured output via Claude Code's JSON schema enforcement. The orchestrator
parses the response from stdout — no marker file needed.

Claude Code wraps the structured output in an envelope:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "...",
  "structured_output": { ... }
}
```

The parser (`parseAgentOutput`) scans stdout lines bottom-up for JSON, checking
`structured_output.result` first, falling back to the envelope `result` field for older Claude Code
versions.

Schema:

- `result` — `implemented` | `clarification_needed` | `failed`.
- `summary` — description of work done (used for PR description, when `implemented`).
- `questions` — list of questions to post on the ticket (when `clarification_needed`).
- `error` — failure details (when `failed`).

If the agent returns no valid structured JSON output, the run is treated as failed.

### 10.3 Orchestrator Response to Result

- `implemented` → push branch, create PR (if implementation) or just push (if review_fix), move
  ticket to AI Review, tear down sandbox, notify user.
- `failed` → tear down sandbox, mark run and ticket as failed, throw error.
- `clarification_needed` → push WIP (optional), post questions on ticket, move ticket to Backlog,
  tear down sandbox, notify user.

If push fails after `implemented`, the run is treated as failed (agent may not have committed code).

If PR creation fails with "No commits between branches" (422), the error is treated as fatal
(non-retryable) — the agent reported success but didn't actually commit anything.

### 10.4 Responsibilities Split

Agent (inside sandbox):

- Writes code.
- Runs tests.
- Commits locally to feature branch.
- Merges target branch and resolves conflicts (in review-fix runs).
- Commits WIP on clarification.

Orchestrator (outside sandbox):

- Creates feature branches (via VCS adapter, before sandbox spin-up).
- Pushes feature branch after agent run completes (via sandbox provider).
- Creates PRs (via VCS adapter).
- Moves tickets between columns.
- Posts clarification questions on ticket.
- Sends notifications.
- Tears down sandboxes.

## 11. Adapter Interfaces

### 11.1 Issue Tracker Adapter

```typescript
interface TicketAdapter {
  fetchTicket(id: string): Promise<Ticket>;
  moveTicket(id: string, column: string): Promise<void>;
  postComment(id: string, comment: string): Promise<void>;
  parseWebhook(req: unknown): NormalizedEvent | null;
  searchTickets?(query: string): Promise<string[]>;  // optional, used by polling
}

interface Ticket {
  externalId: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string | null;
  comments: TicketComment[];
  labels: string[];
  trackerStatus: string;
}
```

Jira implementation uses Basic Auth (email + API token), Zod schema validation for webhook parsing,
and ADF (Atlassian Document Format) for posting comments.

### 11.2 VCS Adapter

```typescript
interface VCSAdapter {
  createBranch(repoOwner: string, repoName: string, branchName: string, baseBranch: string): Promise<void>;
  createPR(repoOwner: string, repoName: string, title: string, body: string, head: string, base: string): Promise<PullRequest>;
  getPRComments(repoOwner: string, repoName: string, prNumber: number): Promise<PullRequestComment[]>;
  getPRConflictStatus(repoOwner: string, repoName: string, prNumber: number): Promise<boolean>;
}

interface PullRequestComment {
  author: string;
  body: string;
  path: string | null;      // file path for inline comments
  line: number | null;       // line number for inline comments
  fromApprovedReview: boolean;  // true if from an approved review
}
```

GitHub implementation uses Octokit. `getPRComments` fetches three sources: inline review comments,
general PR conversation comments, and review body text. `createPR` handles 422 conflicts (existing
PR on same branch) by returning the existing PR.

**Empty repository handling:** `createBranch` must handle the case where the target repository has
no commits. GitHub's Git API returns a 409 ("Git Repository is empty") when attempting to read refs
from an empty repo. When this occurs, the adapter seeds the repository with an initial commit
(README.md) using the Contents API (`repos.createOrUpdateFileContents`), then uses the resulting
commit SHA as the base for branch creation.

### 11.3 Messaging Adapter

Backed by ChatSDK (`chat` package). The `MessagingAdapter` interface wraps a ChatSDK `Chat`
instance and delegates to `channel.post()`. Platform adapters (Slack, Discord, Teams) are
configured via `createSlackAdapter()` etc. and passed to the `Chat` constructor.

```typescript
interface MessagingAdapter {
  notify(userId: string, message: string): Promise<void>;
  ping(userId: string, message: string): Promise<void>;
}
```

Three implementations exist:

- `ChatSDKMessagingAdapter` — production, uses `@chat-adapter/slack` + `chat` SDK.
- `NoopMessagingAdapter` — returned when Slack credentials are missing.
- `ConsoleMessagingAdapter` — logs to stdout (development).

A factory (`createMessagingAdapter`) selects the implementation based on `MESSAGING_KIND` and
available credentials.

### 11.4 Normalized Webhook Event

All tracker webhooks normalize to:

```typescript
interface NormalizedEvent {
  type: "ticket_moved";
  ticketId: string;
  fromColumn: string;
  toColumn: string;
  triggeredBy: string;
  triggeredByAccountId: string;
}
```

The Jira webhook parser uses Zod to validate the incoming payload and extracts status changes from
the changelog. Non-status-change webhooks return `null` and are silently discarded.

The orchestrator only works with normalized events — never raw webhook payloads.

### 11.5 Adapter Registration

- Active adapters configured via env (`ISSUE_TRACKER_KIND`, `MESSAGING_KIND`, `VCS_KIND`).
- Each adapter registers its webhook route on startup.
- Swapping an adapter is a single-module replacement with no changes to core logic.

## 12. Context Assembly

The orchestrator builds `requirements.md` in memory (`packages/app/src/context.ts`) and writes it
into the sandbox before the agent starts. The format is fixed.

For `implementation` runs:

```markdown
# Requirements

## Ticket
{ticket title}

## Description
{ticket description}

## Acceptance Criteria
{acceptance criteria, if present}

## Comments
**{author}** ({ISO timestamp}):
{comment body}
...

---
{contents of packages/app/prompts/implement.md}
```

For `review_fix` runs:

```markdown
# Requirements

## Ticket
{ticket title}

## Description
{ticket description}

## Acceptance Criteria
{acceptance criteria, if present}

## Comments
**{author}** ({ISO timestamp}):
{comment body}
...

## PR Review Feedback

### Liked Comments
**{author}** (`path:line`):
{comment body}

### Other Comments
**{author}** (`path:line`):
{comment body}

## Merge Conflicts
This PR has merge conflicts with the target branch. Merge the target branch and resolve all
conflicts before addressing review feedback.

---
{contents of packages/app/prompts/review-fix.md}
```

The "Liked Comments" / "Other Comments" subheadings only appear when both categories have comments.
The "Acceptance Criteria", "Comments", "PR Review Feedback", and "Merge Conflicts" sections are
omitted if empty.

If rendering fails (missing prompt file, tracker API error), the run fails immediately.

## 13. Observability

### 13.1 Log Context

Every log entry for a ticket-related action includes:

- `ticket_id`
- `ticket_identifier`
- `run_attempt_id` (when applicable)

### 13.2 Key Events to Log

Orchestrator events:

- Webhook received (ticket, event type, triggered by).
- Job enqueued (ticket, run type).
- Job started / completed / failed.
- Ticket state transition (from → to).
- Container spin-up / teardown.
- Retry scheduled (attempt number, reason).

Agent events:

- Agent launched (container ID, run type).
- Agent exited (exit code, duration).
- Clarification requested (no question content — only the event itself).

No client-specific content (ticket data, code, questions) may appear in logs.

Adapter events:

- PR created.
- Comment posted on ticket.
- Notification sent.
- Webhook validation failure.

### 13.3 Log Format

Structured JSON logs to stdout via Pino. Deployment decides where they go (file, log aggregator,
etc.). Log level configurable via `LOG_LEVEL` env var.

### 13.4 Deferred

- Dashboard / status UI.
- Metrics / alerting.
- Token usage tracking.

## 14. Failure Model and Recovery

### 14.1 Failure Classes

1. **Webhook/Ingestion Failures** — invalid payload, HMAC validation failure, tracker API down.
2. **Sandbox Failures** — sandbox won't start, Vercel API error, Docker container failure.
3. **Agent Failures** — timeout, crash, invalid structured output, no commits produced.
4. **Adapter Failures** — VCS API down (can't create PR), messaging down (can't notify), tracker
   down (can't move ticket).
5. **Infrastructure Failures** — Postgres down, workflow engine unavailable.

### 14.2 Recovery Behavior

| Failure | Recovery |
| ------- | -------- |
| Webhook invalid | Log and discard, return 400/401 |
| Tracker API down during context fetch | Workflow step fails, detected by polling |
| Empty repository (no commits) | VCS adapter seeds repo with initial commit, then creates branch |
| Sandbox won't start | Workflow fails, detected and retried by polling |
| Agent timeout/crash | Workflow fails, detected and retried by polling |
| Agent clarification | Not a failure — normal flow |
| No commits on branch (422) | Fatal error — non-retryable (`FatalError`) |
| Can't create PR | Workflow fails, retried by polling |
| Can't move ticket | Log warning |
| Can't send notification | Log warning, don't block workflow |
| Postgres down | Service unhealthy, workflows stall until recovery |
| Max retries exhausted | Ticket → `failed`, notify user |

Notifications are best-effort — never block the workflow.

### 14.3 Recovery After Service Restart

- Postgres is the single source of truth for orchestration state.
- On restart, the workflow engine (`@workflow/world-postgres`) recovers in-flight workflows from
  Postgres.
- No filesystem-based recovery needed.
- Active sandboxes from the previous process may be orphaned — the `orphan-cleanup` plugin detects
  and stops stale sandboxes on startup.

## 15. Security and Operational Safety

### 15.1 Sandbox Isolation

- Each agent runs in an isolated sandbox (Vercel Sandbox or Docker container).
- Docker provider: agent process runs as a non-root user (`kasin-it`) inside the container.
- No access to production infrastructure or other sandboxes.

### 15.2 Git Permission Scoping

**Docker provider:**

- Agent can only commit locally — `git push` is blocked by `git-guard.sh` which overrides the
  `git` binary at `/usr/local/bin/git`. `checkout` and `switch` are also blocked.
- Orchestrator pushes the feature branch after the agent run completes (via commit + new container).
- Claude Code `Stop` hook (`commit-guard.sh`): if `git status --porcelain` shows uncommitted
  changes, exit with code 2 to block the stop and feed instructions back to the agent. On the
  second pass (when `stop_hook_active` is set), allow exit. This ensures no work is silently lost.

**Vercel provider:**

- Agent has `GITHUB_TOKEN` in the sandbox environment (needed for Claude Code operations).
- Push is performed by the orchestrator via `sandbox.runCommand("git", ["push", ...])` after the
  agent completes — the agent itself does not push.
- Branch creation is done by the orchestrator via VCS adapter before sandbox spin-up.

### 15.3 Secret Handling

- Tracker API keys, VCS tokens, messaging credentials stored as env vars.
- Never logged or exposed to the agent.
- Agent receives only the scoped Git credentials it needs.

### 15.4 Network Access

- Agent has full internet access inside the container.
- No restrictions on outbound traffic.
- All outbound network traffic from the container is logged (destination, port, bytes) for
  visibility. Logs must not capture request/response content — only connection metadata.

## 16. Reference Algorithms

### 16.1 Webhook Reception

```pseudocode
on_webhook(req):
  rawBody = readRawBody(req)
  if !verifyHMAC(rawBody, req.headers["x-hub-signature"], JIRA_WEBHOOK_SECRET):
    return 401

  event = parseJiraWebhook(JSON.parse(rawBody))
  if event is null: return { ok: true }  // not a status change

  routeTicketTransition(event)
  return { ok: true }

routeTicketTransition(event):
  if normalize(event.toColumn) == normalize(COLUMN_AI):
    handleMovedToAi(event)
  else if normalize(event.fromColumn) is AI-related:
    handleMovedOutOfAi(event)

handleMovedToAi(event):
  ticket = db.findTicket(event.ticketId, source="jira")

  if ticket is null:
    created = db.insertTicket(event.ticketId, state="queued")
    startWorkflowRun(type="implementation", workflow=implementTicket, dedupeId="impl-{id}-{rowId}")

  else if ticket.workflowState == "clarification_pending":
    db.updateState(ticket, "queued")
    startWorkflowRun(type="implementation", workflow=implementTicket)

  else if ticket.workflowState == "awaiting_review":
    db.updateState(ticket, "queued")
    startWorkflowRun(type="review_fix", workflow=reviewFixTicket)

  else if ticket.workflowState == "failed":
    db.updateState(ticket, "queued")
    startWorkflowRun(type="implementation", workflow=implementTicket)

  else if ticket.workflowState in ["queued", "implementing"]:
    // Duplicate webhook — ignore

handleMovedOutOfAi(event):
  ticket = db.findTicket(event.ticketId, source="jira")
  if ticket is null: return

  // Ignore self-transitions (Blazebot moved the ticket itself)
  if ticket.workflowState == "awaiting_review" and event.toColumn == COLUMN_AI_REVIEW: return
  if ticket.workflowState == "clarification_pending" and event.toColumn == COLUMN_BACKLOG: return

  if ticket.currentRunId:
    cancelWorkflowRun(ticket.currentRunId)  // cancel workflow + teardown sandbox

  db.updateState(ticket, "failed")
```

### 16.2 Workflow Execution (Implementation)

```pseudocode
implementTicket(ticketId, source, triggeredBy, runAttemptId):
  "use workflow"

  ticket = fetchAndValidateTicket(ticketId)  // "use step"
  if ticket is null: return  // stale job — ticket no longer in AI column

  branchName = "blazebot/{ticketId}"
  setupBranch(ticketId, branchName, runAttemptId)  // create branch, set "implementing"

  result = executeSandbox(ticketId, branchName, ticket)  // "use step" — runs agent
  if result.containerId: recordContainerId(runAttemptId, result.containerId)

  if result.status == "complete":
    pushResult = pushAndTeardown(result.containerId, branchName)
    if !pushResult.pushed: finalizeFailure(...); throw
    pr = createPullRequest(ticketId, ticket.title, branchName, result.summary)
    finalizeSuccess(ticketId, runAttemptId, branchName, pr)
    // → workflowState: "awaiting_review", moveTicket → COLUMN_AI_REVIEW, notify

  else if result.status == "clarification_needed":
    pushAndTeardown(result.containerId, branchName)  // push WIP
    finalizeClarification(ticketId, runAttemptId, branchName, result.questions)
    // → postComment, workflowState: "clarification_pending", moveTicket → COLUMN_BACKLOG, notify

  else:  // "failed"
    teardown(result.containerId)
    finalizeFailure(ticketId, runAttemptId, result.error)
    throw Error  // workflow fails
```

### 16.3 Workflow Execution (Fixing Feedback)

```pseudocode
reviewFixTicket(ticketId, source, triggeredBy, runAttemptId):
  "use workflow"

  validation = validateReviewFix(ticketId, runAttemptId)  // "use step"
  if validation is null: return  // stale job
  // validation checks: ticket in AI column, has prId and branchName
  // → workflowState: "fixing_feedback", run status: "running"

  result = executeFixSandbox(ticketId, validation.branchName, validation.prNumber)
  // fetches ticket, PR comments, conflict status, assembles context, runs agent

  if result.containerId: recordContainerId(runAttemptId, result.containerId)

  if result.status == "complete":
    pushAndTeardown(result.containerId, validation.branchName)
    finalizeFixSuccess(ticketId, runAttemptId)
    // → workflowState: "awaiting_review", moveTicket → COLUMN_AI_REVIEW, notify

  else:
    teardown(result.containerId)
    finalizeFixFailure(ticketId, runAttemptId, result.error)
    throw Error
```

## 17. Test and Validation Matrix

### 17.1 Orchestration

- Webhook with ticket moved to AI → starts implementation workflow.
- Webhook with ticket moved to AI (from `clarification_pending`) → starts implementation workflow.
- Webhook with ticket moved to AI (from `awaiting_review`) → starts review_fix workflow.
- Webhook with ticket moved to AI (from `failed`) → starts implementation workflow (retry).
- Webhook with ticket already `queued`/`implementing` → duplicate ignored.
- Webhook with ticket moved out of AI → cancels active workflow, tears down sandbox, marks failed.
- Self-transitions (awaiting_review → AI Review, clarification_pending → Backlog) → ignored.
- Stale job protection — workflow skipped if ticket no longer in AI at start.
- Max retries exhausted → ticket transitions to `failed`, user notified.
- Polling fallback — discovers tickets in AI column missed by webhooks.
- Polling fallback — detects stuck jobs past threshold, cancels workflow, re-enqueues or fails.
- Polling fallback — respects retry limits on stuck job recovery (`JOB_MAX_RETRIES + 1` attempts).

### 17.2 Sandbox Management

- Sandbox created with correct branch and `requirements.md`.
- Sandbox torn down after every run (success, failure, clarification).
- Orphaned sandboxes cleaned up on service startup.
- Push fails → run treated as failure.

### 17.3 Agent Runner

- Structured output `implemented` → push, PR created, ticket moved to AI Review.
- Structured output `failed` → sandbox torn down, ticket marked failed.
- Structured output `clarification_needed` → push WIP, questions posted, ticket moved to Backlog.
- No valid structured output → run treated as failed.
- Timeout enforced by sandbox provider (`JOB_TIMEOUT_MS`).

### 17.4 Adapter Interfaces

- Each adapter implementation satisfies its interface contract.
- Webhook parsing returns normalized events.
- Invalid webhooks return 400, don't enqueue work.
- Adapter failures trigger retries (except notifications — best effort).
- VCS `createBranch` on empty repo (409) → seeds repo with initial commit, then creates branch.
- VCS `createBranch` on empty repo with seed failure → wraps error with repository context.
- VCS `createBranch` non-409 errors from `getRef` → propagated unchanged.

### 17.5 Context Assembly

- Implementation context includes full ticket content + all comments + prompt file.
- Fixing feedback context includes ticket content, PR comments (liked vs. other), conflict info,
  and prompt file.
- Missing prompt file fails the run immediately.

### 17.6 Workflow State Machine

- All transitions from Section 7.2 are tested.
- No invalid transitions possible.
- Recovery from restart — Postgres state drives correct behavior.

### 17.7 Integration (Recommended)

- End-to-end: ticket moved to AI → implementation → PR created → review fix → completed.
- Clarification flow: implementation → clarification → resume → PR created.
- Real tracker webhook validation with credentials.

## 18. Implementation Checklist

### 18.1 Required for MVP

- [x] Webhook receiver with HMAC validation (Nitro + `x-hub-signature`).
- [x] Issue Tracker adapter (Jira — fetch, move, comment, search, webhook parsing).
- [x] VCS adapter (GitHub — branch, PR, comments, conflict status, empty repo handling).
- [x] Messaging adapter (Slack via ChatSDK, with noop fallback).
- [x] Orchestrator — webhook router + workflow helpers with state machine.
- [x] Durable workflow execution for `implementation` and `review_fix` (`workflow/api` +
  `@workflow/world-postgres`).
- [x] Sandbox Provider — Vercel Sandbox (active) + Docker (available).
- [x] Agent Runner — Claude Code CLI, structured JSON output parsing, schema validation.
- [x] Context assembly — `requirements.md` generation with ticket + PR comments + prompts.
- [x] Persistence — Drizzle + Postgres schema for tickets and run attempts.
- [x] Stale job protection (cancel on contradicting webhook + verify at job start + polling
  fallback).
- [x] Concurrency control via `MAX_CONCURRENT_AGENTS`.
- [x] Structured JSON logging with ticket/run context (Pino).
- [x] Prompt files — `packages/app/prompts/implement.md` and `packages/app/prompts/review-fix.md`.
- [x] Orphan sandbox cleanup on startup.
- [x] Webhook deduplication (ignore duplicate events for queued/implementing tickets).

### 18.2 Deferred

- [ ] Model routing (per-ticket model selection).
- [ ] Hot config reload.
- [ ] Token usage tracking.
- [ ] Admin panel / dashboard (scope TBD — open question around exposing cost data to clients).
- [ ] Metrics / alerting.
- [ ] Additional tracker adapters (Linear, Asana).
- [ ] Additional messaging adapters (Teams, Discord) — available via ChatSDK `@chat-adapter/*` packages, needs config/env wiring.
- [ ] Additional VCS adapters (GitLab).
- [ ] Per-user notifications (requires Jira→Slack user mapping).
- [ ] Per-ticket token/cost limit — kill agent run when token budget exceeded.
- [ ] Evaluator loop — two possible approaches:
  - Full: split work into chunks → generator completes chunk → evaluator checks → fix chunk →
    generator completes next chunk.
  - Light: soft timeout per chunk (X min). If agent is still running after X min, interrupt and
    force a summary (what was done, is it stuck, what it's working on). Evaluator decides whether
    to continue, retry, or abort.
- [ ] Complexity-aware timeouts — adjust timeout based on ticket complexity instead of one generic
  `JOB_TIMEOUT_MS` for all tickets.
- [ ] Subtickety — oneToMany ticket→subtask relationship for breaking down complex tickets into
  smaller agent runs.
- [ ] Self-improvement feedback loop — agents report feedback to a shared endpoint, stored in
  Postgres. PR review comments and corrections are captured so agents don't repeat the same
  mistakes across runs.
- [ ] Network egress controls — web searches from containers can leak sensitive data. MVP logs
  connection metadata only. Future: evaluate allowlists, proxy, or content filtering for outbound
  traffic.
- [ ] Tool support (Figma, Notion, attachments) — structured access to rich ticket content
  (screenshots, Figma links, Notion docs) with per-client tool adapter config.
- [ ] Similar ticket search — query issue tracker for related/past tickets during context assembly
  to learn from prior solutions and avoid duplicate work.
- [ ] Agent personas (designer, architect, reviewer, etc.) — specialized prompts, models, and
  constraints per role. Ties into model routing for per-persona model selection.
- [ ] Infrastructure & observability access (brainstorm) — agents accessing DB migrations,
  Datadog, Sentry, etc. for richer context. Needs careful scoping: read-only vs write access,
  credential management, isolation trade-offs. Agent should write migration code but not run it
  against real infrastructure.
- [ ] Monorepo structure — reorganize the repo into a well-structured monorepo with clear package
  boundaries.
