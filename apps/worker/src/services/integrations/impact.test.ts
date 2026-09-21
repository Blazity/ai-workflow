import { defineIntegration } from "@integrations/sdk";
import type { IntegrationState, WorkflowDefinition } from "@shared/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  deploymentIntegrations,
} from "../../engine/definition/integration-availability.js";
import { summarizeIntegrationImpact, runsThatWouldStop } from "./impact.js";

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
