# Three-Phase Agent Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace both `implementationWorkflow` and `reviewFixWorkflow` with a single unified `agentWorkflow` that splits work into three phases (research & plan → implementation → review) within one sandbox.

**Architecture:** The workflow provisions a single Vercel Sandbox and runs three sequential `claude --print` invocations. Between each phase, the workflow checks the result and decides whether to proceed, retry, or fail fast. Phase 1 outputs free-form markdown; Phases 2 and 3 use structured JSON schemas. The review phase can loop back to implementation up to 2 times.

**Tech Stack:** TypeScript, Nitro, Vercel Workflow SDK (`"use workflow"` / `"use step"`), Vercel Sandbox, Zod, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/sandbox/agent-runner.ts` | Modify | Add `REVIEW_SCHEMA`, `ReviewOutput`, `parseReviewOutput()`, `parseResearchStatus()` |
| `src/sandbox/agent-runner.test.ts` | Modify | Tests for new parsers |
| `src/sandbox/wrapper-script.ts` | Rewrite | `buildPhaseScript(opts)` replacing `buildWrapperScript(opts)` |
| `src/sandbox/wrapper-script.test.ts` | Rewrite | Tests for parameterized script builder |
| `src/sandbox/context.ts` | Rewrite | New assembly functions for all three phases |
| `src/sandbox/context.test.ts` | Rewrite | Tests for all new context assemblers |
| `src/sandbox/run-agent.ts` | Modify | Generalize to accept phase script path |
| `src/sandbox/poll-agent.ts` | Modify | Generalize sentinel/output file paths |
| `src/sandbox/poll-agent.test.ts` | Modify | Update tests for generalized functions |
| `src/sandbox/manager.ts` | Modify | Extract stop-hook toggling, remove wrapper script writing from provision |
| `src/sandbox/manager.test.ts` | Modify | Update tests |
| `src/lib/prompts.ts` | Rewrite | Three new prompts, remove old two |
| `src/workflows/agent.ts` | Create | Unified three-phase workflow |
| `src/workflows/implementation.ts` | Delete | Replaced by agent.ts |
| `src/workflows/review-fix.ts` | Delete | Absorbed into agent.ts |
| `src/lib/dispatch.ts` | Modify | Always start `agentWorkflow`, remove branching |
| `src/lib/dispatch.test.ts` | Modify | Update tests for unified workflow |

---

### Task 1: Add review output schema and research status parser to agent-runner

**Files:**
- Modify: `src/sandbox/agent-runner.ts`
- Modify: `src/sandbox/agent-runner.test.ts`

- [ ] **Step 1: Write failing tests for `parseResearchStatus`**

Add to `src/sandbox/agent-runner.test.ts`:

```typescript
describe("parseResearchStatus", () => {
  it("extracts completed status", () => {
    const raw = "STATUS: completed\n\n# Implementation Plan\n1. Create foo.ts";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("completed");
    expect(body).toContain("# Implementation Plan");
  });

  it("extracts clarification_needed status", () => {
    const raw = "STATUS: clarification_needed\n\n1. What database?\n2. Which auth?";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("clarification_needed");
    expect(body).toContain("What database?");
  });

  it("extracts failed status", () => {
    const raw = "STATUS: failed\n\nCould not access repository";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("failed");
  });

  it("defaults to failed when no STATUS line", () => {
    const raw = "Here is my analysis of the codebase...";
    const { status, body } = parseResearchStatus(raw);
    expect(status).toBe("failed");
    expect(body).toContain("analysis");
  });

  it("handles STATUS line with extra whitespace", () => {
    const raw = "  STATUS:   completed  \n\nPlan here";
    const { status } = parseResearchStatus(raw);
    expect(status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/agent-runner.test.ts`
Expected: FAIL — `parseResearchStatus` is not exported

- [ ] **Step 3: Implement `parseResearchStatus`**

Add to `src/sandbox/agent-runner.ts`:

```typescript
export type ResearchStatus = "completed" | "clarification_needed" | "failed";

export interface ResearchResult {
  status: ResearchStatus;
  body: string;
}

const VALID_RESEARCH_STATUSES: ResearchStatus[] = ["completed", "clarification_needed", "failed"];

export function parseResearchStatus(raw: string): ResearchResult {
  const lines = raw.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const match = firstLine.match(/^STATUS:\s*(\S+)/i);

  if (match && VALID_RESEARCH_STATUSES.includes(match[1] as ResearchStatus)) {
    const body = lines.slice(1).join("\n").trim();
    return { status: match[1] as ResearchStatus, body };
  }

  return { status: "failed", body: raw };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/agent-runner.test.ts`
Expected: All `parseResearchStatus` tests PASS

- [ ] **Step 5: Write failing tests for `parseReviewOutput` and `REVIEW_SCHEMA`**

Add to `src/sandbox/agent-runner.test.ts`:

```typescript
describe("parseReviewOutput", () => {
  it("parses approved result", () => {
    const raw = JSON.stringify({
      result: "approved",
      feedback: "Looks good",
      issues: [],
    });
    const output = parseReviewOutput(raw);
    expect(output.result).toBe("approved");
    expect(output.feedback).toBe("Looks good");
  });

  it("parses changes_requested result with issues", () => {
    const raw = JSON.stringify({
      result: "changes_requested",
      feedback: "Several issues found",
      issues: [
        { file: "src/foo.ts", description: "Missing null check", severity: "critical" },
      ],
    });
    const output = parseReviewOutput(raw);
    expect(output.result).toBe("changes_requested");
    expect(output.issues).toHaveLength(1);
    expect(output.issues[0].severity).toBe("critical");
  });

  it("returns failed on unparseable output", () => {
    const output = parseReviewOutput("not json");
    expect(output.result).toBe("failed");
    expect(output.error).toBeDefined();
  });

  it("returns failed on empty output", () => {
    const output = parseReviewOutput("");
    expect(output.result).toBe("failed");
  });

  it("extracts from result envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: {
        result: "approved",
        feedback: "All good",
        issues: [],
      },
    });
    const output = parseReviewOutput(envelope);
    expect(output.result).toBe("approved");
  });
});

describe("REVIEW_SCHEMA", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(REVIEW_SCHEMA)).not.toThrow();
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/agent-runner.test.ts`
Expected: FAIL — `parseReviewOutput` and `REVIEW_SCHEMA` not exported

- [ ] **Step 7: Implement `ReviewOutput`, `REVIEW_SCHEMA`, and `parseReviewOutput`**

Add to `src/sandbox/agent-runner.ts`:

```typescript
const reviewOutputSchema = z.object({
  result: z.enum(["approved", "changes_requested", "failed"]),
  feedback: z.string().optional(),
  issues: z.array(z.object({
    file: z.string(),
    description: z.string(),
    severity: z.enum(["critical", "suggestion"]),
  })).optional(),
  error: z.string().optional(),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    result: {
      type: "string",
      enum: ["approved", "changes_requested", "failed"],
    },
    feedback: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["critical", "suggestion"] },
        },
        required: ["file", "description", "severity"],
      },
    },
    error: { type: "string" },
  },
  required: ["result"],
});

