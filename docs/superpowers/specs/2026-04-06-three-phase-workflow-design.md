# Three-Phase Agent Workflow

**Date**: 2026-04-06
**Status**: Draft

## Problem

The current system has two separate workflows (`implementationWorkflow` and `reviewFixWorkflow`) that each dump all context into a single agent invocation. This has several issues:

- The agent receives a large, undifferentiated context blob and must figure out what to do
- No workflow-level control between logical phases — if research reveals clarification is needed, the agent has already started coding
- The implementation prompt is overloaded with instructions for exploration, planning, coding, testing, and review
- Two separate workflows with duplicated orchestration logic (polling, push, teardown)
- No separation of concerns — one agent failure means the entire ticket fails with no intermediate artifacts

## Solution

Replace both workflows with a **single unified `agentWorkflow`** that handles all ticket scenarios (new implementation, review-fix, partial work). The workflow splits work into **three sequential phases** within the same sandbox, each a separate `claude --print` call. The **workflow** orchestrates transitions, checks results between phases, and decides whether to proceed or fail fast.

```
┌─────────────────────────────────────────────────────────────────────┐
│ SANDBOX (single, alive for entire flow)                             │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────┐            │
│  │ Research &    │───▶│ Implementation   │───▶│ Review │            │
│  │ Plan (claude) │    │ (claude)         │    │(claude)│            │
│  └──────┬───────┘    └────────┬─────────┘    └───┬────┘            │
│         │                     │                   │                 │
│     fail fast            fail fast          ┌─────┴──────┐         │
│     on error/            on error/          │  approved?  │         │
│     clarification        clarification      └─────┬──────┘         │
│                                               yes  │  no (max 2)   │
│                                                    │  └──▶ back    │
│                                                    │    to impl    │
│                                                    ▼                │
│                                                  push              │
└─────────────────────────────────────────────────────────────────────┘
```

### Unified Flow

The `agentWorkflow` replaces both `implementationWorkflow` and `reviewFixWorkflow`. It handles all scenarios because Phase 1 (Research & Plan) adapts to the current state:

| Scenario | What Phase 1 sees | What it plans |
|----------|-------------------|---------------|
| **New ticket** (no branch/PR) | Empty branch, full requirements | Full implementation |
| **Ticket with existing PR + review feedback** | Existing commits + PR comments + CI failures | Only the fixes needed |
| **Ticket with partial work** | Some commits, incomplete work | Remaining steps |

The workflow always receives PR feedback and CI results **when they exist**. The research agent sees this context and plans accordingly.

### Dispatch Simplification

`dispatch.ts` no longer branches between two workflow types. It always starts `agentWorkflow(ticketId)`. The workflow itself handles the branch check, PR context fetching, and merge-base logic internally.

## Phase 1 — Research & Plan

### Purpose

Explore the repository, understand the ticket, check for existing work on the branch, and produce a **precise, minimal implementation plan** with only actionable steps.

### Input

Written to `/tmp/research-requirements.md`:

- Ticket ID, title, description, acceptance criteria, comments
- Branch name (for checking existing changes via `git log`/`git diff`)
- **PR review feedback** (if an existing PR has comments — fetched by workflow)
- **CI/CD check results** (if an existing PR has failed checks — fetched by workflow)
- **Merge conflict status** (if applicable)
- Research & planning prompt (see Prompts section)

### Agent Behavior

1. **Read session memory** — check `blazebot/memory/[TASK_ID].md` for context from prior runs
2. Explore repo structure, read `CLAUDE.md`/`AGENTS.md` if present
3. Check `git log` / `git diff` against base branch to identify existing changes
4. If PR feedback/CI failures are present: understand what needs to be fixed
5. Identify what's already implemented vs. what remains
6. Analyze relevant files, code patterns, test setup
7. **Use the `brainstorming` skill from superpowers** to think through the approach
8. Produce a clean implementation plan with only actionable steps for the remaining work
9. Write/update session memory

### Output Format

The research agent output is **free-form markdown**, not structured JSON. This gives the agent flexibility to express findings naturally and organize the plan in the way that best fits the specific ticket.

The only structured requirement is a **status line** at the very top of the output:

