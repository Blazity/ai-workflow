// packages/app/src/workflows/maintenance.ts
import { sleep } from "workflow";
import { eq, and, inArray, lt } from "drizzle-orm";
import {
  env,
  db,
  tickets,
  runAttempts,
  JiraClient,
  createMessagingAdapter,
  createLogger,
} from "@blazebot/shared";
import { appEnv } from "../env.js";
import {
  startWorkflowRun,
  cancelWorkflowRun,
} from "../lib/workflow-helpers.js";
import { implementTicket } from "./implementation.js";
import { reviewFixTicket } from "./review-fix.js";

const logger = createLogger();

// ── Workflow: infinite polling loop ────────────────────────────────

export async function maintenanceLoop() {
  "use workflow";

  // Run forever with sleep between polls
  while (true) {
    await pollOnce();
    await sleep(`${appEnv.POLL_INTERVAL_MS}ms`);
  }
}

// ── Steps ──────────────────────────────────────────────────────────

async function pollOnce() {
  "use step";
  logger.info("poll_started");
  await Promise.allSettled([checkMissedWebhooks(), checkStuckJobs()]);
  logger.info("poll_completed");
}

// ── Helper functions called inside the pollOnce step ───────────────

function createMessaging() {
  return createMessagingAdapter(
    env.MESSAGING_KIND,
    env.SLACK_BOT_TOKEN,
    env.SLACK_DEFAULT_CHANNEL,
  );
}

async function checkMissedWebhooks(): Promise<void> {
  if (
    !appEnv.JIRA_BASE_URL ||
    !appEnv.JIRA_USER_EMAIL ||
    !appEnv.JIRA_API_TOKEN
  ) {
    logger.warn("poll_jira_skipped_no_credentials");
    return;
  }

  const jira = new JiraClient(
    appEnv.JIRA_BASE_URL,
    appEnv.JIRA_USER_EMAIL,
    appEnv.JIRA_API_TOKEN,
  );

  let ticketKeys: string[];
  try {
    ticketKeys = await jira.searchTickets(
      `status = "${env.COLUMN_AI}" AND project = ${appEnv.JIRA_PROJECT_KEY}`,
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
      and(inArray(tickets.externalId, ticketKeys), eq(tickets.source, "jira")),
    );
  const existingMap = new Map(existingTickets.map((t) => [t.externalId, t]));

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
        .onConflictDoNothing()
        .returning();
      if (!created) continue;
      await startWorkflowRun({
        ticketRowId: created.id,
        ticketExternalId: ticketId,
        type: "implementation",
        workflow: implementTicket,
        workflowArgs: [ticketId, "jira", "poller"],
        dedupeId: `impl-${ticketId}-${created.id}`,
      });
      logger.info({ ticketId }, "poll_ticket_discovered");
      continue;
    }

    if (ticket.workflowState === "failed") {
      const attempts = await db
        .select()
        .from(runAttempts)
        .where(eq(runAttempts.ticketId, ticket.id));

      if (attempts.length >= env.JOB_MAX_RETRIES + 1) {
        logger.info(
          { ticketId, attemptCount: attempts.length },
          "poll_failed_ticket_exhausted",
        );
        continue;
      }

      await db
        .update(tickets)
        .set({ workflowState: "queued", updatedAt: new Date() })
        .where(eq(tickets.id, ticket.id));

      await startWorkflowRun({
        ticketRowId: ticket.id,
        ticketExternalId: ticketId,
        type: "implementation",
        workflow: implementTicket,
        workflowArgs: [ticketId, "jira", ticket.assignee ?? "poller"],
        dedupeId: `impl-${ticketId}-${ticket.id}-${Date.now()}`,
      });
      logger.info({ ticketId }, "poll_failed_ticket_reenqueued");
    }
  }
}

async function checkStuckJobs(): Promise<void> {
  const messaging = createMessaging();
  const thresholdMs =
    appEnv.STUCK_JOB_THRESHOLD_MS ?? appEnv.JOB_TIMEOUT_MS * 2;
  const cutoff = new Date(Date.now() - thresholdMs);

  const stuckTickets = await db
    .select()
    .from(tickets)
    .where(
      and(
        inArray(tickets.workflowState, [
          "queued",
          "implementing",
          "fixing_feedback",
        ]),
        lt(tickets.updatedAt, cutoff),
      ),
    );

  if (stuckTickets.length === 0) return;

  for (const ticket of stuckTickets) {
    logger.info(
      { ticketId: ticket.externalId, workflowState: ticket.workflowState },
      "stuck_job_detected",
    );

    if (ticket.currentRunId) {
      const runRows = await db
        .select()
        .from(runAttempts)
        .where(eq(runAttempts.id, ticket.currentRunId));
      const activeRun = runRows[0];

      if (activeRun) {
        await cancelWorkflowRun({
          runAttemptId: activeRun.id,
          workflowRunId: activeRun.workflowRunId,
          containerId: activeRun.containerId,
          ticketExternalId: ticket.externalId,
        });
        // Override status: stuck jobs timed out, not user-cancelled
        await db
          .update(runAttempts)
          .set({ status: "timed_out" })
          .where(eq(runAttempts.id, activeRun.id));
      }
    }

    const attempts = await db
      .select()
      .from(runAttempts)
      .where(eq(runAttempts.ticketId, ticket.id));

    if (attempts.length >= env.JOB_MAX_RETRIES + 1) {
      await db
        .update(tickets)
        .set({
          workflowState: "failed",
          currentRunId: null,
          updatedAt: new Date(),
        })
        .where(eq(tickets.id, ticket.id));
      await messaging.notify(
        ticket.assignee ?? "poller",
        `Task ${ticket.externalId} stuck and retries exhausted after ${attempts.length} attempts`,
      );
      continue;
    }

    const jobType =
      ticket.workflowState === "fixing_feedback"
        ? "review_fix"
        : "implementation";
    const workflowFn =
      jobType === "review_fix" ? reviewFixTicket : implementTicket;

    await db
      .update(tickets)
      .set({
        workflowState: "queued",
        currentRunId: null,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, ticket.id));

    await startWorkflowRun({
      ticketRowId: ticket.id,
      ticketExternalId: ticket.externalId,
      type: jobType === "review_fix" ? "review_fix" : "implementation",
      workflow: workflowFn,
      workflowArgs: [
        ticket.externalId,
        ticket.source as "jira" | "linear",
        ticket.assignee ?? "poller",
      ],
      dedupeId: `${jobType === "review_fix" ? "fix" : "impl"}-${ticket.externalId}-${ticket.id}-${Date.now()}`,
    });

    await messaging.notify(
      ticket.assignee ?? "poller",
      `Task ${ticket.externalId} appeared stuck -- re-enqueued automatically`,
    );
    logger.info(
      { ticketId: ticket.externalId, jobType },
      "stuck_job_recovered",
    );
  }
}
