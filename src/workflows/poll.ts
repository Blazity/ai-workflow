import { sleep } from "workflow";

async function discoverTickets(): Promise<string[]> {
  "use step";
  const { env } = await import("../../env.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { logger } = await import("../lib/logger.js");

  const { issueTracker } = createStepAdapters();

  const jql = `project = ${env.JIRA_PROJECT_KEY} AND status = "${env.COLUMN_AI}"`;
  const ticketKeys = await issueTracker.searchTickets(jql);

  logger.info({ ticketCount: ticketKeys.length }, "poll_discovered_tickets");

  return ticketKeys;
}

async function dispatchTickets(ticketKeys: string[]): Promise<number> {
  "use step";
  const { env } = await import("../../env.js");
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { logger } = await import("../lib/logger.js");
  const { Sandbox } = await import("@vercel/sandbox");
  const { start } = await import("workflow/api");
  const { implementationWorkflow } = await import("./implementation.js");
  const { reviewFixWorkflow } = await import("./review-fix.js");

  const { issueTracker, vcs, runRegistry } = createStepAdapters();

  let activeSandboxes = 0;
  try {
    let nextCursor: number | null = null;
    do {
      const { json } = await Sandbox.list({
        limit: 100,
        ...(nextCursor != null ? { until: nextCursor } : {}),
      });
      activeSandboxes += json.sandboxes.filter(
        (s: any) => s.status === "running",
      ).length;
      nextCursor = json.pagination.next;
    } while (nextCursor != null);
  } catch {
    // If we can't check, assume 0 and let sandbox provisioning fail if truly at capacity
  }

  const availableSlots = Math.max(
    0,
    env.MAX_CONCURRENT_AGENTS - activeSandboxes,
  );
  if (availableSlots === 0) {
    logger.info(
      { active: activeSandboxes, max: env.MAX_CONCURRENT_AGENTS },
      "poll_at_capacity",
    );
    return 0;
  }

  const started: string[] = [];

  for (const key of ticketKeys) {
    if (started.length >= availableSlots) break;

    const claimed = await runRegistry.claim(key, "claiming");
    if (!claimed) {
      logger.info({ ticketKey: key }, "poll_ticket_already_claimed");
      continue;
    }

    try {
      const ticket = await issueTracker.fetchTicket(key);
      const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
      const existingPR = await vcs.findPR(branchName);

      if (existingPR) {
        const handle = await start(reviewFixWorkflow, [ticket.id, branchName]);
        await runRegistry.register(ticket.identifier, handle.runId);
        logger.info(
          {
            ticketId: ticket.id,
            identifier: ticket.identifier,
            runId: handle.runId,
          },
          "workflow_started_review_fix",
        );
      } else {
        const handle = await start(implementationWorkflow, [ticket.id]);
        await runRegistry.register(ticket.identifier, handle.runId);
        logger.info(
          {
            ticketId: ticket.id,
            identifier: ticket.identifier,
            runId: handle.runId,
          },
          "workflow_started_implementation",
        );
      }

      started.push(ticket.identifier);
    } catch (err) {
      await runRegistry.unregister(key).catch(() => {});
      logger.warn(
        { ticketKey: key, error: (err as Error).message },
        "poll_ticket_dispatch_error",
      );
    }
  }

  return started.length;
}

async function reconcileRegistry(
  ticketKeys: string[],
): Promise<{ cancelled: number; cleaned: number }> {
  "use step";
  const { createStepAdapters } = await import("../lib/step-adapters.js");
  const { logger } = await import("../lib/logger.js");
  const { getRun } = await import("workflow/api");

  const { runRegistry } = createStepAdapters();

  const aiColumnSet = new Set(ticketKeys);
  const activeRuns = await runRegistry.listAll();
  let cancelled = 0;
  let cleaned = 0;

  for (const { ticketKey, runId } of activeRuns) {
    if (aiColumnSet.has(ticketKey)) {
      try {
        const run = getRun(runId);
        const status = await run.status;
        if (
          status === "completed" ||
          status === "failed" ||
          status === "cancelled"
        ) {
          await runRegistry.unregister(ticketKey);
          logger.info({ ticketKey, runId, status }, "poll_cleaned_dead_run");
          cleaned++;
        }
      } catch {
        await runRegistry.unregister(ticketKey).catch(() => {});
        logger.warn({ ticketKey, runId }, "poll_cleaned_unreachable_run");
        cleaned++;
      }
      continue;
    }

    try {
      const run = getRun(runId);
      await run.cancel();
      await runRegistry.unregister(ticketKey);
      logger.info({ ticketKey, runId }, "poll_cancelled_stale_run");
      cancelled++;
    } catch (err) {
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.warn(
        { ticketKey, runId, error: (err as Error).message },
        "poll_stale_run_cleanup_error",
      );
    }
  }

  return { cancelled, cleaned };
}

async function logCycleError(message: string): Promise<void> {
  "use step";
  const { logger } = await import("../lib/logger.js");
  logger.warn({ error: message }, "poll_cycle_failed");
}

export async function pollWorkflow() {
  "use workflow";

  const { env } = await import("../../env.js");

  while (true) {
    try {
      const ticketKeys = await discoverTickets();
      await dispatchTickets(ticketKeys);
      await reconcileRegistry(ticketKeys);
    } catch (err) {
      await logCycleError((err as Error).message);
    }
    await sleep(env.POLL_INTERVAL_MS);
  }
}
