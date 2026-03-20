# Blazebot Service Specification

Status: Draft v1

Purpose: Define a queue-driven automation service that picks up tickets, implements features
end-to-end inside isolated Docker containers, and delivers merge-ready pull requests for human
approval.

## 1. Problem Statement

Blazebot is a long-running, queue-driven automation service that watches an issue tracker for
tickets assigned to AI, implements features end-to-end inside isolated Docker containers, and
delivers merge-ready pull requests for human approval.

The service solves four operational problems:

- It turns ticket implementation into a fully automated pipeline — from assignment through TDD,
  code review, conflict resolution, and PR delivery — without manual intervention.
- It isolates agent execution in per-ticket Docker containers so agent commands cannot affect
  production infrastructure or other tickets.
- It manages ticket lifecycle directly — moving tickets between columns, posting clarification
  questions, and notifying users — as first-class service behavior.
- It enforces quality through mandatory TDD and an iterative review loop (AI review → human
  review → agent fix → re-review) before any PR reaches a human for final approval.

Important boundary:

- Blazebot owns the full lifecycle from ticket pickup to merge-ready PR.
- The coding agent inside the sandbox focuses on implementation — it does not manage ticket state,
  PR creation, or review coordination.
- A successful run ends with a PR that has passed AI review, human review, conflict resolution,
  and CI checks.

## 2. Goals and Non-Goals

### 2.1 Goals

- Receive ticket events via webhooks and dispatch work through BullMQ with bounded concurrency.
- Maintain authoritative orchestration state in Postgres for dispatch, retries, and audit.
- Recover orchestrator state from service restarts using Postgres as the single source of truth — no
  filesystem-based recovery needed. Individual agent runs are stateless — each run spins up a fresh
  container, fetches context from the tracker, and tears down on completion. Postgres recovery applies
  to the orchestrator knowing which tickets are in-flight and what workflow state to resume from.
- Spin up isolated Docker containers per ticket with scoped Git permissions.
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
- Running agents outside Docker containers (bare-metal execution).
- Replacing human final approval on PRs.
- Built-in IDE or code editor.
- Prescribing a specific dashboard or terminal UI implementation.

## 3. System Overview

### 3.1 Main Components

1. **Webhook Receiver** (Fastify)
   - Receives ticket events from issue tracker (Jira/Linear).
   - Validates payloads (e.g., HMAC verification).
   - Delegates to adapter for normalization, enqueues work onto BullMQ.

2. **Issue Tracker Adapter**
   - Reads ticket data (description, acceptance criteria, comments, labels).
   - Writes ticket transitions (→ AI Review, → Backlog).
   - Posts clarifying questions as ticket comments.
   - Parses and validates incoming webhooks into normalized events.

3. **Messaging Adapter**
   - Sends status notifications (Slack/Teams).
   - Pings users on clarification requests.

4. **VCS Adapter**
   - Creates feature branches.
   - Creates pull requests.
   - Fetches PR comments (liked + human-written).
   - Reports PR conflict status.

5. **Orchestrator**
   - Decides what action to take based on normalized webhook events and current workflow state.
   - Enqueues jobs (`implementation`, `fixing_feedback`).
   - Manages concurrency limits.
   - Handles stale job protection (cancel on contradicting webhook + verify at job start + polling fallback for missed webhooks and stuck jobs).

6. **Sandbox Manager**
   - Spins up Docker containers from a pre-built project-specific image.
   - Checks out the repo on the feature branch.
   - Generates `requirements.md` inside the container with assembled context.
   - Tears down containers after every run.

7. **Agent Runner**
   - Launches the coding agent (Claude Code / Codex) inside the container via `docker exec`.
   - Reads structured output (JSON schema enforced) to determine outcome.
   - Enforces timeouts.

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
2. **Orchestration Layer** — Job dispatch, concurrency, retries, ticket state decisions.
3. **Execution Layer** — Sandbox lifecycle, agent runner, Docker management.
4. **Persistence Layer** — Postgres state, BullMQ queues.
5. **Observability Layer** — Logging, metrics, optional dashboard.

### 3.3 External Dependencies

MVP:

- Issue tracker API (Jira).
- Messaging API (Slack).
- VCS API (GitHub).
- Docker engine.
- Postgres.
- Redis (for BullMQ).
- Coding agent (Claude Code / Codex).

