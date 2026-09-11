import type { StoredWorkflowDefinition, WorkflowBlockType } from "@shared/contracts";
import { isTriggerBlockType } from "@shared/contracts";
import type { Db } from "../db/types.js";
import type {
  ObservedTriggerOwnerState,
  WorkflowDefinitionRow,
  WorkflowDefinitionVersionRow,
} from "../db/repositories/definitions.js";
import {
  claimTriggerBindingIfMissing,
  deleteObservedTriggerBinding,
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
  listEnabledTriggerBindingCandidates,
  readTriggerBinding,
} from "../db/repositories/definitions.js";
import {
  claimConnectedTriggerBindingIfMissing,
  deleteConnectedObservedTriggerBinding,
  getConnectedWorkflowDefinition,
  getConnectedWorkflowDefinitionVersion,
  listConnectedEnabledTriggerBindingCandidates,
  readConnectedTriggerBinding,
} from "../db/repositories/definitions/connected.js";
import { parseStoredWorkflowDefinition } from "../workflow-definition/stored-definition.js";

interface DefinitionMatch {
  definition: WorkflowDefinitionRow;
  current: WorkflowDefinitionVersionRow | null;
}

type VersionMetadata = Omit<WorkflowDefinitionVersionRow, keyof StoredWorkflowDefinition>;

function parsedVersion(row: WorkflowDefinitionVersionRow | null): WorkflowDefinitionVersionRow | null {
  if (!row) return null;
  const metadata: VersionMetadata = {
    definitionId: row.definitionId,
    version: row.version,
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByLabel: row.createdByLabel,
    restoredFromVersion: row.restoredFromVersion,
  };
  return { ...metadata, ...parseStoredWorkflowDefinition(row.definition) };
}

function triggerTypesOf(stored: StoredWorkflowDefinition): WorkflowBlockType[] {
  if (stored.schema !== "v2") return [];
  return [...new Set(
    stored.definition.nodes
      .map((node) => node.type)
      .filter((type): type is WorkflowBlockType => isTriggerBlockType(type)),
  )];
}

function isSelfRoutedTrigger(type: WorkflowBlockType): boolean {
  return type === "trigger_webhook" || type === "trigger_schedule";
}

interface TriggerRoutingReads {
  readBinding(type: WorkflowBlockType): Promise<number | null>;
  listCandidates(): ReturnType<typeof listEnabledTriggerBindingCandidates>;
  claim(type: WorkflowBlockType, definitionId: number): Promise<void>;
  deleteObserved(input: {
    triggerType: WorkflowBlockType;
    definitionId: number;
    observed: ObservedTriggerOwnerState;
  }): Promise<void>;
  readDefinition(definitionId: number): Promise<WorkflowDefinitionRow | null>;
  readVersion(definitionId: number, version: number): Promise<WorkflowDefinitionVersionRow | null>;
}

async function resolveEnabledDefinition(
  triggerType: WorkflowBlockType,
  repository: TriggerRoutingReads,
): Promise<DefinitionMatch | null> {
  if (isSelfRoutedTrigger(triggerType)) return null;

  let definitionId = await repository.readBinding(triggerType);
  if (definitionId === null) {
    const candidates = (await repository.listCandidates()).filter((candidate) => {
      const triggers = candidate.deployedVersion === null
        ? candidate.triggerTypes
        : candidate.deployedDefinition === null
          ? []
          : triggerTypesOf(parseStoredWorkflowDefinition(candidate.deployedDefinition));
      return triggers.includes(triggerType);
    });
    if (candidates.length !== 1) return null;
    await repository.claim(triggerType, candidates[0]!.id).catch(() => {});
    definitionId = await repository.readBinding(triggerType);
    if (definitionId === null) return null;
  }

  const definition = await repository.readDefinition(definitionId);
  const current = definition?.deployedVersion == null
    ? null
    : parsedVersion(await repository.readVersion(definitionId, definition.deployedVersion));
  const actualTriggers = current
    ? triggerTypesOf(current)
    : definition?.deployedVersion === null
      ? definition.triggerTypes
      : [];
  const stale =
    !definition ||
    !definition.enabled ||
    definition.archivedAt !== null ||
    !actualTriggers.includes(triggerType);
  if (!stale) return { definition, current };

  await repository.deleteObserved({
    triggerType,
    definitionId,
    observed: definition
      ? {
          exists: true,
          enabled: definition.enabled,
          archivedAt: definition.archivedAt,
          deployedVersion: definition.deployedVersion,
        }
      : { exists: false, enabled: false, archivedAt: null, deployedVersion: null },
  }).catch(() => {});
  return null;
}

export function getEnabledWorkflowDefinitionForTrigger(
  db: Db,
  triggerType: WorkflowBlockType,
): Promise<DefinitionMatch | null> {
  return resolveEnabledDefinition(triggerType, {
    readBinding: (type) => readTriggerBinding(db, type),
    listCandidates: () => listEnabledTriggerBindingCandidates(db),
    claim: (type, definitionId) => claimTriggerBindingIfMissing(db, type, definitionId),
    deleteObserved: (input) => deleteObservedTriggerBinding(db, input),
    readDefinition: (definitionId) => getWorkflowDefinition(db, definitionId),
    readVersion: (definitionId, version) => getWorkflowDefinitionVersion(db, definitionId, version),
  });
}

export function getConnectedEnabledWorkflowDefinitionForTrigger(
  triggerType: WorkflowBlockType,
): Promise<DefinitionMatch | null> {
  return resolveEnabledDefinition(triggerType, {
    readBinding: readConnectedTriggerBinding,
    listCandidates: listConnectedEnabledTriggerBindingCandidates,
    claim: claimConnectedTriggerBindingIfMissing,
    deleteObserved: deleteConnectedObservedTriggerBinding,
    readDefinition: getConnectedWorkflowDefinition,
    readVersion: getConnectedWorkflowDefinitionVersion,
  });
}

async function resolveEnabledDeployedDefinition(
  definitionId: number,
  readDefinition: (id: number) => Promise<WorkflowDefinitionRow | null>,
  readVersion: (id: number, version: number) => Promise<WorkflowDefinitionVersionRow | null>,
): Promise<DefinitionMatch | null> {
  const definition = await readDefinition(definitionId);
  if (!definition || !definition.enabled || definition.archivedAt !== null || definition.deployedVersion === null) {
    return null;
  }
  const current = parsedVersion(await readVersion(definition.id, definition.deployedVersion));
  return current ? { definition, current } : null;
}

export function getEnabledDeployedDefinition(db: Db, definitionId: number) {
  return resolveEnabledDeployedDefinition(
    definitionId,
    (id) => getWorkflowDefinition(db, id),
    (id, version) => getWorkflowDefinitionVersion(db, id, version),
  );
}

export function getConnectedEnabledDeployedDefinition(definitionId: number) {
  return resolveEnabledDeployedDefinition(
    definitionId,
    getConnectedWorkflowDefinition,
    getConnectedWorkflowDefinitionVersion,
  );
}
