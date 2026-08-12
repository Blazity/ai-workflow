import { describe, expect, it } from "vitest";

import type { McpActorContext, McpScope } from "./contracts.js";
import { authorizeTool, policyFor } from "./policy.js";

function actor(
  role: McpActorContext["role"],
  scopes: readonly McpScope[],
): McpActorContext {
  return {
    kind: role === "service" ? "service" : "user",
    subject: role === "service" ? "client:fixture" : "user:fixture",
    userId: role === "service" ? null : "user-fixture",
    clientId: "client-fixture",
    organizationId: "org-fixture",
    organizationSlug: "fixture",
    role,
    scopes: new Set(scopes),
    audience: "https://worker.example.com/mcp",
  };
}

describe("MCP tool policy", () => {
  it("annotates reads and dispatch with their exact scope and role policy", () => {
    expect(policyFor("runs.get")).toMatchObject({
      scope: "mcp:read",
      roles: ["member", "admin", "owner", "service"],
      mutation: "read",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    });
    expect(policyFor("workflows.dispatch")).toMatchObject({
      scope: "runs:dispatch",
      roles: ["admin", "owner", "service"],
      mutation: "direct",
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
      },
    });
    expect(policyFor("workflows.dispatch_preflight")).toMatchObject({
      scope: "runs:dispatch",
      roles: ["admin", "owner", "service"],
      mutation: "read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });

  it("allows every actor role to read only with mcp:read", () => {
    for (const role of ["member", "admin", "owner", "service"] as const) {
      expect(() => authorizeTool(actor(role, ["mcp:read"]), "runs.get")).not.toThrow();
      expect(() => authorizeTool(actor(role, []), "runs.get")).toThrowError(
        expect.objectContaining({ code: "INSUFFICIENT_SCOPE" }),
      );
    }
  });

  it("allows dispatch only for admin, owner, and service actors with runs:dispatch", () => {
    for (const role of ["admin", "owner", "service"] as const) {
      expect(() =>
        authorizeTool(actor(role, ["runs:dispatch"]), "workflows.dispatch"),
      ).not.toThrow();
    }
    expect(() =>
      authorizeTool(actor("member", ["runs:dispatch"]), "workflows.dispatch"),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => authorizeTool(actor("service", []), "workflows.dispatch")).toThrowError(
      expect.objectContaining({ code: "INSUFFICIENT_SCOPE" }),
    );
  });

  it("uses dispatch authorization for the read-only dispatch preflight", () => {
    expect(() =>
      authorizeTool(actor("member", ["mcp:read"]), "workflows.dispatch_preflight"),
    ).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_SCOPE" }));
    for (const role of ["admin", "owner", "service"] as const) {
      expect(() =>
        authorizeTool(
          actor(role, ["runs:dispatch"]),
          "workflows.dispatch_preflight",
        ),
      ).not.toThrow();
    }
  });
});
