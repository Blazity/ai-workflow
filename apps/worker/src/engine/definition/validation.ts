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
import { hasIntegration } from "@integrations/registry";
import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import { buildProvidesBlockType } from "./integration-block-contract.js";

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

  // A block type neither core nor an integration in this build provides. The
  // graph schema accepts it, because a definition published while an
  // integration existed has to stay readable after the build stops shipping it;
  // storing a NEW candidate carrying one is a different matter, and it is
  // refused here the way a misspelled block type always was. Nothing an admin
  // can connect brings it back, so it is not a deployment issue.
  const unknownTypes = parsed.definition.nodes.flatMap((node, index) =>
    !buildProvidesBlockType(resolveContract(node.type, {}))
      ? [
          {
            code: "schema" as const,
            severity: "error" as const,
            nodeId: node.id,
            path: `/nodes/${index}/type`,
            message: `Unknown workflow block type. ${unknownBlockTypeAdvice(node.type)}`,
          },
        ]
      : [],
  );
  if (unknownTypes.length > 0) {
    return {
      parsed: null,
      analysis: null,
      response: {
        valid: false,
        issues: unknownTypes,
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

/**
 * What to do about a block type nothing provides.
 *
 * A misspelled core type looks exactly like an integration block type, because
 * both are lowercase words joined by underscores. Telling the author of
 * `planning_agnet` to connect an integration called `planning` sends them
 * looking for something that does not exist, so the prefix decides: an
 * integration this build ships means the block was removed, and anything else
 * is far more likely a typo, answered with the nearest core type.
 */
function unknownBlockTypeAdvice(type: string): string {
  const prefix = type.slice(0, type.indexOf("_"));
  if (hasIntegration(prefix)) {
    return `The ${prefix} integration no longer provides "${type}". Remove the node, or use one of the blocks it provides now.`;
  }
  const nearest = nearestCoreBlockType(type);
  return nearest
    ? `No block type "${type}" exists. Did you mean "${nearest}"?`
    : `No block type "${type}" exists in this build, and no integration here provides one.`;
}

/** The closest core type by edit distance, when one is close enough to be worth
 *  suggesting. A quarter of the length is the threshold: far enough to catch a
 *  transposition or a dropped letter, close enough not to guess. */
function nearestCoreBlockType(type: string): string | null {
  let best: { type: string; distance: number } | null = null;
  for (const candidate of Object.keys(BLOCK_TYPE_SPECS)) {
    const distance = editDistance(type, candidate);
    if (!best || distance < best.distance) best = { type: candidate, distance };
  }
  if (!best) return null;
  return best.distance <= Math.max(1, Math.floor(type.length / 4)) ? best.type : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