Deferred: Linear, Teams, GitLab.

## 4. Core Domain Model

### 4.1 Ticket (DB Record — Orchestration State)

Fields:

- `id` — stable tracker-internal ID.
- `identifier` — human-readable key (e.g., `PROJ-123`).
- `state` — last known tracker column/status (updated by webhooks).
- `workflow_state` — Blazebot's internal lifecycle state (see Section 7).
- `assignee` — user who triggered the AI run (stored for audit; not used for notifications in MVP).
- `branch_name` — feature branch for this ticket.
- `pr_id` — pull request reference (set after PR creation).
- `current_run_id` — reference to active run attempt. All historical run attempts are persisted and
  queryable via `RunAttempt.ticket_id` for audit and visibility.
- `created_at`
- `updated_at`

Ticket content (title, description, acceptance criteria, comments, labels) is always fetched fresh
from the tracker API — never stored in the database.

### 4.2 Run Attempt

One execution attempt for one ticket.

Fields:

- `id`
- `ticket_id` — **indexed** (frequently queried for run history per ticket).
- `attempt_number` — 1 for first, increments on retry.
- `type` — `implementation`, `review_fix`, `conflict_resolution`.
- `status` — `pending`, `preparing_sandbox`, `running`, `succeeded`, `failed`, `timed_out`,
  `clarification_needed`.
- `container_id` — Docker container reference.
- `branch_name`
- `started_at`
- `finished_at`
- `error` — failure reason if any.

Retries are handled natively by BullMQ (exponential backoff, configurable per job type). No custom
retry entity needed.

## 5. Agent Prompt Contract

Prompt files live in the Blazebot service repository and are copied into the Docker container at
sandbox setup. This keeps prompts easy to edit and version without touching client repos.

- `.blazebot/prompts/implement.md` — initial implementation prompt.
- `.blazebot/prompts/review-fix.md` — fixing review feedback + resolving merge conflicts.

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

When resuming after clarification, `.blazebot/prompts/implement.md` is used again. The Q&A context comes
from ticket comments (fetched fresh), not from the prompt file.

If a prompt file is missing, the run fails with a clear error.

The coding agent uses a default model for all runs. Model routing (per-ticket model selection based
on labels or complexity) is deferred.

## 6. Configuration

All runtime config lives in environment variables, validated at startup. Changes require service
restart. In-flight jobs finish with the config they started with; new jobs pick up new config after
restart.

Key config groups:

- **Sandbox:** Docker image, concurrency limit (`MAX_CONCURRENT_AGENTS`), job timeout
  (`JOB_TIMEOUT_MS`).
- **Issue Tracker:** adapter kind (`ISSUE_TRACKER_KIND`), project key (`JIRA_PROJECT_KEY`), credentials, webhook secrets.
- **Messaging:** adapter kind (`MESSAGING_KIND`), credentials.
- **VCS:** adapter kind (`VCS_KIND`), credentials.
- **Infrastructure:** Postgres connection, Redis connection.

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

```
queued → implementing                    (sandbox spun up)
implementing → clarification_pending     (agent needs answers, container torn down)
implementing → awaiting_review           (PR created, container torn down)
implementing → failed                    (unrecoverable error)
clarification_pending → implementing     (user answers, moves ticket back to AI)
awaiting_review → fixing_feedback        (human moves ticket to AI In Progress)
fixing_feedback → awaiting_review        (fixes done, re-review)
fixing_feedback → completed              (CI passes, PR ready)
fixing_feedback → failed                 (unrecoverable error)
any → failed                             (max retries exhausted)
```

### 7.3 Container Lifecycle

Containers are alive only during `implementing` and `fixing_feedback`. Torn down on every other
transition.

### 7.4 Retry Strategy

- BullMQ's built-in retry with exponential backoff.
- Retry config (max attempts, backoff) set per job type in env config.
- After max retries exhausted → ticket transitions to `failed`.

## 8. Event Handling and Job Dispatch

### 8.1 Trigger Events

1. **Ticket moved to AI** → check workflow state in DB:
   - No record → first time, create branch, enqueue `implementation` job.
   - `clarification_pending` → enqueue `implementation` job (with Q&A context from comments).
   - `awaiting_review` → check PR for conflicts and comments, enqueue `fixing_feedback` job.
