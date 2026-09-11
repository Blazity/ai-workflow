import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb, type Db } from "../../client.js";
import { approvalRequests, manualDispatchRequests, triggerDeliveries, workflowDefinitions, workflowDefinitionVersions } from "../../schema.js";

export function listDeployedDefinitionSnapshots(db: Db) {
  return db.select({ id: workflowDefinitions.id, name: workflowDefinitions.name, version: workflowDefinitionVersions.version, definition: workflowDefinitionVersions.definition }).from(workflowDefinitions).innerJoin(workflowDefinitionVersions, and(eq(workflowDefinitionVersions.definitionId, workflowDefinitions.id), eq(workflowDefinitionVersions.version, workflowDefinitions.deployedVersion))).where(and(isNull(workflowDefinitions.archivedAt), isNotNull(workflowDefinitions.deployedVersion)));
}
export function listFreshInstallDefinitionCandidates(db: Db) {
  return db.select({ id: workflowDefinitions.id, name: workflowDefinitions.name, triggerTypes: workflowDefinitions.triggerTypes }).from(workflowDefinitions).where(and(isNull(workflowDefinitions.archivedAt), eq(workflowDefinitions.enabled, true), isNull(workflowDefinitions.deployedVersion)));
}
export async function definitionHasAnyVersion(db: Db, definitionId: number): Promise<boolean> {
  const [row] = await db.select({ version: workflowDefinitionVersions.version }).from(workflowDefinitionVersions).where(eq(workflowDefinitionVersions.definitionId, definitionId)).limit(1);
  return row !== undefined;
}
export function listPendingApprovalDefinitionPins(db: Db) {
  return db.selectDistinct({ definitionId: approvalRequests.definitionId, definitionVersion: approvalRequests.definitionVersion }).from(approvalRequests).where(eq(approvalRequests.status, "pending"));
}
export function listPendingTriggerDeliveryDefinitionPins(db: Db) {
  return db.selectDistinct({ definitionId: triggerDeliveries.definitionId, definitionVersion: triggerDeliveries.definitionVersion }).from(triggerDeliveries).where(eq(triggerDeliveries.pending, true));
}
export function listLiveManualDispatchDefinitionPins(db: Db, statuses: readonly string[]) {
  return db.selectDistinct({ definitionId: manualDispatchRequests.definitionId, definitionVersion: manualDispatchRequests.definitionVersion }).from(manualDispatchRequests).where(inArray(manualDispatchRequests.status, statuses));
}
export function listDefinitionDriftMetadata(db: Db, definitionIds: number[]) {
  if (definitionIds.length === 0) return Promise.resolve([]);
  return db.select({ id: workflowDefinitions.id, name: workflowDefinitions.name, deployedVersion: workflowDefinitions.deployedVersion }).from(workflowDefinitions).where(inArray(workflowDefinitions.id, definitionIds));
}
export function listDefinitionDriftSnapshots(db: Db, requests: Array<{ definitionId: number; version: number }>) {
  if (requests.length === 0) return Promise.resolve([]);
  return db.select({ definitionId: workflowDefinitionVersions.definitionId, version: workflowDefinitionVersions.version, definition: workflowDefinitionVersions.definition }).from(workflowDefinitionVersions).where(or(...requests.map((entry) => and(eq(workflowDefinitionVersions.definitionId, entry.definitionId), eq(workflowDefinitionVersions.version, entry.version)))));
}
export function listConnectedDeployedDefinitionSnapshots() { return listDeployedDefinitionSnapshots(getDb()); }
export function listConnectedFreshInstallDefinitionCandidates() { return listFreshInstallDefinitionCandidates(getDb()); }
export function connectedDefinitionHasAnyVersion(definitionId: number) { return definitionHasAnyVersion(getDb(), definitionId); }
export function listConnectedPendingApprovalDefinitionPins() { return listPendingApprovalDefinitionPins(getDb()); }
export function listConnectedPendingTriggerDeliveryDefinitionPins() { return listPendingTriggerDeliveryDefinitionPins(getDb()); }
export function listConnectedLiveManualDispatchDefinitionPins(statuses: readonly string[]) { return listLiveManualDispatchDefinitionPins(getDb(), statuses); }
export function listConnectedDefinitionDriftMetadata(definitionIds: number[]) { return listDefinitionDriftMetadata(getDb(), definitionIds); }
export function listConnectedDefinitionDriftSnapshots(requests: Array<{ definitionId: number; version: number }>) { return listDefinitionDriftSnapshots(getDb(), requests); }
