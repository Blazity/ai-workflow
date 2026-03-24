# Agent Session Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give blazebot agents persistent session memory so they can restore context across runs instead of starting from scratch.

**Architecture:** Pure prompt changes to `implement.md` and `review-fix.md` instruct the agent to read/write a `blazebot/memory/[TASK_ID].md` file on the feature branch. A small code change to `context.ts` adds the ticket identifier to `requirements.md` so the agent knows the task ID. Callers in both workflow files pass the identifier through.

**Tech Stack:** TypeScript (Nitropack), Markdown prompts

**Spec:** `docs/superpowers/specs/2026-03-23-agent-session-memory-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/sandbox/context.ts` | Modify | Add `identifier` to interfaces and rendered context |
| `src/sandbox/context.test.ts` | Modify | Add `identifier` to test data, assert `## Ticket ID` renders |
| `src/workflows/implementation.ts` | Modify | Pass `ticket.identifier` to context assembly |
| `src/workflows/review-fix.ts` | Modify | Pass `ticket.identifier` to context assembly |
| `.blazebot/prompts/implement.md` | Modify | Add memory read (step 0) + memory write (Session Memory section) |
| `.blazebot/prompts/review-fix.md` | Modify | Add memory read (step 0) + memory write (Session Memory section) |

---

### Task 1: Add ticket identifier to context assembly

**Files:**
- Modify: `src/sandbox/context.ts:3-8` (TicketData interface)
- Modify: `src/sandbox/context.ts:22-48` (assembleImplementationContext)
- Modify: `src/sandbox/context.ts:51-86` (assembleFixingFeedbackContext)

- [ ] **Step 1: Add `identifier` to `TicketData` interface**

In `src/sandbox/context.ts`, add `identifier` to the `TicketData` interface:

```typescript
interface TicketData {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}
```

- [ ] **Step 2: Add `## Ticket ID` section to `assembleImplementationContext`**

In the template string returned by `assembleImplementationContext`, add a `## Ticket ID` section right after `# Requirements`:

```typescript
export function assembleImplementationContext(
  input: ImplementationContextInput,
): string {
  const { ticket, prompt } = input;

  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

---

${prompt}
`;
}
```

- [ ] **Step 3: Add `## Ticket ID` section to `assembleFixingFeedbackContext`**

Same change — add `## Ticket ID\n\n${ticket.identifier}` right after `# Requirements` in the `assembleFixingFeedbackContext` template string:

```typescript
export function assembleFixingFeedbackContext(
  input: FixingFeedbackContextInput,
): string {
  const { ticket, prompt, prComments, hasConflicts } = input;

  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Description

${ticket.description}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Comments

${formatComments(ticket.comments)}

## PR Review Feedback

${formatPRComments(prComments)}

## Merge Conflicts

${hasConflicts ? "This PR has merge conflicts that must be resolved." : "No merge conflicts."}

---

${prompt}
`;
}
```

- [ ] **Step 4: Update `context.test.ts` — add `identifier` to test data**

In `src/sandbox/context.test.ts`, add `identifier` to both test ticket objects and add assertions for the new section:

```typescript
import { describe, it, expect } from "vitest";
import { assembleImplementationContext, assembleFixingFeedbackContext } from "./context.js";

describe("assembleImplementationContext", () => {
  it("assembles requirements.md for implementation", () => {
    const result = assembleImplementationContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page with OAuth",
        acceptanceCriteria: "- User can log in\n- User can log out",
        comments: [
          { author: "Alice", body: "Use OAuth2", createdAt: "2026-03-20T10:00:00Z" },
        ],
      },
      prompt: "You are an implementation agent...",
    });

    expect(result).toContain("# Requirements");
    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-1");
    expect(result).toContain("Add login page");
    expect(result).toContain("Build a login page with OAuth");
    expect(result).toContain("User can log in");
    expect(result).toContain("Alice: Use OAuth2");
    expect(result).toContain("You are an implementation agent...");
  });
});

