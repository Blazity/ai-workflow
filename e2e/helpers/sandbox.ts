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
 * Kill the running agent process (claude or codex) inside the ticket's sandbox.
 *
 * The wrapper script's cleanup section (touch sentinel) runs unconditionally
 * after the agent exits, so killing the agent causes the workflow's
 * pollUntilDone to see the sentinel with empty/partial stdout —
 * parseResearchStatus then defaults to `{ status: "failed" }`, exercising the
 * US-7 failure path.
 *
 * The pkill pattern matches a flag unique to the agent's wrapper invocation
 * (`claude --print` / `codex exec`) rather than the bare binary name. This
 * avoids false positives from the Arthur tracer hook (`claude_code_tracer.py`)
 * which runs as a transient `python3` subprocess whose cmdline contains the
 * substring "claude" — without this constraint, the previous `-f claude`
 * pattern matched the tracer in codex sandboxes, returned exit 0, but never
 * actually killed codex; the agent ran to completion and the ticket landed in
 * AI Review instead of Backlog.
 *
 * Agent kind is resolved from the ticket's `agent:<kind>` label using the
 * same `parseAgentKindOverride` the workflow runs server-side, so the helper
 * targets whichever agent the deployed app actually started.
 *
 * Returns `true` only when `pkill` actually terminated a matching process.
 * Returning `true` from "sandbox exists on the right branch" alone is unsafe:
 * there's a window between git checkout and the agent exec where the wrapper
 * is still sourcing env files — `pkill` then matches nothing (exit 1), the
 * agent starts a moment later, and runs to completion. Caller polls this
 * helper, so returning `false` on a no-op pkill makes the caller try again
 * instead of advancing.
 */
export async function killClaudeForTicket(
  ticketKey: string,
): Promise<boolean> {
  const expectedBranch = `blazebot/${ticketKey.trim().toLowerCase()}`;
  const { getTicketLabels } = await import("./jira.js");
  const { parseAgentKindOverride } = await import(
    "../../src/sandbox/agents/index.js"
  );
  const labels = await getTicketLabels(ticketKey).catch(() => [] as string[]);
  const labelKind = parseAgentKindOverride(labels);
  // Fall back to the same default the deployed app uses when no agent:* label
  // is present (env.AGENT_KIND, default "claude").
  const envFallback =
    process.env.E2E_AGENT_KIND?.toLowerCase() === "codex" ? "codex" : "claude";
  const agentKind = labelKind ?? envFallback;
  // Pattern targets a flag that appears only in the agent's wrapper-script
  // invocation, never in the Arthur tracer's argv. See claude.ts/codex.ts
  // buildPhaseScript for the exact command line.
  const killPattern = agentKind === "codex" ? "codex exec" : "claude --print";

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
      args: ["-9", "-f", killPattern],
    });
    if (killResult.exitCode === 0) return true;
    // Matched sandbox but agent wasn't running yet; caller will retry.
    return false;
  }
  return false;
}
