/**
 * Starting one trigger node by hand from the editor.
 *
 * The dispatch itself belongs to the manual-dispatch cluster; what lives here is
 * the binding an operator-initiated request needs and a route must not hold: the
 * connection, the provider adapters, the run-slot ceiling this deployment runs
 * under, and the audit label of the person who pressed the button.
 */
import type {
  DashboardRole,
  ManualDispatchInput,
  ManualDispatchPreflightResponse,
  ManualDispatchRequest,
  ManualDispatchResponse,
} from "@shared/contracts";
import { maxConcurrentAgents } from "../settings/index.js";
import { createAdapters } from "../vcs/index.js";
import { resolveWorkflowDefinitionActor } from "./definition-authoring.js";
import {
  dispatchConnectedManualWorkflow,
  preflightConnectedManualWorkflow,
} from "./policy-operations.js";

/** Would this dispatch start, and what would it start against? No run, no
 *  claim, no ticket transition. */
export function preflightTriggerDispatch(input: {
  definitionId: number;
  triggerNodeId: string;
  dispatchInput: ManualDispatchInput;
}): Promise<ManualDispatchPreflightResponse> {
  return preflightConnectedManualWorkflow({
    adapters: createAdapters(),
    definitionId: input.definitionId,
    triggerNodeId: input.triggerNodeId,
    dispatchInput: input.dispatchInput,
    maxConcurrentAgents: maxConcurrentAgents(),
  });
}

/** Start the trigger node, recording who asked for it. */
export async function dispatchTriggerManually(input: {
  definitionId: number;
  triggerNodeId: string;
  request: ManualDispatchRequest;
  actorId: string;
  actorRole: DashboardRole;
}): Promise<ManualDispatchResponse> {
  const actor = await resolveWorkflowDefinitionActor({
    role: input.actorRole,
    userId: input.actorId,
  });
  return dispatchConnectedManualWorkflow({
    adapters: createAdapters(),
    definitionId: input.definitionId,
    triggerNodeId: input.triggerNodeId,
    request: input.request,
    actor: { id: actor.id, label: actor.label },
    maxConcurrentAgents: maxConcurrentAgents(),
  });
}
