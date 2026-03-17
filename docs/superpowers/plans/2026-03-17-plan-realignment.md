# Plan Realignment — Spec Audit & Corrections

**Date:** 2026-03-17

**Purpose:** Document how the four implementation plans diverged from `docs/BLAZEBOT_SPEC.md`, what the codebase actually implemented, and what code-level gaps remain.

**Context:** The plans were written before implementation. During implementation, many deviations were corrected in code but the plan documents were never updated. This document is the authoritative record of what drifted, what was fixed, and what still needs work.

---

## How to Read This Document

Each section covers one plan. For each plan:

- **Plan said** — what the plan document specifies
- **Spec says** — what `BLAZEBOT_SPEC.md` requires
- **Code has** — what was actually implemented in the codebase
- **Verdict** — whether the code is aligned, and what (if anything) still needs fixing

At the end, a consolidated list of **remaining code-level gaps** captures work items for future phases.

---

## Phase 1: Infrastructure Boilerplate

**Plan:** `2026-03-12-phase1-boilerplate.md`

### Verdict: ALIGNED — no issues

Phase 1 is pure infrastructure scaffolding (Docker Compose, Fastify health check, Drizzle config, env validation). It makes no domain claims and has no spec misalignment. The code matches the plan.

One minor note: the plan defined `NODE_ENV` with values `development | production`. The codebase later added `test` in Phase 2. This is a normal incremental change, not a misalignment.

---

## Phase 2: Database Schema & BullMQ

**Plan:** `2026-03-12-phase2-schema-bullmq.md`

### 2.1 Ticket Workflow State Enum

| | Values |
|---|---|
| **Plan said** | `queued`, `in_progress`, `clarifying`, `in_review`, `done`, `failed` |
| **Spec says** (Section 7.1) | `queued`, `implementing`, `clarification_pending`, `awaiting_review`, `fixing_feedback`, `completed`, `failed` |
| **Code has** | `queued`, `implementing`, `clarification_pending`, `awaiting_review`, `fixing_feedback`, `completed`, `failed` |

**Verdict:** Code is spec-aligned. Plan was wrong — it collapsed `implementing`/`fixing_feedback` into `in_progress` and renamed several states. The implementation corrected this.

### 2.2 Run Attempt Status Enum

| | Values |
|---|---|
| **Plan said** | `provisioning`, `running`, `reviewing`, `fixing`, `merging`, `completed`, `failed`, `cancelled` |
| **Spec says** (Section 4.2) | `pending`, `preparing_sandbox`, `running`, `succeeded`, `failed`, `timed_out`, `clarification_needed` |
| **Code has** | `pending`, `preparing_sandbox`, `running`, `succeeded`, `failed`, `timed_out`, `clarification_needed` |

**Verdict:** Code is spec-aligned. Plan invented statuses that don't exist in the spec (`provisioning`, `reviewing`, `fixing`, `merging`, `completed`, `cancelled`). The implementation corrected this.

### 2.3 Run Type / Trigger Enum

| | Values |
|---|---|
| **Plan said** | `agentRunTriggerEnum`: `new`, `review_fix`, `clarification_answer` |
| **Spec says** (Section 4.2) | `type`: `implementation`, `review_fix`, `conflict_resolution` |
| **Code has** | `runTypeEnum`: `implementation`, `review_fix`, `conflict_resolution` |

**Verdict:** Code is spec-aligned. Plan used `trigger` instead of `type` and invented `new`/`clarification_answer` which don't exist in the spec. Resuming after clarification re-enqueues an `implementation` job (Section 8.1), not a separate type.

### 2.4 Tickets Table Fields

| Field | Plan | Spec (Section 4.1) | Code |
|-------|------|---------------------|------|
| `id` | Yes | Yes | Yes |
| `externalId` | Yes (as `external_id`) | Yes (as `id`) | Yes |
| `identifier` | **Missing** | Yes | Yes |
| `source` | Yes | N/A (implicit) | Yes |
| `state` | **Missing** | Yes (tracker column) | Yes |
| `workflowState` | As `status` (wrong enum) | Yes | Yes (correct enum) |
| `assignee` | **Missing** | Yes | Yes |
| `branchName` | **Missing** | Yes | Yes |
| `prId` | **Missing** | Yes | Yes |
| `currentRunId` | **Missing** | Yes | Yes |
| `createdAt` | Yes | Yes | Yes |
| `updatedAt` | Yes | Yes | Yes |

**Verdict:** Code is spec-aligned. Plan was missing 6 fields. The implementation added them all.

### 2.5 Run Attempts Table Fields

