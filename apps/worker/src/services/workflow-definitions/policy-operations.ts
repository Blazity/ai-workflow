/** Service policy around the raw definition repository. */
import type { DashboardRole, WorkflowDefinition, WorkflowDefinitionLayoutInput } from "@shared/contracts";
import {
  canEditWorkflowDefinitions,
  normalizeWorkflowDefinitionLayout,
  RETIRED_SCHEMA_MESSAGE,
} from "@shared/contracts";
import type { Db } from "../../db/types.js";
import {
  archiveConnectedDefinition,
  appendConnectedWorkflowDefinitionDraft,
  getConnectedWorkflowDefinition,
  insertConnectedWorkflowDefinition,
  listConnectedWorkflowDefinitions,
  selectConnectedDefinitionDeployment,
  selectConnectedDefinitionRollback,
  updateConnectedWorkflowDefinitionLayout,
  updateConnectedDefinitionLifecycle,
  updateConnectedDefinitionName,
} from "../../db/repositories/definitions/connected.js";
import {
  getConnectedEnabledWorkflowDefinitionForTrigger,
  getEnabledWorkflowDefinitionForTrigger,
} from "../../engine/definition-trigger-routing.js";
import * as raw from "../../db/repositories/definitions.js";
import { createDefinitionsRepository } from "../../db/repositories/definitions.js";
import { validateWorkflowPromptAuthoringIssues } from "../../workflow-definition/prompt-authoring.js";
import { currentBlockContracts } from "./block-contracts.js";
import {
  dispatchManualWorkflow,
  preflightManualDispatch,
} from "../manual-dispatch/index.js";
import { getTriggerRejectionsToday } from "../dispatch/index.js";
import {
  describeWorkflowDefinitionIssues,
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionV2Schema,
} from "../../workflow-definition/schema.js";
import {
  syncConnectedLiveDefinitionTriggers,
  syncLiveDefinitionTriggers,
} from "./live-trigger-sync.js";
import {
  dispatchConnectedDefinitionManual,
  preflightConnectedDefinitionManual,
  previewConnectedDefinitionPrompt,
  readConnectedDefinitionTriggerRejections,
  readConnectedDefinitionWebhookRejections,
  validateConnectedDefinitionCandidate,
  validateConnectedDefinitionPromptAuthoring,
} from "./connected-policy-dependencies.js";
import {
  readConnectedCurrentWorkflowDefinitionVersion,
  readConnectedWorkflowDefinitionVersion,
  readCurrentWorkflowDefinitionVersion,
  readWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";

export type WorkflowDefinitionActor = raw.WorkflowDefinitionActor;
type WorkflowDefinitionRow = raw.WorkflowDefinitionRow;
export type WorkflowDefinitionVersionRow = raw.WorkflowDefinitionVersionRow;
export { WorkflowDefinitionStoreError,  } from "../../db/repositories/definitions.js";

/** The definitions service's transport-mapped authorization rejection. Keeping
 * it here avoids loading the complete auth service (and its DB singleton) for
 * a workflow authoring operation. */
export class DashboardAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function requireEditor(role: string): asserts role is DashboardRole {
  if (!canEditWorkflowDefinitions(role as DashboardRole)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
}

function structural(definition: WorkflowDefinition): WorkflowDefinition {
  const parsed = workflowDefinitionV2Schema.safeParse(definition);
  if (!parsed.success) {
    throw new raw.WorkflowDefinitionStoreError(400, `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`);
  }
  return parsed.data;
}

function validStored(definition: WorkflowDefinition): WorkflowDefinition {
  const parsed = structural(definition);
  const contracts = currentBlockContracts();
  const issues = validateWorkflowDefinitionIssuesForDeployment(
    parsed,
    contracts.resolveContract,
    contracts.blockParamsSchemas,
    contracts.configuredVcsProviders,
  );
  if (issues.length > 0) {
    throw new raw.WorkflowDefinitionStoreError(400, `Invalid workflow: ${issues.map(({ message }) => message).join("; ")}`);
  }
  return parsed;
}

function triggerTypesOf(definition: WorkflowDefinition) {
  return [...new Set(
    definition.nodes
      .map((node) => node.type)
      .filter((type) => isTriggerType(type)),
  )];
}

function isTriggerType(type: WorkflowDefinition["nodes"][number]["type"]): type is import("@shared/contracts").WorkflowBlockType {
  return type.startsWith("trigger_");
}

function bindingTriggerTypesOf(definition: WorkflowDefinition) {
  return triggerTypesOf(definition).filter(
    (type) => type !== "trigger_webhook" && type !== "trigger_schedule",
  );
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: string }).code === "23505") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/duplicate key value|unique constraint/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function assertNoTriggerOverlap(
  definitionId: number,
  triggerTypes: import("@shared/contracts").WorkflowBlockType[],
  read: (type: import("@shared/contracts").WorkflowBlockType) => ReturnType<typeof getEnabledWorkflowDefinitionForTrigger>,
): Promise<void> {
  for (const triggerType of triggerTypes.filter(
    (type) => type !== "trigger_webhook" && type !== "trigger_schedule",
  )) {
    const conflict = await read(triggerType);
    if (conflict && conflict.definition.id !== definitionId) {
      throw new raw.WorkflowDefinitionStoreError(
        409,
        `Its trigger is already handled by the enabled definition "${conflict.definition.name}"`,
      );
    }
  }
}

