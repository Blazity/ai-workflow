/**
 * Process-bound definition reads.
 *
 * These are deliberately named operations rather than a connection accessor:
 * callers can ask the repository a persistence question, but cannot carry a
 * database capability into policy or orchestration code.
 */
import { getDb } from "../../client.js";
import {
  getCurrentWorkflowDefinitionVersion,
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinition,
  getWorkflowDefinitionName,
  getWorkflowDefinitionRawState,
  getWorkflowDefinitionDraftState,
  getWorkflowDefinitionVersion,
  listWorkflowDefinitionVersionRows,
  listWorkflowDefinitions,
  insertWorkflowDefinition,
  appendWorkflowDefinitionDraft,
  updateWorkflowDefinitionLayout,
  archiveWorkflowDefinition,
} from "./operations.js";
import { createDefinitionsRepository } from "./atomic.js";
import {
  claimTriggerBindingIfMissing,
  deleteObservedTriggerBinding,
  listEnabledTriggerBindingCandidates,
  readTriggerBinding,
} from "./trigger-bindings.js";

export function listConnectedWorkflowDefinitions() {
  return listWorkflowDefinitions(getDb());
}

export function getConnectedWorkflowDefinition(definitionId: number) {
  return getWorkflowDefinition(getDb(), definitionId);
}

export function getConnectedWorkflowDefinitionName(definitionId: number) {
  return getWorkflowDefinitionName(getDb(), definitionId);
}

export function getConnectedWorkflowDefinitionRawState(definitionId: number) {
  return getWorkflowDefinitionRawState(getDb(), definitionId);
}

export function getConnectedWorkflowDefinitionDraftState(definitionId: number) {
  return getWorkflowDefinitionDraftState(getDb(), definitionId);
}

export function getConnectedWorkflowDefinitionVersion(
  definitionId: number,
  version: number,
) {
  return getWorkflowDefinitionVersion(getDb(), definitionId, version);
}

export function getConnectedCurrentWorkflowDefinitionVersion(definitionId: number) {
  return getCurrentWorkflowDefinitionVersion(getDb(), definitionId);
}

export function getConnectedDeployedWorkflowDefinitionVersion(definitionId: number) {
  return getDeployedWorkflowDefinitionVersion(getDb(), definitionId);
}

export function listConnectedWorkflowDefinitionVersionRows(definitionId: number) {
  return listWorkflowDefinitionVersionRows(getDb(), definitionId);
}

export function readConnectedTriggerBinding(
  triggerType: Parameters<typeof readTriggerBinding>[1],
) {
  return readTriggerBinding(getDb(), triggerType);
}

export function listConnectedEnabledTriggerBindingCandidates() {
  return listEnabledTriggerBindingCandidates(getDb());
}

export function claimConnectedTriggerBindingIfMissing(
  triggerType: Parameters<typeof claimTriggerBindingIfMissing>[1],
  definitionId: number,
) {
  return claimTriggerBindingIfMissing(getDb(), triggerType, definitionId);
}

export function deleteConnectedObservedTriggerBinding(
  input: Parameters<typeof deleteObservedTriggerBinding>[1],
) {
  return deleteObservedTriggerBinding(getDb(), input);
}

export function revokeConnectedScheduleAndCancelWaiting(
  ...args: Parameters<ReturnType<typeof createDefinitionsRepository>["revokeScheduleAndCancelWaiting"]>
) {
  return createDefinitionsRepository(getDb()).revokeScheduleAndCancelWaiting(...args);
}

export function selectConnectedDefinitionDeployment(
  input: Parameters<ReturnType<typeof createDefinitionsRepository>["selectDeployment"]>[0],
) {
  return createDefinitionsRepository(getDb()).selectDeployment(input);
}

export function selectConnectedDefinitionRollback(
  input: Parameters<ReturnType<typeof createDefinitionsRepository>["selectRollback"]>[0],
) {
  return createDefinitionsRepository(getDb()).selectRollback(input);
}

export function updateConnectedDefinitionLifecycle(
  input: Parameters<ReturnType<typeof createDefinitionsRepository>["updateLifecycle"]>[0],
) {
  return createDefinitionsRepository(getDb()).updateLifecycle(input);
}

export function updateConnectedDefinitionName(
  input: Parameters<ReturnType<typeof createDefinitionsRepository>["updateName"]>[0],
) {
  return createDefinitionsRepository(getDb()).updateName(input);
}

export function insertConnectedWorkflowDefinition(input: Parameters<typeof insertWorkflowDefinition>[1]) { return insertWorkflowDefinition(getDb(), input); }
export function appendConnectedWorkflowDefinitionDraft(input: Parameters<typeof appendWorkflowDefinitionDraft>[1]) { return appendWorkflowDefinitionDraft(getDb(), input); }
export function updateConnectedWorkflowDefinitionLayout(input: Parameters<typeof updateWorkflowDefinitionLayout>[1]) { return updateWorkflowDefinitionLayout(getDb(), input); }
export function archiveConnectedDefinition(input: Parameters<typeof archiveWorkflowDefinition>[1]) { return archiveWorkflowDefinition(getDb(), input); }
