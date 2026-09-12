import type {
  VcsProviderKind,
  WorkflowBlockContractResolver,
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
import {
  type WorkflowValueAnalysis,
  type WorkflowValueAnalyzer,
} from "./available-values.js";
import {
  workflowDefinitionV2Schema,
  type WorkflowBlockParamsSchemas,
} from "@shared/workflow-graph";
import { validateWorkflowDefinitionIssuesForDeployment } from "./deployment-validation.js";

/**
 * `analysis` is the one available-values pass this validation ran. A caller
 * that goes on to check prompt authoring, or to render what the graph offers,
 * reads it instead of walking the graph again.
 */
export type WorkflowDefinitionCandidateValidation =
  | {
      parsed: WorkflowDefinition;
      analysis: WorkflowValueAnalysis;
      response: WorkflowDefinitionValidationResponse;
    }
  | {
      parsed: null;
      analysis: null;
      response: WorkflowDefinitionValidationResponse;
    };

/**
 * Validates one exact candidate and returns API-ready issues. Node ownership and
 * JSON paths are attached while the source validation still has that context;
 * callers never recover structure by parsing human-readable messages.
 */
export function validateWorkflowDefinitionCandidate(
  candidate: unknown,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
  analyzeValues: WorkflowValueAnalyzer,
): WorkflowDefinitionCandidateValidation {
  if (declaresRetiredSchema(candidate)) {
    return {
      parsed: null,
      analysis: null,
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
      analysis: null,
      response: {
        valid: false,
        issues: structuralIssues(candidate, parsed.error),
        nodeContracts: {},
        availableValuesByNode: {},
      },
    };
  }

  const analysis = analyzeValues(parsed.data);
  const deploymentIssues = validateWorkflowDefinitionIssuesForDeployment(
    parsed.data,
    resolveContract,
    blockParamsSchemas,
    configuredVcsProviders,
    analysis,
  );
  const issues = dedupeIssues([...deploymentIssues, ...analysis.issues]);
  return {
    parsed: parsed.data,
    analysis,
    response: {
      valid: issues.length === 0,
      issues,
      nodeContracts: analysis.nodeContracts,
      availableValuesByNode: analysis.availableValuesByNode,
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
