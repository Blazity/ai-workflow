import { logger } from "../lib/logger.js";
import { getSandboxCredentials } from "./credentials.js";

const BRANCH_PREFIX = "blazebot/";

/**
 * Best-effort cleanup for leaked sandboxes after ticket cancellation.
 * Finds running sandboxes whose checked-out branch matches the ticket branch
 * and requests stop on each match.
 */
export async function stopTicketSandboxes(ticketKey: string): Promise<number> {
  const normalizedTicket = ticketKey.trim().toLowerCase();
  if (!normalizedTicket) return 0;

  const expectedBranch = `${BRANCH_PREFIX}${normalizedTicket}`;

  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const credentials = getSandboxCredentials();
    const { json } = await Sandbox.list({ ...credentials, limit: 100 });
    const running = json.sandboxes.filter((sandbox) => sandbox.status === "running");

    let stopped = 0;
    for (const entry of running) {
      try {
        const sandbox = await Sandbox.get({
          ...credentials,
          sandboxId: entry.id,
        });
        if (sandbox.status !== "running") continue;

        const branch = await getSandboxBranch(sandbox);
        if (branch !== expectedBranch) continue;

        await sandbox.stop();
        stopped++;
      } catch (err) {
        logger.warn(
          {
            ticketKey,
            sandboxId: entry.id,
            error: (err as Error).message,
          },
          "cancel_run_sandbox_stop_failed",
        );
      }
    }

    if (stopped > 0) {
      logger.info(
        { ticketKey, expectedBranch, stopped },
        "cancel_run_stopped_ticket_sandboxes",
      );
    }
    return stopped;
  } catch (err) {
    logger.warn(
      { ticketKey, expectedBranch, error: (err as Error).message },
      "cancel_run_sandbox_discovery_failed",
    );
    return 0;
  }
}

async function getSandboxBranch(sandbox: {
  runCommand: (
    params: {
      cmd: string;
      args: string[];
      cwd: string;
    },
  ) => Promise<{ exitCode: number; stdout: () => Promise<string> }>;
}): Promise<string | null> {
  try {
    const result = await sandbox.runCommand({
      cmd: "git",
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: "/vercel/sandbox",
    });
    if (result.exitCode !== 0) return null;
    return (await result.stdout()).trim();
  } catch {
    return null;
  }
}
