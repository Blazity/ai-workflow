import { getSandboxCredentials } from "./credentials.js";
import { parseAgentOutput } from "./agent-runner.js";
import type { AgentOutput } from "./agent-runner.js";

/**
 * Reconnects to a sandbox and checks whether the agent has finished.
 * Returns:
 * - `true` if /tmp/agent-done sentinel exists
 * - `false` if sandbox is running but agent not done yet
 * - `"stopped"` if sandbox is no longer running (timeout/crash)
 */
export async function checkAgentDone(
  sandboxId: string,
): Promise<boolean | "stopped"> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    if (sandbox.status !== "running") {
      return "stopped";
    }

    const result = await sandbox.runCommand("test", ["-f", "/tmp/agent-done"]);
    return result.exitCode === 0;
  } catch {
    // Sandbox unreachable (network error, GC'd, etc.) — treat as stopped
    return "stopped";
  }
}

/**
 * Reconnects to the sandbox, reads agent stdout/stderr, extracts changed files,
 * and returns the parsed result.
 */
export async function collectAgentResults(
  sandboxId: string,
): Promise<{ output: AgentOutput; files: Array<{ path: string; content: string }> }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");

  let sandbox;
  try {
    sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  } catch {
    // Sandbox unreachable between final poll and collection — return a clear failure
    return {
      output: { result: "failed", error: "Sandbox became unreachable before results could be collected" },
      files: [],
    };
  }

  // Read agent output files
  const stdoutResult = await sandbox.runCommand("cat", ["/tmp/agent-stdout.txt"]);
  const stdout = (await stdoutResult.stdout()).trim();

  const stderrResult = await sandbox.runCommand("cat", ["/tmp/agent-stderr.txt"]);
  const stderr = (await stderrResult.stdout()).trim();

  const raw = stdout || stderr;
  const output = parseAgentOutput(raw);

  // Extract changed files
  const baseResult = await sandbox.runCommand("bash", [
    "-c",
    "cat /tmp/.pre-agent-sha 2>/dev/null || git rev-list --max-parents=0 HEAD",
  ]);
  const baseSha = (await baseResult.stdout()).trim();

  let files: Array<{ path: string; content: string }> = [];

  if (baseSha) {
    const diffResult = await sandbox.runCommand("git", [
      "diff", "--name-only", baseSha, "HEAD",
    ]);
    const diffOutput = (await diffResult.stdout()).trim();

    if (diffOutput) {
      const filePaths = diffOutput
        .split("\n")
        .filter(Boolean)
        .filter((p) => p !== "requirements.md")
        .filter((p) => !p.startsWith(".claude/"));

      for (const filePath of filePaths) {
        const buf = await sandbox.readFileToBuffer({
          path: filePath,
          cwd: "/vercel/sandbox",
        });
        if (buf) {
          files.push({ path: filePath, content: buf.toString("utf-8") });
        }
      }
    }
  }

  return { output, files };
}

/**
 * Reconnects to a sandbox and stops it.
 */
export async function teardownSandbox(sandboxId: string): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
    await sandbox.stop();
  } catch {
    // Teardown failures are non-critical (sandbox may have already stopped)
  }
}
