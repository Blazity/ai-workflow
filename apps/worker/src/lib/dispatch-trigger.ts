import { start } from "workflow/api";
import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { AgentWorkflowInput } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { getEnabledWorkflowDefinitionForTrigger } from "../workflow-definition/store.js";
import { ticketKeyFromBranch } from "./branch-prefix.js";
import { claimTicketRun } from "./dispatch.js";
import { logger } from "./logger.js";
import type { TriggerEvent } from "./trigger-events.js";

export type DispatchTriggerResult =
  | { result: "no_definition" }
  | { result: "ignored_not_workflow_owned" }
  | { result: "ignored_provider" }
  | { result: "coalesced" }
  | { result: "at_capacity" }
  | { result: "error" }
  | { result: "started"; runId: string };

export interface DispatchTriggerDeps {
  db: Db;
  runRegistry: RunRegistryAdapter;
  maxConcurrentAgents: number;
}

/** Trigger-node params for a given trigger type in an enabled definition, or {}. */
function triggerNodeParams(
  definition: { nodes: { type: string; params: Record<string, unknown> }[] },
  triggerType: string,
): Record<string, unknown> {
  const node = definition.nodes.find((n) => n.type === triggerType);
  return node?.params ?? {};
}

/**
 * Resolve the review states that may fire trigger_pr_review, from the enabled
 * definition's node config. Falls back to the safe default (["changes_requested"])
 * when no definition is enabled or the param is unset — a "commented" review
 * carries an untrusted body and must be opted into explicitly. Used by the GitHub
 * webhook route to gate review events in normalizeGitHubEvent before dispatch.
 */
export async function resolveEnabledReviewStates(db: Db): Promise<string[]> {
  const enabled = await getEnabledWorkflowDefinitionForTrigger(db, "trigger_pr_review");
  if (!enabled?.current) return ["changes_requested"];
  const on = triggerNodeParams(enabled.current.definition, "trigger_pr_review").on;
  if (Array.isArray(on) && on.length > 0) {
    return on.filter((s): s is string => typeof s === "string");
  }
  return ["changes_requested"];
}

export async function dispatchTriggerEvent(
  evt: TriggerEvent,
  deps: DispatchTriggerDeps,
): Promise<DispatchTriggerResult> {
  const enabled = await getEnabledWorkflowDefinitionForTrigger(deps.db, evt.triggerType);
  if (!enabled || !enabled.current) {
    logger.info({ triggerType: evt.triggerType }, "trigger_no_enabled_definition");
    return { result: "no_definition" };
  }

  const params = triggerNodeParams(enabled.current.definition, evt.triggerType);

  // providers gate: dispatch only when the event's provider is in the configured
  // list. An empty/unset list means "all providers" (back-compat).
  const providers = params.providers;
  if (
    Array.isArray(providers) &&
    providers.length > 0 &&
    !providers.includes(evt.pr.provider)
  ) {
    logger.info(
      { triggerType: evt.triggerType, provider: evt.pr.provider, providers },
      "trigger_ignored_provider",
    );
    return { result: "ignored_provider" };
  }

  // onlyWorkflowOwned gate (default true): only workflow-owned PRs (branch
  // resolves to a ticket key via the blazebot/ prefix) may dispatch. When an
  // operator explicitly opts out (false), a non-workflow-owned PR is allowed
  // through under a synthetic run key derived from the PR identity.
  const onlyWorkflowOwned = params.onlyWorkflowOwned !== false;
  const ticketKey = ticketKeyFromBranch(evt.pr.headRef);
  let runKey: string;
  if (ticketKey) {
    runKey = ticketKey;
  } else if (onlyWorkflowOwned) {
    logger.info(
      { triggerType: evt.triggerType, headRef: evt.pr.headRef },
      "trigger_ignored_not_workflow_owned",
    );
    return { result: "ignored_not_workflow_owned" };
  } else {
    runKey = `pr:${evt.pr.provider}:${evt.pr.repoPath}:${evt.pr.prNumber}`;
    logger.info(
      { triggerType: evt.triggerType, headRef: evt.pr.headRef, runKey },
      "trigger_non_workflow_owned_allowed",
    );
  }

  const definitionId = enabled.definition.id;
  const input: AgentWorkflowInput = {
    kind: "pr_trigger",
    triggerType: evt.triggerType,
    ticketKey: runKey,
    definitionId,
    pr: evt.pr,
  };

  const dispatchResult = await claimTicketRun(
    runKey,
    deps.runRegistry,
    deps.maxConcurrentAgents,
    {
      kind: "pr_trigger",
      startWorkflow: async () => {
        const handle = await start(agentWorkflow, [input]);
        logger.info(
          { ticketKey: runKey, definitionId, triggerType: evt.triggerType, runId: handle.runId },
          "trigger_workflow_started",
        );
        return handle.runId;
      },
    },
  );

  if (dispatchResult.started) {
    return { result: "started", runId: dispatchResult.runId! };
  }
  if (dispatchResult.reason === "already_claimed") {
    return { result: "coalesced" };
  }
  if (dispatchResult.reason === "at_capacity") {
    return { result: "at_capacity" };
  }
  return { result: "error" };
}
