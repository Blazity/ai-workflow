import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import {
  activeProviderOf,
  coreBlockCapabilities,
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

const versionControl = manifest({
  id: "acmevcs",
  name: "Acme VCS",
  capabilities: ["vcs"],
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

  const tracker = manifest({
    id: "acmetrack",
    name: "Acme Track",
    capabilities: ["issue_tracker"],
  });

  it("runs when the one connected tracker provides the capability, counted once", () => {
    // Until S12 the connected tracker was also counted as core's own built-in
    // issue tracker, so "Acme Track and this deployment's built-in provider"
    // were two providers of one capability and every block that required the
    // issue tracker was refused on every deployment that had one connected.
    const integrations = deploymentIntegrations({
      manifests: [research, tracker],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrack", state("acmetrack")],
      ]),
    });

    expect(integrationBlockAvailability("acmedocs_research", integrations)).toEqual({
      available: true,
      unavailableReason: null,
    });
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

  it("refuses to pick for the admin when two trackers are connected", () => {
    const other = manifest({ id: "othertrack", name: "Other Track", capabilities: ["issue_tracker"] });
    const integrations = deploymentIntegrations({
      manifests: [research, tracker, other],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrack", state("acmetrack")],
        ["othertrack", state("othertrack")],
      ]),
    });

    const availability = integrationBlockAvailability("acmedocs_research", integrations);
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("Acme Track and Other Track both provide");
    // No selection control exists yet, so the sentence must not send an admin
    // looking for one.
    expect(availability?.unavailableReason).toContain("Disable the ones you do not want");
  });

  it("ignores a provider an admin disabled when counting who can serve", () => {
    const other = manifest({ id: "othertrack", name: "Other Track", capabilities: ["issue_tracker"] });
    const integrations = deploymentIntegrations({
      manifests: [research, tracker, other],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrack", state("acmetrack")],
        ["othertrack", state("othertrack", { enabled: false, status: "disabled", usable: false })],
      ]),
    });

    expect(integrationBlockAvailability("acmedocs_research", integrations)?.available).toBe(true);
  });

  it("names the switched-off tracker rather than sending the admin to connect a second one", () => {
    const integrations = deploymentIntegrations({
      manifests: [research, tracker],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrack", state("acmetrack", { enabled: false, status: "disabled", usable: false })],
      ]),
    });

    const availability = integrationBlockAvailability("acmedocs_research", integrations);
    expect(availability?.unavailableReason).toContain("Acme Track would provide");
    expect(availability?.unavailableReason).toContain("switched off");
  });

  it("refuses a capability execution cannot hand a block, however many declare it", () => {
    // Availability and execution have to agree about WHICH provider serves the
    // block: tracing is applied around a run by core, never handed to a block,
    // so offering a block on it would promise something the run cannot give.
    const tracing = manifest({ id: "acmetrace", name: "Acme Trace", capabilities: ["agent_tracing"] });
    const traced = manifest({
      id: "acmedocs",
      name: "Acme Docs",
      blocks: [{ type: "acmedocs_research", requires: { capabilities: ["agent_tracing"] } }],
    });
    const integrations = deploymentIntegrations({
      manifests: [traced, tracing],
      states: new Map([
        ["acmedocs", state("acmedocs")],
        ["acmetrace", state("acmetrace")],
      ]),
    });

    const availability = integrationBlockAvailability("acmedocs_research", integrations);
    expect(availability?.available).toBe(false);
    expect(availability?.unavailableReason).toContain("Acme Trace");
  });
});

describe("who serves a capability one provider serves at a time", () => {
  it("is nobody, the one, or every name when several are usable, never the first", () => {
    expect(activeProviderOf([])).toEqual({ kind: "none" });
    expect(activeProviderOf(["jira"])).toEqual({ kind: "one", provider: "jira" });
    expect(activeProviderOf(["jira", "linear"])).toEqual({
      kind: "ambiguous",
      providers: ["jira", "linear"],
    });
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

  it("pins the repository provider behind every core version-control block", () => {
    const integrations = deploymentIntegrations({
      manifests: [versionControl],
      states: new Map([["acmevcs", state("acmevcs")]]),
    });

    expect(
      integrationsUsedBy(
        [
          { type: "trigger_pr_created" },
          { type: "prepare_workspace" },
          { type: "open_pr" },
          { type: "post_pr_comment" },
        ],
        integrations,
      ),
    ).toEqual(["acmevcs"]);
  });

  it("leaves the chat provider out when the investigation opted out of it", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([["acmenotify", state("acmenotify")]]),
    });

    expect(
      integrationsUsedBy(
        [{ type: "investigate", params: { sources: ["issue_tracker"] } }],
        integrations,
      ),
    ).toEqual([]);
    // No selection is the parameter's own default, which is both sources on.
    expect(integrationsUsedBy([{ type: "investigate" }], integrations)).toEqual(["acmenotify"]);
  });

  // The pins, the run-start blocker and the disable preview all hand stored
  // nodes, which carry their parameters as `configuration`.
  it("reads a stored node's configuration, not only a runtime node's params", () => {
    const integrations = deploymentIntegrations({
      manifests: [notify],
      states: new Map([["acmenotify", state("acmenotify")]]),
    });

    expect(
      integrationsUsedBy(
        [{ type: "investigate", configuration: { sources: ["issue_tracker"] } }],
        integrations,
      ),
    ).toEqual([]);
  });
});

