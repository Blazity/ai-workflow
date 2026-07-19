import { randomUUID } from "node:crypto";
import { buildCloneUrl, buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import { getSandboxCredentials } from "./credentials.js";
import {
  parseVerifiedWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "./repo-workspace.js";
import type {
  PublicationAttemptRecord,
  PublicationRepositoryRecord,
} from "../publication/store.js";
import { stopSandboxAndConfirm } from "./stop-ticket-sandboxes.js";

export interface TrustedWorkspacePushRepositoryResult {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  branchName: string;
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
  durable: PublicationRepositoryRecord;
  result: TrustedWorkspacePushRepositoryResult;
  bundlePath?: string;
  bundle?: Buffer;
}

/**
 * Publication has two isolated trust domains:
 * - the agent/source sandbox may expose committed Git objects but never gets a
 *   VCS credential;
 * - a fresh publisher sandbox receives credentials and canonical provider
 *   coordinates, but never trusts source remotes/config/manifest files.
 */
export async function publishTrustedWorkspaceFromSandbox(input: {
  sourceSandboxId: string;
  publicationAttemptId: string;
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
  const { getDb } = await import("../db/client.js");
  const {
    getPublicationAttempt,
    recordPublicationRepositoryFailure,
    recordPublicationRepositoryPreflight,
    recordPublicationRepositoryPush,
  } = await import("../publication/store.js");

  const db = getDb();
  const attempt = await getPublicationAttempt(db, input.publicationAttemptId);
  if (!attempt) {
    throw new Error(`publication ledger attempt ${input.publicationAttemptId} is missing`);
  }
  if (attempt.runId !== input.runId) {
    throw new Error(
      `publication ledger attempt ${input.publicationAttemptId} belongs to ${attempt.runId}, not ${input.runId}`,
    );
  }
  const durableByKey = assertLedgerMatchesTrustedManifest(attempt, input.workspaceManifest);
  const source = await Sandbox.get({
    sandboxId: input.sourceSandboxId,
    ...getSandboxCredentials(),
  });
  const prepared: PreparedRepository[] = [];

  for (const repo of input.workspaceManifest.repositories) {
    const durable = durableByKey.get(repositoryKey(repo))!;
    const base = {
      provider: repo.provider,
      repoPath: repo.repoPath,
      branchName: repo.branchName,
      pushed: false,
    } as const;
    const failure = (result: Omit<TrustedWorkspacePushRepositoryResult, keyof typeof base>) => {
      prepared.push({ repo, durable, result: { ...base, ...result } });
    };

    if (!repo.expectedRemoteSha || !repo.preAgentSha) {
      failure({
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
    if (status.exitCode !== 0) {
      failure({
        changed: false,
        failureKind: "preflight_failed",
        error: `git status failed: ${await commandError(status)}`,
      });
      continue;
    }
    const dirty = (await status.stdout()).trim();
    if (dirty) {
      failure({
        changed: false,
        failureKind: "dirty_worktree",
        error: `workspace has uncommitted changes: ${dirty}`,
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
      failure({
        changed: false,
        failureKind: conflicts.exitCode === 0 ? "merge_conflict" : "preflight_failed",
        error: conflicts.exitCode === 0
          ? `workspace has unresolved merge conflicts: ${conflictPaths}`
          : `conflict check failed: ${await commandError(conflicts)}`,
      });
      continue;
    }

    const head = await source.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
    if (head.exitCode !== 0) {
      failure({
        changed: false,
        failureKind: "preflight_failed",
        error: `git rev-parse failed: ${await commandError(head)}`,
      });
      continue;
    }
    const targetHead = (await head.stdout()).trim();
    const ancestorFailure = await verifyAncestors(source, repo, targetHead);
    if (ancestorFailure) {
      failure({
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
    if (durable.targetHead && durable.targetHead !== targetHead) {
      failure({
        changed,
        expectedHead: providerHead,
        targetHead,
        failureKind: "preflight_failed",
        error: `source head ${targetHead} does not match durable target ${durable.targetHead}`,
      });
      continue;
    }
    if (durable.targetHead === targetHead && providerHead === targetHead) {
      prepared.push({
        repo,
        durable,
        result: {
          ...base,
          changed: durable.changed,
          expectedHead: durable.expectedHead ?? repo.expectedRemoteSha,
          targetHead,
          pushed: durable.changed,
          ...(durable.changed ? { pushedHead: targetHead } : {}),
        },
      });
      continue;
    }
    if (providerHead !== repo.expectedRemoteSha) {
      failure({
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
      durable,
      result: {
        ...base,
        changed,
        expectedHead: repo.expectedRemoteSha,
        targetHead,
      },
    });
  }

  for (const item of prepared) {
    await recordPublicationRepositoryPreflight(db, {
      attemptId: attempt.id,
      provider: item.repo.provider,
      repoPath: item.repo.repoPath,
      changed: item.result.changed,
      expectedHead: item.result.expectedHead ?? null,
      targetHead: item.result.targetHead ?? null,
      failure: item.result.error ?? null,
    });
  }
  if (prepared.some((item) => item.result.failureKind)) {
    return summarizeStepResult(prepared.map((item) => item.result));
  }

  const pending = prepared.filter((item) => item.result.changed && !item.result.pushed);
  for (const item of prepared.filter((candidate) => candidate.result.pushed)) {
    await recordPublicationRepositoryPush(db, {
      attemptId: attempt.id,
      provider: item.repo.provider,
      repoPath: item.repo.repoPath,
      pushedHead: item.result.pushedHead!,
    });
  }
  if (pending.length === 0) return summarizeStepResult(prepared.map((item) => item.result));

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
      const error = `git bundle failed: ${await commandError(bundle)}`;
      item.result = {
        ...item.result,
        failureKind: "preflight_failed",
        error,
      };
      await recordPublicationRepositoryFailure(db, {
        attemptId: attempt.id,
        provider: item.repo.provider,
        repoPath: item.repo.repoPath,
        failure: error,
      });
      continue;
    }
    const bytes = await source.readFileToBuffer({ path: bundlePath });
    if (!bytes) {
      const error = `git bundle is missing at ${bundlePath}`;
      item.result = {
        ...item.result,
        failureKind: "preflight_failed",
        error,
      };
      await recordPublicationRepositoryFailure(db, {
        attemptId: attempt.id,
        provider: item.repo.provider,
        repoPath: item.repo.repoPath,
        failure: error,
      });
      continue;
    }
    item.bundlePath = bundlePath;
    item.bundle = bytes;
  }
  if (pending.some((item) => item.result.failureKind)) {
    return summarizeStepResult(prepared.map((item) => item.result));
  }

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
    const sourceVcs = input.sourcePullRequest
      ? createRepositoryVcsRuntime({
          provider: input.sourcePullRequest.provider,
          repoPath: input.sourcePullRequest.repoPath,
          baseBranch: input.sourcePullRequest.baseRef,
        }).vcs
      : null;
    const reconciledSource = input.sourcePullRequest
      ? prepared.find(
          (item) =>
            item.result.pushed &&
            isSourcePullRequestRepository(input.sourcePullRequest!, item.repo),
        )
      : null;
    let expectedSourceHead =
      reconciledSource?.result.pushedHead ?? input.sourcePullRequest?.headSha;
    for (const [index, item] of pending.entries()) {
      const runtime = createRepositoryVcsRuntime({
        provider: item.repo.provider,
        repoPath: item.repo.repoPath,
        baseBranch: item.repo.defaultBranch,
      });
      const token = await runtime.getToken();
      const urls = buildVcsUrls({ ...runtime.config, repoPath: item.repo.repoPath });
      const cloneUrl = buildCloneUrl({
        host: runtime.config.host,
        repoPath: item.repo.repoPath,
      });
      const authArgs = gitAuthArgs(urls.authUser, token);
      const checkoutPath = `/vercel/sandbox/publisher/${index}`;
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
        await recordPublisherFailure(item, `canonical clone failed: ${await commandError(clone)}`);
        continue;
      }
      const clonedHead = await publisher.runCommand("git", [
        "-C",
        checkoutPath,
        "rev-parse",
        "HEAD",
      ]);
      const clonedSha = clonedHead.exitCode === 0 ? (await clonedHead.stdout()).trim() : "";
      if (clonedSha !== item.repo.expectedRemoteSha) {
        await recordPublisherFailure(
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
        await recordPublisherFailure(item, `bundle import failed: ${await commandError(fetchBundle)}`);
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
        await recordPublisherFailure(
          item,
          `bundle target is ${bundleSha || "unreadable"}, expected ${item.result.targetHead}`,
          "preflight_failed",
        );
        continue;
      }
      const bundleAncestor = await publisher.runCommand("git", [
        "-C",
        checkoutPath,
        "merge-base",
        "--is-ancestor",
        item.repo.expectedRemoteSha!,
        "FETCH_HEAD",
      ]);
      if (bundleAncestor.exitCode !== 0) {
        await recordPublisherFailure(item, "bundle target does not descend from trusted remote head");
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
        await recordPublisherFailure(item, `bundle checkout failed: ${await commandError(checkout)}`);
        continue;
      }
      // Registration is an idempotent exact-owner CAS. Reassert it at the
      // irreversible boundary: cancellation either closes the owner first and
      // this push never starts, or observes/stops this registered publisher and
      // waits for the running Workflow step to drain before releasing ownership.
      await runRegistry.registerSandbox(
        input.subjectKey,
        input.ownerToken,
        publisher.sandboxId,
        input.runId,
      );
      if (input.sourcePullRequest && sourceVcs && expectedSourceHead) {
        const expectedSource = {
          ...input.sourcePullRequest,
          headSha: expectedSourceHead,
        };
        assertOpenSourcePullRequest(
          expectedSource,
          await sourceVcs.getPRHead(input.sourcePullRequest.prId),
        );
      }
      const push = await publisher.runCommand("git", [
        "-C",
        checkoutPath,
        ...authArgs,
        "push",
        `--force-with-lease=refs/heads/${item.repo.branchName}:${item.repo.expectedRemoteSha}`,
        cloneUrl,
        `HEAD:refs/heads/${item.repo.branchName}`,
      ]);
      const providerHead = await runtime.vcs.getBranchSha(item.repo.branchName);
      if (providerHead !== item.result.targetHead) {
        const error = push.exitCode === 0
          ? `provider reported ${providerHead} after push, expected ${item.result.targetHead}`
          : await commandError(push);
        await recordPublisherFailure(
          item,
          error,
          isLeaseRejection(error) ? "lease_rejected" : "push_failed",
        );
        continue;
      }
      item.result = {
        ...item.result,
        pushed: true,
        pushedHead: item.result.targetHead,
      };
      await recordPublicationRepositoryPush(db, {
        attemptId: attempt.id,
        provider: item.repo.provider,
        repoPath: item.repo.repoPath,
        pushedHead: item.result.targetHead!,
      });
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

  return summarizeStepResult(prepared.map((item) => item.result));

  async function recordPublisherFailure(
    item: PreparedRepository,
    error: string,
    failureKind: TrustedWorkspacePushRepositoryResult["failureKind"] = "push_failed",
  ): Promise<void> {
    item.result = { ...item.result, pushed: false, failureKind, error };
    await recordPublicationRepositoryFailure(db, {
      attemptId: input.publicationAttemptId,
      provider: item.repo.provider,
      repoPath: item.repo.repoPath,
      failure: error,
    });
  }
}
// The step is replay-safe through the publication ledger, exact target-head
// checks, and force-with-lease. Let Workflow durably retry transient provider
// or publisher failures while the parent run still owns its source sandbox.
publishTrustedWorkspaceFromSandbox.maxRetries = 3;

function assertLedgerMatchesTrustedManifest(
  attempt: PublicationAttemptRecord,
  trusted: WorkspaceManifest,
): Map<string, PublicationRepositoryRecord> {
  try {
    parseVerifiedWorkspaceManifest(JSON.stringify(attempt.workspaceManifest), trusted);
  } catch {
    throw new Error(`publication ledger ${attempt.id} does not match trusted workspace manifest`);
  }
  if (attempt.repositories.length !== trusted.repositories.length) {
    throw new Error(`publication ledger ${attempt.id} does not match trusted workspace manifest cardinality`);
  }
  const durableByKey = new Map(
    attempt.repositories.map((repository) => [repositoryKey(repository), repository]),
  );
  if (durableByKey.size !== attempt.repositories.length) {
    throw new Error(`publication ledger ${attempt.id} contains duplicate repositories`);
  }
  for (const repo of trusted.repositories) {
    const durable = durableByKey.get(repositoryKey(repo));
    if (
      !durable ||
      durable.branchName !== repo.branchName ||
      durable.defaultBranch !== repo.defaultBranch
    ) {
      throw new Error(`publication ledger ${attempt.id} does not match trusted workspace manifest fields`);
    }
  }
  return durableByKey;
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

function repositoryKey(repo: { provider: string; repoPath: string }): string {
  return `${repo.provider}:${repo.repoPath}`;
}

function summarize(
  repositories: TrustedWorkspacePushRepositoryResult[],
): TrustedWorkspacePushResult {
  const failures = repositories.filter((repository) => repository.failureKind);
  if (failures.length > 0) {
    return {
      pushed: false,
      repositories,
      error: failures
        .map((repository) =>
          `${repository.provider}:${repository.repoPath}: ${repository.error ?? "publication failed"}`,
        )
        .join("\n"),
    };
  }
  if (!repositories.some((repository) => repository.changed)) {
    return {
      pushed: false,
      repositories,
      error: "Agent reported success but made no commits",
    };
  }
  const unpushed = repositories.filter((repository) => repository.changed && !repository.pushed);
  return unpushed.length === 0
    ? { pushed: true, repositories }
    : {
        pushed: false,
        repositories,
        error: unpushed
          .map((repository) =>
            `${repository.provider}:${repository.repoPath}: ${repository.error ?? "push failed"}`,
          )
          .join("\n"),
      };
}

function summarizeStepResult(
  repositories: TrustedWorkspacePushRepositoryResult[],
): TrustedWorkspacePushResult {
  const result = summarize(repositories);
  // Command/provider failures can be transient. Throwing keeps them inside the
  // durable step retry boundary; deterministic safety failures are returned so
  // the orchestration can terminally record them without pointless retries.
  if (
    !result.pushed &&
    result.repositories.some((repository) => repository.failureKind === "push_failed")
  ) {
    throw new Error(result.error ?? "transient workspace publication failure");
  }
  return result;
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
}
