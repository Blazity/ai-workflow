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
- Recover from service restarts using Postgres as the single source of truth — no filesystem-based
  recovery needed.
- Spin up isolated Docker containers per ticket with scoped Git permissions.
- Enforce TDD — integration and e2e tests are required, not optional.
- Run iterative code review loops (AI review → human feedback → agent fix) until clean.
- Handle conflict resolution (merge target branch, resolve conflicts, re-review).
- Manage two ticket transitions directly: move to **AI Review** when implementation passes
  self-review, and move to **Backlog** when clarification is needed.
- Notify users via messaging adapter (Slack/Teams) at every status change.
- Support clarification flow — commit work-in-progress, tear down container, post questions on
  ticket, and resume in a fresh container with full conversation history when answered.
- Support adapter modularity — all external integrations behind isolated interfaces so swapping
  e.g. Jira → Linear or Slack → Teams is a single-module replacement.

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
   - Handles stale job protection (cancel on contradicting webhook + verify at job start).

6. **Sandbox Manager**
   - Spins up Docker containers from a pre-built project-specific image.
   - Checks out the repo on the feature branch.
   - Generates `requirements.md` inside the container with assembled context.
   - Tears down containers after every run.

7. **Agent Runner**
   - Launches the coding agent (Claude Code / Codex) inside the container via `docker exec`.
   - Streams agent stdout to logs.
   - Reads exit code and marker file (`.blazebot/output.json`) to determine outcome.
   - Enforces timeouts.

8. **Persistence Layer** (Drizzle + Postgres)
   - Stores ticket orchestration state and run attempts.
   - Single source of truth for recovery after service restarts.

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

- Issue tracker API (Jira, Linear).
- Messaging API (Slack, Teams).
- VCS API (GitHub).
- Docker engine.
- Postgres.
- Redis (for BullMQ).
- Coding agent (Claude Code / Codex).

## 4. Core Domain Model

### 4.1 Ticket (DB Record — Orchestration State)

Fields:

- `id` — stable tracker-internal ID.
- `identifier` — human-readable key (e.g., `PROJ-123`).
- `state` — last known tracker column/status (updated by webhooks).
- `workflow_state` — Blazebot's internal lifecycle state (see Section 7).
- `assignee` — user who triggered the AI run (for notifications).
- `branch_name` — feature branch for this ticket.
- `pr_id` — pull request reference (set after PR creation).
- `current_run_id` — reference to active run attempt.
- `created_at`
- `updated_at`

Ticket content (title, description, acceptance criteria, comments, labels) is always fetched fresh
from the tracker API — never stored in the database.

### 4.2 Run Attempt

One execution attempt for one ticket.

Fields:

- `id`
- `ticket_id`
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

Each repo contains prompt files that define the instructions sent to the coding agent:

- `.blazebot/implement.md` — initial implementation prompt.
- `.blazebot/review-fix.md` — fixing review feedback + resolving merge conflicts.

Prompt files are:

- Versioned in the repo — changes go through normal PRs.
- Self-contained — no composition or inheritance between them.
- Pure prompt content — no runtime config.

When resuming after clarification, `.blazebot/implement.md` is used again. The Q&A context comes
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
- **Issue Tracker:** adapter kind (`ISSUE_TRACKER_KIND`), credentials, webhook secrets.
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

- On contradicting webhook (ticket moved out of AI), cancel any pending job in BullMQ.
- At job start, fetch current ticket state from tracker — skip if no longer in AI.
- Both layers to eliminate race conditions.

## 9. Sandbox Management

### 9.1 Sandbox Setup

For each run, the Sandbox Manager:

1. Creates a Docker container from a pre-built project-specific image (dependencies pre-installed).
2. Checks out the repo on the feature branch (branch created by orchestrator if first run).
3. Generates `requirements.md` inside the container with assembled context.
4. Agent has scoped Git permissions — can only commit and push to its feature branch.

### 9.2 Context Assembly per Run Type

- **`implementation`**: ticket content (fetched fresh, including all comments) +
  `.blazebot/implement.md`.
- **`fixing_feedback`**: ticket content (fetched fresh, including all comments) + PR diff + liked
  comments + human comments + conflict info if applicable + `.blazebot/review-fix.md`.

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
- Agent stdout is streamed to logs for observability.
- Timeout enforced via config (`JOB_TIMEOUT_MS`).

### 10.2 Agent Signals

Exit codes:

- `0` — success.
- `1` — failure.
- `2` — clarification needed.

Marker file (`.blazebot/output.json`):

- On success: summary of work done (used for PR description).
- On clarification: questions to post on the ticket.
- On failure: error details.

Orchestrator reads the marker file after exit to determine next actions.

### 10.3 Orchestrator Response to Exit

- `0` → read summary, create PR (if implementation) or signal done (if fixing_feedback), tear down
  container.
- `1` → read error, retry or transition to `failed`.
- `2` → read questions, post on ticket, move ticket to Backlog, notify user, tear down container.

### 10.4 Responsibilities Split

Agent (inside sandbox):

- Writes code.
- Runs tests.
- Commits and pushes to feature branch.
- Runs self-review skill.
- Merges target branch and resolves conflicts.
- Commits WIP on clarification.

Orchestrator (outside sandbox):

