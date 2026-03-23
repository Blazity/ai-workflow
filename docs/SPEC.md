# Blazebot Service Specification

Status: Draft v2

Purpose: Define a workflow-driven automation service that polls an issue tracker for tickets assigned
to AI, implements features end-to-end inside isolated Vercel Sandboxes, and delivers merge-ready
pull requests for human approval.

## 1. Problem Statement

Blazebot is a workflow-driven automation service that polls an issue tracker for tickets assigned to
AI, implements features end-to-end inside isolated Vercel Sandboxes, and delivers merge-ready pull
requests for human approval.

The service solves four operational problems:

- It turns ticket implementation into a fully automated pipeline — from assignment through TDD,
  code review, conflict resolution, and PR delivery — without manual intervention.
- It isolates agent execution in per-ticket Vercel Sandboxes so agent commands cannot affect
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

- Poll the issue tracker on a configurable interval to discover tickets assigned to AI and dispatch
  Vercel Workflow runs.
- Use Vercel Workflows as the durable orchestration layer — workflow state survives failures and
  restarts automatically. No external persistence needed for MVP.
- Individual agent runs are stateless — each run spins up a fresh sandbox, fetches context from the
  tracker, and tears down on completion.
- Spin up isolated Vercel Sandboxes per ticket with scoped Git permissions.
- Enforce TDD — integration and e2e tests are required, not optional.
- Run iterative code review loops (AI review → human feedback → agent fix) until clean.
- Handle conflict resolution (merge target branch, resolve conflicts, re-review).
- Manage two ticket transitions directly: move to **AI Review** when implementation passes
  self-review, and move to **Backlog** when clarification is needed.
- Notify users via Chat SDK (Slack/Teams) when user action is required (e.g., clarification needed,
  PR ready for review).
- Support clarification flow — commit work-in-progress, tear down sandbox, post questions on
  ticket, and resume in a fresh sandbox with full conversation history when answered.
- Support adapter modularity — all external integrations behind isolated interfaces so swapping
  e.g. Jira → Linear is a single-module replacement.
- Design for self-hosting — users provide their own API keys (issue tracker, VCS, messaging, AI
  model) and run the service on their own infrastructure. The project is intended to be open source.

### 2.2 Non-Goals

- Rich multi-tenant control plane or SaaS UI.
- General-purpose CI/CD or workflow engine.
- Replacing human final approval on PRs.
- Built-in IDE or code editor.
- Prescribing a specific dashboard or terminal UI implementation.
- Webhook-driven event ingestion (polling only for MVP).

## 3. System Overview

### 3.1 Main Components

1. **Poller** (Vercel Workflow with sleep)
   - Runs as a long-lived Vercel Workflow that sleeps between poll cycles (`POLL_INTERVAL_MS`, default 15s).
   - Queries the issue tracker for tickets in the AI column.
   - For each discovered ticket, starts a Vercel Workflow run if one is not already active.
   - Started via `GET /poll/start` route which ensures singleton operation. Vercel Cron hits this
     route every 15 minutes as a liveness check — if the workflow died, the route restarts it.

2. **Issue Tracker Adapter**
   - Reads ticket data (description, acceptance criteria, comments, labels).
   - Writes ticket transitions (→ AI Review, → Backlog).
   - Posts clarifying questions as ticket comments.
   - Searches for tickets by column/status (JQL or equivalent).

3. **Messaging Adapter** (Chat SDK — chat-sdk.dev)
   - Sends status notifications (Slack/Teams) via Chat SDK.
   - Pings users on clarification requests.
   - Chat SDK provides a unified interface for Slack and Teams — no per-platform adapter needed.

4. **VCS Adapter**
   - Creates feature branches.
   - Creates pull requests.
   - Pushes feature branches after agent run completes.
   - Fetches PR comments (liked + human-written).
   - Reports PR conflict status.

