/**
 * Payload of the pull request that fired a PR-based trigger. Assembled by the
 * webhook dispatch layer and carried unchanged through the run so block
 * executors can read PR facts without re-fetching them.
 */
import type { ApprovedRepositoryScope, JsonValue } from "@shared/contracts";
import type { RunKind } from "../adapters/run-registry/types.js";
import type { PrTriggerType } from "../lib/trigger-events.js";
import type { SupportCase } from "../webhook-trigger/payload-mapping.js";

export interface PrTriggerPayload {
  provider: "github" | "gitlab";
  repoPath: string;
  /** GitLab project identity retained so deferred scope checks can be replayed. */
  providerProjectId?: number | string;
  prNumber: number;
  prUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  author: string;
  isDraft: boolean;
  mergeSha?: string;
  mergedAt?: string;
  /** GitLab pipeline event identity used to reject superseded head pipelines. */
  pipelineId?: number;
  failedChecks?: Array<{
    name: string;
    conclusion: string;
    detailsUrl?: string;
    /** GitHub identity used only by dispatch freshness checks. */
    checkRunId?: number;
    appSlug?: string;
  }>;
  review?: { state: "changes_requested" | "commented"; author: string; body: string };
  reviews?: Array<{ state: "changes_requested" | "commented"; author: string; body: string }>;
}

/**
 * Fields a webhook delivery contributes to the run it starts, already mapped
 * through the endpoint's map* params. `payload` is the raw authenticated body.
 */
export interface WebhookTriggerEntryPayload {
  subject: string;
  description: string;
  requester: string;
  priority: string;
  /** The authenticated request body, already parsed. */
  payload: JsonValue;
  supportCase?: SupportCase;
}

/** Immutable identity for the built-in fresh-install graph, which has no
 * workflow_definition_versions row to pin by number. */
export const BUILTIN_FALLBACK_DEFINITION_VERSION = "builtin_fallback" as const;
export type WorkflowDefinitionVersionPin =
  | number
  | typeof BUILTIN_FALLBACK_DEFINITION_VERSION;

export interface ClarificationContinuationMarker {
  kind: "clarification";
  clarificationRequestId: string;
}

/**
 * Entry describing what started an agent workflow run. "ticket" is the classic
 * ticket-column trigger, "pr_trigger" covers the PR webhook triggers,
 * "webhook_trigger" covers deliveries authenticated by a trigger_webhook
 * endpoint, and "plan_approved" resumes a run after a human approved a plan on
 * the dashboard.
 * Clarification answers resume the asking run in place through a Workflow hook.
 */
export type AgentWorkflowInput =
  | {
      kind: "ticket";
      subjectKey: string;
      ticketKey: string;
      ownerToken: string;
      /** Durable manual-dispatch request acknowledged after owner binding. */
      manualDispatchId?: string;
      continuation?: ClarificationContinuationMarker;
      definitionId?: number;
      definitionVersion?: WorkflowDefinitionVersionPin;
    }
  | {
      kind: "pr_trigger";
      triggerType: PrTriggerType;
      subjectKey: string;
      ticketKey?: string;
      ownerToken: string;
      /** Durable manual-dispatch request acknowledged after owner binding. */
      manualDispatchId?: string;
      continuation?: ClarificationContinuationMarker;
      definitionId: number;
      definitionVersion: number;
      scope: "workflow_owned" | "any";
      /** Authenticated provider delivery that launched this candidate. Optional
       * only for workflow inputs serialized before durable delivery tracking. */
      delivery?: {
        provider: "github" | "gitlab";
        producer: string;
        deliveryId: string;
      };
      /** Durable pending row this candidate must acknowledge after owner bind. */
      pendingEvent?: {
        headSha: string;
        triggerType: PrTriggerType;
        /** Provider delivery snapshot consumed by this candidate. A newer
         * delivery for the same semantic event must remain pending. */
        deliveryId: string;
      };
      pr: PrTriggerPayload;
    }
  | {
      kind: "webhook_trigger";
      endpointId: string;
      definitionId: number;
      /** Graph version this delivery was accepted against. A delivery that waits
       * in the pending queue across a definition publish must still run the
       * version it was admitted under, not the new head. */
      definitionVersion: number;
      /** The exact trigger_webhook node that owns the endpoint. Entry-node
       * selection uses it: a definition may carry several webhook triggers. */
      nodeId: string;
      deliveryId: string;
      subjectKey: string;
      ownerToken: string;
      continuation?: ClarificationContinuationMarker;
      /** Type-level marker only, never serialized: a webhook run has no
       * correlated ticket. Declaring it keeps `entry.ticketKey` readable across
       * the whole union, where every reader already takes its no-ticket path. */
      ticketKey?: undefined;
      entry: WebhookTriggerEntryPayload;
    }
  | {
      kind: "schedule";
      scheduleId: string;
      definitionId: number;
      /** Graph version the occurrence was admitted against. REQUIRED, unlike the
       * ticket kinds: an occurrence can sit in the pending slot across a
       * definition publish, and it must run the version it was admitted under
       * rather than whatever head it wakes up to. */
      definitionVersion: number;
      /** The exact trigger_schedule node this occurrence belongs to. A definition
       * may carry several schedules, so entry-node selection uses the id. */
      nodeId: string;
      subjectKey: string;
      ownerToken: string;
      /** Occurrence instant, ISO. This is the schedule's identity for the run. */
      scheduledFor: string;
      /** Occurrence the schedule last started a run for, absent on the first
       * firing, so a task instruction can say "since the previous run". */
      previousScheduledFor?: string;
      /** Pull requests the previous occurrence's run opened and nobody has merged.
       * Every occurrence branches from the default branch under its own identity,
       * so without this a daily schedule reopens the same change every day and
       * accumulates mutually conflicting duplicates. */
      previousRunPullRequests?: string[];
      taskTitle: string;
      taskDescription: string;
      continuation?: ClarificationContinuationMarker;
      /** Type-level marker only, never serialized: a scheduled run has no
       * correlated ticket, exactly like a webhook run. */
      ticketKey?: undefined;
    }
  | {
      kind: "plan_approved";
      subjectKey: string;
      ticketKey: string;
      ownerToken: string;
      continuation?: ClarificationContinuationMarker;
      definitionId: number;
      /** Pinned definition version that produced the approved plan. When set, the
       *  run loads exactly that version instead of the definition's head. */
      definitionVersion?: number;
      approvedPlan: {
        markdown: string;
        assumptions?: string[];
        repositoryScope?: ApprovedRepositoryScope;
      };
      approval: { approvalRequestId: string; approver: string; approvedAt: string };
    }
  ;

