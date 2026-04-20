# Blazebot User Stories

Core behavioral stories for Blazebot. Each story has a concrete example and verifiable assertions to serve as a foundation for integration and E2E tests.

**VCS coverage:** Stories involving VCS operations (branch creation, PR, push, merge conflicts) must be tested against both **GitHub** and **GitLab**.

---

## 1. Happy Path Journeys

### US-1: Clear ticket produces a PR `[GitHub/GitLab]`

> As a developer, when I create a ticket with clear requirements and move it to the "AI" column, the agent should implement the feature and create a PR for review.

**Example ticket:**
```
Title: Add GET /api/health endpoint
Description: Create a GET /api/health route that returns { status: "ok" } with HTTP 200.
Acceptance criteria:
- Returns JSON { status: "ok" }
- HTTP 200 response
```

**Expected behavior:**
1. Ticket discovered in AI column (via cron poll or Jira webhook)
2. Agent creates branch `blazebot/awt-123`
3. Research phase analyzes repo and produces implementation plan
4. Implementation phase creates the endpoint (framework-agnostic) and commits
5. Internal review phase approves the changes
6. Changes pushed to VCS, PR created
7. Ticket moves to "AI Review" column
8. Redis entry cleaned up, sandbox torn down

**Verifications:**
- PR exists on branch `blazebot/awt-123`
- PR has at least 1 commit
- Ticket status = "AI Review"
- Redis has no entry for ticket
- No sandbox running for this ticket

---

### US-2: Ticket with attachments (integration test: fetch phase only)

> As a developer, when I attach files to a ticket, the agent should download them and make them available in the sandbox.

**Example ticket:**
```
Title: Create user profile card component
Description: Build a profile card component matching the attached mockup.
Attachments:
- profile-mockup.png (120KB, screenshot of desired UI)
- design-tokens.json (2KB, color/spacing values)
```

**Test scope:** Integration test for the attachment fetch + write phase only — not a full E2E flow.

**Expected behavior:**
1. `fetchAttachments()` downloads both files from Jira
2. Files respect size limits (`ATTACHMENT_MAX_FILE_SIZE_MB`, `ATTACHMENT_MAX_TOTAL_SIZE_MB`)
3. `writeAttachments()` writes files to `/tmp/attachments/` in sandbox
4. Files are readable inside the sandbox at expected paths

**Verifications:**
- `fetchAttachments` returns 2 items with `failed: false`
- Downloaded content matches expected sizes
- Files exist at `/tmp/attachments/profile-mockup.png` and `/tmp/attachments/design-tokens.json` in sandbox
- File contents are valid (not corrupted)

---

### US-3: Review feedback triggers a fix cycle `[GitHub/GitLab]`

> As a developer, when I leave review comments on the agent's PR and move the ticket back to "AI", the agent should address the feedback and push updates to the same PR.

**Example:**
```
Initial PR: Adds GET /api/ping returning { ping: "pong" }
Review comment: "Rename the endpoint from /api/ping to /api/healthcheck.
                 Move app/api/ping/route.ts to app/api/healthcheck/route.ts
                 and return { healthcheck: 'passed' }. The old /api/ping
                 route must no longer exist."
```

**Expected behavior:**
1. Developer adds PR comment and moves ticket back to "AI"
2. Ticket discovered (via cron poll or webhook); agent detects existing PR on branch
3. Agent does NOT reset the branch (preserves existing work)
4. Research phase reads PR comments + check results
5. Implementation phase renames the route file and updates the response body
6. Push updates to same branch; no new PR created
7. Ticket moves back to "AI Review"

**Verifications:**
- Same PR number, no duplicate PR
- PR has more commits than before the review fix
- `app/api/healthcheck/route.ts` exists with the new response body
- `app/api/ping/route.ts` no longer exists on the branch
- Ticket status = "AI Review"
- Redis cleaned up
- No sandbox running for this ticket

---

### US-4: PR with merge conflicts — agent rebases `[GitHub/GitLab]`

> As a developer, when my ticket's PR has merge conflicts, moving the ticket back to AI should trigger the agent to resolve conflicts.

**Example scenario:**
```
PR for AWT-123 has merge conflicts with main
Developer moves ticket back to AI
```

