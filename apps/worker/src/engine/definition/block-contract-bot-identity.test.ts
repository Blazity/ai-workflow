import { describe, expect, it, vi } from "vitest";
import { defineIntegration } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    ANTHROPIC_API_KEY: "test",
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_INSTALLATION_ID: undefined,
    GITHUB_BOT_LOGIN: undefined,
    VCS_BOT_LOGIN: undefined,
  },
}));
vi.mock("../support/adapters.js", () => ({ coreServesIssueTracker: () => false }));

const { deploymentIntegrations } = await import("./integration-availability.js");
const { workflowBlockRegistryContext } = await import("./block-contract-environment.js");
const { buildWorkflowBlockRegistry } = await import("./block-contract-resolver.js");

describe("integration bot identity deployment facts", () => {
  it("refuses commented review triggers for a connected GitLab integration with no bot login", () => {
    const manifest = defineIntegration({
      id: "gitlab",
      name: "GitLab",
      description: "test",
      connection: { fields: [] },
      capabilities: ["vcs"],
      webhook: { reviewStates: ["commented"] },
      blocks: [],
      pages: [],
      health: [],
    });
    const state: IntegrationState = {
      integrationId: "gitlab",
      enabled: true,
      source: "stored",
      status: "connected",
      connection: "connected",
      verification: { state: "never_tested" },
      failure: null,
      usable: true,
      environment: { setVariables: [], missingVariables: [], complete: false },
      stored: {
        latestVersion: 1,
        activeVersion: 1,
        missingFields: [],
        complete: true,
        prepared: null,
      },
      pin: { integrationId: "gitlab", configFingerprint: "connection" },
      configuredFields: ["token", "host"],
      secretsKeyAvailable: true,
    };
    const integrations = deploymentIntegrations({
      manifests: [manifest],
      states: new Map([["gitlab", state]]),
    });

    const context = workflowBlockRegistryContext(undefined, integrations);
    expect(context.vcsProviders).toEqual(["gitlab"]);
    expect(context.vcsBotIdentities).toEqual([]);
    const availability = buildWorkflowBlockRegistry(context).trigger_pr_review.availability;
    expect(availability.available).toBe(false);
    expect(availability.unavailableReason).toContain("require a bot username for gitlab");
  });

  it("accepts a dashboard legacy login only for the sole active VCS integration", () => {
    const manifest = defineIntegration({
      id: "gitlab",
      name: "GitLab",
      description: "test",
      connection: { fields: [] },
      capabilities: ["vcs"],
      blocks: [],
      pages: [],
      health: [],
    });
    const state: IntegrationState = {
      integrationId: "gitlab",
      enabled: true,
      source: "stored",
      status: "connected",
      connection: "connected",
      verification: { state: "never_tested" },
      failure: null,
      usable: true,
      environment: { setVariables: [], missingVariables: [], complete: false },
      stored: {
        latestVersion: 1,
        activeVersion: 1,
        missingFields: [],
        complete: true,
        prepared: null,
      },
      pin: { integrationId: "gitlab", configFingerprint: "connection" },
      configuredFields: ["token", "legacyBotLogin"],
      secretsKeyAvailable: true,
    };
    const integrations = deploymentIntegrations({
      manifests: [manifest],
      states: new Map([["gitlab", state]]),
    });

    expect(workflowBlockRegistryContext(undefined, integrations).vcsBotIdentities)
      .toEqual(["gitlab"]);
  });
});
