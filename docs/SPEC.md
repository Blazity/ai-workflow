# Blazebot Service Specification

Status: v3 — revised 2026-07-07 to match the implementation. v2 described the pre-Postgres,
single-repo, GitHub-only MVP design; this revision documents the system as built. Where v2 design
intents were never implemented, they are listed under Deferred (Section 18.2), not removed.

Purpose: Define a workflow-driven automation service that dispatches issue-tracker tickets assigned
to AI, implements them end-to-end inside isolated Vercel Sandboxes, and delivers merge-ready pull
requests for human approval.

## 1. Problem Statement

Blazebot is a workflow-driven automation service that discovers tickets assigned to AI (via Jira
webhook or a cron poller), implements features end-to-end inside isolated Vercel Sandboxes, and
delivers merge-ready pull requests for human approval.

The service solves four operational problems:

- It turns ticket implementation into a fully automated pipeline — from assignment through
  research/planning, implementation, optional self-review, and PR delivery — without manual
  intervention.
- It isolates agent execution in per-ticket Vercel Sandboxes so agent commands cannot affect
  production infrastructure or other tickets.
- It manages ticket lifecycle directly — moving tickets between columns, posting clarification
  questions, and notifying users — as first-class service behavior.
- It closes the review loop: when a ticket with an existing workflow-owned PR/MR re-enters the AI
  column, the same workflow re-runs with the PR's review comments, CI check results, and conflict
  status folded into the agent's context.

Important boundary:

- Blazebot owns the full lifecycle from ticket pickup to merge-ready PR.
- The coding agent inside the sandbox focuses on implementation — it does not manage ticket state,
  PR creation, or review coordination.
- Humans give final approval. A separate post-PR gate workflow (Section 16) runs configurable
  checks against each workflow-owned PR after creation.

## 2. Goals and Non-Goals

### 2.1 Goals

- Accept Jira webhooks for real-time ticket dispatch and cancellation, with a Vercel Cron poller
  (every minute) as the fallback discovery path.
- Use Vercel Workflows as the durable orchestration layer — workflow state survives failures,
  restarts, and redeploys.
- Persist operational state (run registry, branch/PR ownership, telemetry, gate state, auth) in
  Postgres (Neon); ticket content is always fetched fresh from the tracker.
- Spin up one isolated Vercel Sandbox per run; sandboxes never survive between runs.
- Support multi-repository tickets — a pre-sandbox selection step chooses which repositories a run
  may edit, and the run pushes and opens PRs/MRs per changed repository.
- Support two coding agents behind one interface — Claude Code (default) and OpenAI Codex CLI —
  selectable globally (`AGENT_KIND`) and per ticket (`agent:codex` / `agent:claude` labels).
- Support GitHub (App auth) and GitLab, including both configured simultaneously with
  mixed-provider repository selection.
- Run the agent in phases (research/plan → implementation → optional review) with structured JSON
  output contracts per phase.
- Manage ticket transitions directly: → **AI Review** when the PR is ready, → **Backlog** when
  clarification is needed or the run fails.
- Notify the team in Slack — a live-status parent message plus a threaded audit log per ticket, a
  token/cost usage report per run, and an `/ai-workflow` slash command for status and control.
- Support adapter modularity — issue tracker, VCS, and messaging sit behind interfaces so swapping
  e.g. Jira → Linear is a single-module replacement.
- Design for self-hosting — users provide their own API keys (issue tracker, VCS, messaging, AI
  model) and deploy onto their own Vercel account. The project is intended to be open source.
- Provide an observability dashboard (separate Next.js app) with runs, KPIs, cost & usage, eval
  health, the prompt library, and user administration, authenticated against the worker.

### 2.2 Non-Goals

- Rich multi-tenant control plane or SaaS UI.
- General-purpose CI/CD or workflow engine.
- Replacing human final approval on PRs.
- Built-in IDE or code editor.

## 3. System Overview

### 3.1 Main Components

All paths below are relative to `apps/worker/src/` unless stated otherwise.

1. **Poller** (Vercel Cron — `routes/cron/poll.get.ts`)
   - Fired every minute by the Vercel cron in `apps/worker/vercel.json` (`* * * * *`), authenticated
     with `CRON_SECRET`. (`POLL_INTERVAL_MS` still exists in config but does not drive scheduling.)
   - Queries the issue tracker for tickets in the AI column and dispatches each via the shared
     `dispatchTicket` path.
   - Runs the reconciler (Section 8.5) and snapshots run telemetry on every cycle.

2. **Jira Webhook Endpoint** (`POST /webhooks/jira` — `routes/webhooks/jira.post.ts`)
   - Receives `jira:issue_updated` events in real time; verifies an HMAC signature
     (`x-hub-signature`, `JIRA_WEBHOOK_SECRET`); filters by `JIRA_PROJECT_KEY`.
   - Status change **into** the AI column → `dispatchTicket` (same path as the poller).
   - Status change **out of** the AI column → re-checks the live ticket (guards against stale
     payloads), then cancels the active workflow run and unregisters it. A `claiming:` sentinel is
     fast-path cleaned (sandbox stopped, claim cleared) without waiting for the reconciler.

