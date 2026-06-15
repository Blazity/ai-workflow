import { defineEventHandler, getHeader, createError } from "h3";
import { getWorld } from "workflow/runtime";
import { env } from "../../../env.js";
import { createAdapters } from "../../lib/adapters.js";
import { dispatchTicket } from "../../lib/dispatch.js";
import { reconcileRuns } from "../../lib/reconcile.js";
import { logger } from "../../lib/logger.js";
import { GateStore } from "../../post-pr-gate/gate-store.js";
import { getDb } from "../../db/client.js";
import { collectSnapshots } from "../../lib/telemetry/collect-snapshots.js";
import { upsertRunSnapshots } from "../../lib/telemetry/run-telemetry.js";
import type { RunsLister } from "../../lib/overview/collect-runs.js";

export default defineEventHandler(async (event) => {
  verifyCronAuth(getHeader(event, "authorization"));

  const adapters = createAdapters();
  const ticketKeys = await discoverAiColumnTickets(adapters);
  const started = await dispatchDiscoveredTickets(ticketKeys, adapters);
  const { cancelled, cleaned } = await reconcileRuns(
    new Set(ticketKeys),
    adapters.runRegistry,
    adapters.issueTracker,
    async (ticketKey, reason) => {
      const detail =
        reason === "inflight_claim"
          ? "claim was cleared after the ticket left AI"
          : "workflow run was cancelled after the ticket left AI";
      await adapters.messaging.notifyForTicket(ticketKey, {
        kind: "canceled",
        reason: `${detail}.`,
      });
    },
  );

  // Housekeeping: physically drop expired gate rows (reads already treat
  // them as absent). Best-effort — a failed purge must not fail the poll.
  await new GateStore(getDb())
    .purgeExpired()
    .catch((err) => logger.warn({ err: (err as Error).message }, "poll_gate_purge_failed"));

  // Telemetry: snapshot run lifecycle from the Workflow world into Neon so run
  // history, active counts and durations stay SQL-queryable beyond Vercel's
  // ~24h observability window. Per-run cost is filled separately by the agent
  // workflow. Best-effort — a failed snapshot must not fail the poll.
  try {
    const db = getDb();
    const snapshots = await collectSnapshots({
      runsLister: getWorld().runs as RunsLister,
      db,
    });
    await upsertRunSnapshots(db, snapshots);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "poll_snapshot_failed");
  }

  return {
    status: "ok",
    discovered: ticketKeys.length,
    started: started.length,
    cancelled,
    cleaned,
  };
});

function verifyCronAuth(authHeader: string | undefined): void {
  if (!env.CRON_SECRET) return;
  if (authHeader === `Bearer ${env.CRON_SECRET}`) return;

  throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
}

async function discoverAiColumnTickets(
  adapters: ReturnType<typeof createAdapters>,
): Promise<string[]> {
  const jql = `project = "${env.JIRA_PROJECT_KEY}" AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await adapters.issueTracker.searchTickets(jql);
  const normalizedKeys = normalizeTicketKeys(ticketKeys);

  if (normalizedKeys.length !== ticketKeys.length) {
    logger.warn(
      {
        discovered: ticketKeys.length,
        valid: normalizedKeys.length,
        expectedProjectKey: env.JIRA_PROJECT_KEY,
      },
      "poll_discarded_invalid_ticket_keys",
    );
  }

  logger.info({ ticketCount: normalizedKeys.length }, "poll_discovered_tickets");
  return normalizedKeys;
}

async function dispatchDiscoveredTickets(
  ticketKeys: string[],
  adapters: ReturnType<typeof createAdapters>,
): Promise<string[]> {
  // Dispatch in parallel. dispatchTicket is internally atomic — the
  // post-claim fairness check in src/lib/dispatch.ts caps started
  // workflows at MAX_CONCURRENT_AGENTS even when racers run concurrently,
  // so excess parallel dispatches safely return `at_capacity`.
  const results = await Promise.all(
    ticketKeys.map(async (key) => {
      try {
        const result = await dispatchTicket(
          key,
          adapters,
          env.MAX_CONCURRENT_AGENTS,
        );
        return { key, started: result.started };
      } catch (err) {
        logger.warn({ ticketKey: key, error: err }, "poll_dispatch_failed");
        return { key, started: false };
      }
    }),
  );

  return results.filter((r) => r.started).map((r) => r.key);
}

function normalizeTicketKeys(ticketKeys: string[]): string[] {
  const expectedPrefix = `${env.JIRA_PROJECT_KEY.trim().toUpperCase()}-`;
  const unique = new Set<string>();

  for (const rawKey of ticketKeys) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) continue;
    const normalizedKey = key.toUpperCase();
    if (!normalizedKey.startsWith(expectedPrefix)) continue;
    unique.add(normalizedKey);
  }

  return [...unique];
}
