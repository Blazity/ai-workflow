import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import {
  deploymentIntegrations,
  integrationBlockAvailability,
  integrationsUsedBy,
  NO_INTEGRATIONS,
} from "./integration-availability.js";

/**
 * The availability decision, alone.
 *
 * Every case here is a deployment declared as data: manifests, the state S2
 * resolved for each, and which capabilities core still serves itself. No
 * database, no environment, no registry file, which is the point of the seam.
 */

function declaredBlock(block: {
  type: string;
  requires?: { capabilities?: string[] };
}): IntegrationManifest["blocks"][number] {
  return {
    type: block.type,
    paramsSchema: { parse: (value: unknown) => value } as never,
    contract: { ports: ["out"], allowsFailurePort: false },
    ui: {
      label: block.type,
      description: block.type,
      glyph: "F",
      color: "#445566",
      softColor: "#EEF1F4",
    },
    output: { properties: {}, statusVariants: ["ok"] },
    requires: (block.requires ?? {}) as never,
  };
}

function manifest(overrides: {
  id: string;
  name?: string;
  capabilities?: string[];
  blocks?: { type: string; requires?: { capabilities?: string[] } }[];
}): IntegrationManifest {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    description: "A provider core has never heard of.",
    connection: { fields: [] },
    capabilities: (overrides.capabilities ?? []) as IntegrationManifest["capabilities"],
    blocks: (overrides.blocks ?? []).map(declaredBlock),
    pages: [],
    health: [{ id: "reachable", label: "Reachable", description: "", critical: true }],
  };
}

function state(id: string, overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: id,
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    // Every deployment alive on the day this lands is complete and never
    // tested, so the decision may not read this field.
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
    pin: { integrationId: id, configFingerprint: "aaaaaaaaaaaa" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

const notify = manifest({
  id: "acmenotify",
  name: "Acme Notify",
  capabilities: ["messaging"],
  blocks: [{ type: "acmenotify_announce" }],
});

describe("integrationBlockAvailability", () => {
  it("offers the block of a connected, enabled integration", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([["acmenotify", state("acmenotify")]]),
    });

    expect(integrationBlockAvailability("acmenotify_announce", integrations)).toEqual({
      available: true,
      unavailableReason: null,
    });
  });

  it("offers the block of a complete connection nobody ever tested", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([
        ["acmenotify", state("acmenotify", { verification: { state: "never_tested" } })],
      ]),
    });

    expect(integrationBlockAvailability("acmenotify_announce", integrations)?.available).toBe(
      true,
    );
  });

  it("withdraws the block when an admin disabled the integration, and says so", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([
        ["acmenotify", state("acmenotify", { enabled: false, status: "disabled", usable: false })],
      ]),
    });

    const availability = integrationBlockAvailability("acmenotify_announce", integrations);
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("Acme Notify");
    expect(availability?.unavailableReason).toContain("disabled");
  });

  it("withdraws the block when nobody connected the integration", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([
        [
          "acmenotify",
          state("acmenotify", {
            status: "not_connected",
            connection: "not_connected",
            usable: false,
          }),
        ],
      ]),
    });

    const availability = integrationBlockAvailability("acmenotify_announce", integrations);
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("Acme Notify is not connected");
  });

  it("carries the resolver's own sentence when the connection is failing", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([
        [
          "acmenotify",
          state("acmenotify", {
            status: "failing",
            connection: "failing",
            usable: false,
            failure: {
              reason: "environment_incomplete",
              message: "Set ACMENOTIFY_TOKEN on this deployment",
              missingVariables: ["ACMENOTIFY_TOKEN"],
            },
          }),
        ],
      ]),
    });

    expect(
      integrationBlockAvailability("acmenotify_announce", integrations)?.unavailableReason,
    ).toContain("Set ACMENOTIFY_TOKEN on this deployment");
  });

  it("names the integration a build no longer ships rather than answering nothing", () => {
    const availability = integrationBlockAvailability("goneaway_send", NO_INTEGRATIONS, {
      coreOwnsType: false,
    });
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("goneaway_send");
  });

  it("leaves a core block type to core", () => {
    expect(integrationBlockAvailability("post_ticket_comment", NO_INTEGRATIONS)).toBeNull();
  });
});

