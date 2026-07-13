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
  | { result: "coalesced" }
  | { result: "at_capacity" }
  | { result: "error" }
  | { result: "started"; runId: string };

export interface DispatchTriggerDeps {
  db: Db;
  runRegistry: RunRegistryAdapter;
  maxConcurrentAgents: number;
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

  const ticketKey = ticketKeyFromBranch(evt.pr.headRef);
  if (!ticketKey) {
    logger.info(
      { triggerType: evt.triggerType, headRef: evt.pr.headRef },
      "trigger_ignored_not_workflow_owned",
    );
    return { result: "ignored_not_workflow_owned" };
  }

  const triggerNode = enabled.current.definition.nodes.find(
    (node) => node.type === evt.triggerType,
  );
  if (triggerNode && triggerNode.params.onlyWorkflowOwned === false) {
    logger.warn(
      { triggerType: evt.triggerType, definitionId: enabled.definition.id },
      "trigger_only_workflow_owned_false_not_honored",
    );
  }

  const definitionId = enabled.definition.id;
  const input: AgentWorkflowInput = {
    kind: "pr_trigger",
    triggerType: evt.triggerType,
    ticketKey,
    definitionId,
    pr: evt.pr,
  };

  const dispatchResult = await claimTicketRun(
    ticketKey,
    deps.runRegistry,
    deps.maxConcurrentAgents,
    {
      kind: "pr_trigger",
      startWorkflow: async () => {
        const handle = await start(agentWorkflow, [input]);
        logger.info(
          { ticketKey, definitionId, triggerType: evt.triggerType, runId: handle.runId },
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