3. **Issue Tracker Adapter** (`adapters/issue-tracker/jira.ts`)
   - `fetchTicket`, `moveTicket` (by column name or configured transition id), `postComment`,
     `searchTickets` (JQL), `downloadAttachment`, `updateLabels`.
   - Transitions can be pinned with `JIRA_BACKLOG_TRANSITION_ID` / `JIRA_AI_REVIEW_TRANSITION_ID`
     (recommended when Jira localizes transition names).

4. **Messaging Adapter** (`adapters/messaging/chatsdk.ts`)
   - Built on the [`vercel/chat`](https://github.com/vercel/chat) abstraction (`chat` +
     `@chat-adapter/slack`). Slack is the only wired adapter; Teams is not supported.
   - Maintains a live-status parent message per ticket with a threaded audit log, and attaches a
     token/cost usage report to `pr_ready` notifications.
   - Optional — when `CHAT_SDK_SLACK_TOKEN` / `CHAT_SDK_CHANNEL_ID` are unset a no-op adapter is
     used.
   - A separate Slack slash command `/ai-workflow` (`routes/webhooks/slack.post.ts`, signature
     verified via `SLACK_SIGNING_SECRET`, allow-listed via `SLACK_ALLOWED_USER_IDS`) supports
     `help`, `list`, `status <KEY>`, `cancel <KEY>`, and registry-inspection subcommands.

5. **VCS Adapters** (`adapters/vcs/github.ts`, `adapters/vcs/gitlab.ts`)
   - GitHub via Octokit with **GitHub App auth** (installation tokens, bot commit identity);
     GitLab via `@gitbeaker/rest`. Both may be configured at once.
   - Branch creation (with empty-repository seeding), PR/MR creation and lookup, PR comments,
     CI check-run results, conflict status, PR file lists, and gate check-run/commit-status
     reporting.

6. **Orchestrator** (`workflows/agent.ts` — the single durable `agentWorkflow`)
   - One workflow handles both fresh tickets and review-fix re-runs; branching happens at
     context-assembly time based on workflow-owned PR records, not at dispatch time.
   - Runs the phase pipeline (Section 7) with Vercel Workflow retry/durability semantics.
   - Verifies the ticket is still in the AI column at workflow start (stale job protection).

7. **Sandbox Manager** (`sandbox/manager.ts`, `sandbox/repo-workspace.ts`)
   - Provisions one Vercel Sandbox per run (Node 24) with the first selected repository at
     `/vercel/sandbox` and additional repositories under `/vercel/sandbox/repos/`.
   - Writes the workspace manifest (`/vercel/sandbox/aiw-repos.json`: per-repo local path, branch,
     pre-agent SHA), installs the agent CLI and skills, configures git identity, auth, and the
     optional Arthur tracer.
   - Tears the sandbox down after every run (in `finally`).

8. **Agent Runner** (`sandbox/agents/{claude,codex}.ts`)
   - Launches Claude Code or Codex CLI per phase via wrapper scripts; enforces structured JSON
     output via schema; signals completion with sentinel files (Section 10).

9. **Run Registry + Reconciler** (`adapters/run-registry/postgres.ts`, `lib/reconcile.ts`)
   - Postgres-backed atomic claims, run registration, sandbox pinning, failed-ticket markers; the
     reconciler cleans up stale claims, finished runs, and orphaned runs every poll (Section 8.5).

10. **Post-PR Gate** (`workflows/post-pr-gate.ts`, `post-pr-gate/`) — Section 16.

11. **Dashboard + Auth** (`apps/dashboard`, worker `auth.ts`, `routes/api/v1/*`) — Section 17.

12. **Observability** — structured Pino logs, durable per-run telemetry in Postgres
    (`workflow_runs`), optional Arthur (GenAI Engine) tracing and eval health (Section 13).

### 3.2 Abstraction Layers

1. **Adapter Layer** — issue tracker, messaging, VCS, run registry (all behind interfaces).
2. **Orchestration Layer** — Vercel Workflows for the agent run and the post-PR gate.
3. **Execution Layer** — sandbox lifecycle, agent runners, workspace push.
4. **Observability Layer** — logging, run telemetry, Arthur tracing/evals, dashboard.

### 3.3 External Dependencies

- Jira REST API (issue tracker).
- Slack (via `vercel/chat`).
- GitHub (App) and/or GitLab APIs.
- Vercel Workflows (durable orchestration), Vercel Sandbox (isolated execution), Vercel Cron.
- Neon Postgres (Vercel Marketplace integration; one branch per environment) — **required**.
- Anthropic API (Claude Code) and/or OpenAI (Codex CLI).
- Optional: Arthur GenAI Engine (tracing/evals/prompt-injection check), Resend (dashboard email).

