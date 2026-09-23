import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deploymentIntegrations } from "../../engine/definition/integration-availability.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

const database = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/client.js")>()),
  getDb: () => database.db,
}));

const { capabilityOverview, readCapabilityOverview } = await import("./overview.js");

/** A manifest reduced to what the overview and the engine read. */
function manifest(id: string, capabilities: string[]): IntegrationManifest {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: "",
    connection: { fields: [] },
    capabilities,
    blocks: [],
    pages: [],
    health: [],
  } as unknown as IntegrationManifest;
}

function state(id: string, usable: boolean): IntegrationState {
  return {
    integrationId: id,
    enabled: true,
    source: "environment",
    status: usable ? "connected" : "not_connected",
    connection: usable ? "connected" : "not_connected",
    verification: { state: "never_tested" },
    failure: null,
    usable,
    environment: { setVariables: [], missingVariables: [], complete: usable },
    stored: { latestVersion: 0, activeVersion: null, missingFields: [], complete: false, prepared: null },
    pin: { integrationId: id, configFingerprint: "" },
    secretsKeyAvailable: true,
  };
}

function overview(
  manifests: IntegrationManifest[],
  usable: string[],
  memory: Parameters<typeof capabilityOverview>[0]["memory"] = {
    id: "builtin",
    name: "Built-in memory",
    refusal: null,
  },
) {
  const states = new Map(manifests.map((m) => [m.id, state(m.id, usable.includes(m.id))]));
  const rows = capabilityOverview({
    manifests,
    deployment: deploymentIntegrations({ manifests, states }),
    memory,
  });
  return new Map(rows.map((row) => [row.id, row]));
}

describe("which provider serves each capability", () => {
  it("serves memory from the built-in store on a deployment that connected nothing", () => {
    // ADR-010 decision 21: connecting a memory integration replaces a
    // provider rather than supplying the first. The Integrations page showed
    // no memory at all, so an admin could not see that anything served it.
    const rows = overview([manifest("tracker", ["issue_tracker"])], []);

    expect(rows.get("memory")).toMatchObject({
      label: "Memory",
      cardinality: "one",
      declaredBy: [],
      serving: { kind: "builtin", name: "Built-in memory" },
    });
    expect(rows.get("issue_tracker")).toMatchObject({
      declaredBy: ["tracker"],
      serving: { kind: "none" },
    });
  });

  it("lists no capability that has no port yet", () => {
    const rows = overview([], []);
    expect([...rows.keys()]).not.toContain("agent_tools");
    expect([...rows.keys()]).toEqual(["issue_tracker", "vcs", "messaging", "memory", "agent_tracing"]);
  });

  it("names two usable providers of a one-provider capability as a refusal, never as the first", () => {
    const rows = overview(
      [manifest("tracker", ["issue_tracker"]), manifest("linear", ["issue_tracker"])],
      ["tracker", "linear"],
    );
    expect(rows.get("issue_tracker")?.serving).toEqual({
      kind: "ambiguous",
      ids: ["tracker", "linear"],
    });
  });

  it("does not count a provider that is not usable, so switching one off resolves the choice", () => {
    const rows = overview(
      [manifest("tracker", ["issue_tracker"]), manifest("linear", ["issue_tracker"])],
      ["linear"],
    );
    expect(rows.get("issue_tracker")?.serving).toEqual({ kind: "integrations", ids: ["linear"] });
  });

  it("serves a many-provider capability from every usable provider at once", () => {
    const rows = overview(
      [manifest("hub", ["vcs"]), manifest("lab", ["vcs"]), manifest("bucket", ["vcs"])],
      ["hub", "lab"],
    );
    expect(rows.get("vcs")).toMatchObject({
      cardinality: "many",
      declaredBy: ["hub", "lab", "bucket"],
      serving: { kind: "integrations", ids: ["hub", "lab"] },
    });
  });

  it("names the integration that took memory over", () => {
    const rows = overview([manifest("recall", ["memory"])], ["recall"], {
      id: "recall",
      name: "Recall",
      refusal: null,
    });
    expect(rows.get("memory")?.serving).toEqual({ kind: "integrations", ids: ["recall"] });
  });

  it("reports memory's own refusal rather than the built-in store it did not fall back to", () => {
    // Zep is switched on and failing, so it is not usable: the ids have to
    // come from the resolver's refusal, not from who is usable.
    const ambiguous = overview(
      [manifest("recall", ["memory"]), manifest("zep", ["memory"])],
      ["recall"],
      {
        id: null,
        name: "no memory provider",
        refusal: {
          code: "ambiguous",
          detail: "Recall and Zep both provide memory",
          providers: ["recall", "zep"],
        },
      },
    );
    expect(ambiguous.get("memory")?.serving).toEqual({ kind: "ambiguous", ids: ["recall", "zep"] });

    const failing = overview([manifest("recall", ["memory"])], [], {
      id: null,
      name: "no memory provider",
      refusal: {
        code: "unavailable",
        detail: "Recall is switched on for memory and its connection is failing",
        providers: ["recall"],
      },
    });
    expect(failing.get("memory")?.serving).toEqual({
      kind: "refused",
      ids: ["recall"],
      reason: "Recall is switched on for memory and its connection is failing",
    });

    const unreadable = overview([], [], {
      id: null,
      name: "no memory provider",
      refusal: {
        code: "unreadable",
        detail: "this deployment's integration settings could not be read (timeout), so memory was not used",
        providers: [],
      },
    });
    expect(unreadable.get("memory")?.serving).toEqual({
      kind: "unknown",
      reason: "this deployment's integration settings could not be read (timeout), so memory was not used",
    });
  });
});

describe("the overview this deployment reads", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    database.db = db;
  });

  it("asks the same resolvers a run does, and says memory is served by the built-in store", async () => {
    // Nothing stored: whatever the environment configures, no integration in
    // this build serves memory, so the run's own resolver answers built-in.
    const response = await readCapabilityOverview();
    const rows = new Map(response.capabilities.map((row) => [row.id, row]));

    expect(rows.get("memory")?.serving).toEqual({ kind: "builtin", name: "Built-in memory" });
    expect(rows.get("issue_tracker")?.declaredBy).toEqual(["jira"]);
    expect(rows.get("vcs")?.declaredBy).toEqual(["github", "gitlab"]);
  });
});
