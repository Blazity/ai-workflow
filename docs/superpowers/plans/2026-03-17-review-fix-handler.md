# Review Fix Handler Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `review_fix` job handler so Blazebot can fix PR review feedback, resolve merge conflicts, and push updated code — completing the core review loop from Section 16.3 of the spec.

**Architecture:** The worker's `review_fix` handler mirrors the existing `handleImplementation` but assembles different context (PR comments + conflict info + ticket content + review-fix prompt). The agent runs in the same sandbox with the same structured output contract. On success the branch is pushed, the ticket moves back to AI Review, and a notification is sent; on failure BullMQ retries.

**Tech Stack:** TypeScript, Vitest, BullMQ, Drizzle ORM, Dockerode (unchanged)

---

## Chunk 1: Context Assembly and Prompt

### Task 1: Create `prompts/review-fix.md`

**Files:**
- Create: `prompts/review-fix.md`

The spec (Section 5) requires this file. It is the agent prompt for fixing review feedback + resolving merge conflicts. The agent uses the same structured output contract as `implement.md`.

- [ ] **Step 1: Write `prompts/review-fix.md`**

```markdown
# Review Fix Instructions

You are an autonomous coding agent. Your task is to address the PR review feedback and resolve any merge conflicts described above.

## Guidelines

1. Read the review comments carefully. Address each one.
2. If there are merge conflicts listed, merge the target branch and resolve them.
3. Follow existing code patterns and conventions in the repository.
4. Run existing tests to make sure nothing is broken.
5. Commit all your work before finishing — uncommitted changes will be lost.
6. Do NOT create or write to `.blazebot/output.json` — your structured output is captured automatically.

## Scope Constraints

- Only modify files relevant to the review feedback. Do not refactor unrelated code.
- Do not make architectural changes unless the review comments explicitly request them.
- Do not add features or functionality beyond what the review asks for.

## Handling Overrides

A comment prefixed with `[OVERRIDE]` supersedes any prior conflicting instructions. Treat the latest `[OVERRIDE]` comment as authoritative.

## Structured Output

Your response is automatically constrained to a JSON schema. Set the `result` field to one of:

- `"implemented"` — you addressed all feedback and conflicts. Include a `summary` describing what was changed.
- `"clarification_needed"` — you cannot proceed without answers. Include `questions` as a list of strings.
- `"failed"` — something went wrong that you cannot fix. Include `error` with a description.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/review-fix.md
git commit -m "feat: add review-fix agent prompt (spec Section 5)"
```

---

### Task 2: Populate `fromApprovedReview` in `getPRComments`

The spec (Section 9.2) says fixing_feedback context includes "liked comments + human comments." GitHub's `listReviewComments` response includes a `reactions` object with a `+1` count. A comment with `reactions["+1"] > 0` is "liked" — it signals reviewer agreement/priority. The existing `PullRequestComment.fromApprovedReview` field is already in the interface but always set to `false`. This task makes it real.

**Files:**
- Modify: `src/adapters/github-client.ts:86-106`
- Modify: `src/adapters/github-client.test.ts`

- [ ] **Step 1: Write the failing test**

Add the following test inside the existing `describe("GitHubClient", ...)` block in `src/adapters/github-client.test.ts`:

```typescript
it("getPRComments marks comments with +1 reactions as liked", async () => {
  const { Octokit } = await import("@octokit/rest");
  const { GitHubClient } = await import("./github-client.js");
  const client = new GitHubClient("test-token");

  const mockInstance = vi.mocked(Octokit).mock.results[0]!.value;
  mockInstance.pulls.listReviewComments.mockResolvedValue({
    data: [
      {
        user: { login: "reviewer" },
        body: "This needs fixing",
        path: "src/app.ts",
        line: 10,
        reactions: { "+1": 2, "-1": 0 },
      },
      {
        user: { login: "reviewer2" },
        body: "Nit: spacing",
        path: "src/app.ts",
        line: 20,
        reactions: { "+1": 0, "-1": 0 },
      },
      {
        user: { login: "reviewer3" },
        body: "Old comment",
        path: "src/old.ts",
        line: 5,
      },
    ],
  });

  const comments = await client.getPRComments("owner", "repo", 1);

  expect(comments).toEqual([
    expect.objectContaining({ author: "reviewer", fromApprovedReview: true }),
    expect.objectContaining({ author: "reviewer2", fromApprovedReview: false }),
    expect.objectContaining({ author: "reviewer3", fromApprovedReview: false }),
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/github-client.test.ts`
Expected: FAIL — the first comment has `fromApprovedReview: false` but test expects `true`.

