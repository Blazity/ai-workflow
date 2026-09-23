import { describe, expect, it, vi } from "vitest";
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

const { manifest: github } = await import("../../../../../integrations/github/manifest.js");
const { manifest: gitlab } = await import("../../../../../integrations/gitlab/manifest.js");
const { deploymentIntegrations } = await import("./integration-availability.js");
const { workflowBlockRegistryContext } = await import("./block-contract-environment.js");
const { buildWorkflowBlockRegistry, resolveWorkflowBlockContract } = await import(
  "./block-contract-resolver.js"
);

/**
 * Which review a trigger can hear is each provider's own declaration, read from
 * the real manifests: GitLab delivers a merge request note and nothing else, so
 * a trigger waiting only for "changes_requested" there would never fire. The
 * bot login is configured everywhere below, so the "commented needs a known
 * automation account" rule never decides these answers.
 */
function connected(integrationId: string): IntegrationState {
  return {
    integrationId,
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
    pin: { integrationId, configFingerprint: "connection" },
    configuredFields: ["botLogin"],
    secretsKeyAvailable: true,
  };
}

function deployment(...providers: Array<"github" | "gitlab">) {
  const manifests = providers.map((provider) => (provider === "github" ? github : gitlab));
  return workflowBlockRegistryContext(
    undefined,
    deploymentIntegrations({
      manifests,
      states: new Map(providers.map((provider) => [provider, connected(provider)])),
    }),
  );
}

function reviewTrigger(
  context: ReturnType<typeof deployment>,
  params: { providers?: string[]; on: string[] },
) {
  return resolveWorkflowBlockContract(
    "trigger_pr_review",
    { providers: params.providers ?? [], on: params.on, scope: "workflow_owned" },
    context,
  ).availability;
}

describe("a review trigger waiting for a review its providers never report", () => {
  it("is refused on GitLab, with the states GitLab does report", () => {
    const availability = reviewTrigger(deployment("gitlab"), { on: ["changes_requested"] });

    expect(availability.available).toBe(false);
    expect(availability.unavailableReason).toBe(
      'GitLab reports a review only as "commented", so a trigger waiting for "changes_requested" would never start a run.',
    );
  });

  it("is accepted on GitLab once it also waits for a comment", () => {
    expect(
      reviewTrigger(deployment("gitlab"), { on: ["changes_requested", "commented"] }).available,
    ).toBe(true);
  });

  it("is accepted when another of its providers reports that state", () => {
    expect(
      reviewTrigger(deployment("github", "gitlab"), { on: ["changes_requested"] }).available,
    ).toBe(true);
  });

  it("is refused when the one provider it names cannot report that state", () => {
    const availability = reviewTrigger(deployment("github", "gitlab"), {
      providers: ["gitlab"],
      on: ["changes_requested"],
    });

    expect(availability.available).toBe(false);
    expect(availability.unavailableReason).toContain('GitLab reports a review only as "commented"');
  });
});

describe("the review trigger the palette places", () => {
  it("waits for a requested change where a provider reports one", () => {
    const placed = buildWorkflowBlockRegistry(deployment("github")).trigger_pr_review;

    expect(placed.defaults.on).toEqual(["changes_requested"]);
    expect(placed.availability.available).toBe(true);
  });

  it("waits for a comment where the only provider reports nothing else", () => {
    const placed = buildWorkflowBlockRegistry(deployment("gitlab")).trigger_pr_review;

    expect(placed.defaults.on).toEqual(["commented"]);
    expect(placed.availability.available).toBe(true);
  });
});