const TRIGGER_TAKEN_MESSAGE = "Its trigger is already handled by another enabled definition";

async function deployable(db: Db, definition: WorkflowDefinition): Promise<WorkflowDefinition> {
  const parsed = structural(definition);
  const contracts = currentBlockContracts();
  const issues = validateWorkflowDefinitionIssuesForDeployment(
    parsed,
    contracts.resolveContract,
    contracts.blockParamsSchemas,
    contracts.configuredVcsProviders,
  );
  if (issues.length > 0) throw new raw.WorkflowDefinitionValidationError(issues);
  const promptIssues = await validateWorkflowPromptAuthoringIssues(
    db,
    parsed,
    contracts.resolveContract,
  );
  if (promptIssues.length > 0) throw new raw.WorkflowDefinitionValidationError(promptIssues);
  return parsed;
}

function layout(input: WorkflowDefinitionLayoutInput): void {
  if (!input || typeof input !== "object" || !input.nodes || typeof input.nodes !== "object" || Array.isArray(input.nodes)) {
    throw new raw.WorkflowDefinitionStoreError(400, "Invalid workflow layout");
  }
  for (const [id, position] of Object.entries(input.nodes)) {
    if (!id || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new raw.WorkflowDefinitionStoreError(400, "Invalid workflow layout");
    }
  }
  if (input.edges === undefined) return;
  if (!input.edges || typeof input.edges !== "object" || Array.isArray(input.edges)) {
    throw new raw.WorkflowDefinitionStoreError(400, "Invalid workflow layout");
  }
  for (const [id, value] of Object.entries(input.edges)) {
    if (!id || !value || !Number.isFinite(value.bend.x) || !Number.isFinite(value.bend.y)) {
      throw new raw.WorkflowDefinitionStoreError(400, "Invalid workflow layout");
    }
  }
}

function canonicalizeDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
  };
}

function layoutOf(definition: WorkflowDefinition) {
  return normalizeWorkflowDefinitionLayout({
    nodes: Object.fromEntries(
      definition.nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
    ),
    edges: {},
  });
}

function applyLayout(
  definition: WorkflowDefinition,
  savedLayout: ReturnType<typeof normalizeWorkflowDefinitionLayout>,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const position = savedLayout.nodes[node.id];
      return position ? { ...node, ...position } : node;
    }),
  };
}

function requireRunnableVersion(version: WorkflowDefinitionVersionRow): WorkflowDefinition {
  if (version.schema !== "v2") {
    throw new raw.WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
  }
  return version.definition;
}

async function retryOnUniqueViolation<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < attempts && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

function unavailableDefinitionError(
  definition: WorkflowDefinitionRow | null,
): never | void {
  if (!definition) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (definition.archivedAt) {
    throw new raw.WorkflowDefinitionStoreError(409, "Definition is archived");
  }
}

