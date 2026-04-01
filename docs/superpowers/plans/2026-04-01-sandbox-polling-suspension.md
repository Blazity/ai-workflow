# Sandbox Polling Suspension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suspend the workflow while the sandbox runs the Claude Code agent, using a sleep+poll pattern so the workflow consumes zero resources during the 10-30 min agent execution.

**Architecture:** Split the blocking `runAgentInSandbox` step into three phases: (1) provision sandbox + start agent detached, (2) poll for completion with `sleep("30s")` intervals (workflow truly suspends between polls), (3) collect results + teardown. A bash wrapper script inside the sandbox runs claude, does cleanup, and writes sentinel files. Debug mode (live log streaming via `getWritable`) is removed — the polling approach replaces it entirely.

**Tech Stack:** Vercel Workflow DevKit (`sleep` from `"workflow"`), `@vercel/sandbox` (`Sandbox.get()` for reconnection), Nitro (h3 routes)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/sandbox/wrapper-script.ts` | Generates the bash wrapper script for detached agent execution |
| Create | `src/sandbox/poll-agent.ts` | Step functions: `checkAgentDone`, `collectAgentResults`, `teardownSandbox` |
| Modify | `src/sandbox/manager.ts` | Extract `getSandboxCredentials()`, add wrapper script installation to `provision()` |
| Modify | `src/sandbox/run-agent.ts` | Replace `runAgent()` with `startAgentDetached()`; remove debug streaming code |
| Modify | `src/workflows/implementation.ts` | Replace single blocking step with provision → poll loop → collect pattern |
| Modify | `src/workflows/review-fix.ts` | Same poll pattern as implementation workflow |
| Create | `src/sandbox/wrapper-script.test.ts` | Test wrapper script generation |
| Create | `src/sandbox/poll-agent.test.ts` | Test polling and result collection |

---

### Task 1: Extract sandbox credentials helper

Move credential resolution from inline in `SandboxManager.provision()` into a reusable function, so both provisioning and reconnection steps can authenticate with the Sandbox API.

**Files:**
- Create: `src/sandbox/credentials.ts`
- Modify: `src/sandbox/manager.ts:49-59` (use the new helper)

- [ ] **Step 1: Create `src/sandbox/credentials.ts`**

```ts
// src/sandbox/credentials.ts
import type { Sandbox as SandboxType } from "@vercel/sandbox";

type Credentials = {
  token: string;
  teamId: string;
  projectId: string;
};

/**
 * Returns explicit Sandbox credentials when all three env vars are set (local dev).
 * On Vercel, returns empty object — the SDK authenticates via OIDC automatically.
 */
export function getSandboxCredentials(): Partial<Credentials> {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  return {};
}
```

- [ ] **Step 2: Update `SandboxManager.provision()` to use the helper**

In `src/sandbox/manager.ts`, replace the inline credential logic with the helper.

Replace lines 43-59 (inside `provision()`):
```ts
// Before:
if (!this.config.claudeCodeOauthToken && !this.config.anthropicApiKey) {
  throw new Error("Either anthropicApiKey or claudeCodeOauthToken must be provided");
}

const hasExplicitCredentials =
  this.config.vercelToken && this.config.vercelTeamId && this.config.vercelProjectId;

const sandbox = await Sandbox.create({
  ...(hasExplicitCredentials
    ? {
        token: this.config.vercelToken,
        teamId: this.config.vercelTeamId,
        projectId: this.config.vercelProjectId,
      }
    : {}),
  // ...
});
```

With:
```ts
// After:
import { getSandboxCredentials } from "./credentials.js";

if (!this.config.claudeCodeOauthToken && !this.config.anthropicApiKey) {
  throw new Error("Either anthropicApiKey or claudeCodeOauthToken must be provided");
}