**Expected behavior:**
1. Agent detects `hasConflicts: true` from PR context
2. Sandbox provisioned with `mergeBase` set to base branch
3. Agent resolves conflicts during implementation
4. Push updated branch
5. Ticket moves back to "AI Review"

**Verifications:**
- PR no longer has merge conflicts after agent push
- PR has new commits
- Ticket status = "AI Review"
- Redis has no entry for ticket
- No sandbox running for this ticket

---

## 2. Clarification & Ambiguity Journeys

### US-5: Unclear ticket triggers clarification

> As a developer, when I create a ticket that is too vague, subjective, or ambiguous to implement, the agent should ask clarification questions and move the ticket to Backlog.

**Example ticket:**
```
Title: Change website color to my favorite color
Description: Update the primary brand color across the site to my favorite color.
```

**Expected behavior:**
1. Research phase identifies the ticket as unclear (vague, subjective, missing details, contradictory, etc.)
2. Agent returns `STATUS: clarification_needed`
3. Numbered clarification questions posted as a Jira comment
4. Ticket moves to "Backlog" column
5. Redis entry cleaned up, sandbox torn down

**Verifications:**
- Ticket status = "Backlog"
- Jira comment exists with numbered questions (1. ..., 2. ..., etc.)
- No PR created
- Redis has no entry for ticket
- No sandbox running for this ticket

---

### US-6: Clarification answered — ticket re-processed successfully `[GitHub/GitLab]`

> As a developer, after I answer the agent's clarification questions and move the ticket back to "AI", the agent should use my answers and complete the implementation.

**Example:**
```
Original ticket: "Change website color to my favorite color"
Agent asked: "1. What is your favorite color?"
Developer comment: "1. Use #FF6B35 (orange)"
Developer moves ticket back to "AI"
```

**Expected behavior:**
1. Agent reads previous session memory from `blazebot/memory/AWT-123.md`
2. Research phase reads Jira comments including the answer
3. Agent implements with the specified color `#FF6B35`
4. PR created with the color change
5. Ticket moves to "AI Review"

**Verifications:**
- PR diff contains `#FF6B35` or equivalent
- Ticket status = "AI Review"
- Redis has no entry for ticket
- No sandbox running for this ticket

---

## 3. Failure & Recovery

### US-7: Agent failure moves ticket to Backlog

> As a developer, when the agent fails for any reason (timeout, error, unresolvable issue), the ticket should be moved to Backlog and resources cleaned up.

**Failure scenarios (any of these):**
- Research phase times out (exceeds 20-minute limit)
- Implementation phase times out (exceeds 35-minute limit)
- Agent returns `{ result: "failed" }`
- Unhandled exception in the workflow

**Expected behavior:**
1. Ticket moves to "Backlog"
2. Redis entry cleaned up
3. Sandbox torn down

**Verifications:**
- Ticket status = "Backlog"
- No PR created
- Redis has no entry for ticket
- No sandbox running for this ticket

---

### US-8: Previously failed ticket is skipped on re-poll

> As a developer, if a ticket has previously failed, the cron poller should skip it to avoid infinite retry loops — until I move it out of AI and back.

**Expected behavior:**
1. Ticket AWT-123 fails and is marked as failed in Redis
2. Developer does NOT move the ticket (stays in AI column)
3. Next cron poll: ticket is discovered but skipped (`previously_failed`)
4. No new workflow started

**Verifications:**
- Dispatch returns `{ started: false, reason: "previously_failed" }`
- No workflow started

---

### US-9: Failed marker cleared when ticket leaves AI

> As a developer, when I move a previously-failed ticket out of the AI column, the failed marker should be cleared so it can be retried later.

**Expected behavior:**
1. Ticket AWT-123 is marked as failed in Redis
2. Developer moves ticket from "AI" to "Backlog" (or any non-AI column)
3. Next reconciliation cycle detects ticket is no longer in AI
4. Failed marker cleared from Redis

**Verifications:**
- Redis failed marker removed for ticket
- If developer moves ticket back to AI later, it will be processed normally

---

## 4. Discovery & Dispatch

### US-10: Duplicate dispatch prevented by atomic claim

