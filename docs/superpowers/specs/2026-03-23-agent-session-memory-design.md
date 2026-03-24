# Agent Session Memory

## Problem

When blazebot's agent hits a blocker (needs clarification, incomplete data), it returns `clarification_needed` and the ticket moves to backlog. When the ticket returns to the AI column, a fresh agent session starts with zero context about what was already done — wasting tokens re-analyzing the codebase and potentially making different decisions.

## Solution

Prompt changes to `implement.md` and `review-fix.md`, plus a one-line code change to `context.ts` to include the ticket identifier in `requirements.md`.

The agent writes a structured memory file to `blazebot/memory/[TASK_ID].md` on the feature branch. On subsequent runs, it checks for this file first and restores context before doing any work. The memory file is **always updated before completing** — regardless of outcome — so it serves as a cumulative audit trail and context source for future sessions (including review-fix).

## Code Change

**`src/sandbox/context.ts`** — Add `ticket.identifier` to both `assembleImplementationContext` and `assembleFixingFeedbackContext` so the agent knows the Jira key (e.g., `AIW-123`) for naming the memory file.

The `ImplementationContextInput` and `FixingFeedbackContextInput` interfaces gain an `identifier: string` field. The rendered requirements.md gets a `## Ticket ID` section.

Callers in `implementation.ts` and `review-fix.ts` pass `ticket.identifier` through.

## Memory File

**Location:** `blazebot/memory/[TASK_ID].md` (e.g., `blazebot/memory/AIW-123.md`)

The agent derives `TASK_ID` from the ticket identifier in requirements.md.

**Format:**

```markdown
# Session Memory — [TASK_ID]

## Progress
- What was analyzed, understood, attempted so far

## Decisions Made
- Technical choices and reasoning

## Blockers
- What's blocking progress (if clarification_needed)
- Specific questions that need answers

## Files Touched
- List of files created/modified with brief notes
```

## Agent Flow

```
Agent starts
  → Check if blazebot/memory/[TASK_ID].md exists
  → If yes: read it, restore context, skip re-analysis
  → If no: proceed normally
  → Work on task
  → ALWAYS update memory file before returning (any outcome)
  → Return result (implemented / clarification_needed / failed)
```

The memory file is updated on **every** outcome — not just blockers. This ensures:
- Review-fix agents always have implementation context available
- Multiple sessions build a cumulative record of progress and decisions
- The file serves as an audit trail even for successful runs

## Prompt Changes

### implement.md

1. **New step 0 (before all other steps):** Check for `blazebot/memory/[TASK_ID].md`. If it exists, read it immediately to restore context from a previous session. Use the progress, decisions, and file list to avoid redundant analysis.

2. **New "Session Memory" section:** Before returning your result (any outcome — `implemented`, `clarification_needed`, or `failed`), write/update your session progress to `blazebot/memory/[TASK_ID].md` using the prescribed format. Include what you analyzed, decisions you made, current status, and which files you touched. Commit this file with your other changes.

### review-fix.md

1. **New step 0 (before all other steps):** Same as above — check for and read `blazebot/memory/[TASK_ID].md` to restore context from the implementation phase or prior fix attempts.

2. **New "Session Memory" section:** Before returning your result, update the memory file with your review-fix progress. The review-fix agent reads memory but also writes to it — appending its own progress, decisions, and files touched. Note: review-fix does not support `clarification_needed` as a result, so memory is written on `implemented` or `failed` outcomes only.

## Changes Summary

| File | Change |
|------|--------|
| `src/sandbox/context.ts` | Add `identifier` field to context interfaces, render `## Ticket ID` section |
| `src/workflows/implementation.ts` | Pass `ticket.identifier` to context assembly |
| `src/workflows/review-fix.ts` | Pass `ticket.identifier` to context assembly |
| `.blazebot/prompts/implement.md` | Add step 0 (read memory) + Session Memory section |
| `.blazebot/prompts/review-fix.md` | Add step 0 (read memory) + Session Memory section |

## Why This Works

- **File persistence:** The sandbox clones the feature branch. Memory files committed on previous runs are already on disk.
- **File extraction:** `extractChanges` picks up all files changed in the last commit, including `blazebot/memory/*.md`.
- **Push:** `pushChanges` pushes all extracted files to the branch, including memory files.
- **End hook:** `runEndHook` force-commits any uncommitted changes before teardown, ensuring memory files are never lost even if the agent forgets to commit.

## Memory File Lifecycle

1. **First run:** Agent works normally. Before returning (any outcome), it creates `blazebot/memory/AIW-123.md` with session progress.
2. **Subsequent runs (memory exists):** Agent reads memory file as step 0, skips redundant analysis, picks up where it left off. Updates the memory file before returning.
3. **Review-fix runs:** Agent reads existing memory to understand implementation context and prior decisions. Updates memory with review-fix progress.
4. **Completion:** Memory file stays on the branch as an audit trail.

## Edge Cases

- **Multiple clarification rounds:** Memory file is updated/overwritten each time with cumulative progress.
- **Review-fix after implementation:** Review-fix agent reads implementation memory for context, then appends its own progress.
- **First run succeeds:** Memory file is still created — captures decisions and progress for potential review-fix sessions.
