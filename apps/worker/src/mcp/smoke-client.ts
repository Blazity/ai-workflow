// C3: operator smoke-check for the deployed /mcp endpoint.
//
// This talks to the real network through the MCP SDK's HTTP client, never
// through src/mcp/server.ts or transport.ts directly. Importing the server
// would turn this into a unit test that passes even when the deployed
// process is down, which defeats the point of a deployment smoke check.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { FIRST_SLICE_TOOLS, type McpEnvelope } from "./contracts.js";

// The only tool this smoke calls: read-only, requires no arguments, and (per
// C0) is the one tool guaranteed to be registered even before C1 registers
// the remaining eight FIRST_SLICE_TOOLS.
const SMOKE_TOOL_NAME = "system.capabilities";

export type McpSmokeInput = {
  baseUrl: string;
  // Never logged or included in the returned evidence, only its length is.
  token: string | undefined;
};

export type McpSmokeRejection = {
  status: number;
  wwwAuthenticate: string | null;
};

export type McpSmokeEvidence = {
  baseUrl: string;
  // "auth_rejected" is a passing check, not a failure: a 401 with
  // WWW-Authenticate proves the deployment enforces auth correctly. Only
  // "failure" means something is actually wrong with the deployment.
  outcome: "ok" | "auth_rejected" | "failure";
  tokenLength: number | null;
  protocolVersion?: string;
  serverVersion?: string;
  contractHash?: string;
  toolCount?: number;
  toolNames?: string[];
  missingTools?: string[];
  rejection?: McpSmokeRejection;
  error?: string;
};

/**
 * Wraps fetch so a 401's WWW-Authenticate header survives long enough to be
 * reported: the SDK transport itself only keeps the HTTP status code on the
 * StreamableHTTPError it throws, it drops the header. The global is looked
 * up lazily on every call (not captured at module load) so tests can
 * vi.stubGlobal("fetch", ...) before calling runMcpSmoke.
 */
function fetchCapturingRejection(rejection: { current: McpSmokeRejection | null }): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) {
      rejection.current = {
        status: response.status,
        wwwAuthenticate: response.headers.get("WWW-Authenticate"),
      };
    }
    return response;
  };
}

// Defense in depth: if a misbehaving server ever echoed the token back into
// an error body, this keeps it out of the returned evidence anyway.
function safeErrorMessage(error: unknown, token: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join("[redacted]") : message;
}

/**
 * Accepts either the deployment host or the full endpoint, because an operator
 * handed a field called `baseUrl` passes the host. Taking the value verbatim
 * POSTed to `/` and came back "Cannot find any route matching /", which reads
 * as "MCP is broken" when the endpoint is in fact healthy: the first real run
 * against a deployment failed exactly this way. The fake server in the tests
 * answered on any path, so nothing caught it.
 */
export function resolveMcpEndpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/mcp")) url.pathname = `${path}/mcp`;
  return url;
}

export async function runMcpSmoke(input: McpSmokeInput): Promise<McpSmokeEvidence> {
  const tokenLength = input.token ? input.token.length : null;
  const rejection: { current: McpSmokeRejection | null } = { current: null };

  const transport = new StreamableHTTPClientTransport(resolveMcpEndpoint(input.baseUrl), {
    requestInit: input.token ? { headers: { Authorization: `Bearer ${input.token}` } } : undefined,
    fetch: fetchCapturingRejection(rejection),
  });
  const client = new Client({ name: "ai-workflow-mcp-smoke", version: "0.1.0" });

  try {
    await client.connect(transport);
  } catch (error) {
    // client.connect() already closes the transport internally on failure.
    if (rejection.current) {
      return {
        baseUrl: input.baseUrl,
        outcome: "auth_rejected",
        tokenLength,
        rejection: rejection.current,
      };
    }
    return {
      baseUrl: input.baseUrl,
      outcome: "failure",
      tokenLength,
      error: safeErrorMessage(error, input.token),
    };
  }

  try {
    const protocolVersion = transport.protocolVersion;
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    const missingTools = FIRST_SLICE_TOOLS.filter((name) => !toolNames.includes(name));

    const callResult = await client.callTool({ name: SMOKE_TOOL_NAME, arguments: {} });
    const envelope = callResult.structuredContent as McpEnvelope<unknown> | undefined;

    // client.callTool() does not throw for a tool-level failure: it only
    // throws when the client has a registered outputSchema for the tool. An
    // isError result or a missing envelope means system.capabilities failed
    // on the deployment, which is never "ok" even if every tool name is
    // present in tools/list.
    if (callResult.isError || !envelope) {
      return {
        baseUrl: input.baseUrl,
        outcome: "failure",
        tokenLength,
        error: callResult.isError
          ? `${SMOKE_TOOL_NAME} returned isError`
          : `${SMOKE_TOOL_NAME} did not return structuredContent`,
      };
    }

    return {
      baseUrl: input.baseUrl,
      outcome: missingTools.length > 0 ? "failure" : "ok",
      tokenLength,
      protocolVersion,
      serverVersion: envelope.meta.serverVersion,
      contractHash: envelope.meta.contractHash,
      toolCount: toolNames.length,
      toolNames,
      missingTools,
    };
  } catch (error) {
    // A 401 can also surface here (e.g. a token that expires mid-session):
    // this stateless transport re-checks auth on every request, not just on
    // initialize, so a rejection at tools/list or tools/call deserves the
    // same "expected rejection" classification as one at initialize.
    if (rejection.current) {
      return {
        baseUrl: input.baseUrl,
        outcome: "auth_rejected",
        tokenLength,
        rejection: rejection.current,
      };
    }
    return {
      baseUrl: input.baseUrl,
      outcome: "failure",
      tokenLength,
      error: safeErrorMessage(error, input.token),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export function smokeExitCode(evidence: McpSmokeEvidence): 0 | 1 {
  return evidence.outcome === "failure" ? 1 : 0;
}
