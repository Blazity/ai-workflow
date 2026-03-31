import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getWritable } from "workflow";
import { buildAgentCommand, parseAgentOutput, formatStreamEvent } from "./agent-runner.js";
import type { AgentOutput } from "./agent-runner.js";
import { SandboxManager } from "./manager.js";

type SandboxInstance = InstanceType<typeof SandboxType>;

interface StartAgentOptions {
  sandbox: SandboxInstance;
  model: string;
  debug: boolean;
}

export interface StartAgentResult {
  sandboxId: string;
  cmdId: string;
}

/**
 * Provisions and starts the agent command in detached mode.
 * Returns identifiers to reconnect later — does NOT wait for the agent to finish.
 */
export async function startAgent(
  opts: StartAgentOptions,
): Promise<StartAgentResult> {
  const { sandbox, model, debug } = opts;
  const { cmd, args } = buildAgentCommand(model, debug);

  const command = await sandbox.runCommand({
    cmd,
    args,
    cwd: "/vercel/sandbox",
    detached: true,
  });

  return { sandboxId: sandbox.sandboxId, cmdId: command.cmdId };
}

/**
 * Returns true when the error indicates the sandbox has been torn down
 * (HTTP 410 Gone). Once gone, the sandbox will never come back, so
 * retrying is pointless.
 */
function isSandboxGone(err: unknown): boolean {
  return err instanceof Error && /status code 410/i.test(err.message);
}

// --- Non-blocking status check (used with sleep() polling) ---

export type AgentStatus = "running" | "done" | "gone";

interface CheckStatusOptions {
  sandboxId: string;
  cmdId: string;
  manager: SandboxManager;
}

/**
 * Non-blocking check: reconnects to the sandbox, fetches command state,
 * and returns the current status without waiting.
 *
 * - "running" → agent still executing
 * - "done"    → agent finished (exitCode is set)
 * - "gone"    → sandbox was torn down (410)
 */
export async function checkAgentStatus(
  opts: CheckStatusOptions,
): Promise<AgentStatus> {
  const { sandboxId, cmdId, manager } = opts;

  let sandbox;
  try {
    sandbox = await manager.reconnect(sandboxId);
  } catch (err) {
    if (isSandboxGone(err)) return "gone";
    throw err;
  }

  try {
    const command = await sandbox.getCommand(cmdId);
    return command.exitCode !== null ? "done" : "running";
  } catch (err) {
    if (isSandboxGone(err)) return "gone";
    throw err;
  }
}

// --- Result collection (called only after agent is done) ---

interface CollectResultsOptions {
  sandboxId: string;
  cmdId: string;
  manager: SandboxManager;
  debug: boolean;
}

/**
 * Reconnects to a sandbox whose agent command has already finished,
 * collects stdout/stderr, runs end-hook, extracts changed files, and
 * tears down the sandbox.
 *
 * Must be called only after {@link checkAgentStatus} returned "done".
 * If the sandbox is gone (410), returns a graceful failure.
 */
export async function collectAgentResults(
  opts: CollectResultsOptions,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  const { sandboxId, cmdId, manager, debug } = opts;

  let sandbox;
  try {
    sandbox = await manager.reconnect(sandboxId);
  } catch (err) {
    if (isSandboxGone(err)) {
      console.error(`Sandbox ${sandboxId} is gone (410) — cannot reconnect.`);
      return {
        output: { result: "failed", error: "Sandbox expired (410 Gone) before results could be collected." },
        files: [],
      };
    }
    throw err;
  }

  try {
    const command = await sandbox.getCommand(cmdId);

    let stdout: string;
    let stderr: string;

    if (debug) {
      const writable = getWritable<string>();
      const writer = writable.getWriter();
      stdout = "";
      stderr = "";
      let lineBuf = "";
      try {
        await writer.write("[debug] Agent finished, streaming logs\n");
        for await (const log of command.logs()) {
          if (log.stream === "stdout") {
            stdout += log.data;
            lineBuf += log.data;
            const lines = lineBuf.split("\n");
            lineBuf = lines.pop() ?? "";
            for (const line of lines.filter(Boolean)) {
              const formatted = formatStreamEvent(line);
              if (formatted) await writer.write(formatted + "\n");
            }
          } else {
            stderr += log.data;
          }
        }
        if (lineBuf.trim()) {
          const formatted = formatStreamEvent(lineBuf);
          if (formatted) await writer.write(formatted + "\n");
        }
        await writer.write("[debug] Logs collected\n");
      } finally {
        writer.releaseLock();
      }
    } else {
      stdout = await command.stdout();
      stderr = await command.stderr();
    }

    await manager.runEndHook(sandbox);
    const files = await manager.extractChanges(sandbox);

    const raw = stdout.trim() || stderr.trim();
    const output = parseAgentOutput(raw);
    return { output, files };
  } catch (err) {
    if (isSandboxGone(err)) {
      console.error(`Sandbox ${sandboxId} expired (410) during result collection.`);
      return {
        output: { result: "failed", error: "Sandbox expired (410 Gone) during result collection." },
        files: [],
      };
    }
    await manager.runEndHook(sandbox).catch(() => {});
    const files = await manager.extractChanges(sandbox).catch(() => []);
    throw Object.assign(err as Error, { files });
  } finally {
    if (sandbox) await manager.teardown(sandbox);
  }
}