| Field | Plan | Spec (Section 4.2) | Code |
|-------|------|---------------------|------|
| `id` | Yes | Yes | Yes |
| `ticketId` | Yes | Yes | Yes |
| `attemptNumber` | **Missing** | Yes | Yes |
| `type` | As `trigger` (wrong enum) | Yes | Yes (correct enum) |
| `status` | Wrong enum | Yes | Yes (correct enum) |
| `containerId` | Yes | Yes | Yes |
| `branchName` | Yes | Yes | Yes |
| `startedAt` | Yes | Yes | Yes |
| `finishedAt` | Yes | Yes | Yes |
| `error` | **Missing** | Yes | Yes |

**Verdict:** Code is spec-aligned. Plan was missing `attemptNumber` and `error`. The implementation added them.

### 2.6 `MAX_CONCURRENT_CONTAINERS` vs `MAX_CONCURRENT_AGENTS`

| | Name |
|---|---|
| **Plan said** | `MAX_CONCURRENT_CONTAINERS` |
| **Spec says** (Section 8.2) | `MAX_CONCURRENT_AGENTS` |
| **Code has** | `MAX_CONCURRENT_AGENTS` |

**Verdict:** Code is spec-aligned.

### 2.7 Table Naming

The plan called the table `agent_runs`. The spec calls the entity `RunAttempt`. The code uses `run_attempts` as the table name and `runAttempts` in Drizzle. This is a reasonable mapping — no issue.

---

## Phase 3: Adapter Interfaces & Jira Webhook

**Plan:** `2026-03-12-adapter-interfaces-webhook.md`

### 3.1 TicketAdapter Interface

| Method | Plan | Spec (Section 11.1) | Code |
|--------|------|----------------------|------|
| Fetch ticket | `getTicket(externalId)` | `fetchTicket(id)` | `fetchTicket(id)` |
| Move ticket | `moveTicket(externalId, columnName)` | `moveTicket(id, column)` | `moveTicket(id, column)` |
| Post comment | `addComment(externalId, body)` | `postComment(id, comment)` | `postComment(id, comment)` |
| Parse webhook | **Missing** | `parseWebhook(req)` | `parseWebhook(req)` |

**Verdict:** Code is spec-aligned. Plan used wrong method names and omitted `parseWebhook`. The implementation corrected all of these.

### 3.2 Ticket Interface — Missing `labels`

| | Has `labels`? |
|---|---|
| **Plan said** | No |
| **Spec says** (Section 11.1) | Yes (`fetchTicket` returns labels) |
| **Code has** | Yes (in the `Ticket` interface) |

**Verdict:** Code is spec-aligned.

### 3.3 NormalizedEvent Shape

| Field | Plan (`TicketTransitionEvent`) | Spec (Section 11.4) | Code (`NormalizedEvent`) |
|-------|-------------------------------|----------------------|--------------------------|
| `type` | **Missing** | `"ticket_moved"` | `"ticket_moved"` |
| Ticket ID | `externalTicketId` | `ticketId` | `ticketId` |
| `fromColumn` | Yes | Yes | Yes |
| `toColumn` | Yes | Yes | Yes |
| Actor | `actor` | `triggeredBy` | `triggeredBy` |
| `source` | Yes | Not in spec | Not in code |

**Verdict:** Code is spec-aligned. Plan used different field names and a different type name. The implementation corrected this and re-exports `NormalizedEvent` from `src/webhooks/types.ts`.

### 3.4 SourceControlAdapter / VCSAdapter

| Method | Plan | Spec (Section 11.2) | Code |
|--------|------|----------------------|------|
| `createBranch` | `(repoOwner, repoName, branchName, baseBranch)` | `(repo, name, base)` | `(repoOwner, repoName, branchName, baseBranch)` |
| `createPR` | `(repoOwner, repoName, title, body, head, base)` | `(repo, branch, title, body)` | `(repoOwner, repoName, title, body, head, base)` |
| `getPRComments` | Yes | Yes | Yes |
| `getPRConflictStatus` | Yes | Yes | Yes |
| `mergeBranch` | Yes | **Not in spec** | Not in code |

**Verdict:** Mostly aligned. The code uses split `(repoOwner, repoName)` parameters instead of a single `repo` param. This is a pragmatic implementation detail for the GitHub API — acceptable deviation. The plan's `mergeBranch` method was correctly not implemented (spec assigns conflict resolution to the agent inside the sandbox, Section 10.4).

### 3.5 MessagingAdapter

| Method | Plan | Spec (Section 11.3) | Code |
|--------|------|----------------------|------|
| `sendNotification(channel, message)` | Yes | `notify(message)` | `notify(userId, message)` + `ping(userId, message)` |

**Verdict:** Minor deviation. Code adds `ping` and uses `userId` instead of a bare message. The spec's `notify(message)` is minimal — the code's version is a superset. No functional issue but `ping` is not in the spec.

