import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { env } from "../../env.js";
import type { RunKind, RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";
import { getDb } from "../db/client.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../workflow-definition/store.js";
import {
  BUILTIN_FALLBACK_DEFINITION_VERSION,
  type AgentWorkflowInput,
  type WorkflowDefinitionVersionPin,
} from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import type { Adapters } from "./adapters.js";
import { logger } from "./logger.js";
import { ticketSubjectKey } from "./subject-key.js";

export const STALE_CLAIM_MS = 5 * 60 * 1000;

export interface DispatchResult {
  started: boolean;
  runId?: string;
  reason?:
    | "already_claimed"
    | "at_capacity"
    | "error"
    | "previously_failed"
    | "not_in_ai_column"
    | "wrong_project_key"
    | "no_definition";
}

export interface ClaimSubject {
  subjectKey: string;
  ticketKey: string | null;
  kind: RunKind;
}

export interface ClaimSubjectRunOptions {
  postClaimGuard?: (ownerToken: string) => Promise<DispatchResult | null>;
  startWorkflow: (ownerToken: string) => Promise<string>;
}

export async function dispatchTicket(
  ticketKey: string,
  adapters: Adapters,
  maxConcurrentAgents: number,
): Promise<DispatchResult> {
  const expectedProjectKey = env.JIRA_PROJECT_KEY.trim().toUpperCase();
  const expectedAiStatus = env.COLUMN_AI.trim().toLowerCase();
  const { issueTracker, runRegistry } = adapters;

  try {
    if (await runRegistry.isTicketFailed(ticketKey)) {
      return { started: false, reason: "previously_failed" };
    }
  } catch (error) {
    logger.warn({ ticketKey, error: (error as Error).message }, "dispatch_error");
    return { started: false, reason: "error" };
  }

  let ticket: TicketContent | null = null;
  let definitionId: number | null = null;
  let definitionVersion: WorkflowDefinitionVersionPin | null = null;
  const subjectKey = ticketSubjectKey("jira", ticketKey);
  return claimSubjectRun(
    { subjectKey, ticketKey, kind: "ticket" },
    runRegistry,
    maxConcurrentAgents,
    {
      postClaimGuard: async () => {
        ticket = await issueTracker.fetchTicket(ticketKey);
        if (ticket.trackerStatus.trim().toLowerCase() !== expectedAiStatus) {
          return { started: false, reason: "not_in_ai_column" };
        }
        if (extractProjectKey(ticket.identifier) !== expectedProjectKey) {
          return { started: false, reason: "wrong_project_key" };
        }
        const enabled = await getEnabledWorkflowDefinitionForTrigger(
          getDb(),
          "trigger_ticket_ai",
        );
        if (!enabled) {
          logger.info({ ticketKey }, "dispatch_skipped_no_definition");
          return { started: false, reason: "no_definition" };
        }
        definitionId = enabled.definition.id;
        definitionVersion = enabled.current
          ? enabled.current.version
          : BUILTIN_FALLBACK_DEFINITION_VERSION;
        return null;
      },
      startWorkflow: async (ownerToken) => {
        const input: AgentWorkflowInput = {
          kind: "ticket",
          subjectKey,
          ticketKey,
          ownerToken,
          definitionId: definitionId!,
          definitionVersion: definitionVersion!,
        };
        const handle = await start(agentWorkflow, [input]);
        logger.info(
          { ticketId: ticket!.id, identifier: ticket!.identifier, runId: handle.runId },
          "workflow_started",
        );
        return handle.runId;
      },
    },
  );
}

/**
 * Reserve before start. The dispatcher never binds the run: every Workflow
 * candidate CAS-binds its own runtime id on entry, so retries and duplicate
 * candidates exit before side effects instead of replacing the winner.
 */
export async function claimSubjectRun(
  subject: ClaimSubject,
  runRegistry: RunRegistryAdapter,
  maxConcurrentAgents: number,
  options: ClaimSubjectRunOptions,
): Promise<DispatchResult> {
  let ownerToken: string | null = null;
  let started = false;
  try {
    if (await isAtCapacity(maxConcurrentAgents, runRegistry)) {
      return { started: false, reason: "at_capacity" };
    }

    ownerToken = `owner:${randomUUID()}`;
    const reserved = await runRegistry.reserve({ ...subject, ownerToken });
    if (!reserved) return { started: false, reason: "already_claimed" };

    if (!(await winsPostReservationCapacity(subject.subjectKey, maxConcurrentAgents, runRegistry))) {
      await runRegistry.releaseReservation(subject.subjectKey, ownerToken).catch(() => false);
      ownerToken = null;
      return { started: false, reason: "at_capacity" };
    }

    if (options.postClaimGuard) {
      const bail = await options.postClaimGuard(ownerToken);
      if (bail) {
        await runRegistry.releaseReservation(subject.subjectKey, ownerToken).catch(() => false);
        ownerToken = null;
        return bail;
      }
    }

    const runId = await options.startWorkflow(ownerToken);
    started = true;
    return { started: true, runId };
  } catch (error) {
    // Once start returns, the candidate may already have bound. A dispatcher
    // must never use reservation cleanup to delete a bound workflow.
    if (!started && ownerToken) {
      await runRegistry.releaseReservation(subject.subjectKey, ownerToken).catch(() => false);
    }
    logger.warn(
      { subjectKey: subject.subjectKey, error: (error as Error).message },
      "dispatch_error",
    );
    return { started: false, reason: "error" };
  }
}

/** Ticket-only compatibility wrapper used by approval/clarification dispatch. */
export async function claimTicketRun(
  ticketKey: string,
  runRegistry: RunRegistryAdapter,
  maxConcurrentAgents: number,
  options: ClaimSubjectRunOptions & { kind?: RunKind },
): Promise<DispatchResult> {
  return claimSubjectRun(
    {
      subjectKey: ticketSubjectKey("jira", ticketKey),
      ticketKey,
      kind: options.kind ?? "ticket",
    },
    runRegistry,
    maxConcurrentAgents,
    options,
  );
}

async function isAtCapacity(max: number, runRegistry: RunRegistryAdapter): Promise<boolean> {
  try {
    return liveEntries(await runRegistry.listAll()).length >= max;
  } catch (error) {
    logger.warn({ max, error: (error as Error).message }, "dispatch_capacity_check_failed_closed");
    return true;
  }
}

async function winsPostReservationCapacity(
  subjectKey: string,
  max: number,
  runRegistry: RunRegistryAdapter,
): Promise<boolean> {
  const entries = liveEntries(await runRegistry.listAll());
  if (entries.length <= max) return true;
  const winners = [...entries]
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === "bound" ? -1 : 1;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.subjectKey.localeCompare(b.subjectKey);
    })
    .slice(0, max)
    .map(({ subjectKey: key }) => key);
  return winners.includes(subjectKey);
}

function liveEntries(entries: Awaited<ReturnType<RunRegistryAdapter["listAll"]>>) {
  const staleBefore = Date.now() - STALE_CLAIM_MS;
  return entries.filter((entry) => entry.state === "bound" || entry.createdAt >= staleBefore);
}

function extractProjectKey(ticketIdentifier: string): string | null {
  const dashIndex = ticketIdentifier.trim().indexOf("-");
  return dashIndex <= 0 ? null : ticketIdentifier.trim().slice(0, dashIndex).toUpperCase();
}