- [ ] **Step 3: Update `getPRComments` in `src/adapters/github-client.ts`**

Replace the existing `getPRComments` method (lines 86-106) with:

```typescript
async getPRComments(
  repoOwner: string,
  repoName: string,
  prNumber: number,
): Promise<PullRequestComment[]> {
  const { data } = await this.octokit.pulls.listReviewComments({
    owner: repoOwner,
    repo: repoName,
    pull_number: prNumber,
  });

  return data.map(
    (c): PullRequestComment => ({
      author: c.user?.login ?? "unknown",
      body: c.body,
      path: c.path ?? null,
      line: c.line ?? null,
      fromApprovedReview:
        (c.reactions as Record<string, number> | undefined)?.["+1"] != null &&
        (c.reactions as Record<string, number>)["+1"] > 0,
    }),
  );
}
```

The `reactions` field from GitHub's API is typed loosely by Octokit, so we cast to `Record<string, number>` to access the `+1` key safely. If the `reactions` field is absent (older API responses), `fromApprovedReview` defaults to `false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/github-client.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github-client.ts src/adapters/github-client.test.ts
git commit -m "feat: populate fromApprovedReview from GitHub +1 reactions (spec Section 9.2)"
```

---

### Task 3: Add `assembleFixingFeedbackContext` to `src/context.ts`

The spec (Section 12) defines the exact format for `fixing_feedback` context. It extends the implementation format with PR Review Feedback and Merge Conflicts sections. Liked comments (those with `fromApprovedReview: true`) are rendered first in a separate subsection so the agent prioritises them.

**Files:**
- Modify: `src/context.ts`
- Modify: `src/context.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing imports at the top of `src/context.test.ts` (extend the existing import line):