describe("a block that asks for a capability rather than a provider", () => {
  const research = manifest({
    id: "acmedocs",
    name: "Acme Docs",
    blocks: [
      { type: "acmedocs_research", requires: { capabilities: ["issue_tracker"] } },
    ],
  });

  it("runs on the capability core still serves itself", () => {
    const integrations = deploymentIntegrations({
      manifests: [research],
      states: new Map([["acmedocs", state("acmedocs")]]),
      builtinCapabilities: ["issue_tracker"],
    });

    expect(integrationBlockAvailability("acmedocs_research", integrations)?.available).toBe(true);
  });

  it("refuses when nothing on this deployment provides the capability", () => {
    const integrations = deploymentIntegrations({
      manifests: [research],
      states: new Map([["acmedocs", state("acmedocs")]]),
    });

    const availability = integrationBlockAvailability("acmedocs_research", integrations);
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("issue tracker");
  });

  it("refuses a capability only an integration provides, because execution would use core's", () => {
    // Availability and execution have to agree about WHICH provider serves the
    // block. Execution hands core's own adapters today, so offering the block
    // on the strength of an integration's declaration would promise one
    // provider in the palette and use another in the run.
    const tracker = manifest({
      id: "acmetrack",
      name: "Acme Track",
      capabilities: ["issue_tracker"],
    });
    const integrations = deploymentIntegrations({
      manifests: [research, tracker],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrack", state("acmetrack")],
      ]),
    });

    const availability = integrationBlockAvailability("acmedocs_research", integrations);
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("Acme Track");
    expect(availability?.unavailableReason).toContain("core still owns");
  });

  it("refuses to pick for the admin when an integration joins core on one capability", () => {
    const tracker = manifest({
      id: "acmetrack",
      name: "Acme Track",
      capabilities: ["issue_tracker"],
    });
    const integrations = deploymentIntegrations({
      manifests: [research, tracker],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrack", state("acmetrack")],
      ]),
      builtinCapabilities: ["issue_tracker"],
    });

    const availability = integrationBlockAvailability("acmedocs_research", integrations);
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("Acme Track");
    // No selection control exists before S6, so the sentence must not send an
    // admin looking for one.
    expect(availability?.unavailableReason).toContain("Disable the ones you do not want");
  });

  it("ignores a provider an admin disabled when counting who can serve", () => {
    const tracker = manifest({
      id: "acmetrack",
      name: "Acme Track",
      capabilities: ["issue_tracker"],
    });
    const integrations = deploymentIntegrations({
      manifests: [research, tracker],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrack", state("acmetrack", { enabled: false, status: "disabled", usable: false })],
      ]),
      builtinCapabilities: ["issue_tracker"],
    });

    expect(integrationBlockAvailability("acmedocs_research", integrations)?.available).toBe(true);
  });
});

describe("integrationsUsedBy", () => {
  it("names every integration a definition's nodes reach, once each", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([["acmenotify", state("acmenotify")]]),
    });

    expect(
      integrationsUsedBy(
        [
          { type: "trigger_ticket_ai" },
          { type: "acmenotify_announce" },
          { type: "acmenotify_announce" },
        ],
        integrations,
      ),
    ).toEqual(["acmenotify"]);
  });

  it("names the provider behind a core block that consumes a capability", () => {
    // Send message is core's own block type, so nothing in the block map points
    // at an integration. Without this the run pins nothing for it and a channel
    // changed mid-run moves where the workflow posts with nobody told.
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([["acmenotify", state("acmenotify")]]),
    });

    expect(
      integrationsUsedBy([{ type: "trigger_ticket_ai" }, { type: "send_message" }], integrations),
    ).toEqual(["acmenotify"]);
  });

  it("leaves the chat provider out when the investigation opted out of it", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([["acmenotify", state("acmenotify")]]),
    });

    expect(
      integrationsUsedBy(
        [{ type: "investigate", params: { providers: ["jira"] } }],
        integrations,
      ),
    ).toEqual([]);
    // No selection is the parameter's own default, which is both providers on.
    expect(integrationsUsedBy([{ type: "investigate" }], integrations)).toEqual(["acmenotify"]);
  });
});