- Creates feature branches (via VCS adapter, before sandbox spin-up).
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
parseWebhook(req) → NormalizedEvent
```

### 11.2 VCS Adapter

```
createBranch(repo, name, base) → void
createPR(repo, branch, title, body) → PR
getPRComments(repo, prId) → liked comments + human comments
getPRConflictStatus(repo, prId) → boolean
```

### 11.3 Messaging Adapter

```
notify(userId, message) → void
ping(userId, message) → void
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
{contents of .blazebot/implement.md}
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
{contents of .blazebot/review-fix.md}
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

- Agent launched (container, prompt file).
- Agent exited (exit code).
- Clarification requested (questions).

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
3. **Agent Failures** — timeout, crash, exit code 1, marker file missing.
4. **Adapter Failures** — VCS API down (can't create PR), messaging down (can't notify), tracker
   down (can't move ticket).
5. **Infrastructure Failures** — Postgres down, Redis down, BullMQ connection lost.

### 14.2 Recovery Behavior

| Failure | Recovery |
|---------|----------|
| Webhook invalid | Log and discard, return 400 |
| Tracker API down during context fetch | Retry via BullMQ backoff |
| Container won't start | Retry via BullMQ backoff |
| Agent timeout/crash | Retry via BullMQ backoff |
| Agent clarification (exit 2) | Not a failure — normal flow |
| Can't create PR | Retry via BullMQ backoff |
| Can't move ticket | Retry, log warning |
| Can't send notification | Log warning, don't block workflow |
| Postgres down | Service unhealthy, jobs stall until recovery |
| Redis down | BullMQ unavailable, service unhealthy |
| Max retries exhausted | Ticket → `failed`, notify user |

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
- No access to production infrastructure or other containers.

### 15.2 Git Permission Scoping

- Agent can only commit and push to its feature branch.
- No other Git operations — PRs, merges to main, branch deletion are orchestrator-only.

### 15.3 Secret Handling

- Tracker API keys, VCS tokens, messaging credentials stored as env vars.
- Never logged or exposed to the agent.
- Agent receives only the scoped Git credentials it needs.

### 15.4 Network Access

- Agent has full internet access inside the container.
- No restrictions on outbound traffic.

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
  prompt = readFile(repo, ".blazebot/implement.md")
  requirementsMd = assembleContext(ticketContent, prompt)

  container = sandboxManager.spinUp(ticket.branch, requirementsMd)
  db.updateRun(run, container_id=container.id)

  exitCode = agentRunner.exec(container, requirementsMd)
  output = readMarkerFile(container, ".blazebot/output.json")

  sandboxManager.tearDown(container)

  if exitCode == 0:
    pr = vcsAdapter.createPR(repo, ticket.branch, output.title, output.summary)
    issueTrackerAdapter.moveTicket(ticketId, "AI Review")
    db.updateState(ticket, "awaiting_review")
    messagingAdapter.notify(ticket.assignee, "PR ready for review")

  else if exitCode == 2:
    issueTrackerAdapter.postComment(ticketId, output.questions)
    issueTrackerAdapter.moveTicket(ticketId, "Backlog")
    db.updateState(ticket, "clarification_pending")
    messagingAdapter.ping(ticket.assignee, "Clarification needed")

  else:
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
  prompt = readFile(repo, ".blazebot/review-fix.md")
  requirementsMd = assembleContext(ticketContent, prComments, hasConflicts, prompt)

  container = sandboxManager.spinUp(ticket.branch, requirementsMd)
  exitCode = agentRunner.exec(container, requirementsMd)
  output = readMarkerFile(container, ".blazebot/output.json")

  sandboxManager.tearDown(container)

  if exitCode == 0:
    issueTrackerAdapter.moveTicket(ticketId, "AI Review")
    db.updateState(ticket, "awaiting_review")
    messagingAdapter.notify(ticket.assignee, "Fixes applied, ready for re-review")

  else:
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

### 17.2 Sandbox Management

- Container spun up with correct branch and `requirements.md`.
- Container torn down after every run (success, failure, clarification).
- Git permissions scoped to feature branch only.

### 17.3 Agent Runner

- Exit code 0 → PR created, ticket moved to AI Review.
- Exit code 1 → retry or fail.
- Exit code 2 → questions posted, ticket moved to Backlog.
- Marker file read correctly for all exit codes.
- Timeout enforced — agent killed after `JOB_TIMEOUT_MS`.

### 17.4 Adapter Interfaces

- Each adapter implementation satisfies its interface contract.
- Webhook parsing returns normalized events.
- Invalid webhooks return 400, don't enqueue work.
- Adapter failures trigger retries (except notifications — best effort).

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
- [ ] Agent Runner — `docker exec`, exit code handling, marker file reading.
- [ ] Context assembly — `requirements.md` generation.
- [ ] Persistence — Postgres schema for tickets and run attempts.
- [ ] Stale job protection (cancel on contradicting webhook + verify at job start).
- [ ] Concurrency control via `MAX_CONCURRENT_AGENTS`.
- [ ] Structured JSON logging with ticket/run context.
- [ ] Prompt files — `.blazebot/implement.md` and `.blazebot/review-fix.md`.

### 18.2 Deferred

- [ ] Model routing (per-ticket model selection).
- [ ] Hot config reload.
- [ ] Token usage tracking.
- [ ] Dashboard / status UI.
- [ ] Metrics / alerting.
- [ ] Additional tracker adapters (Linear, Asana).
- [ ] Additional messaging adapters (Teams).
