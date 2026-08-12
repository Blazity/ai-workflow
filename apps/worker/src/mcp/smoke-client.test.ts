import { afterEach, describe, expect, it, vi } from "vitest";

import { FIRST_SLICE_TOOLS } from "./contracts.js";
import { runMcpSmoke, smokeExitCode } from "./smoke-client.js";

// Mirrors src/mcp/server.ts's MCP_PROTOCOL_VERSION constant for the fake
// server's initialize response. Duplicated on purpose instead of imported:
// this test double stands in for the deployed process, and smoke-client.ts
// must never import server.ts (see the module comment there). Keep this in
// sync by hand if the real constant ever changes.
const FAKE_SERVER_PROTOCOL_VERSION = "2025-11-25";
const FAKE_SERVER_VERSION = "9.9.9-fake";
const FAKE_CONTRACT_HASH = "fake-contract-hash-abc123";
const BASE_URL = "https://worker.example.com/mcp";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function unauthorizedResponse(wwwAuthenticate: string): Response {
  return new Response(null, {
    status: 401,
    headers: { "WWW-Authenticate": wwwAuthenticate },
  });
}

function capabilitiesEnvelope() {
  return {
    data: {
      protocolVersions: [FAKE_SERVER_PROTOCOL_VERSION],
      serverVersion: FAKE_SERVER_VERSION,
      contractHash: FAKE_CONTRACT_HASH,
      deploymentClass: "dedicated-worker",
      enabledDomains: ["system"],
      readScopes: ["mcp:read"],
    },
    meta: {
      requestId: "request-fake",
      traceId: "trace-fake",
      serverVersion: FAKE_SERVER_VERSION,
      contractHash: FAKE_CONTRACT_HASH,
      trust: "system",
      truncated: false,
      redactions: 0,
    },
  };
}

