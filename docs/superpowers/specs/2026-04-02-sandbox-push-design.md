# Sandbox Push — Push from Sandbox with Real Commit Messages

**Date:** 2026-04-02
**Status:** Draft (v2 — full clone approach)

## Problem

The original GitHub API push flow (blob → tree → commit → updateRef) lost all agent commit
messages and created a single flat commit. We replaced it with sandbox-side `git push`, but
shallow clones (`depth: 1`) cause "no history in common with main" errors on PR creation —
the unshallow + remote-swap flow is fragile and hard to debug.

Root cause: shallow clones combined with remote removal/re-addition create edge cases where
git's object graph becomes disconnected. GitHub then rejects the PR because the branch
commits don't share ancestry with main.

## Solution

**Full clone, no bare repo, agent commits only, server pushes.**

1. Remove `depth: 1` — clone the full repo. The ~10-30s overhead is negligible vs. the
   agent's 5-35 min execution time.
2. Strip auth from origin URL (instead of swapping to a local bare repo). The agent can
   see the remote URL but can't push without a token.
3. Agent only commits — remove push from the Quality Gate prompt.
4. After the agent exits, server injects the token and pushes to GitHub.

This eliminates all shallow-clone edge cases, the unshallow step, the local bare repo,
and the commit chain verification — ~40 lines of complexity that existed solely to work
around depth-1 limitations.

## Detailed Flow

### 1. Branch Creation (unchanged — server-side)

The server creates the branch via GitHub API before the sandbox is provisioned.

```
Server: vcs.createBranch("blazebot/awt-123", "main")  // Octokit API
```

**Files:** `src/workflows/implementation.ts:19-24`, `src/adapters/vcs/github.ts:23-51`
**Change:** None.

### 2. Sandbox Provisioning (modified)

Remove `depth: 1` from the clone. After clone, strip the token from the origin URL
so the agent never has push access.

```typescript
// src/sandbox/manager.ts — Sandbox.create source
source: {
  type: "git",
  url: `https://github.com/${owner}/${repo}.git`,
  username: "x-access-token",
  password: githubToken,
  revision: branch,
  // No depth — full clone
},
```

```bash
# After clone: strip auth from origin, replace with unauthenticated URL
git remote set-url origin https://github.com/<owner>/<repo>.git
```

**File:** `src/sandbox/manager.ts`
**Changes:**
- Remove `depth: 1` from `Sandbox.create` source config.
- Replace the 3-command bare-repo setup with a single `git remote set-url` to strip auth.

### 3. Git Identity + Optional Merge (simplified)

```bash
git config user.name "ai-workflow-blazity"
git config user.email "ai-workflow@blazity.com"
```

For review-fix workflow, the merge fetch uses an authenticated URL passed as a CLI
argument. With a full clone, we no longer need `--unshallow` during the merge fetch —
just a normal `git fetch <url> <branch>`.

**File:** `src/sandbox/manager.ts`
**Change:** Remove `--unshallow` from the merge fetch command (no longer needed with
full clone). Use plain `git fetch "<url>" <branch>`.

### 4. Pre-Agent SHA Recording (unchanged)

```bash
git rev-parse HEAD > /tmp/.pre-agent-sha
```

**File:** `src/sandbox/manager.ts`
**Change:** None.

### 5. Agent Execution (modified prompt)

The Quality Gate no longer includes push instructions. The agent commits only.

**Quality Gate (both prompts):**

```
## Quality Gate

Before finishing, you MUST:
- Find and run ALL quality checks in the project: tests, linting, type checking,
  formatting, and any other validation scripts.
