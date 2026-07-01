import { getSandboxCredentials } from "./credentials.js";
import { buildCloneUrl, buildVcsUrls } from "./manager.js";
import { parseWorkspaceManifest, WORKSPACE_MANIFEST_PATH } from "./repo-workspace.js";

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
  const { getVcsConfig, getVcsToken } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const config = getVcsConfig();
  const token = await getVcsToken(config);
  const urls = buildVcsUrls(config, token);

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

export interface WorkspacePushRepoResult {
  repoPath: string;
  branchName: string;
  pushed: boolean;
  changed: boolean;
  error?: string;
}

export interface WorkspacePushResult {
  pushed: boolean;
  repositories: WorkspacePushRepoResult[];
  error?: string;
}

export async function pushWorkspaceFromSandbox(
  sandboxId: string,
): Promise<WorkspacePushResult> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getVcsConfig, getVcsToken } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const config = getVcsConfig();
  const token = await getVcsToken(config);

  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  const manifest = parseWorkspaceManifest(await manifestResult.stdout());
  const repositories: WorkspacePushRepoResult[] = [];

  for (const repo of manifest.repositories) {
    const headResult = await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
    const headSha = (await headResult.stdout()).trim();
    const changed = !repo.preAgentSha || repo.preAgentSha !== headSha;

    if (!changed) {
      repositories.push({
        repoPath: repo.repoPath,
        branchName: repo.branchName,
        changed: false,
        pushed: false,
      });
      continue;
    }

    const urls = buildVcsUrls({ ...config, repoPath: repo.repoPath }, token);
    await sandbox.runCommand("git", ["-C", repo.localPath, "remote", "set-url", "origin", urls.authUrl]);
    await sandbox.runCommand("bash", [
      "-c",
      `if [ "$(git -C "${repo.localPath}" rev-parse --is-shallow-repository)" = "true" ]; then git -C "${repo.localPath}" fetch --unshallow origin; fi`,
    ]);
    const result = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "push",
      "--force",
      "origin",
      `HEAD:refs/heads/${repo.branchName}`,
    ]);

    if (result.exitCode !== 0) {
      const stdout = (await result.stdout()).trim();
      const stderr = (await result.stderr()).trim();
      const error = stderr || stdout;
      repositories.push({
        repoPath: repo.repoPath,
        branchName: repo.branchName,
        changed: true,
        pushed: false,
        error,
      });
      return { pushed: false, repositories, error };
    }

    repositories.push({
      repoPath: repo.repoPath,
      branchName: repo.branchName,
      changed: true,
      pushed: true,
    });
  }

  if (!repositories.some((repo) => repo.changed)) {
    return {
      pushed: false,
      repositories,
      error: "Agent reported success but made no commits",
    };
  }

  return { pushed: true, repositories };
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
  agentKind: "claude" | "codex",
  model: string,
): Promise<{ pushed: boolean; error?: string }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getVcsConfig, getVcsToken } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const config = getVcsConfig();

  // Strip token from origin before the fix agent runs — agent only commits, never pushes.
  await sandbox.runCommand("git", [
    "remote", "set-url", "origin", buildCloneUrl(config),
  ]);

  // Write prompt to a file to avoid shell injection via pushError content
  const fixPrompt = `The git push failed with this error:\n\n${pushError}\n\nFix the issues and commit your fixes. Do NOT push.`;
  await sandbox.writeFiles([
    { path: "/tmp/fix-prompt.txt", content: Buffer.from(fixPrompt) },
  ]);

  // Same CLI flags as the main phase scripts, minus structured output / schema.
  // Codex needs `--skip-git-repo-check` (sandbox sees the repo as dirty after
  // the agent's changes) and `--dangerously-bypass-approvals-and-sandbox` to
  // match the main run; otherwise its inner sandbox would reject edits inside
  // the Vercel microVM.
  const cli =
    agentKind === "codex"
      ? `codex exec --model "${model}" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json -`
      : `claude --print --model '${model}' --dangerously-skip-permissions`;

  await sandbox.runCommand("bash", [
    "-c",
    `[ -f /tmp/agent-env.sh ] && source /tmp/agent-env.sh; cat /tmp/fix-prompt.txt | ${cli} > /tmp/fix-stdout.txt 2>/tmp/fix-stderr.txt || true`,
  ]);

  // Log fix agent output for observability
  const { logger } = await import("../lib/logger.js");
  const fixOut = await sandbox.runCommand("cat", ["/tmp/fix-stdout.txt"]);
  const fixLog = (await fixOut.stdout()).trim();
  if (fixLog) {
    logger.info({ output: fixLog.slice(0, 500) }, "fix_and_retry_push_output");
  }

  // Re-inject token and push — server pushes, not the agent. Mint fresh token
  // here (after the fix agent runs) so we never have a stale token in scope.
  const token = await getVcsToken(config);
  const urls = buildVcsUrls(config, token);
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
 * Collect raw + (optional) structured phase output. Replaces collectPhaseOutput
 * in adapter-aware code paths.
 */
export async function collectPhase(
  sandboxId: string,
  paths: { stdout: string; stderr: string; structuredOutput: string | null },
): Promise<{ raw: string; structured: string | null }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const stdoutResult = await sandbox.runCommand("cat", [paths.stdout]);
  const stdoutText = (await stdoutResult.stdout()).trim();
  const stderrResult = await sandbox.runCommand("cat", [paths.stderr]);
  const stderrText = (await stderrResult.stdout()).trim();
  const raw = stdoutText || stderrText;

  let structured: string | null = null;
  if (paths.structuredOutput) {
    const r = await sandbox.runCommand("cat", [paths.structuredOutput]);
    const text = (await r.stdout()).trim();
    structured = text || null;
  }
  return { raw, structured };
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
