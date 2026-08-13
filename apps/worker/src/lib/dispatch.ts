import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type { WorkflowDefinition } from "@shared/contracts";
import { env } from "../../env.js";
import {
  RESERVATION_BIND_GRACE_MS,
  type RunKind,
  type RunRegistryAdapter,
} from "../adapters/run-registry/types.js";
import type { TicketContent } from "../adapters/issue-tracker/types.js";
import { getDb } from "../db/client.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../workflow-definition/store.js";
import {
  enforceTriggerRateLimit,
  resolveTriggerRateLimitForType,
  triggerRateLimitLogFields,
  type TriggerRateLimitConfig,
  type TriggerRateLimitNode,
  type TriggerRateLimitNodeParams,
  type TriggerRateLimitWindow,
} from "./trigger-rate-limit.js";
import {
  BUILTIN_FALLBACK_DEFINITION_VERSION,
  type AgentWorkflowInput,
  type WorkflowDefinitionVersionPin,
} from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { hasDispatchBlockingApprovalForTicket } from "../approvals/store.js";
import type { Adapters } from "./adapters.js";
import { logger } from "./logger.js";
import { ticketSubjectKey } from "./subject-key.js";

export const STALE_CLAIM_MS = RESERVATION_BIND_GRACE_MS;

export interface DispatchResult {
  started: boolean;
  runId?: string;
  /** Exact reservation owner returned only by the low-level claim helper. */
  ownerToken?: string;
  reason?:
    | "already_claimed"
    | "at_capacity"
    | "error"
    | "previously_failed"
    | "not_in_ai_column"
    | "wrong_project_key"
    | "no_definition"
    | "approval_pending"
    | "rate_limited";
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

export type SubjectReservationResult =
  | "reserved"
  | "already_claimed"
  | "at_capacity";

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
  const result = await claimSubjectRun(
    { subjectKey, ticketKey, kind: "ticket" },
    runRegistry,
    maxConcurrentAgents,
    {
      postClaimGuard: async () => {
        // Query again under the exact reservation instead of trusting the
        // poller's earlier snapshot. A plan request can be persisted while a
        // poll is in flight; neither a pending decision nor an approved pinned
        // continuation may be replaced by generic ticket discovery.
        if (await hasDispatchBlockingApprovalForTicket(getDb(), ticketKey)) {
          return { started: false, reason: "approval_pending" };
        }
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
          // The reservation is released right after this guard bails, so the
          // recorded row is a plain tombstone: it holds nothing, fails nothing,
          // and the next poll dispatches normally once a definition resolves.
          const { recordNoDefinitionBlockedRun } = await import(
            "./run-start-lifecycle.js"
          );
          await recordNoDefinitionBlockedRun({
            subjectKey,
            ticketKey,
            ticketTitle: ticket.title,
          });
          return { started: false, reason: "no_definition" };
        }
        definitionId = enabled.definition.id;
        definitionVersion = enabled.current
          ? enabled.current.version
          : BUILTIN_FALLBACK_DEFINITION_VERSION;
        // The rate limit stands LAST among the guards, right before the run
        // starts: a candidate refused by any guard above (approval pending,
        // wrong column, wrong project, no definition) must not spend the
        // trigger's start budget nor tally a rejection.
        if (await ticketTriggerRateLimited(enabled, ticketKey)) {
          return { started: false, reason: "rate_limited" };
        }
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
  // ownerToken is an internal start-boundary proof used by trigger delivery
  // persistence. Do not expose it from ordinary ticket dispatch.
  return result.started
    ? { started: true, runId: result.runId }
    : result;
}

/**
 * The optional global rate-limit default from env. Both halves must be set: a
 * lone max without a window (or vice versa) is a misconfiguration, treated as
 * no default at all so it never silently changes existing workflows.
 */
export function envTriggerRateLimitDefault(source: {
  TRIGGER_RATE_LIMIT_MAX?: number;
  TRIGGER_RATE_LIMIT_WINDOW?: TriggerRateLimitWindow;
}): TriggerRateLimitConfig | null {
  const max = source.TRIGGER_RATE_LIMIT_MAX;
  const windowKind = source.TRIGGER_RATE_LIMIT_WINDOW;
  return max !== undefined && windowKind !== undefined ? { max, windowKind } : null;
}

/** The rate-limit params authored on one graph node, across the v1 (params)
 *  and v2 (configuration) shapes. Unknown or mistyped values are dropped: the
 *  definition schema validates them at save time, and a value that cannot be
 *  read here must not turn into a limit nobody configured. */
export function triggerNodeRateLimitParams(
  definition: WorkflowDefinition | undefined,
  nodeId: string,
): TriggerRateLimitNodeParams | undefined {
  if (!definition) return undefined;
  const raw: Record<string, unknown> | undefined =
    definition.schemaVersion === 1
      ? definition.nodes.find((node) => node.id === nodeId)?.params
      : definition.nodes.find((node) => node.id === nodeId)?.configuration;
  if (!raw) return undefined;
  const windowKind = raw.rateLimitWindow;
  return {
    rateLimitMax:
      typeof raw.rateLimitMax === "number" ? raw.rateLimitMax : undefined,
    rateLimitWindow:
      windowKind === "minute" ||
      windowKind === "hour" ||
      windowKind === "day" ||
      windowKind === "month"
        ? windowKind
        : undefined,
  };
}

/**
 * Sibling trigger nodes of one type with the rate-limit params authored on
 * them, for dispatchers that resolve a definition by trigger TYPE rather than
 * by node (ticket and PR triggers). Empty when the definition has no current
 * graph (the built-in fallback), which the restrictive resolver reads as
 * "nothing configured" — including no env default, since there is no node to
 * key the counter under.
 */
export function triggerRateLimitNodes(
  definition: WorkflowDefinition | undefined,
  triggerType: string,
): TriggerRateLimitNode[] {
  if (!definition) return [];
  return definition.nodes
    .filter((node) => node.type === triggerType)
    .map((node) => ({
      nodeId: node.id,
      params: triggerNodeRateLimitParams(definition, node.id),
    }));
}

/**
 * Count one ticket-dispatch start against the trigger rate limit, answering
 * true when the start must be dropped. The most restrictive limit configured
 * across the definition's trigger_ticket_ai nodes applies, because this
 * dispatcher resolves the definition by trigger type, not by node.
 */
async function ticketTriggerRateLimited(
  enabled: NonNullable<Awaited<ReturnType<typeof getEnabledWorkflowDefinitionForTrigger>>>,
  ticketKey: string,
): Promise<boolean> {
  const limit = resolveTriggerRateLimitForType(
    triggerRateLimitNodes(enabled.current?.definition, "trigger_ticket_ai"),
    envTriggerRateLimitDefault(env),
  );
  if (!limit) return false;
  const key = { definitionId: String(enabled.definition.id), nodeId: limit.nodeId };
  const decision = await enforceTriggerRateLimit(
    getDb(),
    key,
    limit.config,
    new Date(),
  );
  if (!decision || decision.allowed) return false;
  logger.info(
    {
      ticketKey,
      triggerType: "trigger_ticket_ai",
      nodeId: key.nodeId,
      ...triggerRateLimitLogFields(decision),
    },
    "trigger_rate_limited",
  );
  return true;
}

/**
 * Reserve before start, then atomically bind the returned hosted run and write
 * its startup-watchdog row before reporting success. The Workflow entry repeats
 * the exact operation as a crash-window fallback.
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
    ownerToken = `owner:${randomUUID()}`;
    const reservation = await reserveSubjectWithinCapacity(
      subject,
      ownerToken,
      runRegistry,
      maxConcurrentAgents,
    );
    if (reservation !== "reserved") {
      ownerToken = null;
      return { started: false, reason: reservation };
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
    const startedRun = {
      ...subject,
      ownerToken,
      runId,
    };
    const { commitHostedStart } = await import("./run-start-lifecycle.js");
    if (!(await commitHostedStart(runRegistry, startedRun))) {
      return { started: false, reason: "error" };
    }
    return { started: true, runId, ownerToken };
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

/**
 * Atomically participates in the same capacity/fairness protocol as a normal
 * workflow claim while retaining a caller-owned durable token. Clarification
 * recovery uses this when its predecessor/successor owner is genuinely
 * missing, and clarification resumption uses a custom reserve/rollback pair
 * so a parked subject reacquires capacity without ever becoming unclaimed.
 */
export async function reserveSubjectWithinCapacity(
  subject: ClaimSubject,
  ownerToken: string,
  runRegistry: RunRegistryAdapter,
  maxConcurrentAgents: number,
  reserve: (() => Promise<boolean>) | null = null,
  rollback: (() => Promise<boolean>) | null = null,
): Promise<SubjectReservationResult> {
  if (await isAtCapacity(maxConcurrentAgents, runRegistry)) return "at_capacity";

  const reserved = await (reserve
    ? reserve()
    : runRegistry.reserve({ ...subject, ownerToken }));
  if (!reserved) return "already_claimed";

  try {
    if (
      await winsPostReservationCapacity(
        subject.subjectKey,
        maxConcurrentAgents,
        runRegistry,
      )
    ) {
      return "reserved";
    }
  } catch (error) {
    await rollbackReservation(
      subject.subjectKey,
      ownerToken,
      runRegistry,
      rollback,
    );
    throw error;
  }

  await rollbackReservation(
    subject.subjectKey,
    ownerToken,
    runRegistry,
    rollback,
  );
  return "at_capacity";
}

async function rollbackReservation(
  subjectKey: string,
  ownerToken: string,
  runRegistry: RunRegistryAdapter,
  rollback: (() => Promise<boolean>) | null,
): Promise<boolean> {
  return (rollback
    ? rollback()
    : runRegistry.releaseReservation(subjectKey, ownerToken)
  ).catch(() => false);
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
    return (await capacityEntries(runRegistry)).length >= max;
  } catch (error) {
    logger.warn({ max, error: (error as Error).message }, "dispatch_capacity_check_failed_closed");
    return true;
  }
}

export async function winsPostReservationCapacity(
  subjectKey: string,
  max: number,
  runRegistry: RunRegistryAdapter,
): Promise<boolean> {
  const entries = await capacityEntries(runRegistry);
  if (entries.length <= max) return true;
  const winners = [...entries]
    .sort((a, b) => {
      const aIsReservation = a.state === "reserved";
      const bIsReservation = b.state === "reserved";
      if (aIsReservation !== bIsReservation) return aIsReservation ? 1 : -1;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.subjectKey.localeCompare(b.subjectKey);
    })
    .slice(0, max)
    .map(({ subjectKey: key }) => key);
  return winners.includes(subjectKey);
}

/**
 * How many slots of MAX_CONCURRENT_AGENTS are taken right now, counted exactly the
 * way the dispatch refusal counts them (parked claims included), so a surface that
 * shows the pool cannot disagree with the decision it is explaining.
 */
export async function countCapacityConsumers(
  runRegistry: RunRegistryAdapter,
): Promise<number> {
  return (await capacityEntries(runRegistry)).length;
}

async function capacityEntries(runRegistry: RunRegistryAdapter) {
  if (runRegistry.listCapacityConsumers) {
    return runRegistry.listCapacityConsumers();
  }
  return liveEntries(await runRegistry.listAll());
}

function liveEntries(entries: Awaited<ReturnType<RunRegistryAdapter["listAll"]>>) {
  const staleBefore = Date.now() - STALE_CLAIM_MS;
  return entries.filter((entry) => entry.state !== "reserved" || entry.updatedAt >= staleBefore);
}

function extractProjectKey(ticketIdentifier: string): string | null {
  const dashIndex = ticketIdentifier.trim().indexOf("-");
  return dashIndex <= 0 ? null : ticketIdentifier.trim().slice(0, dashIndex).toUpperCase();
}