const sandbox = await Sandbox.create({
  ...getSandboxCredentials(),
  // ... rest stays the same
});
```

- [ ] **Step 3: Remove `vercelToken`, `vercelTeamId`, `vercelProjectId` from `SandboxConfig`**

These are now read from `process.env` by `getSandboxCredentials()`. Remove them from the `SandboxConfig` interface and all call sites that pass them.

In `src/sandbox/manager.ts`:
```ts
// Remove these three fields from SandboxConfig:
export interface SandboxConfig {
  githubToken: string;
  owner: string;
  repo: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeModel: string;
  commitAuthor: string;
  commitEmail: string;
  jobTimeoutMs: number;
  // REMOVE: vercelToken, vercelTeamId, vercelProjectId
}
```

In `src/workflows/implementation.ts` (`runAgentInSandbox` step), remove these three lines from the `SandboxManager` constructor:
```ts
// REMOVE:
vercelToken: env.VERCEL_TOKEN,
vercelTeamId: env.VERCEL_TEAM_ID,
vercelProjectId: env.VERCEL_PROJECT_ID,
```

Same removal in `src/workflows/review-fix.ts` (`runFixingAgentInSandbox` step).

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors)

- [ ] **Step 5: Run existing tests**

Run: `pnpm test`
Expected: PASS (all existing tests pass)

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/credentials.ts src/sandbox/manager.ts src/workflows/implementation.ts src/workflows/review-fix.ts
git commit -m "refactor: extract getSandboxCredentials into reusable helper"
```

---

### Task 2: Build the wrapper script generator

Create a function that generates a bash script to run inside the sandbox. The script: runs claude (which commits via the stop hook), does artifact cleanup, and writes sentinel files signaling completion. The agent is responsible for committing — the wrapper does NOT auto-commit.

**Files:**
- Create: `src/sandbox/wrapper-script.ts`
- Create: `src/sandbox/wrapper-script.test.ts`

- [ ] **Step 1: Write failing test for `buildWrapperScript`**

```ts
// src/sandbox/wrapper-script.test.ts
import { describe, it, expect } from "vitest";
import { buildWrapperScript } from "./wrapper-script.js";

describe("buildWrapperScript", () => {
  it("generates a bash script that runs claude and writes sentinel", () => {
    const script = buildWrapperScript({ model: "claude-opus-4-6" });

    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("claude");
    expect(script).toContain("claude-opus-4-6");
    expect(script).toContain("/tmp/agent-done");
    expect(script).toContain("/tmp/agent-stdout.txt");
    expect(script).toContain("/tmp/agent-stderr.txt");
    expect(script).not.toContain("git commit"); // agent commits via stop hook, not wrapper
  });

  it("includes json-schema flag", () => {
    const script = buildWrapperScript({ model: "claude-opus-4-6" });
    expect(script).toContain("--json-schema");
    expect(script).toContain("--output-format json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/sandbox/wrapper-script.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `buildWrapperScript`**

```ts
// src/sandbox/wrapper-script.ts
import { AGENT_SCHEMA } from "./agent-runner.js";

interface WrapperScriptOptions {
  model: string;
}

/**
 * Generates a bash wrapper script that:
 * 1. Runs claude --print with the given model (agent commits via stop hook)
 * 2. Does cleanup (removes .claude/, requirements.md artifacts)
 * 3. Writes stdout/stderr to /tmp/ files
 * 4. Touches /tmp/agent-done as sentinel
 *
 * Designed to run detached inside a Vercel Sandbox.
 * The agent is responsible for committing — this script does NOT auto-commit.
 */