export async function createWorkflowDefinition(db: Db, input: { name: string; seed: WorkflowDefinition | null; actor: WorkflowDefinitionActor; seedValidation?: "deployment" | "structural" }) {
  requireEditor(input.actor.role);
  const seed = input.seed === null ? null : input.seedValidation === "structural" ? structural(input.seed) : validStored(input.seed);
  let inserted;
  try {
    inserted = await raw.insertWorkflowDefinition(db, {
      name: input.name,
      layout: seed ? layoutOf(seed) : normalizeWorkflowDefinitionLayout({ nodes: {}, edges: {} }),
      layoutRevision: seed ? 1 : 0,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      initialDefinition: seed ? canonicalizeDefinition(seed) : null,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, "Name already in use");
    throw error;
  }
  const definition = await raw.getWorkflowDefinition(db, inserted.definitionId);
  if (!definition) throw new raw.WorkflowDefinitionStoreError(500, "Created definition was not readable");
  const current = inserted.initialVersion === null
    ? null
    : await raw.getWorkflowDefinitionVersion(db, definition.id, inserted.initialVersion);
  if (inserted.initialVersion !== null && !current) {
    throw new raw.WorkflowDefinitionStoreError(500, "Created definition version was not readable");
  }
  return { definition, current };
}

export async function createWorkflowDefinitionDraft(db: Db, input: { name: string; seed: WorkflowDefinition; actor: WorkflowDefinitionActor }) {
  const created = await createWorkflowDefinition(db, {
    ...input,
    seed: structural(input.seed),
    seedValidation: "structural",
  });
  if (!created.current) throw new raw.WorkflowDefinitionStoreError(500, "Created definition version was not readable");
  return {
    definition: created.definition,
    draft: applyLayout(requireRunnableVersion(created.current), created.definition.layout),
    draftRevision: created.current.version,
  };
}

export async function saveWorkflowDefinitionDraft(db: Db, input: { definitionId: number; definition: WorkflowDefinition; expectedDraftRevision: number; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  const selected = await raw.appendWorkflowDefinitionDraft(db, {
    definitionId: input.definitionId,
    definition: canonicalizeDefinition(structural(input.definition)),
    expectedDraftRevision: input.expectedDraftRevision,
    actorId: input.actor.id,
    actorLabel: input.actor.label,
  });
  if (!selected) {
    unavailableDefinitionError(await raw.getWorkflowDefinition(db, input.definitionId));
    throw new raw.WorkflowDefinitionStoreError(409, "Draft changed; reload before saving");
  }
  const [definition, version] = await Promise.all([
    raw.getWorkflowDefinition(db, selected.id),
    raw.getWorkflowDefinitionVersion(db, selected.id, selected.version),
  ]);
  if (!definition || !version) throw new raw.WorkflowDefinitionStoreError(500, "Saved definition version was not readable");
  return {
    definition,
    draft: applyLayout(requireRunnableVersion(version), definition.layout),
    draftRevision: version.version,
  };
}

export async function saveWorkflowDefinitionLayout(db: Db, input: { definitionId: number; layout: WorkflowDefinitionLayoutInput; expectedLayoutRevision: number; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  layout(input.layout);
  const savedId = await raw.updateWorkflowDefinitionLayout(db, {
    definitionId: input.definitionId,
    layout: normalizeWorkflowDefinitionLayout(input.layout),
    expectedLayoutRevision: input.expectedLayoutRevision,
  });
  if (!savedId) {
    unavailableDefinitionError(await raw.getWorkflowDefinition(db, input.definitionId));
    throw new raw.WorkflowDefinitionStoreError(409, "Layout changed; reload before saving");
  }
  const saved = await raw.getWorkflowDefinition(db, savedId);
  if (!saved) throw new raw.WorkflowDefinitionStoreError(500, "Saved definition layout was not readable");
  return saved;
}

export async function saveWorkflowDefinitionVersion(db: Db, input: { definitionId: number; definition: WorkflowDefinition; restoredFromVersion?: number; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  return appendWorkflowDefinitionVersionWithPolicy(db, {
    ...input,
    definition: validStored(input.definition),
  });
}

export async function restoreWorkflowDefinitionVersion(db: Db, input: { definitionId: number; version: number; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  const source = await readWorkflowDefinitionVersion(db, input.definitionId, input.version);
  if (!source) throw new raw.WorkflowDefinitionStoreError(404, "Unknown version");
  return appendWorkflowDefinitionVersionWithPolicy(db, {
    definitionId: input.definitionId,
    definition: validStored(requireRunnableVersion(source)),
    restoredFromVersion: source.version,
    actor: input.actor,
  });
}

async function appendWorkflowDefinitionVersionWithPolicy(
  db: Db,
  input: {
    definitionId: number;
    definition: WorkflowDefinition;
    restoredFromVersion?: number;
    actor: WorkflowDefinitionActor;
  },
): Promise<WorkflowDefinitionVersionRow> {
  unavailableDefinitionError(await raw.getWorkflowDefinition(db, input.definitionId));
  const selected = await retryOnUniqueViolation(() => raw.appendWorkflowDefinitionVersion(db, {
    definitionId: input.definitionId,
    definition: input.definition,
    restoredFromVersion: input.restoredFromVersion,
    actorId: input.actor.id,
    actorLabel: input.actor.label,
  }));
  if (!selected) {
    unavailableDefinitionError(await raw.getWorkflowDefinition(db, input.definitionId));
    throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before saving");
  }
  const saved = await raw.getWorkflowDefinitionVersion(db, selected.id, selected.version);
  if (!saved) throw new raw.WorkflowDefinitionStoreError(500, "Saved definition version was not readable");
  return saved;
}

export async function deployWorkflowDefinition(db: Db, input: { definitionId: number; expectedDraftRevision: number; expectedDeployedVersion: number | null; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  const current = await raw.getWorkflowDefinition(db, input.definitionId);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new raw.WorkflowDefinitionStoreError(409, "Definition is archived");
  if (current.draftRevision === 0) throw new raw.WorkflowDefinitionStoreError(409, "Save a draft before deploying");
  if (current.draftRevision !== input.expectedDraftRevision || current.deployedVersion !== input.expectedDeployedVersion) {
    throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
  }
  const source = await readWorkflowDefinitionVersion(db, input.definitionId, input.expectedDraftRevision);
  if (source?.schema === "v2") await deployable(db, source.definition);
  if (!source || source.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
  let selected;
  try {
    selected = await createDefinitionsRepository(db).selectDeployment({
      definitionId: input.definitionId,
      expectedDraftRevision: input.expectedDraftRevision,
      expectedDeployedVersion: input.expectedDeployedVersion,
      triggerTypes: triggerTypesOf(source.definition),
      bindingTriggerTypes: bindingTriggerTypesOf(source.definition),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    throw error;
  }
  if (!selected) throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
  const [definition, version] = await Promise.all([
    raw.getWorkflowDefinition(db, selected.id),
    readWorkflowDefinitionVersion(db, selected.id, selected.version),
  ]);
  if (!definition || version?.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(500, "Deployment selection was not readable");
  const deployed = { definition, version };
  await syncLiveDefinitionTriggers(db, input.definitionId);
  return deployed;
}

export async function rollbackWorkflowDefinition(db: Db, input: { definitionId: number; version: number; expectedDeployedVersion: number | null; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  const current = await raw.getWorkflowDefinition(db, input.definitionId);
  const source = await readWorkflowDefinitionVersion(db, input.definitionId, input.version);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new raw.WorkflowDefinitionStoreError(409, "Definition is archived");
  if (!source) throw new raw.WorkflowDefinitionStoreError(404, "Unknown version");
  if (current.deployedVersion !== input.expectedDeployedVersion) {
    throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before rolling back");
  }
  if (source?.schema === "v2") await deployable(db, source.definition);
  if (source.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
  let selected;
  try {
    selected = await createDefinitionsRepository(db).selectRollback({
      definitionId: input.definitionId,
      version: input.version,
      expectedDeployedVersion: input.expectedDeployedVersion,
      triggerTypes: triggerTypesOf(source.definition),
      bindingTriggerTypes: bindingTriggerTypesOf(source.definition),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    throw error;
  }
  if (!selected) throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before rolling back");
  const definition = await raw.getWorkflowDefinition(db, selected.id);
  if (!definition) throw new raw.WorkflowDefinitionStoreError(500, "Rollback selection was not readable");
  const deployed = { definition, version: source };
  await syncLiveDefinitionTriggers(db, input.definitionId);
  return deployed;
}

export async function updateWorkflowDefinition(db: Db, input: { definitionId: number; name?: string; enabled?: boolean; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  const current = await raw.getWorkflowDefinition(db, input.definitionId);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new raw.WorkflowDefinitionStoreError(409, "Definition is archived");
  let triggerTypes: import("@shared/contracts").WorkflowBlockType[] = [];
  if (input.enabled) {
    if (current?.deployedVersion != null) {
      const source = await readWorkflowDefinitionVersion(db, input.definitionId, current.deployedVersion);
      if (!source) throw new raw.WorkflowDefinitionStoreError(409, "The deployed version is unavailable");
      if (source.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
      await deployable(db, source.definition);
      triggerTypes = triggerTypesOf(source.definition);
    } else {
      const latest = await readCurrentWorkflowDefinitionVersion(db, current.id);
      const fallback = latest === null && current.triggerTypes.length === 1 && current.triggerTypes[0] === "trigger_ticket_ai";
      if (!fallback) throw new raw.WorkflowDefinitionStoreError(409, "Deploy a valid draft before enabling");
      triggerTypes = ["trigger_ticket_ai"];
    }
  }
  if (input.enabled === undefined) {
    if (input.name === undefined) return current;
    let updatedId;
    try {
      updatedId = await createDefinitionsRepository(db).updateName({ definitionId: input.definitionId, name: input.name });
    } catch (error) {
      if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, "Name already in use");
      throw error;
    }
    const updated = updatedId ? await raw.getWorkflowDefinition(db, updatedId) : null;
    if (!updated) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
    return updated;
  }
  if (input.enabled) {
    await assertNoTriggerOverlap(input.definitionId, triggerTypes, (type) =>
      getEnabledWorkflowDefinitionForTrigger(db, type));
  }
  let updatedId;
  try {
    updatedId = await createDefinitionsRepository(db).updateLifecycle({
      definitionId: input.definitionId,
      expectedDeployedVersion: current.deployedVersion,
      expectedTriggerTypes: current.triggerTypes,
      enabled: input.enabled,
      name: input.name,
      bindingTriggerTypes: triggerTypes.filter((type) => type !== "trigger_webhook" && type !== "trigger_schedule"),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    throw error;
  }
  if (!updatedId) throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before updating");
  const updated = await raw.getWorkflowDefinition(db, updatedId);
  if (!updated) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (input.enabled) await syncLiveDefinitionTriggers(db, input.definitionId);
  return updated;
}

export async function archiveWorkflowDefinition(db: Db, input: { definitionId: number; actor: WorkflowDefinitionActor }) {
  requireEditor(input.actor.role);
  const archivedId = await raw.archiveWorkflowDefinition(db, { definitionId: input.definitionId });
  const current = await raw.getWorkflowDefinition(db, input.definitionId);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (archivedId !== null || current.archivedAt) return current;
  if (current.enabled) {
    throw new raw.WorkflowDefinitionStoreError(409, "Disable the definition before archiving it");
  }
  if ((await raw.listWorkflowDefinitions(db)).length <= 1) {
    throw new raw.WorkflowDefinitionStoreError(409, "Cannot archive the last workflow definition");
  }
  throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before archiving");
}

/** Process-bound public writes. These retain the complete policy wrapper above
 * rather than handing callers a Db value that could bypass it. */
export function createConnectedWorkflowDefinition(
  input: Parameters<typeof createWorkflowDefinition>[1],
) {
  requireEditor(input.actor.role);
  return createWorkflowDefinitionConnected(input);
}

export function createConnectedWorkflowDefinitionDraft(
  input: Parameters<typeof createWorkflowDefinitionDraft>[1],
) {
  requireEditor(input.actor.role);
  return createWorkflowDefinitionDraftConnected(input);
}

export function saveConnectedWorkflowDefinitionDraft(
  input: Parameters<typeof saveWorkflowDefinitionDraft>[1],
) {
  requireEditor(input.actor.role);
  return saveWorkflowDefinitionDraftConnected(input);
}

export function saveConnectedWorkflowDefinitionLayout(
  input: Parameters<typeof saveWorkflowDefinitionLayout>[1],
) {
  requireEditor(input.actor.role);
  return saveWorkflowDefinitionLayoutConnected(input);
}

export function deployConnectedWorkflowDefinition(
  input: Parameters<typeof deployWorkflowDefinition>[1],
) {
  return deployWorkflowDefinitionConnected(input);
}

export function rollbackConnectedWorkflowDefinition(
  input: Parameters<typeof rollbackWorkflowDefinition>[1],
) {
  return rollbackWorkflowDefinitionConnected(input);
}

export function updateConnectedWorkflowDefinition(
  input: Parameters<typeof updateWorkflowDefinition>[1],
) {
  return updateWorkflowDefinitionConnected(input);
}

export function archiveConnectedWorkflowDefinition(
  input: Parameters<typeof archiveWorkflowDefinition>[1],
) {
  requireEditor(input.actor.role);
  return archiveWorkflowDefinitionConnected(input);
}

async function createWorkflowDefinitionConnected(
  input: Parameters<typeof createWorkflowDefinition>[1],
) {
  const seed = input.seed === null
    ? null
    : input.seedValidation === "structural"
      ? structural(input.seed)
      : validStored(input.seed);
  let inserted;
  try {
    inserted = await insertConnectedWorkflowDefinition({
      name: input.name,
      layout: seed ? layoutOf(seed) : normalizeWorkflowDefinitionLayout({ nodes: {}, edges: {} }),
      layoutRevision: seed ? 1 : 0,
      actorId: input.actor.id,
      actorLabel: input.actor.label,
      initialDefinition: seed ? canonicalizeDefinition(seed) : null,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, "Name already in use");
    throw error;
  }
  const definition = await getConnectedWorkflowDefinition(inserted.definitionId);
  if (!definition) throw new raw.WorkflowDefinitionStoreError(500, "Created definition was not readable");
  const current = inserted.initialVersion === null
    ? null
    : await readConnectedWorkflowDefinitionVersion(definition.id, inserted.initialVersion);
  if (inserted.initialVersion !== null && !current) {
    throw new raw.WorkflowDefinitionStoreError(500, "Created definition version was not readable");
  }
  return { definition, current };
}

async function createWorkflowDefinitionDraftConnected(
  input: Parameters<typeof createWorkflowDefinitionDraft>[1],
) {
  const created = await createWorkflowDefinitionConnected({
    ...input,
    seed: structural(input.seed),
    seedValidation: "structural",
  });
  if (!created.current) throw new raw.WorkflowDefinitionStoreError(500, "Created definition version was not readable");
  return {
    definition: created.definition,
    draft: applyLayout(requireRunnableVersion(created.current), created.definition.layout),
    draftRevision: created.current.version,
  };
}

async function saveWorkflowDefinitionDraftConnected(
  input: Parameters<typeof saveWorkflowDefinitionDraft>[1],
) {
  const selected = await appendConnectedWorkflowDefinitionDraft({
    definitionId: input.definitionId,
    definition: canonicalizeDefinition(structural(input.definition)),
    expectedDraftRevision: input.expectedDraftRevision,
    actorId: input.actor.id,
    actorLabel: input.actor.label,
  });
  if (!selected) {
    unavailableDefinitionError(await getConnectedWorkflowDefinition(input.definitionId));
    throw new raw.WorkflowDefinitionStoreError(409, "Draft changed; reload before saving");
  }
  const [definition, version] = await Promise.all([
    getConnectedWorkflowDefinition(selected.id),
    readConnectedWorkflowDefinitionVersion(selected.id, selected.version),
  ]);
  if (!definition || !version) throw new raw.WorkflowDefinitionStoreError(500, "Saved definition version was not readable");
  return {
    definition,
    draft: applyLayout(requireRunnableVersion(version), definition.layout),
    draftRevision: version.version,
  };
}

async function saveWorkflowDefinitionLayoutConnected(
  input: Parameters<typeof saveWorkflowDefinitionLayout>[1],
) {
  layout(input.layout);
  const savedId = await updateConnectedWorkflowDefinitionLayout({
    definitionId: input.definitionId,
    layout: normalizeWorkflowDefinitionLayout(input.layout),
    expectedLayoutRevision: input.expectedLayoutRevision,
  });
  if (!savedId) {
    unavailableDefinitionError(await getConnectedWorkflowDefinition(input.definitionId));
    throw new raw.WorkflowDefinitionStoreError(409, "Layout changed; reload before saving");
  }
  const saved = await getConnectedWorkflowDefinition(savedId);
  if (!saved) throw new raw.WorkflowDefinitionStoreError(500, "Saved definition layout was not readable");
  return saved;
}

async function archiveWorkflowDefinitionConnected(
  input: Parameters<typeof archiveWorkflowDefinition>[1],
) {
  const archivedId = await archiveConnectedDefinition({ definitionId: input.definitionId });
  const current = await getConnectedWorkflowDefinition(input.definitionId);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (archivedId !== null || current.archivedAt) return current;
  if (current.enabled) {
    throw new raw.WorkflowDefinitionStoreError(409, "Disable the definition before archiving it");
  }
  const active = await listConnectedWorkflowDefinitions();
  if (active.length <= 1) {
    throw new raw.WorkflowDefinitionStoreError(409, "Cannot archive the last workflow definition");
  }
  throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before archiving");
}

async function deployWorkflowDefinitionConnected(input: Parameters<typeof deployWorkflowDefinition>[1]) {
  requireEditor(input.actor.role);
  const current = await getConnectedWorkflowDefinition(input.definitionId);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new raw.WorkflowDefinitionStoreError(409, "Definition is archived");
  if (current.draftRevision === 0) throw new raw.WorkflowDefinitionStoreError(409, "Save a draft before deploying");
  if (current.draftRevision !== input.expectedDraftRevision || current.deployedVersion !== input.expectedDeployedVersion) {
    throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
  }
  const source = await readConnectedWorkflowDefinitionVersion(input.definitionId, input.expectedDraftRevision);
  if (source?.schema === "v2") await deployableConnected(source.definition);
  if (!source || source.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
  let selected;
  try {
    selected = await selectConnectedDefinitionDeployment({
      definitionId: input.definitionId,
      expectedDraftRevision: input.expectedDraftRevision,
      expectedDeployedVersion: input.expectedDeployedVersion,
      triggerTypes: triggerTypesOf(source.definition),
      bindingTriggerTypes: bindingTriggerTypesOf(source.definition),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    throw error;
  }
  if (!selected) throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before deploying");
  const [definition, version] = await Promise.all([
    getConnectedWorkflowDefinition(selected.id),
    readConnectedWorkflowDefinitionVersion(selected.id, selected.version),
  ]);
  if (!definition || version?.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(500, "Deployment selection was not readable");
  const deployed = { definition, version };
  await syncConnectedLiveDefinitionTriggers(input.definitionId);
  return deployed;
}

async function rollbackWorkflowDefinitionConnected(input: Parameters<typeof rollbackWorkflowDefinition>[1]) {
  requireEditor(input.actor.role);
  const current = await getConnectedWorkflowDefinition(input.definitionId);
  const source = await readConnectedWorkflowDefinitionVersion(input.definitionId, input.version);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new raw.WorkflowDefinitionStoreError(409, "Definition is archived");
  if (!source) throw new raw.WorkflowDefinitionStoreError(404, "Unknown version");
  if (current.deployedVersion !== input.expectedDeployedVersion) {
    throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before rolling back");
  }
  if (source?.schema === "v2") await deployableConnected(source.definition);
  if (source.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
  let selected;
  try {
    selected = await selectConnectedDefinitionRollback({
      definitionId: input.definitionId,
      version: input.version,
      expectedDeployedVersion: input.expectedDeployedVersion,
      triggerTypes: triggerTypesOf(source.definition),
      bindingTriggerTypes: bindingTriggerTypesOf(source.definition),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    throw error;
  }
  if (!selected) throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before rolling back");
  const definition = await getConnectedWorkflowDefinition(selected.id);
  if (!definition) throw new raw.WorkflowDefinitionStoreError(500, "Rollback selection was not readable");
  const deployed = { definition, version: source };
  await syncConnectedLiveDefinitionTriggers(input.definitionId);
  return deployed;
}

async function updateWorkflowDefinitionConnected(input: Parameters<typeof updateWorkflowDefinition>[1]) {
  requireEditor(input.actor.role);
  const current = await getConnectedWorkflowDefinition(input.definitionId);
  if (!current) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (current.archivedAt) throw new raw.WorkflowDefinitionStoreError(409, "Definition is archived");
  let triggerTypes: import("@shared/contracts").WorkflowBlockType[] = [];
  if (input.enabled) {
    if (current?.deployedVersion != null) {
      const source = await readConnectedWorkflowDefinitionVersion(input.definitionId, current.deployedVersion);
      if (!source) throw new raw.WorkflowDefinitionStoreError(409, "The deployed version is unavailable");
      if (source.schema !== "v2") throw new raw.WorkflowDefinitionStoreError(409, RETIRED_SCHEMA_MESSAGE);
      await deployableConnected(source.definition);
      triggerTypes = triggerTypesOf(source.definition);
    } else {
      const latest = await readConnectedCurrentWorkflowDefinitionVersion(current.id);
      const fallback = latest === null && current.triggerTypes.length === 1 && current.triggerTypes[0] === "trigger_ticket_ai";
      if (!fallback) throw new raw.WorkflowDefinitionStoreError(409, "Deploy a valid draft before enabling");
      triggerTypes = ["trigger_ticket_ai"];
    }
  }
  if (input.enabled === undefined) {
    if (input.name === undefined) return current;
    let updatedId;
    try {
      updatedId = await updateConnectedDefinitionName({ definitionId: input.definitionId, name: input.name });
    } catch (error) {
      if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, "Name already in use");
      throw error;
    }
    const updated = updatedId ? await getConnectedWorkflowDefinition(updatedId) : null;
    if (!updated) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
    return updated;
  }
  if (input.enabled) {
    await assertNoTriggerOverlap(input.definitionId, triggerTypes, (type) =>
      getConnectedEnabledWorkflowDefinitionForTrigger(type));
  }
  let updatedId;
  try {
    updatedId = await updateConnectedDefinitionLifecycle({
      definitionId: input.definitionId,
      expectedDeployedVersion: current.deployedVersion,
      expectedTriggerTypes: current.triggerTypes,
      enabled: input.enabled,
      name: input.name,
      bindingTriggerTypes: triggerTypes.filter((type) => type !== "trigger_webhook" && type !== "trigger_schedule"),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new raw.WorkflowDefinitionStoreError(409, TRIGGER_TAKEN_MESSAGE);
    throw error;
  }
  if (!updatedId) throw new raw.WorkflowDefinitionStoreError(409, "Definition changed; reload before updating");
  const updated = await getConnectedWorkflowDefinition(updatedId);
  if (!updated) throw new raw.WorkflowDefinitionStoreError(404, "Unknown definition");
  if (input.enabled) await syncConnectedLiveDefinitionTriggers(input.definitionId);
  return updated;
}

async function deployableConnected(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
  const parsed = structural(definition);
  const contracts = currentBlockContracts();
  const issues = validateWorkflowDefinitionIssuesForDeployment(
    parsed,
    contracts.resolveContract,
    contracts.blockParamsSchemas,
    contracts.configuredVcsProviders,
  );
  if (issues.length > 0) throw new raw.WorkflowDefinitionValidationError(issues);
  const promptIssues = await validateConnectedDefinitionPromptAuthoring(
    parsed,
    contracts.resolveContract,
  );
  if (promptIssues.length > 0) throw new raw.WorkflowDefinitionValidationError(promptIssues);
  return parsed;
}

export function validateConnectedWorkflowDefinitionCandidateWithPromptAuthoring(
  candidate: unknown,
) {
  return validateConnectedDefinitionCandidate(candidate);
}

export function previewConnectedWorkflowPromptCandidate(
  input: {
    candidate: unknown;
    blockId: string;
    organizationId?: string;
  },
) {
  return previewConnectedDefinitionPrompt(input);
}

/** Bind the one manual-dispatch request shape without leaking a Db capability
 * into the trigger panel service. Dispatch policy remains in manual-dispatch. */
export function preflightConnectedManualWorkflow(
  input: Omit<Parameters<typeof preflightManualDispatch>[0], "db">,
) {
  return preflightConnectedDefinitionManual(input);
}

export function dispatchConnectedManualWorkflow(
  input: Omit<Parameters<typeof dispatchManualWorkflow>[0], "db">,
) {
  return dispatchConnectedDefinitionManual(input);
}

export function readConnectedTriggerRejectionsToday(
  key: Parameters<typeof getTriggerRejectionsToday>[1],
  now: Date,
) {
  return readConnectedDefinitionTriggerRejections(key, now);
}

export function readConnectedWebhookRejectionsToday(endpointId: string, now: Date) {
  return readConnectedDefinitionWebhookRejections(endpointId, now);
}
