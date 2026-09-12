import type {
  VcsProviderKind,
  WorkflowBlockContractResolver,
  WorkflowDefinition,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import {
  declaresRetiredSchema,
  parse,
  type WorkflowBlockParamsSchemas,
  type WorkflowValueAnalysis,
  type WorkflowValueAnalyzer,
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
 * Validates one exact candidate and returns API-ready issues. The parse policy
 * attaches node ownership and JSON paths while it still has that context, so
 * callers never recover structure by parsing human-readable messages, and the
 * deploy policy de-duplicates the list it composes, so nothing is deduped again
 * here.
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
  const parsed = parse(candidate);
  if (parsed.definition === null) {
    return {
      parsed: null,
      analysis: null,
      response: {
        valid: false,
        issues: parsed.issues,
        nodeContracts: {},
        availableValuesByNode: {},
      },
    };
  }

  const analysis = analyzeValues(parsed.definition);
  // The deployment walk already carries this pass, so its de-duplicated list is
  // the answer: appending the pass a second time could only repeat it.
  const issues = validateWorkflowDefinitionIssuesForDeployment(
    parsed.definition,
    resolveContract,
    blockParamsSchemas,
    configuredVcsProviders,
    analysis,
  );
  return {
    parsed: parsed.definition,
    analysis,
    response: {
      valid: issues.length === 0,
      issues,
      nodeContracts: analysis.nodeContracts,
      availableValuesByNode: analysis.availableValuesByNode,
    },
  };
}
