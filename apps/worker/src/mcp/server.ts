import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { env } from "../../env.js";
import type { McpToolDependencies } from "./contracts.js";
import { executeMcpRead } from "./execute-tool.js";
import { policyFor } from "./policy.js";
import { MCP_CONTRACT_HASH } from "./sanitize-result.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;

export function createMcpServer(deps: McpToolDependencies): McpServer {
  const server = new McpServer({
    name: "ai-workflow-worker",
    version: env.MCP_SERVER_VERSION,
  });

  server.registerTool(
    "system.capabilities",
    {
      description: "Describe this authenticated MCP deployment.",
      inputSchema: z.object({}).strict(),
      annotations: policyFor("system.capabilities").annotations,
    },
    async () => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "system.capabilities",
        targetRefs: [],
        operation: async () => ({
          protocolVersions: [MCP_PROTOCOL_VERSION],
          serverVersion: env.MCP_SERVER_VERSION,
          contractHash: MCP_CONTRACT_HASH,
          deploymentClass: "dedicated-worker",
          enabledDomains: ["system"],
          readScopes: [...deps.actor.scopes].filter((scope) => scope === "mcp:read"),
        }),
      });
      envelope.meta.trust = "system";
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  return server;
}
