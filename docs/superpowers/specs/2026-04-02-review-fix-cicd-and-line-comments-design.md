# Review-Fix Flow: CI/CD Check Awareness & Structured Line Comments

## Problem

When the review-fix workflow runs, the agent is missing two key pieces of information:

1. **CI/CD check results** — the agent has no visibility into whether checks (lint, build, tests, e2e) passed or failed. It cannot act on failures it doesn't know about.
2. **Line-coupled comment location** — review comments attached to specific lines lose their file path and line numbers. The agent sees flat text like `"Bob: Fix the typo"` with no indication of where in the code the comment refers to.

## Solution

### 1. Enrich `PRComment` with Location Fields

Extend the existing `PRComment` interface with optional location fields. GitHub's `pulls.listReviewComments()` already returns `path`, `start_line`, and `line` — currently discarded.

**Updated `PRComment` in `src/adapters/vcs/types.ts`:**

```typescript
export interface PRComment {
  author: string;
  body: string;
  liked: boolean;
  filePath?: string;    // only on review comments (not issue comments)
  startLine?: number;   // start of the comment range
  endLine?: number;     // end of the comment range (same as startLine for single-line)
}
```

**GitHub adapter mapping in `getPRComments()`:**

Review comments map `c.path` -> `filePath`, `c.start_line` -> `startLine`, `c.line` -> `endLine`.
Issue comments have no location and remain as-is.

**Context formatting in `formatPRComments()`:**

Line-coupled comments render with a structured header:

```
### src/lib/auth.ts (lines 42-45)
Bob: Use a constant instead of a magic number

### src/components/Form.tsx (line 12)
Alice (liked): Looks good but add error handling
```

General comments (no `filePath`) render as before:

```
Bob: Overall looks good, just a few nits
```

Comments are grouped: line-coupled comments first (sorted by file path), then general comments.

### 2. CI/CD Check Results with Logs for Failures

Add a new type and method to fetch check run results, including full log output for failed checks.

**New type in `src/adapters/vcs/types.ts`:**

```typescript
export interface CheckRunResult {
  name: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: string | null; // "success", "failure", "cancelled", "timed_out", etc.
  logs?: string;             // full output, only populated for non-success conclusions
}
```

**New method on `VCSAdapter` interface:**

```typescript
getCheckRunResults(prId: number): Promise<CheckRunResult[]>;
```

**GitHub adapter implementation:**

1. Get the PR's head SHA via `pulls.get(prId)`
2. Call `checks.listForRef({ ref: headSha })` to get all check runs
3. For each check where `conclusion !== 'success'` and status is `'completed'`: fetch logs via `actions.listJobsForWorkflowRun()` to find the matching job, then `actions.downloadJobLogsForWorkflowRun()` for the log content
4. Return all checks; only failures have `logs` populated

**Context formatting — new `formatCheckResults()` function:**

All checks passed:
```
All CI/CD checks passed.
```

No checks found:
```
No CI/CD checks found.
```

Mixed results:
```
Passed: lint, build, type-check

### Failed: test
<full log output here>

### Failed: e2e
<full log output here>
```

### 3. Thread Data Through the Workflow

**`FixingFeedbackContextInput` in `src/sandbox/context.ts`:**

```typescript
export interface FixingFeedbackContextInput {
  ticket: TicketData;
  prompt: string;
  skills?: string;
  prComments: PRComment[];
  hasConflicts: boolean;
  checkResults: CheckRunResult[];
}
```

**`assembleFixingFeedbackContext()` adds a new section** between "PR Review Feedback" and "Merge Conflicts":

```
## CI/CD Check Results

<formatted check results>
```

**`fetchPRContext()` in `src/workflows/review-fix.ts`:**

Add `vcs.getCheckRunResults(pr.id)` call alongside existing comment and conflict fetches. Return `checkResults` in the result object.

**`assembleReviewFixRequirements()`** passes `checkResults` through to `assembleFixingFeedbackContext()`.

### 4. Prompt Update

In the review-fix prompt (`src/lib/prompts.ts`), add a new step after merge conflict resolution and before addressing review comments:

```
3. If CI/CD checks failed, read the failure logs in "CI/CD Check Results" and fix the underlying issues (test failures, lint errors, build errors, etc.).
```

Update the constraints section to acknowledge CI failures as actionable:

```
- Address CI/CD check failures in addition to review comments.
```

## Files Changed

| File | Change |
|------|--------|
| `src/adapters/vcs/types.ts` | Add fields to `PRComment`, add `CheckRunResult`, add `getCheckRunResults` to `VCSAdapter` |
| `src/adapters/vcs/github.ts` | Map location fields in `getPRComments()`, implement `getCheckRunResults()` |
| `src/sandbox/context.ts` | Update `FixingFeedbackContextInput`, add `formatCheckResults()`, update `formatPRComments()` grouping, add CI/CD section to template |
| `src/workflows/review-fix.ts` | Fetch check results in `fetchPRContext()`, pass to context assembly |
| `src/lib/prompts.ts` | Add CI/CD step to review-fix prompt |
| `src/sandbox/context.test.ts` | Update tests for new fields and formatting |

## Edge Cases

- **Non-GitHub-Actions checks** (external CI like CircleCI, Jenkins): `checks.listForRef()` returns the check run but `actions.downloadJobLogsForWorkflowRun()` won't work. For these, populate `logs` as `null` and show the check name + conclusion without logs.
- **Very large logs**: GitHub Actions logs can be large. No truncation — the agent needs the full output to diagnose failures. If this becomes a token problem in practice, we can add truncation later.
- **No check runs at all**: Some repos may not have CI configured. Show "No CI/CD checks found." and proceed normally.

## Out of Scope

- Fetching logs for in-progress or queued checks (only completed failures)
- Re-running failed checks from the agent
- Fetching review approval/request status
- Threaded comment conversations (parent/reply chains)
