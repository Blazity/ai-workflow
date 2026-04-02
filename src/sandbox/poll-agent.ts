import { getSandboxCredentials } from "./credentials.js";
import { parseAgentOutput } from "./agent-runner.js";
import type { AgentOutput } from "./agent-runner.js";

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
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    if (sandbox.status !== "running") {
      return "stopped";
    }

    const result = await sandbox.runCommand("test", ["-f", "/tmp/agent-done"]);
    return result.exitCode === 0;
  } catch {
    // Sandbox unreachable (network error, GC'd, etc.) — treat as stopped
    return "stopped";
  }
}

/**
 * Reconnects to the sandbox, reads agent stdout/stderr, and returns the
 * parsed result. File extraction is no longer needed — commits are pushed
 * directly from the sandbox via `pushFromSandbox`.
 */
export async function collectAgentOutput(
  sandboxId: string,
): Promise<{ output: AgentOutput }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");

  let sandbox;
  try {
    sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  } catch {
    // Sandbox unreachable between final poll and collection — return a clear failure
    return {
      output: { result: "failed", error: "Sandbox became unreachable before results could be collected" },
    };
  }

  // Read agent output files
  const stdoutResult = await sandbox.runCommand("cat", ["/tmp/agent-stdout.txt"]);
  const stdout = (await stdoutResult.stdout()).trim();

  const stderrResult = await sandbox.runCommand("cat", ["/tmp/agent-stderr.txt"]);
  const stderr = (await stderrResult.stdout()).trim();

  const raw = stdout || stderr;
  const output = parseAgentOutput(raw);

  return { output };
}

/**
 * After the agent exits, injects the GitHub token and pushes commits to GitHub.
 * The agent process is dead at this point — the token is never visible to it.
 */
export async function pushFromSandbox(
  sandboxId: string,
  branch: string,
): Promise<{ pushed: boolean; error?: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Check if agent made any commits.
  // If the sentinel file is missing (provisioning issue), skip the check and push anyway.
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

  // Unshallow so git can negotiate objects with GitHub during push.
  // The sandbox clones with depth:1 — without full history, push fails with
  // "Could not read <sha>" when the remote has commits the shallow clone can't traverse.
  await sandbox.runCommand("git", ["fetch", "--unshallow", "origin"]);

  // Push to GitHub — use HEAD:<ref> so it works even if the local branch name
  // doesn't match (e.g. shallow clone leaves HEAD detached).
  const result = await sandbox.runCommand("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);

  if (result.exitCode !== 0) {
    const stdout = (await result.stdout()).trim();
    const stderr = (await result.stderr()).trim();
    return { pushed: false, error: stderr || stdout };
  }

  return { pushed: true };
}

/**
 * If `pushFromSandbox` fails (e.g. pre-push hook failure on the real remote),
 * spawns a lightweight fix agent in the same sandbox to resolve the issue,
 * then retries the push once.
 *
 * SECURITY NOTE: The fix agent runs with the GitHub token present in
 * .git/config (set by the prior `pushFromSandbox` call). This is a deliberate
 * trade-off — the agent is short-lived, narrowly prompted, and the sandbox is
 * torn down immediately after.
 */
export async function fixAndRetryPush(
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

  // Log fix agent output for observability
  const fixOut = await sandbox.runCommand("cat", ["/tmp/fix-stdout.txt"]);
  const fixLog = (await fixOut.stdout()).trim();
  if (fixLog) {
    console.log(`[fixAndRetryPush] fix agent output: ${fixLog.slice(0, 500)}`);
  }

  // Retry push — use HEAD:<ref> to handle detached HEAD from shallow clone
  const result = await sandbox.runCommand("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);

  if (result.exitCode !== 0) {
    const stdout = (await result.stdout()).trim();
    const stderr = (await result.stderr()).trim();
    return { pushed: false, error: stderr || stdout };
  }
  return { pushed: true };
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
