import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState, WorkflowDefinition } from "@shared/contracts";
import { analyzeWorkflowValues, parse } from "@shared/workflow-graph";
import { validateWorkflowDefinitionCandidate } from "./validation.js";
import { z } from "zod";
import { createWorkflowBlockContractResolver } from "./block-contract-resolver.js";
import { blockParamsSchemasFor } from "./block-params-schemas.js";
import { validateWorkflowDefinitionIssuesForDeployment } from "./deployment-validation.js";
import { deploymentIntegrations, NO_INTEGRATIONS } from "./integration-availability.js";
import { JSON_SCHEMA_SUPPORT } from "./json-schema-support.js";

/**
 * Publishing a workflow that uses an integration.
 *
 * The journey: an author drafts a workflow with an integration's block, an
 * admin disconnects or disables that integration, and the author presses
 * Publish. The refusal has to name the integration, not the block type, and it
 * has to arrive at publish rather than in the middle of a run.
 */

const notify: IntegrationManifest = {
  id: "acmenotify",
  name: "Acme Notify",
  description: "A provider core has never heard of.",
  connection: { fields: [] },
  capabilities: [],
  blocks: [
    {
      type: "acmenotify_announce",
      paramsSchema: z.object({ channel: z.string().min(1) }).strict(),
      contract: { ports: ["out"], allowsFailurePort: false },
      ui: {
        label: "Announce",
        description: "Announces a milestone.",
        glyph: "A",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      defaults: { channel: "general" },
      output: { properties: {}, statusVariants: ["sent"] },
    },
  ],
  pages: [],
  health: [{ id: "reachable", label: "Reachable", description: "", critical: true }],
};

function state(overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: "acmenotify",
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: {
      latestVersion: 0,
      activeVersion: null,
      missingFields: [],
      complete: false,
      prepared: null,
    },
    pin: { integrationId: "acmenotify", configFingerprint: "aaaaaaaaaaaa" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

const storedDefinition = {
  schemaVersion: 2,
  nodes: [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      name: "Ticket enters the AI column",
      x: 40,
      y: 280,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "announce",
      type: "acmenotify_announce",
      name: "Announce",
      x: 300,
      y: 280,
      configuration: { channel: "releases" },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [{ id: "trigger-out-announce", from: "trigger", to: "announce" }],
};

function deploymentIssues(
  integrations: ReturnType<typeof deploymentIntegrations>,
): string[] {
  const parsed = parse(storedDefinition);
  if (!parsed.definition) throw new Error("the stored definition did not parse");
  const definition: WorkflowDefinition = parsed.definition;
  const resolveContract = createWorkflowBlockContractResolver({
    agentProviders: { claude: true, codex: true },
    llmProviders: { claude: true, codex: true },
    defaultAgent: { provider: "claude", model: "claude-sonnet-4-5" },
    vcsProviders: ["github"],
    vcsBotIdentities: ["github"],
    slackConfigured: true,
    webhookTriggerConfigured: true,
    integrations,
  });
  return validateWorkflowDefinitionIssuesForDeployment(
    definition,
    resolveContract,
    blockParamsSchemasFor(integrations),
    ["github"],
    analyzeWorkflowValues(definition, resolveContract, JSON_SCHEMA_SUPPORT),
  ).map((issue) => issue.message);
}

const connected = deploymentIntegrations({
  manifests: [notify],
  states: new Map([["acmenotify", state()]]),
});

describe("publishing a workflow that uses an integration", () => {
  it("stores and parses a node whose block an integration contributes", () => {
    const parsed = parse(storedDefinition);
    expect(parsed.definition?.nodes.map((node) => node.type)).toEqual([
      "trigger_ticket_ai",
      "acmenotify_announce",
    ]);
  });

  it("publishes while the integration is connected and enabled", () => {
    expect(deploymentIssues(connected)).toEqual([]);
  });

  it("refuses the publish naming the integration once an admin disabled it", () => {
    const issues = deploymentIssues(
      deploymentIntegrations({
        manifests: [notify],
        states: new Map([
          ["acmenotify", state({ enabled: false, status: "disabled", usable: false })],
        ]),
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Acme Notify is disabled");
    expect(issues[0]).toContain("announce");
  });

  it("refuses the publish naming the integration once it is disconnected", () => {
    const issues = deploymentIssues(
      deploymentIntegrations({
        manifests: [notify],
        states: new Map([
          [
            "acmenotify",
            state({ status: "not_connected", connection: "not_connected", usable: false }),
          ],
        ]),
      }),
    );

    expect(issues[0]).toContain("Acme Notify is not connected");
  });

  it("refuses the publish when the build no longer ships the integration at all", () => {
    const issues = deploymentIssues(NO_INTEGRATIONS);
    expect(issues[0]).toContain("acmenotify_announce");
  });
});

describe("a block type nobody can run", () => {
  function adviceFor(type: string): string {
    const definition = parse({
      ...storedDefinition,
      nodes: [storedDefinition.nodes[0], { ...storedDefinition.nodes[1], type }],
    });
    const resolveContract = createWorkflowBlockContractResolver({
      agentProviders: { claude: true, codex: true },
      llmProviders: { claude: true, codex: true },
      defaultAgent: { provider: "claude", model: "claude-sonnet-4-5" },
      vcsProviders: ["github"],
      vcsBotIdentities: ["github"],
      slackConfigured: true,
      webhookTriggerConfigured: true,
      integrations: NO_INTEGRATIONS,
    });
    const result = validateWorkflowDefinitionCandidate(
      definition.definition ?? {},
      resolveContract,
      blockParamsSchemasFor(NO_INTEGRATIONS),
      ["github"],
      (candidate) => analyzeWorkflowValues(candidate, resolveContract, JSON_SCHEMA_SUPPORT),
    );
    return result.response.issues.map((issue) => issue.message).join(" | ");
  }

  it("answers a misspelled core type with the nearest one, not with an integration to connect", () => {
    // `planning_agnet` matches the shape of an integration block exactly, so
    // without this the author of a typo is told to connect an integration
    // called "planning", which has never existed.
    const advice = adviceFor("planning_agnet");
    expect(advice).toContain("planning_agent");
    expect(advice).not.toContain("Connect the integration");
  });

  it("says nothing exists when the name resembles no core block either", () => {
    expect(adviceFor("zzzqqq_unrelated")).toContain("no integration here provides one");
  });
});
