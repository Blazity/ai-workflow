import { getSandboxCredentials } from "./credentials.js";

/**
 * Generalized sentinel check — works with any sentinel file path.
 */
export async function checkPhaseDone(
  sandboxId: string,
  sentinelFile: string,
): Promise<boolean | "stopped"> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    if (sandbox.status !== "running") {
      return "stopped";
    }

    const result = await sandbox.runCommand("test", ["-f", sentinelFile]);
    return result.exitCode === 0;
  } catch {
    return "stopped";
  }
}

/**
 * Generalized output collector — reads from any stdout/stderr file paths.
 * Returns raw string. Caller is responsible for parsing.
 */
export async function collectPhaseOutput(
  sandboxId: string,
  outputFile: string,
  stderrFile: string,
): Promise<string> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const stdoutResult = await sandbox.runCommand("cat", [outputFile]);
  const stdout = (await stdoutResult.stdout()).trim();

  const stderrResult = await sandbox.runCommand("cat", [stderrFile]);
  const stderr = (await stderrResult.stdout()).trim();

  return stdout || stderr;
}

/**
 * Collect raw + (optional) structured phase output. Replaces collectPhaseOutput
 * in adapter-aware code paths.
 */
export async function collectPhase(
  sandboxId: string,
  paths: { stdout: string; stderr: string; structuredOutput: string | null },
): Promise<{ raw: string; structured: string | null }> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  const stdoutResult = await sandbox.runCommand("cat", [paths.stdout]);
  const stdoutText = (await stdoutResult.stdout()).trim();
  const stderrResult = await sandbox.runCommand("cat", [paths.stderr]);
  const stderrText = (await stderrResult.stdout()).trim();
  const raw = stdoutText || stderrText;

  let structured: string | null = null;
  if (paths.structuredOutput) {
    const result = await sandbox.runCommand("cat", [paths.structuredOutput]);
    const text = (await result.stdout()).trim();
    structured = text || null;
  }
  return { raw, structured };
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

/**
 * Tears down every provided sandbox id, de-duplicated and best-effort: one
 * failing teardown never skips the rest. Used to clean up all sandboxes a run
 * created (a prepare_workspace inside a loop makes a fresh one per iteration),
 * not just the most recent. `teardown` is injectable for tests.
 */
export async function teardownSandboxes(
  sandboxIds: Iterable<string>,
  teardown: (sandboxId: string) => Promise<void> = teardownSandbox,
): Promise<void> {
  for (const sandboxId of new Set(sandboxIds)) {
    try {
      await teardown(sandboxId);
    } catch {
      // Best-effort: keep tearing down the remaining sandboxes.
    }
  }
}
