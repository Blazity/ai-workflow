import { logger } from "../lib/logger.js";
import { getSandboxCredentials } from "./credentials.js";

const BRANCH_PREFIX = "blazebot/";

/**
 * Best-effort cleanup for leaked sandboxes after ticket cancellation.
 *
 * Fast path: if the caller knows the sandboxId (looked up from Redis via
 * `runRegistry.getSandboxId`), we issue a single `Sandbox.stop()` — no
 * discovery pass at all.
 *
 * Fallback path: scan all running sandboxes and inspect each one's checked-
 * out branch. Used when the caller doesn't have a sandboxId (older Redis
 * state, or a crash between `provisionSandbox` and the sandboxId being
 * written). The scan runs in parallel — serial iteration over N sandboxes
 * previously dominated cron's 300s budget when the environment was busy.
 */
export async function stopTicketSandboxes(
  ticketKey: string,
  knownSandboxId?: string | null,
): Promise<number> {
  const normalizedTicket = ticketKey.trim().toLowerCase();
  if (!normalizedTicket) return 0;

  const { Sandbox } = await import("@vercel/sandbox");
  const credentials = getSandboxCredentials();

  if (knownSandboxId) {
    try {
      const sandbox = await Sandbox.get({
        ...credentials,
        sandboxId: knownSandboxId,
      });
      if (sandbox.status === "running") {
        await sandbox.stop();
        logger.info(
          { ticketKey, sandboxId: knownSandboxId },
          "cancel_run_stopped_known_sandbox",
        );
        return 1;
      }
      return 0;
    } catch (err) {
      logger.warn(
        { ticketKey, sandboxId: knownSandboxId, error: (err as Error).message },
        "cancel_run_known_sandbox_stop_failed",
      );
      // Fall through to branch scan in case the id is stale.
    }
  }

  const expectedBranch = `${BRANCH_PREFIX}${normalizedTicket}`;

  try {
    const { json } = await Sandbox.list({ ...credentials, limit: 100 });
    const running = json.sandboxes.filter((sandbox) => sandbox.status === "running");

    const results = await Promise.all(
      running.map(async (entry): Promise<number> => {
        try {
          const sandbox = await Sandbox.get({
            ...credentials,
            sandboxId: entry.id,
          });
          if (sandbox.status !== "running") return 0;

          const branch = await getSandboxBranch(sandbox);
          if (branch !== expectedBranch) return 0;

          await sandbox.stop();
          return 1;
        } catch (err) {
          logger.warn(
            {
              ticketKey,
              sandboxId: entry.id,
              error: (err as Error).message,
            },
            "cancel_run_sandbox_stop_failed",
          );
          return 0;
        }
      }),
    );

    const stopped = results.reduce<number>((a, b) => a + b, 0);
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
