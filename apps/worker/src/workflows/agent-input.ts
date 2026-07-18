/**
 * Payload of the pull request that fired a PR-based trigger. Assembled by the
 * webhook dispatch layer and carried unchanged through the run so block
 * executors can read PR facts without re-fetching them.
 */
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
 * "plan_approved" resumes a run after a human approved a plan on the dashboard,
 * and "clarification_answered" resumes a run after a human answered the
 * questions the agent parked on.
 */
export type AgentWorkflowInput =
  | {
      kind: "ticket";
      subjectKey: string;
      ticketKey: string;
      ownerToken: string;
      continuation?: ClarificationContinuationMarker;
      definitionId?: number;
      definitionVersion?: WorkflowDefinitionVersionPin;
    }
  | {
      kind: "pr_trigger";
      triggerType:
        | "trigger_pr_created"
        | "trigger_pr_checks_failed"
        | "trigger_pr_review"
        | "trigger_pr_merged";
      subjectKey: string;
      ticketKey?: string;
      ownerToken: string;
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
        triggerType:
          | "trigger_pr_created"
          | "trigger_pr_checks_failed"
          | "trigger_pr_review"
          | "trigger_pr_merged";
        /** Provider delivery snapshot consumed by this candidate. A newer
         * delivery for the same semantic event must remain pending. */
        deliveryId: string;
      };
      pr: PrTriggerPayload;
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
      approvedPlan: { markdown: string; assumptions?: string[] };
      approval: { approvalRequestId: string; approver: string; approvedAt: string };
    }
  | {
      kind: "clarification_answered";
      subjectKey: string;
      ticketKey: string | null;
      ownerToken: string;
      definitionId?: number;
      definitionVersion?: WorkflowDefinitionVersionPin;
      /** Clarification request whose answer resumes work on the ticket. */
      clarificationRequestId: string;
    };

export type ClarificationOriginEntry =
  | { kind: "ticket"; ticketKey: string; definitionId?: number; definitionVersion?: WorkflowDefinitionVersionPin }
  | {
      kind: "pr_trigger";
      triggerType:
        | "trigger_pr_created"
        | "trigger_pr_checks_failed"
        | "trigger_pr_review"
        | "trigger_pr_merged";
      ticketKey?: string;
      definitionId: number;
      definitionVersion: number;
      scope: "workflow_owned" | "any";
      pr: PrTriggerPayload;
    }
  | {
      kind: "plan_approved";
      ticketKey: string;
      definitionId: number;
      definitionVersion?: number;
      approvedPlan: { markdown: string; assumptions?: string[] };
      approval: { approvalRequestId: string; approver: string; approvedAt: string };
    };

export type ClarificationRuntimeEntry = Exclude<
  AgentWorkflowInput,
  { kind: "clarification_answered" }
>;

/** Strip dispatcher and predecessor identity while preserving block-facing trigger facts. */
export function normalizeClarificationOrigin(
  entry: ClarificationRuntimeEntry,
): ClarificationOriginEntry {
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
