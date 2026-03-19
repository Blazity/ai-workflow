import { Sandbox } from "@vercel/sandbox";
import { createLogger } from "@blazebot/shared";
import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";
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

      // Write requirements into the sandbox
      await sandbox.writeFiles([
        { path: "requirements.md", content: Buffer.from(options.requirementsMd) },
      ]);

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

      const stdout = await agentResult.stdout();
      const stderr = await agentResult.stderr();
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
          return { exitCode, status: "complete", summary: output.summary ?? "", containerId: sandboxId };
        case "clarification_needed":
          return { exitCode, status: "clarification_needed", questions: output.questions ?? [], containerId: sandboxId };
        default:
          return { exitCode, status: "failed", error: output.error ?? `Agent returned result: ${output.result}`, containerId: sandboxId };
      }
    } catch (err) {
      return {
        exitCode: -1,
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown error",
        containerId: sandbox?.sandboxId,
      };
    }
  }

  async pushBranch(handle: string, branchName: string): Promise<{ pushed: boolean; output: string }> {
    try {
      const sandbox = await Sandbox.get({ sandboxId: handle });
      const result = await sandbox.runCommand({
        cmd: "git",
        args: ["push", "origin", `HEAD:${branchName}`],
        cwd: "/vercel/sandbox",
      });
      const stdout = await result.stdout();
      const stderr = await result.stderr();
      const output = stdout + stderr;
      if (result.exitCode !== 0) {
        logger.warn({ sandboxId: handle, branchName, exitCode: result.exitCode, output: sanitizeForLog(output) }, "vercel_push_failed");
        return { pushed: false, output: sanitizeForLog(output) };
      }
      logger.info({ sandboxId: handle, branchName }, "vercel_branch_pushed");
      return { pushed: true, output: sanitizeForLog(output) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.warn({ sandboxId: handle, branchName, error: msg }, "vercel_push_failed");
      return { pushed: false, output: msg };
    }
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