5. **Orchestrator** (Vercel Workflow)
   - Decides what action to take based on ticket state and existing PR state.
   - Runs `implementation` and `fixing_feedback` steps as durable workflow steps.
   - Handles retries with built-in Vercel Workflow retry semantics.
   - Verifies ticket is still in AI column at workflow start (stale job protection).

6. **Sandbox Manager**
   - Provisions Vercel Sandboxes with the project repository.
   - Checks out the repo on the feature branch.
   - Writes `requirements.md` inside the sandbox with assembled context.
   - Injects Anthropic API key (`ANTHROPIC_API_KEY`) for Claude Code authentication.
   - Runs sandbox end hook before teardown (see Section 9.4).
   - Tears down sandboxes after every run.

7. **Agent Runner**
   - Launches the coding agent (Claude Code / Codex) inside the sandbox via the Vercel Sandbox API.
   - Reads structured output (JSON schema enforced) to determine outcome.
   - Enforces timeouts.

8. **Logging & Observability**
   - Structured JSON logs with ticket/run context.
   - Dashboard, metrics, and token tracking deferred.

### 3.2 Abstraction Layers

1. **Adapter Layer** — Issue tracker, messaging (Chat SDK), VCS adapters (all behind interfaces,
   swappable).
2. **Orchestration Layer** — Vercel Workflows for dispatch, retries, ticket state decisions.
3. **Execution Layer** — Sandbox lifecycle, agent runner, Vercel Sandbox management.
4. **Observability Layer** — Logging, metrics, optional dashboard.

### 3.3 External Dependencies

MVP:

- Issue tracker API (Jira).
- Chat SDK (chat-sdk.dev) for Slack/Teams messaging.
- VCS API (GitHub).
- Vercel Workflows (durable orchestration).
- Vercel Sandbox (isolated agent execution).
- Anthropic API (Claude Code authentication).
- Coding agent (Claude Code / Codex).

Deferred: Linear, GitLab, Docker (for self-hosted sandbox), Postgres (for audit/reporting).

## 4. Core Domain Model

### 4.1 Workflow Run State

For MVP, workflow state lives inside the Vercel Workflow run — no external database. The workflow
tracks:

- `ticketId` — stable tracker-internal ID.
- `identifier` — human-readable key (e.g., `PROJ-123`).
- `workflowState` — Blazebot's internal lifecycle state (see Section 7).
- `branchName` — feature branch for this ticket.
- `prId` — pull request reference (set after PR creation).
- `attemptNumber` — current attempt count for retries.

Ticket content (title, description, acceptance criteria, comments, labels) is always fetched fresh
from the tracker API — never stored.

### 4.2 Run Attempt

Run attempts are not persisted to a database for MVP. The Vercel Workflow run itself serves as the
record of execution. Structured logs capture run events (start, exit code, duration) for
observability.

Retries are handled by Vercel Workflow's built-in retry semantics. No custom retry entity needed.

## 5. Agent Prompt Contract

Prompt files live in the Blazebot service repository and are written into the sandbox at setup. This
keeps prompts easy to edit and version without touching client repos.

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

When resuming after clarification, `.blazebot/prompts/implement.md` is used again. The Q&A context
comes from ticket comments (fetched fresh), not from the prompt file.

If a prompt file is missing, the run fails with a clear error.

The coding agent uses a default model for all runs. Model routing (per-ticket model selection based
on labels or complexity) is deferred.

## 6. Configuration

All runtime config lives in environment variables, validated at startup.

Key config groups:

- **Sandbox:** concurrency limit (`MAX_CONCURRENT_AGENTS`), job timeout (`JOB_TIMEOUT_MS`).
- **Polling:** interval between cycles (`POLL_INTERVAL_MS`, default 15s).
- **Issue Tracker:** adapter kind (`ISSUE_TRACKER_KIND`), project key (`JIRA_PROJECT_KEY`),
  credentials.