// Stands in for the deployed worker process: a fake HTTP handler for POST
// /mcp that speaks just enough Streamable HTTP JSON-RPC to drive initialize,
// tools/list and one tools/call, gated by a pluggable auth check.
function fakeMcpServer(options: {
  // Takes the JSON-RPC method too, so a test can simulate a token that is
  // accepted at initialize but rejected later (e.g. expires mid-session).
  isAuthorized: (authHeader: string | null, method: string | undefined) => boolean;
  wwwAuthenticate: string;
  toolNames: readonly string[];
  toolCallOutcome?: "ok" | "isError" | "missing_structured_content";
}) {
  return vi.fn(async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const message = JSON.parse(String(init?.body ?? "{}")) as {
      id?: string | number;
      method?: string;
    };

    if (!options.isAuthorized(headers.get("authorization"), message.method)) {
      return unauthorizedResponse(options.wwwAuthenticate);
    }

    switch (message.method) {
      case "initialize":
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: FAKE_SERVER_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "ai-workflow-worker", version: FAKE_SERVER_VERSION },
          },
        });
      case "notifications/initialized":
        // No id on a notification: the transport just releases the
        // connection, it does not parse a JSON-RPC body out of this.
        return new Response(null, { status: 200 });
      case "tools/list":
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: options.toolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
          },
        });
      case "tools/call": {
        if (options.toolCallOutcome === "isError") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: "system.capabilities failed inside the tool" }],
              isError: true,
            },
          });
        }
        if (options.toolCallOutcome === "missing_structured_content") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: "no structuredContent on this result" }],
            },
          });
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(capabilitiesEnvelope()) }],
            structuredContent: capabilitiesEnvelope(),
          },
        });
      }
      default:
        throw new Error(`fakeMcpServer: unhandled method ${message.method}`);
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runMcpSmoke", () => {
  it("walks initialize, tools/list and system.capabilities on the happy path", async () => {
    const token = "super-secret-happy-path-token";
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        isAuthorized: (authHeader) => authHeader === `Bearer ${token}`,
        wwwAuthenticate: "Bearer realm=\"mcp\"",
        toolNames: FIRST_SLICE_TOOLS,
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token });

    expect(evidence.outcome).toBe("ok");
    expect(evidence.protocolVersion).toBe(FAKE_SERVER_PROTOCOL_VERSION);
    expect(evidence.serverVersion).toBe(FAKE_SERVER_VERSION);
    expect(evidence.contractHash).toBe(FAKE_CONTRACT_HASH);
    expect(evidence.toolCount).toBe(FIRST_SLICE_TOOLS.length);
    expect(evidence.toolNames).toEqual(Array.from(FIRST_SLICE_TOOLS));
    expect(evidence.missingTools).toEqual([]);
    expect(evidence.tokenLength).toBe(token.length);
    expect(smokeExitCode(evidence)).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  it("reports a missing tool as a mismatch and fails the exit code", async () => {
    const token = "another-secret-token";
    const incompleteToolNames = FIRST_SLICE_TOOLS.filter((name) => name !== "workflows.dispatch");
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        isAuthorized: (authHeader) => authHeader === `Bearer ${token}`,
        wwwAuthenticate: "Bearer realm=\"mcp\"",
        toolNames: incompleteToolNames,
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token });

    expect(evidence.outcome).toBe("failure");
    expect(evidence.missingTools).toEqual(["workflows.dispatch"]);
    expect(evidence.toolCount).toBe(incompleteToolNames.length);
    expect(smokeExitCode(evidence)).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  it("reports a missing token as an expected 401 rejection, not a failure", async () => {
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        isAuthorized: (authHeader) => authHeader != null,
        wwwAuthenticate: "Bearer realm=\"mcp\", error=\"invalid_request\"",
        toolNames: FIRST_SLICE_TOOLS,
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token: undefined });

    expect(evidence.outcome).toBe("auth_rejected");
    expect(evidence.rejection?.status).toBe(401);
    expect(evidence.rejection?.wwwAuthenticate).toBe("Bearer realm=\"mcp\", error=\"invalid_request\"");
    expect(evidence.tokenLength).toBeNull();
    expect(smokeExitCode(evidence)).toBe(0);
  });

  it("reports an expired or invalid token as an expected 401 rejection", async () => {
    const token = "expired-token-xyz";
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        isAuthorized: (authHeader) => authHeader === "Bearer a-currently-valid-token",
        wwwAuthenticate: "Bearer realm=\"mcp\", error=\"invalid_token\", error_description=\"expired\"",
        toolNames: FIRST_SLICE_TOOLS,
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token });

    expect(evidence.outcome).toBe("auth_rejected");
    expect(evidence.rejection?.status).toBe(401);
    expect(evidence.rejection?.wwwAuthenticate).toContain("invalid_token");
    expect(smokeExitCode(evidence)).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  it("reports a token issued for the wrong audience as an expected 401 rejection", async () => {
    const token = "wrong-audience-token-abc";
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        isAuthorized: (authHeader) => authHeader === "Bearer a-currently-valid-token",
        wwwAuthenticate: "Bearer realm=\"mcp\", error=\"invalid_token\", error_description=\"audience mismatch\"",
        toolNames: FIRST_SLICE_TOOLS,
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token });

    expect(evidence.outcome).toBe("auth_rejected");
    expect(evidence.rejection?.status).toBe(401);
    expect(evidence.rejection?.wwwAuthenticate).toContain("audience mismatch");
    expect(smokeExitCode(evidence)).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  it("reports a tool-call isError result as a failure, not ok", async () => {
    const token = "iserror-token";
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        isAuthorized: (authHeader) => authHeader === `Bearer ${token}`,
        wwwAuthenticate: "Bearer realm=\"mcp\"",
        toolNames: FIRST_SLICE_TOOLS,
        toolCallOutcome: "isError",
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token });

    expect(evidence.outcome).toBe("failure");
    expect(evidence.serverVersion).toBeUndefined();
    expect(evidence.contractHash).toBeUndefined();
    expect(smokeExitCode(evidence)).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  it("reports a tool-call result missing structuredContent as a failure, not ok", async () => {
    const token = "missing-structured-content-token";
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        isAuthorized: (authHeader) => authHeader === `Bearer ${token}`,
        wwwAuthenticate: "Bearer realm=\"mcp\"",
        toolNames: FIRST_SLICE_TOOLS,
        toolCallOutcome: "missing_structured_content",
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token });

    expect(evidence.outcome).toBe("failure");
    expect(evidence.serverVersion).toBeUndefined();
    expect(evidence.contractHash).toBeUndefined();
    expect(smokeExitCode(evidence)).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });

  it("reports a 401 surfacing at tools/list (not initialize) as an expected rejection", async () => {
    const token = "token-that-expires-mid-session";
    vi.stubGlobal(
      "fetch",
      fakeMcpServer({
        // Authorized through the handshake, rejected once tools/list is
        // requested: simulates a token expiring mid-session against this
        // stateless transport, which re-checks auth on every request.
        isAuthorized: (_authHeader, method) => method !== "tools/list",
        wwwAuthenticate: "Bearer realm=\"mcp\", error=\"invalid_token\", error_description=\"expired mid-session\"",
        toolNames: FIRST_SLICE_TOOLS,
      }),
    );

    const evidence = await runMcpSmoke({ baseUrl: BASE_URL, token });

    expect(evidence.outcome).toBe("auth_rejected");
    expect(evidence.rejection?.status).toBe(401);
    expect(evidence.rejection?.wwwAuthenticate).toContain("expired mid-session");
    expect(smokeExitCode(evidence)).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain(token);
  });
});