Deferred: Linear, Teams, Docker sandbox provider (self-hosted without Vercel).

## 4. Core Domain Model

Durable workflow state lives inside the Vercel Workflow run; operational and audit state lives in
Postgres (Drizzle schema in `apps/worker/src/db/schema.ts`, migrations in `apps/worker/drizzle/`).
Ticket content (title, description, acceptance criteria, comments, labels) is always fetched fresh
from the tracker API — never stored.

Tables:

- `active_runs` — run registry: ticket key → workflow run id (or `claiming:{timestamp}` sentinel)
  plus pinned sandbox id.
- `failed_tickets` — failure markers so a ticket that couldn't be moved back to Backlog isn't
  re-picked until it leaves the AI column.
- `thread_parents` — Slack thread parent message per ticket.
- `workflow_owned_branches` — per-ticket, per-repository branch and PR/MR ownership records. This
  is the source of truth for "does this ticket already have a workflow-owned PR"; ownership is
  never inferred from unrelated open PRs.
- `workflow_runs` — durable run telemetry: status (`success` | `failed`), timing, agent/model, PR
  links, token/cost totals, per-phase usage, and the full step trace.
- `gate_locks`, `gate_dedupe`, `gate_current` — post-PR gate state (Section 16).
- `pre_pr_check_config_versions` — append-only dashboard-managed pre-PR check config (current =
  highest version).
- `env_marker` — guards against two environments sharing one Neon branch.
- Better Auth tables (`db/auth-schema.ts`) — users, sessions, organizations, invites.
- Email delivery tables (`db/email-delivery-schema.ts`) — Resend delivery tracking.

## 5. Agent Prompt Contract

Prompts are **not** files in the client repo. There are three named prompts — `research-plan`,
`implement`, and `review` — with fallback bodies hardcoded in `apps/worker/src/lib/prompts.ts`.

Resolution at run time (`workflows/prompts-step.ts`): the in-code default body for each named
prompt is used directly (the bodies are the single source of truth in `@shared/contracts`,
re-exported through `apps/worker/src/lib/prompts.ts`). Per-block prompt overrides authored in the
dashboard prompt library are applied elsewhere in the graph.

The resolved prompt body is appended to the assembled per-phase context (Section 12) and written
into the sandbox as that phase's input file. The agent also picks up repo-level instruction files
(`CLAUDE.md`, `AGENTS.md`) from the client's repository at runtime; Blazebot prompts provide
task-specific instructions only.

Contract highlights encoded in the prompts:

- Scope limits — modify only files relevant to the ticket, no drive-by refactoring.
- **PR review comments supersede the original acceptance criteria** when they conflict — this is
  the precedence rule for review-fix re-runs.
- Cross-run continuity — the agent must read and update a per-ticket memory file
  (`blazebot/memory/<TASK_ID>.md`) in the workspace so later runs inherit context.

The v2 `[OVERRIDE]` ticket-comment convention was never implemented and is listed as deferred.

## 6. Configuration

All runtime config lives in environment variables validated at startup with zod via
`@t3-oss/env-core` (`apps/worker/env.ts`), including cross-field rules (VCS provider completeness,
commit author+email set together, agent-kind key requirements, SSO all-or-none, Resend
dependencies). Missing or invalid required config fails startup with a clear error. The full
per-variable reference lives in `SETUP.md`; the groups are:

- **Issue tracker:** `ISSUE_TRACKER_KIND` (`jira`), `JIRA_BASE_URL`, `JIRA_API_TOKEN`,
  `JIRA_PROJECT_KEY`, `COLUMN_AI` / `COLUMN_AI_REVIEW` / `COLUMN_BACKLOG`, optional
  `JIRA_BACKLOG_TRANSITION_ID` / `JIRA_AI_REVIEW_TRANSITION_ID`, `JIRA_WEBHOOK_SECRET`.
- **VCS:** `VCS_KIND` (`github` | `gitlab`), GitHub App vars (`GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_BASE_BRANCH`), GitLab vars
  (`GITLAB_TOKEN`, `GITLAB_HOST`, `GITLAB_BASE_BRANCH`), per-provider webhook secrets. Legacy
  single-repo `GITHUB_OWNER`/`GITHUB_REPO` is still honored as a fallback.
- **Messaging:** `CHAT_SDK_SLACK_TOKEN`, `CHAT_SDK_CHANNEL_ID`, `CHAT_SDK_BOT_NAME` (default
  `blazebot`), `SLACK_SIGNING_SECRET`, `SLACK_ALLOWED_USER_IDS`. (There is no `CHAT_SDK_API_KEY`.)
