import type { Sandbox as SandboxType } from "@vercel/sandbox";

export interface SandboxConfig {
  githubToken: string;
  owner: string;
  repo: string;
  anthropicApiKey: string;
  claudeModel: string;
  commitAuthor: string;
  commitEmail: string;
  jobTimeoutMs: number;
  vercelToken?: string;
  vercelTeamId?: string;
  vercelProjectId?: string;
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

export type EndHookResult = "clean" | "committed" | "error";

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provision(
    branch: string,
    requirementsMd: string,
  ): Promise<SandboxInstance> {
    const { Sandbox } = await import("@vercel/sandbox");

    // Pass explicit credentials only when all three are provided (local dev).
    // On Vercel, omit them entirely so the SDK uses OIDC auto-detection.
    const hasExplicitCredentials =
      this.config.vercelToken && this.config.vercelTeamId && this.config.vercelProjectId;

    const sandbox = await Sandbox.create({
      ...(hasExplicitCredentials
        ? {
            token: this.config.vercelToken,
            teamId: this.config.vercelTeamId,
            projectId: this.config.vercelProjectId,
          }
        : {}),
      source: {
        type: "git",
        url: `https://github.com/${this.config.owner}/${this.config.repo}.git`,
        username: "x-access-token",
        password: this.config.githubToken,
        revision: branch,
        depth: 1,
      },
      runtime: "node24",
      timeout: this.config.jobTimeoutMs,
      env: {
        ANTHROPIC_API_KEY: this.config.anthropicApiKey,
        CLAUDE_MODEL: this.config.claudeModel,
      },
    });

    // Configure git identity
    await sandbox.runCommand("bash", [
      "-c",
      `git config user.name "${this.config.commitAuthor}" && git config user.email "${this.config.commitEmail}"`,
    ]);

    // Install Claude Code
    await sandbox.runCommand("npm", ["install", "-g", "@anthropic-ai/claude-code"]);

    // Write requirements.md
    await sandbox.writeFiles([
      { path: "requirements.md", content: Buffer.from(requirementsMd) },
    ]);

    return sandbox;
  }

  async runEndHook(sandbox: SandboxInstance): Promise<EndHookResult> {
    try {
      const statusResult = await sandbox.runCommand("git", [
        "status",
        "--porcelain",
      ]);
      const status = (await statusResult.stdout()).trim();

      if (!status) return "clean";

      // Uncommitted changes exist — force commit
      await sandbox.runCommand("git", ["add", "-A"]);
      await sandbox.runCommand("git", [
        "commit",
        "-m",
        "wip: auto-commit uncommitted changes before sandbox teardown",
      ]);

      return "committed";
    } catch {
      return "error";
    }
  }

  async extractChanges(
    sandbox: SandboxInstance,
  ): Promise<Array<{ path: string; content: string }>> {
    const diffResult = await sandbox.runCommand("git", [
      "diff",
      "--name-only",
      "HEAD~1",
      "HEAD",
    ]);
    const diffOutput = (await diffResult.stdout()).trim();
    if (!diffOutput) return [];

    const filePaths = diffOutput.split("\n").filter(Boolean);
    const files: Array<{ path: string; content: string }> = [];

    for (const filePath of filePaths) {
      const buf = await sandbox.readFileToBuffer({
        path: filePath,
        cwd: "/vercel/sandbox",
      });
      if (buf) {
        files.push({ path: filePath, content: buf.toString("utf-8") });
      }
    }
    return files;
  }

  async teardown(sandbox: SandboxInstance): Promise<void> {
    try {
      await sandbox.stop();
    } catch {
      // Teardown failures are non-critical
    }
  }
}
