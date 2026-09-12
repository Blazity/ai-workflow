import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  listSettingsVersions,
  readAllSettings,
  writeManySettings,
} from "../../db/repositories/settings.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {} as Record<string, unknown>,
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

const {
  ensureEnvironmentSettingsImported,
  importEnvironmentSettings,
  migratedVariablesSet,
  resetEnvironmentSettingsImportForTest,
} = await import("./environment-import.js");
const { loadSettingsResolution, loadSettingsSnapshot } = await import("./snapshot.js");

let db: Db;

/** A deployment that still runs on its variables, in miniature. */
function environmentAsDeployed(): Record<string, unknown> {
  return {
    MAX_CONCURRENT_AGENTS: 7,
    COLUMN_AI: "Agent",
    JOB_TIMEOUT_MS: 1_800_000,
    DASHBOARD_ORG_SLUG: "acme",
  };
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  db = await createTestDb();
  state.db = db;
  for (const key of Object.keys(state.env)) delete state.env[key];
  Object.assign(state.env, environmentAsDeployed());
  // The parsed environment is mocked above; presence is answered from
  // process.env, so a case has to set both to look like a real deployment.
  vi.stubEnv("MAX_CONCURRENT_AGENTS", "7");
  vi.stubEnv("COLUMN_AI", "Agent");
  vi.stubEnv("JOB_TIMEOUT_MS", "1800000");
  vi.stubEnv("DASHBOARD_ORG_SLUG", "acme");
  resetEnvironmentSettingsImportForTest();
});

describe("environment import", () => {
  it("stores every migrated value the deployment sets, once", async () => {
    const written = await importEnvironmentSettings();

    expect(written).toContain("MAX_CONCURRENT_AGENTS");
    expect(written).toContain("COLUMN_AI");
    expect(written).toContain("JOB_TIMEOUT_MS");
    const stored = new Map(
      (await readAllSettings(db)).map((row) => [row.key, row.value]),
    );
    expect(stored.get("MAX_CONCURRENT_AGENTS")).toBe(7);
    expect(stored.get("COLUMN_AI")).toBe("Agent");

    // Recorded as a change, under an actor nobody will mistake for a person or
    // for the build-time seed.
    const versions = await listSettingsVersions(db, "COLUMN_AI", 10);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.actor).toBe("environment import");
    expect(versions[0]?.previousValue).toBeNull();
    expect(versions[0]?.newValue).toBe("Agent");
  });

  it("writes nothing on a second run", async () => {
    const first = await importEnvironmentSettings();
    expect(first.length).toBeGreaterThan(0);

    const second = await importEnvironmentSettings();

    expect(second).toEqual([]);
    const versions = await listSettingsVersions(db, "COLUMN_AI", 10);
    expect(versions).toHaveLength(1);
  });

  it("never overwrites a row an operator decided", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 1 },
      actor: "user_admin",
      reason: "throttling",
    });

    const written = await importEnvironmentSettings();

    expect(written).not.toContain("MAX_CONCURRENT_AGENTS");
    const stored = new Map(
      (await readAllSettings(db)).map((row) => [row.key, row.value]),
    );
    // The environment says 7 and the operator said 1. The operator wins, and no
    // second version row pretends anything changed.
    expect(stored.get("MAX_CONCURRENT_AGENTS")).toBe(1);
    const versions = await listSettingsVersions(db, "MAX_CONCURRENT_AGENTS", 10);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.actor).toBe("user_admin");
  });

  it("leaves the keys this deployment still reads itself alone", async () => {
    const written = await importEnvironmentSettings();

    // DASHBOARD_ORG_SLUG is marked requiresRedeploy: the auth instance reads
    // the variable at module load, so a stored row would be a second answer to
    // the same question rather than a durable one.
    expect(written).not.toContain("DASHBOARD_ORG_SLUG");
    const stored = new Map(
      (await readAllSettings(db)).map((row) => [row.key, row.value]),
    );
    expect(stored.has("DASHBOARD_ORG_SLUG")).toBe(false);
  });

  it("resolves the same values before and after it runs", async () => {
    const before = await (async () => {
      // The snapshot as it resolves with nothing stored: the deployment's
      // environment, which is what production is running on right now.
      const { snapshot } = await loadSettingsResolution();
      return snapshot;
    })();

    await importEnvironmentSettings();
    const { snapshot: after, sources } = await loadSettingsResolution();

    expect(after).toEqual(before);
    // What DID change is where each one comes from, which is the whole point.
    expect(sources.get("MAX_CONCURRENT_AGENTS")).toBe("stored");
  });

  it("runs at the first snapshot and only once per process", async () => {
    expect(await readAllSettings(db)).toEqual([]);

    await loadSettingsSnapshot();
    const afterFirst = await readAllSettings(db);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterFirst.every((row) => row.updatedBy === "environment import")).toBe(true);

    // A second snapshot on a database that lost the rows writes nothing: the
    // process already did its one import.
    db = await createTestDb();
    state.db = db;
    await loadSettingsSnapshot();
    expect(await readAllSettings(db)).toEqual([]);
  });

  it("survives a database that refuses the write", async () => {
    const broken = {
      execute: () => Promise.reject(new Error("read only replica")),
      select: () => ({ from: () => Promise.resolve([]) }),
    };
    state.db = broken;

    // No throw: the resolution order still answers from the environment, and a
    // failed import must not take the settings read down with it.
    await expect(ensureEnvironmentSettingsImported()).resolves.toBeUndefined();
  });

  it("names the variables an operator still has to remove, and nothing else", () => {
    const names = migratedVariablesSet();

    expect(names).toContain("MAX_CONCURRENT_AGENTS");
    expect(names).toContain("COLUMN_AI");
    // Still set, still read by the deployment itself, so not on the list.
    expect(names).not.toContain("DASHBOARD_ORG_SLUG");
    // Unset here, so there is nothing to remove.
    expect(names).not.toContain("POLL_INTERVAL_MS");
  });
});
