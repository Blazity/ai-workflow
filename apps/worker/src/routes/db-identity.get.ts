import { defineEventHandler, getHeader, createError } from "h3";
import { neon } from "@neondatabase/serverless";
import { env } from "../../env.js";

/**
 * TEMPORARY DEBUG ENDPOINT — remove after diagnosing the e2e split-brain.
 *
 * Reports which Neon branch this *running* deployment actually talks to.
 * The e2e harness seeds rows on the branch in its DATABASE_URL and expects
 * the deployment to read/write the SAME branch; if a stale deployment is
 * still injecting an old DATABASE_URL, the registry tests fail. This proves
 * the runtime host + does a real query roundtrip (env_marker + row counts)
 * so two migrated branches can be told apart (e.g. ep-late-mode has the demo
 * history; the empty split-brain branch has ~0 rows).
 *
 * Gated behind CRON_SECRET so it isn't fully public.
 */
export default defineEventHandler(async (event) => {
  if (env.CRON_SECRET) {
    const auth = getHeader(event, "authorization");
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    }
  }

  // Host the worker actually connects through (getDb() uses this same value).
  const host = (() => {
    try {
      return new URL(env.DATABASE_URL).host;
    } catch {
      return "unparseable";
    }
  })();

  const sql = neon(env.DATABASE_URL);
  const probe = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await fn();
    } catch (err) {
      return { error: (err as Error).message };
    }
  };

  const [marker, workflowRuns, activeRuns] = await Promise.all([
    probe(async () => (await sql`SELECT env, endpoint_host FROM env_marker LIMIT 1`)[0] ?? null),
    probe(async () => (await sql`SELECT count(*)::int AS n FROM workflow_runs`)[0]?.n),
    probe(async () => (await sql`SELECT count(*)::int AS n FROM active_runs`)[0]?.n),
  ]);

  return {
    dbHost: host,
    envMarker: marker,
    counts: { workflowRuns, activeRuns },
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
  };
});
