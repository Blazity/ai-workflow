import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { WorkflowBlockContract } from "@shared/contracts";

import { buildWorkflowBlockRegistry } from "../../workflow-definition/block-registry.js";
import { workflowBlockRegistryContextFromEnv } from "../../workflow-definition/models.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { registerCatalogTool } from "../tool-catalog.js";

type BlocksListData = {
  blocks: WorkflowBlockContract[];
};

// Environment-derived (which agent, VCS and messaging providers this deployment
// has configured) and cheap to recompute -- the same function
// buildWorkflowEditorOptions calls on every dashboard load (workflow-definition/
// models.ts:120) -- so it is read fresh per call rather than cached. A provider
// that comes online mid-process (a rotated token, a newly configured Slack
// channel) is then visible on the very next call instead of waiting for a
// restart.
function buildRegistry(): Record<string, WorkflowBlockContract> {
  return buildWorkflowBlockRegistry(workflowBlockRegistryContextFromEnv());
}

export function registerBlockTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "blocks.list",
    async () => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "blocks.list",
        targetRefs: [],
        operation: async (): Promise<BlocksListData> => {
          const registry = buildRegistry();
          return {
            blocks: Object.values(registry).sort((a, b) => a.type.localeCompare(b.type)),
          };
        },
      });
      // No trust override: descriptions are this deployment's own copy today, but
      // the same envelope shape every other read answers with is one fewer thing
      // an agent has to special-case.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "blocks.get",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "blocks.get",
        targetRefs: [input.type],
        operation: async (): Promise<WorkflowBlockContract> => {
          const registry = buildRegistry();
          const contract = registry[input.type];
          if (!contract) throw new McpPublicError("NOT_FOUND", "Unknown block type", false);
          return contract;
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