### 3.6 Router Dispatch Logic

| | Approach |
|---|---|
| **Plan said** | Match 4 cases by `fromColumn`/`toColumn` pattern, log stubs |
| **Spec says** (Section 8.1) | Match `toColumn === AI`, then look up `workflow_state` in DB to decide job type |
| **Code has** | Match `toColumn === AI`, then look up `workflowState` in DB |

**Verdict:** Code is spec-aligned. The plan hardcoded `from` column matching which would break if tickets arrive from unexpected columns. The code correctly uses DB state.

### 3.7 `COLUMN_AI_IN_PROGRESS` Env Var

The plan added `COLUMN_AI_IN_PROGRESS` which is not in the spec and not needed when the router uses DB-based `workflowState` dispatch. The code does not use this env var. No issue.

---

## Phase 4: Start New Work (Vertical Slice)

**Plan:** `2026-03-13-start-new-work.md`

### 4.1 Adapter Interface Corrections

The plan explicitly self-corrected Phase 3's interface misalignments, noting it uses `fetchTicket`/`postComment`/`parseWebhook` and the correct `NormalizedEvent` shape. This matches both spec and code. No issue.

### 4.2 Prompt File Path

| | Path |
|---|---|
| **Plan said** | `.blazebot/implement.md` |
| **Spec says** (Section 5) | `.blazebot/prompts/implement.md` |
| **Code has** | `prompts/implement.md` (loaded via `getFileContent`) |

**Verdict:** Code loads `prompts/implement.md`. The plan used the wrong path. See Remaining Gap #1 for detail on whether the full path `.blazebot/prompts/implement.md` is correctly used.

### 4.3 Agent Output Mechanism

| | Mechanism |
|---|---|
| **Plan said** | Exit codes (0/1/2) + marker file `.blazebot/output.json` |
| **Spec says** (Section 10.2) | Claude Code's JSON schema enforcement; "no marker file needed" |
| **Code has** | Exit codes + marker file (via `entrypoint.sh` and `sandbox/manager.ts`) |

**Verdict: CODE MISALIGNED.** The spec explicitly says the orchestrator reads structured output directly from Claude Code — no marker file. The code and plan both use the marker file approach. **This is a remaining gap.**

### 4.4 Git Permission Scoping

| | Allows `git push`? |
|---|---|
| **Plan said** | Yes (git-guard allows push to feature branch) |
| **Spec says** (Section 15.2) | No — agent cannot push. Orchestrator pushes after run. |
| **Code has** | `git-guard.sh` allows push to `$BLAZEBOT_BRANCH` |

**Verdict: CODE MISALIGNED.** The spec is explicit: "Agent can only commit locally — `git push` is not allowed from inside the container." **This is a remaining gap.**

### 4.5 Stale Job Protection

| | Has stale job check at job start? |
|---|---|
| **Plan said** | Not mentioned |
| **Spec says** (Section 8.3) | "At job start, fetch current ticket state from tracker — skip if no longer in AI." |
| **Code has** | Not implemented |

**Verdict: CODE MISALIGNED.** The worker starts executing without verifying the ticket is still in the AI column. **This is a remaining gap.**

### 4.6 Messaging/Notification Calls

| | Sends notification after PR creation? |
|---|---|
| **Plan said** | Not included |
| **Spec says** (Section 16.2) | `messagingAdapter.notify("Task " + ticket.identifier + " PR ready for review")` |
| **Code has** | No notification calls in the worker |

**Verdict: CODE MISALIGNED.** The spec's reference algorithm includes notification after PR creation and after clarification. The worker does neither. **This is a remaining gap.** (Messaging adapter has no concrete implementation yet, but the worker should call it — the adapter can be a no-op stub until Slack is wired.)

### 4.7 `review_fix` Handler

| | Implemented? |
|---|---|
| **Plan said** | Not in scope (plan covers "start new work" only) |
| **Spec says** (Section 16.3) | Full `fixing_feedback` flow defined |
| **Code has** | Throws `"review_fix handler not yet implemented"` |

**Verdict:** Expected — the plan explicitly scoped only the "start new work" flow. This is deferred work, not a misalignment.

### 4.8 Terminal State Handling (Cancel)

| | Handles ticket moved to terminal state? |
|---|---|
| **Plan said** | Not in scope |
| **Spec says** (Section 8.1) | Cancel active job, tear down container, mark failed |
| **Code has** | Router only handles `toColumn === AI`; ignores terminal transitions |

**Verdict:** Expected scope limitation. The router correctly ignores non-AI transitions, but terminal state cancellation (spec Section 8.1 item 2) is not implemented. **This is deferred work for a future phase.**

---

## Remaining Code-Level Gaps

