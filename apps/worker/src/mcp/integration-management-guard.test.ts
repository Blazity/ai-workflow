import { describe, expect, it } from "vitest";

import { integrationManifests } from "@integrations/registry";

import {
  FIRST_SLICE_TOOLS,
  MCP_SCOPES,
  McpPublicError,
  type McpActorContext,
} from "./contracts.js";
import { authorizeTool, policyFor } from "./policy.js";

/** A member's token: read-only, and the role a dashboard viewer has. Built here
 *  rather than from test-support, which reaches the settings snapshot and with
 *  it a configured deployment this file deliberately does not need. */
function memberActor(): McpActorContext {
  return {
    kind: "user",
    subject: "user:member",
    userId: "user-member",
    clientId: "client-member",
    organizationId: "org-execute",
    organizationSlug: "execute",
    role: "member",
    scopes: new Set(["mcp:read"]),
    audience: "https://worker.example.com/mcp",
  };
}

/**
 * The guard behind ADR-010 decision 15 (Jakub, 2026-09-18): MCP covers what a
 * workflow can DO, and nothing else. Connecting an integration, entering or
 * reading a credential, testing, enabling, disabling, switching the source and
 * choosing a provider are dashboard actions, because a token that travelled
 * through one of these tools would land in a model's context and in a model
 * provider's logs.
 *
 * Two rules, because neither catches the other's case:
 *
 *  - the reviewed list below catches a management tool under ANY name, since
 *    one cannot be added without this file being edited, and the failure names
 *    the tool rather than counting the surface;
 *  - the shape rules catch the likely spellings even in the same edit that
 *    updated the list, which is how a tool gets added by accident rather than
 *    by decision.
 *
 * A new tool that is NOT integration management: add its name below, having
 * read this comment.
 */
const REVIEWED_TOOLS: readonly string[] = [
  "system.capabilities",
  "tickets.get",
  "tickets.list_runs",
  "runs.get",
  "runs.trace",
  "runs.result",
  "runs.diagnose",
  "workflows.dispatch_preflight",
  "workflows.dispatch",
  "workflows.list",
  "prompts.list",
  "prompts.get",
  "prompts.update",
  "workflows.create",
  "workflows.save_draft",
  "workflows.publish",
  "runs.get_clarification",
  "runs.answer_clarification",
  "runs.cancel",
  "tickets.comment",
  "tickets.transition",
  "tickets.create",
  "blocks.list",
  "blocks.get",
  "runs.stats",
  "workflows.get_graph",
  "workflows.set_enabled",
  "runs.logs",
  "repositories.list",
  "repositories.get",
  "repositories.list_versions",
  "repositories.upsert",
  "repositories.set_enabled",
  "repositories.activate_preview",
  "repositories.activate",
  "repositories.import_preview",
  "repositories.import",
  "repositories.suggest",
  "settings.list",
  "settings.get",
  "settings.set",
  "settings.reset",
  "work_scope.get",
  "work_scope.edit",
  // Reads and erasure of what the agent remembered. None of the three connects,
  // tests, enables, disables, switches a source or chooses a provider: they
  // address a stored document by subject and path and never name a provider.
  "memory.list",
  "memory.get",
  "memory.forget",
  // Reads of what a run's agents were sent. Neither touches a connection: they
  // return recorded prompt text addressed by run or by definition node, and a
  // briefing names an integration only where the prompt it recorded did.
  "runs.briefing",
  "workflows.node_briefing",
  // Harness profiles: which skills a profile pins and which workflows pin it,
  // pointing a pinned skill at the bytes its source holds now, and publishing
  // the draft. A skill is
  // content the deployment carries, not a connection, and none of the three
  // names a provider or touches a credential.
  "profiles.list",
  "profiles.get",
  "profiles.refresh_skill",
  "profiles.publish",
];

/**
 * What a tool would be called if somebody put integration management here.
 * Matched on the tool's own name parts, so `integrations.connect`,
 * `connections.set`, `demo.test_connection` and `credentials.rotate` all trip
 * it whatever domain they were filed under.
 */
const MANAGEMENT_WORDS = [
  "integration",
  "connection",
  "connect",
  "disconnect",
  "credential",
  "secret",
  "token",
];

describe("MCP holds no integration management tool", () => {
  it("publishes only the tools this file has reviewed", () => {
    const unreviewed = FIRST_SLICE_TOOLS.filter((tool) => !REVIEWED_TOOLS.includes(tool));

    expect(
      unreviewed,
      "A tool was added to the MCP surface. ADR-010 decision 15 forbids integration management over MCP: connecting, testing, enabling, disabling, switching source and choosing a provider are dashboard actions. If this tool is none of those, add its name to REVIEWED_TOOLS.",
    ).toEqual([]);
  });

  it("still publishes every tool it reviewed, so the list cannot rot", () => {
    const removed = REVIEWED_TOOLS.filter(
      (tool) => !(FIRST_SLICE_TOOLS as readonly string[]).includes(tool),
    );

    expect(removed).toEqual([]);
  });

  it("names no tool after connecting or configuring anything", () => {
    const offenders = FIRST_SLICE_TOOLS.filter((tool) =>
      MANAGEMENT_WORDS.some((word) => tool.toLowerCase().includes(word)),
    );

    expect(offenders).toEqual([]);
  });

  it("names no tool after an integration this build ships", () => {
    const ids = integrationManifests.map((manifest) => manifest.id.toLowerCase());
    const offenders = FIRST_SLICE_TOOLS.filter((tool) =>
      ids.some((id) => tool.toLowerCase().includes(id)),
    );

    expect(offenders).toEqual([]);
  });

  it("grants no scope over integrations", () => {
    const offenders = MCP_SCOPES.filter((scope) =>
      MANAGEMENT_WORDS.some((word) => scope.toLowerCase().includes(word)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the integration facts on a plain read, not behind a write scope", () => {
    // Reusing a write scope for a read is how a read-only client ends up unable
    // to learn what this deployment can do, and how an integration write would
    // later slip in under a scope somebody already holds.
    expect(policyFor("system.capabilities")).toMatchObject({
      scope: "mcp:read",
      mutation: "read",
      annotations: { readOnlyHint: true },
    });
  });
});

describe("a refusal an agent can tell apart", () => {
  it("answers a member's authoring attempt with a scope refusal, not a workflow verdict", () => {
    const member = memberActor();

    let thrown: unknown;
    try {
      authorizeTool(member, "workflows.save_draft");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpPublicError);
    expect((thrown as McpPublicError).code).toBe("INSUFFICIENT_SCOPE");
  });

  it("lets the same member read what this deployment can do", () => {
    const member = memberActor();

    expect(() => authorizeTool(member, "system.capabilities")).not.toThrow();
  });
});
