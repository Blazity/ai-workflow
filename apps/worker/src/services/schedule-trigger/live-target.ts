import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import type { Db } from "../../db/types.js";
import { getWorkflowDefinition } from "../../db/repositories/definitions.js";
import { getConnectedWorkflowDefinition } from "../../db/repositories/definitions/connected.js";
import type { WorkflowDefinitionVersionRow } from "../../db/repositories/definitions.js";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readConnectedWorkflowDefinitionVersion,
  readDeployedWorkflowDefinitionVersion,
  readWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";

interface StoredTriggerRateLimitParams {
  rateLimitMax?: number;
  rateLimitWindow?: "minute" | "hour" | "day" | "month";
}

export type LiveScheduleTriggerTarget =
  | {
      kind: "runnable";
      definitionVersion: number;
      taskTitle: string;
      taskDescription: string;
      rateLimit: StoredTriggerRateLimitParams;
    }
  | {
      kind: "retired-head" | "retired-pinned";
      definitionVersion: number;
      reason: typeof RETIRED_SCHEMA_MESSAGE;
    }
  | null;

type ScheduleTargetReads = {
  getDefinition(definitionId: number): ReturnType<typeof getWorkflowDefinition>;
  getDeployed(definitionId: number): ReturnType<typeof readDeployedWorkflowDefinitionVersion>;
  getVersion(definitionId: number, version: number): ReturnType<typeof readWorkflowDefinitionVersion>;
};

export function resolveLiveScheduleTriggerTarget(
  db: Db,
  input: { definitionId: number; nodeId: string; definitionVersion: number | null },
): Promise<LiveScheduleTriggerTarget> {
  return resolveWithReads(input, {
    getDefinition: (definitionId) => getWorkflowDefinition(db, definitionId),
    getDeployed: (definitionId) => readDeployedWorkflowDefinitionVersion(db, definitionId),
    getVersion: (definitionId, version) => readWorkflowDefinitionVersion(db, definitionId, version),
  });
}

export function resolveConnectedLiveScheduleTriggerTarget(
  input: { definitionId: number; nodeId: string; definitionVersion: number | null },
): Promise<LiveScheduleTriggerTarget> {
  return resolveWithReads(input, {
    getDefinition: getConnectedWorkflowDefinition,
    getDeployed: readConnectedDeployedWorkflowDefinitionVersion,
    getVersion: readConnectedWorkflowDefinitionVersion,
  });
}

async function resolveWithReads(
  input: { definitionId: number; nodeId: string; definitionVersion: number | null },
  reads: ScheduleTargetReads,
): Promise<LiveScheduleTriggerTarget> {
  const definition = await reads.getDefinition(input.definitionId);
  if (!definition || !definition.enabled || definition.archivedAt !== null) return null;
  const head = await reads.getDeployed(input.definitionId);
  if (!head) return null;
  if (head.schema !== "v2") {
    return { kind: "retired-head", definitionVersion: head.version, reason: RETIRED_SCHEMA_MESSAGE };
  }
  if (!scheduleNodeOf(head, input.nodeId)) return null;

  const version = input.definitionVersion ?? head.version;
  const source = version === head.version ? head : await reads.getVersion(input.definitionId, version);
  if (source?.schema === "legacy-v1") {
    return { kind: "retired-pinned", definitionVersion: source.version, reason: RETIRED_SCHEMA_MESSAGE };
  }
  const node = source ? scheduleNodeOf(source, input.nodeId) : null;
  if (!node) return null;
  const configuration = node.configuration ?? {};
  return {
    kind: "runnable",
    definitionVersion: version,
    taskTitle: typeof configuration.taskTitle === "string" ? configuration.taskTitle : "",
    taskDescription: typeof configuration.taskDescription === "string" ? configuration.taskDescription : "",
    rateLimit: readTriggerRateLimitParams(configuration),
  };
}

function readTriggerRateLimitParams(
  configuration: Record<string, unknown>,
): StoredTriggerRateLimitParams {
  const windowKind = configuration.rateLimitWindow;
  return {
    ...(typeof configuration.rateLimitMax === "number"
      ? { rateLimitMax: configuration.rateLimitMax }
      : {}),
    ...(windowKind === "minute" || windowKind === "hour" || windowKind === "day" || windowKind === "month"
      ? { rateLimitWindow: windowKind }
      : {}),
  };
}

function scheduleNodeOf(
  version: WorkflowDefinitionVersionRow,
  nodeId: string,
): { configuration?: Record<string, unknown> } | null {
  if (version.schema !== "v2") return null;
  const node = version.definition.nodes.find((candidate) => candidate.id === nodeId);
  return node && node.type === "trigger_schedule" ? node : null;
}
