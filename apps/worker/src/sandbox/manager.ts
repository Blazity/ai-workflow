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
import { buildVcsUrls } from "../lib/vcs-urls.js";

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
    const firstUrls = buildVcsUrls({ ...firstProvider, repoPath: firstRepo.repoPath }, firstToken);

    const sandbox = await Sandbox.create({
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
      const provider = this.providerFor(repo.provider);
      const token = await provider.getToken();
      const urls = buildVcsUrls({ ...provider, repoPath: repo.repoPath }, token);
      if (index > 0) {
        await sandbox.runCommand("git", [
          "clone",
          "--branch",
          repo.branchName,
          urls.authUrl,
          repo.localPath,
        ]);
      } else {
        await sandbox.runCommand("git", ["-C", repo.localPath, "checkout", "-B", repo.branchName]);
      }
      await sandbox.runCommand("git", ["-C", repo.localPath, "remote", "set-url", "origin", urls.cloneUrl]);
      await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.name", provider.commitAuthor]);
      await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.email", provider.commitEmail]);

      if (repo.mergeBase) {
        await sandbox.runCommand("git", ["-C", repo.localPath, "fetch", urls.authUrl, repo.mergeBase]);
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

      const sha = await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
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

    return sandbox;
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
