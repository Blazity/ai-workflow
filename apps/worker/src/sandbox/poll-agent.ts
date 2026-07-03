import { getSandboxCredentials } from "./credentials.js";
import { buildVcsUrls } from "./manager.js";
import { parseWorkspaceManifest, WORKSPACE_MANIFEST_PATH } from "./repo-workspace.js";

export interface WorkspacePushRepoResult {
  provider: "github" | "gitlab";
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
  const { getVcsProviderConfig, getVcsToken } = await import("../../env.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  const manifest = parseWorkspaceManifest(await manifestResult.stdout());
  const repositories: WorkspacePushRepoResult[] = [];

  for (const repo of manifest.repositories) {
    const headResult = await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
    const headSha = (await headResult.stdout()).trim();
    const changed = !repo.preAgentSha || repo.preAgentSha !== headSha;

    if (!changed) {
      repositories.push({
        provider: repo.provider,
        repoPath: repo.repoPath,
        branchName: repo.branchName,
        changed: false,
        pushed: false,
      });
      continue;
    }

    const config = getVcsProviderConfig(repo.provider);
    const token = await getVcsToken(config);
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
        provider: repo.provider,
        repoPath: repo.repoPath,
        branchName: repo.branchName,
        changed: true,
        pushed: false,
        error,
      });
      return { pushed: false, repositories, error };
    }

    repositories.push({
      provider: repo.provider,
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