- **Messaging:** Chat SDK credentials (`CHAT_SDK_API_KEY`), channel config.
- **VCS:** adapter kind (`VCS_KIND`), credentials.
- **Agent:** Anthropic API key (`ANTHROPIC_API_KEY`), commit author (`COMMIT_AUTHOR`,
  default `ai-workflow-blazity`).
- **Vercel:** API token, team ID.

If required config is missing or invalid, the service fails startup with a clear error.

## 7. Orchestration State Machine

### 7.1 Ticket Workflow States

1. `queued` — ticket discovered by poller, workflow started.
2. `implementing` — agent working on implementation + self-review.
3. `clarification_pending` — waiting for user answers, sandbox torn down.
4. `awaiting_review` — PR created, sandbox torn down, waiting for human.
5. `fixing_feedback` — agent fixing review comments + self-review + conflict resolution + CI.
6. `completed` — PR ready for human final approval.
7. `failed` — unrecoverable failure.

### 7.2 Transitions

```
queued → implementing                    (sandbox spun up)
implementing → clarification_pending     (agent needs answers, sandbox torn down)
implementing → awaiting_review           (PR created, sandbox torn down)
implementing → failed                    (unrecoverable error)
clarification_pending → implementing     (user answers, moves ticket back to AI)
awaiting_review → fixing_feedback        (human moves ticket to AI In Progress)
fixing_feedback → awaiting_review        (fixes done, re-review)
fixing_feedback → completed              (CI passes, PR ready)
fixing_feedback → failed                 (unrecoverable error)
any → failed                             (max retries exhausted)
```

### 7.3 Sandbox Lifecycle

Sandboxes are alive only during `implementing` and `fixing_feedback`. Torn down on every other
transition.

### 7.4 Retry Strategy

- Vercel Workflow's built-in retry with backoff.
- Retry config (max attempts, backoff) set per workflow step.
- After max retries exhausted → ticket transitions to `failed`.

## 8. Ticket Discovery and Job Dispatch

### 8.1 Polling

The poller runs as a long-lived Vercel Workflow that sleeps `POLL_INTERVAL_MS` (default 15s)
between cycles and queries the issue tracker for tickets in the AI column. For each discovered ticket:

1. Check if a Vercel Workflow run is already active for this ticket — if so, skip.
2. Determine run type based on ticket state:
   - No existing PR → first time, start `implementation` workflow.
   - Existing PR with review comments → start `fixing_feedback` workflow.
   - Ticket was previously in clarification (detected via tracker comments/state) → start
     `implementation` workflow with Q&A context from comments.

### 8.2 Concurrency Control

- `MAX_CONCURRENT_AGENTS` — global limit on running sandboxes.
- Enforced at the workflow level before sandbox spin-up. If at capacity, the ticket is skipped and
  will be picked up on the next poll cycle.

### 8.3 Stale Job Protection

- **Layer 1 — Workflow-start verification:** At workflow start, fetch current ticket state from
  tracker — skip if no longer in AI.
- **Layer 2 — Polling idempotency:** The poller skips tickets that already have an active workflow
  run, preventing duplicate work.

Webhook-based cancellation and stuck job detection are deferred (see Section 18.2).

Blazebot-initiated transitions (not poll triggers):

- → **AI Review** when PR is ready.
- → **Backlog** when clarification is needed.

## 9. Sandbox Management

### 9.1 Sandbox Setup

For each run, the Sandbox Manager:

1. Provisions a Vercel Sandbox with the project repository.
2. Checks out the repo on the feature branch (branch created by orchestrator if first run).
3. Writes `requirements.md` inside the sandbox with assembled context.
4. Agent has scoped Git permissions — can only commit locally, no remote operations.
5. Injects the Anthropic API key (`ANTHROPIC_API_KEY`) into the sandbox for Claude Code
   authentication.
6. Configures the commit author to `COMMIT_AUTHOR` env var (default: `ai-workflow-blazity`).

### 9.2 Context Assembly per Run Type

- **`implementation`**: ticket content (fetched fresh, including all comments) +
  `.blazebot/prompts/implement.md`.