```
STATUS: completed | clarification_needed | failed
```

The workflow parses only this status line to decide next steps. The rest of the output (the plan, research findings, etc.) is passed as-is to Phase 2 as context.

#### Output Constraints

The plan portion must be **minimal and precise**:
- Each step must be directly actionable ("Create file X with Y" not "Consider how to...")
- No preamble, rationale, or noise that would confuse the implementation agent
- File paths must be concrete, not vague ("src/components/Foo.tsx" not "the relevant component")
- The output should be structured so the implementation agent can read it top-to-bottom and execute

If `STATUS: clarification_needed`, the output should contain the questions (one per line, numbered). The workflow will extract and post them to Jira.

If `STATUS: failed`, the output should contain the error description.

### Workflow Decision After Phase 1

| Status line | Action |
|-------------|--------|
| `completed` | Save full output to `/tmp/research-plan-output.md`, proceed to Phase 2 |
| `clarification_needed` | Extract questions from output, post on Jira, move to backlog, teardown |
| `failed` | Notify Slack with error, move to backlog, teardown |

### Sentinel & Output Files

- Stdout: `/tmp/research-stdout.txt`
- Stderr: `/tmp/research-stderr.txt`
- Sentinel: `/tmp/research-done`
- Plan (written by workflow after parsing): `/tmp/research-plan-output.md`

## Phase 2 — Implementation

### Purpose

Execute the plan from Phase 1. The agent receives precise instructions and focuses solely on coding, testing, and committing.

### Input

Written to `/tmp/impl-requirements.md`:

- Ticket ID, title, acceptance criteria (for reference, kept brief)
- **Full research & plan output from Phase 1** (free-form markdown — passed as-is)
- If this is a **retry after review feedback**: also includes the review issues and feedback
- Implementation prompt (see Prompts section)

### Agent Behavior

1. Read the plan from Phase 1 output
2. **Use the `executing-plans` skill from superpowers** to execute the plan systematically
3. If retry: read review feedback, focus on fixing flagged issues
4. Execute each step in order
5. Run tests and quality checks
6. Commit all changes with descriptive messages

### Output Schema

Same as today's `AgentOutput`:

```typescript
const implOutputSchema = z.object({
  result: z.enum(["implemented", "clarification_needed", "failed"]),
  summary: z.string().optional(),
  questions: z.array(z.string()).optional(),
  error: z.string().optional(),
});
```

### Workflow Decision After Phase 2

| Result | Action |
|--------|--------|
| `implemented` | Proceed to Phase 3 (Review) |
| `clarification_needed` | Post questions on Jira, move to backlog, teardown |
| `failed` | Notify Slack, move to backlog, teardown |

### Sentinel & Output Files

- Stdout: `/tmp/impl-stdout.txt`
- Stderr: `/tmp/impl-stderr.txt`
- Sentinel: `/tmp/impl-done`

## Phase 3 — Review

### Purpose

Review the implementation diff against the plan and acceptance criteria. Check code quality, test coverage, and completeness. Use the `requesting-code-review` skill.

### Input

Written to `/tmp/review-requirements.md`:

- Ticket ID, title, acceptance criteria
- Plan output from Phase 1 (what was supposed to happen)
- Git diff of all changes (`git diff <base-sha>..HEAD` — captured by workflow via sandbox command)
- Review prompt (see Prompts section)

### Agent Behavior

1. Read the plan and acceptance criteria
2. Review the diff against the plan — did the agent follow it?
3. Check code quality, test coverage, edge cases
4. Invoke `requesting-code-review` skill to dispatch a code-reviewer subagent
5. Output approval or specific issues to fix

### Output Schema

```typescript
const reviewOutputSchema = z.object({
  result: z.enum(["approved", "changes_requested", "failed"]),
  feedback: z.string().describe("Detailed review notes"),
  issues: z.array(z.object({
    file: z.string(),
    description: z.string(),
    severity: z.enum(["critical", "suggestion"]),
  })).describe("Specific issues found"),
  error: z.string().optional(),
});

type ReviewOutput = z.infer<typeof reviewOutputSchema>;
```

### Workflow Decision After Phase 3

