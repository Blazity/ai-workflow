import type { ActiveRunOwner } from "../lib/active-run-owner.js";
import type { WorkflowRepositoryScope } from "@shared/contracts";
import { buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import {
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifestV2,
  type WorkspaceRepoV2,
} from "../sandbox/repo-workspace.js";
import type { ResearchRepository } from "../sandbox/agents/types.js";

interface CommandResult {
  exitCode: number;
  stdout(): Promise<string>;
  stderr?(): Promise<string>;
}

interface PromotionSandbox {
  runCommand(command: string, args: string[]): Promise<CommandResult>;
  writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<unknown>;
}

interface PromotionProvider {
  kind: "github" | "gitlab";
  host: string;
  getToken(): Promise<string>;
}

export interface RepositoryPromotionController {
  getResearchBranchSha(repository: WorkspaceRepoV2): Promise<string>;
  findOwnedBranch(
    repository: WorkspaceRepoV2,
  ): Promise<{ branchName: string; publishedHeadSha?: string } | null>;
  getBranchShaIfExists(
    repository: WorkspaceRepoV2,
    branchName: string,
  ): Promise<string | null>;
  createBranchIfMissing(
    repository: WorkspaceRepoV2,
    branchName: string,
    baseSha: string,
  ): Promise<"created" | "existing">;
  resetOwnedBranch(
    repository: WorkspaceRepoV2,
    branchName: string,
    baseSha: string,
  ): Promise<void>;
  recordOwnedBranch(
    repository: WorkspaceRepoV2,
    branchName: string,
  ): Promise<void>;
  assertRepositoryAllowed(repository: WorkspaceRepoV2): Promise<void>;
  getBranchSha(
    repository: WorkspaceRepoV2,
    branchName: string,
  ): Promise<string>;
}

export interface ResearchBranchMovedEvent {
  provider: "github" | "gitlab";
  repoPath: string;
  expected: string;
  actual: string;
}

export async function promoteRepositoryWriteScope(input: {
  sandbox: PromotionSandbox;
  manifest: WorkspaceManifestV2;
  writeRepositories: ResearchRepository[];
  branchName: string;
  controller: RepositoryPromotionController;
  providers: PromotionProvider[];
  onResearchBranchMoved?: (event: ResearchBranchMovedEvent) => void;
}): Promise<WorkspaceManifestV2> {
  const { randomUUID } = await import("node:crypto");
  if (input.writeRepositories.length === 0) {
    throw new Error("A completed implementation plan must declare at least one write repository");
  }
  const manifestByKey = new Map(
    input.manifest.repositories.map((repository) => [
      repositoryKey(repository),
      repository,
    ]),
  );
  const requested = new Map<string, WorkspaceRepoV2>();
  for (const write of input.writeRepositories) {
    const key = repositoryKey(write);
    if (requested.has(key)) {
      throw new Error(`Write repository ${write.provider}:${write.repoPath} is duplicated`);
    }
    const repository = manifestByKey.get(key);
    if (!repository) {
      throw new Error(
        `Write repository ${write.provider}:${write.repoPath} is not attached`,
      );
    }
    requested.set(key, repository);
  }

  const providers = new Map(
    input.providers.map((provider) => [provider.kind, provider]),
  );
  for (const repository of requested.values()) {
    if (!providers.has(repository.provider)) {
      throw new Error(
        `Sandbox provider is not configured: ${repository.provider}; identity resolution may have failed earlier, check logs for sandbox_provider_identity_resolution_failed`,
      );
    }
  }

  // Validate every read baseline before the first provider mutation. A changed
  // dependency can invalidate the plan even when that dependency stays read-only.
  for (const repository of input.manifest.repositories) {
    if (repository.access !== "read") continue;
    // Research agents run installs, builds, and tests inside read-only clones,
    // which leaves untracked files behind. Those never enter the publication
    // bundle (it exports commit ranges), so ignore untracked entries and fail
    // only on tracked modifications (staged or unstaged) or a moved HEAD.
    const status = await runGit(
      input.sandbox,
      repository,
      ["status", "--porcelain", "--untracked-files=no"],
    );
    if (status.trim()) {
      throw new Error(
        `Research repository ${repository.provider}:${repository.repoPath} is dirty`,
      );
    }
    const head = (
      await runGit(input.sandbox, repository, ["rev-parse", "HEAD"])
    ).trim();
    if (!repository.researchBaseSha || head !== repository.researchBaseSha) {
      throw new Error(
        `Research repository ${repository.provider}:${repository.repoPath} no longer matches its trusted baseline`,
      );
    }
    const researchSha = await input.controller.getResearchBranchSha(repository);
    if (researchSha !== repository.researchBaseSha) {
      // The default branch moved after research read it. The approved plan was
      // reviewed against researchBaseSha, and every write branch is cut from
      // that exact SHA below, so the remote movement is safe to proceed past.
      // Hand the move to the step, which owns logging, instead of failing the
      // run; this plain function stays free of Node-only imports (pino) so it
      // can be bundled into the workflow without leaking them across the
      // step boundary.
      input.onResearchBranchMoved?.({
        provider: repository.provider,
        repoPath: repository.repoPath,
        expected: repository.researchBaseSha,
        actual: researchSha,
      });
    }
  }

  const candidates: Array<{
    repository: WorkspaceRepoV2;
    owned: { branchName: string; publishedHeadSha?: string } | null;
    remoteSha: string | null;
    action: "reuse" | "create" | "reset";
    recordsNewOwnership: boolean;
  }> = [];
  const promoted = new Map<string, WorkspaceRepoV2>();
  for (const repository of requested.values()) {
    if (repository.access === "write") {
      promoted.set(repositoryKey(repository), repository);
      continue;
    }
    const owned = await input.controller.findOwnedBranch(repository);
    if (owned && owned.branchName !== input.branchName) {
      throw new Error(
        `Repository ${repository.provider}:${repository.repoPath} branch is not owned by this ticket`,
      );
    }
    if (
      repository.workflowOwnedBranch &&
      repository.workflowOwnedBranch.branchName !== input.branchName
    ) {
      throw new Error(
        `Repository ${repository.provider}:${repository.repoPath} manifest ownership does not match ${input.branchName}`,
      );
    }
    const remoteSha = await input.controller.getBranchShaIfExists(
      repository,
      input.branchName,
    );
    if (remoteSha && !owned) {
      throw new Error(
        `Repository ${repository.provider}:${repository.repoPath} branch ${input.branchName} is not owned by this ticket`,
      );
    }
    candidates.push({
      repository,
      owned,
      remoteSha,
      action: remoteSha
        ? repository.workflowOwnedBranch
          ? "reuse"
          : "reset"
        : "create",
      recordsNewOwnership: !owned,
    });
  }

  for (const candidate of candidates) {
    await input.controller.assertRepositoryAllowed(candidate.repository);
  }

  // Establish recoverable ownership for every new branch before the first
  // provider mutation. A durable replay can then reconcile partial provider
  // success without ever treating a foreign branch as owned.
  for (const candidate of candidates) {
    if (!candidate.recordsNewOwnership) continue;
    await input.controller.assertRepositoryAllowed(candidate.repository);
    await input.controller.recordOwnedBranch(
      candidate.repository,
      input.branchName,
    );
  }

  for (const candidate of candidates) {
    const { repository } = candidate;
    await input.controller.assertRepositoryAllowed(repository);
    if (candidate.action === "reset") {
      // Refuse to reset a branch whose remote head has diverged from the head we
      // last published: a human may have pushed since publication, and a force
      // reset would discard their work. The ledger's publishedHeadSha is the
      // trusted last-published head; only reset when the remote still matches it.
      if (
        candidate.owned?.publishedHeadSha &&
        candidate.remoteSha !== candidate.owned.publishedHeadSha
      ) {
        throw new Error(
          `Repository ${repository.provider}:${repository.repoPath} branch ${input.branchName} has diverged from its last published head; refusing to reset (a human may have pushed since publication)`,
        );
      }
      await input.controller.resetOwnedBranch(
        repository,
        input.branchName,
        repository.researchBaseSha!,
      );
    } else if (candidate.action === "create") {
      const created = await input.controller.createBranchIfMissing(
        repository,
        input.branchName,
        repository.researchBaseSha!,
      );
      if (created === "existing") {
        if (candidate.recordsNewOwnership) {
          // A concurrent run of the SAME ticket created this workflow-generated
          // branch in the tiny window after our pre-mutation probe found it
          // absent. Both runs upsert the same (ticketKey, provider, repoPath)
          // ledger row, so deleting it here would orphan the remote branch the
          // winning run legitimately owns and brick every later run of the
          // ticket. Keep the row and fail this run: the next run reconciles the
          // now-existing owned branch through the normal reuse path.
          throw new Error(
            `Repository ${repository.provider}:${repository.repoPath} branch ${input.branchName} was created by a concurrent promotion of the same ticket`,
          );
        }
        // The branch we already own was absent from the probe yet present at
        // create, so its head is whatever the other writer left there, not the
        // researchBaseSha the assignment below would assume. Publication leases
        // that SHA, so continuing only trades a wrong assumption for a rejected
        // push after the whole implementation phase. Fail now; the next run
        // sees the branch and reconciles it through the reuse path, which reads
        // the real head.
        throw new Error(
          `Repository ${repository.provider}:${repository.repoPath} branch ${input.branchName} reappeared after the ownership probe; its head is unknown`,
        );
      }
    }
    // Create and reset just wrote this branch at researchBaseSha, so that SHA is
    // already known. Re-reading the ref here made every promotion depend on the
    // provider serving a ref it had just accepted: GitHub's ref API can still
    // 404 for a second or two after createRef, and this step has no retries, so
    // a transient read killed otherwise healthy runs. Only the reuse path, which
    // targets a branch an earlier run published, has to ask the provider.
    const expectedRemoteSha =
      candidate.action === "reuse"
        ? await input.controller.getBranchSha(repository, input.branchName)
        : repository.researchBaseSha!;
    // The reuse path targets a branch an earlier run created, whose head can be
    // absent from this sandbox clone (it only carries the research checkout).
    // Fetch that branch, with credentials supplied inline so nothing persists,
    // before checkout. Create and reset target the research HEAD, which is
    // already present locally, so those paths stay fetch-free.
    let fetchConfig: PromotionFetch | undefined;
    if (candidate.action === "reuse") {
      const provider = providers.get(repository.provider)!;
      const token = await provider.getToken();
      const urls = buildVcsUrls({
        kind: provider.kind,
        host: provider.host,
        repoPath: repository.repoPath,
      });
      fetchConfig = {
        authArgs: gitAuthArgs(urls.authUser, token),
        cloneUrl: urls.cloneUrl,
        ref: input.branchName,
      };
    }
    await checkoutOwnedBranch({
      sandbox: input.sandbox,
      repository,
      branchName: input.branchName,
      expectedRemoteSha,
      fetch: fetchConfig,
    });
    const preAgentSha = (
      await runGit(input.sandbox, repository, ["rev-parse", "HEAD"])
    ).trim();
    if (preAgentSha !== expectedRemoteSha) {
      throw new Error(
        `Write repository ${repository.provider}:${repository.repoPath} checkout verification failed`,
      );
    }
    promoted.set(repositoryKey(repository), {
      ...repository,
      access: "write",
      branchName: input.branchName,
      expectedRemoteSha,
      preAgentSha,
      workflowOwnedBranch: { branchName: input.branchName },
    });
  }

  const manifest: WorkspaceManifestV2 = {
    version: 2,
    repositories: input.manifest.repositories.map(
      (repository) => promoted.get(repositoryKey(repository)) ?? repository,
    ),
  };
  const temporaryManifest = `${WORKSPACE_MANIFEST_PATH}.tmp-${randomUUID()}`;
  await input.sandbox.writeFiles([
    {
      path: temporaryManifest,
      content: Buffer.from(JSON.stringify(manifest, null, 2)),
    },
  ]);
  const replace = await input.sandbox.runCommand("mv", [
    temporaryManifest,
    WORKSPACE_MANIFEST_PATH,
  ]);
  if (replace.exitCode !== 0) {
    throw new Error(`Workspace manifest promotion failed: ${await commandError(replace)}`);
  }
  return manifest;
}

export async function promoteRepositoryWriteScopeStep(input: {
  sandboxId: string;
  manifest: WorkspaceManifestV2;
  writeRepositories: ResearchRepository[];
  branchName: string;
  ticketKey: string;
  owner: ActiveRunOwner;
  repositoryScope?: WorkflowRepositoryScope;
}): Promise<WorkspaceManifestV2> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { getDb } = await import("../db/client.js");
  const { assertActiveRunOwner } = await import("../lib/active-run-owner.js");
  const {
    listWorkflowOwnedBranchesForTicket,
    upsertWorkflowOwnedBranch,
  } = await import("../db/queries/workflow-owned-branches.js");
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const { buildSandboxProviderConfigs } = await import("../lib/vcs-runtime.js");
  const { logger } = await import("../lib/logger.js");
  const db = getDb();
  const owned = await listWorkflowOwnedBranchesForTicket(db, input.ticketKey);
  const adapterFor = (repository: WorkspaceRepoV2) =>
    createRepositoryVCS({
      provider: repository.provider,
      repoPath: repository.repoPath,
      baseBranch: repository.defaultBranch,
    });
  return promoteRepositoryWriteScope({
    sandbox: await Sandbox.get({
      sandboxId: input.sandboxId,
      ...getSandboxCredentials(),
    }),
    manifest: input.manifest,
    writeRepositories: input.writeRepositories,
    branchName: input.branchName,
    providers: await buildSandboxProviderConfigs(
      input.writeRepositories.map((repository) => repository.provider),
    ),
    onResearchBranchMoved: (event) =>
      logger.warn(event, "promotion_research_branch_moved"),
    controller: {
      getResearchBranchSha: (repository) =>
        adapterFor(repository).getBranchSha(repository.branchName),
      findOwnedBranch: async (repository) =>
        owned.find(
          (candidate) =>
            candidate.provider === repository.provider &&
            candidate.repoPath.toLowerCase() === repository.repoPath.toLowerCase(),
        ) ?? null,
      getBranchShaIfExists: (repository, branchName) =>
        adapterFor(repository).getBranchShaIfExists(branchName),
      createBranchIfMissing: async (repository, branchName, baseSha) => {
        await assertActiveRunOwner(db, input.owner);
        return adapterFor(repository).createBranchIfMissing(
          branchName,
          baseSha,
        );
      },
      resetOwnedBranch: async (repository, branchName, baseSha) => {
        await assertActiveRunOwner(db, input.owner);
        await adapterFor(repository).resetOwnedBranch(
          branchName,
          baseSha,
        );
      },
      recordOwnedBranch: async (repository, branchName) => {
        await assertActiveRunOwner(db, input.owner);
        await upsertWorkflowOwnedBranch(db, {
          ticketKey: input.ticketKey,
          provider: repository.provider,
          repoPath: repository.repoPath,
          branchName,
        });
      },
      assertRepositoryAllowed: async (repository) => {
        const { isRepoAllowedForScope } = await import("../lib/repo-allowlist.js");
        if (!isRepoAllowedForScope(repository, input.repositoryScope)) {
          throw new Error(
            `Refusing to promote ${repository.repoPath}: not in AGENT_ALLOWED_REPOS`,
          );
        }
        await assertActiveRunOwner(db, input.owner);
      },
      getBranchSha: (repository, branchName) =>
        adapterFor(repository).getBranchSha(branchName),
    },
  });
}
promoteRepositoryWriteScopeStep.maxRetries = 0;

