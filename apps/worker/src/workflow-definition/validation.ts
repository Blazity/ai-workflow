import type {
  WorkflowDefinition,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";
import type { z } from "zod";
import { analyzeWorkflowV2Bindings } from "./available-values.js";
import { resolveWorkflowBlockContract } from "./block-registry.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionV1Schema,
  workflowDefinitionV2Schema,
  workflowDefinitionSchema,
} from "./schema.js";

export type WorkflowDefinitionCandidateValidation =
  | { parsed: WorkflowDefinition; response: WorkflowDefinitionValidationResponse }
  | { parsed: null; response: WorkflowDefinitionValidationResponse };

/**
 * Validates one exact candidate and returns API-ready issues. Node ownership and
 * JSON paths are attached while the source validation still has that context;
 * callers never recover structure by parsing human-readable messages.
 */
export function validateWorkflowDefinitionCandidate(
  candidate: unknown,
  registryContext: WorkflowBlockRegistryContext,
): WorkflowDefinitionCandidateValidation {
  const schema =
    candidate !== null &&
    typeof candidate === "object" &&
    "schemaVersion" in candidate &&
    candidate.schemaVersion === 1
      ? workflowDefinitionV1Schema
      : candidate !== null &&
          typeof candidate === "object" &&
          "schemaVersion" in candidate &&
          candidate.schemaVersion === 2
        ? workflowDefinitionV2Schema
        : workflowDefinitionSchema;
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      parsed: null,
      response: {
        valid: false,
        issues: structuralIssues(candidate, parsed.error),
        nodeContracts: {},
        availableValuesByNode: {},
      },
    };
  }

  const deploymentIssues = validateWorkflowDefinitionIssuesForDeployment(
    parsed.data,
    registryContext,
  );
  const v2Analysis =
    parsed.data.schemaVersion === 2
      ? analyzeWorkflowV2Bindings(parsed.data, registryContext)
      : null;
  const issues = dedupeIssues([
    ...deploymentIssues,
    ...(v2Analysis?.issues ?? []),
  ]);
  return {
    parsed: parsed.data,
    response: {
      valid: issues.length === 0,
      issues,
      nodeContracts:
        parsed.data.schemaVersion === 1
          ? Object.fromEntries(
              parsed.data.nodes.map((node) => [
                node.id,
                resolveWorkflowBlockContract(node.type, node.params, registryContext),
              ]),
            )
          : v2Analysis?.nodeContracts ?? {},
      availableValuesByNode: v2Analysis?.availableValuesByNode ?? {},
    },
  };
}

function dedupeIssues(
  issues: WorkflowDefinitionValidationIssue[],
): WorkflowDefinitionValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([
      issue.code,
      issue.nodeId,
      issue.path ?? null,
      issue.message,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function structuralIssues(
  candidate: unknown,
  error: z.ZodError,
): WorkflowDefinitionValidationIssue[] {
  return error.issues.map((issue) => {
    const path = jsonPointer(issue.path);
    return {
      code: "schema",
      severity: "error",
      nodeId: nodeIdAtPath(candidate, issue.path),
      ...(path ? { path } : {}),
      message: issue.message,
    };
  });
}

function nodeIdAtPath(candidate: unknown, path: PropertyKey[]): string | null {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    path[0] !== "nodes" ||
    typeof path[1] !== "number"
  ) {
    return null;
  }
  const nodes = (candidate as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  const node = nodes[path[1]];
  if (!node || typeof node !== "object") return null;
  const id = (node as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function jsonPointer(path: PropertyKey[]): string {
  return path.length === 0
    ? ""
    : `/${path
        .map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")}`;
}