```typescript
import { assembleImplementationContext, assembleFixingFeedbackContext } from "./context.js";
import type { PullRequestComment } from "./adapters/source-control.js";

describe("assembleFixingFeedbackContext", () => {
  const ticket = {
    externalId: "PROJ-42",
    identifier: "PROJ-42",
    title: "Add dark mode",
    description: "Implement dark mode",
    acceptanceCriteria: "All pages support dark theme",
    comments: [
      { author: "Alice", body: "Use CSS variables", createdAt: new Date("2026-03-10T10:00:00Z") },
    ],
    labels: ["frontend"],
    trackerStatus: "AI",
  };

  const prComments: PullRequestComment[] = [
    { author: "bob", body: "Please add unit tests for the toggle", path: "src/toggle.ts", line: 15, fromApprovedReview: true },
    { author: "carol", body: "LGTM on the color scheme", path: null, line: null, fromApprovedReview: false },
  ];

  it("assembles full fixing-feedback context in spec Section 12 format", () => {
    const result = assembleFixingFeedbackContext(ticket, prComments, true, "review-fix prompt");

    expect(result).toContain("# Requirements");
    expect(result).toContain("## Ticket\nAdd dark mode");
    expect(result).toContain("## Description\nImplement dark mode");
    expect(result).toContain("## Acceptance Criteria\nAll pages support dark theme");
    expect(result).toContain("## Comments");
    expect(result).toContain("**Alice**");
    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("### Liked Comments");
    expect(result).toContain("**bob** (`src/toggle.ts:15`):");
    expect(result).toContain("Please add unit tests for the toggle");
    expect(result).toContain("### Other Comments");
    expect(result).toContain("**carol**:");
    expect(result).toContain("LGTM on the color scheme");
    expect(result).toContain("## Merge Conflicts");
    expect(result).toContain("has merge conflicts");
    expect(result).toContain("---");
    expect(result).toContain("review-fix prompt");
  });

  it("renders liked comments before other comments", () => {
    const result = assembleFixingFeedbackContext(ticket, prComments, false, "prompt");
    const likedIdx = result.indexOf("### Liked Comments");
    const otherIdx = result.indexOf("### Other Comments");
    expect(likedIdx).toBeLessThan(otherIdx);
  });

  it("omits liked subsection heading when no liked comments", () => {
    const noLiked: PullRequestComment[] = [
      { author: "dave", body: "Nit", path: null, line: null, fromApprovedReview: false },
    ];
    const result = assembleFixingFeedbackContext(ticket, noLiked, false, "prompt");

    expect(result).toContain("## PR Review Feedback");
    expect(result).not.toContain("### Liked Comments");
    expect(result).not.toContain("### Other Comments");
  });

  it("omits other subsection heading when all comments are liked", () => {
    const allLiked: PullRequestComment[] = [
      { author: "eve", body: "Fix this", path: "src/a.ts", line: 1, fromApprovedReview: true },
    ];
    const result = assembleFixingFeedbackContext(ticket, allLiked, false, "prompt");

    expect(result).toContain("## PR Review Feedback");
    expect(result).not.toContain("### Liked Comments");
    expect(result).not.toContain("### Other Comments");
  });

  it("omits merge conflicts section when hasConflicts is false", () => {
    const result = assembleFixingFeedbackContext(ticket, prComments, false, "prompt");

    expect(result).not.toContain("## Merge Conflicts");
  });

  it("omits PR review feedback section when no comments", () => {
    const result = assembleFixingFeedbackContext(ticket, [], false, "prompt");

    expect(result).not.toContain("## PR Review Feedback");
  });

  it("always ends with prompt content after separator", () => {
    const result = assembleFixingFeedbackContext(ticket, prComments, false, "Fix the issues");
    const lines = result.split("\n");
    const separatorIdx = lines.indexOf("---");
    expect(separatorIdx).toBeGreaterThan(-1);
    expect(lines.slice(separatorIdx + 1).join("\n")).toContain("Fix the issues");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/context.test.ts`
Expected: FAIL — `assembleFixingFeedbackContext` is not exported from `./context.js`.

- [ ] **Step 3: Implement `assembleFixingFeedbackContext` in `src/context.ts`**

Add the following function after the existing `assembleImplementationContext`:

