import { start } from "workflow/api";
import { implementationWorkflow } from "../workflows/implementation.js";
import { reviewFixWorkflow } from "../workflows/review-fix.js";
import { logger } from "./logger.js";
import type { Adapters } from "./adapters.js";

export const CLAIMING_SENTINEL = "claiming";

async function getActiveSandboxCount(): Promise<number> {
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { json } = await Sandbox.list({ limit: 100 });
    return json.sandboxes.filter((s: any) => s.status === "running").length;
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      "sandbox_count_check_failed",
    );
    return 0;
  }
}

export interface DispatchResult {
  started: boolean;
  runId?: string;
  reason?: "already_claimed" | "at_capacity" | "error";
}

export async function dispatchTicket(
  ticketKey: string,
  adapters: Adapters,
  maxConcurrentAgents: number,
): Promise<DispatchResult> {
  const { issueTracker, vcs, runRegistry } = adapters;

  const activeSandboxes = await getActiveSandboxCount();
  if (activeSandboxes >= maxConcurrentAgents) {
    logger.info(
      { active: activeSandboxes, max: maxConcurrentAgents },
      "dispatch_at_capacity",
    );
    return { started: false, reason: "at_capacity" };
  }

  const claimed = await runRegistry.claim(ticketKey, CLAIMING_SENTINEL);
  if (!claimed) {
    logger.info({ ticketKey }, "dispatch_ticket_already_claimed");
    return { started: false, reason: "already_claimed" };
  }

  try {
    const ticket = await issueTracker.fetchTicket(ticketKey);
    const branchName = `blazebot/${ticket.identifier.toLowerCase()}`;
    const existingPR = await vcs.findPR(branchName);

    let handle;
    if (existingPR) {
      handle = await start(reviewFixWorkflow, [ticket.id, branchName]);
      logger.info(
        {
          ticketId: ticket.id,
          identifier: ticket.identifier,
          runId: handle.runId,
        },
        "workflow_started_review_fix",
      );
    } else {
      handle = await start(implementationWorkflow, [ticket.id]);
      logger.info(
        {
          ticketId: ticket.id,
          identifier: ticket.identifier,
          runId: handle.runId,
        },
        "workflow_started_implementation",
      );
    }

    await runRegistry.register(ticket.identifier, handle.runId);
    return { started: true, runId: handle.runId };
  } catch (err) {
    await runRegistry.unregister(ticketKey).catch(() => {});
    logger.warn(
      { ticketKey, error: (err as Error).message },
      "dispatch_ticket_error",
    );
    return { started: false, reason: "error" };
  }
}
