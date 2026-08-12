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

  it("gives the prompt write its own scope, its own role list and a destructive hint", () => {
    expect(policyFor("prompts.update")).toMatchObject({
      scope: "prompts:write",
      // No "service", unlike the dispatch policy above: an unattended
      // client_credentials client must not rewrite a production prompt.
      roles: ["admin", "owner"],
      mutation: "direct",
      annotations: {
        readOnlyHint: false,
        // Nothing is deleted, but the head this replaces is what every unpinned
        // reference resolves for every future run, so a client must not probe it
        // as a safe append.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });

  it("gives workflow authoring its own scope and marks only the publish destructive", () => {
    for (const tool of ["workflows.create", "workflows.save_draft"] as const) {
      expect(policyFor(tool)).toMatchObject({
        scope: "workflows:write",
        // No "service" here either: an unattended client must not author what the
        // platform then runs with its own credentials.
        roles: ["admin", "owner"],
        mutation: "direct",
        annotations: {
          readOnlyHint: false,
          // Nothing is replaced while a graph is only authored: a create adds a
          // definition and a save adds an immutable version.
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
    }
    expect(policyFor("workflows.publish")).toMatchObject({
      scope: "workflows:write",
      roles: ["admin", "owner"],
      mutation: "direct",
      annotations: {
        readOnlyHint: false,
        // Publishing replaces the snapshot every future dispatch resolves against,
        // and it arms the schedule and webhook triggers of the new head, which can
        // then start runs with nobody calling anything again.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    });
  });

  it("does not let any other scope carry a workflow write", () => {
    for (const tool of [
      "workflows.create",
      "workflows.save_draft",
      "workflows.publish",
    ] as const) {
      for (const scopes of [
        ["mcp:read"],
        ["runs:dispatch"],
        // The nearest miss: consent to fire a reviewed workflow and even to edit a
        // prompt is not consent to write the workflow itself.
        ["mcp:read", "runs:dispatch", "prompts:write"],
      ] as const) {
        expect(() => authorizeTool(actor("admin", scopes), tool)).toThrowError(
          expect.objectContaining({ code: "INSUFFICIENT_SCOPE" }),
        );
      }
      for (const role of ["admin", "owner"] as const) {
        expect(() =>
          authorizeTool(actor(role, ["workflows:write"]), tool),
        ).not.toThrow();
      }
      for (const role of ["member", "service"] as const) {
        expect(() =>
          authorizeTool(actor(role, ["workflows:write"]), tool),
        ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
      }
    }
  });

  it("does not let the read or the dispatch scope carry a prompt write", () => {
    for (const scopes of [
      ["mcp:read"],
      ["runs:dispatch"],
      ["mcp:read", "runs:dispatch"],
    ] as const) {
      expect(() => authorizeTool(actor("admin", scopes), "prompts.update")).toThrowError(
        expect.objectContaining({ code: "INSUFFICIENT_SCOPE" }),
      );
    }
    for (const role of ["admin", "owner"] as const) {
      expect(() =>
        authorizeTool(actor(role, ["prompts:write"]), "prompts.update"),
      ).not.toThrow();
    }
    for (const role of ["member", "service"] as const) {
      expect(() =>
        authorizeTool(actor(role, ["prompts:write"]), "prompts.update"),
      ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    }
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
