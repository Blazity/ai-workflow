import { getSandboxCredentials } from "./credentials.js";
import { buildCloneUrl, buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "./repo-workspace.js";
import type { PublicationRepositoryRecord } from "../publication/store.js";

export interface WorkspacePushRepoResult {
  provider: "github" | "gitlab";
  repoPath: string;
  branchName: string;
  pushed: boolean;
  changed: boolean;
  /** Freshly fetched remote head used in the exact lease. */
  expectedHead?: string;
  /** Committed local head intended for the remote, persisted before push. */
  targetHead?: string;
  /** Local committed head that landed remotely. */
  pushedHead?: string;
  failureKind?:
    | "dirty_worktree"
    | "merge_conflict"
    | "remote_drift"
    | "preflight_failed"
    | "lease_rejected"
    | "push_failed";
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
  sourceHeads: Array<{
    provider: WorkspaceRepo["provider"];
    repoPath: string;
    headSha: string;
  }> = [],
  publicationAttemptId?: string,
): Promise<WorkspacePushResult> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manifest = await readWorkspaceManifest(sandbox);
  const durableRepositories = await loadPublicationRepositories(publicationAttemptId);
  return pushWorkspaceRepositories(
    sandbox,
    manifest,
    sourceHeads,
    publicationAttemptId,
    durableRepositories,
  );
}
pushWorkspaceFromSandbox.maxRetries = 0;

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
  sourceHeads: Array<{
    provider: WorkspaceRepo["provider"];
    repoPath: string;
    headSha: string;
  }>,
  publicationAttemptId?: string,
  durableRepositories: PublicationRepositoryRecord[] = [],
): Promise<WorkspacePushResult> {
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const sourceHeadByRepository = new Map(
    sourceHeads.map((head) => [`${head.provider}:${head.repoPath}`, head.headSha]),
  );
  const durableByRepository = new Map(
    durableRepositories.map((repository) => [
      `${repository.provider}:${repository.repoPath}`,
      repository,
    ]),
  );
  const preflights: Array<{
    repo: WorkspaceRepo;
    result: WorkspacePushRepoResult;
    localHead?: string;
    authArgs?: string[];
    cloneUrl?: string;
  }> = [];

  for (const repo of manifest.repositories) {
    const base = {
      provider: repo.provider,
      repoPath: repo.repoPath,
      branchName: repo.branchName,
      pushed: false,
    };
    const status = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.exitCode !== 0) {
      preflights.push({
        repo,
        result: {
          ...base,
          changed: false,
          failureKind: "preflight_failed",
          error: `git status failed: ${await commandError(status)}`,
        },
      });
      continue;
    }
    const dirty = (await status.stdout()).trim();
    if (dirty) {
      preflights.push({
        repo,
        result: {
          ...base,
          changed: false,
          failureKind: "dirty_worktree",
          error: `workspace has uncommitted changes: ${dirty}`,
        },
      });
      continue;
    }

    const conflicts = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    const conflictPaths = conflicts.exitCode === 0 ? (await conflicts.stdout()).trim() : "";
    if (conflicts.exitCode !== 0 || conflictPaths) {
      preflights.push({
        repo,
        result: {
          ...base,
          changed: false,
          failureKind: conflicts.exitCode === 0 ? "merge_conflict" : "preflight_failed",
          error:
            conflicts.exitCode === 0
              ? `workspace has unresolved merge conflicts: ${conflictPaths}`
              : `conflict check failed: ${await commandError(conflicts)}`,
        },
      });
      continue;
    }

    const headResult = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "rev-parse",
      "HEAD",
    ]);
    if (headResult.exitCode !== 0) {
      preflights.push({
        repo,
        result: {
          ...base,
          changed: false,
          failureKind: "preflight_failed",
          error: `git rev-parse failed: ${await commandError(headResult)}`,
        },
      });
      continue;
    }
    const headSha = (await headResult.stdout()).trim();
    const durable = durableByRepository.get(`${repo.provider}:${repo.repoPath}`);
    const isDurableTarget = durable?.targetHead === headSha;
    const changed = isDurableTarget
      ? durable.changed
      : !repo.preAgentSha || repo.preAgentSha !== headSha;

    const runtime = createRepositoryVcsRuntime({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    const token = await runtime.getToken();
    const urls = buildVcsUrls({ ...runtime.config, repoPath: repo.repoPath });
    const cloneUrl = buildCloneUrl({ host: runtime.config.host, repoPath: repo.repoPath });
    const authArgs = gitAuthArgs(urls.authUser, token);

    const fetchResult = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      ...authArgs,
      "fetch",
      "--no-tags",
      urls.cloneUrl,
      `refs/heads/${repo.branchName}`,
    ]);
    if (fetchResult.exitCode !== 0) {
      preflights.push({
        repo,
        result: {
          ...base,
          changed,
          failureKind: "preflight_failed",
          error: `remote fetch failed: ${await commandError(fetchResult)}`,
        },
      });
      continue;
    }

    const remoteHeadResult = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      "rev-parse",
      "FETCH_HEAD",
    ]);
    if (remoteHeadResult.exitCode !== 0) {
      preflights.push({
        repo,
        result: {
          ...base,
          changed,
          failureKind: "preflight_failed",
          error: `remote head read failed: ${await commandError(remoteHeadResult)}`,
        },
      });
      continue;
    }
    const expectedHead = (await remoteHeadResult.stdout()).trim();
    if (isDurableTarget && durable.targetHead === expectedHead) {
      preflights.push({
        repo,
        localHead: headSha,
        authArgs,
        cloneUrl,
        result: {
          ...base,
          changed,
          expectedHead:
            durable.expectedHead ?? repo.expectedRemoteSha ?? repo.preAgentSha ?? expectedHead,
          targetHead: durable.targetHead,
          pushed: true,
          pushedHead: durable.targetHead,
        },
      });
      continue;
    }
    const baseline =
      (isDurableTarget ? durable.expectedHead : null) ??
      sourceHeadByRepository.get(`${repo.provider}:${repo.repoPath}`) ??
      repo.expectedRemoteSha ??
      repo.preAgentSha;
    if (!baseline || expectedHead !== baseline) {
      preflights.push({
        repo,
        result: {
          ...base,
          changed,
          expectedHead,
          failureKind: "remote_drift",
          error: baseline
            ? `remote branch moved from ${baseline} to ${expectedHead}`
            : "workspace has no trusted remote branch baseline",
        },
      });
      continue;
    }

    preflights.push({
      repo,
      localHead: headSha,
      authArgs,
      cloneUrl,
      result: {
        ...base,
        changed,
        expectedHead,
        targetHead: headSha,
      },
    });
  }

  await persistPublicationPreflights(
    publicationAttemptId,
    preflights.map((preflight) => preflight.result),
  );

  if (preflights.some((preflight) => preflight.result.failureKind)) {
    return summarizeWorkspacePush(preflights.map((preflight) => preflight.result));
  }

  for (const preflight of preflights) {
    if (!preflight.result.changed) continue;
    if (preflight.result.pushed) {
      await persistPublicationPushResult(publicationAttemptId, preflight.result);
      continue;
    }
    const { repo } = preflight;
    const pushResult = await sandbox.runCommand("git", [
      "-C",
      repo.localPath,
      ...(preflight.authArgs ?? []),
      "push",
      `--force-with-lease=refs/heads/${repo.branchName}:${preflight.result.expectedHead}`,
      "origin",
      `HEAD:refs/heads/${repo.branchName}`,
    ]);

    if (pushResult.exitCode !== 0) {
      const error = await commandError(pushResult);
      const currentHead = await refetchRemoteHead(
        sandbox,
        repo,
        preflight.authArgs ?? [],
        preflight.cloneUrl!,
      );
      if (currentHead === preflight.localHead) {
        const cleanupError = await resetOriginAfterPush(
          sandbox,
          repo,
          preflight.cloneUrl!,
        );
        preflight.result = {
          ...preflight.result,
          pushed: true,
          pushedHead: preflight.localHead,
          ...(cleanupError ? { cleanupError } : {}),
        };
        await persistPublicationPushResult(publicationAttemptId, preflight.result);
        continue;
      }
      preflight.result = {
        ...preflight.result,
        pushed: false,
        failureKind: isLeaseRejection(error) ? "lease_rejected" : "push_failed",
        error,
      };
      await persistPublicationPushResult(publicationAttemptId, preflight.result);
      continue;
    }

    const cleanupError = await resetOriginAfterPush(sandbox, repo, preflight.cloneUrl!);

    preflight.result = {
      ...preflight.result,
      pushed: true,
      pushedHead: preflight.localHead,
      ...(cleanupError ? { cleanupError } : {}),
    };
    await persistPublicationPushResult(publicationAttemptId, preflight.result);
  }

  return summarizeWorkspacePush(preflights.map((preflight) => preflight.result));
}

