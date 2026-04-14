import { start, getRun } from "workflow/api";
import { env } from "../../env.js";
import { agentWorkflow } from "../workflows/agent.js";
import { logger } from "./logger.js";
import type { Adapters } from "./adapters.js";

const CLAIMING_PREFIX = "claiming:";
const EXPECTED_PROJECT_KEY = env.JIRA_PROJECT_KEY.trim().toUpperCase();
const EXPECTED_AI_STATUS = env.COLUMN_AI.trim().toLowerCase();

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

export async function dispatchTicket(
  ticketKey: string,
  adapters: Adapters,
  maxConcurrentAgents: number,
): Promise<DispatchResult> {
  const { issueTracker, runRegistry } = adapters;

  if (await runRegistry.isTicketFailed(ticketKey)) {
    logger.info({ ticketKey }, "dispatch_skipped_previously_failed");
    return { started: false, reason: "previously_failed" };
  }

  if (await isAtCapacity(maxConcurrentAgents)) {
    return { started: false, reason: "at_capacity" };
  }

  const claimValue = `${CLAIMING_PREFIX}${Date.now()}`;
  const claimed = await runRegistry.claim(ticketKey, claimValue);
  if (!claimed) {
    logger.info({ ticketKey }, "dispatch_already_claimed");
    return { started: false, reason: "already_claimed" };
  }

  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);
    const ticketStatus = ticket.trackerStatus.trim().toLowerCase();
    if (ticketStatus !== EXPECTED_AI_STATUS) {
      await runRegistry.unregister(ticketKey).catch(() => {});
      logger.info(
        { ticketKey, ticketStatus: ticket.trackerStatus, expectedStatus: env.COLUMN_AI },
        "dispatch_skipped_not_in_ai_column",
      );
      return { started: false, reason: "not_in_ai_column" };
    }

    const ticketProjectKey = extractProjectKey(ticket.identifier);
    if (!ticketProjectKey || ticketProjectKey !== EXPECTED_PROJECT_KEY) {
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

    const handle = await start(agentWorkflow, [ticket.id]);
    logger.info(
      { ticketId: ticket.id, identifier: ticket.identifier, runId: handle.runId },
      "workflow_started",
    );

    const claimStillHeld = await verifyClaimNotCancelled(
      ticketKey,
      claimValue,
      runRegistry,
    );
    if (!claimStillHeld) {
      await abortWorkflow(handle.runId, ticketKey);
      return { started: false, reason: "already_claimed" };
    }

    await runRegistry.register(ticketKey, handle.runId);
    return { started: true, runId: handle.runId };
  } catch (err) {
    await runRegistry.unregister(ticketKey).catch(() => {});
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "dispatch_error",
    );
    return { started: false, reason: "error" };
  }
}

async function isAtCapacity(max: number): Promise<boolean> {
  const active = await getActiveSandboxCount();
  if (active < max) return false;

  logger.info({ active, max }, "dispatch_at_capacity");
  return true;
}

async function getActiveSandboxCount(): Promise<number> {
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { json } = await Sandbox.list({ limit: 100 });
    return json.sandboxes.filter((s: any) => s.status === "running").length;
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "sandbox_count_check_failed");
    return 0;
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
}

function extractProjectKey(ticketIdentifier: string): string | null {
  const trimmed = ticketIdentifier.trim();
  if (!trimmed) return null;
  const dashIndex = trimmed.indexOf("-");
  if (dashIndex <= 0) return null;
  return trimmed.slice(0, dashIndex).toUpperCase();
}