2. **Ticket moved to terminal state** (Closed/Cancelled) → cancel any queued/active job, tear down
   container.

Blazebot-initiated transitions (not webhook triggers):

- → **AI Review** when PR is ready.
- → **Backlog** when clarification is needed.

### 8.2 Concurrency Control

- `MAX_CONCURRENT_AGENTS` — global limit on running containers.
- Jobs wait in BullMQ queue until a slot opens.

### 8.3 Stale Job Protection

- **Layer 1 — Webhook cancellation:** On contradicting webhook (ticket moved out of AI), cancel any pending job in BullMQ.
- **Layer 2 — Job-start verification:** At job start, fetch current ticket state from tracker — skip if no longer in AI.
- **Layer 3 — Polling fallback:** A BullMQ repeatable job runs every `POLL_INTERVAL_MS` (default 5 min) performing two checks:
  - **Missed webhooks:** JQL search against tracker for tickets in AI column, cross-referenced with DB. Tickets not in DB or in `failed` state are enqueued automatically.
  - **Stuck jobs:** Tickets in `implementing`/`fixing_feedback` past `STUCK_JOB_THRESHOLD_MS` (default `JOB_TIMEOUT_MS × 2`) are recovered — container torn down, run marked `timed_out`, job re-enqueued (respecting `JOB_MAX_RETRIES`).
- All three layers combined eliminate race conditions, missed webhooks, and silently stuck jobs.

## 9. Sandbox Management

### 9.1 Sandbox Setup

For each run, the Sandbox Manager:

1. Creates a Docker container from a pre-built project-specific image (dependencies pre-installed).
2. Checks out the repo on the feature branch (branch created by orchestrator if first run).
3. Generates `requirements.md` inside the container with assembled context.
4. Agent has scoped Git permissions — can only commit locally, no remote operations.
5. Injects a long-lived Claude Code authentication token into the container for agent API access.

### 9.2 Context Assembly per Run Type

- **`implementation`**: ticket content (fetched fresh, including all comments) +
  `.blazebot/prompts/implement.md`.
- **`fixing_feedback`**: ticket content (fetched fresh, including all comments) + PR diff + liked
  comments + human comments + conflict info if applicable + `.blazebot/prompts/review-fix.md`.

### 9.3 Teardown

Container is destroyed after every run — no container survives between workflow states.

### 9.4 Safety Invariants

- Agent Git permissions scoped to its feature branch only.
- Container is isolated — no access to production infrastructure or other containers.
- All commits authored as Blazebot.

## 10. Agent Runner

### 10.1 Launch

- Orchestrator runs `docker exec` to launch the coding agent (Claude Code / Codex) inside the
  container with the assembled prompt.
- Agent stdout is not logged — it may contain client code and confidential ticket data. Only
  anonymized, structured events (start, exit code, duration) are logged.
- Timeout enforced via config (`JOB_TIMEOUT_MS`).

### 10.2 Agent Signals

The agent returns structured output via Claude Code's JSON schema enforcement. The orchestrator
defines a schema with a required `result` field and reads the response directly — no marker file
needed.

Schema:

- `result` — `implemented` | `clarification_needed` | `failed`.
- `summary` — description of work done (used for PR description, when `implemented`).
- `questions` — list of questions to post on the ticket (when `clarification_needed`).
- `error` — failure details (when `failed`).

Schema validation is enforced by the agent runtime. If the agent returns invalid output or fails to
produce structured output, the run is treated as failed and retried via BullMQ.

### 10.3 Orchestrator Response to Result

- `implemented` → read summary, create PR (if implementation) or signal done (if fixing_feedback),
  tear down container.
- `failed` → read error, retry or transition to `failed`.
- `clarification_needed` → read questions, post on ticket, move ticket to Backlog, notify user, tear
  down container.

### 10.4 Responsibilities Split

Agent (inside sandbox):

- Writes code.
- Runs tests.
- Commits locally to feature branch (no push — orchestrator handles push).
- Runs self-review skill.
- Merges target branch and resolves conflicts.
- Commits WIP on clarification.

Orchestrator (outside sandbox):

- Creates feature branches (via VCS adapter, before sandbox spin-up).
- Pushes feature branch after agent run completes.
- Creates PRs (via VCS adapter).
- Moves tickets between columns.
- Posts clarification questions on ticket.
- Sends notifications.
- Tears down containers.

