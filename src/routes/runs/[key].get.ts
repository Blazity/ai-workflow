import { timingSafeEqual } from "node:crypto";
import { defineEventHandler, getHeader, getRouterParam, createError } from "h3";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { logger } from "../../lib/logger.js";

/**
 * Returns the current run state for a ticket, used by the Forge issue panel.
 *
 * Shape is intentionally narrow — only what the panel renders. Phase / PR URL
 * are best-effort: the run registry tracks runId + sandboxId only, so richer
 * state would require either expanding the registry or reading from VCS.
 */
export default defineEventHandler(async (event) => {
  if (!env.FORGE_SHARED_SECRET) {
    throw createError({ statusCode: 503, statusMessage: "FORGE_SHARED_SECRET not configured" });
  }

  verifyForgeSecret(getHeader(event, "x-forge-secret"));

  const issueKey = getRouterParam(event, "key");
  if (!issueKey) {
    throw createError({ statusCode: 400, statusMessage: "Missing issueKey" });
  }

  const adapters = createAdapters();
  const runId = await adapters.runRegistry.getRunId(issueKey);

  if (!runId) {
    const failed = await adapters.runRegistry.isTicketFailed(issueKey).catch(() => false);
    if (failed) {
      return { status: "failed", issueKey };
    }
    setResponseStatus(event, 404);
    return { status: "idle", issueKey };
  }

  const sandboxId = await adapters.runRegistry.getSandboxId(issueKey).catch(() => null);

  // Branch convention is set in agent.ts: `blazebot/{ticketKey-lowercase}`.
  // Mirror it here so the panel can show a PR link without expanding the
  // run registry schema.
  let prUrl: string | null = null;
  try {
    const branchName = `blazebot/${issueKey.toLowerCase()}`;
    const pr = await adapters.vcs.findPR(branchName);
    prUrl = pr?.url ?? null;
  } catch (err) {
    logger.debug({ issueKey, error: (err as Error).message }, "forge_runs_pr_lookup_failed");
  }

  return {
    status: "active",
    issueKey,
    runId,
    sandboxId,
    prUrl,
  };
});

function verifyForgeSecret(received: string | undefined): void {
  if (!received) {
    throw createError({ statusCode: 401, statusMessage: "Missing X-Forge-Secret header" });
  }
  const expected = env.FORGE_SHARED_SECRET!;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid forge secret" });
  }
}

function setResponseStatus(event: Parameters<typeof getHeader>[0], status: number): void {
  // h3 has setResponseStatus but importing it here to keep the file's imports
  // explicit and self-contained.
  (event.node?.res ?? (event as any).res).statusCode = status;
}