export function buildWrapperScript(opts: WrapperScriptOptions): string {
  const { model } = opts;

  // Escape single quotes in the schema for safe embedding in bash
  const escapedSchema = AGENT_SCHEMA.replace(/'/g, "'\\''");

  return `#!/bin/bash

# --- Phase 1: Run Claude Code agent ---
cat /vercel/sandbox/requirements.md | claude \\
  --print \\
  --model "${model}" \\
  --dangerously-skip-permissions \\
  --output-format json \\
  --json-schema '${escapedSchema}' \\
  > /tmp/agent-stdout.txt 2>/tmp/agent-stderr.txt || true

# --- Phase 2: Cleanup ---
cd /vercel/sandbox

# Remove repo-level .claude/ artifacts that Claude Code auto-creates.
# git checkout restores any that were already committed.
rm -rf .claude/ requirements.md
git checkout -- .claude/ 2>/dev/null || true
git checkout -- requirements.md 2>/dev/null || true

# --- Phase 3: Signal completion ---
touch /tmp/agent-done
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/sandbox/wrapper-script.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/wrapper-script.ts src/sandbox/wrapper-script.test.ts
git commit -m "feat: add wrapper script generator for detached sandbox agent execution"
```

---

### Task 3: Create polling and result collection step functions

These `"use step"` functions reconnect to a sandbox by ID, check for the sentinel file, and collect results.

**Files:**
- Create: `src/sandbox/poll-agent.ts`
- Create: `src/sandbox/poll-agent.test.ts`

- [ ] **Step 1: Write failing tests for `checkAgentDone`**

```ts
// src/sandbox/poll-agent.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunCommand = vi.fn();
const mockReadFileToBuffer = vi.fn();
const mockStop = vi.fn();

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(() => ({
      sandboxId: "sbx-test-123",
      status: "running",
      runCommand: mockRunCommand,
      readFileToBuffer: mockReadFileToBuffer,
      stop: mockStop,
    })),
  },
}));

// Must mock the module before importing
vi.mock("./credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));

import { checkAgentDone, collectAgentResults, teardownSandbox } from "./poll-agent.js";

describe("checkAgentDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns false when sentinel file does not exist", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 1 });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe(false);
  });

  it("returns true when sentinel file exists", async () => {
    mockRunCommand.mockResolvedValue({ exitCode: 0 });

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe(true);
  });

  it("returns 'stopped' when sandbox is not running and no sentinel", async () => {
    const { Sandbox } = await import("@vercel/sandbox");
    (Sandbox.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sandboxId: "sbx-test-123",
      status: "stopped",
      runCommand: mockRunCommand,
    });
    // No sentinel check needed — sandbox is dead

    const result = await checkAgentDone("sbx-test-123");
    expect(result).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/sandbox/poll-agent.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `checkAgentDone`**

```ts
// src/sandbox/poll-agent.ts
import { getSandboxCredentials } from "./credentials.js";

/**
 * Reconnects to a sandbox and checks whether the agent has finished.
 * Returns:
 * - `true` if /tmp/agent-done sentinel exists
 * - `false` if sandbox is running but agent not done yet
 * - `"stopped"` if sandbox is no longer running (timeout/crash)
 */
export async function checkAgentDone(
  sandboxId: string,
): Promise<boolean | "stopped"> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  if (sandbox.status !== "running") {
    return "stopped";
  }

  const result = await sandbox.runCommand("test", ["-f", "/tmp/agent-done"]);
  return result.exitCode === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/sandbox/poll-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for `collectAgentResults`**

Add to `src/sandbox/poll-agent.test.ts`:

```ts
describe("collectAgentResults", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads stdout, stderr and extracts changed files", async () => {
    const mockStdout = vi.fn();
    mockRunCommand.mockImplementation((...args: unknown[]) => {
      const cmdArgs = (args[0] as string) === "bash" ? args[1] : args;
      // Respond to different commands based on arguments
      return {
        exitCode: 0,
        stdout: mockStdout,
      };
    });

    // cat /tmp/agent-stdout.txt
    mockStdout
      .mockResolvedValueOnce(JSON.stringify({ result: "implemented", summary: "Done" })) // stdout
      .mockResolvedValueOnce("") // stderr
      .mockResolvedValueOnce("abc123") // pre-agent sha
      .mockResolvedValueOnce("src/index.ts"); // git diff --name-only

    mockReadFileToBuffer.mockResolvedValue(Buffer.from("console.log('hello')"));

    const result = await collectAgentResults("sbx-test-123");

    expect(result.output.result).toBe("implemented");
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/index.ts");
    expect(result.files[0].content).toBe("console.log('hello')");
  });
});
```

- [ ] **Step 6: Implement `collectAgentResults`**

Add to `src/sandbox/poll-agent.ts`:

```ts
import { parseAgentOutput } from "./agent-runner.js";
import type { AgentOutput } from "./agent-runner.js";

/**
 * Reconnects to the sandbox, reads agent stdout/stderr, extracts changed files,
 * and returns the parsed result.
 */
export async function collectAgentResults(
  sandboxId: string,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Read agent output files
  const stdoutResult = await sandbox.runCommand("cat", ["/tmp/agent-stdout.txt"]);
  const stdout = (await stdoutResult.stdout()).trim();

  const stderrResult = await sandbox.runCommand("cat", ["/tmp/agent-stderr.txt"]);
  const stderr = (await stderrResult.stdout()).trim();

  const raw = stdout || stderr;
  const output = parseAgentOutput(raw);

  // Extract changed files (same logic as SandboxManager.extractChanges)
  const baseResult = await sandbox.runCommand("bash", [
    "-c",
    "cat /tmp/.pre-agent-sha 2>/dev/null || git rev-list --max-parents=0 HEAD",
  ]);
  const baseSha = (await baseResult.stdout()).trim();

  let files: Array<{ path: string; content: string }> = [];

  if (baseSha) {
    const diffResult = await sandbox.runCommand("git", [
      "diff", "--name-only", baseSha, "HEAD",
    ]);
    const diffOutput = (await diffResult.stdout()).trim();

    if (diffOutput) {
      const filePaths = diffOutput
        .split("\n")
        .filter(Boolean)
        .filter((p) => p !== "requirements.md")
        .filter((p) => !p.startsWith(".claude/"));

      for (const filePath of filePaths) {
        const buf = await sandbox.readFileToBuffer({
          path: filePath,
          cwd: "/vercel/sandbox",
        });
        if (buf) {
          files.push({ path: filePath, content: buf.toString("utf-8") });
        }
      }
    }
  }

  return { output, files };
}

/**
 * Reconnects to a sandbox and stops it.
 */
export async function teardownSandbox(sandboxId: string): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
    await sandbox.stop();
  } catch {
    // Teardown failures are non-critical (sandbox may have already stopped)
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test src/sandbox/poll-agent.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/sandbox/poll-agent.ts src/sandbox/poll-agent.test.ts
git commit -m "feat: add polling step functions for sandbox agent completion"
```

---

### Task 4: Add wrapper script installation to sandbox provisioning

Write the wrapper script to the sandbox during `provision()` so it's available for detached execution.

**Files:**
- Modify: `src/sandbox/manager.ts:151-156` (add wrapper script writing)

- [ ] **Step 1: Import and write wrapper script in `provision()`**

In `src/sandbox/manager.ts`, after the line that writes `requirements.md` (line ~152), also write the wrapper script:

```ts
// In provision(), after writeFiles for requirements.md:

import { buildWrapperScript } from "./wrapper-script.js";

// ... inside provision():

// Write wrapper script for detached execution
const wrapperScript = buildWrapperScript({ model: this.config.claudeModel });
await sandbox.writeFiles([
  { path: "requirements.md", content: Buffer.from(requirementsMd) },
  { path: "/tmp/agent-wrapper.sh", content: Buffer.from(wrapperScript) },
]);
await sandbox.runCommand("chmod", ["+x", "/tmp/agent-wrapper.sh"]);
```

Replace the existing `writeFiles` call (which only writes `requirements.md`) with the combined call above.

- [ ] **Step 2: Run existing manager tests**

Run: `pnpm test src/sandbox/manager.test.ts`
Expected: PASS (mock handles writeFiles with any args)

- [ ] **Step 3: Commit**

```bash
git add src/sandbox/manager.ts
git commit -m "feat: write agent wrapper script to sandbox during provisioning"
```

---

### Task 5: Replace `run-agent.ts` with `startAgentDetached`

Remove the old blocking `runAgent` (including debug streaming code) and replace with a single `startAgentDetached` function. Debug mode (`DEBUG_AGENT` env var) is removed entirely — observability is handled via the WDK workflow dashboard and step logs.

**Files:**
- Rewrite: `src/sandbox/run-agent.ts`
- Modify: `env.ts` (remove `DEBUG_AGENT`)

- [ ] **Step 1: Rewrite `src/sandbox/run-agent.ts`**

Replace the entire file contents with:

```ts
// src/sandbox/run-agent.ts
import type { Sandbox as SandboxType } from "@vercel/sandbox";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

/**
 * Starts the agent wrapper script in detached mode.
 * Returns immediately — the agent runs in the background.
 * Use `checkAgentDone` / `collectAgentResults` from poll-agent.ts to poll for completion.
 */
export async function startAgentDetached(
  sandbox: SandboxInstance,
): Promise<void> {
  await sandbox.runCommand({
    cmd: "bash",
    args: ["/tmp/agent-wrapper.sh"],
    cwd: "/vercel/sandbox",
    detached: true,
  });
}
```

- [ ] **Step 2: Remove `DEBUG_AGENT` from `env.ts`**

Remove the `DEBUG_AGENT` field from the env schema in `env.ts`:

```ts
// REMOVE these lines from env.ts:
DEBUG_AGENT: z
  .string()
  .transform((v) => v === "true" || v === "1")
  .default("false"),
```

- [ ] **Step 3: Remove `debug` references from workflow steps**

In `src/workflows/implementation.ts`, remove `debug: env.DEBUG_AGENT` from the `SandboxManager` constructor call (if present in the new `provisionAndStartAgent` step — it should not be needed since the wrapper script handles everything).

Same for `src/workflows/review-fix.ts`.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (any remaining references to `DEBUG_AGENT` or `runAgent` will surface as type errors — fix them)

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/run-agent.ts env.ts src/workflows/implementation.ts src/workflows/review-fix.ts
git commit -m "feat: replace runAgent with startAgentDetached, remove debug mode"
```

---

### Task 6: Update `implementationWorkflow` to use polling pattern

Replace the single blocking `runAgentInSandbox` step with the provision → poll → collect pattern.

**Files:**
- Modify: `src/workflows/implementation.ts`

- [ ] **Step 1: Replace the `runAgentInSandbox` step**

Remove the existing `runAgentInSandbox` function (lines 43-71). Replace with two new steps:

```ts
async function provisionAndStartAgent(
  branchName: string,
  requirementsMd: string,
): Promise<string> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { startAgentDetached } = await import("../sandbox/run-agent.js");

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

  const sandbox = await manager.provision(branchName, requirementsMd);
  await startAgentDetached(sandbox);
  return sandbox.sandboxId;
}
provisionAndStartAgent.maxRetries = 0; // Don't retry expensive provisioning
```

- [ ] **Step 2: Update the workflow orchestration**

Replace the workflow body (inside the try block, after `assembleImplementationRequirements`) with the poll pattern. Add imports for `sleep` from `"workflow"`:

```ts
import { sleep } from "workflow";

// ... inside implementationWorkflow, in the try block:

    const requirementsMd = await assembleImplementationRequirements(ticket);

    // --- Detached execution with polling ---
    const { checkAgentDone, collectAgentResults, teardownSandbox } =
      await import("../sandbox/poll-agent.js");

    const sandboxId = await provisionAndStartAgent(branchName, requirementsMd);

    // Poll until agent finishes — workflow truly suspends between polls.
    // Use Date.now() for timeout instead of Promise.race with two sleeps
    // (racing two WDK sleep calls is unsafe for deterministic replay).
    const POLL_INTERVAL = "30s";
    const TIMEOUT_MS = 35 * 60 * 1000; // 35 min — slightly above JOB_TIMEOUT_MS default (30m)
    const startedAt = Date.now();
    let agentDone = false;

    try {
      while (!agentDone) {
        await sleep(POLL_INTERVAL);

        if (Date.now() - startedAt > TIMEOUT_MS) break;

        const status = await checkAgentDone(sandboxId);
        if (status === true) {
          agentDone = true;
        } else if (status === "stopped") {
          // Sandbox died before agent finished
          break;
        }
        // status === false → keep polling
      }

      let output: AgentOutput;
      let files: Array<{ path: string; content: string }>;

      if (agentDone) {
        ({ output, files } = await collectAgentResults(sandboxId));
      } else {
        output = { result: "failed", error: "Agent timed out or sandbox stopped unexpectedly" };
        files = [];
      }

      // --- Rest of workflow continues unchanged ---
      await pushChanges(branchName, files);
    } finally {
      await teardownSandbox(sandboxId);
    }
```

- [ ] **Step 3: Clean up unused imports**

Remove `runAgent` import and the old `SandboxManager` usage from the removed step. Add `sleep` import:

```ts
import { sleep } from "workflow";
import type { AgentOutput } from "../sandbox/agent-runner.js";
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workflows/implementation.ts
git commit -m "feat: implement polling-based sandbox suspension in implementation workflow"
```

---

### Task 7: Update `reviewFixWorkflow` to use polling pattern

Apply the same polling pattern to the review-fix workflow.

**Files:**
- Modify: `src/workflows/review-fix.ts`

- [ ] **Step 1: Replace `runFixingAgentInSandbox` step**

Remove the existing `runFixingAgentInSandbox` function (lines 66-100). Replace with:

```ts
async function provisionAndStartFixingAgent(
  branchName: string,
  requirementsMd: string,
  mergeBase: string,
): Promise<string> {
  "use step";
  const { env } = await import("../../env.js");
  const { SandboxManager } = await import("../sandbox/manager.js");
  const { startAgentDetached } = await import("../sandbox/run-agent.js");

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

  const sandbox = await manager.provision(branchName, requirementsMd, mergeBase);
  await startAgentDetached(sandbox);
  return sandbox.sandboxId;
}
provisionAndStartFixingAgent.maxRetries = 0;
```

- [ ] **Step 2: Update workflow orchestration**

Replace the workflow body (after `assembleReviewFixRequirements`) with the poll pattern — same as Task 6 Step 2 but calling `provisionAndStartFixingAgent(branchName, requirementsMd, env.GITHUB_BASE_BRANCH)` instead:

```ts
import { sleep } from "workflow";

// ... inside reviewFixWorkflow, in the try block, after assembling requirements:

    const { checkAgentDone, collectAgentResults, teardownSandbox } =
      await import("../sandbox/poll-agent.js");

    const sandboxId = await provisionAndStartFixingAgent(
      branchName,
      requirementsMd,
      env.GITHUB_BASE_BRANCH,
    );

    // Same Date.now() elapsed-time pattern as implementation workflow
    // (racing two WDK sleep calls is unsafe for deterministic replay).
    const POLL_INTERVAL = "30s";
    const TIMEOUT_MS = 35 * 60 * 1000; // 35 min
    const startedAt = Date.now();
    let agentDone = false;

    try {
      while (!agentDone) {
        await sleep(POLL_INTERVAL);

        if (Date.now() - startedAt > TIMEOUT_MS) break;

        const status = await checkAgentDone(sandboxId);
        if (status === true) {
          agentDone = true;
        } else if (status === "stopped") {
          break;
        }
      }

      let output: AgentOutput;
      let files: Array<{ path: string; content: string }>;

      if (agentDone) {
        ({ output, files } = await collectAgentResults(sandboxId));
      } else {
        output = { result: "failed", error: "Agent timed out or sandbox stopped unexpectedly" };
        files = [];
      }

      await pushChanges(branchName, files, baseSha);
    } finally {
      await teardownSandbox(sandboxId);
    }
```

- [ ] **Step 3: Clean up imports**

Add `sleep` import, add `AgentOutput` type import, remove unused imports.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workflows/review-fix.ts
git commit -m "feat: implement polling-based sandbox suspension in review-fix workflow"
```

---

### Task 8: Run full test suite and fix issues

- [ ] **Step 1: Run all unit tests**

Run: `pnpm test`
Expected: PASS — all existing tests should still pass. The `manager.test.ts` mock includes `writeFiles` which accepts any args, and we only added to the existing `provision()` flow.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Fix any failures**

Address any test or type failures found. Common issues:
- `manager.test.ts` may need an extra `mockRunCommand` call for the `chmod` on the wrapper script
- Import paths may need `.js` extension for ESM

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "fix: resolve test/type issues from sandbox polling refactor"
```

---

## Summary of Changes

| Before | After |
|--------|-------|
| Single blocking step runs agent for 10-30 min | Detached start → workflow suspends → polls every 30s |
| Workflow consumes resources entire time | Workflow at zero resources during agent execution |
| No timeout handling | `Date.now()` elapsed-time check (35 min) per poll iteration |
| Sandbox teardown in same step | Separate teardown step in `finally` block (always runs) |
| Debug mode: live streaming via `getWritable` | Debug mode: removed entirely |
| Wrapper auto-commits uncommitted changes | Agent commits via stop hook with descriptive message |

## Not In Scope (Future Work)

- **Hook-based callback**: If 30s polling latency is unacceptable, switch to `createHook`/`resumeHook` with a callback route.
- **Progress streaming**: The wrapper script could write progress to a file that the poll step reads and streams via `getWritable()`.
