import { getSandboxCredentials } from "./credentials.js";
import { buildCloneUrl, buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "./repo-workspace.js";

export interface WorkspacePushRepoResult {
  provider: "github" | "gitlab";
  repoPath: string;
  branchName: string;
  pushed: boolean;
  changed: boolean;
  error?: string;
  cleanupError?: string;
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
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manifest = await readWorkspaceManifest(sandbox);
  return pushWorkspaceRepositories(sandbox, manifest);
}

export async function fixAndRetryWorkspacePush(
  sandboxId: string,
  failedPush: WorkspacePushResult,
  agentKind: "claude" | "codex",
  model: string,
): Promise<WorkspacePushResult> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { logger } = await import("../lib/logger.js");
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manifest = await readWorkspaceManifest(sandbox);
  const failedKeys = failedRepositoryKeys(failedPush);

  for (const repo of manifest.repositories.filter((repo) => failedKeys.has(repositoryKey(repo)))) {
    const runtime = createRepositoryVcsRuntime({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "remote",
      "set-url",
      "origin",
      buildCloneUrl({ host: runtime.config.host, repoPath: repo.repoPath }),
    ]);
  }

  await sandbox.writeFiles([
    {
      path: "/tmp/fix-prompt.txt",
      content: Buffer.from(buildPushFixPrompt(failedPush, manifest)),
    },
  ]);

  const cli =
    agentKind === "codex"
      ? `codex exec --model "${model}" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json -`
      : `claude --print --model '${model}' --dangerously-skip-permissions`;

  await sandbox.runCommand("bash", [
    "-c",
    `cd /vercel/sandbox || exit 1; if [ -f /tmp/agent-env.sh ]; then source /tmp/agent-env.sh; fi; cat /tmp/fix-prompt.txt | ${cli} > /tmp/fix-stdout.txt 2>/tmp/fix-stderr.txt || true`,
  ]);

  const fixOut = await sandbox.runCommand("cat", ["/tmp/fix-stdout.txt"]);
  const fixLog = (await fixOut.stdout()).trim();
  if (fixLog) {
    logger.info({ output: fixLog.slice(0, 500) }, "fix_and_retry_workspace_push_output");
  }

  const retryResult = await pushWorkspaceRepositories(sandbox, manifest, failedKeys);
  return mergePushRetryResults(failedPush, retryResult, failedKeys);
}

async function readWorkspaceManifest(sandbox: SandboxSession): Promise<WorkspaceManifest> {
  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  if (manifestResult.exitCode !== 0) {
    throw new Error(`Workspace manifest not found in sandbox at ${WORKSPACE_MANIFEST_PATH}`);
  }
  return parseWorkspaceManifest(await manifestResult.stdout());
}

async function pushWorkspaceRepositories(
  sandbox: SandboxSession,
  manifest: WorkspaceManifest,
  onlyRepositories?: Set<string>,
): Promise<WorkspacePushResult> {
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const repositories: WorkspacePushRepoResult[] = [];

  for (const repo of manifest.repositories) {
    if (onlyRepositories && !onlyRepositories.has(repositoryKey(repo))) continue;

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

    const runtime = createRepositoryVcsRuntime({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    const token = await runtime.getToken();
    const urls = buildVcsUrls({ ...runtime.config, repoPath: repo.repoPath });
    const cloneUrl = buildCloneUrl({ host: runtime.config.host, repoPath: repo.repoPath });
    const authArgs = gitAuthArgs(urls.authUser, token);
    const shallowResult = await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "--is-shallow-repository"]);
    if ((await shallowResult.stdout()).trim() === "true") {
      await sandbox.runCommand("git", ["-C", repo.localPath, ...authArgs, "fetch", "--unshallow", "origin"]);
    }
    const result = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      ...authArgs,
      "push",
      "--force",
      "origin",
      `HEAD:refs/heads/${repo.branchName}`,
    ]);

    if (result.exitCode !== 0) {
      repositories.push({
        provider: repo.provider,
        repoPath: repo.repoPath,
        branchName: repo.branchName,
        changed: true,
        pushed: false,
        error: await commandError(result),
      });
      continue;
    }

    const resetRemote = await sandbox.runCommand("git", ["-C", repo.localPath, "remote", "set-url", "origin", cloneUrl]);
    const cleanupError = resetRemote.exitCode === 0
      ? undefined
      : `failed to reset origin after push: ${await commandError(resetRemote)}`;

    repositories.push({
      provider: repo.provider,
      repoPath: repo.repoPath,
      branchName: repo.branchName,
      changed: true,
      pushed: true,
      ...(cleanupError ? { cleanupError } : {}),
    });
  }

  return summarizeWorkspacePush(repositories);
}

