import { randomUUID } from "node:crypto";
import type { WorkflowRepositoryScope } from "@shared/contracts";
import type { RepositoryVcsRuntime } from "../lib/vcs-runtime.js";
import { buildCloneUrl, buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import { getSandboxCredentials } from "./credentials.js";
import {
  workspaceRepositoryAccess,
  type WorkspaceManifest,
  type WorkspaceRepo,
  type WorkspaceRepoV2,
} from "./repo-workspace.js";
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
    | "read_only_changed"
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
  repositoryScope?: WorkflowRepositoryScope;
  sourcePullRequest?: import("../workflows/source-pull-request.js").SourcePullRequestIdentity;
}): Promise<TrustedWorkspacePushResult> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { env } = await import("../../env.js");
  const { createRepositoryVcsRuntime } = await import("../lib/vcs-runtime.js");
  const { isRepoAllowedForScope } = await import("../lib/repo-allowlist.js");
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

    if (workspaceRepositoryAccess(input.workspaceManifest, repo) === "read") {
      const researchBaseSha = (repo as WorkspaceRepoV2).researchBaseSha;
      if (!researchBaseSha) {
        fail({
          changed: false,
          failureKind: "preflight_failed",
          error: "read-only repository is missing its research baseline",
        });
        continue;
      }
      // Research agents leave untracked build/test artifacts in read-only
      // clones. They cannot enter the publication bundle (it exports commit
      // ranges), so ignore untracked entries here and fail only on tracked
      // modifications or a moved HEAD. The write-repository check below applies
      // the same tolerance for the same reason.
      const status = await source.runCommand("git", [
        "-C",
        repo.localPath,
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ]);
      const dirty = status.exitCode === 0 ? (await status.stdout()).trim() : "";
      const head = await source.runCommand("git", [
        "-C",
        repo.localPath,
        "rev-parse",
        "HEAD",
      ]);
      const targetHead = head.exitCode === 0 ? (await head.stdout()).trim() : "";
      const changed =
        status.exitCode === 0 &&
        head.exitCode === 0 &&
        (dirty.length > 0 || targetHead !== researchBaseSha);
      if (status.exitCode !== 0 || head.exitCode !== 0 || changed) {
        fail({
          changed,
          ...(targetHead ? { targetHead } : {}),
          failureKind:
            status.exitCode === 0 && head.exitCode === 0
              ? "read_only_changed"
              : "preflight_failed",
          error:
            status.exitCode !== 0
              ? `git status failed: ${await commandError(status)}`
              : head.exitCode !== 0
                ? `git rev-parse failed: ${await commandError(head)}`
                : `read-only repository changed from ${researchBaseSha} to ${targetHead}`,
        });
      } else {
        prepared.push({
          repo,
          result: {
            ...base,
            changed: false,
            expectedHead: researchBaseSha,
            targetHead,
            pushed: false,
          },
        });
      }
      continue;
    }

    if (!repo.expectedRemoteSha || !repo.preAgentSha) {
      fail({
        changed: false,
        failureKind: "preflight_failed",
        error: "trusted workspace manifest is missing remote or pre-agent baseline",
      });
      continue;
    }
    if (!isRepoAllowedForScope(repo, input.repositoryScope)) {
      fail({
        changed: false,
        failureKind: "preflight_failed",
        error: `Refusing to publish ${repo.repoPath}: not in AGENT_ALLOWED_REPOS`,
      });
      continue;
    }

    // Agent phases (research and implementation) run inside the write checkout
    // and leave untracked scratch behind, e.g. a session-memory file the agent
    // did not commit. Publication ships a commit bundle (HEAD ^expectedRemoteSha),
    // so untracked files physically cannot enter the PR; ignore them and fail
    // only on tracked modifications or deletions, which are real work that would
    // be lost if not committed.
    const status = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
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
    const memoryFailure = await verifyPublishedMemoryScope(
      source,
      repo,
      repo.expectedRemoteSha,
      targetHead,
      runtime,
    );
    if (memoryFailure) {
      fail({
        changed: targetHead !== repo.preAgentSha,
        targetHead,
        failureKind: "preflight_failed",
        error: memoryFailure,
      });
      continue;
    }

    const providerHead = await readBranchShaAfterWrite(runtime.vcs, repo.branchName);
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

    // The allowlist is an authorization boundary and may change while an
    // agent or clarification is running. Recheck the entire write set after
    // all expensive preflight work and immediately before the first push.
    for (const item of pending) {
      if (!isRepoAllowedForScope(item.repo, input.repositoryScope)) {
        failPrepared(
          item,
          `Refusing to publish ${item.repo.repoPath}: not in AGENT_ALLOWED_REPOS`,
          "preflight_failed",
        );
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
      if (!isRepoAllowedForScope(item.repo, input.repositoryScope)) {
        failPrepared(
          item,
          `Refusing to publish ${item.repo.repoPath}: not in AGENT_ALLOWED_REPOS`,
          "preflight_failed",
        );
        continue;
      }
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
      const providerHead = await readBranchShaAfterWrite(runtime.vcs, item.repo.branchName);
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

const BRANCH_SHA_RETRY_DELAYS_MS = [1000, 2000];

/**
 * Reads a branch head this run has already written: promotion created the owned
 * branch, and the verification reads run milliseconds after the push that moved
 * it. The provider ref API can still answer 404 for a ref it just accepted, and
 * no caller treats absence as an answer, so a transient 404 threw the whole step
 * and burned a retry (a publication retry redoes the sandbox, clone and bundle
 * import) on a branch that demonstrably exists. Retry only that, and only
 * briefly. Every other error propagates on the first attempt, and a 404 that
 * survives the retries is rethrown exactly as the provider raised it. Exported
 * for the finalized-branch verification in workspace-publication.ts, which reads
 * the same ref this module has just pushed.
 */
export async function readBranchShaAfterWrite(
  vcs: { getBranchSha(branch: string): Promise<string> },
  branchName: string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await vcs.getBranchSha(branchName);
    } catch (error) {
      if (attempt >= BRANCH_SHA_RETRY_DELAYS_MS.length || !isRefNotFound(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, BRANCH_SHA_RETRY_DELAYS_MS[attempt]!));
    }
  }
}

