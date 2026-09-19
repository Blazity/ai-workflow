import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { WorkflowBlockContract } from "@shared/contracts";

import { agentFacingBlockContracts } from "../integration-facts.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { registerCatalogTool } from "../tool-catalog.js";

type BlocksListData = {
  blocks: WorkflowBlockContract[];
};

// Credential-derived (which agent, VCS and messaging providers this deployment
// has configured) and cheap to recompute -- the same block data the dashboard's
// editor read binds on every load -- so it is read fresh per call rather than
// cached. A provider that comes online mid-process (a rotated token, a newly
// configured Slack channel) is then visible on the very next call instead of
// waiting for a restart. The agent default comes from the built-in Harness
// Profile because this catalog call has no run-specific profile.
async function buildRegistry(
  _deps: McpToolDependencies,
): Promise<Record<string, WorkflowBlockContract>> {
  // Through the connected variant, so the catalog an agent reads holds the
  // blocks of the integrations this deployment has connected and says which of
  // them are usable. Reading the core-only map here would let an agent build a
  // graph the dashboard accepts and this tool's own save then refuses.
  //
  // Agent-facing: the verdict is the editor's own, and the sentence beside it
  // is the one a model may read. The admin's version names the variable that is
  // missing, which is the one thing ADR-010 decision 15 keeps off this surface.
  return (await agentFacingBlockContracts()).blockRegistry();
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
          const registry = await buildRegistry(deps);
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
          const registry = await buildRegistry(deps);
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
