import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import { buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import type { EngineCtx } from "../workflows/blocks/types.js";
import type { SelectedRepositoryPromptContext } from "./context.js";
import {
  configureRepositoryExcludes,
  installMemoryCommitHook,
  writeRepositoryExcludesFile,
} from "./git-excludes.js";
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

export interface ResearchMaterializationSandbox extends ResearchWorkspaceSandbox {
  readFileToBuffer(input: { path: string }): Promise<Buffer | null>;
}

export interface ResearchWorkspaceProvider {
  kind: "github" | "gitlab";
  host: string;
  getToken(): Promise<string>;
  commitAuthor: string;
  commitEmail: string;
}

export interface MaterializedResearchRepository {
  repository: WorkspaceRepositoryInput;
  archive: Buffer;
  cloneUrl: string;
  researchBaseSha: string;
  commitAuthor: string;
  commitEmail: string;
}

export async function attachResearchRepositories(input: {
  sandbox: ResearchWorkspaceSandbox;
  manifest: WorkspaceManifestV2;
  artifacts: MaterializedResearchRepository[];
}): Promise<WorkspaceManifestV2> {
  const { randomUUID } = await import("node:crypto");
  const existingKeys = new Set(
    input.manifest.repositories.map(repositoryKey),
  );
  const additions = input.artifacts.filter(
    ({ repository }) => !existingKeys.has(repositoryKey(repository)),
  );
  const existingArtifacts = input.artifacts.filter(({ repository }) =>
    existingKeys.has(repositoryKey(repository)),
  );
  for (const artifact of existingArtifacts) {
    const existing = input.manifest.repositories.find(
      (repository) =>
        repositoryKey(repository) === repositoryKey(artifact.repository),
    );
    if (!existing) throw new Error("Trusted repository manifest lookup failed");
    await verifyAttachedRepository(input.sandbox, existing, artifact);
  }
  if (additions.length === 0) return input.manifest;
  if (input.manifest.repositories.length + additions.length > 8) {
    throw new Error("A research workspace may contain at most 8 repositories");
  }
  await ensureWorkspaceDirectory(input.sandbox);
  // Written once for the whole batch instead of per checkout, so two attaches
  // running side by side never write the same file at the same time. Each
  // checkout is pointed at it in attachOne.
  await writeRepositoryExcludesFile(input.sandbox);

  const attached: WorkspaceRepoV2[] = [];
  try {
    for (let offset = 0; offset < additions.length; offset += 2) {
      const batch = additions.slice(offset, offset + 2);
      const results = await Promise.allSettled(
        batch.map((artifact) =>
          attachOne(input.sandbox, artifact),
        ),
      );
      attached.push(
        ...results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) throw failure.reason;
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

async function verifyAttachedRepository(
  sandbox: ResearchWorkspaceSandbox,
  repository: WorkspaceRepoV2,
  artifact: MaterializedResearchRepository,
): Promise<void> {
  await assertSafeWorkspacePath(sandbox, repository.localPath, true);
  const remote = await sandbox.runCommand("git", [
    "-C",
    repository.localPath,
    "remote",
    "get-url",
    "origin",
  ]);
  const remoteUrl = remote.exitCode === 0 ? (await remote.stdout()).trim() : "";
  const head = await sandbox.runCommand("git", [
    "-C",
    repository.localPath,
    "rev-parse",
    "HEAD",
  ]);
  const headSha = head.exitCode === 0 ? (await head.stdout()).trim() : "";
  if (
    remoteUrl !== artifact.cloneUrl ||
    headSha !== artifact.researchBaseSha ||
    headSha !== repository.researchBaseSha
  ) {
    throw new Error(
      `Existing repository attachment verification failed for ${repository.repoPath}`,
    );
  }
}

export async function materializeResearchRepositories(input: {
  sandbox: ResearchMaterializationSandbox;
  repositories: WorkspaceRepositoryInput[];
  providers: ResearchWorkspaceProvider[];
}): Promise<MaterializedResearchRepository[]> {
  const artifacts: MaterializedResearchRepository[] = [];
  for (let offset = 0; offset < input.repositories.length; offset += 2) {
    const batch = input.repositories.slice(offset, offset + 2);
    const results = await Promise.allSettled(
      batch.map((repository) =>
        materializeOne(input.sandbox, repository, input.providers),
      ),
    );
    artifacts.push(
      ...results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
  return artifacts;
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
  artifact: MaterializedResearchRepository,
): Promise<WorkspaceRepoV2> {
  const { randomUUID } = await import("node:crypto");
  const { repository } = artifact;
  const slug = buildProviderRepoSlug(
    repository.provider,
    repository.repoPath,
  );
  const localPath = `${WORKSPACE_REPOS_DIR}/${slug}`;
  // A pre-existing final path can only be a leftover from an attach that crashed
  // before the trusted manifest recorded it: repositories already in the manifest
  // take the verifyAttachedRepository reuse path and never reach attachOne. The
  // leftover holds server-created clone data only, so once its safety is validated
  // it is safe to clear and re-clone. removePath reuses assertSafeWorkspacePath, so
  // a symlink or unexpected nesting still hard-fails instead of being removed.
  await removePath(sandbox, localPath);
  const temporaryPath = `${WORKSPACE_REPOS_DIR}/.attach-${randomUUID()}`;
  const archivePath = `/tmp/aiw-attach-${randomUUID()}.tgz`;
  let moved = false;
  await assertSafeWorkspacePath(sandbox, temporaryPath, false);
  await sandbox.writeFiles([{ path: archivePath, content: artifact.archive }]);
  try {
    await requireCommand(
      await sandbox.runCommand("mkdir", [temporaryPath]),
      "repository attach directory creation failed",
    );
    await requireCommand(
      await sandbox.runCommand("tar", [
        "-xzf",
        archivePath,
        "-C",
        temporaryPath,
      ]),
      "repository archive extraction failed",
    );
    await assertSafeWorkspacePath(sandbox, temporaryPath, true);
    const remote = await sandbox.runCommand("git", [
      "-C",
      temporaryPath,
      "remote",
      "get-url",
      "origin",
    ]);
    const remoteUrl = remote.exitCode === 0 ? (await remote.stdout()).trim() : "";
    if (remoteUrl !== artifact.cloneUrl) {
      throw new Error(`Repository remote verification failed for ${repository.repoPath}`);
    }
    const head = await sandbox.runCommand("git", [
      "-C",
      temporaryPath,
      "rev-parse",
      "HEAD",
    ]);
    const researchBaseSha = head.exitCode === 0 ? (await head.stdout()).trim() : "";
    if (!researchBaseSha || researchBaseSha !== artifact.researchBaseSha) {
      throw new Error(`Repository HEAD verification failed for ${repository.repoPath}`);
    }
    const move = await sandbox.runCommand("mv", [temporaryPath, localPath]);
    if (move.exitCode !== 0) {
      throw new Error(`Repository attach failed: ${await commandError(move)}`);
    }
    moved = true;
    await assertSafeWorkspacePath(sandbox, localPath, true);
    // A promoted checkout gets the same memory guards as a provisioned one. Only
    // the /blazebot/memory/ pattern is load-bearing here: this checkout lives
    // under repos/, where /aiw-repos.json and /repos/ match nothing. Without it
    // the agent's memory document shows up as an untracked change and blocks
    // publication.
    await requireCommand(
      await configureRepositoryExcludes(sandbox, localPath),
      `git runtime excludes configuration failed for ${repository.repoPath}`,
    );
    // Best effort: installMemoryCommitHook returns {kind:"failed"} instead of
    // throwing, so a chmod or write failure no longer tears down the attach. This
    // module is reachable from workflow scope and must stay free of pino, so the
    // failure is not logged here; the publication gate stays authoritative.
    await installMemoryCommitHook(sandbox, localPath);
    // Mirror provisionMultiRepo so a checkout promoted to write commits under the
    // bot identity instead of failing with "Author identity unknown" or inventing
    // one. Same command shape as manager.ts, applied to the final checkout.
    await sandbox.runCommand("git", ["-C", localPath, "config", "user.name", artifact.commitAuthor]);
    await sandbox.runCommand("git", ["-C", localPath, "config", "user.email", artifact.commitEmail]);
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
    if (moved) await removePath(sandbox, localPath);
    throw error;
  } finally {
    await sandbox.runCommand("rm", ["-f", "--", archivePath]);
  }
}

async function materializeOne(
  sandbox: ResearchMaterializationSandbox,
  repository: WorkspaceRepositoryInput,
  providers: ResearchWorkspaceProvider[],
): Promise<MaterializedResearchRepository> {
  const { randomUUID } = await import("node:crypto");
  const provider = providers.find(
    (candidate) => candidate.kind === repository.provider,
  );
  if (!provider) {
    throw new Error(`Sandbox provider is not configured: ${repository.provider}`);
  }
  const temporaryPath = `/tmp/aiw-materialize-${randomUUID()}`;
  const archivePath = `${temporaryPath}.tgz`;
  const token = await provider.getToken();
  const urls = buildVcsUrls({
    kind: provider.kind,
    host: provider.host,
    repoPath: repository.repoPath,
  });
  try {
    await requireCommand(
      await sandbox.runCommand("git", [
        ...gitAuthArgs(urls.authUser, token),
        "clone",
        "--no-tags",
        "--single-branch",
        "--branch",
        repository.workflowOwnedBranch?.branchName ?? repository.defaultBranch,
        urls.cloneUrl,
        temporaryPath,
      ]),
      `git clone failed for ${repository.provider}:${repository.repoPath}`,
    );
    await requireCommand(
      await sandbox.runCommand("git", [
        "-C",
        temporaryPath,
        "remote",
        "set-url",
        "origin",
        urls.cloneUrl,
      ]),
      "git remote scrub failed",
    );
    const head = await sandbox.runCommand("git", [
      "-C",
      temporaryPath,
      "rev-parse",
      "HEAD",
    ]);
    await requireCommand(head, "repository HEAD verification failed");
    const researchBaseSha = (await head.stdout()).trim();
    await requireCommand(
      await sandbox.runCommand("tar", [
        "-czf",
        archivePath,
        "-C",
        temporaryPath,
        ".",
      ]),
      "repository archive creation failed",
    );
    const archive = await sandbox.readFileToBuffer({ path: archivePath });
    if (!archive) throw new Error(`Repository archive is missing for ${repository.repoPath}`);
    return {
      repository,
      archive,
      cloneUrl: urls.cloneUrl,
      researchBaseSha,
      commitAuthor: provider.commitAuthor,
      commitEmail: provider.commitEmail,
    };
  } finally {
    await sandbox.runCommand("rm", [
      "-rf",
      "--",
      temporaryPath,
      archivePath,
    ]);
  }
}

async function removePath(
  sandbox: ResearchWorkspaceSandbox,
  path: string,
): Promise<void> {
  const exists = await assertSafeWorkspacePath(sandbox, path, null);
  if (!exists) return;
  await sandbox.runCommand("rm", ["-rf", "--", path]);
}

async function assertSafeWorkspacePath(
  sandbox: ResearchWorkspaceSandbox,
  path: string,
  expectExisting: boolean | null,
): Promise<boolean> {
  if (
    !path.startsWith(`${WORKSPACE_REPOS_DIR}/`) ||
    path.slice(WORKSPACE_REPOS_DIR.length + 1).includes("/")
  ) {
    throw new Error(`Refusing path outside repository workspace: ${path}`);
  }
  await ensureWorkspaceDirectory(sandbox);
  const symlink = await sandbox.runCommand("test", ["-L", path]);
  if (symlink.exitCode === 0) {
    throw new Error(`Repository workspace path must not be a symlink: ${path}`);
  }
  const exists = await sandbox.runCommand("test", ["-e", path]);
  if (expectExisting === false) {
    if (exists.exitCode === 0) {
      throw new Error(`Unexpected repository path already exists: ${path}`);
    }
    return false;
  }
  if (expectExisting === null && exists.exitCode !== 0) return false;
  if (exists.exitCode !== 0) {
    throw new Error(`Expected repository workspace path is missing: ${path}`);
  }
  const realpath = await sandbox.runCommand("realpath", [path]);
  const resolved = realpath.exitCode === 0 ? (await realpath.stdout()).trim() : "";
  if (!resolved.startsWith(`${WORKSPACE_REPOS_DIR}/`)) {
    throw new Error(`Repository workspace path escaped its boundary: ${path}`);
  }
  return true;
}

async function ensureWorkspaceDirectory(
  sandbox: ResearchWorkspaceSandbox,
): Promise<void> {
  const parentSymlink = await sandbox.runCommand("test", [
    "-L",
    WORKSPACE_REPOS_DIR,
  ]);
  if (parentSymlink.exitCode === 0) {
    throw new Error("Repository workspace directory must not be a symlink");
  }
  const exists = await sandbox.runCommand("test", ["-e", WORKSPACE_REPOS_DIR]);
  if (exists.exitCode !== 0) {
    await requireCommand(
      await sandbox.runCommand("mkdir", [WORKSPACE_REPOS_DIR]),
      "repository workspace directory creation failed",
    );
  }
  const parentRealpath = await sandbox.runCommand("realpath", [
    WORKSPACE_REPOS_DIR,
  ]);
  const resolvedParent =
    parentRealpath.exitCode === 0 ? (await parentRealpath.stdout()).trim() : "";
  if (resolvedParent !== WORKSPACE_REPOS_DIR) {
    throw new Error("Repository workspace directory has an unexpected real path");
  }
}

async function requireCommand(
  result: SandboxCommandResult,
  message: string,
): Promise<void> {
  if (result.exitCode === 0) return;
  throw new Error(`${message}: ${await commandError(result)}`);
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