/**
 * GitHub raises an Octokit error carrying the status; GitLab reclassifies a 404
 * into a FatalError that keeps only the message, so match the text as well.
 */
function isRefNotFound(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { status?: unknown; response?: { status?: unknown } };
    if (candidate.status === 404 || candidate.response?.status === 404) return true;
  }
  return /\b404\b|not found/i.test(error instanceof Error ? error.message : String(error));
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

/**
 * The authoritative guard for the platform-managed memory document. Runtime
 * excludes hide it from `git status` and the per-checkout pre-commit hook rejects
 * a forced staging, but neither survives `git commit --no-verify`, a
 * repository-owned core.hooksPath, or a deleted hook. This gate lives on the
 * publication boundary, which no agent controls: the published commit range may
 * only touch a memory path that is already public, so legacy committed documents
 * keep publishing their modifications and deletions exactly as before.
 *
 * "Already public" is judged first against the recorded baseSha, then, only if
 * the path is absent there, against a fresh fetch of the repository default
 * branch. baseSha is the remote head captured before the local base merge, so a
 * document merged in from the base branch looks added against it yet is already
 * published; the default-branch fallback separates that leak-neutral case from a
 * document the agent actually created. Happy path cost is two enumerations that
 * return nothing, no per-path probe, and no fetch.
 */
async function verifyPublishedMemoryScope(
  source: SandboxSession,
  repo: WorkspaceRepo,
  baseSha: string,
  targetHead: string,
  runtime: RepositoryVcsRuntime,
): Promise<string | null> {
  if (baseSha === targetHead) return null;
  const range = `${baseSha}..${targetHead}`;
  // Two enumerations, because neither is complete on its own: the tree diff misses
  // a path added and then deleted inside the range, whose blob still ships in the
  // published commits, and the added-path log skips the diff of a merge commit.
  const enumerations: string[] = [];
  for (const args of [
    ["diff", "--name-only", range, "--", "blazebot/memory/"],
    [
      "log",
      "--diff-filter=A",
      "--name-only",
      "--pretty=format:",
      range,
      "--",
      "blazebot/memory/",
    ],
  ]) {
    const listed = await source.runCommand("git", ["-C", repo.localPath, ...args]);
    if (listed.exitCode !== 0) {
      return `memory publication check failed: ${await commandError(listed)}`;
    }
    enumerations.push(await listed.stdout());
  }
  const paths = [
    ...new Set(
      enumerations.flatMap((output) =>
        output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    ),
  ];
  // The recorded baseSha predates the local base merge, so a memory path it does
  // not track may still be public on the repository default branch (e.g. carried
  // in by merging the base branch). Resolve that branch tip once, lazily, and
  // only when a path is missing from baseSha; the happy path performs no fetch. A
  // resolved failure is memoized as null so a second missing path never
  // re-fetches, and every fetch/probe error fails closed.
  let baseTipResolved = false;
  let baseTip: string | null = null;
  const resolveBaseBranchTip = async (): Promise<string | null> => {
    if (baseTipResolved) return baseTip;
    baseTipResolved = true;
    const token = await runtime.getToken();
    const { authUser } = buildVcsUrls({ ...runtime.config, repoPath: repo.repoPath });
    const cloneUrl = buildCloneUrl({ host: runtime.config.host, repoPath: repo.repoPath });
    const fetched = await source.runCommand("git", [
      "-C",
      repo.localPath,
      ...gitAuthArgs(authUser, token),
      "fetch",
      "--no-tags",
      cloneUrl,
      repo.defaultBranch,
    ]);
    if (fetched.exitCode !== 0) return baseTip;
    const tip = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "rev-parse",
      "FETCH_HEAD",
    ]);
    if (tip.exitCode !== 0) return baseTip;
    const sha = (await tip.stdout()).trim();
    baseTip = sha.length > 0 ? sha : null;
    return baseTip;
  };

  for (const path of paths) {
    const tracked = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "ls-tree",
      "--name-only",
      baseSha,
      "--",
      path,
    ]);
    if (tracked.exitCode !== 0) {
      return `memory publication check failed for ${path}: ${await commandError(tracked)}`;
    }
    if ((await tracked.stdout()).trim().length > 0) continue;

    // Missing from the recorded pre-merge baseline. Confirm against a fresh,
    // authenticated default-branch tip before rejecting: present there means the
    // document is already public (leak-neutral); absent means the agent created
    // it. A tip that cannot be resolved is a hard, fail-closed error.
    const baseBranchTip = await resolveBaseBranchTip();
    if (baseBranchTip === null) {
      return `memory publication check failed: unable to verify ${repo.defaultBranch} for ${path}`;
    }
    const onBaseBranch = await source.runCommand("git", [
      "-C",
      repo.localPath,
      "ls-tree",
      "--name-only",
      baseBranchTip,
      "--",
      path,
    ]);
    if (onBaseBranch.exitCode !== 0) {
      return `memory publication check failed for ${path}: ${await commandError(onBaseBranch)}`;
    }
    if ((await onBaseBranch.stdout()).trim().length > 0) continue;

    return `blazebot/memory is platform-managed and must not be published: ${path} was added in ${range}`;
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
