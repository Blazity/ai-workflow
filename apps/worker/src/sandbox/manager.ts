import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "./credentials.js";
import type { AgentAdapter, ConfigureOpts } from "./agents/types.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import { buildWorkspaceManifest, WORKSPACE_MANIFEST_PATH, WORKSPACE_REPOS_DIR } from "./repo-workspace.js";

export interface SandboxConfig {
  kind: "github" | "gitlab";
  /** Resolves a fresh, short-lived token at the moment of use. */
  getToken: () => Promise<string>;
  repoPath: string;
  host: string;
  jobTimeoutMs: number;
  commitAuthor: string;
  commitEmail: string;
}

/** Bare clone URL with no auth — host normalization shared with `buildVcsUrls`. */
export function buildCloneUrl(config: { host: string; repoPath: string }): string {
  const host = config.host.replace(/\/+$/, "");
  return `${host}/${config.repoPath}.git`;
}

/**
 * Build clone/push URLs for the configured VCS. The caller resolves the token
 * just-in-time and passes it as the second arg, so this function stays pure
 * and does not capture credentials.
 */
export function buildVcsUrls(
  config: { kind: "github" | "gitlab"; repoPath: string; host: string },
  token: string,
) {
  const host = config.host.replace(/\/+$/, "");
  const scheme = host.match(/^https?:\/\//)?.[0] ?? "https://";
  const hostNoScheme = host.replace(/^https?:\/\//, "");
  const authUser = config.kind === "gitlab" ? "oauth2" : "x-access-token";
  return {
    cloneUrl: buildCloneUrl(config),
    authUrl: `${scheme}${authUser}:${token}@${hostNoScheme}/${config.repoPath}.git`,
    authUser,
  };
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provision(
    branch: string,
    agent: AgentAdapter,
    configureOpts: ConfigureOpts,
    mergeBase?: string,
  ): Promise<SandboxInstance> {
    const { Sandbox } = await import("@vercel/sandbox");
    const token = await this.config.getToken();
    const urls = buildVcsUrls(this.config, token);

    const sandbox = await Sandbox.create({
      ...getSandboxCredentials(),
      source: {
        type: "git",
        url: urls.cloneUrl,
        username: urls.authUser,
        password: token,
        revision: branch,
      },
      runtime: "node24",
      timeout: this.config.jobTimeoutMs,
    });

    // Strip auth from origin
    await sandbox.runCommand("git", ["remote", "set-url", "origin", urls.cloneUrl]);
    // Re-create the local branch (clone is detached HEAD on a revision)
    await sandbox.runCommand("git", ["checkout", "-B", branch]);
    // Identity
    await sandbox.runCommand("bash", [
      "-c",
      `git config user.name "${this.config.commitAuthor}" && git config user.email "${this.config.commitEmail}"`,
    ]);

    if (mergeBase) {
      const repoUrl = urls.authUrl;
      await sandbox.runCommand("bash", ["-c", `git fetch "${repoUrl}" ${mergeBase} 2>&1`]);
      await sandbox.runCommand("bash", ["-c", `git branch ${mergeBase} FETCH_HEAD 2>/dev/null || true`]);
      const merge = await sandbox.runCommand("bash", ["-c", `git merge FETCH_HEAD --no-edit 2>&1`]);
      if (merge.exitCode !== 0) {
        const out = (await merge.stdout()).trim();
        const { logger } = await import("../lib/logger.js");
        logger.warn({ mergeBase, exitCode: merge.exitCode, output: out.slice(0, 500) }, "merge_conflicts_during_provision");
      }
    }

    // Pre-agent SHA so push step can detect commits
    await sandbox.runCommand("bash", ["-c", "git rev-parse HEAD > /tmp/.pre-agent-sha"]);

    // --- Agent-specific work delegated to the adapter ---
    await agent.install(sandbox);
    await agent.configure(sandbox, configureOpts);

    return sandbox;
  }

  async provisionMultiRepo(
    input: { branchName: string; repositories: SelectedRepository[]; mergeBase?: string },
    agent: AgentAdapter,
    configureOpts: ConfigureOpts,
  ): Promise<SandboxInstance> {
    if (input.repositories.length === 0) {
      throw new Error("Cannot provision sandbox without selected repositories");
    }

    const { Sandbox } = await import("@vercel/sandbox");
    const token = await this.config.getToken();
    const firstRepo = input.repositories[0];
    const firstUrls = buildVcsUrls({ ...this.config, repoPath: firstRepo.repoPath }, token);

    const sandbox = await Sandbox.create({
      ...getSandboxCredentials(),
      source: {
        type: "git",
        url: firstUrls.cloneUrl,
        username: firstUrls.authUser,
        password: token,
        revision: input.branchName,
      },
      runtime: "node24",
      timeout: this.config.jobTimeoutMs,
    });

    await sandbox.runCommand("mkdir", ["-p", WORKSPACE_REPOS_DIR]);
    const manifest = buildWorkspaceManifest({
      branchName: input.branchName,
      repositories: input.repositories,
    });

    for (const repo of manifest.repositories) {
      const urls = buildVcsUrls({ ...this.config, repoPath: repo.repoPath }, token);
      await sandbox.runCommand("git", [
        "clone",
        "--branch",
        repo.branchName,
        urls.authUrl,
        repo.localPath,
      ]);
      await sandbox.runCommand("git", ["-C", repo.localPath, "remote", "set-url", "origin", urls.cloneUrl]);
      await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.name", this.config.commitAuthor]);
      await sandbox.runCommand("git", ["-C", repo.localPath, "config", "user.email", this.config.commitEmail]);

      if (input.mergeBase) {
        await sandbox.runCommand("bash", ["-c", `git -C "${repo.localPath}" fetch "${urls.authUrl}" ${input.mergeBase} 2>&1`]);
        await sandbox.runCommand("bash", ["-c", `git -C "${repo.localPath}" branch ${input.mergeBase} FETCH_HEAD 2>/dev/null || true`]);
        const merge = await sandbox.runCommand("bash", ["-c", `git -C "${repo.localPath}" merge FETCH_HEAD --no-edit 2>&1`]);
        if (merge.exitCode !== 0) {
          const out = (await merge.stdout()).trim();
          const { logger } = await import("../lib/logger.js");
          logger.warn({ repoPath: repo.repoPath, mergeBase: input.mergeBase, exitCode: merge.exitCode, output: out.slice(0, 500) }, "merge_conflicts_during_provision");
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
}