export function parseReviewOutput(raw: string): ReviewOutput {
  if (!raw.trim()) {
    return { result: "failed", error: "Review agent produced no output" };
  }

  // Direct parse
  try {
    const direct = reviewOutputSchema.safeParse(JSON.parse(raw));
    if (direct.success) return direct.data;
  } catch {}

  // Stream-json / result-envelope format
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);

      if (event.type === "result" && event.structured_output != null) {
        const parsed = reviewOutputSchema.safeParse(event.structured_output);
        if (parsed.success) return parsed.data;
      }

      const direct = reviewOutputSchema.safeParse(event);
      if (direct.success) return direct.data;
    } catch {}
  }

  // Fallback: extract JSON objects
  const objects = raw.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  for (const [candidate] of objects) {
    try {
      const result = reviewOutputSchema.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
    } catch {}
  }

  return {
    result: "failed",
    error: `Review output was not structured JSON. Output starts with: ${raw.slice(0, 500)}`,
  };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/agent-runner.test.ts`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/sandbox/agent-runner.ts src/sandbox/agent-runner.test.ts
git commit -m "feat: add review output schema and research status parser"
```

---

### Task 2: Parameterize wrapper script builder

**Files:**
- Rewrite: `src/sandbox/wrapper-script.ts`
- Rewrite: `src/sandbox/wrapper-script.test.ts`

- [ ] **Step 1: Write failing tests for `buildPhaseScript`**

Replace `src/sandbox/wrapper-script.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { buildPhaseScript } from "./wrapper-script.js";

describe("buildPhaseScript", () => {
  it("generates research phase script without json-schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "research",
      inputFile: "/tmp/research-requirements.md",
      outputFile: "/tmp/research-stdout.txt",
      stderrFile: "/tmp/research-stderr.txt",
      sentinelFile: "/tmp/research-done",
    });

    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("claude");
    expect(script).toContain("claude-opus-4-6");
    expect(script).toContain("/tmp/research-requirements.md");
    expect(script).toContain("/tmp/research-stdout.txt");
    expect(script).toContain("/tmp/research-stderr.txt");
    expect(script).toContain("/tmp/research-done");
    expect(script).not.toContain("--json-schema");
    expect(script).not.toContain("--output-format");
  });

  it("generates impl phase script with json-schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "impl",
      inputFile: "/tmp/impl-requirements.md",
      outputFile: "/tmp/impl-stdout.txt",
      stderrFile: "/tmp/impl-stderr.txt",
      sentinelFile: "/tmp/impl-done",
      jsonSchema: '{"type":"object"}',
    });

    expect(script).toContain("--json-schema");
    expect(script).toContain("--output-format json");
    expect(script).toContain("/tmp/impl-requirements.md");
    expect(script).toContain("/tmp/impl-done");
  });

  it("generates review phase script with json-schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "review",
      inputFile: "/tmp/review-requirements.md",
      outputFile: "/tmp/review-stdout.txt",
      stderrFile: "/tmp/review-stderr.txt",
      sentinelFile: "/tmp/review-done",
      jsonSchema: '{"type":"object"}',
    });

    expect(script).toContain("--json-schema");
    expect(script).toContain("/tmp/review-requirements.md");
    expect(script).toContain("/tmp/review-done");
  });

  it("includes cleanup and sentinel touch", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "research",
      inputFile: "/tmp/research-requirements.md",
      outputFile: "/tmp/research-stdout.txt",
      stderrFile: "/tmp/research-stderr.txt",
      sentinelFile: "/tmp/research-done",
    });

    expect(script).toContain("rm -rf .claude/");
    expect(script).toContain("touch /tmp/research-done");
  });

  it("escapes single quotes in json schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "impl",
      inputFile: "/tmp/impl-requirements.md",
      outputFile: "/tmp/impl-stdout.txt",
      stderrFile: "/tmp/impl-stderr.txt",
      sentinelFile: "/tmp/impl-done",
      jsonSchema: `{"type":"object","desc":"it's"}`,
    });

    expect(script).not.toContain("it's");
    expect(script).toContain("it'\\''s");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/wrapper-script.test.ts`
Expected: FAIL — `buildPhaseScript` not exported

- [ ] **Step 3: Implement `buildPhaseScript`**

Replace `src/sandbox/wrapper-script.ts` with:

```typescript
export interface PhaseScriptOptions {
  model: string;
  phase: "research" | "impl" | "review";
  inputFile: string;
  outputFile: string;
  stderrFile: string;
  sentinelFile: string;
  jsonSchema?: string;
}

/**
 * Generates a bash script for a single agent phase.
 * Designed to run detached inside a Vercel Sandbox.
 */
export function buildPhaseScript(opts: PhaseScriptOptions): string {
  const { model, inputFile, outputFile, stderrFile, sentinelFile, jsonSchema } = opts;

  let claudeFlags = `--print --model '${model}' --dangerously-skip-permissions`;

  if (jsonSchema) {
    const escapedSchema = jsonSchema.replace(/'/g, "'\\''");
    claudeFlags += ` --output-format json --json-schema '${escapedSchema}'`;
  }

  return `#!/bin/bash

# --- Phase: ${opts.phase} ---
cat ${inputFile} | claude \\
  ${claudeFlags} \\
  > ${outputFile} 2>${stderrFile}; echo $? > /tmp/${opts.phase}-exit-code || true

# --- Cleanup ---
cd /vercel/sandbox

# Remove repo-level .claude/ artifacts that Claude Code auto-creates.
# git checkout restores any that were already committed.
rm -rf .claude/
git checkout -- .claude/ 2>/dev/null || true

