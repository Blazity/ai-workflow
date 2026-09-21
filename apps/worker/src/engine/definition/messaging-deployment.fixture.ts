/**
 * A deployment with one usable messaging provider, for the many contract tests
 * that only need `send_message` and `investigate` to be offered.
 *
 * Messaging stopped being core's own credential in S9 of the integrations plan
 * (ADR-010): a block that needs it is offered when a connected integration
 * serves it and refused otherwise, so a test that wants it available has to
 * declare one. The manifest is a fake rather than a real package, because a
 * core test that named a provider would be testing the registry's contents
 * instead of the rule.
 */
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import {
  deploymentIntegrations,
  type DeploymentIntegrations,
} from "./integration-availability.js";

const manifest = {
  id: "testchat",
  name: "Test Chat",
  description: "A messaging provider that exists only in tests.",
  connection: { fields: [] },
  capabilities: ["messaging"],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "It answers.", critical: true }],
} as unknown as IntegrationManifest;

const connected: IntegrationState = {
  integrationId: "testchat",
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
  pin: { integrationId: "testchat", configFingerprint: "testchatfinger" },
  secretsKeyAvailable: true,
};

/**
 * The pieces, for a test that needs messaging available ALONGSIDE an
 * integration of its own. A context that swapped the whole deployment out to
 * add one integration would be comparing two different deployments.
 */
export const MESSAGING_PROVIDER = { manifest, state: connected } as const;

/** Messaging available, nothing else. */
export const MESSAGING_CONNECTED: DeploymentIntegrations = deploymentIntegrations({
  manifests: [manifest],
  states: new Map([["testchat", connected]]),
});

/** The same provider, connected but switched off by an admin. */
export const MESSAGING_DISABLED: DeploymentIntegrations = deploymentIntegrations({
  manifests: [manifest],
  states: new Map([
    ["testchat", { ...connected, enabled: false, status: "disabled", usable: false }],
  ]),
});