> As a developer, even if two cron polls overlap or a webhook fires at the same time as a poll, only one workflow should start per ticket.

**Example scenario:**
```
Cron poll A discovers AWT-123 at T=0
Cron poll B discovers AWT-123 at T=0.5s (overlapping)
```

**Expected behavior:**
1. First dispatch atomically claims AWT-123 via Redis HSETNX
2. Second dispatch attempt finds ticket already claimed
3. Only one workflow starts

**Verifications:**
- Dispatch #1: `{ started: true }`
- Dispatch #2: `{ started: false, reason: "already_claimed" }`
- Exactly one workflow running for the ticket

---

### US-11: Capacity limit respected

> As a developer, the system should not start more sandboxes than the configured `MAX_CONCURRENT_AGENTS` limit.

**Example scenario:**
```
MAX_CONCURRENT_AGENTS = 3
3 sandboxes already running
New ticket AWT-456 moved to AI column
```

**Expected behavior:**
1. Cron discovers AWT-456
2. Capacity check: 3 active sandboxes >= 3 max
3. Dispatch skipped for AWT-456 (`at_capacity`)
4. Ticket remains in AI column, will be picked up when a slot frees

**Verifications:**
- Dispatch returns `{ started: false, reason: "at_capacity" }`
- No workflow started
- Ticket remains in AI column (not moved)

---

### US-12: Ticket moved out of AI during dispatch

> As a developer, if I move a ticket out of the AI column while the agent is in the process of claiming it, the dispatch should abort cleanly.

**Example scenario:**
```
T=0: Cron discovers AWT-123 in AI column
T=0.1s: Developer moves AWT-123 to "In Progress"
T=0.2s: Dispatch fetches ticket — status is "In Progress"
```

**Expected behavior:**
1. Atomic claim succeeds (Redis)
2. Fetch ticket: status is no longer "AI"
3. Claim released in Redis
4. Dispatch returns `not_in_ai_column`

**Verifications:**
- Dispatch returns `{ started: false, reason: "not_in_ai_column" }`
- Redis claim cleaned up
- No workflow started

---

### US-13: Webhook-triggered immediate dispatch

> As a developer, when Jira sends a webhook on ticket status change, the agent should start processing immediately without waiting for the next cron poll.

**Example scenario:**
```
Developer moves AWT-123 to AI column
Jira fires webhook to /webhooks/jira
```

**Expected behavior:**
1. Webhook received with valid HMAC signature
2. Ticket extracted from webhook payload
3. Dispatch triggered immediately
4. Workflow starts within seconds

**Verifications:**
- Webhook returns 200
- Workflow started for the ticket
- Processing begins without waiting for next cron cycle

---

## 5. Reconciliation

### US-14: Stale claim cleaned up

> As a developer, if a dispatch process crashes after claiming a ticket but before starting a workflow, the stale claim should be cleaned up within 5 minutes.

**Example scenario:**
```
T=0: Dispatch claims AWT-123 (Redis entry: "claiming:1713200000000")
T=0.1s: Dispatch process crashes before starting workflow
T=5min: Reconciliation runs
```

**Expected behavior:**
1. Reconciliation finds claim older than 5 minutes
2. Any sandbox matching the ticket branch is stopped (covers the case where dispatch crashed between `start()` and `register()`, leaving a sentinel in Redis but a live sandbox)
3. Stale claim removed from Redis
4. Ticket can be picked up by next poll cycle

**Verifications:**
- Redis entry removed
- No sandbox running for this ticket
- Next dispatch for same ticket succeeds

---

### US-15: Orphaned run cancelled when ticket leaves AI

> As a developer, if I move a ticket out of the AI column while the agent is still working, the running workflow should be cancelled and cleaned up.

**Example scenario:**
```
AWT-123 is being processed (workflow running)
Developer moves AWT-123 from "AI" to "In Progress"
```

**Expected behavior:**
1. Reconciliation detects AWT-123 is no longer in AI column
2. Verifies with Jira API that ticket truly left AI (not just poll lag)
3. Workflow cancelled
4. Sandbox stopped
5. Redis entry removed

**Verifications:**
- Workflow status = cancelled
- No sandbox running for the ticket
- Redis has no entry for ticket

