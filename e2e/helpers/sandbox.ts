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
    const { json } = await Sandbox.list({ limit: 100 });
    const running = json.sandboxes.filter(
      (s: { status?: string }) => s.status === "running",
    );

    let stopped = 0;
    for (const entry of running) {
      try {
        const sandbox = await Sandbox.get({ sandboxId: entry.id });
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
