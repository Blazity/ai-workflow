# Sandbox Push — Push from Sandbox with Real Commit Messages

**Date:** 2026-04-02
**Status:** Draft

## Problem

Today, the agent commits inside the sandbox with real commit messages, but the server
throws them away — it extracts files via `git diff`, then recreates a single commit via
the GitHub API with a hardcoded `"feat: agent implementation"` message. This means:

1. **All agent commit messages are lost.** The PR always shows one flat commit.
2. **Pre-push hooks never run.** The GitHub API bypasses git hooks entirely.
3. **The GitHub token lives in the sandbox** as part of the clone URL in `.git/config`,
   potentially visible to the agent.

## Solution

Push from inside the sandbox after the agent exits. The agent commits and pushes to a
local mock remote (triggering pre-push hooks naturally). After the agent process is dead,
the server injects the GitHub token and does the real `git push` to GitHub.

## Detailed Flow

### 1. Branch Creation (unchanged — server-side)

The server creates the branch via GitHub API before the sandbox is provisioned.
This requires the token and stays on the server.

```
Server: vcs.createBranch("blazebot/awt-123", "main")  // Octokit API
```

**Files:** `src/workflows/implementation.ts:19-24`, `src/adapters/vcs/github.ts:23-51`
**Change:** None.

### 2. Sandbox Provisioning (modified)

After `Sandbox.create` clones the repo, immediately sanitize the remote and set up
a local push target. This ensures the agent never sees the GitHub token.

```bash
# Remove origin (may contain token from clone)
git remote remove origin

# Create local bare repo as push target
git init --bare /tmp/push-target.git
git remote add origin /tmp/push-target.git
```

**File:** `src/sandbox/manager.ts` (after line 62, before git config)
**Change:** Add remote sanitization + local bare repo setup after sandbox creation.

### 3. Git Identity + Optional Merge (unchanged)

```bash
git config user.name "ai-workflow-blazity"
git config user.email "ai-workflow@blazity.com"
```

For review-fix workflow, the merge fetch still uses an authenticated URL passed as a
CLI argument to `git fetch`. This appears briefly in process args but is not stored.
No change needed — the agent process hasn't started yet.

**File:** `src/sandbox/manager.ts:64-91`
**Change:** None.

### 4. Pre-Agent SHA Recording (unchanged)

```bash
git rev-parse HEAD > /tmp/.pre-agent-sha
```

**File:** `src/sandbox/manager.ts:93-98`
**Change:** None.

### 5. Agent Execution (modified prompt)

The implementation and review-fix prompts gain a quality gate instruction and a push
instruction. The agent now pushes to `origin` (which points to the local bare repo).

**Prompt additions (both `implement.md` and `review-fix.md`):**

```
## Quality Gate

Before finishing, you MUST:
- Find and run ALL quality checks in the project: tests, linting, type checking,
  formatting, and any other validation scripts.
- Fix all failures and commit your fixes with descriptive messages.
- Push your work to origin (`git push origin <branch>`).
  - If the push fails due to pre-push hooks, fix the issues, commit, and push again.
  - If the push succeeds, you are clear to finish.
```

**Prompt modification for commit messages:**

Replace the existing line:
```
10. Commit your work with descriptive commit messages.
```

With:
```
10. Commit your work with descriptive commit messages that explain the "why", not just
    the "what". Use conventional commit format (feat:, fix:, test:, refactor:, etc.).
11. Run all quality checks and push (see Quality Gate above).
```

**Files:** `src/lib/prompts.ts` (both `implementPrompt` and `reviewFixPrompt`)

### 6. Agent Works

The agent implements the feature, committing with real messages:

```
git commit -m "feat: add user validation schema"
git commit -m "feat: implement registration endpoint"
git commit -m "fix: handle duplicate email edge case"
git commit -m "test: add registration tests"
```

Then pushes:

