/**
 * Best-effort cleanup: find and stop any running sandboxes whose checked-out
 * branch matches `blazebot/{ticketKey}`.
 */
export async function stopSandboxesForTicket(
  ticketKey: string,
): Promise<number> {
  const expectedBranch = `blazebot/${ticketKey.trim().toLowerCase()}`;
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import(
      "../../src/sandbox/credentials.js"
    );
    const credentials = getSandboxCredentials();
    const { json } = await Sandbox.list({ ...credentials, limit: 100 });
    const running = json.sandboxes.filter(
      (s: { status?: string }) => s.status === "running",
    );

    let stopped = 0;
    for (const entry of running) {
      try {
        const sandbox = await Sandbox.get({
          ...credentials,
          sandboxId: entry.id,
        });
        if (sandbox.status !== "running") continue;

        const result = await sandbox.runCommand({
          cmd: "git",
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
          cwd: "/vercel/sandbox",
        });
        const branch = result.exitCode === 0
          ? (await result.stdout()).trim()
          : null;
        if (branch !== expectedBranch) continue;

        await sandbox.stop();
        stopped++;
      } catch {
        // Best-effort — skip individual sandbox errors
      }
    }
    return stopped;
  } catch {
    return 0;
  }
}

/**
 * Kill the running `claude` process inside the ticket's sandbox.
 *
 * The wrapper script's cleanup section (touch sentinel) runs unconditionally
 * after claude exits, so killing claude causes the workflow's pollUntilDone
 * to see the sentinel with empty/partial stdout — parseResearchStatus then
 * defaults to `{ status: "failed" }`, exercising the US-7 failure path.
 *
 * Returns `true` only when `pkill` actually terminated a claude process.
 * Returning `true` from "sandbox exists on the right branch" alone is unsafe:
 * there's a window between git checkout and claude exec where the wrapper is
 * still sourcing env files — `pkill` then matches nothing (exit 1), claude
 * starts a moment later, the agent runs to completion, and the ticket lands
 * in AI Review instead of Backlog. Caller polls this helper, so returning
 * `false` on a no-op pkill makes the caller try again instead of advancing.
 */
export async function killClaudeForTicket(
  ticketKey: string,
): Promise<boolean> {
  const expectedBranch = `blazebot/${ticketKey.trim().toLowerCase()}`;
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import(
    "../../src/sandbox/credentials.js"
  );
  const credentials = getSandboxCredentials();
  const { json } = await Sandbox.list({ ...credentials, limit: 100 });
  const running = json.sandboxes.filter(
    (s: { status?: string }) => s.status === "running",
  );

  for (const entry of running) {
    const sandbox = await Sandbox.get({
      ...credentials,
      sandboxId: entry.id,
    });
    if (sandbox.status !== "running") continue;

    const branchResult = await sandbox.runCommand({
      cmd: "git",
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: "/vercel/sandbox",
    });
    const branch = branchResult.exitCode === 0
      ? (await branchResult.stdout()).trim()
      : null;
    if (branch !== expectedBranch) continue;

    // `pkill` exits 0 if any process matched and was signaled, 1 if no
    // match. We only claim success on 0 — that guarantees the wrapper's
    // foreground pipeline was actually interrupted and the cleanup path
    // (touch sentinel with empty stdout) will run.
    const killResult = await sandbox.runCommand({
      cmd: "pkill",
      args: ["-9", "-f", "claude"],
    });
    if (killResult.exitCode === 0) return true;
    // Matched sandbox but claude wasn't running yet; caller will retry.
    return false;
  }
  return false;
}
