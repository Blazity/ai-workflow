# Start New Work — Vertical Slice Design

## Overview

Wire the full happy path for "ticket moved to AI column": webhook → BullMQ job → worker orchestrates GitHub branch creation, Docker sandbox, Claude Code execution, and post-run actions (PR creation or clarification questions).

This phase replaces the router's `console.log` stub for the "start new work" case with a real end-to-end flow.

## End-to-End Flow

```
Jira webhook → Parser (extract transition + full ticket context)
  → Router(event, context) → BullMQ job (enqueue with ticket context)
    → Worker picks up job:
      1. Upsert ticket in DB, create agent_run record
      2. Create branch blazebot/{ticket-key} via GitHub API (reuse if exists)
      3. Generate requirements.md from ticket data
      4. Spin up prebuilt Docker container:
         - Clone repo on feature branch
         - Inject requirements.md + prompt.md (with branch name substituted)
         - Run Claude Code non-interactively
      5. Wait for container exit
      6. Read output/result.json from container
      7. Based on result.json content (exit code is only a crash indicator):
         - "complete": Create PR via GitHub API, move ticket to AI Review, log notification
         - "needs_clarification": Post questions as Jira comment, move ticket to Backlog, log notification
         - missing/unparseable: treat as failure
```

## Component Design

### 1. Expanded Jira Webhook Parser (`src/webhooks/jira.ts`)

The current parser only extracts transition info. Expand to also extract the full issue context from the webhook payload. The Jira `issue:updated` webhook includes the full `issue` object.

New Zod schema additions to the existing `jiraWebhookSchema`:

```typescript
issue: z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.string().nullable().transform(v => v ?? ""),
    comment: z.object({
      comments: z.array(z.object({
        author: z.object({ displayName: z.string() }),
        body: z.string(),
        created: z.string(),
      })),
    }).optional(),
    labels: z.array(z.string()).optional(),
  }).optional(),
}),
```

The `fields` block is optional so the existing parser doesn't break for webhooks that don't include it. When present, the data flows into the job payload.

New return type alongside `TicketTransitionEvent`:

```typescript
export type JiraTicketContext = {
  externalTicketId: string;
  title: string;
  description: string;
  comments: { author: string; body: string; createdAt: string }[];
  labels: string[];
};
```

`parseJiraWebhook` returns `{ event: TicketTransitionEvent; context: JiraTicketContext | null } | null`.

**Note on `JiraTicketContext` vs `Ticket` interface:** `JiraTicketContext` is a webhook-layer DTO representing raw data extracted from the Jira payload. The `Ticket` interface in `src/adapters/ticket.ts` is the adapter's domain model (with `Date` objects, `acceptanceCriteria`, etc.). They serve different bounded contexts and are intentionally separate. The worker converts between them as needed.

**Note on `acceptanceCriteria`:** Jira stores acceptance criteria in a custom field that varies by instance. Extracting it requires a configurable custom field ID. This is deferred to a future phase — for now, acceptance criteria should be included in the ticket description by the user.

### 2. Job Enqueueing (`src/webhooks/router.ts` → `src/queue.ts`)

Replace the `console.log` stub in the "start new work" case with actual job enqueueing.

**Updated router signature:**

```typescript
export function routeTicketTransition(
  event: TicketTransitionEvent,
  context: JiraTicketContext | null,
): void
```

The "start new work" case requires context to be non-null. If context is null when `toColumn === AI`, log a warning and do not enqueue (the webhook payload was missing issue fields).

**Updated `TicketJobData` type** in `src/queue.ts`:

```typescript
export type TicketJobData = {
  type: "start_new_work";
  source: "jira" | "linear";
  externalTicketId: string;
  actor: string;
  context: {
    title: string;
    description: string;
    comments: { author: string; body: string; createdAt: string }[];
    labels: string[];
  };
};
```

This is a discriminated union with `type` field — future phases add `"review_fix"`, `"clarification_answer"`, etc.

**Breaking change:** The current `TicketJobData` shape (`{ ticketId: string }`) is replaced entirely. Any existing jobs in the Redis queue from development/testing will fail. The worker should include a guard clause that logs and discards jobs missing the `type` field.

The router imports `ticketQueue` and calls `ticketQueue.add("start_new_work", jobData, { jobId: externalTicketId })`. Using `jobId` prevents duplicate jobs if Jira retries the webhook.

