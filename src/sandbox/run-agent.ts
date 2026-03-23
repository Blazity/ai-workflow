import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getWritable } from "workflow";
import { buildAgentCommand, parseAgentOutput, formatStreamEvent } from "./agent-runner.js";
import type { AgentOutput } from "./agent-runner.js";
import { SandboxManager } from "./manager.js";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

interface RunAgentOptions {
  sandbox: SandboxInstance;
  manager: SandboxManager;
  model: string;
  debug: boolean;
}

export async function runAgent(
  opts: RunAgentOptions,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  const { sandbox, manager, model, debug } = opts;

  try {
    const { cmd, args } = buildAgentCommand(model, debug);

    let stdout: string;
    let stderr: string;

    if (debug) {
      const command = await sandbox.runCommand({ cmd, args, cwd: "/vercel/sandbox", detached: true });

      const writable = getWritable<string>();
      const writer = writable.getWriter();
      stdout = "";
      stderr = "";
      let lineBuf = "";
      try {
        await writer.write("[debug] Agent started\n");
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
        // Flush remaining buffer
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
      const result = await sandbox.runCommand({ cmd, args, cwd: "/vercel/sandbox" });
      stdout = await result.stdout();
      stderr = await result.stderr();
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