# --- Signal completion ---
touch ${sentinelFile}
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/wrapper-script.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/wrapper-script.ts src/sandbox/wrapper-script.test.ts
git commit -m "feat: parameterize wrapper script for multi-phase execution"
```

---

### Task 3: Rewrite context assembly functions

**Files:**
- Rewrite: `src/sandbox/context.ts`
- Rewrite: `src/sandbox/context.test.ts`

- [ ] **Step 1: Write failing tests for `assembleResearchPlanContext`**

Add to `src/sandbox/context.test.ts` (keep existing `formatCheckResults` tests, replace `assembleImplementationContext` and `assembleFixingFeedbackContext` tests):

```typescript
describe("assembleResearchPlanContext", () => {
  it("assembles context for new ticket (no PR feedback)", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are a research agent...",
      branchName: "blazebot/test-1",
    });

    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-1");
    expect(result).toContain("## Branch");
    expect(result).toContain("blazebot/test-1");
    expect(result).toContain("You are a research agent...");
    expect(result).not.toContain("## PR Review Feedback");
  });

  it("assembles context with PR feedback for review-fix scenario", () => {
    const result = assembleResearchPlanContext({
      ticket: {
        identifier: "TEST-2",
        title: "Fix auth",
        description: "Fix auth module",
        acceptanceCriteria: "",
        comments: [],
      },
      prompt: "prompt",
      branchName: "blazebot/test-2",
      prComments: [
        { author: "Bob", body: "Fix the null check", liked: false },
      ],
      checkResults: [
        { name: "test", status: "completed", conclusion: "failure", logs: "FAIL" },
      ],
      hasConflicts: true,
    });

    expect(result).toContain("## PR Review Feedback");
    expect(result).toContain("Fix the null check");
    expect(result).toContain("## CI/CD Check Results");
    expect(result).toContain("### Failed: test");
    expect(result).toContain("## Merge Conflicts");
  });
});
```

- [ ] **Step 2: Write failing tests for `assembleImplementationContext` (new signature)**

```typescript
describe("assembleImplementationContext (new)", () => {
  it("assembles context with research plan markdown", () => {
    const result = assembleImplementationContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are an implementation agent...",
      researchPlanMarkdown: "# Plan\n1. Create LoginForm component\n2. Add route handler",
    });

    expect(result).toContain("## Ticket ID");
    expect(result).toContain("TEST-1");
    expect(result).toContain("## Research & Plan");
    expect(result).toContain("# Plan");
    expect(result).toContain("Create LoginForm component");
    expect(result).toContain("You are an implementation agent...");
  });
});
```

- [ ] **Step 3: Write failing tests for `assembleImplementationRetryContext`**

```typescript
describe("assembleImplementationRetryContext", () => {
  it("includes plan and review feedback", () => {
    const result = assembleImplementationRetryContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "prompt",
      researchPlanMarkdown: "# Plan\n1. Create LoginForm",
      reviewFeedback: {
        result: "changes_requested",
        feedback: "Missing error handling",
        issues: [
          { file: "src/LoginForm.tsx", description: "No null check", severity: "critical" },
        ],
      },
    });

    expect(result).toContain("## Research & Plan");
    expect(result).toContain("Create LoginForm");
    expect(result).toContain("## Review Feedback");
    expect(result).toContain("Missing error handling");
    expect(result).toContain("src/LoginForm.tsx");
    expect(result).toContain("No null check");
    expect(result).toContain("critical");
  });
});
```

- [ ] **Step 4: Write failing tests for `assembleReviewContext`**

```typescript
describe("assembleReviewContext", () => {
  it("includes plan and git diff", () => {
    const result = assembleReviewContext({
      ticket: {
        identifier: "TEST-1",
        title: "Add login page",
        description: "Build a login page",
        acceptanceCriteria: "User can log in",
        comments: [],
      },
      prompt: "You are a review agent...",
      researchPlanMarkdown: "# Plan\n1. Create LoginForm",
      gitDiff: "diff --git a/src/LoginForm.tsx b/src/LoginForm.tsx\n+export function LoginForm() {}",
    });

    expect(result).toContain("## Research & Plan");
    expect(result).toContain("## Git Diff");
    expect(result).toContain("+export function LoginForm()");
    expect(result).toContain("You are a review agent...");
  });
});
```

- [ ] **Step 5: Run all new tests to verify they fail**

Run: `npx vitest run src/sandbox/context.test.ts`
Expected: FAIL — new functions not exported

- [ ] **Step 6: Implement all new context assembly functions**

Rewrite `src/sandbox/context.ts` — keep `formatCheckResults` and the helper functions (`formatComments`, `formatPRComments`), replace the main assembly functions:

```typescript
import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";
import type { ReviewOutput } from "./agent-runner.js";

interface TicketData {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

export interface ResearchPlanContextInput {
  ticket: TicketData;
  prompt: string;
  branchName: string;
  prComments?: PRComment[];
  checkResults?: CheckRunResult[];
  hasConflicts?: boolean;
}

export interface ImplementationContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
}

export interface ImplementationRetryContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  reviewFeedback: ReviewOutput;
}

export interface ReviewContextInput {
  ticket: TicketData;
  prompt: string;
  researchPlanMarkdown: string;
  gitDiff: string;
}

export function assembleResearchPlanContext(input: ResearchPlanContextInput): string {
  const { ticket, prompt, branchName, prComments, checkResults, hasConflicts } = input;

  let md = `# Requirements

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

## Branch

${branchName}
`;

  if (prComments && prComments.length > 0) {
    md += `\n## PR Review Feedback\n\n${formatPRComments(prComments)}\n`;
  }

  if (checkResults && checkResults.length > 0) {
    md += `\n## CI/CD Check Results\n\n${formatCheckResults(checkResults)}\n`;
  }

  if (hasConflicts) {
    md += `\n## Merge Conflicts\n\nThis PR has merge conflicts. The base branch has already been merged — the repo is in a MERGING state with conflict markers in the affected files. Resolve the markers, \`git add\` the files, and run \`git merge --continue\`.\n`;
  }

  md += `\n---\n\n${prompt}\n`;
  return md;
}

export function assembleImplementationContext(input: ImplementationContextInput): string {
  const { ticket, prompt, researchPlanMarkdown } = input;
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

---

${prompt}
`;
}

export function assembleImplementationRetryContext(input: ImplementationRetryContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, reviewFeedback } = input;
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

## Review Feedback

${reviewFeedback.feedback ?? "No feedback provided."}

### Issues

${formatReviewIssues(reviewFeedback.issues ?? [])}

---

${prompt}
`;
}

export function assembleReviewContext(input: ReviewContextInput): string {
  const { ticket, prompt, researchPlanMarkdown, gitDiff } = input;
  return `# Requirements

## Ticket ID

${ticket.identifier}

## Ticket

${ticket.title}

## Acceptance Criteria

${ticket.acceptanceCriteria || "None specified."}

## Research & Plan

${researchPlanMarkdown}

## Git Diff

\`\`\`diff
${gitDiff}
\`\`\`

---

${prompt}
`;
}

function formatReviewIssues(issues: Array<{ file: string; description: string; severity: string }>): string {
  if (issues.length === 0) return "No specific issues listed.";
  return issues
    .map((i) => `- **[${i.severity}]** ${i.file}: ${i.description}`)
    .join("\n");
}

// Keep existing helpers below unchanged
```

Note: Keep the existing `formatComments`, `formatPRComments`, and `formatCheckResults` functions exactly as they are.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/context.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/sandbox/context.ts src/sandbox/context.test.ts
git commit -m "feat: rewrite context assembly for three-phase workflow"
```

---

### Task 4: Write three new prompts

**Files:**
- Rewrite: `src/lib/prompts.ts`