## 11. Adapter Interfaces

### 11.1 Issue Tracker Adapter

```
fetchTicket(id) → TicketContent (title, description, acceptance criteria, comments, labels)
moveTicket(id, column) → void
postComment(id, comment) → void
searchTickets(jql) → string[] (ticket keys matching query)
parseWebhook(req) → NormalizedEvent
```

### 11.2 VCS Adapter

```
createBranch(repo, name, base) → void
createPR(repo, branch, title, body) → PR
getPRComments(repo, prId) → liked comments + human comments
getPRConflictStatus(repo, prId) → boolean
```

**Empty repository handling:** `createBranch` must handle the case where the target repository has
no commits. GitHub's Git API returns a 409 ("Git Repository is empty") when attempting to read refs
from an empty repo. When this occurs, the adapter seeds the repository with an initial commit
(README.md) using the Contents API (`repos.createOrUpdateFileContents`), then uses the resulting
commit SHA as the base for branch creation. Low-level Git endpoints (`git.createTree`,
`git.createCommit`, `git.createRef`) also return 409 on empty repos — only the Contents API can
bootstrap them. If the seed commit fails, the error is wrapped with repository context and
propagated.

### 11.3 Messaging Adapter

```
notify(message) → void
```

### 11.4 Normalized Webhook Event

All tracker webhooks normalize to:

```
{
  type: "ticket_moved"
  ticketId: string
  fromColumn: string
  toColumn: string
  triggeredBy: string (user who moved it)
}
```

The orchestrator only works with normalized events — never raw webhook payloads.

### 11.5 Adapter Registration

- Active adapters configured via env (`ISSUE_TRACKER_KIND`, `MESSAGING_KIND`, `VCS_KIND`).
- Each adapter registers its webhook route on startup.
- Swapping an adapter is a single-module replacement with no changes to core logic.

## 12. Context Assembly

The Sandbox Manager builds `requirements.md` inside the container before the agent starts. The
format is fixed.

For `implementation` runs:

```markdown
# Requirements

## Ticket

{ticket title}

## Description

{ticket description}

## Acceptance Criteria

{acceptance criteria}

## Comments

{all ticket comments, chronological}

---

{contents of .blazebot/prompts/implement.md}
```

For `fixing_feedback` runs:

```markdown
# Requirements

## Ticket

{ticket title}

## Description

{ticket description}

## Acceptance Criteria

{acceptance criteria}

## Comments

{all ticket comments, chronological}

## PR Review Feedback

{liked comments + human comments}

## Merge Conflicts

{conflict info, if applicable}

---

{contents of .blazebot/prompts/review-fix.md}
```

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

Structured JSON logs to stdout. Deployment decides where they go (file, log aggregator, etc.).

### 13.4 Deferred

- Dashboard / status UI.
- Metrics / alerting.
- Token usage tracking.

## 14. Failure Model and Recovery

### 14.1 Failure Classes

