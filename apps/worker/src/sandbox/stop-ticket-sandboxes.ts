import { logger } from "../lib/logger.js";
import { getSandboxCredentials } from "./credentials.js";

/** Stop exactly the sandbox ids recorded for one owner; never discover by branch. */
export async function stopSandboxesByIds(sandboxIds: readonly string[]): Promise<number> {
  if (sandboxIds.length === 0) return 0;
  const { Sandbox } = await import("@vercel/sandbox");
  const credentials = getSandboxCredentials();
  const uniqueIds = [...new Set(sandboxIds)];
  const results = await Promise.all(
    uniqueIds.map(async (sandboxId): Promise<{ stopped: number; failed: boolean }> => {
      try {
        const sandbox = await Sandbox.get({ ...credentials, sandboxId });
        if (sandbox.status !== "running") return { stopped: 0, failed: false };
        await sandbox.stop();
        return { stopped: 1, failed: false };
      } catch (err) {
        if (isNotFoundError(err)) return { stopped: 0, failed: false };
        logger.warn(
          { sandboxId, error: (err as Error).message },
          "owned_sandbox_stop_failed",
        );
        return { stopped: 0, failed: true };
      }
    }),
  );
  const failedIds = uniqueIds.filter((_, index) => results[index]?.failed);
  if (failedIds.length > 0) {
    throw new Error(`owned sandbox cleanup unconfirmed: ${failedIds.join(", ")}`);
  }
  return results.reduce((total, result) => total + result.stopped, 0);
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.code === "NOT_FOUND"
  );
}
