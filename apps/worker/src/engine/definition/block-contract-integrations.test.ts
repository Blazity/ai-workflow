import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState, WorkflowBlockType } from "@shared/contracts";
import {
  buildWorkflowBlockRegistry,
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "./block-contract-resolver.js";
import { deploymentIntegrations, NO_INTEGRATIONS } from "./integration-availability.js";

/**
 * The palette and the contract chain, over a deployment declared as data.
 *
 * What an author sees in the editor and what a publish refuses both come from
 * here, so these are the tests that say a block appears exactly while its
 * integration is usable.
 */

const announce = {
  type: "acmenotify_announce",
  paramsSchema: { parse: (value: unknown) => value } as never,
  contract: { ports: ["out"] as [string, ...string[]], allowsFailurePort: false },
  ui: {
    label: "Announce",
    description: "Announces a milestone through Acme Notify.",
    glyph: "A",
    color: "#445566",
    softColor: "#EEF1F4",
  },
  defaults: { channel: "general" },
  inputs: { message: { required: true, schema: { type: "string" } } },
  output: {
    properties: { permalink: { type: "string" } },
    required: ["permalink"],
    statusVariants: ["sent", "skipped"] as [string, ...string[]],
  },
} satisfies IntegrationManifest["blocks"][number];

const notify: IntegrationManifest = {
  id: "acmenotify",
  name: "Acme Notify",
  description: "A provider core has never heard of.",
  connection: { fields: [] },
  capabilities: [],
  blocks: [announce],
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

function context(overrides: Partial<WorkflowBlockRegistryContext> = {}): WorkflowBlockRegistryContext {
  return {
    agentProviders: { claude: true, codex: true },
    llmProviders: { claude: true, codex: true },
    defaultAgent: { provider: "claude", model: "claude-sonnet-4-5" },
    vcsProviders: ["github"],
    vcsBotIdentities: ["github"],
    slackConfigured: true,
    arthurConfigured: true,
    webhookTriggerConfigured: true,
    integrations: NO_INTEGRATIONS,
    ...overrides,
  };
}

const connected = context({
  integrations: deploymentIntegrations({
    manifests: [notify],
    states: new Map([["acmenotify", state()]]),
  }),
});

const type = "acmenotify_announce" as WorkflowBlockType;

describe("an integration's block in the editor", () => {
  it("is in the palette, with the block's own presentation and ports", () => {
    const registry = buildWorkflowBlockRegistry(connected);
    const contract = registry[type];

    expect(contract).toBeDefined();
    expect(contract.presentation.label).toBe("Announce");
    expect(contract.ports).toEqual(["out"]);
    expect(contract.defaults).toEqual({ channel: "general" });
    expect(contract.output.statusVariants).toEqual(["sent", "skipped"]);
    expect(contract.availability).toEqual({ available: true, unavailableReason: null });
  });

  it("promises downstream bindings exactly the fields the block declared required", () => {
    const contract = resolveWorkflowBlockContract(type, {}, connected);
    const binding = contract.output.bindingSchema;

    expect(binding.type).toBe("object");
    if (binding.type !== "object") throw new Error("unreachable");
    expect(Object.keys(binding.properties).sort()).toEqual(["permalink", "status"]);
    expect(binding.required.sort()).toEqual(["permalink", "status"]);
  });

  it("stays in the palette but says why when the integration is disabled", () => {
    const disabled = context({
      integrations: deploymentIntegrations({
        manifests: [notify],
        states: new Map([
          ["acmenotify", state({ enabled: false, status: "disabled", usable: false })],
        ]),
      }),
    });

    const contract = buildWorkflowBlockRegistry(disabled)[type];
    expect(contract.availability.available).toBe(false);
    expect(contract.availability.unavailableReason).toContain("Acme Notify is disabled");
  });

  it("is absent from the palette of a build that ships no such integration", () => {
    expect(buildWorkflowBlockRegistry(context())[type]).toBeUndefined();
  });

  it("still answers for a node published before the build stopped shipping it", () => {
    const contract = resolveWorkflowBlockContract(type, {}, context());
    expect(contract.availability.available).toBe(false);
    expect(contract.availability.unavailableReason).toContain("acmenotify_announce");
  });

  it("marks a block nothing in this build provides, and marks nothing else", () => {
    // `unprovided` decides whether a definition carrying the node may be
    // written at all, so a core block or a shipped integration block that
    // carried it would become unpublishable for everyone.
    const registry = buildWorkflowBlockRegistry(connected);
    expect(Object.values(registry).filter((contract) => contract.unprovided)).toEqual([]);
    expect(resolveWorkflowBlockContract(type, {}, context()).unprovided).toBe(true);
  });

  it("leaves every core block's availability alone", () => {
    const withIntegration = buildWorkflowBlockRegistry(connected);
    const without = buildWorkflowBlockRegistry(context());

    for (const coreType of Object.keys(without) as WorkflowBlockType[]) {
      expect(withIntegration[coreType].availability).toEqual(without[coreType].availability);
    }
  });
});
