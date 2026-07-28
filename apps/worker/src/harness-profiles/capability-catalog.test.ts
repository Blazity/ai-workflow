import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessCapabilityCatalog,
  HarnessProfileDraftManifestV1,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import { organization } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  getHarnessCapabilities,
  HarnessCapabilityCatalogError,
  hashHarnessCapabilityCatalog,
  normalizeClaudeModel,
  requireFreshHarnessCapabilities,
  upgradeHarnessDraftToHistoricalV2,
  upgradeHarnessDraftToV2,
} from "./capability-catalog.js";

const CATALOG: HarnessCapabilityCatalog = {
  provider: "codex",
  packageName: "@openai/codex",
  cliVersion: "0.144.6",
  protocolVersion: "codex-jsonl-0.144.6",
  models: [
    {
      id: "gpt-current",
      name: "GPT Current",
      description: "Current Codex model",
      contextWindowTokens: 200_000,
      reasoningEfforts: [
        { id: "medium", name: "Medium", description: null },
        { id: "high", name: "High", description: null },
      ],
      defaultReasoningEffort: "medium",
      serviceTiers: [
        { id: "standard", name: "Standard", description: null },
        { id: "fast", name: "Fast", description: null },
      ],
      defaultServiceTier: "standard",
      verbosityOptions: [
        { id: "medium", name: "Medium", description: null },
      ],
      defaultVerbosity: "medium",
      compactionModes: ["model_default", "custom_threshold"],
    },
  ],
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values([
    { id: "org-a", name: "Organization A", slug: "capability-org-a" },
    { id: "org-b", name: "Organization B", slug: "capability-org-b" },
  ]);
});