function summarizeWorkspacePush(repositories: WorkspacePushRepoResult[]): WorkspacePushResult {
  if (!repositories.some((repo) => repo.changed)) {
    return {
      pushed: false,
      repositories,
      error: "Agent reported success but made no commits",
    };
  }

  const failed = repositories.filter((repo) => repo.changed && !repo.pushed);
  if (failed.length > 0) {
    return {
      pushed: false,
      repositories,
      error: summarizePushFailures(failed),
    };
  }

  return { pushed: true, repositories };
}

function failedRepositoryKeys(failedPush: WorkspacePushResult): Set<string> {
  const failedKeys = failedPush.repositories
    .filter((repo) => repo.changed && !repo.pushed)
    .map(repositoryKey);
  return new Set(failedKeys.length > 0
    ? failedKeys
    : failedPush.repositories.map(repositoryKey));
}

function mergePushRetryResults(
  failedPush: WorkspacePushResult,
  retryResult: WorkspacePushResult,
  retryKeys: Set<string>,
): WorkspacePushResult {
  const retryByKey = new Map(
    retryResult.repositories.map((repo) => [repositoryKey(repo), repo]),
  );
  const merged = failedPush.repositories.map((repo) => {
    const key = repositoryKey(repo);
    return retryKeys.has(key) ? retryByKey.get(key) ?? repo : repo;
  });

  for (const repo of retryResult.repositories) {
    if (!failedPush.repositories.some((previous) => repositoryKey(previous) === repositoryKey(repo))) {
      merged.push(repo);
    }
  }

  return summarizeWorkspacePush(merged);
}

async function commandError(result: SandboxCommandResult): Promise<string> {
  const stdout = (await result.stdout()).trim();
  const stderr = ((await result.stderr?.()) ?? "").trim();
  return stderr || stdout || "command failed";
}

function summarizePushFailures(failed: WorkspacePushRepoResult[]): string {
  return failed
    .map((repo) => `${repo.provider}:${repo.repoPath}: ${repo.error ?? "push failed"}`)
    .join("\n");
}

function buildPushFixPrompt(
  failedPush: WorkspacePushResult,
  manifest: WorkspaceManifest,
): string {
  const reposByKey = new Map(
    manifest.repositories.map((repo) => [repositoryKey(repo), repo]),
  );
  const failedRepos = failedPush.repositories.filter((repo) => repo.changed && !repo.pushed);
  const failures = failedRepos.length > 0 ? failedRepos : failedPush.repositories;
  const details = failures.map((repo) => {
    const workspaceRepo = reposByKey.get(repositoryKey(repo));
    return [
      `- Repository: ${repo.provider}:${repo.repoPath}`,
      `  Path: ${workspaceRepo?.localPath ?? "(unknown)"}`,
      `  Branch: ${repo.branchName}`,
      `  Error: ${repo.error ?? failedPush.error ?? "push failed"}`,
    ].join("\n");
  });

  return `The git push failed for one or more Run Workspace repositories.

Fix the issues and commit your fixes. Do not push.

${details.join("\n\n")}`;
}

function repositoryKey(repo: Pick<WorkspaceRepo | WorkspacePushRepoResult, "provider" | "repoPath">): string {
  return `${repo.provider}:${repo.repoPath}`;
}

interface SandboxCommandResult {
  exitCode: number;
  stdout: () => Promise<string>;
  stderr?: () => Promise<string>;
}

interface SandboxSession {
  runCommand: (cmd: string, args: string[]) => Promise<SandboxCommandResult>;
  writeFiles: (files: Array<{ path: string; content: Buffer }>) => Promise<unknown>;
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

/**
 * Tears down every provided sandbox id, de-duplicated and best-effort: one
 * failing teardown never skips the rest. Used to clean up all sandboxes a run
 * created (a prepare_workspace inside a loop makes a fresh one per iteration),
 * not just the most recent. `teardown` is injectable for tests.
 */
export async function teardownSandboxes(
  sandboxIds: Iterable<string>,
  teardown: (sandboxId: string) => Promise<void> = teardownSandbox,
): Promise<void> {
  for (const sandboxId of new Set(sandboxIds)) {
    try {
      await teardown(sandboxId);
    } catch {
      // Best-effort: keep tearing down the remaining sandboxes.
    }
  }
}
