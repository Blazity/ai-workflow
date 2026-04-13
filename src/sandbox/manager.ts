import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "./credentials.js";

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
  kind: "github" | "gitlab";
  token: string;
  /** GitHub: "owner/repo", GitLab: project path e.g. "group/repo" */
  repoPath: string;
  /** VCS host base URL, e.g. https://github.com or https://gitlab.example.com */
  host: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeModel: string;
  commitAuthor: string;
  commitEmail: string;
  jobTimeoutMs: number;
}

/** Build clone/push URLs for the configured VCS. Supports github.com and any GitLab host (incl. self-hosted). */
export function buildVcsUrls(config: {
  kind: "github" | "gitlab";
  token: string;
  repoPath: string;
  host: string;
}) {
  // Strip trailing slash for consistent URL joining.
  const host = config.host.replace(/\/+$/, "");
  // Extract `host.tld` (no scheme) so we can interpolate credentials into the URL.
  const hostNoScheme = host.replace(/^https?:\/\//, "");
  const authUser = config.kind === "gitlab" ? "oauth2" : "x-access-token";
  return {
    cloneUrl: `${host}/${config.repoPath}.git`,
    authUrl: `https://${authUser}:${config.token}@${hostNoScheme}/${config.repoPath}.git`,
    authUser,
  };
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

/** Minimal interface for sandbox objects that support runCommand (works with both Sandbox.create and Sandbox.get). */
interface RunnableSandbox {
  runCommand: SandboxInstance["runCommand"];
}

/**
 * Configures or disables the commit-guard stop hook in a sandbox.
 * Standalone function so both SandboxManager and workflow steps can call it
 * without type mismatches between Sandbox.create() and Sandbox.get().
 */
export async function configureStopHookInSandbox(sandbox: RunnableSandbox, enabled: boolean): Promise<void> {
  if (enabled) {
    await sandbox.runCommand("bash", [
      "-c",
      [
        `mkdir -p ~/.claude`,
        `cat > ~/.claude/commit-guard.sh << 'SCRIPT'`,
        `#!/bin/bash`,
        `input=$(cat)`,
        `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
        `changes=$(git status --porcelain | grep -v '^.. \\.claude/' | grep -v '^?? \\.claude/')`,
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
  } else {
    await sandbox.runCommand("bash", [
      "-c",
      `mkdir -p ~/.claude && echo '{}' > ~/.claude/settings.json`,
    ]);
  }
}

export class SandboxManager {
  constructor(private config: SandboxConfig) {}

  async provision(
    branch: string,
    /** If set, fetches and merges this branch (e.g. "main") so the agent can resolve conflicts. */
    mergeBase?: string,
  ): Promise<SandboxInstance> {
    const { Sandbox } = await import("@vercel/sandbox");

    if (!this.config.claudeCodeOauthToken && !this.config.anthropicApiKey) {
      throw new Error("Either anthropicApiKey or claudeCodeOauthToken must be provided");
    }

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
      "remote", "set-url", "origin", urls.cloneUrl,
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
      const repoUrl = urls.authUrl;
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
        const { logger } = await import("../lib/logger.js");
        logger.warn(
          { mergeBase, exitCode: mergeResult.exitCode, output: mergeOutput.slice(0, 500) },
          "merge_conflicts_during_provision",
        );
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

    // Write auth env vars to a file that phase scripts can source.
    // Sandbox.create({ env }) does NOT propagate vars to runCommand sessions,
    // so we persist them to disk and source before every `claude` invocation.
    // NOTE: Only auth credentials go here. CLAUDE_MODEL is passed via the
    // explicit --model flag in phase scripts and poll-agent to keep one source of truth.
    const envLines: string[] = [];
    if (this.config.claudeCodeOauthToken) {
      envLines.push(`export CLAUDE_CODE_OAUTH_TOKEN=${this.shellQuote(this.config.claudeCodeOauthToken)}`);
    } else if (this.config.anthropicApiKey) {
      envLines.push(`export ANTHROPIC_API_KEY=${this.shellQuote(this.config.anthropicApiKey)}`);
    }

    await sandbox.writeFiles([
      { path: "/tmp/agent-env.sh", content: Buffer.from(envLines.join("\n") + "\n") },
    ]);
    await sandbox.runCommand("chmod", ["600", "/tmp/agent-env.sh"]);

    // Skip interactive onboarding (required for headless auth — both OAuth and API key)
    await sandbox.runCommand("bash", [
      "-c",
      `mkdir -p ~/.claude && echo '{"hasCompletedOnboarding":true}' > ~/.claude.json`,
    ]);

    // Install skills globally (outside the client repo)
    await this.installGlobalSkills(sandbox);

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

  /** Safely quote a value for use in a shell variable assignment. */
  private shellQuote(val: string): string {
    // Single-quote the value, escaping any embedded single quotes.
    return `'${val.replace(/'/g, "'\\''")}'`;
  }

  async configureStopHook(sandbox: SandboxInstance, enabled: boolean): Promise<void> {
    await configureStopHookInSandbox(sandbox, enabled);
  }

  async teardown(sandbox: SandboxInstance): Promise<void> {
    try {
      await sandbox.stop();
    } catch {
      // Teardown failures are non-critical
    }
  }
}