describe("what a graph reaches beyond the blocks the palette gates", () => {
  const tracker = manifest({ id: "acmetracker", capabilities: ["issue_tracker"] });
  const notebook = manifest({ id: "acmememory", capabilities: ["memory"] });
  const tracer = manifest({ id: "acmetracer", capabilities: ["agent_tracing"] });
  const everything = deploymentIntegrations({
    manifests: [tracker, versionControl, notebook, tracer, notify],
    states: new Map(
      ["acmetracker", "acmevcs", "acmememory", "acmetracer", "acmenotify"].map((id) => [
        id,
        state(id),
      ]),
    ),
  });

  // The disable preview asked "which workflows use the tracker?" and was told
  // none, because no core block declared issue_tracker, and a run pinned
  // nothing for the memory and tracing its workspace reaches. A ticket trigger
  // makes the whole run about a ticket, and preparing a workspace reaches
  // version control, memory and every tracing provider.
  it("reports a ticket workflow that prepares a workspace as using all four", () => {
    expect(
      integrationsUsedBy(
        [{ type: "trigger_ticket_ai" }, { type: "prepare_workspace" }, { type: "open_pr" }],
        everything,
      ),
    ).toEqual(["acmetracker", "acmevcs", "acmememory", "acmetracer"]);
  });

  // F117. An agent block prepares the workspace on first use, so a graph of an
  // agent and a message pinned the messaging provider only, and every version
  // control call of the run then read the missing pin as a provider that moved.
  it("pins version control for an agent block that prepares its own workspace", () => {
    expect(
      integrationsUsedBy(
        [{ type: "trigger_webhook" }, { type: "implementation_agent" }, { type: "send_message" }],
        everything,
      ),
    ).toEqual(["acmevcs", "acmememory", "acmetracer", "acmenotify"]);
  });

  it("traces a generic agent's sandbox without claiming it prepares a workspace", () => {
    expect(coreBlockCapabilities("generic_agent", { workspaceMode: "none" }).reached).toEqual([
      "agent_tracing",
    ]);
  });

  // The same answer the scheduler and the block give (workflowWorkspaceAccessOf,
  // generic-agent/execute.ts): a workspace mode other than "none", including
  // none at all on a definition saved before the field existed, works in the
  // shared checkout, so the run reaches what preparing it reaches.
  it.each([{ workspaceMode: "read_write" }, {}])(
    "counts a generic agent that works in the checkout (%o) as touching the workspace",
    (params) => {
      expect(coreBlockCapabilities("generic_agent", params).reached).toEqual([
        "vcs",
        "memory",
        "agent_tracing",
      ]);
    },
  );

  it("counts a block that only reads a prepared workspace as reaching what preparing it does", () => {
    expect(coreBlockCapabilities("run_checks", {}).reached).toEqual([
      "vcs",
      "memory",
      "agent_tracing",
    ]);
  });

  // The palette's question is narrower on purpose: an agent runs untraced
  // without a tracing provider and remembers into the built-in store without a
  // memory integration, so neither may take the block off the palette.
  it("gates the palette only on what a block cannot run without", () => {
    expect(coreBlockCapabilities("implementation_agent", {}).required).toEqual([]);
    expect(coreBlockCapabilities("trigger_ticket_ai", {}).required).toEqual([]);
    expect(coreBlockCapabilities("open_pr", {}).required).toEqual(["vcs"]);
    expect(coreBlockCapabilities("send_message", {}).required).toEqual(["messaging"]);
  });

  // The words graphs were published with before the vocabulary named no
  // provider. The block runs both halves for them, so both are what it uses.
  it("reads an investigation's legacy source words the way the block runs them", () => {
    expect(coreBlockCapabilities("investigate", { sources: ["jira", "slack"] })).toEqual({
      required: ["messaging"],
      reached: ["issue_tracker", "messaging"],
    });
    expect(coreBlockCapabilities("investigate", { providers: ["jira"] })).toEqual({
      required: [],
      reached: ["issue_tracker"],
    });
  });

  it("names the provider of a capability an integration's own block requires", () => {
    const announcer = manifest({
      id: "acmeannounce",
      blocks: [{ type: "acmeannounce_post", requires: { capabilities: ["messaging"] } }],
    });
    const integrations = deploymentIntegrations({
      manifests: [announcer, notify],
      states: new Map([
        ["acmeannounce", state("acmeannounce")],
        ["acmenotify", state("acmenotify")],
      ]),
    });

    expect(integrationsUsedBy([{ type: "acmeannounce_post" }], integrations)).toEqual([
      "acmeannounce",
      "acmenotify",
    ]);
  });
});
