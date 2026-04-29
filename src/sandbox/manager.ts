import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "./credentials.js";
import type { AgentAdapter, ConfigureOpts } from "./agents/types.js";

export interface SandboxConfig {
  kind: "github" | "gitlab";
  token: string;
  repoPath: string;
  host: string;
  jobTimeoutMs: number;
  commitAuthor: string;
  commitEmail: string;
}

/** Build clone/push URLs for the configured VCS. Unchanged from previous behaviour. */
export function buildVcsUrls(config: { kind: "github" | "gitlab"; token: string; repoPath: string; host: string }) {
  const host = config.host.replace(/\/+$/, "");
  const scheme = host.match(/^https?:\/\//)?.[0] ?? "https://";
  const hostNoScheme = host.replace(/^https?:\/\//, "");
  const authUser = config.kind === "gitlab" ? "oauth2" : "x-access-token";
  return {
    cloneUrl: `${host}/${config.repoPath}.git`,
    authUrl: `${scheme}${authUser}:${config.token}@${hostNoScheme}/${config.repoPath}.git`,
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
    const urls = buildVcsUrls(this.config);

    const sandbox = await Sandbox.create({
      ...getSandboxCredentials(),
      source: {
        type: "git",
        url: urls.cloneUrl,
        username: urls.authUser,
        password: this.config.token,
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

  async teardown(sandbox: SandboxInstance): Promise<void> {
    try { await sandbox.stop(); } catch { /* non-critical */ }
  }
}