interface PromotionFetch {
  authArgs: string[];
  cloneUrl: string;
  ref: string;
}

async function checkoutOwnedBranch(input: {
  sandbox: PromotionSandbox;
  repository: WorkspaceRepoV2;
  branchName: string;
  expectedRemoteSha: string;
  fetch?: PromotionFetch;
}): Promise<void> {
  if (input.fetch) {
    await requireCommand(
      await input.sandbox.runCommand("git", [
        "-C",
        input.repository.localPath,
        ...input.fetch.authArgs,
        "fetch",
        "--no-tags",
        input.fetch.cloneUrl,
        input.fetch.ref,
      ]),
      `git fetch failed for ${input.repository.provider}:${input.repository.repoPath}`,
    );
  }
  await requireCommand(
    await input.sandbox.runCommand("git", [
      "-C",
      input.repository.localPath,
      "checkout",
      "-B",
      input.branchName,
      input.expectedRemoteSha,
    ]),
    `git checkout failed for ${input.repository.provider}:${input.repository.repoPath}`,
  );
}

async function runGit(
  sandbox: PromotionSandbox,
  repository: WorkspaceRepoV2,
  args: string[],
): Promise<string> {
  const result = await sandbox.runCommand("git", [
    "-C",
    repository.localPath,
    ...args,
  ]);
  await requireCommand(
    result,
    `git ${args[0]} failed for ${repository.provider}:${repository.repoPath}`,
  );
  return result.stdout();
}

async function requireCommand(
  result: CommandResult,
  message: string,
): Promise<void> {
  if (result.exitCode === 0) return;
  throw new Error(`${message}: ${await commandError(result)}`);
}

async function commandError(result: CommandResult): Promise<string> {
  const stderr = result.stderr ? (await result.stderr()).trim() : "";
  const stdout = (await result.stdout()).trim();
  return stderr || stdout || "command failed";
}

function repositoryKey(repository: {
  provider: "github" | "gitlab";
  repoPath: string;
}): string {
  return `${repository.provider}:${repository.repoPath.toLowerCase()}`;
}