- [ ] **Step 1: Replace prompts.ts with three new prompts**

Rewrite `src/lib/prompts.ts`. Remove `implement.md` (old) and `review-fix.md`. Add `research-plan.md`, `implement.md` (new), and `review.md`:

```typescript
const researchPlanPrompt = `# Instructions

You are an AI research agent. Your job is to explore the repository, understand the ticket, and produce a precise implementation plan.

## Output Format

Your output MUST start with a STATUS line on the very first line:

\`\`\`
STATUS: completed
\`\`\`

Valid statuses: \`completed\`, \`clarification_needed\`, \`failed\`

Everything after the STATUS line is your research findings and plan. This output will be passed as-is to the implementation agent — keep it clean and actionable.

## Superpowers

You have access to **superpowers skills** installed globally. Use them.

- **Always check for applicable skills before starting work.** The \`using-superpowers\` skill is loaded — follow its guidance.
- **Use \`brainstorming\` to think through the approach** — explore alternatives, consider trade-offs, then settle on the best path.

## Process

1. **Restore session memory** — Check if \`blazebot/memory/[TASK_ID].md\` exists (where \`[TASK_ID]\` is the Ticket ID from above, e.g. \`AIW-123\`). If it exists, read it immediately.
2. Explore the repository structure. Read \`CLAUDE.md\`, \`AGENTS.md\` if present.
3. Check \`git log\` and \`git diff\` against the base branch to identify what's already been done on this branch.
4. If PR review feedback or CI/CD failures are included above, understand what needs to be fixed.
5. Identify what's already implemented vs. what remains.
6. Analyze relevant files, code patterns, test setup.
7. **Use the \`brainstorming\` skill** to think through the approach.
8. Produce a precise implementation plan for the remaining work.
9. **Write/update session memory** — overwrite \`blazebot/memory/[TASK_ID].md\`.

## Plan Output Constraints

Your plan MUST be:
- **Actionable only** — each step must be directly executable ("Create file X with Y" not "Consider how to...")
- **Minimal** — no preamble, rationale, or context noise that would confuse the implementation agent
- **Concrete** — file paths must be specific ("src/components/Foo.tsx" not "the relevant component")
- **Structured for top-to-bottom execution** — the implementation agent reads and executes sequentially

## When to Ask for Clarification

Return \`STATUS: clarification_needed\` if:
- No clear definition of done in the ticket
- Ambiguous scope
- Missing technical context
- Contradictory requirements
- Multiple valid interpretations
- Missing design/UX details for UI work

When you need clarification, list your questions as numbered lines after the STATUS line. Batch ALL questions — never return with just one.

## Constraints

- **NO coding** — do not write implementation code
- **NO commits** — do not create any git commits
- Only analyze and plan

## Session Memory

**MANDATORY** — before returning, overwrite \`blazebot/memory/[TASK_ID].md\`:

\`\`\`markdown
# Session Memory — [TASK_ID]

## Progress
- What was analyzed and planned this session

## Decisions Made
- Technical choices and reasoning

## Blockers
- What is blocking progress (if clarification_needed or failed)
- "None" if completed successfully

## Files Touched
- "None — research phase only"

## Prior Sessions
- Brief summary of prior sessions (if memory file existed)
\`\`\``;

const implementPrompt = `# Instructions

You are an AI coding agent executing an implementation plan. The plan was created by a research agent and is included above under "Research & Plan".

## Superpowers

You have access to **superpowers skills** installed globally. Use them.

- **Use \`executing-plans\` to systematically work through the plan** — it structures execution correctly.
- **Use \`systematic-debugging\` when encountering bugs or test failures** — do not guess at fixes.
- **Use \`verification-before-completion\` before claiming work is done** — verify, don't assume.

## Process

1. **Restore session memory** — Check if \`blazebot/memory/[TASK_ID].md\` exists. If it exists, read it.
2. Read the plan from the "Research & Plan" section above.
3. If review feedback is included (retry scenario): focus on fixing the flagged issues. Do not redo work that was approved.
4. Execute each step in the plan, in order.
5. If the repo has tests: run them to ensure nothing is broken.
6. **Update session memory** — overwrite \`blazebot/memory/[TASK_ID].md\`.
7. Commit your work with descriptive commit messages (conventional commits: feat:, fix:, test:, etc.).
8. Run all quality checks (tests, linting, type checking, formatting).

## Constraints

- Follow the plan — do not explore or re-research (already done).
- Do not refactor code outside the scope of the plan.
- Do not install new dependencies unless the plan specifies them.
- Follow existing code conventions (check CLAUDE.md, AGENTS.md if present).
- Do NOT invoke \`requesting-code-review\` — that happens in a separate review phase.

## When to Ask for Clarification

Return \`clarification_needed\` only if the plan is genuinely unexecutable. Exhaust code-level investigation first.

## Session Memory

**MANDATORY** — before returning, overwrite \`blazebot/memory/[TASK_ID].md\`:

\`\`\`markdown
# Session Memory — [TASK_ID]

## Progress
- What was implemented this session

## Decisions Made
- Technical choices and reasoning

## Blockers
- What is blocking progress (if clarification_needed or failed)
- "None" if implemented successfully

## Files Touched
- List of files created or modified

## Prior Sessions
- Brief summary of prior sessions (if memory file existed)
\`\`\`

## Output

Return a JSON object with:
- \`result\`: "implemented" if done, "clarification_needed" if you have questions, "failed" if stuck.
- \`summary\`: Description of work done (when implemented).
- \`questions\`: List of questions (when clarification_needed).
- \`error\`: Failure details (when failed).`;

const reviewPrompt = `# Instructions

You are an AI code review agent. Your job is to review the implementation diff against the plan and acceptance criteria.

## Superpowers

You have access to **superpowers skills** installed globally. Use them.

- **Use \`requesting-code-review\` to dispatch a code-reviewer subagent** — this is your primary tool.

## Process

1. Read the plan from the "Research & Plan" section above.
2. Read the acceptance criteria.
3. Review the git diff against the plan — did the implementation agent follow it?
4. Check code quality, test coverage, edge cases.
5. Invoke \`requesting-code-review\` skill to dispatch a code-reviewer subagent.
6. Combine your findings with the subagent's findings.
7. Output your verdict.

## Review Criteria

- Does the implementation match the plan?
- Does it satisfy the acceptance criteria?
- Are there test gaps?
- Are there obvious bugs or edge cases?
- Does the code follow existing conventions?

## Constraints

- **NO coding** — do not write or modify any code
- **NO commits** — do not create any git commits
- Only review and report

## Output

Return a JSON object with:
- \`result\`: "approved" if the implementation is ready, "changes_requested" if issues need fixing, "failed" if review itself failed.
- \`feedback\`: Detailed review notes.
- \`issues\`: Array of specific issues — each with \`file\`, \`description\`, \`severity\` ("critical" or "suggestion"). Only include issues that MUST be fixed for \`changes_requested\`.
- \`error\`: Failure details (when failed).`;