### 3. Jira REST Client (`src/adapters/jira-client.ts`)

Concrete implementation of `TicketAdapter` for write operations only (reads come from the webhook). Uses `fetch` — no external library needed.

**Auth:** Jira Cloud Basic auth with `email:api_token` base64-encoded.

**Methods implemented:**

- `addComment(externalId, body)` — `POST /rest/api/3/issue/{externalId}/comment`
- `moveTicket(externalId, columnName)` — `POST /rest/api/3/issue/{externalId}/transitions` (fetches available transitions first, matches by name)
- `getTicket(externalId)` — Not needed this phase (data comes from webhook), but implement as a thin wrapper for completeness since the interface requires it.

**New env vars:**

| Variable | Required | Purpose |
|---|---|---|
| `JIRA_BASE_URL` | yes | e.g. `https://yourteam.atlassian.net` |
| `JIRA_USER_EMAIL` | yes | Email for Basic auth |
| `JIRA_API_TOKEN` | yes | API token for Basic auth |

### 4. GitHub REST Client (`src/adapters/github-client.ts`)

Concrete implementation of `SourceControlAdapter`. Uses `@octokit/rest` for typed responses and rate limit handling.

**Methods implemented:**

- `createBranch(repoOwner, repoName, branchName, baseBranch)` — Creates ref `refs/heads/blazebot/{ticket-key}`. If branch already exists (409/422), silently succeeds (reuse).
- `createPullRequest(repoOwner, repoName, title, body, head, base)` — Creates PR from feature branch to base branch.
- `getPullRequestComments(...)` — Not needed this phase, stub that returns `[]`.
- `mergeBranch(...)` — Not needed this phase, stub that returns.

**New env vars:**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN` | yes | — | PAT or GitHub App token |
| `GITHUB_REPO_OWNER` | yes | — | Repository owner |
| `GITHUB_REPO_NAME` | yes | — | Repository name |
| `GITHUB_BASE_BRANCH` | no | `main` | Branch to create feature branches from |

### 5. Docker Manager (`src/docker/manager.ts`)

Manages the container lifecycle using `dockerode`.

**Prebuilt image: `blazebot-sandbox`**

Built from a Dockerfile in the repo (`docker/sandbox/Dockerfile`):

```dockerfile
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY entrypoint.sh /entrypoint.sh
COPY git-guard.sh /usr/local/bin/git
RUN chmod +x /entrypoint.sh /usr/local/bin/git
ENTRYPOINT ["/entrypoint.sh"]
```

**`entrypoint.sh`:**

1. Clone repo using `GITHUB_TOKEN` on branch `BLAZEBOT_BRANCH`
2. Copy injected `/inject/requirements.md` into repo root
3. Substitute `{branchName}` in injected `/inject/prompt.md` with `$BLAZEBOT_BRANCH`, copy into repo root
4. Create `output/` directory
5. Run `claude -p "$(cat prompt.md)" --dangerously-skip-permissions`
6. Capture Claude Code's exit code, ensure `output/result.json` exists, exit

**`git-guard.sh`** — Git wrapper placed in PATH before real git:

```bash
#!/bin/bash
REAL_GIT=/usr/bin/git

case "$1" in
  checkout|switch)
    echo "ERROR: Branch switching is not allowed. You are on $BLAZEBOT_BRANCH." >&2
    exit 1
    ;;
  push)
    # Parse the refspec to verify we're pushing to the allowed branch
    ALLOWED=false
    for arg in "$@"; do
      if [ "$arg" = "$BLAZEBOT_BRANCH" ] || [ "$arg" = "origin" ] || [ "$arg" = "push" ]; then
        continue
      fi
      # If we see a refspec that's not our branch, block it
      if echo "$arg" | grep -q ":" && ! echo "$arg" | grep -q "$BLAZEBOT_BRANCH"; then
        echo "ERROR: You can only push to $BLAZEBOT_BRANCH." >&2
        exit 1
      fi
    done
    $REAL_GIT "$@"
    ;;
  *)
    $REAL_GIT "$@"
    ;;
esac
```

**Docker manager API:**

```typescript
export interface SandboxResult {
  status: "complete";
  summary: string;
} | {
  status: "needs_clarification";
  questions: string[];
} | {
  status: "failed";
  error: string;
};

