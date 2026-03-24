import { defineEventHandler, getHeader, createError } from "h3";
import { start, getRun } from "workflow/api";
import { Redis } from "@upstash/redis";
import { env } from "../../../env.js";
import { pollWorkflow } from "../../workflows/poll.js";
import { logger } from "../../lib/logger.js";

const POLL_WORKFLOW_KEY = "blazebot:poll-workflow";
const LOCK_KEY = "blazebot:poll-workflow:lock";
const LOCK_TTL_S = 30;

const redis = new Redis({
  url: env.AI_WORKFLOW_KV_REST_API_URL,
  token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
});

async function cancelExisting(): Promise<string | null> {
  const runId = await redis.get<string>(POLL_WORKFLOW_KEY);
  if (!runId) return null;

  try {
    const run = getRun(runId);
    await run.cancel();
    logger.info({ runId }, "poll_workflow_cancelled");
  } catch {
    // already dead or not found
  }

  await redis.del(POLL_WORKFLOW_KEY);
  return runId;
}

export default defineEventHandler(async (event) => {
  if (env.DEPLOY_HOOK_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.DEPLOY_HOOK_SECRET}`) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
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
    const cancelledRunId = await cancelExisting();
    const handle = await start(pollWorkflow);
    await redis.set(POLL_WORKFLOW_KEY, handle.runId);
    logger.info({ runId: handle.runId, cancelledRunId }, "poll_workflow_started");
    return { status: "restarted", runId: handle.runId, cancelledRunId };
  } finally {
    await redis.del(LOCK_KEY);
  }
});