- **Agent:** `AGENT_KIND` (`claude` default | `codex`), `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`
  (default `claude-opus-4-6`), `CODEX_API_KEY` / `CODEX_CHATGPT_OAUTH_TOKEN`, `CODEX_MODEL`
  (default `gpt-5-codex`), Codex pricing feed (`CODEX_PRICING_URL`, `CODEX_PRICING_TTL_MS`),
  `COMMIT_AUTHOR` / `COMMIT_EMAIL` (optional, no default — when unset the identity is derived from
  the GitHub App, or falls back to `ai-workflow-blazity` on GitLab).
- **Sandbox / limits:** `MAX_CONCURRENT_AGENTS` (default 3), `JOB_TIMEOUT_MS` (default 30 min),
  `ATTACHMENT_MAX_FILE_SIZE_MB` / `ATTACHMENT_MAX_TOTAL_SIZE_MB` / `ATTACHMENT_MAX_COUNT` /
  `ATTACHMENT_DOWNLOAD_TIMEOUT_MS`, `ENABLE_REVIEW_PHASE` (default `false`; shapes only the
  built-in default workflow definition, the review phase itself is gated by the `review_agent`
  block in the active definition). Pre-PR check commands are dashboard-managed (Section 9.3),
  not env config.
- **Arthur (optional):** `GENAI_ENGINE_API_KEY`, `GENAI_ENGINE_TRACE_ENDPOINT`.
- **Database:** `DATABASE_URL` (required; Neon via Vercel Marketplace).
- **Vercel / cron:** `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` (local dev only —
  OIDC on Vercel), `CRON_SECRET`.
- **Dashboard auth / email:** `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DASHBOARD_ORIGIN`,
  `DASHBOARD_AUTH_EMAIL` / `DASHBOARD_AUTH_PASSWORD` (required), `DASHBOARD_ORG_NAME` /
  `DASHBOARD_ORG_SLUG`, optional SSO group (`SSO_ISSUER`, `SSO_ALLOWED_DOMAIN`, `SSO_CLIENT_ID`,
  `SSO_CLIENT_SECRET` — all or none), optional Resend group (`RESEND_API_KEY`,
  `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`).

## 7. Orchestration

The v2 seven-state machine (`queued` … `fixing_feedback`) was never built. The actual lifecycle has
three layers:

### 7.1 Phases within a run

One `agentWorkflow` run executes sequential phases, each with a commit-guard setting, a poll cap,
and a structured output schema:

| Phase | Poll cap | Commit guard | Output schema |
|-------|----------|--------------|---------------|
| `research` (plan) | 20 min | off | `completed` \| `clarification_needed` \| `failed` |
| `impl` | 35 min | on | `implemented` \| `clarification_needed` \| `failed` + `summary` / `questions` / `error` |
| `review` (optional, `review_agent` block in the workflow definition) | 15 min | on | `approved` \| `failed` |
| pre-PR checks (optional, dashboard-configured) | — | — | pass \| fail after ≤3 agent fix cycles |
| push + PR | — | — | — |

### 7.2 Ticket transitions (Jira columns)

- → **AI Review** when the PR is ready (after the `pr_ready` notification).
- → **Backlog** when clarification is needed (questions posted as a numbered Jira comment, a
  `needs-clarification` label added and cleared on re-pick) or when a phase fails / times out.

### 7.3 Run outcome

Each run is recorded in `workflow_runs` with status `success` or `failed`, plus per-phase usage and
the step trace. Review-fix is not a separate state: moving a ticket with an existing workflow-owned
PR back into the AI column starts the same workflow, which folds PR feedback into the research
context.

### 7.4 Sandbox lifetime and retries

Sandboxes are alive only for the duration of a single workflow run and are always destroyed in
`finally`. Step-level retries use Vercel Workflow's built-in backoff; a run that exhausts its
options moves the ticket to Backlog and notifies the team.

## 8. Ticket Discovery and Job Dispatch

Both the poller and the webhook share `dispatchTicket` (`lib/dispatch.ts`).

### 8.1 Polling

The cron fires every minute (`vercel.json`), discovers AI-column tickets via JQL, dispatches each,
then reconciles (Section 8.5) and snapshots telemetry.

### 8.2 Jira Webhook

Real-time dispatch/cancellation as described in Section 3.1(2). The public route is disabled with
HTTP 503 when `JIRA_WEBHOOK_SECRET` is unset, leaving cron polling as the only ticket-ingestion
path. Configured webhooks require a valid signature. Events for other projects and non-status
changes are ignored.

### 8.3 Dispatch Logic (`dispatchTicket`)

1. Capacity precheck against `MAX_CONCURRENT_AGENTS`.
2. Atomic claim in the run registry — `INSERT … ON CONFLICT DO NOTHING` with a
   `claiming:{timestamp}` sentinel. Losing racers bail with `already_claimed`.
