import { getSandboxCredentials } from "./credentials.js";
import { buildVcsUrls } from "./manager.js";

/**
 * After the agent exits, injects the VCS token and pushes commits.
 * The agent process is dead at this point — the token is never visible to it.
 */
export async function pushFromSandbox(
  sandboxId: string,
  branch: string,
): Promise<{ pushed: boolean; error?: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getVcsConfig } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const urls = buildVcsUrls(getVcsConfig());

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
  await sandbox.runCommand("git", ["remote", "set-url", "origin", urls.authUrl]);

  // Unshallow if needed — shallow clones cause "no history in common with main"
  // errors on PR creation because the pushed commits lack shared ancestry.
  await sandbox.runCommand("bash", [
    "-c",
    'if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then git fetch --unshallow origin; fi',
  ]);

  // Push to remote — use HEAD:<ref> so it works even if the local branch name
  // doesn't match. Use --force for retries where the branch already has commits
  // from a prior failed run. Safe because these are bot-created branches with
  // no concurrent pushers.
  const result = await sandbox.runCommand("git", ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);

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
 * The fix agent never has push access — the token is stripped before it runs
 * and re-injected only after it exits, matching the main agent's security model.
 */
export async function fixAndRetryPush(
  sandboxId: string,
  branch: string,
  pushError: string,
): Promise<{ pushed: boolean; error?: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { env, getVcsConfig } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const urls = buildVcsUrls(getVcsConfig());

  // Strip token from origin before the fix agent runs — agent only commits, never pushes.
  await sandbox.runCommand("git", [
    "remote", "set-url", "origin", urls.cloneUrl,
  ]);

  // Write prompt to a file to avoid shell injection via pushError content
  const fixPrompt = `The git push failed with this error:\n\n${pushError}\n\nFix the issues and commit your fixes. Do NOT push.`;
  await sandbox.writeFiles([
    { path: "/tmp/fix-prompt.txt", content: Buffer.from(fixPrompt) },
  ]);

  await sandbox.runCommand("bash", [
    "-c",
    `[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh; cat /tmp/fix-prompt.txt | claude --print --model '${env.CLAUDE_MODEL}' --dangerously-skip-permissions > /tmp/fix-stdout.txt 2>/tmp/fix-stderr.txt || true`,
  ]);

  // Log fix agent output for observability
  const { logger } = await import("../lib/logger.js");
  const fixOut = await sandbox.runCommand("cat", ["/tmp/fix-stdout.txt"]);
  const fixLog = (await fixOut.stdout()).trim();
  if (fixLog) {
    logger.info({ output: fixLog.slice(0, 500) }, "fix_and_retry_push_output");
  }

  // Re-inject token and push — server pushes, not the agent.
  await sandbox.runCommand("git", ["remote", "set-url", "origin", urls.authUrl]);

  const result = await sandbox.runCommand("git", ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);

  if (result.exitCode !== 0) {
    const stdout = (await result.stdout()).trim();
    const stderr = (await result.stderr()).trim();
    return { pushed: false, error: stderr || stdout };
  }
  return { pushed: true };
}

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