```typescript
import type { PullRequestComment } from "./adapters/source-control.js";

export function assembleFixingFeedbackContext(
  ticket: Ticket,
  prComments: PullRequestComment[],
  hasConflicts: boolean,
  promptFileContent: string,
): string {
  const lines = [
    "# Requirements",
    "",
    "## Ticket",
    ticket.title,
    "",
    "## Description",
    ticket.description,
  ];

  if (ticket.acceptanceCriteria) {
    lines.push("", "## Acceptance Criteria", ticket.acceptanceCriteria);
  }

  if (ticket.comments.length > 0) {
    lines.push("", "## Comments");
    for (const comment of ticket.comments) {
      lines.push(
        "",
        `**${comment.author}** (${comment.createdAt.toISOString()}):`,
        comment.body,
      );
    }
  }

  if (prComments.length > 0) {
    const liked = prComments.filter((c) => c.fromApprovedReview);
    const other = prComments.filter((c) => !c.fromApprovedReview);
    const needsSubheadings = liked.length > 0 && other.length > 0;

    lines.push("", "## PR Review Feedback");

    const formatComment = (c: PullRequestComment) => {
      const location = c.path ? ` (\`${c.path}${c.line ? `:${c.line}` : ""}\`)` : "";
      lines.push("", `**${c.author}**${location}:`, c.body);
    };

    if (needsSubheadings) {
      lines.push("", "### Liked Comments");
      liked.forEach(formatComment);
      lines.push("", "### Other Comments");
      other.forEach(formatComment);
    } else {
      prComments.forEach(formatComment);
    }
  }

  if (hasConflicts) {
    lines.push(
      "",
      "## Merge Conflicts",
      "This PR has merge conflicts with the target branch. Merge the target branch and resolve all conflicts before addressing review feedback.",
    );
  }

  lines.push("", "---", promptFileContent);

  return lines.join("\n");
}
```

Note: The subheadings `### Liked Comments` / `### Other Comments` only appear when there's a mix of both types. When all comments are liked or none are liked, the comments render flat under `## PR Review Feedback` without subheadings — keeping the output clean.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/context.test.ts`
Expected: All tests PASS (both existing `assembleImplementationContext` tests and new ones).

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/context.test.ts
git commit -m "feat: add assembleFixingFeedbackContext with liked-comment distinction (spec Section 12)"
```

---

## Chunk 2: Worker Handler

### Task 4: Implement `handleReviewFix` in `src/worker.ts`

The spec (Section 16.3) defines the algorithm. This mirrors `handleImplementation` but:
- Reads `prompts/review-fix.md` instead of `prompts/implement.md`.
- Fetches PR comments and conflict status from the GitHub adapter.
- Uses `assembleFixingFeedbackContext` for context assembly.
- On success: moves ticket back to AI Review (the PR already exists from the implementation run — no new PR needed).
- Run type is `review_fix` (matching the existing DB enum).
- The ticket must already have `prId` and `branchName` from the prior implementation run. The handler validates these are present before proceeding.

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add the following tests to the existing `describe("worker handler", ...)` block in `src/worker.test.ts`. These reuse the existing mocks (`mockJira`, `mockGitHub`, `mockRunSandbox`, etc.) and the `defaultTicket` fixture already defined at the top of the file.

```typescript
describe("review_fix handler", () => {
  it("fetches ticket, PR comments, conflict status, runs sandbox, and moves to AI Review on success", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockGitHub.getPRComments.mockResolvedValue([
      { author: "bob", body: "Add tests", path: "src/index.ts", line: 10, fromApprovedReview: false },
    ]);
    mockGitHub.getPRConflictStatus.mockResolvedValue(false);
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Fixed review feedback",
      containerId: "container-xyz",
    });

    // Simulate existing ticket with prId and branchName
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const mockDb = vi.mocked(drizzle).mock.results[0]!.value;
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: "ticket-uuid",
          prId: "42",
          branchName: "blazebot/PROJ-42",
        }]),
      }),
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "review_fix",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockJira.fetchTicket).toHaveBeenCalledWith("PROJ-42");
    expect(mockGitHub.getPRComments).toHaveBeenCalledWith("owner", "repo", 42);
    expect(mockGitHub.getPRConflictStatus).toHaveBeenCalledWith("owner", "repo", 42);
    expect(mockRunSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: "blazebot/PROJ-42",
        requirementsMd: expect.stringContaining("## PR Review Feedback"),
      }),
    );
    expect(mockJira.moveTicket).toHaveBeenCalledWith("PROJ-42", "AI Review");
  });

  it("throws on failure so BullMQ retries (review_fix)", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockGitHub.getPRComments.mockResolvedValue([]);
    mockGitHub.getPRConflictStatus.mockResolvedValue(false);
    mockRunSandbox.mockResolvedValue({
      exitCode: 1,
      status: "failed",
      error: "Merge conflict unresolvable",
      containerId: "container-fail",
    });

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const mockDb = vi.mocked(drizzle).mock.results[0]!.value;
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: "ticket-uuid",
          prId: "42",
          branchName: "blazebot/PROJ-42",
        }]),
      }),
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await expect(
      handler(
        makeJob({
          type: "review_fix",
          ticketId: "PROJ-42",
          source: "jira",
          triggeredBy: "Mia",
        }),
      ),
    ).rejects.toThrow();

    expect(mockGitHub.createPR).not.toHaveBeenCalled();
  });

  it("skips review_fix when ticket is no longer in AI column", async () => {
    mockJira.fetchTicket.mockResolvedValue({
      ...defaultTicket,
      trackerStatus: "Done",
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "review_fix",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockRunSandbox).not.toHaveBeenCalled();
  });

  it("sends notification after review fix completes", async () => {
    mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
    mockGitHub.getPRComments.mockResolvedValue([]);
    mockGitHub.getPRConflictStatus.mockResolvedValue(false);
    mockRunSandbox.mockResolvedValue({
      exitCode: 0,
      status: "complete",
      summary: "Fixed",
      containerId: "container-notif",
    });

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const mockDb = vi.mocked(drizzle).mock.results[0]!.value;
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: "ticket-uuid",
          prId: "42",
          branchName: "blazebot/PROJ-42",
        }]),
      }),
    });

    const { createWorker } = await import("./worker.js");
    const worker = createWorker();
    const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

    await handler(
      makeJob({
        type: "review_fix",
        ticketId: "PROJ-42",
        source: "jira",
        triggeredBy: "Mia",
      }),
    );

    expect(mockMessaging.notify).toHaveBeenCalledWith(
      "Mia",
      expect.stringContaining("fixes applied"),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker.test.ts`
Expected: FAIL — `review_fix handler not yet implemented` error is thrown for every `review_fix` test.

- [ ] **Step 3: Implement `handleReviewFix` in `src/worker.ts`**

First, add the import at the top of `src/worker.ts`:

```typescript
import { assembleFixingFeedbackContext } from "./context.js";
```

Then replace the `review_fix` throw block:

```typescript
} else if (job.data.type === "review_fix") {
  throw new Error(
    `review_fix handler not yet implemented for ${job.data.ticketId}`,
  );
}
```

with:

```typescript
} else if (job.data.type === "review_fix") {
  await handleReviewFix(job.data);
}
```

Then add the handler function after `handleImplementation`:

```typescript
async function handleReviewFix(data: Extract<TicketJobData, { type: "review_fix" }>) {
  const { jira, github, messaging } = createAdapters();
  const owner = env.GITHUB_REPO_OWNER!;
  const repo = env.GITHUB_REPO_NAME!;

  const ticket = await jira.fetchTicket(data.ticketId);

  const colAi = normalize(env.COLUMN_AI);
  if (normalize(ticket.trackerStatus) !== colAi) {
    logger.info(
      { ticketId: data.ticketId, trackerStatus: ticket.trackerStatus },
      "stale_job_skipped",
    );
    return;
  }

  const ticketRow = (
    await db.select().from(tickets).where(eq(tickets.externalId, data.ticketId))
  )[0]!;

  if (!ticketRow.prId || !ticketRow.branchName) {
    logger.error({ ticketId: data.ticketId }, "review_fix_missing_pr_or_branch");
    throw new Error(`review_fix requires prId and branchName for ${data.ticketId}`);
  }

  const prNumber = parseInt(ticketRow.prId, 10);
  const branchName = ticketRow.branchName;

  await db.update(tickets)
    .set({ workflowState: "fixing_feedback", updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const ticketLog = createTicketLogger(logger, ticketRow.id, data.ticketId);

  const [run] = await db.insert(runAttempts)
    .values({
      ticketId: ticketRow.id,
      type: "review_fix",
      status: "running",
      branchName,
    })
    .returning();

  await db.update(tickets)
    .set({ currentRunId: run!.id, updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  const runLog = createRunLogger(ticketLog, run!.id);
  runLog.info({ type: "review_fix", branchName, prNumber }, "job_started");

  ticketLog.info({ from: "awaiting_review", to: "fixing_feedback" }, "ticket_state_transition");

  const promptPath = resolve(PROMPTS_DIR, "review-fix.md");
  const promptContent = await readFile(promptPath, "utf-8");

  const [prComments, hasConflicts] = await Promise.all([
    github.getPRComments(owner, repo, prNumber),
    github.getPRConflictStatus(owner, repo, prNumber),
  ]);

  const requirementsMd = assembleFixingFeedbackContext(
    ticket, prComments, hasConflicts, promptContent,
  );

  const startTime = Date.now();

  const result = await runSandbox({
    image: env.DOCKER_IMAGE,
    branchName,
    requirementsMd,
    githubToken: env.GITHUB_TOKEN!,
    repoUrl: `${owner}/${repo}`,
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    model: env.CLAUDE_MODEL,
    timeoutMs: env.JOB_TIMEOUT_MS,
    memoryLimitMb: env.SANDBOX_MEMORY_MB,
  });

  const durationMs = Date.now() - startTime;
  runLog.info(
    { exitCode: result.exitCode, containerId: result.containerId, durationMs },
    "agent_exited",
  );

  if (result.containerId) {
    await db.update(runAttempts)
      .set({ containerId: result.containerId })
      .where(eq(runAttempts.id, run!.id));
  }

  try {
    if (result.containerId && result.status === "complete") {
      await pushBranchFromContainer(result.containerId, branchName);
    }
  } finally {
    if (result.containerId) {
      await teardownContainer(result.containerId);
    }
  }

  if (result.status === "complete") {
    runLog.info({ prNumber }, "review_fix_complete");

    await db.update(tickets)
      .set({
        workflowState: "awaiting_review",
        currentRunId: null,
        updatedAt: new Date(),
      })
      .where(eq(tickets.externalId, data.ticketId));

    await db.update(runAttempts)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(runAttempts.id, run!.id));

    ticketLog.info({ from: "fixing_feedback", to: "awaiting_review" }, "ticket_state_transition");

    await jira.moveTicket(data.ticketId, env.COLUMN_AI_REVIEW);
    await messaging.notify(
      data.triggeredBy,
      `Task ${ticket.identifier} fixes applied, ready for re-review`,
    );
    return;
  }

  runLog.error({ error: result.error }, "agent_failed");

  await db.update(runAttempts)
    .set({ status: "failed", error: result.error, finishedAt: new Date() })
    .where(eq(runAttempts.id, run!.id));

  await db.update(tickets)
    .set({ workflowState: "failed", currentRunId: null, updatedAt: new Date() })
    .where(eq(tickets.externalId, data.ticketId));

  ticketLog.info({ from: "fixing_feedback", to: "failed" }, "ticket_state_transition");

  throw new Error(
    `Agent failed for ${data.ticketId}: ${result.error}`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker.test.ts`
Expected: All tests PASS (existing implementation tests + new review_fix tests).

- [ ] **Step 5: Run all tests to check for regressions**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: implement review_fix job handler (spec Section 16.3)"
```

---

## Spec Alignment Notes

This plan implements:
- **Spec Section 5**: `prompts/review-fix.md` — self-contained, versioned, includes `[OVERRIDE]` handling instruction.
- **Spec Section 9.2**: Context assembly for `fixing_feedback` — ticket content + PR comments (liked vs. other) + conflict info + prompt.
- **Spec Section 12**: `requirements.md` format for fixing feedback runs (exact template from spec).
- **Spec Section 16.3**: `process_fixing_feedback_job` algorithm — stale check, sandbox run, result handling.
- **Spec Section 7.2**: State transitions `awaiting_review → fixing_feedback → awaiting_review` and `fixing_feedback → failed`.
- **Spec Section 10.4**: Orchestrator pushes branch, creates/updates PR, moves tickets, sends notifications.
- **Spec Section 14.2**: BullMQ retries on failure (throw triggers backoff).

Known spec deviations (deferred to follow-up):
- **PR diff in context** — Spec Section 9.2 says fixing_feedback context should include "PR diff." The current `VCSAdapter` interface has no `getPRDiff()` method. The review comments themselves provide sufficient context for the agent to locate and fix issues. Adding the full PR diff would improve context but requires a new adapter method and increases prompt token cost. Deferred as a follow-up enhancement.

Not in scope (already working or deferred):
- Router dispatch for `review_fix` — already implemented in `src/webhooks/router.ts`.
- `completed` workflow state — deferred per spec (requires CI check integration).
- Clarification during review_fix — spec Section 16.3 does not define this path; the algorithm only handles `implemented` and `failed`.
