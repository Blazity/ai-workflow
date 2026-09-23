import { integrationManifest } from "@integrations/registry";
import { INTEGRATION_CAPABILITIES, defineIntegration } from "@integrations/sdk";
import type {
  IntegrationConnectionPin,
  IntegrationState,
  WorkflowDefinition,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import { describe, expect, it, vi } from "vitest";

import { deploymentIntegrations } from "../../engine/definition/integration-availability.js";
import { encryptIntegrationSecret, integrationSecretsKeyId } from "../../infra/secrets-crypto.js";
import {
  capabilitiesTheReachSees,
  previewedChange,
  runsThatMayStop,
  summarizeIntegrationImpact,
  type InFlightRun,
} from "./impact.js";
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

const chatWithBlock = defineIntegration({
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
});

const hub = defineIntegration({
  id: "acmehub",
  name: "Acme Hub",
  description: "Hosts repositories.",
  connection: { fields: [] },
  capabilities: ["vcs"],
  blocks: [],
  pages: [],
  health: [{ id: "reachable", label: "Reachable", description: "", critical: true }],
});

function state(id: string, fingerprint = `${id}-now`): IntegrationState {
  return {
    integrationId: id,
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
    pin: { integrationId: id, configFingerprint: fingerprint },
    secretsKeyAvailable: true,
  };
}

function definition(types: string[], repositoryScope?: WorkflowRepositoryScope): WorkflowDefinition {
  return {
    schemaVersion: 2,
    ...(repositoryScope ? { repositoryScope } : {}),
    nodes: types.map((type, index) => ({
      id: `${type}-${index}`,
      type: type as WorkflowDefinition["nodes"][number]["type"],
      x: index * 200,
      y: 0,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    })),
    edges: [],
  };
}

function pinned(...pins: Array<[string, string]>): readonly IntegrationConnectionPin[] {
  return pins.map(([integrationId, configFingerprint]) => ({ integrationId, configFingerprint }));
}

function run(definitionId: number, pins: readonly IntegrationConnectionPin[] | null, status = "running"): InFlightRun {
  return { definitionId, status, integrationPins: pins };
}

describe("which enabled workflows use an integration", () => {
  it("lists a workflow that uses the integration's own block", async () => {
    const impact = await summarizeIntegrationImpact({
      integrationId: "acmechat",
      changesFingerprint: true,
      stops: "reconfigured",
      currentFingerprint: "acmechat-now",
      definitions: [{ id: 7, name: "Deploy announcements", definition: definition(["acmechat_announce"]) }],
      integrations: deploymentIntegrations({
        manifests: [chatWithBlock],
        states: new Map([["acmechat", state("acmechat")]]),
      }),
      readInFlightRuns: async () => [run(7, pinned(["acmechat", "acmechat-now"]))],
    });

    expect(impact.enabledDefinitions).toEqual([{ id: 7, name: "Deploy announcements" }]);
    expect(impact.inFlightRuns).toBe(1);
  });

  it("lists a workflow that reaches the integration only through the core send message block", async () => {
    const impact = await summarizeIntegrationImpact({
      integrationId: "acmechat",
      changesFingerprint: false,
      stops: "none",
      currentFingerprint: "acmechat-now",
      definitions: [{ id: 9, name: "Tell release channel", definition: definition(["send_message"]) }],
      integrations: deploymentIntegrations({
        manifests: [chat],
        states: new Map([["acmechat", state("acmechat")]]),
      }),
      readInFlightRuns: vi.fn(),
    });

    expect(impact.enabledDefinitions).toEqual([{ id: 9, name: "Tell release channel" }]);
    expect(impact.inFlightRuns).toBe(0);
  });

  it("sees every capability an integration can serve, so no preview has to say unknown", () => {
    // A capability the reach calculation cannot see makes the preview say
    // "unknown" rather than a measured zero. This names every capability that
    // has a port: one added to the SDK without teaching the calculation turns
    // this red, and the preview says unknown for it until then.
    const providable = Object.entries(INTEGRATION_CAPABILITIES)
      .filter(([, capability]) => capability.reservedFor === null)
      .map(([id]) => id);
    expect([...capabilitiesTheReachSees()].sort()).toEqual(providable.sort());
  });
});

describe("a version control provider, which a workflow reaches through the repository it picks", () => {
  const hubWithBlock = defineIntegration({
    ...hub,
    blocks: [
      {
        type: "acmehub_label",
        paramsSchema: { parse: (value: unknown) => value } as never,
        contract: { ports: ["out"], allowsFailurePort: false },
        ui: {
          label: "Label",
          description: "Labels a pull request.",
          glyph: "L",
          color: "#445566",
          softColor: "#EEF1F4",
        },
        output: { properties: {}, statusVariants: ["labelled"] },
      },
    ],
  });
  const integrations = deploymentIntegrations({
    manifests: [hubWithBlock],
    states: new Map([["acmehub", state("acmehub")]]),
  });
  const agentWork = ["prepare_workspace", "open_pr"];
  const definitions = [
    { id: 1, name: "Any repository", definition: definition(agentWork) },
    { id: 2, name: "GitLab only", definition: definition(agentWork, { providers: ["gitlab"] }) },
    {
      id: 3,
      name: "One GitLab repository",
      definition: definition(agentWork, {
        repositories: [{ provider: "gitlab", repoPath: "acme/api" }],
      }),
    },
    { id: 4, name: "Hub only", definition: definition(agentWork, { providers: ["acmehub"] }) },
    {
      id: 5,
      name: "GitLab work, Hub labels",
      definition: definition([...agentWork, "acmehub_label"], { providers: ["gitlab"] }),
    },
  ];
  const turnedOff = () =>
    summarizeIntegrationImpact({
      integrationId: "acmehub",
      changesFingerprint: false,
      stops: "unusable",
      currentFingerprint: "acmehub-now",
      definitions,
      integrations,
      readInFlightRuns: async () => definitions.map(({ id }) => run(id, null)),
    });

  it("names no workflow whose repository scope rules the provider out", async () => {
    // Every workflow that does agent work pins every connected provider at its
    // start, because its repository is chosen later. Listing by that reach
    // told an admin turning Hub off that a GitLab-only workflow would feel it.
    const impact = await turnedOff();

    expect(impact.enabledDefinitions).toEqual([
      { id: 1, name: "Any repository" },
      { id: 4, name: "Hub only" },
      { id: 5, name: "GitLab work, Hub labels" },
    ]);
  });

  it("counts a run in flight only where its workflow may still reach the provider", async () => {
    // The kill switch count follows the list: a run of a GitLab-only workflow
    // never asks Hub for anything, and the one that uses Hub's own block does.
    const impact = await turnedOff();

    expect(impact.inFlightRuns).toBe(3);
  });

  it("rules a provider out the way repository selection does, when both lists are set", async () => {
    // A scope naming GitLab as its provider and a Hub repository selects
    // nothing on Hub: repository selection intersects the two, and the preview
    // reads the same rule rather than a copy of it.
    const impact = await summarizeIntegrationImpact({
      integrationId: "acmehub",
      changesFingerprint: false,
      stops: "unusable",
      currentFingerprint: "acmehub-now",
      definitions: [
        {
          id: 6,
          name: "Contradictory scope",
          definition: definition(agentWork, {
            providers: ["gitlab"],
            repositories: [{ provider: "acmehub", repoPath: "acme/api" }],
          }),
        },
      ],
      integrations,
      readInFlightRuns: async () => [run(6, null)],
    });

    expect(impact.enabledDefinitions).toEqual([]);
    expect(impact.inFlightRuns).toBe(0);
  });
});

describe("a Jira change, in front of every ticket run in flight", () => {
  const jira = integrationManifest("jira");
  if (!jira) throw new Error("this build ships Jira");
  const ticketWorkflow = definition(["trigger_ticket_ai", "prepare_workspace", "open_pr"]);
  const runs = [
    run(1, pinned(["jira", "jira-now"])),
    run(1, pinned(["jira", "jira-now"]), "awaiting"),
    run(1, pinned(["jira", "jira-now"]), "success"),
  ];
  const summarize = (stops: "reconfigured" | "unusable") =>
    summarizeIntegrationImpact({
      integrationId: "jira",
      changesFingerprint: stops === "reconfigured",
      stops,
      currentFingerprint: "jira-now",
      definitions: [{ id: 1, name: "Ticket to PR", definition: ticketWorkflow }],
      integrations: deploymentIntegrations({
        manifests: [jira],
        states: new Map([["jira", state("jira")]]),
      }),
      readInFlightRuns: async () => runs,
    });

  it("says a config edit stops no ticket run, and still names the workflow that uses Jira", async () => {
    // Nothing compares a tracker pin today: a ticket run reads the tracker as
    // it is configured at each use. Counting those runs would promise a
    // stoppage that does not happen.
    const impact = await summarize("reconfigured");

    expect(impact.enabledDefinitions).toEqual([{ id: 1, name: "Ticket to PR" }]);
    expect(impact.inFlightRuns).toBe(0);
  });

  it("counts every ticket run still going when Jira is turned off", async () => {
    // The original blocker: the kill switch said "0 runs in flight will stop"
    // while every ticket run was about to fail at its next tracker call.
    const impact = await summarize("unusable");

    expect(impact.enabledDefinitions).toEqual([{ id: 1, name: "Ticket to PR" }]);
    expect(impact.inFlightRuns).toBe(2);
  });
});

describe("runs a config edit may stop", () => {
  const messagingDeployment = deploymentIntegrations({
    manifests: [chatWithBlock],
    states: new Map([["acmechat", state("acmechat")]]),
  });
  const vcsDeployment = deploymentIntegrations({
    manifests: [hub],
    states: new Map([["acmehub", state("acmehub")]]),
  });
  const count = (
    runs: InFlightRun[],
    definitions: Array<[number, WorkflowDefinition]>,
    integrationId: string,
    integrations: typeof messagingDeployment,
  ) =>
    runsThatMayStop({
      runs,
      integrationId,
      stops: "reconfigured",
      currentFingerprint: `${integrationId}-now`,
      definitions: new Map(definitions),
      integrations,
    });

  it("counts a run whose send message block compares its chat pin, and not one that only notifies", () => {
    expect(
      count(
        [run(1, pinned(["acmechat", "acmechat-now"])), run(2, pinned(["acmechat", "acmechat-now"]))],
        [
          [1, definition(["send_message"])],
          // A ticket workflow notifies the channel on its own; a notification
          // that finds the pin moved is withheld and the run goes on.
          [2, definition(["trigger_ticket_ai", "prepare_workspace"])],
        ],
        "acmechat",
        messagingDeployment,
      ),
    ).toBe(1);
  });

  it("counts a run whose graph holds the integration's own block", () => {
    expect(
      count(
        [run(1, pinned(["acmechat", "acmechat-now"]))],
        [[1, definition(["acmechat_announce"])]],
        "acmechat",
        messagingDeployment,
      ),
    ).toBe(1);
  });

  it("does not count a run that recorded no pins, or no pin for it, or an older one", () => {
    expect(
      count(
        [
          run(1, null),
          run(1, []),
          run(1, pinned(["other", "other-now"])),
          // Already pinned to values that are not in force: it stops at its
          // next use whatever this change does.
          run(1, pinned(["acmechat", "acmechat-before"])),
        ],
        [[1, definition(["send_message"])]],
        "acmechat",
        messagingDeployment,
      ),
    ).toBe(0);
  });

  it("counts a version control run only where its repository scope leaves room for the provider", () => {
    const pins = pinned(["acmehub", "acmehub-now"]);
    expect(
      count(
        [run(1, pins), run(2, pins), run(3, pins), run(4, pins)],
        [
          [1, definition(["prepare_workspace", "open_pr"])],
          [2, definition(["prepare_workspace", "open_pr"], { providers: ["gitlab"] })],
          [
            3,
            definition(["prepare_workspace", "open_pr"], {
              repositories: [{ provider: "gitlab", repoPath: "acme/api" }],
            }),
          ],
          [4, definition(["prepare_workspace", "open_pr"], { providers: ["acmehub"] })],
        ],
        "acmehub",
        vcsDeployment,
      ),
    ).toBe(2);
  });

  it("counts the runs still going, not the claims left behind", () => {
    // The claim table keeps a row for minutes after a run ends, so a preview
    // built on claims tells an admin that finished work is about to be
    // stopped. Before a destructive button, a number has to be true.
    const pins = pinned(["acmechat", "acmechat-now"]);
    expect(
      count(
        [
          run(1, pins, "running"),
          run(1, pins, "awaiting"),
          run(1, pins, "success"),
          run(1, pins, "failed"),
          { definitionId: 1, status: null, integrationPins: pins },
          { definitionId: null, status: "running", integrationPins: pins },
        ],
        [[1, definition(["send_message"])]],
        "acmechat",
        messagingDeployment,
      ),
    ).toBe(2);
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

  it("says switching to stored values that name another site reconfigures runs in flight", () => {
    // Decision 9: the switch moves the pin whenever the two sources hold
    // different non-secret values, and it used to happen on one click with
    // nothing said.
    expect(
      preview(storedSite("https://two.example", "environment"), ENV, {
        preview: "source",
        source: "stored",
      }),
    ).toEqual({ changesFingerprint: true, stops: "reconfigured" });
  });

  it("says switching between two sources holding the same connection stops nothing", () => {
    // ADR-010: the source is a route to values, not a value, so this switch
    // is one a run follows and the screen does not interrupt the admin for it.
    expect(
      preview(storedSite("https://one.example", "environment"), ENV, {
        preview: "source",
        source: "stored",
      }),
    ).toEqual({ changesFingerprint: false, stops: "none" });
  });

  it("says turning an enabled integration off makes it unusable, and moves no pin", () => {
    expect(
      preview(storedSite("https://one.example", "stored"), ENV, { preview: "disable" }),
    ).toEqual({ changesFingerprint: false, stops: "unusable" });
  });

  it("says turning off a connection that is not working stops no run, because none is using it", () => {
    // A run holds a pin only for a connection that was usable when it started,
    // and a failing one already stops every run at its next use. The kill
    // switch used to count those runs as its own.
    expect(
      preview(storedSite("https://one.example", "environment"), {}, { preview: "disable" }),
    ).toEqual({ changesFingerprint: false, stops: "none" });
  });

  it("says disconnecting with nothing to fall back to makes it unusable", () => {
    expect(
      preview(storedSite("https://one.example", "stored"), {}, { preview: "disconnect" }),
    ).toMatchObject({ stops: "unusable" });
  });

  it("says a save that names another site reconfigures, and one that changes only the token does not", () => {
    const stored = storedSite("https://one.example", "stored");
    expect(
      preview(stored, ENV, {
        preview: "save",
        values: { baseUrl: "https://two.example" },
        clearSecrets: [],
        expectedVersion: 1,
      }),
    ).toEqual({ changesFingerprint: true, stops: "reconfigured" });
    expect(
      preview(stored, ENV, {
        preview: "save",
        values: { apiToken: "rotated" },
        clearSecrets: [],
        expectedVersion: 1,
      }),
    ).toEqual({ changesFingerprint: false, stops: "none" });
  });
});
