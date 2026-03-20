import { defineEventHandler, getHeader } from "nitro/h3";
import { start } from "workflow/api";
import { pollOnceWorkflow } from "../../workflows/maintenance.js";
import { createLogger } from "@blazebot/shared";

const logger = createLogger();

export default defineEventHandler(async (event) => {
  // Verify the request comes from Vercel Cron
  const authHeader = getHeader(event, "authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return { status: 401, error: "Unauthorized" };
  }

  const handle = await start(pollOnceWorkflow, [], {
    id: `cron-poll-${Date.now()}`,
  });

  logger.info({ workflowRunId: handle.runId }, "cron_poll_started");
  return { status: "ok", runId: handle.runId };
});
