import { defineIntegration } from "@integrations/sdk";
import type { IntegrationState, WorkflowDefinition } from "@shared/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  deploymentIntegrations,
} from "../../engine/definition/integration-availability.js";
import { encryptIntegrationSecret, integrationSecretsKeyId } from "../../infra/secrets-crypto.js";
import { previewedChange, summarizeIntegrationImpact, runsThatWouldStop } from "./impact.js";
import {
  environmentReaderFrom,
  integrationSecretDigest,
  resolveIntegrationState,
  type StoredIntegrationConnection,
} from "./resolve.js";

const chat = defineIntegration({
  id: "acmechat",
  name: "Acme Chat",
  description: "Posts messages.",
  connection: { fields: [] },
  capabilities: ["messaging"],
  blocks: [],
  pages: [],
  health: [{ id: "reachable", label: "Reachable", description: "", critical: true }],
});

function state(): IntegrationState {
  return {
    integrationId: "acmechat",
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
    pin: { integrationId: "acmechat", configFingerprint: "site-one" },
    secretsKeyAvailable: true,
  };
}

function definition(type: string): WorkflowDefinition {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "message",
        type: type as WorkflowDefinition["nodes"][number]["type"],
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

describe("integration impact", () => {
  it("lists a real enabled definition by name and counts its runs", async () => {
    const countInFlightRuns = vi.fn().mockResolvedValue(11);
    const impact = await summarizeIntegrationImpact({
      integrationId: "acmechat",
      changesFingerprint: true,
      stopsRuns: true,
      definitions: [
        { id: 7, name: "Deploy announcements", definition: definition("acmechat_announce") },
      ],
      integrations: deploymentIntegrations({
        manifests: [
          defineIntegration({
            ...chat,
            blocks: [
              {
                type: "acmechat_announce",
                paramsSchema: { parse: (value: unknown) => value } as never,
                contract: { ports: ["out"], allowsFailurePort: false },
                ui: {
                  label: "Announce",
                  description: "Posts an announcement.",
                  glyph: "A",
                  color: "#445566",
                  softColor: "#EEF1F4",
                },
                output: { properties: {}, statusVariants: ["sent"] },
              },
            ],
          }),
        ],
        states: new Map([["acmechat", state()]]),
      }),
      countInFlightRuns,
    });

    expect(impact.enabledDefinitions).toEqual([
      { id: 7, name: "Deploy announcements" },
    ]);
    expect(impact.inFlightRuns).toBe(11);
    expect(countInFlightRuns).toHaveBeenCalledWith([7]);
  });

  it("lists a definition that reaches the integration only through the core send message block", async () => {
    const impact = await summarizeIntegrationImpact({
      integrationId: "acmechat",
      changesFingerprint: true,
      stopsRuns: true,
      definitions: [
        { id: 9, name: "Tell release channel", definition: definition("send_message") },
      ],
      integrations: deploymentIntegrations({
        manifests: [chat],
        states: new Map([["acmechat", state()]]),
      }),
      countInFlightRuns: vi.fn().mockResolvedValue(2),
    });

    expect(impact.enabledDefinitions).toEqual([
      { id: 9, name: "Tell release channel" },
    ]);
    expect(impact.inFlightRuns).toBe(2);
  });
});

describe("what the kill switch costs", () => {
  it("counts every run in flight on the definitions that reach it, though no pin moves", async () => {
    // Disabling is read live and never pinned, so a count keyed on a moved
    // fingerprint said zero while every one of these runs was about to stop.
    const countInFlightRuns = vi.fn().mockResolvedValue(3);
    const impact = await summarizeIntegrationImpact({
      integrationId: "acmechat",
      changesFingerprint: false,
      stopsRuns: true,
      definitions: [
        { id: 9, name: "Tell release channel", definition: definition("send_message") },
      ],
      integrations: deploymentIntegrations({
        manifests: [chat],
        states: new Map([["acmechat", state()]]),
      }),
      countInFlightRuns,
    });

    expect(impact.changesFingerprint).toBe(false);
    expect(impact.inFlightRuns).toBe(3);
    expect(countInFlightRuns).toHaveBeenCalledWith([9]);
  });
});

/** A site that names the account and a token that proves who is calling. */
const site = defineIntegration({
  id: "acmesite",
  name: "Acme Site",
  description: "A provider core has never heard of.",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", env: "ACME_BASE_URL", secret: false, format: "url" },
      { key: "apiToken", label: "API token", env: "ACME_API_TOKEN", secret: true },
    ],
  },
  capabilities: [],
  blocks: [],
  pages: [],
  health: [{ id: "auth", label: "Auth", description: "The token is accepted.", critical: true }],
});