async function loadPublicationRepositories(
  attemptId: string | undefined,
): Promise<PublicationRepositoryRecord[]> {
  if (!attemptId) return [];
  const { getDb } = await import("../db/client.js");
  const { getPublicationAttempt } = await import("../publication/store.js");
  return (await getPublicationAttempt(getDb(), attemptId))?.repositories ?? [];
}

async function refetchRemoteHead(
  sandbox: SandboxSession,
  repo: WorkspaceRepo,
  authArgs: string[],
  cloneUrl: string,
): Promise<string | null> {
  const fetchResult = await sandbox.runCommand("git", [
    "-C",
    repo.localPath,
    ...authArgs,
    "fetch",
    "--no-tags",
    cloneUrl,
    `refs/heads/${repo.branchName}`,
  ]);
  if (fetchResult.exitCode !== 0) return null;
  const remoteHeadResult = await sandbox.runCommand("git", [
    "-C",
    repo.localPath,
    "rev-parse",
    "FETCH_HEAD",
  ]);
  if (remoteHeadResult.exitCode !== 0) return null;
  return (await remoteHeadResult.stdout()).trim();
}

async function resetOriginAfterPush(
  sandbox: SandboxSession,
  repo: WorkspaceRepo,
  cloneUrl: string,
): Promise<string | undefined> {
  const resetRemote = await sandbox.runCommand("git", [
    "-C",
    repo.localPath,
    "remote",
    "set-url",
    "origin",
    cloneUrl,
  ]);
  return resetRemote.exitCode === 0
    ? undefined
    : `failed to reset origin after push: ${await commandError(resetRemote)}`;
}

