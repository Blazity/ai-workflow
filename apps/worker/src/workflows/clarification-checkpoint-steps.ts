import type { BlockOutput, WorkflowBlockType } from "@shared/contracts";
import type {
  ClarificationRuntimeContext,
  ClarificationSourceHead,
} from "../db/clarifications-schema.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import type {
  InterpreterControlState,
  StepsRecord,
} from "../workflow-definition/interpreter.js";
import type {
  ClarificationOriginEntry,
  WorkflowDefinitionVersionPin,
} from "./agent-input.js";
import type { RunBudgetFailure, RunBudgetState } from "./run-budget.js";

const CHECKPOINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SerializableClarificationCheckpoint {
  id: string;
  ticketKey: string | null;
  subjectKey: string;
  predecessorOwnerToken: string;
  predecessorRunId: string;
  successorOwnerToken: string;
  waitingNodeId: string;
  definitionId: number | null;
  definitionVersionPin: WorkflowDefinitionVersionPin;
  originEntry: ClarificationOriginEntry;
  originTriggerNodeId: string;
  originTriggerType: WorkflowBlockType;
  triggerPayload: BlockOutput;
  priorSteps: StepsRecord;
  interpreterState: InterpreterControlState;
  budgetState: RunBudgetState;
  runtimeContext: ClarificationRuntimeContext;
  workspaceManifest: WorkspaceManifest | null;
  sourceHeads: ClarificationSourceHead[];
  questions: string[];
  answer: string;
  answeredByLabel: string | null;
  answeredAt: string | null;
  snapshotId: string | null;
  sourceSandboxId: string | null;
  snapshotRequestedAt: string | null;
  snapshotExpiresAt: string | null;
  expiresAt: string;
}

export async function newClarificationCheckpointExpiryStep(): Promise<string> {
  "use step";
  return new Date(Date.now() + CHECKPOINT_RETENTION_MS).toISOString();
}
newClarificationCheckpointExpiryStep.maxRetries = 0;

export async function captureWorkspaceManifestStep(
  sandboxId: string,
): Promise<WorkspaceManifest> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../sandbox/credentials.js");
  const { parseWorkspaceManifest, WORKSPACE_MANIFEST_PATH } =
    await import("../sandbox/repo-workspace.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const buffer = await sandbox.readFileToBuffer({ path: WORKSPACE_MANIFEST_PATH });
  if (!buffer) {
    throw new Error(`clarification workspace manifest is missing in sandbox ${sandboxId}`);
  }
  return parseWorkspaceManifest(buffer.toString("utf8"));
}
captureWorkspaceManifestStep.maxRetries = 0;

export async function createClarificationCheckpointStep(input: {
  ticketKey: string | null;
  subjectKey: string;
  ownerToken: string;
  runId: string;
  waitingNodeId: string;
  definitionId: number | null;
  definitionVersionPin: WorkflowDefinitionVersionPin;
  originEntry: ClarificationOriginEntry;
  originTriggerNodeId: string;
  originTriggerType: WorkflowBlockType;
  triggerPayload: BlockOutput;
  priorSteps: StepsRecord;
  interpreterState: InterpreterControlState;
  budgetState: RunBudgetState;
  runtimeContext: ClarificationRuntimeContext;
  workspaceManifest: WorkspaceManifest | null;
  sourceSandboxId: string | null;
  expiresAt: string;
  questions: string[];
  suggestedAnswers: string[] | null;
}): Promise<{ id: string; snapshotRequestedAt: string | null }> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createClarificationCheckpoint } = await import("../clarifications/store.js");
  const { checkpointSourceHeads, checkpointStepsForPersistence } =
    await import("../clarifications/checkpoint.js");
  const row = await createClarificationCheckpoint(getDb(), {
    ...input,
    priorSteps: checkpointStepsForPersistence(input.priorSteps),
    sourceHeads: input.workspaceManifest
      ? checkpointSourceHeads(input.workspaceManifest)
      : [],
    snapshotRequestedAt: input.sourceSandboxId ? new Date() : null,
    expiresAt: new Date(input.expiresAt),
  });
  return {
    id: row.id,
    snapshotRequestedAt: row.snapshotRequestedAt?.toISOString() ?? null,
  };
}

export async function completeClarificationCheckpointStep(
  clarificationId: string,
  snapshot: {
    snapshotId: string;
    sourceSandboxId: string;
    expiresAt: string;
  } | null,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { completeClarificationCheckpoint } = await import("../clarifications/store.js");
  await completeClarificationCheckpoint(
    getDb(),
    clarificationId,
    snapshot ? { ...snapshot, expiresAt: new Date(snapshot.expiresAt) } : null,
  );
}

export async function updateClarificationCheckpointBudgetStep(
  clarificationId: string,
  budgetState: RunBudgetState,
  budgetFailure: RunBudgetFailure | null = null,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { updateClarificationCheckpointBudget } = await import(
    "../clarifications/store.js"
  );
  await updateClarificationCheckpointBudget(
    getDb(),
    clarificationId,
    budgetState,
    budgetFailure,
  );
}

