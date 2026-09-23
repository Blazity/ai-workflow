/**
 * The memory row of the capability overview, read through the resolver a run
 * uses rather than through a hand-written answer.
 *
 * These are the states where the overview and `activeMemory` used to disagree:
 * the resolver counts a memory integration that is switched on and failing,
 * and the list of usable providers does not hold it. A page that worked the
 * answer out from that list named one provider as "all provide it", or said it
 * could not tell who serves memory when the resolver had said exactly who.
 *
 * Only the state layer is staged. `activeMemory` and `deploymentIntegrations`
 * are the real ones; the memory integrations are fakes registered here,
 * because no memory integration ships in this build yet.
 */
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => [] as IntegrationManifest[]);
vi.mock("@integrations/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@integrations/registry")>()),
  integrationManifests: registered,
}));

const resolveUsableIntegrations = vi.fn();
vi.mock("../integrations/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/runtime.js")>()),
  resolveUsableIntegrations,
}));

const readIntegrationStates = vi.fn();
vi.mock("../integrations/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/index.js")>()),
  readIntegrationStates,
}));

const { readCapabilityOverview } = await import("./overview.js");

function manifestOf(name: string): IntegrationManifest {
  return {
    id: name.toLowerCase(),
    name,
    description: "",
    connection: { fields: [] },
    capabilities: ["memory"],
    blocks: [],
    pages: [],
    health: [],
  } as unknown as IntegrationManifest;
}

const WORKING = { status: "connected", connection: "connected", usable: true, failure: null } as const;
const FAILING = {
  status: "failing",
  connection: "failing",
  usable: false,
  failure: { reason: "provider_refused", message: "the provider refused the key" },
} as const;

function stateOf(id: string, condition: typeof WORKING | typeof FAILING): IntegrationState {
  return {
    integrationId: id,
    enabled: true,
    source: "environment",
    verification: { state: "never_tested" },
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: { latestVersion: 0, activeVersion: null, missingFields: [], complete: false, prepared: null },
    pin: { integrationId: id, configFingerprint: `fingerprint-${id}` },
    secretsKeyAvailable: true,
    ...condition,
  } as IntegrationState;
}

/** A deployment with these memory integrations switched on, each in its state. */
function deployment(entries: Array<{ name: string; condition: typeof WORKING | typeof FAILING }>) {
  const manifests = entries.map(({ name }) => manifestOf(name));
  registered.splice(0, registered.length, ...manifests);
  const states = new Map(
    entries.map(({ name, condition }) => [name.toLowerCase(), stateOf(name.toLowerCase(), condition)]),
  );
  readIntegrationStates.mockResolvedValue(states);
  resolveUsableIntegrations.mockResolvedValue({
    readable: true,
    usable: entries
      .filter(({ condition }) => condition.usable)
      .map(({ name }) => ({
        manifest: manifestOf(name),
        runtime: { capabilities: { memory: () => ({}) } },
        ctx: {},
        redaction: { text: (text: string) => text },
      })),
    states,
  });
}

async function memoryRow() {
  const response = await readCapabilityOverview();
  return response.capabilities.find((row) => row.id === "memory");
}

beforeEach(() => {
  vi.clearAllMocks();
  registered.splice(0);
});

describe("the memory row, as the resolver decided it", () => {
  it("names both providers when a working one sits next to a failing one", async () => {
    deployment([
      { name: "Mem0", condition: WORKING },
      { name: "Zep", condition: FAILING },
    ]);

    expect((await memoryRow())?.serving).toEqual({ kind: "ambiguous", ids: ["mem0", "zep"] });
  });

  it("names both providers when both are failing", async () => {
    deployment([
      { name: "Mem0", condition: FAILING },
      { name: "Zep", condition: FAILING },
    ]);

    expect((await memoryRow())?.serving).toEqual({ kind: "ambiguous", ids: ["mem0", "zep"] });
  });

  it("says which provider was chosen and refused when the only one is failing", async () => {
    deployment([{ name: "Mem0", condition: FAILING }]);

    const serving = (await memoryRow())?.serving;
    expect(serving).toMatchObject({ kind: "refused", ids: ["mem0"] });
    expect(serving?.kind === "refused" ? serving.reason : "").toMatch(
      /Mem0 is switched on for memory and its connection is failing/,
    );
  });
});
