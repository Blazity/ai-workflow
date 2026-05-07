import { timingSafeEqual } from "node:crypto";
import { defineEventHandler, readBody, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { logger } from "../../lib/logger.js";

/**
 * Forge app dispatch endpoint — invoked by the Jira Forge app's
 * `avi:jira:updated:issue` trigger when a ticket enters the AI column.
 *
 * Auth: X-Forge-Secret header matching FORGE_SHARED_SECRET. The Forge runtime
 * adds the header in `src/index.js` of ai-workflow-jira-app; the same secret
 * value is stored in Forge Storage and in this backend's env.
 *
 * Differs from /webhooks/jira: the Forge trigger has already filtered by
 * status, so we skip the column / live-state checks and dispatch directly.
 */
export default defineEventHandler(async (event) => {
  if (!env.FORGE_SHARED_SECRET) {
    throw createError({ statusCode: 503, statusMessage: "FORGE_SHARED_SECRET not configured" });
  }

  verifyForgeSecret(getHeader(event, "x-forge-secret"));

  const body = (await readBody(event)) as {
    issueKey?: string;
    cloudId?: string;
    source?: string;
  };

  if (!body?.issueKey) {
    throw createError({ statusCode: 400, statusMessage: "Missing issueKey" });
  }

  logger.info(
    { ticketKey: body.issueKey, cloudId: body.cloudId, source: body.source ?? "forge" },
    "forge_dispatch_received",
  );

  const adapters = createAdapters();
  const result = await dispatchTicket(body.issueKey, adapters, env.MAX_CONCURRENT_AGENTS);

  logger.info(
    { ticketKey: body.issueKey, started: result.started, reason: result.reason, runId: result.runId },
    "forge_dispatch_result",
  );

  return {
    status: result.started ? "dispatched" : "skipped",
    ticketKey: body.issueKey,
    reason: result.reason,
    runId: result.runId,
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