export async function publishClarificationCheckpointStep(
  clarificationId: string,
): Promise<string[]> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { publishClarificationCheckpoint } = await import("../clarifications/store.js");
  const result = await publishClarificationCheckpoint(getDb(), clarificationId);
  return result.supersededSnapshots;
}

export async function loadClarificationCheckpointStep(
  clarificationId: string,
  successorOwnerToken: string,
): Promise<SerializableClarificationCheckpoint> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { getClarification } = await import("../clarifications/store.js");
  const row = await getClarification(getDb(), clarificationId);
  const recovery = "restart the ticket to rebuild the workspace";
  if (!row || row.status !== "answered" || row.answer === null) {
    throw new Error(`clarification checkpoint ${clarificationId} is unavailable; ${recovery}`);
  }
  if (row.successorOwnerToken !== successorOwnerToken) {
    throw new Error(`clarification checkpoint ${clarificationId} belongs to another successor`);
  }
  if (
    row.checkpointState !== "ready" ||
    !row.waitingNodeId ||
    row.definitionVersionPin === null ||
    !row.expiresAt
  ) {
    throw new Error(`clarification checkpoint ${clarificationId} is incomplete; ${recovery}`);
  }
  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    throw new Error(`clarification checkpoint ${clarificationId} expired; ${recovery}`);
  }
  if (row.workspaceManifest && (!row.snapshotId || !row.sourceSandboxId)) {
    throw new Error(`clarification checkpoint ${clarificationId} lost its workspace snapshot; ${recovery}`);
  }
  if (row.snapshotId) {
    if (
      row.cleanupState !== "retained" ||
      !row.snapshotExpiresAt ||
      row.snapshotExpiresAt.getTime() <= now
    ) {
      throw new Error(
        `clarification snapshot ${row.snapshotId} is unavailable or expired; ${recovery}`,
      );
    }
  }

  return {
    id: row.id,
    ticketKey: row.ticketKey,
    subjectKey: row.subjectKey,
    predecessorOwnerToken: row.ownerToken,
    predecessorRunId: row.runId,
    successorOwnerToken,
    waitingNodeId: row.waitingNodeId,
    definitionId: row.definitionId,
    definitionVersionPin: row.definitionVersionPin,
    originEntry: row.originEntry,
    originTriggerNodeId: row.originTriggerNodeId,
    originTriggerType: row.originTriggerType,
    triggerPayload: row.triggerPayload,
    priorSteps: row.priorSteps,
    interpreterState: row.interpreterState,
    budgetState: row.budgetState,
    runtimeContext: row.runtimeContext,
    workspaceManifest: row.workspaceManifest,
    sourceHeads: row.sourceHeads,
    questions: row.questions,
    answer: row.answer,
    answeredByLabel: row.answeredByLabel,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    snapshotId: row.snapshotId,
    sourceSandboxId: row.sourceSandboxId,
    snapshotRequestedAt: row.snapshotRequestedAt?.toISOString() ?? null,
    snapshotExpiresAt: row.snapshotExpiresAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
loadClarificationCheckpointStep.maxRetries = 0;

export async function scheduleClarificationSnapshotCleanupStep(
  clarificationId: string,
): Promise<string | null> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { scheduleClarificationSnapshotCleanup } = await import("../clarifications/store.js");
  return scheduleClarificationSnapshotCleanup(getDb(), clarificationId);
}
scheduleClarificationSnapshotCleanupStep.maxRetries = 0;

export async function claimClarificationSnapshotCleanupStep(
  clarificationId: string,
): Promise<boolean> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { claimClarificationSnapshotCleanup } = await import("../clarifications/store.js");
  return claimClarificationSnapshotCleanup(getDb(), clarificationId);
}
claimClarificationSnapshotCleanupStep.maxRetries = 0;

export async function markClarificationSnapshotDeletedStep(
  clarificationId: string,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markClarificationSnapshotDeleted } = await import("../clarifications/store.js");
  await markClarificationSnapshotDeleted(getDb(), clarificationId);
}
markClarificationSnapshotDeletedStep.maxRetries = 0;

export async function markClarificationSnapshotDeletedBySnapshotIdStep(
  snapshotId: string,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markClarificationSnapshotDeletedBySnapshotId } =
    await import("../clarifications/store.js");
  await markClarificationSnapshotDeletedBySnapshotId(getDb(), snapshotId);
}
markClarificationSnapshotDeletedBySnapshotIdStep.maxRetries = 0;

export async function markClarificationSnapshotCleanupFailedStep(
  clarificationId: string,
  error: string,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markClarificationSnapshotCleanupFailed } = await import("../clarifications/store.js");
  await markClarificationSnapshotCleanupFailed(getDb(), clarificationId, error);
}
markClarificationSnapshotCleanupFailedStep.maxRetries = 0;

export async function markClarificationSnapshotCleanupFailedBySnapshotIdStep(
  snapshotId: string,
  error: string,
): Promise<void> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { markClarificationSnapshotCleanupFailedBySnapshotId } =
    await import("../clarifications/store.js");
  await markClarificationSnapshotCleanupFailedBySnapshotId(
    getDb(),
    snapshotId,
    error,
  );
}
markClarificationSnapshotCleanupFailedBySnapshotIdStep.maxRetries = 0;