const prompts: Record<string, string> = {
  "research-plan.md": researchPlanPrompt,
  "implement.md": implementPrompt,
  "review.md": reviewPrompt,
};

export function getPrompt(name: string): string {
  const content = prompts[name];
  if (!content) throw new Error(`Unknown prompt: ${name}`);
  return content;
}
```

- [ ] **Step 2: Run existing tests to check for breakage**

Run: `npx vitest run`
Expected: Some tests may fail if they reference old prompt names. Note failures for next step.

- [ ] **Step 3: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat: replace monolithic prompts with three phase-specific prompts"
```

---

### Task 5: Generalize poll-agent and run-agent for multi-phase

**Files:**
- Modify: `src/sandbox/poll-agent.ts`
- Modify: `src/sandbox/poll-agent.test.ts`
- Modify: `src/sandbox/run-agent.ts`

- [ ] **Step 1: Write failing tests for generalized `checkPhaseDone` and `collectPhaseOutput`**

Update `src/sandbox/poll-agent.test.ts` — add tests for the new generalized versions alongside existing tests:

```typescript
describe("checkPhaseDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks a custom sentinel file", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });

    const { checkPhaseDone } = await import("./poll-agent.js");
    const result = await checkPhaseDone("sbx-test-123", "/tmp/research-done");
    expect(result).toBe(true);
    expect(mockRunCommand).toHaveBeenCalledWith("test", ["-f", "/tmp/research-done"]);
  });
});

describe("collectPhaseOutput", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads from a custom output file", async () => {
    const mockStdout = vi.fn();
    mockRunCommand.mockImplementation((...args: any[]) => ({
      exitCode: 0,
      stdout: mockStdout,
    }));

    mockStdout
      .mockResolvedValueOnce(JSON.stringify({ result: "implemented", summary: "Done" }))
      .mockResolvedValueOnce("");

    const { collectPhaseOutput } = await import("./poll-agent.js");
    const result = await collectPhaseOutput("sbx-test-123", "/tmp/impl-stdout.txt", "/tmp/impl-stderr.txt");
    expect(result).toBe(JSON.stringify({ result: "implemented", summary: "Done" }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sandbox/poll-agent.test.ts`
Expected: FAIL — `checkPhaseDone` and `collectPhaseOutput` not exported

- [ ] **Step 3: Add `checkPhaseDone` and `collectPhaseOutput` to poll-agent.ts**

Add to `src/sandbox/poll-agent.ts` (keep existing functions as-is for backward compat during transition):

```typescript
/**
 * Generalized sentinel check — works with any sentinel file path.
 */
export async function checkPhaseDone(
  sandboxId: string,
  sentinelFile: string,
): Promise<boolean | "stopped"> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    if (sandbox.status !== "running") {
      return "stopped";
    }

    const result = await sandbox.runCommand("test", ["-f", sentinelFile]);
    return result.exitCode === 0;
  } catch {
    return "stopped";
  }
}

/**
 * Generalized output collector — reads from any stdout/stderr file paths.
 * Returns raw string. Caller is responsible for parsing.
 */
export async function collectPhaseOutput(
  sandboxId: string,
  outputFile: string,
  stderrFile: string,
): Promise<string> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const stdoutResult = await sandbox.runCommand("cat", [outputFile]);
  const stdout = (await stdoutResult.stdout()).trim();

  const stderrResult = await sandbox.runCommand("cat", [stderrFile]);
  const stderr = (await stderrResult.stdout()).trim();

  return stdout || stderr;
}
```

- [ ] **Step 4: Generalize `startAgentDetached` in run-agent.ts**

Update `src/sandbox/run-agent.ts`:

```typescript
import type { Sandbox as SandboxType } from "@vercel/sandbox";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

/**
 * Starts a phase script in detached mode.
 * Returns immediately — the agent runs in the background.
 */
export async function startPhaseDetached(
  sandbox: SandboxInstance,
  scriptPath: string,
): Promise<void> {
  await sandbox.runCommand({
    cmd: "bash",
    args: [scriptPath],
    cwd: "/vercel/sandbox",
    detached: true,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/sandbox/poll-agent.test.ts`
Expected: All tests PASS (both old and new)

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/poll-agent.ts src/sandbox/poll-agent.test.ts src/sandbox/run-agent.ts
git commit -m "feat: generalize poll-agent and run-agent for multi-phase execution"
```

---

### Task 6: Refactor sandbox manager for phase-based execution

**Files:**
- Modify: `src/sandbox/manager.ts`
- Modify: `src/sandbox/manager.test.ts`

- [ ] **Step 1: Refactor `provision` — remove wrapper script writing, add stop-hook toggle**

The manager should provision the sandbox (clone, git config, install claude, install skills) but NOT write the wrapper script or requirements. Those are now per-phase and handled by the workflow.

Update `src/sandbox/manager.ts`:

1. Remove `import { buildWrapperScript }` and the wrapper script writing from `provision()`
2. Remove `requirementsMd` parameter from `provision()` — it now only takes `branch` and optional `mergeBase`
3. Add a new method `configureStopHook(sandbox, enabled)` that writes or clears `~/.claude/settings.json`
4. Add a new method `writePhaseFiles(sandbox, inputFile, inputContent, scriptPath, scriptContent)` for per-phase file writing

```typescript
async provision(
  branch: string,
  mergeBase?: string,
): Promise<SandboxInstance> {
  // ... same as before up through installGlobalSkills ...
  // REMOVE the wrapper script and requirements.md writing
  return sandbox;
}