```
git push origin blazebot/awt-123
  → .husky/pre-push fires (if present) → runs lint/test
  → If hook fails → agent fixes, commits, pushes again
  → If hook passes → push succeeds to /tmp/push-target.git
```

The agent exits, wrapper script touches `/tmp/agent-done`.

### 7. Collect Agent Output (simplified)

Only read the agent's JSON output. **Remove file extraction entirely** — no more
`git diff` + `readFileToBuffer` loop.

**Before:**
```typescript
// poll-agent.ts collectAgentResults()
// Reads stdout, parses JSON, extracts files via git diff, reads each file content
```

**After:**
```typescript
// poll-agent.ts collectAgentOutput()
// Reads stdout, parses JSON — that's it
// Returns: { output: AgentOutput } (no files array)
```

**File:** `src/sandbox/poll-agent.ts:36-98`
**Change:** Remove lines 63-94 (file extraction). Rename to `collectAgentOutput`.
Return type changes from `{ output, files }` to `{ output }`.

### 8. Push from Sandbox (new step)

After the agent exits and output is collected, inject the token and push.

```typescript
async function pushFromSandbox(
  sandboxId: string,
  branch: string,
): Promise<{ pushed: boolean; error?: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Check if agent made any commits
  const baseSha = await sandbox.runCommand("bash", [
    "-c", "cat /tmp/.pre-agent-sha",
  ]);
  const headSha = await sandbox.runCommand("bash", ["-c", "git rev-parse HEAD"]);

  if ((await baseSha.stdout()).trim() === (await headSha.stdout()).trim()) {
    return { pushed: false }; // No commits to push
  }

  // Inject token — agent process is dead
  const pushUrl = `https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}.git`;
  await sandbox.runCommand("git", ["remote", "set-url", "origin", pushUrl]);

  // Push to GitHub
  const result = await sandbox.runCommand("bash", [
    "-c", `git push origin ${branch} 2>&1`,
  ]);

  if (result.exitCode !== 0) {
    const error = (await result.stdout()).trim();
    return { pushed: false, error };
  }

  return { pushed: true };
}
```

**File:** New function in `src/sandbox/poll-agent.ts` (or new file `src/sandbox/push.ts`)

### 9. Fix Agent on Push Failure (new step)

If `pushFromSandbox` fails (e.g., pre-push hook failure), spawn a lightweight fix
agent in the same sandbox to resolve the issue.

```typescript
async function fixAndRetryPush(
  sandboxId: string,
  branch: string,
  pushError: string,
): Promise<{ pushed: boolean; error?: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Run a quick fix agent with the error context
  const fixPrompt = `The git push failed with this error:\n\n${pushError}\n\nFix the issues, commit your fixes, then push to origin.`;
  await sandbox.runCommand("bash", [
    "-c",
    `echo '${fixPrompt.replace(/'/g, "'\\''")}' | claude --print --model '${env.CLAUDE_MODEL}' --dangerously-skip-permissions > /tmp/fix-stdout.txt 2>/tmp/fix-stderr.txt || true`,
  ]);

  // Retry push (token is still in remote URL from previous step)
  const result = await sandbox.runCommand("bash", [
    "-c", `git push origin ${branch} 2>&1`,
  ]);

  if (result.exitCode !== 0) {
    return { pushed: false, error: (await result.stdout()).trim() };
  }
  return { pushed: true };
}
```

**File:** New function alongside `pushFromSandbox`.

### 10. Workflow Integration

**Implementation workflow** (`src/workflows/implementation.ts`):

Replace:
```typescript
// Old
const { output, files } = await collectAgentResults(sandboxId);
await pushChanges(branchName, files);
```

With:
```typescript
// New
const { output } = await collectAgentOutput(sandboxId);

