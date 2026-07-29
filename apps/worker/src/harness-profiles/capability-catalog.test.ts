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
  claudeDiscoveryCredentialEnv,
  CODEX_CAPABILITY_DISCOVERY_TIMEOUT_MS,
  getCachedHarnessCapabilities,
  getHarnessCapabilities,
  HarnessCapabilityCatalogError,
  hashHarnessCapabilityCatalog,
  normalizeClaudeModel,
  prewarmHarnessCapabilityCatalogs,
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
  it("keeps request-time reads cache-only and reports cold prerequisites actionably", async () => {
    await expect(
      getCachedHarnessCapabilities(db, {
        organizationId: "org-a",
        provider: "claude",
        cliVersion: "2.1.216",
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("ANTHROPIC_API_KEY"),
    });

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
    await expect(
      getCachedHarnessCapabilities(db, {
        organizationId: "org-a",
        provider: "codex",
        cliVersion: "0.144.6",
        now: () => new Date("2026-07-27T10:14:59.999Z"),
      }),
    ).resolves.toMatchObject({ stale: false });
    await expect(
      getCachedHarnessCapabilities(db, {
        organizationId: "org-a",
        provider: "codex",
        cliVersion: "0.144.6",
        now: () => new Date("2026-07-27T10:15:00.000Z"),
      }),
    ).resolves.toMatchObject({ stale: true });
  });

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
      getCachedHarnessCapabilities(db, {
        organizationId: "org-a",
        provider: "codex",
        cliVersion: "0.144.6",
        now: () => new Date("2026-07-27T10:15:01.000Z"),
      }),
    ).resolves.toMatchObject({
      stale: true,
      refreshFailure: { message: "Capability discovery failed." },
    });
    await expect(
      requireFreshHarnessCapabilities(db, {
        organizationId: "org-a",
        provider: "codex",
        cliVersion: "0.144.6",
        now: () => new Date("2026-07-27T10:16:00.000Z"),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("bounds scheduled Codex discovery independently from dashboard requests", async () => {
    vi.useFakeTimers();
    let startedDiscovery!: () => void;
    const started = new Promise<void>((resolve) => {
      startedDiscovery = resolve;
    });
    const pending = getHarnessCapabilities(db, {
      organizationId: "org-a",
      provider: "codex",
      cliVersion: "0.144.6",
      refresh: false,
      dependencies: {
        discoverCodex: async (_cliVersion, signal) => {
          startedDiscovery();
          return await new Promise<HarnessCapabilityCatalog>(
            (_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () =>
                  reject(
                    new DOMException("Discovery timed out", "AbortError"),
                  ),
                { once: true },
              );
            },
          );
        },
      },
    });
    await started;
    const rejection = expect(pending).rejects.toMatchObject({
      statusCode: 503,
    });
    await vi.advanceTimersByTimeAsync(
      CODEX_CAPABILITY_DISCOVERY_TIMEOUT_MS,
    );
    await rejection;
    vi.useRealTimers();
  });

  it("prewarms every organization and isolates provider failures", async () => {
    const result = await prewarmHarnessCapabilityCatalogs(db, {
      dependencies: {
        discoverCodex: async () => CATALOG,
        discoverClaude: async () => {
          throw new Error("missing models credential");
        },
      },
    });

    expect(result).toEqual({
      organizations: 2,
      attempted: 4,
      ready: 2,
      stale: 0,
      failed: 2,
    });
    expect(
      await getCachedHarnessCapabilities(db, {
        organizationId: "org-a",
        provider: "codex",
        cliVersion: "0.144.6",
      }),
    ).toMatchObject({ stale: false });
  });

  it("refreshes warm catalogs before they expire", async () => {
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
    const discoverCodex = vi.fn(async () => CATALOG);
    const discoverClaude = async () => {
      throw new Error("missing models credential");
    };

    await prewarmHarnessCapabilityCatalogs(db, {
      dependencies: {
        now: () => new Date("2026-07-27T10:09:59.999Z"),
        discoverCodex,
        discoverClaude,
      },
    });
    expect(discoverCodex).toHaveBeenCalledTimes(1);

    await prewarmHarnessCapabilityCatalogs(db, {
      dependencies: {
        now: () => new Date("2026-07-27T10:10:00.000Z"),
        discoverCodex,
        discoverClaude,
      },
    });
    expect(discoverCodex).toHaveBeenCalledTimes(2);
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

  it("uses only capabilities advertised by the pinned Claude CLI", () => {
    expect(
      normalizeClaudeModel({
        value: "claude-current",
        displayName: "Claude Current",
      }),
    ).toBeNull();

    expect(
      normalizeClaudeModel({
        value: "claude-advertised",
        displayName: "Claude Advertised",
        description: "Pinned CLI model",
        supportsEffort: true,
        supportedEffortLevels: ["medium", "high"],
      }),
    ).toMatchObject({
      reasoningEfforts: [{ id: "medium" }, { id: "high" }],
      defaultReasoningEffort: null,
      contextWindowTokens: null,
      compactionModes: ["model_default", "disabled"],
    });

    expect(
      normalizeClaudeModel({
        value: "claude-no-effort",
        displayName: "Claude No Effort",
        supportsEffort: false,
      }),
    ).toMatchObject({
      reasoningEfforts: [{ id: "none" }],
      defaultReasoningEffort: "none",
    });
  });

  it("routes the existing Claude credential by its actual type", () => {
    expect(claudeDiscoveryCredentialEnv("sk-ant-api-test")).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-api-test",
    });
    expect(claudeDiscoveryCredentialEnv("sk-ant-oat-test")).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
    });
  });
});
