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

interface CollectResultsOptions {
  sandboxId: string;
  cmdId: string;
  manager: SandboxManager;
  debug: boolean;
}

/**
 * Reconnects to a running sandbox, waits for the agent command to finish,
 * then runs end-hook, extracts changed files, and tears down the sandbox.
 *
 * If the Vercel function times out while waiting, WDK replays the workflow
 * and re-executes this step. It reconnects to the same sandbox/command —
 * if the agent already finished, `wait()` resolves immediately.
 */
export async function collectAgentResults(
  opts: CollectResultsOptions,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  const { sandboxId, cmdId, manager, debug } = opts;

  const sandbox = await manager.reconnect(sandboxId);

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
        await writer.write("[debug] Agent reconnected, streaming logs\n");
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
        await writer.write("[debug] Agent finished\n");
      } finally {
        writer.releaseLock();
      }
      await command.wait();
    } else {
      await command.wait();
      stdout = await command.stdout();
      stderr = await command.stderr();
    }

    await manager.runEndHook(sandbox);
    const files = await manager.extractChanges(sandbox);

    const raw = stdout.trim() || stderr.trim();
    const output = parseAgentOutput(raw);
    return { output, files };
  } catch (err) {
    await manager.runEndHook(sandbox).catch(() => {});
    const files = await manager.extractChanges(sandbox).catch(() => []);
    throw Object.assign(err as Error, { files });
  } finally {
    await manager.teardown(sandbox);
  }
}
