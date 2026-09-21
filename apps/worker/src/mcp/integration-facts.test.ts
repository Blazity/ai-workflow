import { describe, expect, it, vi } from "vitest";

vi.mock("../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

import { z } from "zod";
import type { IntegrationManifest } from "@integrations/sdk";
import type {
  IntegrationState,
  IntegrationStatus,
  WorkflowBlockType,
} from "@shared/contracts";

import { deploymentIntegrations } from "../engine/definition/integration-availability.js";
import { runIntegrationBlocker } from "../engine/definition/integration-run.js";
import { blockContractsFor } from "../services/workflow-definitions/block-contracts.js";
import { agentFacingIntegrations, integrationFactsOf } from "./integration-facts.js";

/**
 * A deployment declared rather than arranged: the resolver S4 built is pure, so
 * a test says what this deployment's integrations are instead of standing up a
 * database, an environment and a generated registry.
 */
const DEMO: IntegrationManifest = {
  id: "demo",
  name: "Demo",
  description: "A deterministic provider used only for tests.",
  docsUrl: "https://example.com/demo/docs",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", env: "DEMO_BASE_URL", secret: false, format: "url" },
      { key: "apiToken", label: "API token", env: "DEMO_API_TOKEN", secret: true },
    ],
  },
  // Declared, and no block here requires it, so it shows up in the facts
  // without deciding any block's availability.
  capabilities: ["issue_tracker"],
  blocks: [
    {
      type: "demo_echo",
      paramsSchema: z.object({ message: z.string().min(1) }).strict(),
      contract: { ports: ["out"], allowsFailurePort: true },
      ui: {
        label: "Demo echo",
        description: "Echoes the message back.",
        glyph: "D",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      output: {
        properties: { reply: { type: "string" } },
        required: ["reply"],
        statusVariants: ["ok"],
      },
    },
    {
      type: "demo_lookup",
      paramsSchema: z.object({ query: z.string().min(1) }).strict(),
      contract: { ports: ["out"], allowsFailurePort: true },
      ui: {
        label: "Demo lookup",
        description: "Looks a query up.",
        glyph: "L",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      output: {
        properties: { summary: { type: "string" } },
        required: ["summary"],
        statusVariants: ["found"],
      },
      requires: { capabilities: ["messaging"] },
    },
  ],
  pages: [],
  health: [],
};

/** The state S2's resolver would have decided, written out by the test. */
function stateOf(overrides: Partial<IntegrationState> & { status: IntegrationStatus }): IntegrationState {
  return {
    integrationId: "demo",
    enabled: true,
    source: "environment",
    connection: overrides.status === "disabled" ? "connected" : overrides.status,
    verification: { state: "never_tested" },
    failure: null,
    usable: overrides.status === "connected",
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: {
      latestVersion: 0,
      activeVersion: null,
      missingFields: [],
      complete: false,
      prepared: null,
    },
    pin: { integrationId: "demo", configFingerprint: "abc123abc123" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

function deploymentWith(
  state: IntegrationState,
  builtinCapabilities: readonly string[] = ["messaging"],
) {
  return deploymentIntegrations({
    manifests: [DEMO],
    states: new Map([["demo", state]]),
    builtinCapabilities,
  });
}

function factsFor(
  state: IntegrationState,
  builtinCapabilities: readonly string[] = ["messaging"],
) {
  const integrations = deploymentWith(state, builtinCapabilities);
  const registry = blockContractsFor(undefined, agentFacingIntegrations(integrations)).blockRegistry();
  return integrationFactsOf(integrations, registry);
}

describe("what system.capabilities tells an agent about integrations", () => {
  it("names a connected integration and every block it unlocks", () => {
    const facts = factsFor(stateOf({ status: "connected", usable: true }));

    expect(facts).toEqual([
      {
        id: "demo",
        name: "Demo",
        status: "connected",
        usable: true,
        capabilities: ["issue_tracker"],
        blocks: [
          { type: "demo_echo", available: true, unavailableReason: null },
          { type: "demo_lookup", available: true, unavailableReason: null },
        ],
      },
    ]);
  });

  it("tells an agent what a human must do, and never which variable to paste", () => {
    const facts = factsFor(
      stateOf({
        status: "failing",
        connection: "failing",
        usable: false,
        environment: {
          setVariables: ["DEMO_BASE_URL"],
          missingVariables: ["DEMO_API_TOKEN"],
          complete: false,
        },
        failure: {
          reason: "environment_incomplete",
          message: "Set DEMO_API_TOKEN on this deployment, or store the values from the dashboard",
          missingVariables: ["DEMO_API_TOKEN"],
        },
      }),
    );

    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("DEMO_API_TOKEN");
    expect(serialized).not.toContain("DEMO_BASE_URL");
    const expected =
      "Demo is failing: its connection is not working; an admin can fix it on the Integrations page in the dashboard.";
    expect(facts[0]).toMatchObject({ id: "demo", status: "failing", usable: false });
    expect(facts[0]?.blocks).toEqual([
      { type: "demo_echo", available: false, unavailableReason: expected },
      { type: "demo_lookup", available: false, unavailableReason: expected },
    ]);
  });

  it("keeps a capability refusal, which names no configuration", () => {
    const facts = factsFor(stateOf({ status: "connected", usable: true }), []);

    expect(facts[0]?.blocks).toEqual([
      { type: "demo_echo", available: true, unavailableReason: null },
      {
        type: "demo_lookup",
        available: false,
        unavailableReason:
          "Nothing on this deployment provides the messaging capability, which this block needs. " +
        "Connect an integration that provides it on the Integrations page.",
      },
    ]);
  });

  it("answers an empty list for a build that ships no integration", () => {
    const integrations = deploymentIntegrations({ manifests: [], states: new Map() });
    const registry = blockContractsFor(undefined, integrations).blockRegistry();

    expect(integrationFactsOf(integrations, registry)).toEqual([]);
  });

  it("names no provider core happens to be configured with", () => {
    const facts = factsFor(stateOf({ status: "not_connected", usable: false }), [
      "issue_tracker",
      "vcs",
      "messaging",
    ]);

    const serialized = JSON.stringify(facts);
    for (const provider of ["github", "gitlab", "slack", "jira", "arthur"]) {
      expect(serialized.toLowerCase()).not.toContain(provider);
    }
  });
});

describe("the agent-facing view of the same deployment", () => {
  it("keeps the availability verdict and drops the admin's own words", () => {
    const state = stateOf({
      status: "failing",
      connection: "failing",
      usable: false,
      failure: {
        reason: "environment_incomplete",
        message: "Set DEMO_API_TOKEN on this deployment, or store the values from the dashboard",
        missingVariables: ["DEMO_API_TOKEN"],
      },
    });
    const integrations = deploymentWith(state);

    const agentFacing = agentFacingIntegrations(integrations);

    expect(agentFacing.byId.get("demo")?.usable).toBe(false);
    expect(agentFacing.byId.get("demo")?.status).toBe("failing");
    expect(JSON.stringify([...agentFacing.byId.values()])).not.toContain("DEMO_API_TOKEN");
  });

  it("decides nothing: the verdict is the one the editor's own registry reached", () => {
    // The anti-drift claim, made against the raw deployment rather than against
    // another MCP surface. If rendering the sentences ever moved a verdict, the
    // palette an agent reads and the palette a person reads would disagree
    // about the same deployment, which is the failure the plan names.
    for (const status of ["connected", "failing", "disabled", "not_connected"] as const) {
      const raw = deploymentWith(stateOf({ status, usable: status === "connected" }));
      const rawRegistry = blockContractsFor(undefined, raw).blockRegistry();
      const agentRegistry = blockContractsFor(
        undefined,
        agentFacingIntegrations(raw),
      ).blockRegistry();

      for (const type of raw.blocks.keys()) {
        const blockType = type as WorkflowBlockType;
        expect(agentRegistry[blockType]?.availability.available).toBe(
          rawRegistry[blockType]?.availability.available,
        );
      }
      const verdicts = (registry: typeof rawRegistry) =>
        integrationFactsOf(raw, registry).flatMap((fact) =>
          fact.blocks.map((block) => [block.type, block.available] as const),
        );
      expect(verdicts(agentRegistry)).toEqual(verdicts(rawRegistry));
    }
  });

  it("hands the dispatch preflight a blocker sentence a model may read", () => {
    // The preflight composes its own sentence from the presence rather than
    // from a block contract, and a dispatch refusal leaves as an error message
    // the envelope sanitizer never sees. So what MCP hands it has to be safe
    // before it gets there.
    const state = stateOf({
      status: "failing",
      connection: "failing",
      usable: false,
      failure: {
        reason: "environment_incomplete",
        message: "Set DEMO_API_TOKEN on this deployment, or store the values from the dashboard",
        missingVariables: ["DEMO_API_TOKEN"],
      },
    });
    const agentFacing = agentFacingIntegrations(deploymentWith(state));

    const blocker = runIntegrationBlocker([{ type: "demo_echo" }], agentFacing);

    expect(blocker?.reason).toBe("disconnected");
    expect(blocker?.message).not.toContain("DEMO_API_TOKEN");
    expect(blocker?.message).toContain("Demo");
    expect(blocker?.message).toContain("Integrations page");
  });

  it("leaves a deployment with no integration untouched", () => {
    const integrations = deploymentIntegrations({ manifests: [], states: new Map() });

    expect(agentFacingIntegrations(integrations)).toBe(integrations);
  });
});
