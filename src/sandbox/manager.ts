import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "./credentials.js";
import { buildWrapperScript } from "./wrapper-script.js";

/**
 * Skills installed globally in the sandbox (~/.claude/skills/).
 * Global install keeps the client repo completely untouched — no git concerns.
 */
const GLOBAL_SKILLS = [
  { repo: "https://github.com/obra/superpowers", skill: "using-superpowers" },
  { repo: "https://github.com/obra/superpowers", skill: "requesting-code-review" },
  { repo: "https://github.com/anthropics/skills", skill: "frontend-design" },
] as const;

export interface SandboxConfig {
  githubToken: string;
  owner: string;
  repo: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeModel: string;
  commitAuthor: string;
  commitEmail: string;
  jobTimeoutMs: number;
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provision(
    branch: string,
    requirementsMd: string,
    /** If set, fetches and merges this branch (e.g. "main") so the agent can resolve conflicts. */
    mergeBase?: string,
  ): Promise<SandboxInstance> {
    const { Sandbox } = await import("@vercel/sandbox");

    if (!this.config.claudeCodeOauthToken && !this.config.anthropicApiKey) {
      throw new Error("Either anthropicApiKey or claudeCodeOauthToken must be provided");
    }

    const sandbox = await Sandbox.create({
      ...getSandboxCredentials(),
      source: {
        type: "git",
        url: `https://github.com/${this.config.owner}/${this.config.repo}.git`,
        username: "x-access-token",
        password: this.config.githubToken,
        revision: branch,
      },
      runtime: "node24",
      timeout: this.config.jobTimeoutMs,
      env: {
        ...(this.config.claudeCodeOauthToken
          ? { CLAUDE_CODE_OAUTH_TOKEN: this.config.claudeCodeOauthToken }
          : { ANTHROPIC_API_KEY: this.config.anthropicApiKey! }),
        CLAUDE_MODEL: this.config.claudeModel,
      },
    });

    // Strip auth from origin — the clone URL contains the token, replace it
    // with the unauthenticated URL so the agent never has push access.
    await sandbox.runCommand("git", [
      "remote", "set-url", "origin",
      `https://github.com/${this.config.owner}/${this.config.repo}.git`,
    ]);

    // The sandbox clones a specific revision, which leaves git in detached HEAD.
    // Create a local branch so pushFromSandbox can push without HEAD resolution issues.
    await sandbox.runCommand("git", ["checkout", "-B", branch]);

    // Configure git identity
    await sandbox.runCommand("bash", [
      "-c",
      `git config user.name "${this.config.commitAuthor}" && git config user.email "${this.config.commitEmail}"`,
    ]);

    // Merge base branch so the agent can see and resolve conflicts.
    // The shallow clone has no remote, so we fetch directly via authenticated URL.
    if (mergeBase) {
      const repoUrl = `https://x-access-token:${this.config.githubToken}@github.com/${this.config.owner}/${this.config.repo}.git`;
      const fetchResult = await sandbox.runCommand("bash", [
        "-c",
        `git fetch "${repoUrl}" ${mergeBase} 2>&1`,
      ]);
      // Create a named local branch so the agent can reference it (e.g. `git show main:path`)
      await sandbox.runCommand("bash", [
        "-c",
        `git branch ${mergeBase} FETCH_HEAD 2>/dev/null || true`,
      ]);
      const mergeResult = await sandbox.runCommand("bash", [
        "-c",
        `git merge FETCH_HEAD --no-edit 2>&1`,
      ]);
      if (mergeResult.exitCode !== 0) {
        const mergeOutput = (await mergeResult.stdout()).trim();
        console.warn(`Merge of ${mergeBase} had conflicts (exit=${mergeResult.exitCode}): ${mergeOutput}`);
      }
    }

    // Record the pre-agent HEAD so pushFromSandbox can detect whether the agent made commits.
    // Must happen after clone + optional merge, before the agent touches anything.
    await sandbox.runCommand("bash", [
      "-c",
      "git rev-parse HEAD > /tmp/.pre-agent-sha",
    ]);

    // Install Claude Code
    await sandbox.runCommand("npm", ["install", "-g", "@anthropic-ai/claude-code"]);

    // Skip interactive onboarding (required for headless OAuth token auth)
    if (this.config.claudeCodeOauthToken) {
      await sandbox.runCommand("bash", [
        "-c",
        `mkdir -p ~/.claude && echo '{"hasCompletedOnboarding":true}' > ~/.claude.json`,
      ]);
    }

    // Configure Stop hook — forces agent to commit or discard before exiting.
    // Written to ~/.claude/ (user-level) so it doesn't pollute the repo working tree.
    await sandbox.runCommand("bash", [
      "-c",
      [
        `mkdir -p ~/.claude`,
        `cat > ~/.claude/commit-guard.sh << 'SCRIPT'`,
        `#!/bin/bash`,
        `input=$(cat)`,
        `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
        `changes=$(git status --porcelain | grep -v '^.. \\.claude/' | grep -v '^?? \\.claude/' | grep -v 'requirements\\.md')`,
        `if [ -n "$changes" ]; then`,
        `  echo '{"decision":"block","reason":"You have uncommitted changes. You MUST either commit all changes with a descriptive message or revert them before stopping."}' >&2`,
        `  exit 2`,
        `fi`,
        `SCRIPT`,
        `chmod +x ~/.claude/commit-guard.sh`,
        `cat > ~/.claude/settings.json << 'JSON'`,
        `{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash ~/.claude/commit-guard.sh"}]}]}}`,
        `JSON`,
      ].join("\n"),
    ]);

    // Install skills globally (outside the client repo)
    await this.installGlobalSkills(sandbox);

    // Write requirements.md and wrapper script for detached execution
    const wrapperScript = buildWrapperScript({ model: this.config.claudeModel });
    await sandbox.writeFiles([
      { path: "requirements.md", content: Buffer.from(requirementsMd) },
      { path: "/tmp/agent-wrapper.sh", content: Buffer.from(wrapperScript) },
    ]);
    await sandbox.runCommand("chmod", ["+x", "/tmp/agent-wrapper.sh"]);

    return sandbox;
  }

  /**
   * Install Claude Code skills globally in the sandbox (~/.claude/skills/).
   * Global install keeps the client repo completely untouched.
   */
  private async installGlobalSkills(sandbox: SandboxInstance): Promise<void> {
    for (const { repo, skill } of GLOBAL_SKILLS) {
      await sandbox.runCommand("npx", [
        "-y", "skills", "add", repo, "--skill", skill, "--yes", "-g",
      ]);
    }
  }

  async teardown(sandbox: SandboxInstance): Promise<void> {
    try {
      await sandbox.stop();
    } catch {
      // Teardown failures are non-critical
    }
  }
}