describe("assembleFixingFeedbackContext", () => {
  it("assembles requirements.md for fixing feedback", () => {
    const result = assembleFixingFeedbackContext({
      ticket: {
        identifier: "TEST-2",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "You are a review-fix agent...",
      prComments: [
        { author: "Bob", body: "Fix the typo on line 5", liked: true },
      ],
      hasConflicts: true,
    });

    expect(result).toContain("# Requirements");
    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-2");
    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("Fix the typo on line 5");
    expect(result).toContain("## Merge Conflicts");
    expect(result).toContain("You are a review-fix agent...");
  });
});
```

- [ ] **Step 5: Run tests to verify**

Run: `npx vitest run src/sandbox/context.test.ts`
Expected: Both tests pass

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/context.ts src/sandbox/context.test.ts
git commit -m "feat: add ticket identifier to context assembly"
```

---

### Task 2: Pass ticket identifier from workflow callers

**Files:**
- Modify: `src/workflows/implementation.ts:25-41` (assembleImplementationRequirements)
- Modify: `src/workflows/review-fix.ts:32-53` (assembleReviewFixRequirements)

- [ ] **Step 1: Update `assembleImplementationRequirements` in `implementation.ts`**

Add `identifier: ticket.identifier` to the ticket object passed to `assembleImplementationContext`:

```typescript
async function assembleImplementationRequirements(ticket: TicketContent) {
  "use step";
  const { assembleImplementationContext } = await import("../sandbox/context.js");
  const { env } = await import("../../env.js");

  const prompt = env.IMPLEMENTATION_PROMPT ?? "";
  return assembleImplementationContext({
    ticket: {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
    },
    prompt,
  });
}
```

- [ ] **Step 2: Update `assembleReviewFixRequirements` in `review-fix.ts`**

Same change — add `identifier: ticket.identifier`:

```typescript
async function assembleReviewFixRequirements(
  ticket: TicketContent,
  prComments: PRComment[],
  hasConflicts: boolean,
) {
  "use step";
  const { assembleFixingFeedbackContext } = await import("../sandbox/context.js");
  const { env } = await import("../../env.js");

  const prompt = env.REVIEW_FIX_PROMPT ?? "";
  return assembleFixingFeedbackContext({
    ticket: {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments,
    },
    prompt,
    prComments,
    hasConflicts,
  });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/workflows/implementation.ts src/workflows/review-fix.ts
git commit -m "feat: pass ticket identifier to context assembly"
```

---

### Task 3: Add session memory instructions to implement.md

**Files:**
- Modify: `.blazebot/prompts/implement.md`

- [ ] **Step 1: Add memory restore as step 0 in Process section**

Replace the current `## Process` section with:

```markdown
## Process

0. **Restore session memory** — Check if `blazebot/memory/[TASK_ID].md` exists (where `[TASK_ID]` is the Ticket ID from above, e.g. `AIW-123`). If it exists, read it immediately. Use the progress, decisions, and file list to skip redundant analysis and pick up where the previous session left off.
1. Read and understand the requirements, description, and acceptance criteria.
2. Review existing code to understand the codebase structure.
3. **Assess ticket clarity** — before writing any code, evaluate whether the ticket provides enough information to implement correctly. If not, return `clarification_needed` (see below).
4. Write tests first (TDD) — integration and e2e tests are required.
5. Implement the feature to make tests pass.
6. Run all tests to ensure nothing is broken.
7. Self-review your changes for quality, correctness, and completeness.
8. **Update session memory** — before returning your result, write/update `blazebot/memory/[TASK_ID].md` (see Session Memory below).
9. Commit your work with descriptive commit messages.
```

- [ ] **Step 2: Add Session Memory section before the Output section**

Insert this new section between "Comment Overrides" and "Output":

```markdown
## Session Memory

Before returning your result — **regardless of outcome** (`implemented`, `clarification_needed`, or `failed`) — write or update `blazebot/memory/[TASK_ID].md` where `[TASK_ID]` is the Ticket ID (e.g. `AIW-123`). Create the `blazebot/memory/` directory if it does not exist.

Use this format:

```
# Session Memory — [TASK_ID]

## Progress
- What was analyzed, understood, and attempted this session

## Decisions Made
- Technical choices and reasoning (e.g. "Using existing Zod pattern from src/db/schema.ts")

## Blockers
- What is blocking progress (if clarification_needed or failed)
- Specific questions that need answers
- "None" if implemented successfully

## Files Touched
- List of files created or modified with brief notes
```

Keep the memory concise and factual. This file will be read by future agent sessions (including review-fix agents) to restore context.
```

- [ ] **Step 3: Commit**

```bash
git add .blazebot/prompts/implement.md
git commit -m "feat: add session memory instructions to implement prompt"
```

---

### Task 4: Add session memory instructions to review-fix.md

**Files:**
- Modify: `.blazebot/prompts/review-fix.md`

- [ ] **Step 1: Add memory restore as step 0 in Process section**

Replace the current `## Process` section with:

```markdown
## Process

0. **Restore session memory** — Check if `blazebot/memory/[TASK_ID].md` exists (where `[TASK_ID]` is the Ticket ID from above, e.g. `AIW-123`). If it exists, read it immediately. Use the progress, decisions, and file list to understand prior implementation context and any previous fix attempts.
1. Read the review feedback carefully.
2. If merge conflicts exist, merge the target branch and resolve conflicts first.
3. Address each review comment — implement the requested changes.
4. Run all tests to ensure nothing is broken.
5. Self-review your changes.
6. **Update session memory** — before returning your result, write/update `blazebot/memory/[TASK_ID].md` (see Session Memory below).
7. Commit your work with descriptive commit messages.
```

- [ ] **Step 2: Add Session Memory section before the Output section**

Insert this new section between "Comment Overrides" and "Output":

```markdown
## Session Memory

Before returning your result — **regardless of outcome** (`implemented` or `failed`) — write or update `blazebot/memory/[TASK_ID].md` where `[TASK_ID]` is the Ticket ID (e.g. `AIW-123`). Create the `blazebot/memory/` directory if it does not exist.

Use this format:

```
# Session Memory — [TASK_ID]

## Progress
- What was analyzed, understood, and attempted this session

## Decisions Made
- Technical choices and reasoning

## Blockers
- What is blocking progress (if failed)
- "None" if implemented successfully

## Files Touched
- List of files created or modified with brief notes
```

Keep the memory concise and factual. This file persists across sessions and serves as context for future runs.
```

- [ ] **Step 3: Commit**

```bash
git add .blazebot/prompts/review-fix.md
git commit -m "feat: add session memory instructions to review-fix prompt"
```

---

### Task 5: Verify end-to-end

- [ ] **Step 1: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Review all changes together**

Run: `git diff main --stat`

Verify exactly 6 files changed:
- `src/sandbox/context.ts`
- `src/sandbox/context.test.ts`
- `src/workflows/implementation.ts`
- `src/workflows/review-fix.ts`
- `.blazebot/prompts/implement.md`
- `.blazebot/prompts/review-fix.md`

- [ ] **Step 4: Spot-check the rendered context includes Ticket ID**

Read `src/sandbox/context.ts` and confirm the `## Ticket ID` section appears right after `# Requirements` in both functions.

- [ ] **Step 5: Spot-check prompts reference the memory file path correctly**

Read both `.blazebot/prompts/implement.md` and `.blazebot/prompts/review-fix.md` and confirm:
- Step 0 references `blazebot/memory/[TASK_ID].md`
- Session Memory section references `blazebot/memory/[TASK_ID].md`
- The memory format template is included
