import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "./credentials.js";
import type { AgentAdapter, ConfigureOpts } from "./agents/types.js";
import {
  configureRepositoryExcludes,
  installMemoryCommitHook,
  writeRepositoryExcludesFile,
} from "./git-excludes.js";
import {
  buildWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_REPOS_DIR,
  type WorkspaceManifest,
  type WorkspaceRepo,
  type WorkspaceRepositoryInput,
} from "./repo-workspace.js";
import type { VcsProviderKind } from "../../env.js";
import { isActiveRunOwnerError } from "../lib/run-control-errors.js";
import { buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";
import { stopSandboxAndConfirm } from "./stop-ticket-sandboxes.js";
import { isAgentRuntimeError } from "./agents/protocol.js";
import type { ResolvedHarnessRuntime } from "./harness-runtime.js";

export interface SandboxProviderConfig {
  kind: "github" | "gitlab";
  /** Resolves a fresh, short-lived token at the moment of use. */
  getToken: () => Promise<string>;
  host: string;
  commitAuthor: string;
  commitEmail: string;
}

export interface SandboxConfig {
  providers: SandboxProviderConfig[];
  jobTimeoutMs: number;
}

export interface SandboxLifecycle {
  /** Called immediately after the external sandbox exists, before any setup. */
  onCreated?: (sandboxId: string) => Promise<void>;
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provisionMultiRepo(
    input: {
      branchName: string;
      repositories: WorkspaceRepositoryInput[];
      access?: "read" | "write";
    },
    agent: AgentAdapter | null,
    configureOpts: ConfigureOpts | null,
    additionalAgents: ReadonlyArray<{
      agent: AgentAdapter;
      configureOpts: ConfigureOpts;
      runtime?: ResolvedHarnessRuntime;
    }> = [],
    lifecycle: SandboxLifecycle = {},
    primaryRuntime?: ResolvedHarnessRuntime,
  ): Promise<{ sandbox: SandboxInstance; workspaceManifest: WorkspaceManifest }> {
    if (input.repositories.length === 0) {
      throw new Error("Cannot provision sandbox without selected repositories");
    }

    const { Sandbox } = await import("@vercel/sandbox");
    const manifest = buildWorkspaceManifest({
      branchName: input.branchName,
      repositories: input.repositories,
      access: input.access,
    });
    const firstRepo = manifest.repositories[0];
    const firstProvider = this.providerFor(firstRepo.provider);
    const firstToken = await firstProvider.getToken();
    const providerTokens = new Map<VcsProviderKind, string>([[firstProvider.kind, firstToken]]);
    const tokenFor = async (provider: SandboxProviderConfig) => {
      let token = providerTokens.get(provider.kind);
      if (!token) {
        token = await provider.getToken();
        providerTokens.set(provider.kind, token);
      }
      return token;
    };
    const firstUrls = buildVcsUrls({ ...firstProvider, repoPath: firstRepo.repoPath });

    let sandbox: SandboxInstance | null = null;
    try {
      sandbox = await Sandbox.create({
        ...getSandboxCredentials(),
        source: {
          type: "git",
          url: firstUrls.cloneUrl,
          username: firstUrls.authUser,
          password: firstToken,
          revision: firstRepo.branchName,
        },
        runtime: "node24",
        timeout: this.config.jobTimeoutMs,
      });

      await lifecycle.onCreated?.(sandbox.sandboxId);

      // Keep the sandbox-owned manifest, the nested secondary checkouts, and the
      // agent's memory document out of every worktree status without adding
      // repository-owned .gitignore entries. The file is written once; each
      // checkout is pointed at it as it is created. Every secondary checkout is
      // still preflighted independently before publication.
      await writeRepositoryExcludesFile(sandbox);

      await sandbox.runCommand("mkdir", ["-p", WORKSPACE_REPOS_DIR]);

      for (const [index, repo] of manifest.repositories.entries()) {
        const provider = index === 0 ? firstProvider : this.providerFor(repo.provider);
        const token = await tokenFor(provider);
        const urls = index === 0
          ? firstUrls
          : buildVcsUrls({ ...provider, repoPath: repo.repoPath });
        if (index > 0) {
          await requireCommand(
            await sandbox.runCommand("git", [
              ...gitAuthArgs(urls.authUser, token),
              "clone",
              "--branch",
              repo.branchName,
              urls.cloneUrl,
              repo.localPath,
            ]),
            `git clone failed for ${repo.provider}:${repo.repoPath}`,
          );
        } else {
          await requireCommand(
            await sandbox.runCommand("git", ["-C", repo.localPath, "checkout", "-B", repo.branchName]),
            `git checkout failed for ${repo.provider}:${repo.repoPath}`,
          );
        }
        await requireCommand(
          await configureRepositoryExcludes(sandbox, repo.localPath),
          `git runtime excludes configuration failed for ${repo.provider}:${repo.repoPath}`,
        );
        const commitHook = await installMemoryCommitHook(sandbox, repo.localPath);
        if (commitHook.kind !== "installed") {
          const { logger } = await import("../lib/logger.js");
          const base = { repoPath: repo.repoPath, localPath: repo.localPath };
          if (commitHook.kind === "failed") {
            logger.warn(
              { ...base, reason: commitHook.reason },
              "memory_commit_hook_install_failed",
            );
          } else if (commitHook.kind === "shadowed") {
            logger.info(
              { ...base, hooksPath: commitHook.hooksPath },
              "memory_commit_hook_shadowed_by_hooks_path",
            );
          } else {
            logger.info(base, "memory_commit_hook_skipped_existing");
          }
        }
        await sandbox.runCommand("git", ["-C", repo.localPath, "remote", "set-url", "origin", urls.cloneUrl]);
        await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.name", provider.commitAuthor]);
        await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.email", provider.commitEmail]);

        const remoteBaseline = await requireCommand(
          await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]),
          `git rev-parse remote baseline failed for ${repo.provider}:${repo.repoPath}`,
        );
        repo.expectedRemoteSha = (await remoteBaseline.stdout()).trim();

        // An approved implementation run must execute against the exact baseline
        // the plan was approved on. The scope step verified this branch's SHA via
        // the provider API before this clone, but a merge can land on the branch in
        // the window between that check and the clone (the scope step's result is
        // memoized and replayed). Reject that drift here, before any manifest state
        // is recorded as trusted. This remote head is the checked-out branch's
        // clone-time head before the local base merge: for a read checkout it equals
        // preAgentSha, and for a write owned-branch checkout it is the owned-branch
        // baseline the approved scope pins.
        const expectedBaseline = input.repositories[index]?.expectedResearchBaseSha;
        if (expectedBaseline && repo.expectedRemoteSha !== expectedBaseline) {
          throw new Error(
            `Approved repository ${repo.provider}:${repo.repoPath} moved after research; replan required`,
          );
        }

        if (repo.mergeBase && repo.access !== "read") {
          await sandbox.runCommand("git", [
            "-C",
            repo.localPath,
            ...gitAuthArgs(urls.authUser, token),
            "fetch",
            urls.cloneUrl,
            repo.mergeBase,
          ]);
          await sandbox.runCommand("git", ["-C", repo.localPath, "branch", "-f", repo.mergeBase, "FETCH_HEAD"]);
          const merge = await sandbox.runCommand("git", ["-C", repo.localPath, "merge", "FETCH_HEAD", "--no-edit"]);
          if (merge.exitCode !== 0) {
            const stdout = (await merge.stdout()).trim();
            const stderr = (await merge.stderr()).trim();
            const out = stderr || stdout;
            const { logger } = await import("../lib/logger.js");
            logger.warn({ repoPath: repo.repoPath, mergeBase: repo.mergeBase, exitCode: merge.exitCode, output: out.slice(0, 500) }, "merge_conflicts_during_provision");
          }
        }

        if (repo.access === "read") {
          const status = await requireCommand(
            await sandbox.runCommand("git", [
              "-C",
              repo.localPath,
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ]),
            `git status failed for ${repo.provider}:${repo.repoPath}`,
          );
          if ((await status.stdout()).trim()) {
            throw new Error(
              `Research repository ${repo.provider}:${repo.repoPath} read-only checkout is dirty`,
            );
          }
        }

        const sha = await requireCommand(
          await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]),
          `git rev-parse failed for ${repo.provider}:${repo.repoPath}`,
        );
        repo.preAgentSha = (await sha.stdout()).trim();
        if (repo.access === "read") {
          repo.researchBaseSha = repo.preAgentSha;
        }
      }

      await sandbox.writeFiles([
        {
          path: WORKSPACE_MANIFEST_PATH,
          content: Buffer.from(JSON.stringify(manifest, null, 2)),
        },
      ]);

      if (agent && configureOpts) {
        await this.prepareAgent(
          sandbox,
          agent,
          configureOpts,
          primaryRuntime,
        );
      }
      for (const extra of additionalAgents) {
        await this.prepareAgent(
          sandbox,
          extra.agent,
          extra.configureOpts,
          extra.runtime,
        );
      }

      return { sandbox, workspaceManifest: manifest };
    } catch (err) {
      if (sandbox) {
        try {
          await this.teardown(sandbox);
        } catch (cleanupError) {
          if (!isActiveRunOwnerError(err) && !isAgentRuntimeError(err)) throw cleanupError;
        }
      }
      throw err;
    }
  }

  async teardown(sandbox: SandboxInstance): Promise<void> {
    await stopSandboxAndConfirm(sandbox);
  }

  private providerFor(kind: VcsProviderKind | WorkspaceRepo["provider"]): SandboxProviderConfig {
    const provider = this.config.providers.find((candidate) => candidate.kind === kind);
    if (!provider) throw new Error(`Sandbox provider is not configured: ${kind}`);
    return provider;
  }

  private async prepareAgent(
    sandbox: SandboxInstance,
    agent: AgentAdapter,
    configureOpts: ConfigureOpts,
    runtime?: ResolvedHarnessRuntime,
  ): Promise<void> {
    if (runtime) {
      // Profile CLI/home/skills are rebuilt as one invocation boundary. An
      // unrestricted earlier agent must not be able to poison a cached CLI.
      return;
    }
    await agent.install(sandbox);
    await agent.configure(sandbox, configureOpts);
  }
}

type SandboxCommandResult = Awaited<ReturnType<SandboxInstance["runCommand"]>>;

async function requireCommand(
  result: SandboxCommandResult,
  context: string,
): Promise<SandboxCommandResult> {
  if (result.exitCode !== 0) {
    throw new Error(`${context}: ${await commandError(result)}`);
  }
  return result;
}

async function commandError(result: SandboxCommandResult): Promise<string> {
  const stdout = (await result.stdout()).trim();
  const stderr = ((await result.stderr?.()) ?? "").trim();
  return stderr || stdout || "command failed";
}
