import { defineEventHandler, getHeader, createError } from "h3";
import { start, getRun } from "workflow/api";
import { Redis } from "@upstash/redis";
import { env } from "../../../env.js";
import { pollWorkflow } from "../../workflows/poll.js";
import { logger } from "../../lib/logger.js";

const POLL_WORKFLOW_KEY = "blazebot:poll-workflow";

export default defineEventHandler(async (event) => {
  if (env.CRON_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
  }

  const redis = new Redis({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
  });

  const existingRunId = await redis.get<string>(POLL_WORKFLOW_KEY);

  if (existingRunId) {
    try {
      const run = getRun(existingRunId);
      const status = await run.status;
      if (status === "running") {
        return { status: "already_running", runId: existingRunId };
      }
    } catch {
      // Run not found — fall through to start a new one
    }
  }

  const handle = await start(pollWorkflow);
  await redis.set(POLL_WORKFLOW_KEY, handle.runId);
  logger.info({ runId: handle.runId }, "poll_workflow_started");
  return { status: "started", runId: handle.runId };
});