async configureStopHook(sandbox: SandboxInstance, enabled: boolean): Promise<void> {
  if (enabled) {
    await sandbox.runCommand("bash", [
      "-c",
      [
        `mkdir -p ~/.claude`,
        `cat > ~/.claude/commit-guard.sh << 'SCRIPT'`,
        `#!/bin/bash`,
        `input=$(cat)`,
        `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
        `changes=$(git status --porcelain | grep -v '^.. \\.claude/' | grep -v '^?? \\.claude/' | grep -v 'requirements\\.md')`,
        `if [ -n "$changes" ]; then`,
        `  echo '{"decision":"block","reason":"You have uncommitted changes. You MUST either commit all changes with a descriptive message or revert them before stopping."}' >&2`,
        `  exit 2`,
        `fi`,
        `SCRIPT`,
        `chmod +x ~/.claude/commit-guard.sh`,
        `cat > ~/.claude/settings.json << 'JSON'`,
        `{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash ~/.claude/commit-guard.sh"}]}]}}`,
        `JSON`,
      ].join("\n"),
    ]);
  } else {
    await sandbox.runCommand("bash", [
      "-c",
      `mkdir -p ~/.claude && echo '{}' > ~/.claude/settings.json`,
    ]);
  }
}

async writePhaseFiles(
  sandbox: SandboxInstance,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  await sandbox.writeFiles(
    files.map((f) => ({ path: f.path, content: Buffer.from(f.content) })),
  );
  // Make scripts executable
  for (const f of files) {
    if (f.path.endsWith(".sh")) {
      await sandbox.runCommand("chmod", ["+x", f.path]);
    }
  }
}
```

- [ ] **Step 2: Update manager.test.ts**

Update the tests to reflect the new `provision()` signature (no `requirementsMd`). Add tests for `configureStopHook` and `writePhaseFiles`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/sandbox/manager.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/sandbox/manager.ts src/sandbox/manager.test.ts
git commit -m "refactor: extract stop-hook config, remove wrapper script from provision"
```

---

### Task 7: Create the unified `agentWorkflow`

**Files:**
- Create: `src/workflows/agent.ts`

- [ ] **Step 1: Create `src/workflows/agent.ts`**

This is the core of the change. The workflow orchestrates three phases:

```typescript
import { sleep } from "workflow";
import type { AgentOutput } from "../sandbox/agent-runner.js";
import type { ReviewOutput } from "../sandbox/agent-runner.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";
import type { PRComment, CheckRunResult } from "../adapters/vcs/types.js";

// --- Step Functions ---

async function fetchAndValidateTicket(ticketId: string, columnAi: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const ticket = await issueTracker.fetchTicket(ticketId);
  if (ticket.trackerStatus.toLowerCase() !== columnAi.toLowerCase()) return null;
  return ticket;
}

async function createFeatureBranch(branchName: string, baseBranch: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  await vcs.createBranch(branchName, baseBranch);
}

async function fetchPRContext(branchName: string): Promise<{
  prComments: PRComment[];
  checkResults: CheckRunResult[];
  hasConflicts: boolean;
} | null> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  const pr = await vcs.findPR(branchName);
  if (!pr) return null;

  const prComments = await vcs.getPRComments(pr.id);
  const hasConflicts = await vcs.getPRConflictStatus(pr.id);
  const checkResults = await vcs.getCheckRunResults(pr.id);
  return { prComments, hasConflicts, checkResults };
}

async function provisionSandbox(
  branchName: string,
  mergeBase?: string,
): Promise<string> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");

  const manager = new SandboxManager({
    githubToken: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
  });

  const sandbox = await manager.provision(branchName, mergeBase);
  return sandbox.sandboxId;
}
provisionSandbox.maxRetries = 0;

async function writeAndStartPhase(
  sandboxId: string,
  inputFilePath: string,
  inputContent: string,
  scriptPath: string,
  scriptContent: string,
): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  await sandbox.writeFiles([
    { path: inputFilePath, content: Buffer.from(inputContent) },
    { path: scriptPath, content: Buffer.from(scriptContent) },
  ]);
  await sandbox.runCommand("chmod", ["+x", scriptPath]);

  await sandbox.runCommand({
    cmd: "bash",
    args: [scriptPath],
    cwd: "/vercel/sandbox",
    detached: true,
  });
}
writeAndStartPhase.maxRetries = 0;

async function configureStopHook(sandboxId: string, enabled: boolean): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { env } = await import("../../env.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manager = new SandboxManager({
    githubToken: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    claudeModel: env.CLAUDE_MODEL,
    commitAuthor: env.COMMIT_AUTHOR,
    commitEmail: env.COMMIT_EMAIL,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
  });
  await manager.configureStopHook(sandbox, enabled);
}

async function captureGitDiff(sandboxId: string): Promise<string> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const baseShaResult = await sandbox.runCommand("bash", [
    "-c", "cat /tmp/.pre-agent-sha 2>/dev/null || echo ''",
  ]);
  const baseSha = (await baseShaResult.stdout()).trim();

  const diffCmd = baseSha
    ? `git diff ${baseSha}..HEAD`
    : "git diff HEAD";
  const diffResult = await sandbox.runCommand("bash", ["-c", diffCmd]);
  return (await diffResult.stdout()).trim();
}

// Reuse existing step functions from implementation.ts for:
// createPullRequest, moveTicket, notifySlack, postClarificationAndMoveBack,
// unregisterRun, markTicketFailed
// (Copy them here — they're identical)

async function createPullRequest(branchName: string, title: string, summary: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { vcs } = createStepAdapters();
  return vcs.createPR(branchName, title, summary);
}

async function moveTicket(ticketId: string, column: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  await issueTracker.moveTicket(ticketId, column);
}

async function notifySlack(message: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { messaging } = createStepAdapters();
  await messaging.notify(message);
}

async function postClarificationAndMoveBack(
  ticketId: string, questions: string[], identifier: string, backlogColumn: string,
) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const comment = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  await issueTracker.postComment(ticketId, comment);
  await issueTracker.moveTicket(ticketId, backlogColumn);
}

async function unregisterRun(ticketIdentifier: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  await runRegistry.unregister(ticketIdentifier);
}

async function markTicketFailed(ticketIdentifier: string, error: string) {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { runRegistry } = createStepAdapters();
  const runId = await runRegistry.getRunId(ticketIdentifier) ?? "unknown";
  await runRegistry.markFailed(ticketIdentifier, {
    runId, error, failedAt: new Date().toISOString(),
  });
}

// --- Polling helper (not a step — called within the workflow) ---

async function pollUntilDone(
  sandboxId: string,
  sentinelFile: string,
  maxPollMinutes: number,
): Promise<boolean> {
  const { checkPhaseDone } = await import("../sandbox/poll-agent.js");
  const POLL_INTERVAL = "30s";
  const MAX_POLLS = Math.ceil((maxPollMinutes * 60) / 30);
  let pollCount = 0;

  while (pollCount < MAX_POLLS) {
    await sleep(POLL_INTERVAL);
    pollCount++;
    const status = await checkPhaseDone(sandboxId, sentinelFile);
    if (status === true) return true;
    if (status === "stopped") return false;
  }
  return false;
}

// --- Main Workflow ---

const MAX_REVIEW_RETRIES = 2;

export async function agentWorkflow(ticketId: string) {
  "use workflow";

  const { env } = await import("../../env.js");
  const { getPrompt } = await import("../lib/prompts.js");
  const { buildPhaseScript } = await import("../sandbox/wrapper-script.js");
  const { parseResearchStatus } = await import("../sandbox/agent-runner.js");
  const { parseAgentOutput } = await import("../sandbox/agent-runner.js");
  const { parseReviewOutput, REVIEW_SCHEMA, AGENT_SCHEMA } = await import("../sandbox/agent-runner.js");
  const { assembleResearchPlanContext, assembleImplementationContext, assembleImplementationRetryContext, assembleReviewContext } =
    await import("../sandbox/context.js");
  const { collectPhaseOutput } = await import("../sandbox/poll-agent.js");
  const { pushFromSandbox, fixAndRetryPush, teardownSandbox } = await import("../sandbox/poll-agent.js");

  const ticket = await fetchAndValidateTicket(ticketId, env.COLUMN_AI);
  if (!ticket) return;

  try {
    await notifySlack(`Task ${ticket.identifier} started`);

    const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
    await createFeatureBranch(branchName, env.GITHUB_BASE_BRANCH);

    // Check for existing PR (review-fix scenario)
    const prContext = await fetchPRContext(branchName);
    const mergeBase = prContext?.hasConflicts ? env.GITHUB_BASE_BRANCH : undefined;

    // Provision sandbox once for all phases
    const sandboxId = await provisionSandbox(branchName, mergeBase);

    try {
      // ========== PHASE 1: Research & Plan ==========
      await configureStopHook(sandboxId, false);

      const researchInput = assembleResearchPlanContext({
        ticket: {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description,
          acceptanceCriteria: ticket.acceptanceCriteria,
          comments: ticket.comments,
        },
        prompt: getPrompt("research-plan.md"),
        branchName,
        prComments: prContext?.prComments,
        checkResults: prContext?.checkResults,
        hasConflicts: prContext?.hasConflicts,
      });

      const researchScript = buildPhaseScript({
        model: env.CLAUDE_MODEL,
        phase: "research",
        inputFile: "/tmp/research-requirements.md",
        outputFile: "/tmp/research-stdout.txt",
        stderrFile: "/tmp/research-stderr.txt",
        sentinelFile: "/tmp/research-done",
      });

      await writeAndStartPhase(
        sandboxId,
        "/tmp/research-requirements.md", researchInput,
        "/tmp/research-wrapper.sh", researchScript,
      );

      const researchDone = await pollUntilDone(sandboxId, "/tmp/research-done", 20);
      if (!researchDone) {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: research phase timed out`);
        await unregisterRun(ticket.identifier);
        return;
      }

      const researchRaw = await collectPhaseOutput(sandboxId, "/tmp/research-stdout.txt", "/tmp/research-stderr.txt");
      const research = parseResearchStatus(researchRaw);

      if (research.status === "clarification_needed") {
        const questions = research.body.split("\n").filter((l) => /^\d+\./.test(l.trim()));
        await postClarificationAndMoveBack(ticketId, questions.length > 0 ? questions : [research.body], ticket.identifier, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} needs clarification`);
        await unregisterRun(ticket.identifier);
        return;
      }

      if (research.status === "failed") {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: research — ${research.body.slice(0, 200)}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      const researchPlanMarkdown = research.body;

      // ========== PHASE 2 & 3 LOOP ==========
      let reviewRetries = 0;
      let lastReviewFeedback: ReviewOutput | undefined;

      while (true) {
        // ========== PHASE 2: Implementation ==========
        await configureStopHook(sandboxId, true);

        const implInput = lastReviewFeedback
          ? assembleImplementationRetryContext({
              ticket: { identifier: ticket.identifier, title: ticket.title, description: ticket.description, acceptanceCriteria: ticket.acceptanceCriteria, comments: ticket.comments },
              prompt: getPrompt("implement.md"),
              researchPlanMarkdown,
              reviewFeedback: lastReviewFeedback,
            })
          : assembleImplementationContext({
              ticket: { identifier: ticket.identifier, title: ticket.title, description: ticket.description, acceptanceCriteria: ticket.acceptanceCriteria, comments: ticket.comments },
              prompt: getPrompt("implement.md"),
              researchPlanMarkdown,
            });

        const implScript = buildPhaseScript({
          model: env.CLAUDE_MODEL,
          phase: "impl",
          inputFile: "/tmp/impl-requirements.md",
          outputFile: "/tmp/impl-stdout.txt",
          stderrFile: "/tmp/impl-stderr.txt",
          sentinelFile: "/tmp/impl-done",
          jsonSchema: AGENT_SCHEMA,
        });

        await writeAndStartPhase(
          sandboxId,
          "/tmp/impl-requirements.md", implInput,
          "/tmp/impl-wrapper.sh", implScript,
        );

        const implDone = await pollUntilDone(sandboxId, "/tmp/impl-done", 35);
        let implOutput: AgentOutput;

        if (implDone) {
          const implRaw = await collectPhaseOutput(sandboxId, "/tmp/impl-stdout.txt", "/tmp/impl-stderr.txt");
          implOutput = parseAgentOutput(implRaw);
        } else {
          implOutput = { result: "failed", error: "Implementation phase timed out" };
        }

        if (implOutput.result === "clarification_needed") {
          await postClarificationAndMoveBack(ticketId, implOutput.questions ?? [], ticket.identifier, env.COLUMN_BACKLOG);
          await notifySlack(`Task ${ticket.identifier} needs clarification`);
          await unregisterRun(ticket.identifier);
          return;
        }

        if (implOutput.result === "failed") {
          await moveTicket(ticketId, env.COLUMN_BACKLOG);
          await notifySlack(`Task ${ticket.identifier} failed: implementation — ${implOutput.error ?? "unknown"}`);
          await unregisterRun(ticket.identifier);
          return;
        }

        // ========== PHASE 3: Review ==========
        await configureStopHook(sandboxId, false);

        const gitDiff = await captureGitDiff(sandboxId);

        const reviewInput = assembleReviewContext({
          ticket: { identifier: ticket.identifier, title: ticket.title, description: ticket.description, acceptanceCriteria: ticket.acceptanceCriteria, comments: ticket.comments },
          prompt: getPrompt("review.md"),
          researchPlanMarkdown,
          gitDiff,
        });

        const reviewScript = buildPhaseScript({
          model: env.CLAUDE_MODEL,
          phase: "review",
          inputFile: "/tmp/review-requirements.md",
          outputFile: "/tmp/review-stdout.txt",
          stderrFile: "/tmp/review-stderr.txt",
          sentinelFile: "/tmp/review-done",
          jsonSchema: REVIEW_SCHEMA,
        });

        await writeAndStartPhase(
          sandboxId,
          "/tmp/review-requirements.md", reviewInput,
          "/tmp/review-wrapper.sh", reviewScript,
        );

        const reviewDone = await pollUntilDone(sandboxId, "/tmp/review-done", 15);
        let reviewOutput: ReviewOutput;

        if (reviewDone) {
          const reviewRaw = await collectPhaseOutput(sandboxId, "/tmp/review-stdout.txt", "/tmp/review-stderr.txt");
          reviewOutput = parseReviewOutput(reviewRaw);
        } else {
          reviewOutput = { result: "failed", error: "Review phase timed out" };
        }

        if (reviewOutput.result === "approved") {
          break; // Exit loop → push
        }

        if (reviewOutput.result === "changes_requested") {
          reviewRetries++;
          if (reviewRetries > MAX_REVIEW_RETRIES) {
            await moveTicket(ticketId, env.COLUMN_BACKLOG);
            await notifySlack(`Task ${ticket.identifier} failed: review rejected after ${MAX_REVIEW_RETRIES} retries`);
            await unregisterRun(ticket.identifier);
            return;
          }
          lastReviewFeedback = reviewOutput;
          continue; // Loop back to Phase 2
        }

        // result === "failed"
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: review — ${reviewOutput.error ?? "unknown"}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      // ========== POST-PHASES: Push & PR ==========
      let pushResult = await pushFromSandbox(sandboxId, branchName);
      if (!pushResult.pushed && pushResult.error) {
        pushResult = await fixAndRetryPush(sandboxId, branchName, pushResult.error);
      }

      if (!pushResult.pushed) {
        await moveTicket(ticketId, env.COLUMN_BACKLOG);
        await notifySlack(`Task ${ticket.identifier} failed: push failed — ${pushResult.error ?? "unknown"}`);
        await unregisterRun(ticket.identifier);
        return;
      }

      await createPullRequest(branchName, ticket.title, "");
      await moveTicket(ticketId, env.COLUMN_AI_REVIEW);
      await notifySlack(`Task ${ticket.identifier} PR ready for review`);
      await unregisterRun(ticket.identifier);
    } finally {
      await teardownSandbox(sandboxId);
    }
  } catch (err) {
    console.error(`Workflow failed for ${ticket.identifier}:`, err);
    const moved = await moveTicket(ticketId, env.COLUMN_BACKLOG).then(() => true).catch(() => false);
    await notifySlack(`Task ${ticket.identifier} failed: ${(err as Error).message ?? "unknown"}`).catch(() => {});
    if (moved) {
      await unregisterRun(ticket.identifier).catch(() => {});
    } else {
      await markTicketFailed(ticket.identifier, `Failed to move ticket to backlog: ${(err as Error).message ?? "unknown"}`).catch(() => {});
    }
    throw err;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/workflows/agent.ts
git commit -m "feat: create unified three-phase agentWorkflow"
```

---

### Task 8: Update dispatch and delete old workflows

**Files:**
- Modify: `src/lib/dispatch.ts`
- Modify: `src/lib/dispatch.test.ts`
- Delete: `src/workflows/implementation.ts`
- Delete: `src/workflows/review-fix.ts`

- [ ] **Step 1: Update dispatch.ts to use `agentWorkflow`**

Replace the workflow imports and `startWorkflow` function:

```typescript
import { start, getRun } from "workflow/api";
import { agentWorkflow } from "../workflows/agent.js";
import { logger } from "./logger.js";
import type { Adapters } from "./adapters.js";

// ... keep CLAIMING_PREFIX, isClaimingSentinel, getClaimTimestamp, DispatchResult, isAtCapacity, getActiveSandboxCount, verifyClaimNotCancelled, abortWorkflow ...

export async function dispatchTicket(
  ticketKey: string,
  adapters: Adapters,
  maxConcurrentAgents: number,
): Promise<DispatchResult> {
  const { issueTracker, runRegistry } = adapters;

  if (await runRegistry.isTicketFailed(ticketKey)) {
    logger.info({ ticketKey }, "dispatch_skipped_previously_failed");
    return { started: false, reason: "previously_failed" };
  }

  if (await isAtCapacity(maxConcurrentAgents)) {
    return { started: false, reason: "at_capacity" };
  }

  const claimValue = `${CLAIMING_PREFIX}${Date.now()}`;
  const claimed = await runRegistry.claim(ticketKey, claimValue);
  if (!claimed) {
    logger.info({ ticketKey }, "dispatch_already_claimed");
    return { started: false, reason: "already_claimed" };
  }

  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);

    const handle = await start(agentWorkflow, [ticket.id]);
    logger.info(
      { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
      "workflow_started",
    );

    const claimStillHeld = await verifyClaimNotCancelled(ticketKey, claimValue, runRegistry);
    if (!claimStillHeld) {
      await abortWorkflow(handle.runId, ticketKey);
      return { started: false, reason: "already_claimed" };
    }

    await runRegistry.register(ticketKey, handle.runId);
    return { started: true, runId: handle.runId };
  } catch (err) {
    await runRegistry.unregister(ticketKey).catch(() => {});
    logger.warn({ ticketKey, error: (err as Error).message }, "dispatch_error");
    return { started: false, reason: "error" };
  }
}
```

Key changes: removed `vcs` from destructure (no longer needed for PR check), removed `branchName` computation, removed `startWorkflow` helper, always `start(agentWorkflow, [ticket.id])`.

- [ ] **Step 2: Update dispatch.test.ts**

Replace the mock and test assertions:

```typescript
// Replace the old workflow mocks with:
vi.mock("../workflows/agent.js", () => ({
  agentWorkflow: "agentWorkflow_sentinel",
}));

// Remove the reviewFixWorkflow mock entirely

// In "dispatches implementation workflow when no PR exists" test:
// Remove the findPR assertion
// Change: expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", ["ticket-001"]);

// Remove "dispatches review-fix workflow when PR exists" test entirely
// (or change it to verify agentWorkflow is still called regardless of PR)

// In makeAdapters: findPR is no longer needed in dispatch, remove it from overrides
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/dispatch.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Delete old workflow files**

```bash
rm src/workflows/implementation.ts src/workflows/review-fix.ts
```

- [ ] **Step 5: Check for remaining imports of deleted files**

Run: `npx vitest run`
If any test imports the old workflows, update those imports.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dispatch.ts src/lib/dispatch.test.ts
git rm src/workflows/implementation.ts src/workflows/review-fix.ts
git commit -m "feat: unify dispatch to single agentWorkflow, delete old workflows"
```

---

### Task 9: Full test suite and type check

**Files:**
- All modified files

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run linting if configured**

Run: `npx eslint src/` (or whatever lint command exists in package.json)
Expected: No errors

- [ ] **Step 4: Fix any remaining issues**

If any tests fail or types don't check, fix them and commit:

```bash
git add -A
git commit -m "fix: resolve test and type issues from workflow migration"
```

---

### Task 10: Verify reconcile.ts still works with new workflow

**Files:**
- Read: `src/lib/reconcile.ts`

- [ ] **Step 1: Check reconcile.ts for references to old workflows**

`reconcile.ts` uses `getRun()` from the workflow SDK and doesn't import workflow functions directly. Verify it still works:

Run: `npx vitest run src/lib/reconcile.test.ts`
Expected: PASS — reconcile doesn't care which workflow type was started, only that a `runId` exists.

- [ ] **Step 2: Commit if any changes were needed**

```bash
git add src/lib/reconcile.ts src/lib/reconcile.test.ts
git commit -m "fix: update reconcile for unified workflow"
```

(Skip if no changes needed.)
