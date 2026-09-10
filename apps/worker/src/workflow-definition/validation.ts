import type {
  WorkflowDefinition,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";
import {
  RETIRED_SCHEMA_MESSAGE,
  WORKFLOW_SCHEMA_VERSION,
  workflowDefinitionSchemaVersionOf,
} from "@shared/contracts";
import type { z } from "zod";
import { analyzeWorkflowV2Bindings } from "./available-values.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionV2Schema,
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
  if (declaresRetiredSchema(candidate)) {
    return {
      parsed: null,
      response: {
        valid: false,
        issues: [
          {
            code: "schema",
            severity: "error",
            nodeId: null,
            path: "/schemaVersion",
            message: RETIRED_SCHEMA_MESSAGE,
          },
        ],
        nodeContracts: {},
        availableValuesByNode: {},
      },
    };
  }
  const parsed = workflowDefinitionV2Schema.safeParse(candidate);
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
  const v2Analysis = analyzeWorkflowV2Bindings(parsed.data, registryContext);
  const issues = dedupeIssues([...deploymentIssues, ...v2Analysis.issues]);
  return {
    parsed: parsed.data,
    response: {
      valid: issues.length === 0,
      issues,
      nodeContracts: v2Analysis.nodeContracts,
      availableValuesByNode: v2Analysis.availableValuesByNode,
    },
  };
}

/** A graph that names a schema this build no longer runs. The parse below would
 *  refuse it too, but with a literal mismatch an author cannot act on. */
export function declaresRetiredSchema(candidate: unknown): boolean {
  const version = workflowDefinitionSchemaVersionOf(candidate);
  return version !== undefined && version !== WORKFLOW_SCHEMA_VERSION;
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
