import { randomUUID } from "node:crypto";
import { buildCloneUrl, buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import { getSandboxCredentials } from "./credentials.js";
import type { WorkspaceManifest, WorkspaceRepo } from "./repo-workspace.js";
import { stopSandboxAndConfirm } from "./stop-ticket-sandboxes.js";

export interface TrustedWorkspacePushRepositoryResult {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  branchName: string;
  defaultBranch: string;
  pushed: boolean;
  changed: boolean;
  expectedHead?: string;
  targetHead?: string;
  pushedHead?: string;
  failureKind?:
    | "dirty_worktree"
    | "merge_conflict"
    | "remote_drift"
    | "preflight_failed"
    | "lease_rejected"
    | "push_failed";
  error?: string;
}

export interface TrustedWorkspacePushResult {
  pushed: boolean;
  repositories: TrustedWorkspacePushRepositoryResult[];
  error?: string;
}

interface PreparedRepository {
  repo: WorkspaceRepo;
  result: TrustedWorkspacePushRepositoryResult;
  bundlePath?: string;
  bundle?: Buffer;
  checkoutPath?: string;
  authArgs?: string[];
  cloneUrl?: string;
}

/**
 * Publishes the manager-authored workspace directly. Workflow owns retries;
 * exact target heads and force-with-lease make a replay safe without a second
 * database state machine.
 */
export async function publishTrustedWorkspaceFromSandbox(input: {
  sourceSandboxId: string;
  workspaceManifest: WorkspaceManifest;
  subjectKey: string;
  ownerToken: string;
  runId: string;
  sourcePullRequest?: import("../workflows/source-pull-request.js").SourcePullRequestIdentity;
}): Promise<TrustedWorkspacePushResult> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await import("../../env.js");
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const { assertOpenSourcePullRequest, isSourcePullRequestRepository } = await import(
    "../workflows/source-pull-request.js"
  );

  const source = await Sandbox.get({
    sandboxId: input.sourceSandboxId,
    ...getSandboxCredentials(),
  });
  const prepared: PreparedRepository[] = [];

  // Preflight every source repository before creating a credentialed sandbox
  // or attempting any remote mutation.
  for (const repo of input.workspaceManifest.repositories) {
    const base = {
      provider: repo.provider,
      repoPath: repo.repoPath,
      branchName: repo.branchName,
      defaultBranch: repo.defaultBranch,
      pushed: false,
    } as const;
    const fail = (
      result: Omit<TrustedWorkspacePushRepositoryResult, keyof typeof base>,
    ) => prepared.push({ repo, result: { ...base, ...result } });

    if (!repo.expectedRemoteSha || !repo.preAgentSha) {
      fail({
        changed: false,
        failureKind: "preflight_failed",
        error: "trusted workspace manifest is missing remote or pre-agent baseline",
      });
      continue;
    }

    const status = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const dirty = status.exitCode === 0 ? (await status.stdout()).trim() : "";
    if (status.exitCode !== 0 || dirty) {
      fail({
        changed: false,
        failureKind: status.exitCode === 0 ? "dirty_worktree" : "preflight_failed",
        error:
          status.exitCode === 0
            ? `workspace has uncommitted changes: ${dirty}`
            : `git status failed: ${await commandError(status)}`,
      });
      continue;
    }

    const conflicts = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    const conflictPaths = conflicts.exitCode === 0 ? (await conflicts.stdout()).trim() : "";
    if (conflicts.exitCode !== 0 || conflictPaths) {
      fail({
        changed: false,
        failureKind: conflicts.exitCode === 0 ? "merge_conflict" : "preflight_failed",
        error:
          conflicts.exitCode === 0
            ? `workspace has unresolved merge conflicts: ${conflictPaths}`
            : `conflict check failed: ${await commandError(conflicts)}`,
      });
      continue;
    }

    const head = await source.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
    if (head.exitCode !== 0) {
      fail({
        changed: false,
        failureKind: "preflight_failed",
        error: `git rev-parse failed: ${await commandError(head)}`,
      });
      continue;
    }
    const targetHead = (await head.stdout()).trim();
    const ancestorFailure = await verifyAncestors(source, repo, targetHead);
    if (ancestorFailure) {
      fail({
        changed: targetHead !== repo.preAgentSha,
        targetHead,
        failureKind: "preflight_failed",
        error: ancestorFailure,
      });
      continue;
    }

    const runtime = createRepositoryVcsRuntime({
      provider: repo.provider,
      repoPath: repo.repoPath,
      baseBranch: repo.defaultBranch,
    });
    const providerHead = await runtime.vcs.getBranchSha(repo.branchName);
    const changed = targetHead !== repo.preAgentSha;
    if (providerHead !== repo.expectedRemoteSha && providerHead !== targetHead) {
      fail({
        changed,
        expectedHead: providerHead,
        targetHead,
        failureKind: "remote_drift",
        error: `remote branch moved from ${repo.expectedRemoteSha} to ${providerHead}`,
      });
      continue;
    }

    prepared.push({
      repo,
      result: {
        ...base,
        changed,
        expectedHead: repo.expectedRemoteSha,
        targetHead,
        pushed: changed && providerHead === targetHead,
        ...(changed && providerHead === targetHead ? { pushedHead: targetHead } : {}),
      },
    });
  }

  if (prepared.some((item) => item.result.failureKind)) return summarize(prepared);
  const pending = prepared.filter((item) => item.result.changed && !item.result.pushed);
  if (pending.length === 0) return summarize(prepared);

  // Export every target before any push. A bad repository cannot leave an
  // earlier repository partially published.
  for (const item of pending) {
    const bundlePath = `/tmp/aiw-publication-${randomUUID()}.bundle`;
    const bundle = await source.runCommand("git", [
      "-C",
      item.repo.localPath,
      "bundle",
      "create",
      bundlePath,
      "HEAD",
      `^${item.repo.expectedRemoteSha}`,
    ]);
    if (bundle.exitCode !== 0) {
      failPrepared(item, `git bundle failed: ${await commandError(bundle)}`, "preflight_failed");
      continue;
    }
    const bytes = await source.readFileToBuffer({ path: bundlePath });
    if (!bytes) {
      failPrepared(item, `git bundle is missing at ${bundlePath}`, "preflight_failed");
      continue;
    }
    item.bundlePath = bundlePath;
    item.bundle = bytes;
  }
  if (prepared.some((item) => item.result.failureKind)) return summarize(prepared);

  const publisher = await Sandbox.create({
    ...getSandboxCredentials(),
    runtime: "node24",
    timeout: env.JOB_TIMEOUT_MS,
  });
  try {
    const { createStepAdapters } = await import("../lib/step-adapters.js");
    const { runRegistry } = createStepAdapters();
    await runRegistry.registerSandbox(
      input.subjectKey,
      input.ownerToken,
      publisher.sandboxId,
      input.runId,
    );
    await publisher.writeFiles(
      pending.map((item) => ({ path: item.bundlePath!, content: item.bundle! })),
    );

    // Validate every canonical checkout and imported target before the first
    // push, preserving all-repository preflight semantics.
    for (const [index, item] of pending.entries()) {
      const runtime = createRepositoryVcsRuntime({
        provider: item.repo.provider,
        repoPath: item.repo.repoPath,
        baseBranch: item.repo.defaultBranch,
      });
      const token = await runtime.getToken();
      const urls = buildVcsUrls({ ...runtime.config, repoPath: item.repo.repoPath });
      const cloneUrl = buildCloneUrl({ host: runtime.config.host, repoPath: item.repo.repoPath });
      const authArgs = gitAuthArgs(urls.authUser, token);
      const checkoutPath = `/vercel/sandbox/publisher/${index}`;
      item.authArgs = authArgs;
      item.cloneUrl = cloneUrl;
      item.checkoutPath = checkoutPath;

      const clone = await publisher.runCommand("git", [
        ...authArgs,
        "clone",
        "--no-tags",
        "--single-branch",
        "--branch",
        item.repo.branchName,
        cloneUrl,
        checkoutPath,
      ]);
      if (clone.exitCode !== 0) {
        failPrepared(item, `canonical clone failed: ${await commandError(clone)}`);
        continue;
      }
      const clonedHead = await publisher.runCommand("git", ["-C", checkoutPath, "rev-parse", "HEAD"]);
      const clonedSha = clonedHead.exitCode === 0 ? (await clonedHead.stdout()).trim() : "";
      if (clonedSha !== item.repo.expectedRemoteSha) {
        failPrepared(
          item,
          `publisher clone head is ${clonedSha || "unreadable"}, expected ${item.repo.expectedRemoteSha}`,
          "remote_drift",
        );
        continue;
      }
      const fetchBundle = await publisher.runCommand("git", [
        "-C",
        checkoutPath,
        "fetch",
        "--no-tags",
        item.bundlePath!,
        "HEAD",
      ]);
      if (fetchBundle.exitCode !== 0) {
        failPrepared(item, `bundle import failed: ${await commandError(fetchBundle)}`);
        continue;
      }
      const bundleHead = await publisher.runCommand("git", [
        "-C",
        checkoutPath,
        "rev-parse",
        "FETCH_HEAD",
      ]);
      const bundleSha = bundleHead.exitCode === 0 ? (await bundleHead.stdout()).trim() : "";
      if (bundleSha !== item.result.targetHead) {
        failPrepared(
          item,
          `bundle target is ${bundleSha || "unreadable"}, expected ${item.result.targetHead}`,
          "preflight_failed",
        );
        continue;
      }
      const ancestor = await publisher.runCommand("git", [
        "-C",
        checkoutPath,
        "merge-base",
        "--is-ancestor",
        item.repo.expectedRemoteSha!,
        "FETCH_HEAD",
      ]);
      if (ancestor.exitCode !== 0) {
        failPrepared(item, "bundle target does not descend from trusted remote head", "preflight_failed");
        continue;
      }
      const checkout = await publisher.runCommand("git", [
        "-C",
        checkoutPath,
        "checkout",
        "--detach",
        "FETCH_HEAD",
      ]);
      if (checkout.exitCode !== 0) {
        failPrepared(item, `bundle checkout failed: ${await commandError(checkout)}`);
      }
    }
    if (prepared.some((item) => item.result.failureKind)) return summarize(prepared);

    const sourceVcs = input.sourcePullRequest
      ? createRepositoryVcsRuntime({
          provider: input.sourcePullRequest.provider,
          repoPath: input.sourcePullRequest.repoPath,
          baseBranch: input.sourcePullRequest.baseRef,
        }).vcs
      : null;
    let expectedSourceHead = input.sourcePullRequest?.headSha;

    for (const item of pending) {
      await runRegistry.registerSandbox(
        input.subjectKey,
        input.ownerToken,
        publisher.sandboxId,
        input.runId,
      );
      if (input.sourcePullRequest && sourceVcs && expectedSourceHead) {
        assertOpenSourcePullRequest(
          { ...input.sourcePullRequest, headSha: expectedSourceHead },
          await sourceVcs.getPRHead(input.sourcePullRequest.prId),
        );
      }
      const push = await publisher.runCommand("git", [
        "-C",
        item.checkoutPath!,
        ...item.authArgs!,
        "push",
        `--force-with-lease=refs/heads/${item.repo.branchName}:${item.repo.expectedRemoteSha}`,
        item.cloneUrl!,
        `HEAD:refs/heads/${item.repo.branchName}`,
      ]);
      const runtime = createRepositoryVcsRuntime({
        provider: item.repo.provider,
        repoPath: item.repo.repoPath,
        baseBranch: item.repo.defaultBranch,
      });
      const providerHead = await runtime.vcs.getBranchSha(item.repo.branchName);
      if (providerHead !== item.result.targetHead) {
        const error =
          push.exitCode === 0
            ? `provider reported ${providerHead} after push, expected ${item.result.targetHead}`
            : await commandError(push);
        failPrepared(item, error, isLeaseRejection(error) ? "lease_rejected" : "push_failed");
        continue;
      }
      item.result = { ...item.result, pushed: true, pushedHead: item.result.targetHead };
      if (
        input.sourcePullRequest &&
        isSourcePullRequestRepository(input.sourcePullRequest, item.repo)
      ) {
        expectedSourceHead = item.result.targetHead;
      }
    }
  } finally {
    await stopSandboxAndConfirm(publisher);
  }

  const result = summarize(prepared);
  if (
    !result.pushed &&
    result.repositories.some((repository) => repository.failureKind === "push_failed")
  ) {
    throw new Error(result.error ?? "transient workspace publication failure");
  }
  return result;
}
publishTrustedWorkspaceFromSandbox.maxRetries = 3;

