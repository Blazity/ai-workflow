# Clarification Flow Hardening Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing clarification flow with missing test coverage and a spec-required edge case — ensuring the resumed implementation run receives Q&A history and that the `[OVERRIDE]` instruction is present in the agent prompt.

**Architecture:** The clarification flow already works end-to-end (worker handles `clarification_needed`, router re-enqueues on resume, self-transitions are filtered). This plan adds targeted tests for untested paths and fills two spec gaps: (1) the `implement.md` prompt is missing `[OVERRIDE]` handling instructions required by Section 5, and (2) there's no test proving resumed runs carry Q&A comments in context.

**Tech Stack:** TypeScript, Vitest (unchanged)

---

## Chunk 1: Prompt and Test Hardening

### Task 1: Add `[OVERRIDE]` handling instruction to `prompts/implement.md`

The spec (Section 5) requires all prompts to include agent constraints for handling comment overrides:
> "Must instruct the agent to handle comment overrides — a ticket comment prefixed with `[OVERRIDE]` negates or supersedes a previous comment."

This instruction is planned for `review-fix.md` (see review-fix-handler plan) but is currently missing from `implement.md`.

**Files:**
- Modify: `prompts/implement.md`

- [ ] **Step 1: Add the `[OVERRIDE]` section to `prompts/implement.md`**

Add the following section between "Guidelines" and "Structured Output" in `prompts/implement.md`:

```markdown
## Handling Overrides

A comment prefixed with `[OVERRIDE]` supersedes any prior conflicting instructions. Treat the latest `[OVERRIDE]` comment as authoritative.
```

The full file should read:

```markdown
# Implementation Instructions

You are an autonomous coding agent. Your task is to implement the requirements described above.

## Guidelines

1. Read the ticket description and acceptance criteria carefully.
2. Follow existing code patterns and conventions in the repository.
3. Write clean, well-tested code.
4. Run existing tests to make sure nothing is broken.
5. Commit all your work before finishing — uncommitted changes will be lost.
6. Do NOT create or write to `.blazebot/output.json` — your structured output is captured automatically.

## Scope Constraints

- Only modify files relevant to the ticket. Do not refactor unrelated code.
- Do not make architectural changes unless the ticket explicitly requests them.
- Stay within the acceptance criteria — do not add features beyond what is asked for.

## Handling Overrides

A comment prefixed with `[OVERRIDE]` supersedes any prior conflicting instructions. Treat the latest `[OVERRIDE]` comment as authoritative.

## Structured Output

Your response is automatically constrained to a JSON schema. Set the `result` field to one of:

- `"implemented"` — you completed the task. Include a `summary` describing what was done (used as PR description).
- `"clarification_needed"` — you cannot proceed without answers. Include `questions` as a list of strings.
- `"failed"` — something went wrong that you cannot fix. Include `error` with a description.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/implement.md
git commit -m "feat: add [OVERRIDE] handling to implement.md (spec Section 5)"
```

---

### Task 2: Test that resumed implementation carries Q&A comments in context

The spec (Section 5) says: "When resuming after clarification, `implement.md` is used again. The Q&A context comes from ticket comments (fetched fresh)."

The current code does this correctly — `handleImplementation` always calls `jira.fetchTicket()` which returns fresh comments, and `assembleImplementationContext` includes all comments. But there is no test proving this. Adding one makes the behavior explicit and prevents regressions.

**Files:**
- Modify: `src/worker.test.ts`

- [ ] **Step 1: Write the test**

Add the following test inside the existing `describe("worker handler", ...)` block in `src/worker.test.ts`:

```typescript
it("includes Q&A comments in context when resuming after clarification", async () => {
  const ticketWithAnswers = {
    ...defaultTicket,
    comments: [
      { author: "Alice", body: "Use CSS variables", createdAt: new Date("2026-03-10") },
      { author: "Blazebot", body: "What color scheme should be used?", createdAt: new Date("2026-03-11") },
      { author: "Alice", body: "Use the Material Design dark palette", createdAt: new Date("2026-03-12") },
    ],
  };

  mockJira.fetchTicket.mockResolvedValue(ticketWithAnswers);
  mockRunSandbox.mockResolvedValue({
    exitCode: 0,
    status: "complete",
    summary: "Implemented with Material Design palette",
  });

  const { createWorker } = await import("./worker.js");
  const worker = createWorker();
  const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

  await handler(
    makeJob({
      type: "implementation",
      ticketId: "PROJ-42",
      source: "jira",
      triggeredBy: "Mia",
    }),
  );

  expect(mockRunSandbox).toHaveBeenCalledWith(
    expect.objectContaining({
      requirementsMd: expect.stringContaining("What color scheme should be used?"),
    }),
  );
  expect(mockRunSandbox).toHaveBeenCalledWith(
    expect.objectContaining({
      requirementsMd: expect.stringContaining("Use the Material Design dark palette"),
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/worker.test.ts`
Expected: All tests PASS. This test verifies existing behavior — it should pass immediately since `assembleImplementationContext` already includes all comments.

