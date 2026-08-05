/**
 * Payload of the pull request that fired a PR-based trigger. Assembled by the
 * webhook dispatch layer and carried unchanged through the run so block
 * executors can read PR facts without re-fetching them.
 */
import type { ApprovedRepositoryScope } from "@shared/contracts";
import type { RunKind } from "../adapters/run-registry/types.js";
import type { PrTriggerType } from "../lib/trigger-events.js";

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
 * and "plan_approved" resumes a run after a human approved a plan on the dashboard.
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
  if (entry.kind === "ticket" && entry.manualDispatchId) {
    return "manual_ticket";
  }
  return "ticket";
}
