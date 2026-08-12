import { defineEventHandler, setResponseHeader } from "h3";
import { env } from "../../../../../env.js";
import { requireDashboardActor, toHttpError } from "../../../../lib/auth/request-context.js";
import { MCP_CONTRACT_ARTIFACT } from "../../../../mcp/contract-artifact.js";
import { MCP_PROTOCOL_VERSION } from "../../../../mcp/server.js";
import { MCP_ENABLED_DOMAINS } from "../../../../mcp/tool-catalog.js";

/**
 * Whether THIS deployment can serve MCP, for an operator who has a client that
 * cannot connect or that is talking to a contract this deployment does not
 * implement. It answers the four questions that produce those two symptoms: is MCP
 * switched on here, which server and protocol version is it, which contract does it
 * publish, and which tools does it actually expose.
 *
 * `contractHash` is the same constant system.capabilities returns and every audit
 * row stores, so an operator can compare an agent's complaint against a deployment
 * without a token for it. It is computed from the catalog, never read from the
 * committed snapshot, so a deployment reports the surface it really has.
 *
 * Deliberately NOT reported, even though none of it is a secret: the request and
 * result byte caps, the tool timeout, the read and mutation rate limits, the audit
 * retention window, the public-DCR flag and the dogfood fixture prefix. None of
 * them decides whether MCP is servable, and an endpoint that mirrors env is an
 * endpoint someone will reach for as a config reader, which is how the next value
 * added to env quietly becomes public. A limit an agent has to respect belongs in
 * the 429 that enforces it, not in a lobby endpoint.
 */
type McpReadinessResponse = {
  enabled: boolean;
  serverVersion: string;
  protocolVersion: string;
  contractHash: string;
  toolCount: number;
  tools: string[];
  enabledDomains: string[];
};

export default defineEventHandler(
  async (event): Promise<McpReadinessResponse | undefined> => {
    setResponseHeader(event, "Cache-Control", "no-store");

    try {
      await requireDashboardActor(event);

      return {
        enabled: env.MCP_ENABLED,
        serverVersion: env.MCP_SERVER_VERSION,
        protocolVersion: MCP_PROTOCOL_VERSION,
        contractHash: MCP_CONTRACT_ARTIFACT.contractHash,
        // Both from the artifact rather than from a second list: the count and the
        // names then cannot disagree with the hash published beside them.
        toolCount: MCP_CONTRACT_ARTIFACT.tools.length,
        tools: MCP_CONTRACT_ARTIFACT.tools.map((tool) => tool.name),
        enabledDomains: [...MCP_ENABLED_DOMAINS],
      };
    } catch (error) {
      toHttpError(error);
    }
  },
);
