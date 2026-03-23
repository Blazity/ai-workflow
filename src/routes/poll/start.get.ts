import { defineEventHandler, getHeader, createError } from "h3";
import { start, getRun } from "workflow/api";
import { Redis } from "@upstash/redis";
import { env } from "../../../env.js";
import { pollWorkflow } from "../../workflows/poll.js";
import { logger } from "../../lib/logger.js";

const POLL_WORKFLOW_KEY = "blazebot:poll-workflow";
const LOCK_KEY = "blazebot:poll-workflow:lock";
const LOCK_TTL_S = 30;
const ALIVE_STATUSES: string[] = ["running", "pending"];

const redis = new Redis({
  url: env.AI_WORKFLOW_KV_REST_API_URL,
  token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
});

export default defineEventHandler(async (event) => {
  if (env.CRON_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
  }

  const existingRunId = await redis.get<string>(POLL_WORKFLOW_KEY);

  if (existingRunId) {
    try {
      const run = getRun(existingRunId);
      const status = await run.status;
      if (ALIVE_STATUSES.includes(status)) {
        return { status: "already_running", runId: existingRunId };
      }
    } catch {
      // Run not found — fall through to start a new one
    }
  }

  const acquired = await redis.set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_S });
  if (!acquired) {
    return {
      status: "lock_contention",
      message: "Another start request is in progress",
    };
  }

  try {
    const recheckRunId = await redis.get<string>(POLL_WORKFLOW_KEY);
    if (recheckRunId) {
      try {
        const run = getRun(recheckRunId);
        const status = await run.status;
        if (ALIVE_STATUSES.includes(status)) {
          return { status: "already_running", runId: recheckRunId };
        }
      } catch {
        // Fall through to start
      }
    }

    const handle = await start(pollWorkflow);
    await redis.set(POLL_WORKFLOW_KEY, handle.runId);
    logger.info({ runId: handle.runId }, "poll_workflow_started");
    return { status: "started", runId: handle.runId };
  } finally {
    await redis.del(LOCK_KEY);
  }
});
