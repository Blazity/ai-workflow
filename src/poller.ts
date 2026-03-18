import { eq, and, inArray, lt } from "drizzle-orm";
import { env } from "./env.js";
import { db } from "./db.js";
import { tickets, runAttempts } from "./schema.js";
import { ticketQueue, defaultJobOptions } from "./queue.js";
import { JiraClient } from "./adapters/jira-client.js";
import { createMessagingAdapter } from "./adapters/messaging-factory.js";
import { teardownContainer } from "./sandbox/manager.js";
import { createLogger } from "./logger.js";

const logger = createLogger();

function createAdapters() {
  const jira = new JiraClient(
    env.JIRA_BASE_URL!,
    env.JIRA_USER_EMAIL!,
    env.JIRA_API_TOKEN!,
  );
  const messaging = createMessagingAdapter(
    env.MESSAGING_KIND,
    env.SLACK_BOT_TOKEN,
    env.SLACK_DEFAULT_CHANNEL,
  );
  return { jira, messaging };
}

export async function runMaintenancePoll(): Promise<void> {
  logger.info("poll_started");

  const adapters = createAdapters();
  await Promise.allSettled([
    checkMissedWebhooks(adapters),
    checkStuckJobs(adapters),
  ]);

  logger.info("poll_completed");
}

async function checkMissedWebhooks(adapters: ReturnType<typeof createAdapters>): Promise<void> {
  const projectKey = env.JIRA_PROJECT_KEY;
  if (!projectKey) return;

  const { jira } = adapters;

  let ticketKeys: string[];
  try {
    ticketKeys = await jira.searchTickets(
      `status = "${env.COLUMN_AI}" AND project = ${projectKey}`,
    );
  } catch (err) {
    logger.error({ error: (err as Error).message }, "poll_jira_error");
    return;
  }

  if (ticketKeys.length === 0) return;

  const existingTickets = await db
    .select()
    .from(tickets)
    .where(
      and(
        inArray(tickets.externalId, ticketKeys),
        eq(tickets.source, "jira"),
      ),
    );
  const existingMap = new Map(existingTickets.map(t => [t.externalId, t]));

  for (const ticketId of ticketKeys) {
    const ticket = existingMap.get(ticketId);

    if (!ticket) {
      const [created] = await db
        .insert(tickets)
        .values({
          externalId: ticketId,
          identifier: ticketId,
          source: "jira",
          state: env.COLUMN_AI,
          workflowState: "queued",
          assignee: "poller",
        })
        .returning();

      await ticketQueue.add(
        "implementation",
        {
          type: "implementation",
          ticketId,
          source: "jira",
          triggeredBy: "poller",
        },
        { ...defaultJobOptions, jobId: `impl-${ticketId}-${created!.id}` },
      );
      logger.info({ ticketId }, "poll_ticket_discovered");
      continue;
    }

    if (ticket.workflowState === "failed") {
      await db
        .update(tickets)
        .set({ workflowState: "queued", updatedAt: new Date() })
        .where(eq(tickets.id, ticket.id));

      await ticketQueue.add(
        "implementation",
        {
          type: "implementation",
          ticketId,
          source: "jira",
          triggeredBy: ticket.assignee ?? "poller",
        },
        { ...defaultJobOptions, jobId: `impl-${ticketId}-${ticket.id}-${Date.now()}` },
      );
      logger.info({ ticketId }, "poll_ticket_discovered");
    }

  }
}

async function checkStuckJobs(adapters: ReturnType<typeof createAdapters>): Promise<void> {
  const { messaging } = adapters;
  const thresholdMs = env.STUCK_JOB_THRESHOLD_MS ?? env.JOB_TIMEOUT_MS * 2;
  const cutoff = new Date(Date.now() - thresholdMs);

  const stuckTickets = await db
    .select()
    .from(tickets)
    .where(
      and(
        inArray(tickets.workflowState, ["implementing", "fixing_feedback"]),
        lt(tickets.updatedAt, cutoff),
      ),
    );

  if (stuckTickets.length === 0) return;

  for (const ticket of stuckTickets) {
    logger.info({ ticketId: ticket.externalId, workflowState: ticket.workflowState }, "stuck_job_detected");

    if (ticket.currentRunId) {
      const runRows = await db
        .select()
        .from(runAttempts)
        .where(eq(runAttempts.id, ticket.currentRunId));
      const activeRun = runRows[0];

      if (activeRun?.containerId) {
        try {
          await teardownContainer(activeRun.containerId);
          logger.info({ ticketId: ticket.externalId, containerId: activeRun.containerId }, "stuck_container_teardown");
        } catch {}
      }

      if (activeRun) {
        await db
          .update(runAttempts)
          .set({ status: "timed_out", finishedAt: new Date() })
          .where(eq(runAttempts.id, activeRun.id));
      }
    }

    const attempts = await db
      .select()
      .from(runAttempts)
      .where(eq(runAttempts.ticketId, ticket.id));

    const attemptCount = attempts.length;

    if (attemptCount >= env.JOB_MAX_RETRIES + 1) {
      await db
        .update(tickets)
        .set({ workflowState: "failed", currentRunId: null, updatedAt: new Date() })
        .where(eq(tickets.id, ticket.id));

      await messaging.notify(
        ticket.assignee ?? "poller",
        `Task ${ticket.externalId} stuck and retries exhausted after ${attemptCount} attempts`,
      );
      logger.info({ ticketId: ticket.externalId, attemptCount }, "stuck_job_exhausted");
      continue;
    }

    const jobType = ticket.workflowState === "fixing_feedback" ? "review_fix" : "implementation";

    await db
      .update(tickets)
      .set({ workflowState: "queued", currentRunId: null, updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await ticketQueue.add(
      jobType,
      {
        type: jobType,
        ticketId: ticket.externalId,
        source: "jira",
        triggeredBy: ticket.assignee ?? "poller",
      },
      { ...defaultJobOptions, jobId: `${jobType === "review_fix" ? "fix" : "impl"}-${ticket.externalId}-${ticket.id}-${Date.now()}` },
    );

    await messaging.notify(
      ticket.assignee ?? "poller",
      `Task ${ticket.externalId} appeared stuck — re-enqueued automatically`,
    );
    logger.info({ ticketId: ticket.externalId, jobType }, "stuck_job_recovered");
  }
}
