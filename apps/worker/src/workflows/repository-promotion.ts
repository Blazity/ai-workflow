import { randomUUID } from "node:crypto";
import type { ActiveRunOwner } from "../lib/active-run-owner.js";
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
  ): Promise<{ branchName: string } | null>;
  createBranchIfMissing(
    repository: WorkspaceRepoV2,
    branchName: string,
  ): Promise<"created" | "existing">;
  resetOwnedBranch(
    repository: WorkspaceRepoV2,
    branchName: string,
  ): Promise<void>;
  recordOwnedBranch(
    repository: WorkspaceRepoV2,
    branchName: string,
  ): Promise<void>;
  getBranchSha(
    repository: WorkspaceRepoV2,
    branchName: string,
  ): Promise<string>;
}

export async function promoteRepositoryWriteScope(input: {
  sandbox: PromotionSandbox;
  manifest: WorkspaceManifestV2;
  writeRepositories: ResearchRepository[];
  branchName: string;
  controller: RepositoryPromotionController;
  providers: PromotionProvider[];
}): Promise<WorkspaceManifestV2> {
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
      throw new Error(`Sandbox provider is not configured: ${repository.provider}`);
    }
  }

  // Validate every read baseline before the first provider mutation. A changed
  // dependency can invalidate the plan even when that dependency stays read-only.
  for (const repository of input.manifest.repositories) {
    if (repository.access !== "read") continue;
    const status = await runGit(
      input.sandbox,
      repository,
      ["status", "--porcelain"],
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
      throw new Error(
        `Research repository ${repository.provider}:${repository.repoPath} research branch moved`,
      );
    }
  }

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
    if (owned && !repository.workflowOwnedBranch) {
      await input.controller.resetOwnedBranch(repository, input.branchName);
    } else {
      const created = await input.controller.createBranchIfMissing(
        repository,
        input.branchName,
      );
      if (created === "existing") {
        throw new Error(
          `Repository ${repository.provider}:${repository.repoPath} branch ${input.branchName} is not owned by this ticket`,
        );
      }
      await input.controller.recordOwnedBranch(repository, input.branchName);
    }
    const expectedRemoteSha = await input.controller.getBranchSha(
      repository,
      input.branchName,
    );
    await checkoutOwnedBranch({
      sandbox: input.sandbox,
      repository,
      branchName: input.branchName,
      provider: providers.get(repository.provider)!,
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
    controller: {
      getResearchBranchSha: (repository) =>
        adapterFor(repository).getBranchSha(repository.branchName),
      findOwnedBranch: async (repository) =>
        owned.find(
          (candidate) =>
            candidate.provider === repository.provider &&
            candidate.repoPath.toLowerCase() === repository.repoPath.toLowerCase(),
        ) ?? null,
      createBranchIfMissing: async (repository, branchName) => {
        await assertActiveRunOwner(db, input.owner);
        return adapterFor(repository).createBranchIfMissing(
          branchName,
          repository.defaultBranch,
        );
      },
      resetOwnedBranch: async (repository, branchName) => {
        await assertActiveRunOwner(db, input.owner);
        await adapterFor(repository).resetOwnedBranch(
          branchName,
          repository.defaultBranch,
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
      getBranchSha: (repository, branchName) =>
        adapterFor(repository).getBranchSha(branchName),
    },
  });
}
promoteRepositoryWriteScopeStep.maxRetries = 0;

async function checkoutOwnedBranch(input: {
  sandbox: PromotionSandbox;
  repository: WorkspaceRepoV2;
  branchName: string;
  provider: PromotionProvider;
}): Promise<void> {
  const token = await input.provider.getToken();
  const urls = buildVcsUrls({
    kind: input.provider.kind,
    host: input.provider.host,
    repoPath: input.repository.repoPath,
  });
  await requireCommand(
    await input.sandbox.runCommand("git", [
      "-C",
      input.repository.localPath,
      ...gitAuthArgs(urls.authUser, token),
      "fetch",
      "--no-tags",
      "origin",
      `refs/heads/${input.branchName}`,
    ]),
    `git fetch failed for ${input.repository.provider}:${input.repository.repoPath}`,
  );
  await requireCommand(
    await input.sandbox.runCommand("git", [
      "-C",
      input.repository.localPath,
      "checkout",
      "-B",
      input.branchName,
      "FETCH_HEAD",
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
