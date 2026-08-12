import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { env } from "../../env.js";
import type { McpToolDependencies } from "./contracts.js";
import { executeMcpRead } from "./execute-tool.js";
import { MCP_CONTRACT_HASH } from "./sanitize-result.js";
import { MCP_ENABLED_DOMAINS, registerCatalogTool } from "./tool-catalog.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerPromptAuthoringTools } from "./tools/prompt-authoring.js";
import { registerRunTools } from "./tools/runs.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerWorkflowTools } from "./tools/workflows.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;

export function createMcpServer(deps: McpToolDependencies): McpServer {
  const server = new McpServer({
    name: "ai-workflow-worker",
    version: env.MCP_SERVER_VERSION,
  });

  // Registered in FIRST_SLICE_TOOLS order, so tools/list enumerates the surface
  // in the order the contract publishes it.
  registerCatalogTool(server, "system.capabilities", async () => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "system.capabilities",
      targetRefs: [],
      operation: async () => ({
        protocolVersions: [MCP_PROTOCOL_VERSION],
        serverVersion: env.MCP_SERVER_VERSION,
        contractHash: MCP_CONTRACT_HASH,
        deploymentClass: "dedicated-worker",
        enabledDomains: [...MCP_ENABLED_DOMAINS],
        readScopes: [...deps.actor.scopes].filter((scope) => scope === "mcp:read"),
      }),
    });
    envelope.meta.trust = "system";
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      structuredContent: envelope,
    };
  });
  registerTicketTools(server, deps);
  registerRunTools(server, deps);
  registerWorkflowTools(server, deps);
  registerDiscoveryTools(server, deps);
  registerPromptAuthoringTools(server, deps);

  return server;
}