- Fix all failures and commit your fixes with descriptive messages.
```

The push instruction (`git push origin <branch>`) is removed. The agent should NOT push.

**Files:** `src/lib/prompts.ts` (both `implementPrompt` and `reviewFixPrompt`)

### 6. Agent Works

The agent implements the feature, committing with real messages:

```
git commit -m "feat: add user validation schema"
git commit -m "feat: implement registration endpoint"
git commit -m "fix: handle duplicate email edge case"
git commit -m "test: add registration tests"
```

No push. The agent exits, wrapper script touches `/tmp/agent-done`.

### 7. Collect Agent Output (unchanged from v1)

Reads agent stdout/stderr and parses JSON. No file extraction.

**File:** `src/sandbox/poll-agent.ts` — `collectAgentOutput()`
**Change:** None (already simplified in v1).

### 8. Push from Sandbox (simplified)

After the agent exits and output is collected, inject the token and push.
No unshallow needed — the full clone has complete history.

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
  const baseShaResult = await sandbox.runCommand("bash", [
    "-c", "cat /tmp/.pre-agent-sha 2>/dev/null || echo ''",
  ]);
  const headShaResult = await sandbox.runCommand("bash", ["-c", "git rev-parse HEAD"]);
  const baseSha = (await baseShaResult.stdout()).trim();
  const headSha = (await headShaResult.stdout()).trim();

  if (baseSha && baseSha === headSha) {
    return { pushed: false, error: "Agent reported success but made no commits" };
  }

  // Inject token — agent process is dead
  const pushUrl = `https://x-access-token:${env.GITHUB_TOKEN}@github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}.git`;
  await sandbox.runCommand("git", ["remote", "set-url", "origin", pushUrl]);

  // Push to GitHub — use HEAD:<ref> so it works even if the local branch name
  // doesn't match. Use --force-with-lease so retries on an existing branch
  // succeed without risking concurrent-push data loss.
  const result = await sandbox.runCommand("git", [
    "push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`,
  ]);

  if (result.exitCode !== 0) {
    const stdout = (await result.stdout()).trim();
    const stderr = (await result.stderr()).trim();
    return { pushed: false, error: stderr || stdout };
  }

  return { pushed: true };
}
```

**What's removed vs. v1:**
- Shallow check (`git rev-parse --is-shallow-repository`)
- Unshallow step (`git fetch --unshallow origin`)
- Fallback fetch (`git fetch origin`)
- Commit chain verification (`git rev-list --count HEAD`)

**File:** `src/sandbox/poll-agent.ts`

### 9. Fix Agent on Push Failure (unchanged from v1)

If `pushFromSandbox` fails, spawn a lightweight fix agent in the same sandbox.

```typescript
async function fixAndRetryPush(
  sandboxId: string,
  branch: string,
  pushError: string,
): Promise<{ pushed: boolean; error?: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Write prompt to a file to avoid shell injection via pushError content
  const fixPrompt = `The git push failed with this error:\n\n${pushError}\n\nFix the issues, commit your fixes, then push to origin.`;
  await sandbox.writeFiles([
    { path: "/tmp/fix-prompt.txt", content: Buffer.from(fixPrompt) },
  ]);

  await sandbox.runCommand("bash", [
    "-c",
    `cat /tmp/fix-prompt.txt | claude --print --model '${env.CLAUDE_MODEL}' --dangerously-skip-permissions > /tmp/fix-stdout.txt 2>/tmp/fix-stderr.txt || true`,
  ]);

  // Retry push (token is still in remote URL from previous step)
  const result = await sandbox.runCommand("git", [
    "push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`,
  ]);

  if (result.exitCode !== 0) {
    const stdout = (await result.stdout()).trim();
    const stderr = (await result.stderr()).trim();
    return { pushed: false, error: stderr || stdout };
  }
  return { pushed: true };
}
```

**File:** `src/sandbox/poll-agent.ts`

### 10. Workflow Integration (unchanged from v1)

Both workflows use the same pattern:

```typescript
const { output } = await collectAgentOutput(sandboxId);

if (output.result === "implemented") {
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

  await createPullRequest(branchName, ticket.title, output.summary ?? "");
  // ... rest unchanged
}
```

**Files:** `src/workflows/implementation.ts`, `src/workflows/review-fix.ts`
**Change:** None (already using this pattern).

### 11. PR Creation, Ticket Update, Teardown (unchanged)

PR creation still uses Octokit API. Ticket moves and Slack notifications unchanged.

## Files Changed

| File | Change |
|------|--------|
| `src/sandbox/manager.ts` | Remove `depth: 1`. Replace bare-repo setup with `git remote set-url` to strip auth. Remove `--unshallow` from merge fetch. |
| `src/lib/prompts.ts` | Remove push instruction from Quality Gate in both prompts. |
| `src/sandbox/poll-agent.ts` | Remove unshallow/shallow-check/chain-verify logic from `pushFromSandbox`. |
| `src/sandbox/poll-agent.test.ts` | Remove shallow/unshallow test cases. Simplify push tests. |
| `e2e/tier2/shallow-push.test.ts` | Delete — no longer relevant (no shallow clones). |
| `src/adapters/vcs/github.ts` | `push()` method no longer called for agent work (keep for other uses or remove). |

## What's Preserved

- All agent commits with their original messages
- Full commit history on the PR (not squashed)
- Token security — agent never has push access
- Merge commits in review-fix flow (natural git merge)
- Fix agent for push failures

## What's Removed (vs. current code)

- `depth: 1` shallow cloning
- Local bare repo (`/tmp/push-target.git`) setup
- Unshallow step (`git fetch --unshallow origin`)
- Shallow repository detection
- Commit chain verification (`git rev-list --count HEAD`)
- Push instruction in agent prompts (agent commits only)
- E2E shallow push test

## Edge Cases

| Case | Handling |
|------|----------|
| Agent doesn't commit | `pushFromSandbox` detects baseSha == HEAD, returns error. Workflow moves ticket to backlog. |
| Push fails (pre-push hook on GitHub, network) | `fixAndRetryPush` spawns fix agent, retries once. |
| Fix agent also fails | Move ticket to backlog with error details. |
| Sandbox dies between agent exit and push | Existing `"stopped"` detection catches this. |
| Large repository (slow full clone) | Accepted trade-off. Clone overhead is negligible vs. 5-35 min agent runtime. |
| Token in .git/config from clone | Stripped immediately via `git remote set-url` to unauthenticated URL. |

## Security

- **Agent never sees the GitHub token.** Origin URL stripped of auth immediately after clone.
- **Token injected only after agent process exits.** The sentinel file `/tmp/agent-done`
  confirms the agent is dead before any token enters the sandbox.
- **Token exists briefly** in the sandbox git config during push, then sandbox is torn down.
- **Fix agent (step 9)** runs with the token in git config, but this is a controlled,
  short-lived session with a narrow prompt.