function failPrepared(
  item: PreparedRepository,
  error: string,
  failureKind: TrustedWorkspacePushRepositoryResult["failureKind"] = "push_failed",
): void {
  item.result = { ...item.result, pushed: false, failureKind, error };
}

async function verifyAncestors(
  source: SandboxSession,
  repo: WorkspaceRepo,
  targetHead: string,
): Promise<string | null> {
  for (const baseline of [repo.expectedRemoteSha!, repo.preAgentSha!]) {
    const ancestor = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "merge-base",
      "--is-ancestor",
      baseline,
      targetHead,
    ]);
    if (ancestor.exitCode !== 0) {
      return `trusted baseline ${baseline} is not an ancestor of source HEAD ${targetHead}`;
    }
  }
  return null;
}

function summarize(prepared: PreparedRepository[]): TrustedWorkspacePushResult {
  const repositories = prepared.map((item) => item.result);
  const failures = repositories.filter((repository) => repository.failureKind);
  if (failures.length > 0) {
    return {
      pushed: false,
      repositories,
      error: failures
        .map(
          (repository) =>
            `${repository.provider}:${repository.repoPath}: ${repository.error ?? "publication failed"}`,
        )
        .join("\n"),
    };
  }
  if (!repositories.some((repository) => repository.changed)) {
    return { pushed: false, repositories, error: "Agent reported success but made no commits" };
  }
  const unpushed = repositories.filter((repository) => repository.changed && !repository.pushed);
  return unpushed.length === 0
    ? { pushed: true, repositories }
    : {
        pushed: false,
        repositories,
        error: unpushed
          .map(
            (repository) =>
              `${repository.provider}:${repository.repoPath}: ${repository.error ?? "push failed"}`,
          )
          .join("\n"),
      };
}

function isLeaseRejection(error: string): boolean {
  return /stale info|force-with-lease|fetch first|rejected.*stale/i.test(error);
}

async function commandError(result: SandboxCommandResult): Promise<string> {
  const stdout = (await result.stdout()).trim();
  const stderr = ((await result.stderr?.()) ?? "").trim();
  return stderr || stdout || "command failed";
}

interface SandboxCommandResult {
  exitCode: number;
  stdout: () => Promise<string>;
  stderr?: () => Promise<string>;
}

interface SandboxSession {
  runCommand(name: string, args: string[]): Promise<SandboxCommandResult>;
  readFileToBuffer(input: { path: string }): Promise<Buffer | null>;
}