- **`fixing_feedback`**: ticket content (fetched fresh, including all comments) + PR diff + liked
  comments + human comments + conflict info if applicable + `.blazebot/prompts/review-fix.md`.

### 9.3 Teardown

Sandbox is destroyed after every run — no sandbox survives between workflow states.

### 9.4 Sandbox End Hook

Before teardown, the orchestrator runs a sandbox end hook:

1. Execute `git status` inside the sandbox.
2. If uncommitted changes exist, force the agent to commit or discard them.
3. This ensures no work is silently lost when a sandbox session ends.

The hook runs regardless of agent exit status (success, failure, clarification). It is the last
operation before the orchestrator pushes the branch and tears down the sandbox.

### 9.5 Safety Invariants

- Agent Git permissions scoped to its feature branch only.
- Sandbox is isolated — no access to production infrastructure or other sandboxes.
- All commits authored as `COMMIT_AUTHOR` (configurable via env var, default:
  `ai-workflow-blazity`).

## 10. Agent Runner

### 10.1 Launch

- Orchestrator launches the coding agent (Claude Code / Codex) inside the sandbox via the Vercel
  Sandbox API.
- Agent authenticates with the Anthropic API using the injected `ANTHROPIC_API_KEY`.
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
produce structured output, the run is treated as failed and retried by the workflow.

### 10.3 Orchestrator Response to Result

- `implemented` → run sandbox end hook, push branch, create PR (if implementation) or signal done
  (if fixing_feedback), tear down sandbox.
- `failed` → run sandbox end hook, push branch (preserve WIP), retry or transition to `failed`,
  tear down sandbox.
- `clarification_needed` → run sandbox end hook, push branch (preserve WIP), post questions on
  ticket, move ticket to Backlog, notify user, tear down sandbox.

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
- Runs sandbox end hook (force commit/discard uncommitted changes).
- Pushes feature branch after agent run completes.
- Creates PRs (via VCS adapter).
- Moves tickets between columns.
- Posts clarification questions on ticket.
- Sends notifications via Chat SDK.
- Tears down sandboxes.

## 11. Adapter Interfaces

### 11.1 Issue Tracker Adapter

```
fetchTicket(id) → TicketContent (title, description, acceptance criteria, comments, labels)
moveTicket(id, column) → void
postComment(id, comment) → void
searchTickets(query) → string[] (ticket keys matching query)
```

### 11.2 VCS Adapter

```
createBranch(repo, name, base) → void
createPR(repo, branch, title, body) → PR
push(repo, branch) → void
getPRComments(repo, prId) → liked comments + human comments
getPRConflictStatus(repo, prId) → boolean
findPR(repo, branch) → PR | null
```

**Empty repository handling:** `createBranch` must handle the case where the target repository has
no commits. GitHub's Git API returns a 409 ("Git Repository is empty") when attempting to read refs
from an empty repo. When this occurs, the adapter seeds the repository with an initial commit
(README.md) using the Contents API (`repos.createOrUpdateFileContents`), then uses the resulting
commit SHA as the base for branch creation. Low-level Git endpoints (`git.createTree`,
`git.createCommit`, `git.createRef`) also return 409 on empty repos — only the Contents API can
bootstrap them. If the seed commit fails, the error is wrapped with repository context and
propagated.

### 11.3 Messaging Adapter (Chat SDK)

```
notify(channel, message) → void
```

Implemented via Chat SDK (chat-sdk.dev), which provides a unified API for Slack and Teams. The
adapter wraps Chat SDK — swapping messaging platforms requires only a config change, not a code
change.

### 11.4 Adapter Registration

- Active adapters configured via env (`ISSUE_TRACKER_KIND`, `VCS_KIND`).
- Messaging is always Chat SDK — platform selection (Slack/Teams) is a Chat SDK config concern.
- Swapping an adapter is a single-module replacement with no changes to core logic.

## 12. Context Assembly

