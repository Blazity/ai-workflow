import assert from "node:assert/strict";
import { mock, test } from "node:test";

type ModuleMock = typeof mock & {
  module: (
    specifier: string,
    options: { namedExports: Record<string, unknown> },
  ) => void;
};

const state = {
  sessionToken: undefined as string | undefined,
  workerBaseUrl: "https://worker.example.com",
  fetchCalls: [] as Array<{ path: string; init: RequestInit }>,
  workerResponse: Response.json({ token: "opaque-handoff-token-123456" }),
};

const moduleMock = (mock as ModuleMock).module?.bind(mock);
if (!moduleMock) {
  test("MCP session handoff route requires Node module mocks", { skip: true });
} else {
  moduleMock("next/headers", {
    namedExports: {
      cookies: async () => ({
        get: (name: string) =>
          name === "ba_session" && state.sessionToken
            ? { value: state.sessionToken }
            : undefined,
      }),
    },
  });
  moduleMock("@/lib/auth/worker", {
    namedExports: {
      fetchAuthWorker: async (path: string, init: RequestInit) => {
        state.fetchCalls.push({ path, init });
        return state.workerResponse;
      },
      readWorkerJson: async <T>(response: Response) => (await response.json()) as T,
    },
  });
  moduleMock("@/lib/auth/worker-core", {
    namedExports: {
      workerUrl: (base: string | undefined, path: string) => {
        if (!base) throw new Error("WORKER_BASE_URL is required");
        return `${base}${path}`;
      },
    },
  });

  const route = import("./route.ts");

  async function get(request: Request) {
    return (await route).GET(request);
  }

  function reset() {
    state.sessionToken = "raw-dashboard-session-token";
    state.workerBaseUrl = "https://worker.example.com";
    state.fetchCalls.length = 0;
    state.workerResponse = Response.json({ token: "opaque-handoff-token-123456" });
    process.env.WORKER_BASE_URL = state.workerBaseUrl;
  }

  test("bridges ba_session through a server-side bearer call", async () => {
    reset();

    const response = await get(
      new Request("https://dashboard.example.com/api/auth/sso/mcp-session"),
    );

    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://worker.example.com/mcp-auth/login?handoff=opaque-handoff-token-123456",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(state.fetchCalls.length, 1);
    assert.equal(state.fetchCalls[0]?.path, "/api/dashboard-auth/sso/mcp-session");
    assert.equal(
      new Headers(state.fetchCalls[0]?.init.headers).get("authorization"),
      "Bearer raw-dashboard-session-token",
    );
    assert.equal(
      response.headers.get("location")?.includes("raw-dashboard-session-token"),
      false,
    );
  });

  test("falls back to worker login when ba_session is absent", async () => {
    reset();
    state.sessionToken = undefined;

    const response = await get(
      new Request("https://dashboard.example.com/api/auth/sso/mcp-session"),
    );

    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://worker.example.com/mcp-auth/login?fallback=1",
    );
    assert.equal(state.fetchCalls.length, 0);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("falls back when the worker rejects the session", async () => {
    reset();
    state.workerResponse = new Response(null, { status: 401 });

    const response = await get(
      new Request("https://dashboard.example.com/api/auth/sso/mcp-session"),
    );

    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://worker.example.com/mcp-auth/login?fallback=1",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("falls back when the worker returns a non-opaque token", async () => {
    reset();
    state.workerResponse = Response.json({ token: "raw.session.token" });

    const response = await get(
      new Request("https://dashboard.example.com/api/auth/sso/mcp-session"),
    );

    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://worker.example.com/mcp-auth/login?fallback=1",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("falls back to the dashboard login when the worker base URL is missing", async () => {
    reset();
    process.env.WORKER_BASE_URL = "";

    const response = await get(
      new Request("https://dashboard.example.com/api/auth/sso/mcp-session"),
    );

    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://dashboard.example.com/login");
    assert.equal(state.fetchCalls.length, 0);
  });
}