describe("Harness capability catalog", () => {
  it("caches a live catalog for fifteen minutes and keeps organizations isolated", async () => {
    const discover = vi.fn(async () => CATALOG);
    const first = await getHarnessCapabilities(db, {
      organizationId: "org-a",
      provider: "codex",
      cliVersion: "0.144.6",
      refresh: false,
      dependencies: {
        now: () => new Date("2026-07-27T10:00:00.000Z"),
        discoverCodex: discover,
      },
    });
    const cached = await getHarnessCapabilities(db, {
      organizationId: "org-a",
      provider: "codex",
      cliVersion: "0.144.6",
      refresh: false,
      dependencies: {
        now: () => new Date("2026-07-27T10:14:59.999Z"),
        discoverCodex: discover,
      },
    });

    expect(discover).toHaveBeenCalledTimes(1);
    expect(cached).toEqual(first);
    await expect(
      getHarnessCapabilities(db, {
        organizationId: "org-b",
        provider: "codex",
        cliVersion: "0.144.6",
        refresh: false,
        dependencies: {
          now: () => new Date("2026-07-27T10:01:00.000Z"),
          discoverCodex: async () => {
            throw new Error("offline");
          },
        },
      }),
    ).rejects.toBeInstanceOf(HarnessCapabilityCatalogError);
  });

  it("returns an expired cache as stale when live discovery fails", async () => {
    await getHarnessCapabilities(db, {
      organizationId: "org-a",
      provider: "codex",
      cliVersion: "0.144.6",
      refresh: false,
      dependencies: {
        now: () => new Date("2026-07-27T10:00:00.000Z"),
        discoverCodex: async () => CATALOG,
      },
    });
    const stale = await getHarnessCapabilities(db, {
      organizationId: "org-a",
      provider: "codex",
      cliVersion: "0.144.6",
      refresh: false,
      dependencies: {
        now: () => new Date("2026-07-27T10:15:00.000Z"),
        discoverCodex: async () => {
          throw new Error("offline");
        },
      },
    });

    expect(stale.stale).toBe(true);
    expect(stale.refreshFailure?.message).toBe(
      "Capability discovery failed.",
    );
    await expect(
      requireFreshHarnessCapabilities(db, {
        organizationId: "org-a",
        provider: "codex",
        cliVersion: "0.144.6",
        dependencies: {
          now: () => new Date("2026-07-27T10:16:00.000Z"),
          discoverCodex: async () => {
            throw new Error("offline");
          },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("coalesces forced refreshes and throttles repeated discovery", async () => {
    let releaseDiscovery: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discover = vi.fn(async () => {
      await blocked;
      return CATALOG;
    });
    const input = {
      organizationId: "org-a",
      provider: "codex" as const,
      cliVersion: "0.144.6",
      refresh: true,
      dependencies: {
        now: () => new Date("2026-07-27T10:00:00.000Z"),
        discoverCodex: discover,
      },
    };

    const first = getHarnessCapabilities(db, input);
    const concurrent = getHarnessCapabilities(db, input);
    releaseDiscovery?.();
    await Promise.all([first, concurrent]);
    expect(discover).toHaveBeenCalledTimes(1);

    await getHarnessCapabilities(db, {
      ...input,
      dependencies: {
        ...input.dependencies,
        now: () => new Date("2026-07-27T10:00:29.999Z"),
      },
    });
    expect(discover).toHaveBeenCalledTimes(1);

    await getHarnessCapabilities(db, {
      ...input,
      dependencies: {
        ...input.dependencies,
        now: () => new Date("2026-07-27T10:00:30.000Z"),
      },
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("does not misreport persistence failures as discovery failures", async () => {
    await getHarnessCapabilities(db, {
      organizationId: "org-a",
      provider: "codex",
      cliVersion: "0.144.6",
      refresh: false,
      dependencies: {
        now: () => new Date("2026-07-27T10:00:00.000Z"),
        discoverCodex: async () => CATALOG,
      },
    });
    const persistenceError = new Error("database write failed");
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "insert") {
          return () => {
            throw persistenceError;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    await expect(
      getHarnessCapabilities(failingDb, {
        organizationId: "org-a",
        provider: "codex",
        cliVersion: "0.144.6",
        refresh: true,
        dependencies: {
          now: () => new Date("2026-07-27T10:00:30.000Z"),
          discoverCodex: async () => CATALOG,
        },
      }),
    ).rejects.toBe(persistenceError);
  });

  it("hashes normalized provider data deterministically and upgrades only a present model", () => {
    const manifest =
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.codex
      ];
    const {
      profileId: _profileId,
      version: _version,
      slug: _slug,
      system: _system,
      ...draft
    } = structuredClone(manifest);
    const response = {
      ...CATALOG,
      catalogHash: hashHarnessCapabilityCatalog(CATALOG),
      fetchedAt: "2026-07-27T10:00:00.000Z",
      stale: false,
      refreshFailure: null,
    };

    expect(hashHarnessCapabilityCatalog(structuredClone(CATALOG))).toBe(
      response.catalogHash,
    );
    expect(() =>
      upgradeHarnessDraftToV2(
        draft as HarnessProfileDraftManifestV1,
        response,
      ),
    ).toThrow(/no longer available/);

    const matching = structuredClone(response);
    matching.models[0]!.id = draft.model.id;
    const upgraded = upgradeHarnessDraftToV2(
      draft as HarnessProfileDraftManifestV1,
      matching,
    );
    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      model: {
        id: draft.model.id,
        reasoning: {
          selection: "model_default",
          effectiveEffort: "medium",
        },
        serviceTier: "standard",
      },
      compaction: { mode: "model_default" },
    });

    const historical = upgradeHarnessDraftToHistoricalV2(
      draft as HarnessProfileDraftManifestV1,
    );
    expect(historical).toMatchObject({
      schemaVersion: 2,
      model: {
        id: draft.model.id,
        reasoning: { effectiveEffort: "none" },
        serviceTier: "standard",
        capability: {
          contextWindowTokens: null,
          compactionModes: ["model_default"],
        },
      },
    });
    expect(historical.model.catalogHash).not.toBe(response.catalogHash);
  });

  it("fills Claude CLI-only effort and compaction controls without inventing model metadata", () => {
    expect(
      normalizeClaudeModel({
        id: "claude-current",
        display_name: "Claude Current",
      }),
    ).toMatchObject({
      id: "claude-current",
      contextWindowTokens: null,
      reasoningEfforts: [
        { id: "low" },
        { id: "medium" },
        { id: "high" },
      ],
      defaultReasoningEffort: "high",
      compactionModes: ["model_default", "disabled"],
    });

    expect(
      normalizeClaudeModel({
        id: "claude-advertised",
        capabilities: {
          effort: {
            supported_efforts: ["medium"],
            default_effort: "medium",
          },
          max_input_tokens: 200_000,
        },
      }),
    ).toMatchObject({
      reasoningEfforts: [{ id: "medium" }],
      defaultReasoningEffort: "medium",
      contextWindowTokens: 200_000,
      compactionModes: [
        "model_default",
        "custom_threshold",
        "disabled",
      ],
    });

    expect(
      normalizeClaudeModel({
        id: "claude-invalid-default",
        capabilities: {
          effort: {
            supported_efforts: ["medium"],
            default_effort: "high",
          },
        },
      }),
    ).toMatchObject({
      reasoningEfforts: [{ id: "medium" }],
      defaultReasoningEffort: "medium",
    });
  });
});