export async function runSandbox(options: {
  image: string;
  branchName: string;
  requirementsMd: string;
  promptMd: string;
  githubToken: string;
  repoUrl: string;
  anthropicApiKey: string;
  timeoutMs: number;
  memoryLimitMb: number;
}): Promise<SandboxResult>;
```

The function:
1. Creates the container with env vars (`BLAZEBOT_BRANCH`, `GITHUB_TOKEN`, `REPO_URL`, `ANTHROPIC_API_KEY`) and resource limits (memory, CPU shares)
2. Writes `requirements.md` and `prompt.md` to a temp dir, bind-mounts it as `/inject` in the container
3. Starts the container
4. Waits for the container to exit (with timeout — kills container if exceeded)
5. Copies `output/result.json` from the stopped container
6. Removes the container and temp dir
7. Parses `result.json`:
   - If valid JSON with `status: "complete"` or `status: "needs_clarification"` → return it
   - If missing, unparseable, or unrecognized status → return `{ status: "failed", error: "..." }`

**Concurrency:** The worker checks active container count before starting a new one. If `MAX_CONCURRENT_CONTAINERS` is reached, the job stays in the queue (BullMQ handles retry).

**Timeout:** Configurable via `SANDBOX_TIMEOUT_MS` env var (default: 30 minutes). If the container exceeds this, it is killed and the result is treated as a failure.

### 6. Worker Handler (`src/worker.ts`)

The worker becomes the orchestrator. On receiving a `start_new_work` job:

```
1. Guard clause: if job data is missing `type` field (old format), log warning and discard
2. Upsert ticket in DB (status: "in_progress")
3. Create agent_run record (status: "provisioning", trigger: "new")
4. Create branch via GitHub adapter (blazebot/{ticket-key})
5. Generate requirements.md from job context
6. Update agent_run (status: "running")
7. Call runSandbox(...)
8. Read result:
   - If "complete":
     a. Create PR via GitHub adapter → get { number, url }
     b. Store PR number/URL on the agent_run record (see schema note below)
     c. Move ticket to AI Review via Jira adapter
     d. Log notification: "PR created for {ticket-key}: {pr-url}"
     e. Update agent_run (status: "completed")
     f. Update ticket (status: "in_review")
   - If "needs_clarification":
     a. Post questions as comment via Jira adapter
     b. Move ticket to Backlog via Jira adapter
     c. Log notification: "Clarification needed for {ticket-key}"
     d. Update agent_run (status: "completed")
     e. Update ticket (status: "clarifying")
   - If "failed":
     a. Update agent_run (status: "failed")
     b. Update ticket (status: "failed")
     c. Log error notification
```

**Schema migration:** Add `pr_number` (integer, nullable) and `pr_url` (text, nullable) columns to the `agent_runs` table. These are populated when a PR is created and needed by future review-fix phases.

### 7. Requirements.md Template

Generated by the worker from job context. Kept minimal — only the *what*, Claude Code discovers the *how* from the repo.

```markdown
# Requirements

## Ticket: {externalTicketId}

### Title
{title}

### Description
{description}

### Comments
{for each comment:}
**{author}** ({createdAt}):
{body}
{end for}
```

No repo-level context is included. Claude Code discovers the codebase structure, tech stack, and conventions by reading the repo's own files (CLAUDE.md, README, etc.).

### 8. Claude Code Prompt (`docker/sandbox/prompt.md`)

A `.md` file in the repo at `docker/sandbox/prompt.md`, copied into the image at build time. The entrypoint substitutes `{branchName}` with `$BLAZEBOT_BRANCH` before Claude Code runs.

```markdown
You are an automated AI developer working on a feature. Follow these instructions exactly.

## Your Task

1. Read `requirements.md` in the repo root — it contains the ticket requirements.
2. Use `/using-superpowers` to brainstorm the approach and create an implementation plan.
3. Evaluate whether the requirements are clear enough to implement:
   - If ANYTHING is ambiguous or missing and would block correct implementation, go to STEP 4.
   - If requirements are clear, go to STEP 5.

4. **Clarification needed:**
   - Write your questions to `output/result.json`:
     ```json
     { "status": "needs_clarification", "questions": ["question 1", "question 2"] }
     ```
   - Exit immediately. Do NOT attempt partial implementation.

