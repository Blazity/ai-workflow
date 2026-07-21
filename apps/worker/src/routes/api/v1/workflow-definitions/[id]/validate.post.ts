import { defineEventHandler, readBody } from "h3";
import type {
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionValidationResponse,
} from "@shared/contracts";
import { requireDashboardActor, toHttpError } from "../../../../../lib/auth/request-context.js";
import { workflowBlockRegistryContextFromEnv } from "../../../../../workflow-definition/models.js";
import { resolveWorkflowBlockContract } from "../../../../../workflow-definition/block-registry.js";
import {
  describeWorkflowDefinitionIssues,
  validateWorkflowDefinitionForDeployment,
  workflowDefinitionSchema,
} from "../../../../../workflow-definition/schema.js";

export default defineEventHandler(
  async (event): Promise<WorkflowDefinitionValidationResponse | undefined> => {
    try {
      await requireDashboardActor(event);
      const body = (await readBody<{ definition?: unknown }>(event).catch(() => null)) ?? {};
      const parsed = workflowDefinitionSchema.safeParse(body.definition);
      if (!parsed.success) {
        return {
          valid: false,
          issues: [
            {
              code: "schema",
              nodeId: null,
              message: `Invalid definition: ${describeWorkflowDefinitionIssues(parsed.error)}`,
            },
          ],
          nodeContracts: {},
        };
      }
      const registryContext = workflowBlockRegistryContextFromEnv();
      const issues = validateWorkflowDefinitionForDeployment(parsed.data, registryContext).map(
        structuredDeploymentIssue,
      );
      return {
        valid: issues.length === 0,
        issues,
        nodeContracts: Object.fromEntries(
          parsed.data.nodes.map((node) => [
            node.id,
            resolveWorkflowBlockContract(node.type, node.params, registryContext),
          ]),
        ),
      };
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      toHttpError(error);
    }
  },
);

function structuredDeploymentIssue(message: string): WorkflowDefinitionValidationIssue {
  const match = /^(?:Block|Branch|Loop) "([^"]+)"/.exec(message);
  return {
    code: "deployment",
    nodeId: match?.[1] ?? null,
    message,
  };
}