3. Post-claim fairness re-check (the precheck isn't atomic with the claim): concurrent claimers are
   ordered by claim timestamp and the excess release their claims with `at_capacity`.
4. Skip if the ticket carries a fresh failed-ticket marker.
5. Start `agentWorkflow` (always the same workflow — no separate review-fix workflow), then replace
   the sentinel with the real workflow run id.
6. Verify the claim still stands after start; abort the workflow if it was cancelled mid-flight.
7. On failure, release the claim so the ticket can be retried.

### 8.4 Stale Job Protection

- **Layer 1 — workflow-start verification:** the workflow re-fetches the ticket and aborts if it
  left the AI column.
- **Layer 2 — claim idempotency:** the atomic claim prevents duplicate dispatch from
  poller/webhook races.
- **Layer 3 — webhook cancellation:** moving a ticket out of the AI column cancels the run
  immediately (with a live re-fetch guard against stale payloads).
- **Layer 4 — reconciler:** see below.

### 8.5 Reconciler (`lib/reconcile.ts`, every poll)

- **Stale claims** older than 5 minutes: stop any orphaned sandbox, clear the sentinel.
- **Finished runs** still registered (status `completed` / `failed` / `cancelled`): unregister.
  Transiently unreachable runs get 3 strikes before being unregistered.
- **Orphaned runs** for tickets that left the AI column: cancel the workflow, stop the sandbox,
  unregister — with a 30-second grace window against Jira JQL index lag.
- **Stale failed-ticket markers**: cleared once the ticket leaves the AI column.

## 9. Sandbox Management

### 9.1 Setup

For each run, the Sandbox Manager provisions a fresh Vercel Sandbox (Node 24, Firecracker microVM)
and:

1. Clones the first selected repository at its `ai-workflow/{ticket-key}` branch (ticket key
   lowercased) to `/vercel/sandbox`; clones additional selected repositories under
   `/vercel/sandbox/repos/`. When the ticket's PR has conflicts, the base branch is merged into the
   checkout during provisioning so the agent resolves conflicts as part of the run. A durable
   workflow-owned `blazebot/*` branch remains authoritative for its existing ticket/repository.
2. Writes the workspace manifest `/vercel/sandbox/aiw-repos.json` (per repo: local path, branch,
   the remote HEAD observed before local preparation, and the pre-agent HEAD SHA).
3. Installs the agent CLI globally (`@anthropic-ai/claude-code` or `@openai/codex`) and the
   configured skills (via `npx skills add … -g --agent claude-code codex --copy`).
4. Writes agent auth to `/tmp/agent-env.sh` (mode 0600), sourced by each phase wrapper — the key
   is never baked into scripts or logged.
5. Configures git identity (Section 6, Agent group) and, when Arthur is configured, the in-sandbox
   tracer hooks.
6. Writes ticket attachments under `/tmp/attachments/`.

### 9.2 Commit Guard (replaces the v2 "sandbox end hook")

There is no orchestrator-run end hook. Instead a **commit-guard Stop hook** is installed inside the
sandbox and toggled per phase: disabled for research (no commits expected), enabled for
implementation and review. The hook checks `git status --porcelain` across all manifest
repositories and blocks the agent from finishing while the working tree is dirty — the agent must
commit before it can return `implemented`.

### 9.3 Pre-PR Checks (optional gate)

Pre-PR check commands are configured in the dashboard (cockpit → Pre-PR checks;
admin/owner-editable, versioned with rollback, stored in `pre_pr_check_config_versions`). When
configured, the workflow runs them inside the sandbox (`src/pre-pr-checks/`) after the phases
and before push/PR creation — only for repositories whose HEAD changed since provisioning. Failed
checks are fed back to the agent (fix and commit, no push) for up to 3 fix cycles; if checks still
fail, publication is blocked and the ticket moves to Backlog with a `failed (pre-pr-checks)`
notification carrying the check logs.

### 9.4 Trusted Publication (after the agent exits)

Publication starts only after the agent process is dead. The orchestrator validates the
manager-authored workspace manifest, then uses a separate short-lived publisher sandbox; the agent
workspace never receives push credentials (`sandbox/trusted-workspace-publisher.ts`):

1. Verify that the sandbox manifest still exactly matches the manager-authored manifest. Each
   repository includes the remote head observed during preparation (`expectedRemoteSha`) and its
   pre-agent head (`preAgentSha`).
2. Preflight every source repository before any remote mutation: require a clean tracked, staged,
   untracked, and conflict-free worktree; read the exact target head; and prove that it descends
   from both trusted baselines. If any repository fails, none are pushed.
3. Re-read provider state and reject remote-branch drift. For remediation runs, also verify that
   the exact source PR/MR remains open at the expected head.
4. Export every changed target as a bundle. In a fresh publisher sandbox, clone each canonical
   remote branch, import its bundle, and validate every target before the first push.
5. Resolve the VCS token only inside the publisher and push each changed repository with an exact
   lease: `--force-with-lease=refs/heads/{branch}:{expectedRemoteSha}`. The token is passed per
   command and is never written to a remote URL or disk.
6. Re-read provider state after each push and require it to equal the exact target head.

Remote drift, lease rejection, and failed preflight stop publication without re-invoking the agent.
Durable workflow retries are safe because the publisher recognizes an already-published exact
target and every remaining mutation uses an exact lease. Finalize Workspace emits exact finalized
branch metadata to Open PR/MR; failed or partial publication creates no PRs and cannot report
success.

### 9.5 Teardown

The agent sandbox is destroyed after every run, in `finally`, regardless of outcome. The publisher
sandbox is also destroyed in its own `finally` block.

### 9.6 Safety Invariants

- The agent never holds push credentials; publication runs in a separate publisher after the agent
  process exits.
- The manager-authored workspace manifest is immutable publication authority and is verified before
  use.
- Every repository passes preflight before the first remote mutation.
- Every push uses an exact lease and is verified against provider state afterward.
- Failed or partial publication creates no PRs and cannot be reported as success.
- Sandboxes are isolated — no access to production infrastructure or other sandboxes.
- Commits are authored as the configured/derived bot identity (Section 6).

## 10. Agent Runner

### 10.1 Launch

Each phase gets a wrapper script (`/tmp/{phase}-wrapper.sh`) that sources `/tmp/agent-env.sh` and
pipes the phase input file into the agent CLI:

- **Claude:** `cat /tmp/{phase}-requirements.md | claude --print --model '<model>'
  --dangerously-skip-permissions --output-format json [--json-schema '<schema>']`, with stdout and
  stderr captured to `/tmp/{phase}-stdout.txt` / `/tmp/{phase}-stderr.txt`.
- **Codex:** `codex exec --model <model> --dangerously-bypass-approvals-and-sandbox
  --skip-git-repo-check --json [--output-schema <schema>]`.

The script ends by writing a sentinel file (`/tmp/{phase}-done`) and the phase exit code. The
workflow polls every 30 seconds (`checkPhaseDone`) and suspends between polls — durable across
redeploys. Agent stdout is not logged by the orchestrator (it may contain client code); structured
events and usage totals are.

### 10.2 Agent Signals

There are no exit-code semantics (the v2 0/1/2 contract was never built). Each phase returns
structured JSON validated against its schema (`sandbox/agents/types.ts`):

- Research: `result: completed | clarification_needed | failed`, plus the plan.
- Implementation: `result: implemented | clarification_needed | failed`, `summary`, `questions`,
  `error`.
- Review: `result: approved | failed`.

Invalid or missing structured output is treated as a failed phase.

### 10.3 Orchestrator Response to Result

- `implemented` (and `approved` when the review phase is enabled) → push changed repos, create or
  reuse PRs/MRs, notify `pr_ready` with the usage report, move ticket to AI Review.
- `clarification_needed` → post numbered questions as a Jira comment, add the
  `needs-clarification` label, move ticket to Backlog, notify.
- `failed` / timeout → move ticket to Backlog, notify `failed`. If the ticket can't be moved, a
  failed-ticket marker prevents immediate re-dispatch.

### 10.4 Responsibilities Split

Agent (inside sandbox): write code, run available tests/quality checks, commit locally per
repository, resolve merge conflicts (base branch is pre-merged on conflict), maintain the ticket
memory file. Orchestrator (workflow steps): branch creation, context assembly, sandbox lifecycle,
push, PR/MR creation, ticket transitions, notifications, telemetry, teardown.

## 11. Adapter Interfaces

### 11.1 Issue Tracker Adapter

```
fetchTicket(id) → TicketContent (title, description, acceptance criteria, comments, labels, attachments)
moveTicket(id, target) → void        // column name or pinned transition id
postComment(id, comment) → string | null
searchTickets(jql) → string[]
downloadAttachment(ref) → bytes
updateLabels(id, add, remove) → void
```

### 11.2 VCS Adapter (GitHub App / GitLab)

```
createBranch(name, base) → void      // seeds empty repositories with an initial commit first
createPR(branch, title, body) → PR
push(...) → void
findPR(branch) → PR | null
getBranchSha(branch) → string
getPRComments(prId) → PRComment[]
getCheckRunResults(prId) → CheckRunResult[]
getPRConflictStatus(prId) → boolean
listPRFiles(prId) → PRFile[]
createGateStatus / updateGateStatus / updateGateStatusDetails   // post-PR gate reporting
```

**Empty repository handling:** `createBranch` handles repositories with no commits. GitHub's Git
API returns 409 ("Git Repository is empty") when reading refs from an empty repo; the adapter seeds
the repository with an initial commit (README.md) via the Contents API and uses the resulting SHA
as the branch base. GitLab gets equivalent seeding. Seed failures are wrapped with repository
context and propagated.

### 11.3 Messaging Adapter

```
notify(event) → void                 // best-effort; never blocks the workflow
```

Implemented on `vercel/chat` with the Slack adapter; a no-op implementation is used when Slack is
not configured. Swapping platforms means wiring another `@chat-adapter/*`.

### 11.4 Adapter Registration

Active adapters are chosen via env (`ISSUE_TRACKER_KIND`, `VCS_KIND`, presence of Slack config).
GitHub and GitLab can be active simultaneously; repository selection spans both providers.

## 12. Context Assembly

`sandbox/context.ts` assembles a `# Requirements` markdown document per phase and writes it into
the sandbox as that phase's input file. All ticket content is fetched fresh.

Research/plan input:

```markdown
# Requirements
## Ticket ID / ## Ticket / ## Description / ## Acceptance Criteria / ## Comments / ## Branch
## Selected Repositories        (the only repos the run may edit)
## Pre-Sandbox: {title}         (optional additions from pre-sandbox steps)
## PR Review Feedback: {repo}   (per repo with a workflow-owned PR)
## CI/CD Check Results: {repo}
## Merge Conflicts: {repo}
---
{research-plan prompt body}
```

Implementation and review inputs carry `## Ticket ID / ## Ticket / ## Acceptance Criteria` plus the
research phase's `## Research & Plan` output, followed by their prompt body. If assembly fails
(tracker API error, missing prompt), the run fails immediately.

A configurable **pre-sandbox phase** (`pre-sandbox.yaml`, `src/pre-sandbox/`) runs before
provisioning; its built-in repository-selection step picks the repositories the run may edit
(including any with workflow-owned branches for the ticket) and can halt the run with a
clarification question — e.g. when no repository matches.

## 13. Observability

- **Structured logs** (Pino, JSON to stdout) with `ticket_id` / `ticket_identifier` /
  `workflow_run_id` context. No client content (code, ticket text, question bodies) in logs.
- **Durable run telemetry** — every run writes status, timing, model, per-phase token/cost usage,
  PR links, and a full step trace to `workflow_runs`, on every exit path.
- **Usage reports** — token/cost totals attached to Slack `pr_ready` notifications. Codex costs are
  computed from a live pricing feed.
- **Arthur (optional)** — per-run trace tasks are auto-created; an in-sandbox tracer hooks the
  agent's prompt/tool events; the dashboard surfaces eval health and cost aggregates from traces.
- **Dashboard** (Section 17) — runs, live status, KPIs, cost & usage, eval health, prompt
  versions.

## 14. Failure Model and Recovery

| Failure | Recovery |
| --- | --- |
| Tracker API down during poll | Next poll cycle (1 min) retries |
| Tracker/VCS API down during a step | Vercel Workflow retry with backoff |
| Empty repository (no commits) | Adapter seeds an initial commit, then creates the branch |
| Sandbox won't provision | Workflow retry with backoff |
| Agent timeout / crash / invalid output | Phase fails → ticket to Backlog, `failed` notification |
| Agent clarification | Not a failure — questions posted, ticket to Backlog |
| Pre-PR checks fail after 3 fix cycles | Publication blocked; ticket → Backlog with `failed (pre-pr-checks)` and logs |
| Push fails | Agent fix-and-retry loop (Section 9.4), then run failure |
| Success with no commits | Run fails ("no commits") |
| Can't move ticket | Failed-ticket marker prevents re-dispatch until the ticket leaves the AI column |
| Can't send notification | Log warning; never blocks the workflow |
| Crashed dispatch (stale claim) | Reconciler clears claims older than 5 min; capacity checks ignore stale sentinels so they can't deadlock capacity |
| Vercel Workflow degradation | Workflows are durable — resume automatically |

Orphaned sandboxes are stopped by the reconciler (via the sandbox id pinned in `active_runs`) and
by webhook cancellation.

## 15. Security and Operational Safety

- **Sandbox isolation:** each run in its own Firecracker microVM; no access to production
  infrastructure or other tickets; destroyed after every run.
- **Credential scoping:** the agent receives only its model API key (via a 0600 env file). VCS
  tokens are injected per push command after the agent exits — never in the remote URL, on disk,
  or visible to the agent. GitHub uses short-lived App installation tokens.
- **Webhook auth:** Jira HMAC signature; Slack request signing + user allow-list; per-provider
  GitHub/GitLab webhook secrets; cron protected by `CRON_SECRET`.
- **Secrets:** all keys live in env vars; never logged.
- **Network:** the agent has full outbound internet access inside the sandbox. Egress controls
  (allowlists/proxy/filtering) remain deferred.
- See also `docs/SECURUTY-OBSERVABILITY.md` and `docs/ON-PREM-AWS.md`.

## 16. Post-PR Gate

A separate durable workflow (`postPrGateWorkflow`) runs configurable checks against workflow-owned
PRs **after** creation. Full spec: `docs/post-pr-gate-spec.md`.

- Triggered by GitHub/GitLab webhooks (PR opened/synchronized) on `ai-workflow/*` branches.
  Legacy `blazebot/*` branches remain recognized.
- Each configured step is surfaced as a real check run (GitHub) / commit status (GitLab) on the PR
  head SHA under `AI Workflow / `. Existing `blazebot / ` checks remain recognized, and their
  exact stored provider references remain authoritative.
- Steps come from `post-pr-gate.yaml`; v1 ships `pr-title-format` (Conventional Commits) and
  `code-hygiene`.
- Idempotency, dedupe, and force-push handling via the `gate_locks` / `gate_dedupe` /
  `gate_current` tables.

## 17. Dashboard and Auth

`apps/dashboard` is a Next.js "cockpit", deployed as a separate Vercel project. Sections: Overview
(KPIs, eval health), Workflow runs (+ live view, run trace, ticket detail), Prompt library
(dashboard-authored reusable prompts, versioned), Arthur evals, Cost & usage, Workflow editor,
and Users (invites, roles).

- **The worker is the auth authority** (Better Auth at `/api/auth/**`; dashboard data API under
  `/api/v1/*` gated by session middleware). The dashboard is a thin BFF: it stores the
  worker-issued session token in a first-party `httpOnly` cookie and forwards it as
  `Authorization: Bearer` server-side.
- **Login modes:** password login (always on, `DASHBOARD_AUTH_EMAIL`/`DASHBOARD_AUTH_PASSWORD`)
  plus optional OIDC SSO (`SSO_*` group, domain-restricted) with a dedicated handoff flow under
  `/api/dashboard-auth/**`.
- **Email:** optional Resend integration for invites/password reset, with delivery tracking via
  the Resend webhook.
- The bot runs fine without the dashboard; it is read-mostly (user administration and prompt
  editing are the write paths).

## 18. Implementation Status

### 18.1 Implemented

- Jira webhook + every-minute cron poller with shared atomic dispatch.
- Single durable `agentWorkflow` with research → implementation → optional review phases,
  structured output schemas, commit guard, 30s durable polling.
- Postgres (Neon) persistence: run registry, branch/PR ownership, telemetry, gate state, auth.
- Multi-repository support with pre-sandbox repository selection and per-repo PRs/MRs.
- GitHub (App auth) + GitLab adapters, mixed-provider setups, empty-repo seeding.
- Claude Code + Codex agents with per-ticket label routing.
- Slack notifications (live status + threads + usage reports) and `/ai-workflow` slash command.
- Attachments pipeline into the sandbox.
- Reconciler (stale claims, orphaned runs, finished runs, failed markers).
- Pre-PR check gate: dashboard-managed per-repo sandbox commands (versioned, with rollback) with
  agent fix cycles before push/PR creation.
- Post-PR gate workflow with check-run reporting.
- Dashboard with Better Auth (password + optional SSO), invites/roles, Resend email.
- Arthur tracing, eval health, prompt-injection check (optional).
- Token/cost usage tracking per run (including live Codex pricing).
- pnpm monorepo (`apps/worker`, `apps/dashboard`, `apps/shared` type contracts).

### 18.2 Deferred

- TDD enforcement in the agent contract — current prompts only require running existing tests and
  quality checks; mandatory test-first/integration/e2e authoring is not enforced.
- `[OVERRIDE]` ticket-comment precedence convention (the implemented rule is narrower: PR review
  comments supersede acceptance criteria).
- Teams (or other chat platforms) via additional `@chat-adapter/*` wiring.
- Additional tracker adapters (Linear, Asana).
- Docker sandbox provider (self-hosted without Vercel; see `docs/ON-PREM-AWS.md`).
- Per-user notifications (requires Jira→Slack user mapping; Slack posts to one channel today).
- Arbitrary per-ticket model routing (only agent-kind routing via labels exists).
- Per-ticket token/cost budget kill.
- Complexity-aware timeouts (single `JOB_TIMEOUT_MS` today).
- Evaluator loop beyond the optional review phase (chunked generator/evaluator).
- Subtickets (ticket → subtask decomposition into smaller runs).
- Self-improvement feedback loop (shared endpoint capturing review corrections across runs).
- Network egress controls (allowlists, proxy, or content filtering for outbound traffic).
- Richer tool support (Figma, Notion) beyond ticket attachments.
- Similar-ticket search during context assembly.
- Agent personas (specialized prompts/models per role).
- Infrastructure & observability access for agents (DB migrations, Datadog, Sentry) — needs
  careful scoping.
- Hot config reload.
- Persistent/named sandboxes (Vercel Sandbox SDK v2 workspace resume) — teardown-always is a
  current design choice, not a platform constraint.