5. **Implement:**
   - Execute the plan using superpowers skills.
   - Follow TDD — write tests before implementation.
   - Commit your work frequently with clear messages.
   - Push all commits to the current branch.

6. **After implementation is complete:**
   - Run `/requesting-code-review` to self-review your work.
   - Fix any issues found during review.
   - Write completion status to `output/result.json`:
     ```json
     { "status": "complete", "summary": "Brief description of what was implemented" }
     ```

## Constraints

- You are on branch `{branchName}`. NEVER switch branches.
- Push ONLY to this branch.
- Do NOT modify `requirements.md` or `prompt.md`.
- Do NOT create or modify `.env` files.
- Always write `output/result.json` before exiting.
```

### 9. Messaging Stubs

The messaging adapter stays as logging stubs. Designed as optional — if `SLACK_*` env vars are not set, the adapter silently does nothing. No implementation in this phase.

Notification points (all logged via Fastify's pino logger, not raw console.log):
- "Started work on {ticket-key}"
- "PR created for {ticket-key}: {pr-url}"
- "Clarification needed for {ticket-key}"
- "Agent failed for {ticket-key}"

## Environment Variables

### New variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JIRA_BASE_URL` | yes | — | Jira instance URL |
| `JIRA_USER_EMAIL` | yes | — | Email for Jira Basic auth |
| `JIRA_API_TOKEN` | yes | — | Jira API token |
| `GITHUB_TOKEN` | yes | — | GitHub PAT for branch/PR operations + container clone |
| `GITHUB_REPO_OWNER` | yes | — | GitHub repository owner |
| `GITHUB_REPO_NAME` | yes | — | GitHub repository name |
| `GITHUB_BASE_BRANCH` | no | `main` | Base branch for feature branches |
| `ANTHROPIC_API_KEY` | yes | — | API key passed into sandbox for Claude Code |
| `SANDBOX_TIMEOUT_MS` | no | `1800000` | Container timeout in ms (default: 30 minutes) |
| `SANDBOX_MEMORY_MB` | no | `4096` | Container memory limit in MB |

### Env validation strategy

The new env vars are only needed by the worker, not the web server. To avoid breaking the web server when worker-specific vars are missing, these variables are validated at worker startup (when the adapters are instantiated), not in the shared `env.ts` `createEnv` call. The `env.ts` schema adds them as optional, and the adapter constructors throw if their required vars are missing.

## New Dependencies

| Package | Purpose |
|---|---|
| `@octokit/rest` | GitHub REST API client |
| `dockerode` | Docker API client for container management |
| `@types/dockerode` | TypeScript types for dockerode |

## File Structure (new/modified)

```
src/
  adapters/
    jira-client.ts          # Concrete TicketAdapter (Jira REST)
    jira-client.test.ts
    github-client.ts        # Concrete SourceControlAdapter (Octokit)
    github-client.test.ts
  docker/
    manager.ts              # runSandbox(), container lifecycle
    manager.test.ts
  webhooks/
    jira.ts                 # Expanded parser (full ticket context)
    jira.test.ts            # New tests for context extraction
    router.ts               # Enqueues BullMQ jobs instead of logging
    router.test.ts          # Updated tests
  queue.ts                  # Updated TicketJobData discriminated union
  worker.ts                 # Full orchestration logic
  worker.test.ts            # Updated tests
docker/
  sandbox/
    Dockerfile              # Prebuilt image definition
    entrypoint.sh           # Container startup script
    git-guard.sh            # Git wrapper for branch protection
    prompt.md               # Claude Code prompt template
```

## Testing Strategy

- **Jira client:** Mock `fetch`, verify correct URLs, headers, and payloads for addComment, moveTicket, getTicket
- **GitHub client:** Mock Octokit, verify branch creation with reuse (409 handling), PR creation
- **Docker manager:** Mock `dockerode`, verify container lifecycle (create → start → wait → cp → remove), timeout behavior, result parsing for all three statuses
- **Worker handler:** Mock all adapters + docker manager, verify orchestration flow for complete/clarification/failure paths, verify old job format is discarded
- **Router:** Verify BullMQ job is enqueued with correct data, verify null context is rejected with warning
- **Jira parser:** Verify full context extraction from expanded payload, verify backward compatibility when `fields` is missing
- **Integration:** Fastify inject tests for webhook → queue flow