const KEY = "c".repeat(64);
const SECRETS_KEY = { present: true, keyId: integrationSecretsKeyId(KEY) } as const;

function storedSite(baseUrl: string, source: "environment" | "stored"): StoredIntegrationConnection {
  return {
    enabled: true,
    source,
    latestVersion: 1,
    activeVersion: 1,
    active: {
      version: 1,
      config: { baseUrl },
      secrets: {
        apiToken: encryptIntegrationSecret("token", KEY, { integrationId: "acmesite", fieldKey: "apiToken" }),
      },
      secretDigests: { apiToken: integrationSecretDigest("acmesite", "apiToken", "token") },
      testStatus: "passed",
      testReason: null,
      testMessage: null,
      testedAt: "2026-09-18T10:00:00.000Z",
      createdAt: "2026-09-18T10:00:00.000Z",
    },
    latest: null,
    lastTest: null,
  };
}

function preview(
  stored: StoredIntegrationConnection,
  env: Record<string, string>,
  request: Parameters<typeof previewedChange>[0]["preview"],
) {
  const environment = environmentReaderFrom(env);
  return previewedChange({
    manifest: site,
    stored,
    current: resolveIntegrationState({ manifest: site, environment, stored, secretsKey: SECRETS_KEY }),
    environment,
    secretsKey: SECRETS_KEY,
    preview: request,
  });
}

describe("what a change stops, before it is made", () => {
  const ENV = { ACME_BASE_URL: "https://one.example", ACME_API_TOKEN: "token" };

  it("says switching to stored values that name another site stops runs in flight", () => {
    // Decision 9: the switch moves the pin whenever the two sources hold
    // different non-secret values, and it used to happen on one click with
    // nothing said.
    expect(
      preview(storedSite("https://two.example", "environment"), ENV, {
        preview: "source",
        source: "stored",
      }),
    ).toEqual({ changesFingerprint: true, stopsRuns: true });
  });

  it("says switching between two sources holding the same connection stops nothing", () => {
    // ADR-010: the source is a route to values, not a value, so this switch
    // is one a run follows and the screen does not interrupt the admin for it.
    expect(
      preview(storedSite("https://one.example", "environment"), ENV, {
        preview: "source",
        source: "stored",
      }),
    ).toEqual({ changesFingerprint: false, stopsRuns: false });
  });

  it("says turning an enabled integration off stops runs, and moves no pin", () => {
    expect(
      preview(storedSite("https://one.example", "stored"), ENV, { preview: "disable" }),
    ).toEqual({ changesFingerprint: false, stopsRuns: true });
  });
});

describe("runsThatWouldStop", () => {
  it("counts the runs still going, not the claims left behind", () => {
    // The claim table keeps a row for minutes after a run ends, so a preview
    // built on claims tells an admin that finished work is about to be
    // stopped. Before a destructive button, a number has to be true.
    const affected = new Set([11]);

    expect(
      runsThatWouldStop(
        [
          { definitionId: 11, status: "running" },
          { definitionId: 11, status: "awaiting" },
          { definitionId: 11, status: "success" },
          { definitionId: 11, status: "failed" },
          { definitionId: 11, status: null },
          { definitionId: 12, status: "running" },
          { definitionId: null, status: "running" },
        ],
        affected,
      ),
    ).toBe(2);
  });
});