The Sandbox Manager writes `requirements.md` inside the sandbox before the agent starts. The format
is fixed.

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
- `workflow_run_id` (when applicable)

### 13.2 Key Events to Log

Orchestrator events:

- Ticket discovered by poller (ticket, run type).
- Workflow started (ticket, run type).
- Workflow step completed / failed.
- Ticket state transition (from → to).
- Sandbox spin-up / teardown.
- Sandbox end hook result (committed / discarded / clean).
- Retry scheduled (attempt number, reason).

Agent events:

- Agent launched (sandbox ID, run type).
- Agent exited (exit code, duration).
- Clarification requested (no question content — only the event itself).

No client-specific content (ticket data, code, questions) may appear in logs.

Adapter events:

- PR created.
- Comment posted on ticket.
- Notification sent via Chat SDK.

### 13.3 Log Format

Structured JSON logs to stdout. Deployment decides where they go (file, log aggregator, etc.).

### 13.4 Deferred

- Dashboard / status UI.
- Metrics / alerting.
- Token usage tracking.

## 14. Failure Model and Recovery

### 14.1 Failure Classes

1. **Polling Failures** — tracker API down, query timeout.
2. **Sandbox Failures** — Vercel Sandbox won't provision, API error, quota exceeded.
3. **Agent Failures** — timeout, crash, invalid structured output.
4. **Adapter Failures** — VCS API down (can't create PR), Chat SDK down (can't notify), tracker
   down (can't move ticket).
5. **Infrastructure Failures** — Vercel Workflow service degradation.

### 14.2 Recovery Behavior

| Failure                               | Recovery                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| Tracker API down during poll          | Next poll cycle retries automatically                           |
| Tracker API down during context fetch | Retry via Vercel Workflow backoff                                |
| Empty repository (no commits)         | VCS adapter seeds repo with initial commit, then creates branch |
| Sandbox won't provision               | Retry via Vercel Workflow backoff                                |
| Agent timeout/crash                   | Retry via Vercel Workflow backoff                                |
| Agent clarification                   | Not a failure — normal flow                                     |
| Can't create PR                       | Retry via Vercel Workflow backoff                                |
| Can't move ticket                     | Retry, log warning                                              |
| Can't send notification               | Log warning, don't block workflow                               |
| Vercel Workflow degradation           | Workflows are durable — resume automatically when service recovers |
| Max retries exhausted                 | Ticket → `failed`, notify user                                  |

Notifications are best-effort — never block the workflow.

### 14.3 Recovery After Failure

- Vercel Workflows are inherently durable — workflow state survives failures and restarts
  automatically.
- No filesystem-based or database-based recovery needed for MVP.
- Orphaned sandboxes (from workflow failures) are detected and cleaned up by the poller.

## 15. Security and Operational Safety

### 15.1 Sandbox Isolation

- Each agent runs in an isolated Vercel Sandbox.
- Sandbox has limited filesystem and system-level permissions.
- No access to production infrastructure or other sandboxes.

### 15.2 Git Permission Scoping

- Agent can only commit locally — `git push` is not allowed from inside the sandbox.
- Orchestrator pushes the feature branch after the agent run completes.
- PRs, merges to main, branch deletion are orchestrator-only.
- Enforced via allowed command list inside the sandbox (no remote Git operations).
- Sandbox end hook enforces that no uncommitted changes are lost (see Section 9.4).

### 15.3 Secret Handling

- Tracker API keys, VCS tokens, Chat SDK credentials stored as env vars.
- Never logged or exposed to the agent.
- Agent receives only the Anthropic API key and scoped Git credentials it needs.

### 15.4 Network Access

- Agent has full internet access inside the sandbox.
- No restrictions on outbound traffic.
- Network traffic logging capabilities depend on Vercel Sandbox features. MVP logs what is
  available — connection metadata preferred over request/response content.

## 16. Reference Algorithms

### 16.1 Poller

```
poll_workflow():
  while true:
    ticketKeys = issueTrackerAdapter.searchTickets("column = AI")

    for key in ticketKeys:
      if hasActiveWorkflowRun(key): continue
      if atConcurrencyLimit(): break

      workflow.start("ticket_workflow", {
        ticketId: key,
        identifier: key
      })

    reconcileRegistry(ticketKeys)
    sleep(POLL_INTERVAL_MS)
```

### 16.2 Ticket Workflow (Vercel Workflow)

```
ticket_workflow(input):
  ticketId = input.ticketId

  // Stale job protection
  currentState = issueTrackerAdapter.fetchTicket(ticketId).state
  if currentState != "AI": return // skip

  // Determine run type based on ticket state
  existingPR = vcsAdapter.findPR(repo, ticketId)

  if existingPR and existingPR.hasReviewComments:
    run_fixing_feedback(ticketId, existingPR)
  else:
    run_implementation(ticketId)
```

### 16.3 Implementation Step

```
run_implementation(ticketId):
  ticketContent = issueTrackerAdapter.fetchTicket(ticketId)

  branchName = deriveBranchName(ticketContent.identifier)
  vcsAdapter.createBranch(repo, branchName, "main")

  prompt = readFile(repo, ".blazebot/prompts/implement.md")
  requirementsMd = assembleContext(ticketContent, prompt)

  sandbox = sandboxManager.spinUp(branchName, requirementsMd)
  output = agentRunner.exec(sandbox, requirementsMd) // returns structured JSON

  sandboxManager.runEndHook(sandbox) // force commit/discard uncommitted changes
  vcsAdapter.push(repo, branchName)
  sandboxManager.tearDown(sandbox)

  if output.result == "implemented":
    pr = vcsAdapter.createPR(repo, branchName, output.title, output.summary)
    issueTrackerAdapter.moveTicket(ticketId, "AI Review")
    messagingAdapter.notify(channel, "Task " + ticketContent.identifier + " PR ready for review")

  else if output.result == "clarification_needed":
    issueTrackerAdapter.postComment(ticketId, output.questions)
    issueTrackerAdapter.moveTicket(ticketId, "Backlog")
    messagingAdapter.notify(channel, "Task " + ticketContent.identifier + " needs clarification")

  else: // "failed" or invalid output
    throw // Vercel Workflow handles retry
```

### 16.4 Fixing Feedback Step

```
run_fixing_feedback(ticketId, existingPR):
  ticketContent = issueTrackerAdapter.fetchTicket(ticketId)
  prComments = vcsAdapter.getPRComments(repo, existingPR.id)
  hasConflicts = vcsAdapter.getPRConflictStatus(repo, existingPR.id)
  prompt = readFile(repo, ".blazebot/prompts/review-fix.md")
  requirementsMd = assembleContext(ticketContent, prComments, hasConflicts, prompt)

  sandbox = sandboxManager.spinUp(existingPR.branchName, requirementsMd)
  output = agentRunner.exec(sandbox, requirementsMd) // returns structured JSON

  sandboxManager.runEndHook(sandbox) // force commit/discard uncommitted changes
  vcsAdapter.push(repo, existingPR.branchName)
  sandboxManager.tearDown(sandbox)

  if output.result == "implemented":
    issueTrackerAdapter.moveTicket(ticketId, "AI Review")
    messagingAdapter.notify(channel, "Task " + ticketContent.identifier + " fixes applied, ready for re-review")

  else: // "failed" or invalid output
    throw // Vercel Workflow handles retry
```

## 17. Test and Validation Matrix

### 17.1 Orchestration

- Poller discovers ticket in AI column → starts workflow, runs implementation.
- Poller discovers ticket in AI column (with prior clarification) → starts workflow, runs
  implementation with Q&A context.
- Poller discovers ticket in AI column (with existing PR + review comments) → starts workflow, runs
  fixing_feedback.
- Stale job protection — workflow skipped if ticket no longer in AI at start.
- Max retries exhausted → ticket transitions to `failed`, user notified.
- Poller skips tickets with active workflow runs (idempotent).
- Concurrency limit respected — tickets skipped when at capacity.

### 17.2 Sandbox Management

- Sandbox provisioned with correct branch and `requirements.md`.
- Sandbox torn down after every run (success, failure, clarification).
- Git permissions scoped to feature branch only.
- Sandbox end hook runs before teardown — uncommitted changes committed or discarded.
- Commit author matches `COMMIT_AUTHOR` env var.

### 17.3 Agent Runner

- Exit code 0 → PR created, ticket moved to AI Review.
- Exit code 1 → retry or fail.
- Exit code 2 → questions posted, ticket moved to Backlog.
- Structured output parsed correctly for all result types.
- Timeout enforced — agent killed after `JOB_TIMEOUT_MS`.

### 17.4 Adapter Interfaces

- Each adapter implementation satisfies its interface contract.
- Adapter failures trigger retries (except notifications — best effort).
- VCS `createBranch` on empty repo (409) → seeds repo with initial commit, then creates branch.
- VCS `createBranch` on empty repo with seed failure → wraps error with repository context.
- VCS `createBranch` non-409 errors from `getRef` → propagated unchanged.
- Chat SDK notifications delivered to correct channel for Slack and Teams.

### 17.5 Context Assembly

- Implementation context includes full ticket content + all comments + prompt.
- Fixing feedback context includes ticket content + PR comments + conflict info + prompt.
- Missing prompt file fails the run immediately.

### 17.6 Workflow State Machine

- All transitions from Section 7.2 are tested.
- No invalid transitions possible.

### 17.7 Integration (Recommended)

- End-to-end: ticket in AI column → implementation → PR created → review fix → completed.
- Clarification flow: implementation → clarification → resume → PR created.

## 18. Implementation Checklist

### 18.1 Required for MVP

- [ ] Poller — Vercel Cron that queries issue tracker and dispatches workflow runs.
- [ ] Issue Tracker adapter (Jira first).
- [ ] VCS adapter (GitHub).
- [ ] Messaging adapter (Chat SDK — chat-sdk.dev — for Slack/Teams).
- [ ] Orchestrator — Vercel Workflow with polling → dispatch logic and workflow state machine.
- [ ] Vercel Workflow steps for `implementation` and `fixing_feedback`.
- [ ] Sandbox Manager — Vercel Sandbox lifecycle (provision, exec, teardown).
- [ ] Sandbox end hook — detect uncommitted changes, force commit or discard.
- [ ] Agent Runner — Vercel Sandbox API execution, structured output parsing, schema validation.
- [ ] Agent authentication via Anthropic API key (`ANTHROPIC_API_KEY`).
- [ ] Context assembly — `requirements.md` generation.
- [ ] Stale job protection (verify at workflow start + polling idempotency).
- [ ] Concurrency control via `MAX_CONCURRENT_AGENTS`.
- [ ] Configurable commit author via `COMMIT_AUTHOR` env var.
- [ ] Structured JSON logging with ticket/run context.
- [ ] Prompt files — `.blazebot/prompts/implement.md` and `.blazebot/prompts/review-fix.md`.

### 18.2 Deferred

- [ ] Ticket cancellation flow (cancel active workflows when ticket moved to terminal state).
- [ ] Webhook-driven event ingestion (complement polling with real-time webhooks).
- [ ] Stuck job detection and recovery.
- [ ] Persistence layer (Postgres) for audit trail, run history, and reporting.
- [ ] Docker sandbox provider (for self-hosted deployments without Vercel).
- [ ] Model routing (per-ticket model selection).
- [ ] Hot config reload.
- [ ] Token usage tracking.
- [ ] Admin panel / dashboard (scope TBD — open question around exposing cost data to clients).
- [ ] Metrics / alerting.
- [ ] Additional tracker adapters (Linear, Asana).
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
- [ ] Network egress controls — web searches from sandboxes can leak sensitive data. MVP logs
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