| Result | Action |
|--------|--------|
| `approved` | Push, create PR (or update existing), move to AI Review, notify Slack |
| `changes_requested` | If retries < MAX_REVIEW_RETRIES (2): loop back to Phase 2 with feedback. Otherwise: fail fast |
| `failed` | Notify Slack, move to backlog, teardown |

### Review → Implementation Loop

When review returns `changes_requested`:
1. Workflow increments a retry counter
2. Workflow writes a new `/tmp/impl-requirements.md` that includes:
   - Original plan from Phase 1
   - Review feedback (`issues` + `feedback` from review output)
   - Instruction: "Fix the issues listed below. Do not redo work that was approved."
3. Re-runs Phase 2 (implementation)
4. Re-runs Phase 3 (review)
5. Maximum 2 retries (3 total implementation attempts)

### Sentinel & Output Files

- Stdout: `/tmp/review-stdout.txt`
- Stderr: `/tmp/review-stderr.txt`
- Sentinel: `/tmp/review-done`

## Wrapper Script Changes

The current `buildWrapperScript` generates a single hardcoded script. It needs to become parameterized to support multiple phases.

### New Signature

```typescript
interface PhaseScriptOptions {
  model: string;
  phase: "research" | "impl" | "review";
  inputFile: string;       // e.g. "/tmp/research-requirements.md"
  outputFile: string;      // e.g. "/tmp/research-stdout.txt"
  stderrFile: string;      // e.g. "/tmp/research-stderr.txt"
  sentinelFile: string;    // e.g. "/tmp/research-done"
  jsonSchema?: string;     // phase-specific JSON schema (only for impl and review phases)
}

function buildPhaseScript(opts: PhaseScriptOptions): string;
```

The generated script follows the same pattern as today:
1. `cat <inputFile> | claude --print --model X --dangerously-skip-permissions [--output-format json --json-schema '<schema>'] > <outputFile> 2><stderrFile>`
   - Research phase: NO `--output-format json` or `--json-schema` (free-form markdown output)
   - Implementation and review phases: include `--output-format json --json-schema` for structured output
2. Cleanup `.claude/` artifacts
3. `touch <sentinelFile>`

### Stop Hook Behavior

