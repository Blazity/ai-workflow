import { Sandbox } from "@vercel/sandbox";
import { createLogger } from "@blazebot/shared";
import type { SandboxProvider, SandboxOptions, SandboxResult, ExtractedChanges } from "./types.js";
import { parseAgentOutput, sanitizeForLog } from "./parse-output.js";

export interface VercelSandboxConfig {
  vcpus?: number;
}

const AGENT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["result"],
  properties: {
    result: { type: "string", enum: ["implemented", "clarification_needed", "failed"] },
    summary: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  additionalProperties: false,
});

const logger = createLogger();

export class VercelSandboxProvider implements SandboxProvider {
  private vcpus: number;

  constructor(config: VercelSandboxConfig) {
    this.vcpus = config.vcpus ?? 2;
  }

  async runSandbox(options: SandboxOptions): Promise<SandboxResult> {
    let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;

    try {
      sandbox = await Sandbox.create({
        source: {
          type: "git",
          url: `https://github.com/${options.repoUrl}.git`,
          username: "x-access-token",
          password: options.githubToken,
          revision: options.branchName,
          depth: 1,
        },
        runtime: "node22",
        resources: { vcpus: this.vcpus },
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken,
          CLAUDE_MODEL: options.model,
          GITHUB_TOKEN: options.githubToken,
        },
        timeout: options.timeoutMs,
      });

      const sandboxId = sandbox.sandboxId;
      const startTime = Date.now();
      logger.info({ sandboxId, branchName: options.branchName }, "vercel_sandbox_created");

      // Write requirements and Claude Code Stop hook that auto-commits changes
      const claudeSettings = JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "git add -A && (git diff --cached --quiet || git commit -m 'Apply agent changes')",
                },
              ],
            },
          ],
        },
      });

      await sandbox.writeFiles([
        { path: "requirements.md", content: Buffer.from(options.requirementsMd) },
        { path: ".claude/settings.json", content: Buffer.from(claudeSettings) },
      ]);

      // Configure git identity and exclude blazebot files from commits
      await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", 'git config user.name "ai-workflow-blazity" && git config user.email "ai-workflow-blazity@users.noreply.github.com" && echo -e "requirements.md\\n.claude/" >> .git/info/exclude'],
        cwd: "/vercel/sandbox",
      });

      // Record initial HEAD SHA before agent runs (used as diff base later)
      const shaResult = await sandbox.runCommand({ cmd: "git", args: ["rev-parse", "HEAD"], cwd: "/vercel/sandbox" });
      const initialSha = (await shaResult.stdout()).trim();

      // Install Claude Code CLI
      const installResult = await sandbox.runCommand("npm", ["install", "-g", "@anthropic-ai/claude-code"]);
      if (installResult.exitCode !== 0) {
        const installErr = await installResult.stderr();
        logger.error({ sandboxId, error: installErr }, "claude_code_install_failed");
        return {
          exitCode: -1,
          status: "failed",
          error: `Failed to install Claude Code: ${sanitizeForLog(installErr)}`,
          containerId: sandboxId,
        };
      }

      // Run Claude Code agent
      const agentResult = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c",
          `cat /vercel/sandbox/requirements.md | claude --print --output-format json --json-schema '${AGENT_SCHEMA}' --model "$CLAUDE_MODEL" --dangerously-skip-permissions`,
        ],
        cwd: "/vercel/sandbox",
      });

      const exitCode = agentResult.exitCode;
      const durationMs = Date.now() - startTime;
      logger.info({ sandboxId, exitCode, durationMs }, "vercel_agent_exited");

      // Commit any uncommitted changes left by the agent (fallback if Stop hook didn't fire)
      await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", "git add -A && (git diff --cached --quiet || git commit -m 'Apply agent changes')"],
        cwd: "/vercel/sandbox",
      });

      // Diagnostic: check sandbox state after agent exits
      const diag = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", "echo '=== git status ===' && git status && echo '=== git log ===' && git log --oneline -5"],
        cwd: "/vercel/sandbox",
      });
      const diagStdout = await diag.stdout();
      logger.info({ sandboxId, initialSha, diagStdout: diagStdout.slice(0, 1500) }, "vercel_post_agent_diag");

      const stdout = await agentResult.stdout();
      const stderr = await agentResult.stderr();
      logger.info({ sandboxId, stdoutTail: sanitizeForLog(stdout).slice(-800), stderrTail: sanitizeForLog(stderr).slice(-500) }, "vercel_agent_output");
      const output = parseAgentOutput(stdout);

      if (!output) {
        const diagnostic = sanitizeForLog(stderr || stdout) || "(no output captured)";
        logger.error({ sandboxId, exitCode, diagnostic }, "vercel_no_structured_output");
        return {
          exitCode,
          status: "failed",
          error: `Agent did not return valid structured JSON output. Output: ${diagnostic.slice(-500)}`,
          containerId: sandboxId,
        };
      }

      switch (output.result) {
        case "implemented":
          return { exitCode, status: "complete", summary: output.summary ?? "", containerId: sandboxId, initialSha };
        case "clarification_needed":
          return { exitCode, status: "clarification_needed", questions: output.questions ?? [], containerId: sandboxId, initialSha };
        default:
          return { exitCode, status: "failed", error: output.error ?? `Agent returned result: ${output.result}`, containerId: sandboxId, initialSha };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const errJson = (err as any)?.json;
      const errText = (err as any)?.text;
      const errStatus = (err as any)?.response?.status;
      logger.error({ error: errMsg, status: errStatus, responseJson: errJson, responseText: errText, stack: (err as Error)?.stack }, "vercel_sandbox_error");
      return {
        exitCode: -1,
        status: "failed",
        error: errMsg,
        containerId: sandbox?.sandboxId,
      };
    }
  }

  async extractChanges(handle: string, initialSha: string): Promise<ExtractedChanges> {
    const sandbox = await Sandbox.get({ sandboxId: handle });

    // Ensure any uncommitted changes are staged and committed
    await sandbox.runCommand({ cmd: "git", args: ["add", "-A"], cwd: "/vercel/sandbox" });
    const statusResult = await sandbox.runCommand({
      cmd: "git", args: ["status", "--porcelain"], cwd: "/vercel/sandbox",
    });
    const statusOutput = await statusResult.stdout();
    if (statusOutput.trim()) {
      await sandbox.runCommand({
        cmd: "git", args: ["commit", "-m", "Apply agent changes"], cwd: "/vercel/sandbox",
      });
    }

    // Get list of changed files vs the initial state (using recorded SHA, not origin ref)
    const diffResult = await sandbox.runCommand({
      cmd: "git", args: ["diff", "--name-status", initialSha, "HEAD"],
      cwd: "/vercel/sandbox",
    });
    const diffOutput = (await diffResult.stdout()).trim();
    if (!diffOutput) {
      logger.info({ sandboxId: handle, initialSha }, "vercel_no_changes_detected");
      return { files: [], commitMessage: "", hasChanges: false };
    }

    // Collect commit messages
    const logResult = await sandbox.runCommand({
      cmd: "git", args: ["log", "--format=%s", `${initialSha}..HEAD`],
      cwd: "/vercel/sandbox",
    });
    const commitMessage = (await logResult.stdout()).trim();

    // Read each changed file
    const files: ExtractedChanges["files"] = [];
    for (const line of diffOutput.split("\n")) {
      const [status, ...pathParts] = line.split("\t");
      const filePath = pathParts.join("\t");
      if (!filePath) continue;

      if (status?.startsWith("D")) {
        files.push({ path: filePath, content: null });
      } else {
        const buf = await sandbox.readFileToBuffer({ path: filePath, cwd: "/vercel/sandbox" });
        files.push({ path: filePath, content: buf?.toString("base64") ?? null });
      }
    }

    logger.info({ sandboxId: handle, initialSha, fileCount: files.length }, "vercel_changes_extracted");
    return { files, commitMessage, hasChanges: true };
  }

  async teardown(handle: string): Promise<void> {
    logger.info({ sandboxId: handle }, "vercel_sandbox_teardown_requested");
    try {
      const sandbox = await Sandbox.get({ sandboxId: handle });
      await sandbox.stop();
    } catch {
      /* sandbox may already be stopped */
    }
  }

  async cleanupOrphans(): Promise<void> {
    try {
      const { json: { sandboxes } } = await Sandbox.list();
      const running = sandboxes.filter((s: { status: string }) => s.status === "running");
      if (running.length === 0) {
        logger.info("vercel_orphan_cleanup_none_found");
        return;
      }
      logger.info({ count: running.length }, "vercel_orphan_cleanup_started");
      for (const s of running) {
        try {
          const sandbox = await Sandbox.get({ sandboxId: s.id });
          await sandbox.stop();
          logger.info({ sandboxId: s.id }, "vercel_orphan_sandbox_stopped");
        } catch {
          logger.warn({ sandboxId: s.id }, "vercel_orphan_sandbox_stop_failed");
        }
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : "Unknown error" }, "vercel_orphan_cleanup_failed");
    }
  }
}
