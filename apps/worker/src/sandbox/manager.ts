import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "./credentials.js";
import type { AgentAdapter, ConfigureOpts } from "./agents/types.js";
import {
  buildWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_REPOS_DIR,
  type WorkspaceRepo,
  type WorkspaceRepositoryInput,
} from "./repo-workspace.js";
import type { VcsProviderKind } from "../../env.js";
import { buildVcsUrls, gitAuthArgs } from "../lib/vcs-urls.js";

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

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provisionMultiRepo(
    input: { branchName: string; repositories: WorkspaceRepositoryInput[] },
    agent: AgentAdapter,
    configureOpts: ConfigureOpts,
    additionalAgents: ReadonlyArray<{ agent: AgentAdapter; configureOpts: ConfigureOpts }> = [],
  ): Promise<SandboxInstance> {
    if (input.repositories.length === 0) {
      throw new Error("Cannot provision sandbox without selected repositories");
    }

    const { Sandbox } = await import("@vercel/sandbox");
    const manifest = buildWorkspaceManifest({
      branchName: input.branchName,
      repositories: input.repositories,
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
        await sandbox.runCommand("git", ["-C", repo.localPath, "remote", "set-url", "origin", urls.cloneUrl]);
        await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.name", provider.commitAuthor]);
        await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.email", provider.commitEmail]);

        if (repo.mergeBase) {
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

        const sha = await requireCommand(
          await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]),
          `git rev-parse failed for ${repo.provider}:${repo.repoPath}`,
        );
        repo.preAgentSha = (await sha.stdout()).trim();
      }

      await sandbox.writeFiles([
        {
          path: WORKSPACE_MANIFEST_PATH,
          content: Buffer.from(JSON.stringify(manifest, null, 2)),
        },
      ]);

      await agent.install(sandbox);
      await agent.configure(sandbox, configureOpts);
      for (const extra of additionalAgents) {
        await extra.agent.install(sandbox);
        await extra.agent.configure(sandbox, extra.configureOpts);
      }

      return sandbox;
    } catch (err) {
      if (sandbox) await this.teardown(sandbox);
      throw err;
    }
  }

  async teardown(sandbox: SandboxInstance): Promise<void> {
    try { await sandbox.stop(); } catch { /* non-critical */ }
  }

  private providerFor(kind: VcsProviderKind | WorkspaceRepo["provider"]): SandboxProviderConfig {
    const provider = this.config.providers.find((candidate) => candidate.kind === kind);
    if (!provider) throw new Error(`Sandbox provider is not configured: ${kind}`);
    return provider;
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
