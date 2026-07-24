import { randomUUID } from "node:crypto";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import { buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import type { EngineCtx } from "../workflows/blocks/types.js";
import type { SelectedRepositoryPromptContext } from "./context.js";
import {
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_REPOS_DIR,
  buildProviderRepoSlug,
  type WorkspaceManifestV2,
  type WorkspaceRepoV2,
  type WorkspaceRepositoryInput,
} from "./repo-workspace.js";

interface SandboxCommandResult {
  exitCode: number;
  stdout(): Promise<string>;
  stderr?(): Promise<string>;
}

export interface ResearchWorkspaceSandbox {
  runCommand(command: string, args: string[]): Promise<SandboxCommandResult>;
  writeFiles(
    files: Array<{ path: string; content: Buffer }>,
  ): Promise<unknown>;
}

export interface ResearchWorkspaceProvider {
  kind: "github" | "gitlab";
  host: string;
  getToken(): Promise<string>;
}

export async function attachResearchRepositories(input: {
  sandbox: ResearchWorkspaceSandbox;
  manifest: WorkspaceManifestV2;
  repositories: WorkspaceRepositoryInput[];
  providers: ResearchWorkspaceProvider[];
}): Promise<WorkspaceManifestV2> {
  const existingKeys = new Set(
    input.manifest.repositories.map(repositoryKey),
  );
  const additions = input.repositories.filter(
    (repository) => !existingKeys.has(repositoryKey(repository)),
  );
  if (additions.length === 0) return input.manifest;
  if (input.manifest.repositories.length + additions.length > 8) {
    throw new Error("A research workspace may contain at most 8 repositories");
  }

  const attached: WorkspaceRepoV2[] = [];
  try {
    for (let offset = 0; offset < additions.length; offset += 2) {
      const batch = additions.slice(offset, offset + 2);
      attached.push(
        ...(await Promise.all(
          batch.map((repository) =>
            attachOne(
              input.sandbox,
              repository,
              input.providers,
            ),
          ),
        )),
      );
    }
  } catch (error) {
    await Promise.all(
      attached.map((repository) =>
        removePath(input.sandbox, repository.localPath),
      ),
    );
    throw error;
  }

  const manifest: WorkspaceManifestV2 = {
    version: 2,
    repositories: [...input.manifest.repositories, ...attached],
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
    await Promise.all(
      attached.map((repository) =>
        removePath(input.sandbox, repository.localPath),
      ),
    );
    throw new Error(`Workspace manifest update failed: ${await commandError(replace)}`);
  }
  return manifest;
}

export function promoteAgentSandboxToWorkspace(
  ctx: Pick<
    EngineCtx,
    | "agentSandboxIds"
    | "sandboxIds"
    | "sandboxId"
    | "workspaceManifest"
    | "selectedRepositories"
    | "repositoryContexts"
  >,
  sandboxId: string,
  state: {
    manifest: WorkspaceManifestV2;
    repositories: WorkspaceRepositoryInput[];
    repositoryContexts: SelectedRepositoryPromptContext[];
  },
): void {
  for (const [key, value] of Object.entries(ctx.agentSandboxIds)) {
    if (value === sandboxId) delete ctx.agentSandboxIds[key];
  }
  ctx.sandboxIds.add(sandboxId);
  ctx.sandboxId = sandboxId;
  ctx.workspaceManifest = state.manifest;
  ctx.selectedRepositories = state.repositories;
  ctx.repositoryContexts = state.repositoryContexts;
}

async function attachOne(
  sandbox: ResearchWorkspaceSandbox,
  repository: WorkspaceRepositoryInput,
  providers: ResearchWorkspaceProvider[],
): Promise<WorkspaceRepoV2> {
  const provider = providers.find(
    (candidate) => candidate.kind === repository.provider,
  );
  if (!provider) {
    throw new Error(`Sandbox provider is not configured: ${repository.provider}`);
  }
  const slug = buildProviderRepoSlug(
    repository.provider,
    repository.repoPath,
  );
  const localPath = `${WORKSPACE_REPOS_DIR}/${slug}`;
  const exists = await sandbox.runCommand("test", ["-e", localPath]);
  if (exists.exitCode === 0) {
    throw new Error(`Unexpected repository path already exists: ${localPath}`);
  }

  const temporaryPath = `${WORKSPACE_REPOS_DIR}/.attach-${randomUUID()}`;
  const token = await provider.getToken();
  const urls = buildVcsUrls({
    kind: provider.kind,
    host: provider.host,
    repoPath: repository.repoPath,
  });
  const clone = await sandbox.runCommand("git", [
    ...gitAuthArgs(urls.authUser, token),
    "clone",
    "--no-tags",
    "--single-branch",
    "--branch",
    repository.defaultBranch,
    urls.cloneUrl,
    temporaryPath,
  ]);
  if (clone.exitCode !== 0) {
    await removePath(sandbox, temporaryPath);
    throw new Error(
      `git clone failed for ${repository.provider}:${repository.repoPath}: ${await commandError(clone)}`,
    );
  }
  try {
    const scrub = await sandbox.runCommand("git", [
      "-C",
      temporaryPath,
      "remote",
      "set-url",
      "origin",
      urls.cloneUrl,
    ]);
    if (scrub.exitCode !== 0) {
      throw new Error(`git remote scrub failed: ${await commandError(scrub)}`);
    }
    const remote = await sandbox.runCommand("git", [
      "-C",
      temporaryPath,
      "remote",
      "get-url",
      "origin",
    ]);
    const remoteUrl = remote.exitCode === 0 ? (await remote.stdout()).trim() : "";
    if (remoteUrl !== urls.cloneUrl) {
      throw new Error(`Repository remote verification failed for ${repository.repoPath}`);
    }
    const head = await sandbox.runCommand("git", [
      "-C",
      temporaryPath,
      "rev-parse",
      "HEAD",
    ]);
    const researchBaseSha =
      head.exitCode === 0 ? (await head.stdout()).trim() : "";
    if (!researchBaseSha) {
      throw new Error(`Repository HEAD verification failed for ${repository.repoPath}`);
    }
    const move = await sandbox.runCommand("mv", [temporaryPath, localPath]);
    if (move.exitCode !== 0) {
      throw new Error(`Repository attach failed: ${await commandError(move)}`);
    }
    return {
      provider: repository.provider,
      repoPath: repository.repoPath,
      slug,
      localPath,
      defaultBranch: repository.defaultBranch,
      branchName: repository.defaultBranch,
      selectedRationale: repository.selectedRationale,
      access: "read",
      researchBaseSha,
      ...(repository.workflowOwnedBranch
        ? { workflowOwnedBranch: repository.workflowOwnedBranch }
        : {}),
    };
  } catch (error) {
    await removePath(sandbox, temporaryPath);
    throw error;
  }
}

async function removePath(
  sandbox: ResearchWorkspaceSandbox,
  path: string,
): Promise<void> {
  if (!path.startsWith(`${WORKSPACE_REPOS_DIR}/`)) {
    throw new Error(`Refusing to remove path outside repository workspace: ${path}`);
  }
  await sandbox.runCommand("rm", ["-rf", "--", path]);
}

function repositoryKey(
  repository: Pick<SelectedRepository, "provider" | "repoPath">,
): string {
  return `${repository.provider}:${repository.repoPath.toLowerCase()}`;
}

async function commandError(result: SandboxCommandResult): Promise<string> {
  const stderr = result.stderr ? (await result.stderr()).trim() : "";
  const stdout = (await result.stdout()).trim();
  return stderr || stdout || "command failed";
}
