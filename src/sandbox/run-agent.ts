import type { Sandbox as SandboxType } from "@vercel/sandbox";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;

/**
 * Starts the agent wrapper script in detached mode.
 * Returns immediately — the agent runs in the background.
 * Use `checkAgentDone` / `collectAgentResults` from poll-agent.ts to poll for completion.
 */
export async function startAgentDetached(
  sandbox: SandboxInstance,
): Promise<void> {
  await sandbox.runCommand({
    cmd: "bash",
    args: ["/tmp/agent-wrapper.sh"],
    cwd: "/vercel/sandbox",
    detached: true,
  });
}
