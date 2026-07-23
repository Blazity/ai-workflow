import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "admin" as "owner" | "admin" | "member",
}));
const preflight = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() => vi.fn());

vi.mock("../../env.js", () => ({
  env: { MAX_CONCURRENT_AGENTS: 4 },
}));
vi.mock("../db/client.js", () => ({
  getDb: () => ({ kind: "db" }),
}));
vi.mock("../lib/adapters.js", () => ({
  createAdapters: () => ({ kind: "adapters" }),
}));
vi.mock("../lib/auth/request-context.js", () => ({
  requireDashboardActor: async () => ({
    role: state.role,
    userId: "user-1",
    organizationName: "AI Workflow",
  }),
}));
vi.mock("../pre-pr-checks/store.js", () => ({
  dashboardUserLabel: async () => "Karol",
}));
vi.mock("./service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service.js")>();
  return {
    ...actual,
    preflightManualDispatch: (...args: unknown[]) => preflight(...args),
    dispatchManualWorkflow: (...args: unknown[]) => dispatch(...args),
  };
});

const dispatchRoute = (
  await import(
    "../routes/api/v1/workflow-definitions/[id]/triggers/[nodeId]/manual-dispatch.post.js"
  )
).default;
const preflightRoute = (
  await import(
    "../routes/api/v1/workflow-definitions/[id]/triggers/[nodeId]/manual-dispatch/preflight.post.js"
  )
).default;

function routeHandler(
  pattern: string,
  route: Parameters<ReturnType<typeof createRouter>["post"]>[1],
) {
  const app = createApp();
  const router = createRouter();
  router.post(pattern, route);
  app.use(router);
  return toWebHandler(app);
}

const dispatchHandler = routeHandler(
  "/api/v1/workflow-definitions/:id/triggers/:nodeId/manual-dispatch",
  dispatchRoute,
);
const preflightHandler = routeHandler(
  "/api/v1/workflow-definitions/:id/triggers/:nodeId/manual-dispatch/preflight",
  preflightRoute,
);

function post(path: string, body: unknown) {
  return new Request(`http://worker.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.role = "admin";
  preflight.mockReset().mockResolvedValue({
    definitionId: 9,
    definitionName: "Standard delivery",
    deployedVersion: 3,
    triggerNodeId: "ticket-trigger",
    triggerType: "trigger_ticket_ai",
    input: { kind: "ticket", ticketKey: "AIW-173" },
    subject: { kind: "ticket", key: "AIW-173", title: "Manual dispatch" },
    steps: [],
    runnable: true,
  });
  dispatch.mockReset().mockResolvedValue({
    requestId: "1b02cf6d-d510-4ae1-a26d-c22f777b1b3a",
    status: "started",
    runId: "run-1",
  });
});

describe("manual dispatch routes", () => {
  it.each(["owner", "admin"] as const)(
    "allows %s to preflight a deployed trigger",
    async (role) => {
      state.role = role;
      const response = await preflightHandler(
        post(
          "/api/v1/workflow-definitions/9/triggers/ticket-trigger/manual-dispatch/preflight",
          { kind: "ticket", ticketKey: "AIW-173" },
        ),
      );
      expect(response.status).toBe(200);
      expect(preflight).toHaveBeenCalledWith(
        expect.objectContaining({
          definitionId: 9,
          triggerNodeId: "ticket-trigger",
          dispatchInput: { kind: "ticket", ticketKey: "AIW-173" },
        }),
      );
    },
  );

  it("rejects members before preflight", async () => {
    state.role = "member";
    const response = await preflightHandler(
      post(
        "/api/v1/workflow-definitions/9/triggers/ticket-trigger/manual-dispatch/preflight",
        { kind: "ticket", ticketKey: "AIW-173" },
      ),
    );
    expect(response.status).toBe(403);
    expect(preflight).not.toHaveBeenCalled();
  });

  it("returns 201 for a started dispatch and records the actor", async () => {
    const response = await dispatchHandler(
      post(
        "/api/v1/workflow-definitions/9/triggers/ticket-trigger/manual-dispatch",
        {
          requestId: "1b02cf6d-d510-4ae1-a26d-c22f777b1b3a",
          expectedDeployedVersion: 3,
          input: { kind: "ticket", ticketKey: "aiw-173" },
        },
      ),
    );
    expect(response.status).toBe(201);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionId: 9,
        triggerNodeId: "ticket-trigger",
        actor: { id: "user-1", label: "Karol" },
        request: expect.objectContaining({
          expectedDeployedVersion: 3,
          input: { kind: "ticket", ticketKey: "aiw-173" },
        }),
      }),
    );
  });

  it("returns 202 when durable recovery owns the accepted request", async () => {
    dispatch.mockResolvedValueOnce({
      requestId: "1b02cf6d-d510-4ae1-a26d-c22f777b1b3a",
      status: "recovering",
    });
    const response = await dispatchHandler(
      post(
        "/api/v1/workflow-definitions/9/triggers/ticket-trigger/manual-dispatch",
        {
          requestId: "1b02cf6d-d510-4ae1-a26d-c22f777b1b3a",
          expectedDeployedVersion: 3,
          input: { kind: "ticket", ticketKey: "AIW-173" },
        },
      ),
    );
    expect(response.status).toBe(202);
  });

  it("rejects malformed request IDs before dispatch", async () => {
    const response = await dispatchHandler(
      post(
        "/api/v1/workflow-definitions/9/triggers/ticket-trigger/manual-dispatch",
        {
          requestId: "not-a-request-id",
          expectedDeployedVersion: 3,
          input: { kind: "ticket", ticketKey: "AIW-173" },
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
