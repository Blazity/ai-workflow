import { start, getRun } from "workflow/api";
import { Sandbox } from "@vercel/sandbox";
import { env } from "../../env.js";
import { agentWorkflow } from "../workflows/agent.js";
import { logger } from "./logger.js";
import type { Adapters } from "./adapters.js";
import { stopTicketSandboxes } from "../sandbox/stop-ticket-sandboxes.js";

const CLAIMING_PREFIX = "claiming:";
const SANDBOX_LIST_TIMEOUT_MS = 1_000;
const SANDBOX_LIST_PAGE_LIMIT = 100;
const SANDBOX_COUNT_FAILED = Number.MAX_SAFE_INTEGER;

export function isClaimingSentinel(runId: string): boolean {
  return runId.startsWith(CLAIMING_PREFIX);
}

export function getClaimTimestamp(runId: string): number {
  return parseInt(runId.slice(CLAIMING_PREFIX.length), 10);
}

export interface DispatchResult {
  started: boolean;
  runId?: string;
  reason?:
    | "already_claimed"
    | "at_capacity"
    | "error"
    | "previously_failed"
    | "not_in_ai_column"
    | "wrong_project_key";
}

export interface DispatchOptions {
  skipCapacityCheck?: boolean;
}

export async function dispatchTicket(
  ticketKey: string,
  adapters: Adapters,
  maxConcurrentAgents: number,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const expectedProjectKey = env.JIRA_PROJECT_KEY.trim().toUpperCase();
  const expectedAiStatus = env.COLUMN_AI.trim().toLowerCase();
  const { issueTracker, runRegistry } = adapters;
  let stage = "precheck_failed_marker";
  let claimHeld = false;
  let claimValue = "";
  try {
    logger.info({ ticketKey, maxConcurrentAgents }, "dispatch_attempt");

    if (await runRegistry.isTicketFailed(ticketKey)) {
      logger.info({ ticketKey }, "dispatch_skipped_previously_failed");
      return { started: false, reason: "previously_failed" };
    }

    if (!options.skipCapacityCheck) {
      stage = "precheck_capacity";
      if (await isAtCapacity(maxConcurrentAgents)) {
        return { started: false, reason: "at_capacity" };
      }
    } else {
      logger.info({ ticketKey }, "dispatch_capacity_check_skipped");
    }

    stage = "claim_ticket";
    claimValue = `${CLAIMING_PREFIX}${Date.now()}`;
    const claimed = await runRegistry.claim(ticketKey, claimValue);
    if (!claimed) {
      logger.info({ ticketKey }, "dispatch_already_claimed");
      return { started: false, reason: "already_claimed" };
    }
    claimHeld = true;

    stage = "fetch_ticket";
    const ticket = await issueTracker.fetchTicket(ticketKey);
    const ticketStatus = ticket.trackerStatus.trim().toLowerCase();
    if (ticketStatus !== expectedAiStatus) {
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.info(
        { ticketKey, ticketStatus: ticket.trackerStatus, expectedStatus: env.COLUMN_AI },
        "dispatch_skipped_not_in_ai_column",
      );
      return { started: false, reason: "not_in_ai_column" };
    }

    const ticketProjectKey = extractProjectKey(ticket.identifier);
    if (!ticketProjectKey || ticketProjectKey !== expectedProjectKey) {
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.info(
        {
          ticketKey,
          ticketIdentifier: ticket.identifier,
          ticketProjectKey,
          expectedProjectKey: env.JIRA_PROJECT_KEY,
        },
        "dispatch_skipped_wrong_project_key",
      );
      return { started: false, reason: "wrong_project_key" };
    }

    stage = "start_workflow";
    const handle = await start(agentWorkflow, [ticket.id]);
    logger.info(
      { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
      "workflow_started",
    );

    stage = "verify_claim_after_start";
    const claimStillHeld = await verifyClaimNotCancelled(
      ticketKey,
      claimValue,
      runRegistry,
    );
    if (!claimStillHeld) {
      await abortWorkflow(handle.runId, ticketKey);
      return { started: false, reason: "already_claimed" };
    }

    stage = "register_run";
    await runRegistry.register(ticketKey, handle.runId);
    return { started: true, runId: handle.runId };
  } catch (err) {
    if (claimHeld) {
      await runRegistry.unregister(ticketKey).catch(() => {});
    }
    logger.warn(
      { ticketKey, stage, error: (err as Error).message },
      "dispatch_error",
    );
    return { started: false, reason: "error" };
  }
}

async function isAtCapacity(max: number): Promise<boolean> {
  const active = await getActiveSandboxCount();
  if (active === SANDBOX_COUNT_FAILED) {
    logger.warn({ max }, "dispatch_capacity_check_failed_closed");
    return true;
  }
  if (active < max) return false;

  logger.info({ active, max }, "dispatch_at_capacity");
  return true;
}

async function getActiveSandboxCount(): Promise<number> {
  try {
    let runningCount = 0;
    let since: number | undefined;

    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SANDBOX_LIST_TIMEOUT_MS);
      try {
        const { json } = await Sandbox.list({
          limit: SANDBOX_LIST_PAGE_LIMIT,
          since,
          signal: controller.signal,
        });
        runningCount += json.sandboxes.filter(
          (sandbox: { status?: string }) => sandbox.status === "running",
        ).length;
        if (json.pagination.next == null) return runningCount;
        since = json.pagination.next;
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "sandbox_count_check_failed");
    return SANDBOX_COUNT_FAILED;
  }
}

async function verifyClaimNotCancelled(
  ticketKey: string,
  expectedClaimValue: string,
  runRegistry: Adapters["runRegistry"],
): Promise<boolean> {
  const currentValue = await runRegistry.getRunId(ticketKey);
  return currentValue === expectedClaimValue;
}

async function abortWorkflow(runId: string, ticketKey: string): Promise<void> {
  logger.info({ ticketKey, runId }, "dispatch_aborted_claim_cancelled");
  try {
    const run = getRun(runId);
    await run.cancel();
  } catch {}
  await stopTicketSandboxes(ticketKey).catch(() => {});
}

function extractProjectKey(ticketIdentifier: string): string | null {
  const trimmed = ticketIdentifier.trim();
  if (!trimmed) return null;
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex <= 0) return null;
  return trimmed.slice(0, dashIndex).toUpperCase();
}