if (output.result === "implemented") {
  let pushResult = await pushFromSandbox(sandboxId, branchName);

  if (!pushResult.pushed && pushResult.error) {
    // Pre-push hook or other failure — try fix agent
    pushResult = await fixAndRetryPush(sandboxId, branchName, pushResult.error);
  }

  if (!pushResult.pushed) {
    // Push failed even after fix attempt
    await moveTicket(ticketId, env.COLUMN_BACKLOG);
    await notifySlack(`Task ${ticket.identifier} failed: push failed — ${pushResult.error ?? "unknown"}`);
    await unregisterRun(ticket.identifier);
    return;
  }

  await createPullRequest(branchName, ticket.title, output.summary ?? "");
  // ... rest unchanged
}
```

**Review-fix workflow** (`src/workflows/review-fix.ts`):

Same pattern. Replace `collectAgentResults` + `pushChanges` with
`collectAgentOutput` + `pushFromSandbox` + `fixAndRetryPush`.

**Note on merge commits:** The current review-fix flow uses `mergeParentSha` to create
a merge commit via the GitHub API. With sandbox push, this is handled naturally — the
sandbox already has the merge commit from step 3 (optional merge). When we `git push`,
the merge commit is included in the push. The `mergeParentSha` parameter on
`github.ts:push()` is no longer needed.

### 11. PR Creation, Ticket Update, Teardown (unchanged)

PR creation still uses Octokit API (no token needed in sandbox for this).
Ticket moves and Slack notifications are unchanged.

## Files Changed

| File | Change |
|------|--------|
| `src/sandbox/manager.ts` | Add remote sanitization + local bare repo setup after clone |
| `src/lib/prompts.ts` | Add quality gate + push instructions to both prompts |
| `src/sandbox/poll-agent.ts` | Simplify `collectAgentResults` → `collectAgentOutput` (remove file extraction). Add `pushFromSandbox` + `fixAndRetryPush` |
| `src/workflows/implementation.ts` | Replace `pushChanges(files)` with `pushFromSandbox` + `fixAndRetryPush` |
| `src/workflows/review-fix.ts` | Same as implementation.ts |
| `src/adapters/vcs/github.ts` | `push()` method no longer called for agent work (keep for other uses or remove) |

## What's Preserved

- All agent commits with their original messages
- Full commit history on the PR (not squashed)
- Pre-push hooks fire naturally during `git push`
- Agent can fix hook failures before exiting
- Merge commits in review-fix flow (natural git merge, not API-fabricated)

## What's Removed

- File extraction in `collectAgentResults` (`git diff` + `readFileToBuffer` loop)
- Hardcoded `"feat: agent implementation"` commit message
- GitHub API push flow (blob → tree → commit → updateRef) for agent work

## Edge Cases

| Case | Handling |
|------|----------|
| No pre-push hooks in target repo | Push to local bare succeeds, real push succeeds. No change. |
| Agent doesn't push (forgets/skips) | Commits are still in sandbox. `pushFromSandbox` pushes them. |
| Pre-push hook fails during real push | `fixAndRetryPush` spawns fix agent, retries once. |
| Fix agent also fails | Move ticket to backlog with error details. |
| Sandbox dies between agent exit and push | Existing `"stopped"` detection catches this — ticket moves to backlog. |
| Agent makes zero commits | `pushFromSandbox` detects baseSha == HEAD, returns `{ pushed: false }`. Workflow handles as no-op or failure based on agent output. |
| Shallow clone push to GitHub | Works — GitHub has the parent commit (branch was created from base). Git sends the delta. |
| Token in .git/config from clone | Removed in step 2 (`git remote remove origin`). |

## Security

- **Agent never sees the GitHub token.** Remote is sanitized immediately after clone.
- **Token injected only after agent process exits.** The sentinel file `/tmp/agent-done`
  confirms the agent is dead before any token enters the sandbox.
- **Token exists briefly** in the sandbox git config during step 10, then sandbox is torn down.
- **Fix agent (step 9)** runs with the token in git config, but this is a controlled,
  short-lived session with a narrow prompt — not the main agent with full autonomy.
