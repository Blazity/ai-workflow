import {
  createError,
  defineEventHandler,
  getHeader,
  setResponseHeader,
} from "h3";
import { env } from "../../../env.js";
import { getDb } from "../../db/client.js";
import { prewarmHarnessCapabilityCatalogs } from "../../harness-profiles/capability-catalog.js";
import { logger } from "../../lib/logger.js";

export default defineEventHandler(async (event) => {
  verifyCronAuth(getHeader(event, "authorization"));
  setResponseHeader(event, "Cache-Control", "private, no-store");

  const result = await prewarmHarnessCapabilityCatalogs(getDb());
  logger.info(
    {
      event: "harness_capability_prewarm",
      ...result,
    },
    "Harness capability prewarm completed",
  );
  return { status: "ok", ...result };
});

function verifyCronAuth(authHeader: string | undefined): void {
  if (!env.CRON_SECRET) return;
  if (authHeader === `Bearer ${env.CRON_SECRET}`) return;
  throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
}