function summarizeWorkspacePush(repositories: WorkspacePushRepoResult[]): WorkspacePushResult {
  const explicitFailures = repositories.filter((repo) => repo.failureKind);
  if (explicitFailures.length > 0) {
    return {
      pushed: false,
      repositories,
      error: summarizePushFailures(explicitFailures),
    };
  }

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

function isLeaseRejection(error: string): boolean {
  return /stale info|force-with-lease|fetch first|rejected.*stale/i.test(error);
}

async function persistPublicationPreflights(
  attemptId: string | undefined,
  repositories: WorkspacePushRepoResult[],
): Promise<void> {
  if (!attemptId) return;
  const { getDb } = await import("../db/client.js");
  const { recordPublicationRepositoryPreflight } = await import("../publication/store.js");
  const db = getDb();
  for (const repository of repositories) {
    await recordPublicationRepositoryPreflight(db, {
      attemptId,
      provider: repository.provider,
      repoPath: repository.repoPath,
      changed: repository.changed,
      expectedHead: repository.expectedHead ?? null,
      targetHead: repository.targetHead ?? null,
      failure: repository.error ?? null,
    });
  }
}

async function persistPublicationPushResult(
  attemptId: string | undefined,
  repository: WorkspacePushRepoResult,
): Promise<void> {
  if (!attemptId) return;
  const { getDb } = await import("../db/client.js");
  const {
    recordPublicationRepositoryFailure,
    recordPublicationRepositoryPush,
  } = await import("../publication/store.js");
  const db = getDb();
  if (repository.pushed && repository.pushedHead) {
    await recordPublicationRepositoryPush(db, {
      attemptId,
      provider: repository.provider,
      repoPath: repository.repoPath,
      pushedHead: repository.pushedHead,
    });
  } else if (repository.error) {
    await recordPublicationRepositoryFailure(db, {
      attemptId,
      provider: repository.provider,
      repoPath: repository.repoPath,
      failure: repository.error,
    });
  }
}

interface SandboxCommandResult {
  exitCode: number;
  stdout: () => Promise<string>;
  stderr?: () => Promise<string>;
}

interface SandboxSession {
  runCommand: (cmd: string, args: string[]) => Promise<SandboxCommandResult>;
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
