import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { env } from "../../env.js";
import type { McpToolDependencies } from "./contracts.js";
import { executeMcpRead } from "./execute-tool.js";
import { MCP_CONTRACT_HASH } from "./sanitize-result.js";
import { MCP_ENABLED_DOMAINS, registerCatalogTool } from "./tool-catalog.js";
import { authoringAnnouncementDelivery } from "./tools/authoring-support.js";
import { registerBlockTools } from "./tools/blocks.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerPromptAuthoringTools } from "./tools/prompt-authoring.js";
import { registerRunControlTools } from "./tools/run-control.js";
import { registerRunStatsTools } from "./tools/run-stats.js";
import { registerRunTools } from "./tools/runs.js";
import { registerTicketWriteTools } from "./tools/ticket-write.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerWorkflowAuthoringTools } from "./tools/workflow-authoring.js";
import { registerWorkflowTools } from "./tools/workflows.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
] as const;

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
        protocolVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
        serverVersion: env.MCP_SERVER_VERSION,
        contractHash: MCP_CONTRACT_HASH,
        deploymentClass: "dedicated-worker",
        enabledDomains: [...MCP_ENABLED_DOMAINS],
        readScopes: [...deps.actor.scopes].filter((scope) => scope === "mcp:read"),
        // Whether a successful prompts.update or workflows.publish reaches a person:
        // "none" means no chat channel is configured, so the announcement those tools
        // send goes nowhere and the audit row is the whole record. Published because
        // a client is entitled to know it is unobserved, and an operator running the
        // smoke client is entitled to find that out before an incident does.
        authoringAnnouncements: authoringAnnouncementDelivery(deps.adapters?.messaging),
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
  registerWorkflowAuthoringTools(server, deps);
  registerRunControlTools(server, deps);
  registerTicketWriteTools(server, deps);
  registerBlockTools(server, deps);
  registerRunStatsTools(server, deps);

  return server;
}