These are items where the **code** diverges from the **spec** and need to be addressed in future work. They are not plan documentation issues — they are real implementation gaps.

### Gap 1: Agent Output — Marker File vs Structured Output

**Spec reference:** Section 10.2

**Current state:** `docker/sandbox/entrypoint.sh` writes `.blazebot/output.json` and `src/sandbox/manager.ts` reads it from the container via `getArchive`. The agent communicates results through this marker file combined with exit codes.

**Spec requires:** The agent returns structured output via Claude Code's JSON schema enforcement. The orchestrator reads the response directly. "No marker file needed."

**Fix:** Replace the marker file approach with Claude Code's `--output-format json` or equivalent structured output flag. The sandbox manager should capture Claude Code's stdout JSON response instead of reading a file from the container.

**Impact:** `docker/sandbox/entrypoint.sh`, `src/sandbox/manager.ts`, `src/sandbox/manager.test.ts`

### Gap 2: Git Guard Allows Push

**Spec reference:** Section 15.2

**Current state:** `docker/sandbox/git-guard.sh` allows `git push` to `$BLAZEBOT_BRANCH`.

**Spec requires:** "Agent can only commit locally — `git push` is not allowed from inside the container. Orchestrator pushes the feature branch after the agent run completes."

**Fix:** Block all `git push` commands in `git-guard.sh`. Add push logic to the orchestrator/worker after sandbox teardown (e.g., via the VCS adapter or a direct `git push` from the host).

**Impact:** `docker/sandbox/git-guard.sh`, `src/worker.ts` (needs post-sandbox push step)

### Gap 3: Missing Stale Job Protection

**Spec reference:** Section 8.3

**Current state:** The worker processes jobs immediately without verifying the ticket is still in the AI column.

**Spec requires:** "At job start, fetch current ticket state from tracker — skip if no longer in AI." Both cancel-on-contradicting-webhook and verify-at-job-start are needed.

**Fix:** At the start of `handleImplementation` (and future `handleReviewFix`), call `jira.fetchTicket(ticketId)` and check the current tracker state. If the ticket is no longer in the AI column, skip the job silently.

**Impact:** `src/worker.ts`

### Gap 4: Missing Notification Calls

**Spec reference:** Sections 10.3, 16.2, 16.3

**Current state:** No notification calls anywhere in the worker.

**Spec requires:** Notify after PR creation ("PR ready for review") and after clarification ("needs clarification").

**Fix:** Wire `MessagingAdapter.notify()` calls into the worker's result handlers. Create a no-op/console-log stub implementation of `MessagingAdapter` so the calls work without Slack being configured.

**Impact:** `src/worker.ts`, new `src/adapters/console-messaging.ts` (stub)

### Gap 5: Contradicting Webhook — Cancel Active Job

**Spec reference:** Section 8.3

**Current state:** The router only handles `toColumn === AI`. It does not handle tickets leaving AI (contradicting webhooks).

**Spec requires:** "On contradicting webhook (ticket moved out of AI), cancel any pending job in BullMQ."

**Fix:** Add handling in the router for transitions where `fromColumn` is an AI-related column and `toColumn` is not. Cancel the BullMQ job and tear down any active container.

**Impact:** `src/webhooks/router.ts`, `src/sandbox/manager.ts` (needs a `teardown(containerId)` export)

### Gap 6: Orchestrator Push After Sandbox

**Spec reference:** Section 10.4

**Current state:** The agent inside the sandbox may or may not push (depending on git-guard). The orchestrator does not explicitly push after sandbox teardown.

**Spec requires:** "Orchestrator pushes feature branch after agent run completes." This is the orchestrator's job, not the agent's.

**Fix:** After sandbox teardown and before PR creation, the worker should push the feature branch via VCS adapter or direct git command. This is closely tied to Gap 2 (blocking agent push).

**Impact:** `src/worker.ts`, potentially `src/adapters/source-control.ts` (add `pushBranch` if needed)

---

## Summary

| Plan | Plan Accuracy | Code Accuracy | Action Needed |
|------|--------------|---------------|---------------|
| Phase 1: Boilerplate | Correct | Correct | None |
| Phase 2: Schema & BullMQ | **Wrong** (enums, fields, naming) | Correct | Plan is stale documentation only |
| Phase 3: Adapters & Webhook | **Wrong** (method names, event shape, router logic) | Correct | Plan is stale documentation only |
| Phase 4: Start New Work | Partially wrong (prompt path, marker file, git push) | Mostly correct, 6 gaps remain | Gaps 1–6 above need implementation |

**Key takeaway:** The plans were written with significant deviations from the spec, but the implementation largely corrected them. The plans are now stale documentation. The six remaining code-level gaps are the only items that need engineering work.