- [ ] **Step 3: Commit**

```bash
git add src/worker.test.ts
git commit -m "test: verify resumed implementation carries Q&A comments (spec Section 5)"
```

---

### Task 3: Test that branch creation is idempotent on resume

When a ticket resumes from `clarification_pending`, the branch already exists from the first run. The handler calls `github.createBranch()` again — which succeeds silently because `GitHubClient.createBranch` swallows 422 (branch exists). This is correct but untested.

**Files:**
- Modify: `src/worker.test.ts`

- [ ] **Step 1: Write the test**

Add the following test inside the existing `describe("worker handler", ...)` block:

```typescript
it("calls createBranch on resume from clarification (adapter handles 422)", async () => {
  mockJira.fetchTicket.mockResolvedValue({ ...defaultTicket });
  // The adapter silently swallows 422 (branch exists), so mock resolves.
  // This test verifies the worker always calls createBranch, even on resume.
  mockGitHub.createBranch.mockResolvedValue(undefined);
  mockRunSandbox.mockResolvedValue({
    exitCode: 0,
    status: "complete",
    summary: "Done after resume",
  });

  const { createWorker } = await import("./worker.js");
  const worker = createWorker();
  const handler = (worker as unknown as { handler: (job: Job<TicketJobData>) => Promise<void> }).handler;

  await handler(
    makeJob({
      type: "implementation",
      ticketId: "PROJ-42",
      source: "jira",
      triggeredBy: "Mia",
    }),
  );

  expect(mockGitHub.createBranch).toHaveBeenCalledWith(
    "owner", "repo", "blazebot/PROJ-42", "main",
  );
  expect(mockRunSandbox).toHaveBeenCalled();
  expect(mockGitHub.createPR).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/worker.test.ts`
Expected: All tests PASS. The worker calls `createBranch` on every run (including resume); the adapter's 422 handling is tested separately in `github-client.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/worker.test.ts
git commit -m "test: verify branch creation called on resume (adapter handles 422)"
```

---

### Task 4: Test the router clarification→resume→AI round-trip

The router already has a test for `clarification_pending → AI` dispatching an `implementation` job. But it doesn't verify that the `triggeredBy` field carries through — this is important because the worker uses it for notifications on the resumed run.

**Files:**
- Modify: `src/webhooks/router.test.ts`

- [ ] **Step 1: Write the test**

Add the following test inside the existing `describe("routeTicketTransition", ...)` block in `src/webhooks/router.test.ts`:

```typescript
it("carries triggeredBy through when resuming from clarification_pending", async () => {
  const { routeTicketTransition } = await import("./router.js");

  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([
        { id: "uuid-1", workflowState: "clarification_pending" },
      ]),
    }),
  });
  mockDb.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });

  await routeTicketTransition({
    type: "ticket_moved",
    ticketId: "PROJ-42",
    fromColumn: "Backlog",
    toColumn: "AI",
    triggeredBy: "Bob",
    triggeredByAccountId: "user-bob-456",
  });

  expect(mockQueueAdd).toHaveBeenCalledWith(
    "implementation",
    expect.objectContaining({
      type: "implementation",
      ticketId: "PROJ-42",
      triggeredBy: "Bob",
    }),
    expect.any(Object),
  );
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/webhooks/router.test.ts`
Expected: All tests PASS. This verifies existing behavior.

- [ ] **Step 3: Commit**

```bash
git add src/webhooks/router.test.ts
git commit -m "test: verify triggeredBy carried through on clarification resume"
```

---

### Task 5: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 2: Commit (if any formatting/lint fixes needed)**

If the test run reveals lint issues, fix and commit. Otherwise no action needed.

---

## Spec Alignment Notes

This plan hardens the following spec requirements:

| Spec Section | Requirement | Status Before | Status After |
|---|---|---|---|
| 5 | Prompts must include `[OVERRIDE]` comment handling | Missing from `implement.md` | Added |
| 5 | Resumed implementation uses same prompt with fresh Q&A from comments | Working but untested | Tested |
| 16.1 | Branch creation called on every run; adapter handles 422 (branch exists) | Working but untested at worker level | Tested |
| 8.1 | Clarification resume dispatches `implementation` job with correct `triggeredBy` | Working but `triggeredBy` not verified in test | Tested |

**Already working and tested (no changes needed):**
- Worker: `clarification_needed` → post questions → move to Backlog → notify → push WIP → teardown (worker.test.ts)
- Router: `clarification_pending` ticket moved to AI → enqueue `implementation` (router.test.ts)
- Router: self-transition filter for Backlog echo (router.ts lines 175-178)
- Context: `assembleImplementationContext` includes all comments chronologically (context.test.ts)

**Not in scope:**
- End-to-end integration test spanning router + worker (would need real or in-memory DB, deferred to integration phase per spec Section 17.7).
