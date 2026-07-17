import { logger } from "../lib/logger.js";
import { getSandboxCredentials } from "./credentials.js";

/** Stop exactly the sandbox ids recorded for one owner; never discover by branch. */
export async function stopSandboxesByIds(sandboxIds: readonly string[]): Promise<number> {
  if (sandboxIds.length === 0) return 0;
  const { Sandbox } = await import("@vercel/sandbox");
  const credentials = getSandboxCredentials();
  const uniqueIds = [...new Set(sandboxIds)];
  const results = await Promise.all(
    uniqueIds.map(async (sandboxId): Promise<number> => {
      try {
        const sandbox = await Sandbox.get({ ...credentials, sandboxId });
        if (sandbox.status !== "running") return 0;
        await sandbox.stop();
        return 1;
      } catch (err) {
        logger.warn(
          { sandboxId, error: (err as Error).message },
          "owned_sandbox_stop_failed",
        );
        return 0;
      }
    }),
  );
  return results.reduce((total, count) => total + count, 0);
}