1. **Webhook/Ingestion Failures** — invalid payload, validation failure, tracker API down.
2. **Sandbox Failures** — Docker container won't start, image pull failure, disk full.
3. **Agent Failures** — timeout, crash, invalid structured output.
4. **Adapter Failures** — VCS API down (can't create PR), messaging down (can't notify), tracker
   down (can't move ticket).
5. **Infrastructure Failures** — Postgres down, Redis down, BullMQ connection lost.

### 14.2 Recovery Behavior

| Failure                               | Recovery                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| Webhook invalid                       | Log and discard, return 400                                     |
| Tracker API down during context fetch | Retry via BullMQ backoff                                        |
| Empty repository (no commits)         | VCS adapter seeds repo with initial commit, then creates branch |
| Container won't start                 | Retry via BullMQ backoff                                        |
| Agent timeout/crash                   | Retry via BullMQ backoff                                        |
| Agent clarification (exit 2)          | Not a failure — normal flow                                     |
| Can't create PR                       | Retry via BullMQ backoff                                        |
| Can't move ticket                     | Retry, log warning                                              |
| Can't send notification               | Log warning, don't block workflow                               |
| Postgres down                         | Service unhealthy, jobs stall until recovery                    |
| Redis down                            | BullMQ unavailable, service unhealthy                           |
| Max retries exhausted                 | Ticket → `failed`, notify user                                  |

Notifications are best-effort — never block the workflow.

### 14.3 Recovery After Service Restart

- Postgres is the single source of truth for orchestration state.
- On restart, BullMQ recovers its job queue from Redis.
- No filesystem-based recovery needed.
- Active containers from the previous process may be orphaned — the service should detect and clean
  up stale containers on startup.

## 15. Security and Operational Safety

### 15.1 Sandbox Isolation

- Each agent runs in an isolated Docker container.
- Agent process runs as a non-root user inside the container with limited filesystem and system-level
  permissions.
- No access to production infrastructure or other containers.

### 15.2 Git Permission Scoping

- Agent can only commit locally — `git push` is not allowed from inside the container.
- Orchestrator pushes the feature branch after the agent run completes.
- PRs, merges to main, branch deletion are orchestrator-only.
- Enforced via allowed command list inside the container (no remote Git operations).
- Claude Code `PreStop` hook: if `git status` shows uncommitted changes, block the agent from
  finishing and force it to commit or discard. This ensures no work is silently lost.
- Codex equivalent of the PreStop hook is TBD.

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

```
on_webhook(req):
  event = issueTrackerAdapter.parseWebhook(req)
  if event.type != "ticket_moved": discard

  if event.toColumn == "AI":
    ticket = db.findTicket(event.ticketId)

    if ticket is null:
      // First time — new implementation
      branch = vcsAdapter.createBranch(repo, branchName, "main")
      db.createTicket(event.ticketId, state="queued", branch=branch)
      enqueue("implementation", event.ticketId)

    else if ticket.workflow_state == "clarification_pending":
      db.updateState(ticket, "queued")
      enqueue("implementation", event.ticketId)

    else if ticket.workflow_state == "awaiting_review":
      db.updateState(ticket, "queued")
      enqueue("fixing_feedback", event.ticketId)

  else if event.toColumn is terminal:
    cancelActiveJob(event.ticketId)
    teardownContainer(event.ticketId)
    db.updateState(ticket, "failed")
```

### 16.2 Job Execution (Implementation)

```
process_implementation_job(ticketId):
  ticket = db.findTicket(ticketId)

  // Stale job protection
  currentState = issueTrackerAdapter.fetchTicket(ticketId).state
  if currentState != "AI": skip job

  db.updateState(ticket, "implementing")
  run = db.createRunAttempt(ticketId, type="implementation")

  ticketContent = issueTrackerAdapter.fetchTicket(ticketId)
  prompt = readFile(repo, ".blazebot/prompts/implement.md")
  requirementsMd = assembleContext(ticketContent, prompt)

  container = sandboxManager.spinUp(ticket.branch, requirementsMd)
  db.updateRun(run, container_id=container.id)

  output = agentRunner.exec(container, requirementsMd) // returns structured JSON

  sandboxManager.tearDown(container)

  if output.result == "implemented":
    pr = vcsAdapter.createPR(repo, ticket.branch, output.title, output.summary)
    issueTrackerAdapter.moveTicket(ticketId, "AI Review")
    db.updateState(ticket, "awaiting_review")
    messagingAdapter.notify("Task " + ticket.identifier + " PR ready for review")

  else if output.result == "clarification_needed":
    issueTrackerAdapter.postComment(ticketId, output.questions)
    issueTrackerAdapter.moveTicket(ticketId, "Backlog")
    db.updateState(ticket, "clarification_pending")
    messagingAdapter.notify("Task " + ticket.identifier + " needs clarification")

  else: // "failed" or invalid output
    db.updateRun(run, status="failed", error=output.error)
    throw // BullMQ handles retry
```

### 16.3 Job Execution (Fixing Feedback)

```
process_fixing_feedback_job(ticketId):
  ticket = db.findTicket(ticketId)

  currentState = issueTrackerAdapter.fetchTicket(ticketId).state
  if currentState != "AI": skip job

  db.updateState(ticket, "fixing_feedback")
  run = db.createRunAttempt(ticketId, type="fixing_feedback")

  ticketContent = issueTrackerAdapter.fetchTicket(ticketId)
  prComments = vcsAdapter.getPRComments(repo, ticket.prId)
  hasConflicts = vcsAdapter.getPRConflictStatus(repo, ticket.prId)
  prompt = readFile(repo, ".blazebot/prompts/review-fix.md")
  requirementsMd = assembleContext(ticketContent, prComments, hasConflicts, prompt)

  container = sandboxManager.spinUp(ticket.branch, requirementsMd)
  output = agentRunner.exec(container, requirementsMd) // returns structured JSON

  sandboxManager.tearDown(container)

  if output.result == "implemented":
    issueTrackerAdapter.moveTicket(ticketId, "AI Review")
    db.updateState(ticket, "awaiting_review")
    messagingAdapter.notify("Task " + ticket.identifier + " fixes applied, ready for re-review")

  else: // "failed" or invalid output
    db.updateRun(run, status="failed", error=output.error)
    throw // BullMQ handles retry
```

## 17. Test and Validation Matrix

### 17.1 Orchestration

- Webhook with ticket moved to AI → enqueues implementation job.
- Webhook with ticket moved to AI (from `clarification_pending`) → enqueues implementation job.
- Webhook with ticket moved to AI (from `awaiting_review`) → enqueues fixing_feedback job.
- Webhook with ticket moved to terminal → cancels active job, tears down container.
- Stale job protection — job skipped if ticket no longer in AI at start.
- Contradicting webhook cancels pending job in queue.
- Max retries exhausted → ticket transitions to `failed`, user notified.
- Concurrency limit respected — jobs wait in queue when at capacity.
- Polling fallback — discovers tickets in AI column missed by webhooks.
- Polling fallback — detects stuck jobs past threshold, tears down container, re-enqueues or fails.
- Polling fallback — skips tickets already queued/implementing/fixing_feedback (idempotent).
- Polling fallback — respects retry limits on stuck job recovery.

### 17.2 Sandbox Management

- Container spun up with correct branch and `requirements.md`.
- Container torn down after every run (success, failure, clarification).
- Git permissions scoped to feature branch only.

### 17.3 Agent Runner

- Exit code 0 → PR created, ticket moved to AI Review.
- Exit code 1 → retry or fail.
- Exit code 2 → questions posted, ticket moved to Backlog.
- Structured output parsed correctly for all result types.
- Timeout enforced — agent killed after `JOB_TIMEOUT_MS`.

### 17.4 Adapter Interfaces

- Each adapter implementation satisfies its interface contract.
- Webhook parsing returns normalized events.
- Invalid webhooks return 400, don't enqueue work.
- Adapter failures trigger retries (except notifications — best effort).
- VCS `createBranch` on empty repo (409) → seeds repo with initial commit, then creates branch.
- VCS `createBranch` on empty repo with seed failure → wraps error with repository context.
- VCS `createBranch` non-409 errors from `getRef` → propagated unchanged.

### 17.5 Context Assembly

- Implementation context includes full ticket content + all comments + prompt.
- Fixing feedback context includes ticket content + PR comments + conflict info + prompt.
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

- [ ] Webhook receiver with HMAC validation.
- [ ] Issue Tracker adapter (Jira first).
- [ ] VCS adapter (GitHub).
- [ ] Messaging adapter (Slack).
- [ ] Orchestrator — webhook → dispatch logic with workflow state machine.
- [ ] BullMQ job processing for `implementation` and `fixing_feedback`.
- [ ] Sandbox Manager — Docker container lifecycle.
- [ ] Agent Runner — `docker exec`, structured output parsing, schema validation.
- [ ] Context assembly — `requirements.md` generation.
- [ ] Persistence — Postgres schema for tickets and run attempts.
- [ ] Stale job protection (cancel on contradicting webhook + verify at job start + polling fallback).
- [ ] Concurrency control via `MAX_CONCURRENT_AGENTS`.
- [ ] Structured JSON logging with ticket/run context.
- [ ] Prompt files — `.blazebot/prompts/implement.md` and `.blazebot/prompts/review-fix.md`.

### 18.2 Deferred

- [ ] Model routing (per-ticket model selection).
- [ ] Hot config reload.
- [ ] Token usage tracking.
- [ ] Admin panel / dashboard (scope TBD — open question around exposing cost data to clients).
- [ ] Metrics / alerting.
- [ ] Additional tracker adapters (Linear, Asana).
- [ ] Additional messaging adapters (Teams).
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
