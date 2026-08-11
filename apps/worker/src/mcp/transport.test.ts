import { createServer } from "node:http";
import { once } from "node:events";

import { createApp, toNodeListener } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpPublicError, type McpActorContext } from "./contracts.js";

const state = vi.hoisted(() => ({
  env: {
    MCP_ENABLED: true,
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_REQUEST_BYTES: 4_096,
    MCP_MAX_RESULT_BYTES: 2_048,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    BETTER_AUTH_URL: "https://worker.example.com",
  },
  requireMcpActor: vi.fn(),
}));

vi.mock("../../env.js", () => ({ env: state.env }));
vi.mock("./request-context.js", () => ({
  requireMcpActor: state.requireMcpActor,
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../lib/adapters.js", () => ({ createAdapters: () => ({}) }));

const mcpPost = (await import("../routes/mcp.post.js")).default;
const mcpGet = (await import("../routes/mcp.get.js")).default;
const mcpDelete = (await import("../routes/mcp.delete.js")).default;

const ACTOR: McpActorContext = {
  kind: "user",
  subject: "user_1",
  userId: "user_1",
  clientId: "client_1",
  organizationId: "org_1",
  organizationSlug: "ai-workflow",
  role: "member",
  scopes: new Set(["mcp:read"]),
  audience: "https://worker.example.com/mcp",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.env.MCP_ENABLED = true;
  state.env.MCP_MAX_REQUEST_BYTES = 4_096;
  state.requireMcpActor.mockImplementation(async (request: Request) => {
    const authorization = request.headers.get("authorization");
    if (authorization === "Bearer valid-token") return ACTOR;
    throw new McpPublicError("UNAUTHENTICATED", "Authentication required", false);
  });
});

describe("stateless MCP Streamable HTTP", () => {
  it("handles a real 2025-11-25 initialize request without creating a session", async () => {
    const response = await post(initializeRequest(1));

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "ai-workflow-worker", version: "0.1.0" },
      },
    });
  });

  it("creates a fresh server and transport for every POST", async () => {
    const first = await post(initializeRequest(7));
    const second = await post(initializeRequest(7));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: 7, result: { protocolVersion: "2025-11-25" } });
    expect(await second.json()).toMatchObject({ id: 7, result: { protocolVersion: "2025-11-25" } });
    expect(first.headers.get("mcp-session-id")).toBeNull();
    expect(second.headers.get("mcp-session-id")).toBeNull();
  });

  it("lists the currently registered tool on a sessionless follow-up request", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-protocol-version": "2025-11-25" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 2,
      result: { tools: [{ name: "system.capabilities" }] },
    });
  });

  it("rejects non-JSON content before authentication", async () => {
    const response = await post(initializeRequest(3), { "content-type": "text/plain" });

    expect(response.status).toBe(415);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it("rejects request bodies over the configured byte limit", async () => {
    state.env.MCP_MAX_REQUEST_BYTES = 32;

    const response = await post(initializeRequest(4));

    expect(response.status).toBe(413);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it("rejects batches and protocol versions other than 2025-11-25", async () => {
    const batch = await post([initializeRequest(1), initializeRequest(2)]);
    const oldVersion = await post({
      ...initializeRequest(5),
      params: { ...initializeRequest(5).params, protocolVersion: "2025-06-18" },
    });

    expect(batch.status).toBe(400);
    expect(oldVersion.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
    await expect(oldVersion.json()).resolves.toMatchObject({
      error: { data: { code: "VALIDATION_FAILED" } },
    });
  });

  it("returns a minimal bearer challenge for missing or wrong-audience tokens", async () => {
    const missing = await post(initializeRequest(6), {}, null);
    const wrongAudience = await post(initializeRequest(7), {}, "wrong-audience-token");

    const challenge =
      'Bearer resource_metadata="https://worker.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp:read"';
    expect(missing.status).toBe(401);
    expect(wrongAudience.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(challenge);
    expect(wrongAudience.headers.get("www-authenticate")).toBe(challenge);
    await expect(wrongAudience.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Authentication required",
        data: { code: "UNAUTHENTICATED", retryable: false },
      },
      id: null,
    });
  });

  it("returns 405 with Allow POST for GET and DELETE", async () => {
    const getResponse = await methodRequest(mcpGet, "GET");
    const deleteResponse = await methodRequest(mcpDelete, "DELETE");

    expect(getResponse.status).toBe(405);
    expect(deleteResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(deleteResponse.headers.get("allow")).toBe("POST");
  });

  it("returns 404 before authentication when MCP is disabled", async () => {
    state.env.MCP_ENABLED = false;

    const response = await post(initializeRequest(8));

    expect(response.status).toBe(404);
    expect(state.requireMcpActor).not.toHaveBeenCalled();
  });
});

function initializeRequest(id: number) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "initialize" as const,
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "task-5-test", version: "1.0.0" },
    },
  };
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  token: string | null = "valid-token",
) {
  const app = createApp();
  app.use("/", mcpPost);
  return requestApp(
    app,
    "/mcp",
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

async function methodRequest(handler: typeof mcpGet, method: "GET" | "DELETE") {
  const app = createApp();
  app.use("/", handler);
  return requestApp(app, "/mcp", { method });
}

async function requestApp(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const server = createServer(toNodeListener(app));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
}