- **Research & Plan phase**: Stop hook should NOT enforce commits (research agent doesn't write code)
- **Implementation phase**: Stop hook enforces commits (same as today)
- **Review phase**: Stop hook should NOT enforce commits (review agent only reads)

**Decision**: Simplest approach — only install the stop hook before Phase 2 (implementation), remove it before Phase 1 and Phase 3. Since the sandbox is provisioned once, the workflow can run a command to toggle the hook between phases.

## Context Assembly Changes

### Current

- `assembleImplementationContext(ticket, prompt)` — one function, one context
- `assembleFixingFeedbackContext(ticket, prompt, prComments, hasConflicts, checkResults)` — for review-fix

### New

Three new context assembly functions in `src/sandbox/context.ts`:

```typescript
// Phase 1 input — includes optional PR feedback for review-fix scenarios
interface ResearchPlanContextInput {
  ticket: TicketData;
  prompt: string;
  branchName: string;
  prComments?: PRComment[];        // present when PR exists
  checkResults?: CheckRunResult[]; // present when PR exists
  hasConflicts?: boolean;          // present when PR exists
}
function assembleResearchPlanContext(input: ResearchPlanContextInput): string;

// Phase 2 input (first run)
interface ImplementationContextInput {
  ticket: TicketData;        // kept minimal — ID, title, acceptance criteria only
  prompt: string;
  researchPlanMarkdown: string;  // free-form output from Phase 1, passed as-is
}
function assembleImplementationContext(input: ImplementationContextInput): string;

// Phase 2 input (retry after review)
interface ImplementationRetryContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;  // free-form output from Phase 1, passed as-is
  reviewFeedback: ReviewOutput;
}
function assembleImplementationRetryContext(input: ImplementationRetryContextInput): string;

// Phase 3 input
interface ReviewContextInput {
  ticket: TicketData;        // kept minimal — ID, title, acceptance criteria only
  prompt: string;
  researchPlanMarkdown: string;  // free-form output from Phase 1, passed as-is
  gitDiff: string;
}
function assembleReviewContext(input: ReviewContextInput): string;
```

The old `assembleFixingFeedbackContext` is removed — its PR feedback/CI data is now fed into `assembleResearchPlanContext` instead.

## Prompt Changes

### Current

- `implement.md` — single monolithic prompt (exploration + planning + coding + testing + review)
- `review-fix.md` — for fixing PR feedback

### New

Three new prompts in `src/lib/prompts.ts`. The old `implement.md` and `review-fix.md` are removed.

#### `research-plan.md`

Focused prompt for Phase 1:
- **Read session memory** (`blazebot/memory/[TASK_ID].md`) first if it exists
- Explore the repo, check existing changes on the branch
- If PR feedback/CI failures are present: factor them into the plan
- **Use the `brainstorming` skill** to think through the approach
- Produce a precise implementation plan — actionable steps only, no noise
- Output starts with `STATUS: completed|clarification_needed|failed` on the first line
- Check for clarification needs (same criteria as today)
- Write/update session memory
- NO coding, NO commits
- NO `--output-format json` or `--json-schema` for this phase (free-form markdown output)

#### `implement.md` (rewritten)

Focused prompt for Phase 2:
- **Use the `executing-plans` skill** to systematically execute the plan from Phase 1
- If retrying: fix the review feedback, do not redo approved work
- Run tests and quality checks
- Commit with descriptive messages
- Write/update session memory
- NO exploration (already done), NO planning (already done), NO code review (separate phase)

#### `review.md` (new)

Focused prompt for Phase 3:
- Review the diff against the plan and acceptance criteria
- Check code quality, test coverage, edge cases
- Use `requesting-code-review` skill to dispatch code-reviewer subagent
- Output approval or specific, actionable issues
- NO coding, NO commits

## Workflow Changes

### `src/workflows/implementation.ts` → `src/workflows/agent.ts`

Renamed and rewritten. The exported function becomes `agentWorkflow(ticketId: string)`.

The workflow changes from:

```
fetchTicket → createBranch → assembleContext → provision → startAgent → poll → collect → handle result → push → PR
```

To:

```
fetchTicket → createBranch → fetchPRContext (if PR exists) → provision sandbox (with mergeBase if PR exists)
  → Phase 1: writeResearchInput (includes PR feedback if any) → startResearchAgent → poll → collect → check
  → Phase 2: writeImplInput → configureStopHook(on) → startImplAgent → poll → collect → check
  → Phase 3: captureGitDiff → writeReviewInput → configureStopHook(off) → startReviewAgent → poll → collect → check
  → if changes_requested and retries < MAX: goto Phase 2
  → push → createOrUpdatePR → cleanup
```

### `src/workflows/review-fix.ts` — DELETED

All review-fix logic is absorbed into `agentWorkflow`. The research agent handles PR feedback as part of its context.

### `src/lib/dispatch.ts` — Simplified

```typescript
// Before: branching between two workflows
const existingPR = await vcs.findPR(branchName);
const handle = existingPR
  ? await start(reviewFixWorkflow, [ticket.id, branchName])
  : await start(implementationWorkflow, [ticket.id]);

// After: always the same workflow
const handle = await start(agentWorkflow, [ticket.id]);
```

The workflow internally checks for existing PRs and fetches context as needed.

### Key Implementation Details

1. **Sandbox provisioned once** — `SandboxManager.provision()` called once at the start. If a PR exists with merge conflicts, `mergeBase` is passed to provision (same as review-fix did). The three phase scripts are written and executed sequentially within the same sandbox.

2. **Phase execution is a reusable function** — extract a `runPhase(sandboxId, phaseConfig)` helper that handles: write input file → write wrapper script → start detached → poll → collect → parse output. This avoids duplicating the polling loop three times.

3. **Pre-agent SHA recorded once** — `/tmp/.pre-agent-sha` is written during provisioning (before any agent runs). The push step compares against this to detect commits.

4. **Git diff for review** — before Phase 3, the workflow runs `git diff <base-sha>..HEAD` inside the sandbox (via `sandbox.runCommand`) and passes the output to the review context.

5. **Stop hook toggling** — the workflow writes `~/.claude/settings.json` with/without the stop hook before each phase. Research and review phases get an empty hooks config; implementation gets the commit-guard hook.

6. **Retry counter** — tracked as a workflow-level variable, not persisted to disk. Incremented when review returns `changes_requested`.

7. **PR handling** — if a PR already exists, the workflow pushes to the same branch (force push, same as today) and does NOT create a new PR. If no PR exists, it creates one.

### New Step Functions

```typescript
// Generic phase runner — handles write input, start agent, poll, collect
async function runPhase(
  sandboxId: string,
  phase: PhaseConfig,
): Promise<{ raw: string }>;

// Write phase input file to sandbox
async function writePhaseInput(
  sandboxId: string,
  inputFile: string,
  content: string,
): Promise<void>;

// Toggle stop hook on/off
async function configureStopHook(
  sandboxId: string,
  enabled: boolean,
): Promise<void>;

// Capture git diff for review phase
async function captureGitDiff(
  sandboxId: string,
): Promise<string>;

// Fetch PR context (comments, checks, conflicts) — returns null if no PR exists
async function fetchPRContext(
  branchName: string,
): Promise<PRContext | null>;
```

## Session Memory

Session memory (`blazebot/memory/[TASK_ID].md`) behavior:

- **Phase 1 (Research & Plan)**: Reads memory first (for context from prior runs), then writes updated memory with research findings and plan
- **Phase 2 (Implementation)**: Reads and updates session memory with implementation progress
- **Phase 3 (Review)**: Reads session memory for context, writes review findings

Each phase overwrites the memory file (same as today). The memory serves as additional context across phases and across workflow runs, but is NOT the primary handoff mechanism — the Phase 1 free-form output is the primary handoff to Phase 2 and 3.

## File Changes Summary

| File | Change |
|------|--------|
| `src/workflows/implementation.ts` | **Delete** — replaced by `agent.ts` |
| `src/workflows/review-fix.ts` | **Delete** — absorbed into `agent.ts` |
| `src/workflows/agent.ts` | **New** — unified three-phase `agentWorkflow` |
| `src/lib/dispatch.ts` | Simplify: remove workflow branching, always start `agentWorkflow` |
| `src/sandbox/wrapper-script.ts` | Parameterize: `buildPhaseScript(opts)` replacing `buildWrapperScript` |
| `src/sandbox/context.ts` | Add: `assembleResearchPlanContext`, rewrite `assembleImplementationContext`, add `assembleImplementationRetryContext`, add `assembleReviewContext`. Remove: `assembleFixingFeedbackContext` |
| `src/sandbox/agent-runner.ts` | Add: `ReviewOutput` schema + parser. Add: `parseResearchStatus()` (extracts STATUS line from free-form output) |
| `src/sandbox/manager.ts` | Refactor: extract stop-hook config, support phase-based execution |
| `src/sandbox/poll-agent.ts` | Generalize: `checkPhaseDone(sandboxId, sentinelFile)`, `collectPhaseOutput(sandboxId, outputFile)` |
| `src/lib/prompts.ts` | Add: `research-plan.md`, `review.md`. Rewrite: `implement.md`. Remove: `review-fix.md` |
| `src/sandbox/run-agent.ts` | Generalize: accept phase config instead of hardcoded paths |

## Skills Installation

The current `GLOBAL_SKILLS` in `manager.ts` installs:
- `using-superpowers` (from `superpowers` repo)
- `requesting-code-review` (from `superpowers` repo)
- `frontend-design` (from `anthropics/skills` repo)

The `brainstorming` and `executing-plans` skills (required by Phase 1 and Phase 2) are part of the `superpowers` repo and are discoverable via the `using-superpowers` skill — they do NOT need separate installs. The phase prompts will explicitly instruct the agent to use them.

No changes to `GLOBAL_SKILLS` are needed.

## Non-Goals

- **Parallel phase execution** — phases are sequential by design
- **Multiple sandboxes** — single sandbox for the entire flow
- **Agent-to-agent communication** — phases communicate only through files orchestrated by the workflow