export function runKindForAgentWorkflowInput(
  entry: AgentWorkflowInput,
): RunKind {
  if (entry.kind === "pr_trigger") {
    return entry.manualDispatchId ? "manual_pr_trigger" : "pr_trigger";
  }
  if (entry.kind === "webhook_trigger") {
    return "webhook_trigger";
  }
  if (entry.kind === "schedule") {
    return "schedule";
  }
  if (entry.kind === "ticket" && entry.manualDispatchId) {
    return "manual_ticket";
  }
  return "ticket";
}

export type ClarificationOriginEntry =
  | { kind: "ticket"; ticketKey: string; definitionId?: number; definitionVersion?: WorkflowDefinitionVersionPin }
  | {
      kind: "pr_trigger";
      triggerType: PrTriggerType;
      ticketKey?: string;
      definitionId: number;
      definitionVersion: number;
      scope: "workflow_owned" | "any";
      pr: PrTriggerPayload;
    }
  | {
      kind: "webhook_trigger";
      endpointId: string;
      definitionId: number;
      definitionVersion: number;
      nodeId: string;
      deliveryId: string;
      entry: WebhookTriggerEntryPayload;
    }
  | {
      kind: "plan_approved";
      ticketKey: string;
      definitionId: number;
      definitionVersion?: number;
      approvedPlan: {
        markdown: string;
        assumptions?: string[];
        repositoryScope?: ApprovedRepositoryScope;
      };
      approval: { approvalRequestId: string; approver: string; approvedAt: string };
    };

export type ClarificationRuntimeEntry = AgentWorkflowInput;

/** Strip dispatcher and predecessor identity while preserving block-facing trigger facts. */
export function normalizeClarificationOrigin(
  entry: ClarificationRuntimeEntry,
): ClarificationOriginEntry {
  if (entry.kind === "schedule") {
    // Unreachable because the run fails before it can park: the deployment gate
    // refuses the two blocks whose whole purpose is waiting for a person, and
    // assertScheduledRunMayNotPark in agent.ts fails any scheduled run that
    // reaches a clarification at execution time (a park is a runtime outcome of
    // several ordinary blocks, not a property of a block type). Loud here, so
    // that if either of those is ever loosened this surfaces instead of quietly
    // producing a continuation entry with no schedule identity on it.
    throw new Error("a scheduled run cannot own a clarification checkpoint");
  }
  if (entry.kind === "ticket") {
    return {
      kind: "ticket",
      ticketKey: entry.ticketKey,
      ...(entry.definitionId !== undefined ? { definitionId: entry.definitionId } : {}),
      ...(entry.definitionVersion !== undefined
        ? { definitionVersion: entry.definitionVersion }
        : {}),
    };
  }
  if (entry.kind === "pr_trigger") {
    return {
      kind: "pr_trigger",
      triggerType: entry.triggerType,
      ...(entry.ticketKey !== undefined ? { ticketKey: entry.ticketKey } : {}),
      definitionId: entry.definitionId,
      definitionVersion: entry.definitionVersion,
      scope: entry.scope,
      pr: entry.pr,
    };
  }
  if (entry.kind === "webhook_trigger") {
    // No ticketKey to carry: like a scope:any pr_trigger, the successor keeps
    // only the trigger facts the blocks read.
    return {
      kind: "webhook_trigger",
      endpointId: entry.endpointId,
      definitionId: entry.definitionId,
      definitionVersion: entry.definitionVersion,
      nodeId: entry.nodeId,
      deliveryId: entry.deliveryId,
      entry: entry.entry,
    };
  }
  return {
    kind: "plan_approved",
    ticketKey: entry.ticketKey,
    definitionId: entry.definitionId,
    ...(entry.definitionVersion !== undefined
      ? { definitionVersion: entry.definitionVersion }
      : {}),
    approvedPlan: entry.approvedPlan,
    approval: entry.approval,
  };
}

/** Rehydrate original trigger semantics under the bound successor identity. */
export function restoreClarificationOrigin(
  origin: ClarificationOriginEntry,
  identity: {
    subjectKey: string;
    ownerToken: string;
    clarificationRequestId: string;
  },
): ClarificationRuntimeEntry {
  return {
    ...origin,
    subjectKey: identity.subjectKey,
    ownerToken: identity.ownerToken,
    continuation: {
      kind: "clarification",
      clarificationRequestId: identity.clarificationRequestId,
    },
  } as ClarificationRuntimeEntry;
}
