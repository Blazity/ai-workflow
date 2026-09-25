/**
 * Which Harness Profiles an agent block can pin, as a tool.
 *
 * A graph chooses the model an agent runs on by pinning a profile version in
 * the node's `configuration.harnessProfile`. Nothing on this surface named a
 * profile, so a graph authored over MCP could only take the built-in default,
 * whose provider and model blocks.get shows as `defaults` and which may be an
 * account nobody meant to spend. This is the read half the dashboard's
 * Harness page has; authoring and publishing a profile stay there.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { HarnessProfilePinOption } from "../../services/harness/index.js";
import type { McpToolDependencies } from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { mcpEnvelopeResult, registerCatalogTool } from "../tool-catalog.js";

interface HarnessProfilesListData {
  profiles: HarnessProfilePinOption[];
}

export function registerHarnessProfileTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(server, "harness_profiles.list", async () => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "harness_profiles.list",
      targetRefs: [],
      operation: async (): Promise<HarnessProfilesListData> => ({
        profiles: await deps.services.listHarnessProfilePins(deps.actor.organizationId),
      }),
    });
    return mcpEnvelopeResult(envelope);
  });
}
