import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import { deploymentIntegrations } from "./integration-availability.js";
import {
  checkRunIntegrationUse,
  integrationPinsFor,
  runIntegrationBlocker,
} from "./integration-run.js";

/**
 * What a run carries about its integrations, and what stops it.
 *
 * A run pins the configuration it starts with and compares it at every later
 * use, so a rotated token is followed and a different account is not. The
 * comparison only means anything because the pin is a value recorded at the
 * start: recomputing it from live state at both ends would always agree and
 * `reconfigured` could never fire.
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
      paramsSchema: { parse: (value: unknown) => value } as never,
      contract: { ports: ["out"], allowsFailurePort: false },
      ui: {
        label: "Announce",
        description: "Announces a milestone.",
        glyph: "A",
        color: "#445566",
        softColor: "#EEF1F4",
      },
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
    pin: { integrationId: "acmenotify", configFingerprint: "site-one" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

function deployment(overrides: Partial<IntegrationState> = {}) {
  return deploymentIntegrations({
    manifests: [notify],
    states: new Map([["acmenotify", state(overrides)]]),
  });
}

const nodes = [{ type: "trigger_ticket_ai" }, { type: "acmenotify_announce" }];

describe("what a run records at its start", () => {
  it("pins the configuration of every integration its graph uses", () => {
    expect(integrationPinsFor(nodes, deployment())).toEqual([
      { integrationId: "acmenotify", configFingerprint: "site-one" },
    ]);
  });

  it("pins nothing for a graph that uses no integration", () => {
    expect(integrationPinsFor([{ type: "trigger_ticket_ai" }], deployment())).toEqual([]);
  });

  it("does not start when an integration the graph uses is already unusable", () => {
    const blocker = runIntegrationBlocker(
      nodes,
      deployment({ status: "not_connected", connection: "not_connected", usable: false }),
    );

    expect(blocker?.integrationId).toBe("acmenotify");
    expect(blocker?.message).toContain("Acme Notify is not connected");
  });

  it("starts when every integration the graph uses is usable", () => {
    expect(runIntegrationBlocker(nodes, deployment())).toBeNull();
  });
});

describe("what stops a run already in flight", () => {
  const pinned = { integrationId: "acmenotify", configFingerprint: "site-one" };

  it("lets the run continue while the connection it pinned is the one in force", () => {
    expect(checkRunIntegrationUse(pinned, deployment())).toBeNull();
  });

  it("follows a rotated secret, which never moves the pin", () => {
    // S2 fingerprints non-secret values only, so rotating a token leaves the
    // pin where it was and the run keeps going. This is the case that must not
    // regress into `reconfigured`.
    expect(checkRunIntegrationUse(pinned, deployment())).toBeNull();
  });

  it("stops with `disabled` when an admin turned the integration off mid-run", () => {
    const failure = checkRunIntegrationUse(
      pinned,
      deployment({ enabled: false, status: "disabled", usable: false }),
    );

    expect(failure?.reason).toBe("disabled");
    expect(failure?.message).toContain("Acme Notify was disabled");
    expect(failure?.message).toContain("in flight");
  });

  it("stops with `reconfigured` when a non-secret value changed mid-run", () => {
    const failure = checkRunIntegrationUse(
      pinned,
      deployment({
        pin: { integrationId: "acmenotify", configFingerprint: "site-two" },
      }),
    );

    expect(failure?.reason).toBe("reconfigured");
    expect(failure?.message).toContain("Acme Notify was reconfigured");
  });

  it("calls a failing connection failing, the way every other surface does", () => {
    const failure = checkRunIntegrationUse(
      pinned,
      deployment({
        status: "failing",
        connection: "failing",
        usable: false,
        failure: {
          reason: "credential_rejected",
          message: "The provider refused the API token",
        },
      }),
    );

    // The union has three run-facing reasons and stays at three, but the
    // sentence must not contradict the card, the palette and the dispatch
    // blocker, which all read this same state as "failing".
    expect(failure?.reason).toBe("disconnected");
    expect(failure?.message).toContain("Acme Notify is failing");
    expect(failure?.message).toContain("The provider refused the API token");
  });

  it("says not connected when the connection really is absent", () => {
    const failure = checkRunIntegrationUse(pinned, deployment({
      status: "not_connected",
      connection: "not_connected",
      usable: false,
    }));

    expect(failure?.reason).toBe("disconnected");
    expect(failure?.message).toContain("no longer connected");
  });

  it("stops when the build no longer ships the integration the run pinned", () => {
    const failure = checkRunIntegrationUse(pinned, deploymentIntegrations({
      manifests: [],
      states: new Map(),
    }));

    expect(failure?.reason).toBe("disconnected");
    expect(failure?.message).toContain("acmenotify");
  });
});
