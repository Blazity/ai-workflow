import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  listSettingsVersions,
  readAllSettings,
  writeManySettings,
} from "../../db/repositories/settings.js";
import { deleteSetting } from "../../db/repositories/settings-reset.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {} as Record<string, unknown>,
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

const {
  ensureEnvironmentSettingsImported,
  migratedVariablesSet,
  migratedVariablesUnstored,
  resetEnvironmentSettingsImportForTest,
  storeEnvironmentValues,
} = await import("./environment-import.js");
const { loadSettingsResolution, loadSettingsSnapshot } = await import("./snapshot.js");
const { logger } = await import("../../infra/logger.js");

/** What the deployment has stored right now, as the import is handed it. */
async function storedKeys(): Promise<Set<string>> {
  return new Set((await readAllSettings(db)).map((row) => row.key));
}

/** The import as a caller makes it: the keys it just read, then the write. */
async function importNow(): Promise<string[]> {
  return (await storeEnvironmentValues(await storedKeys())).map((row) => row.key);
}

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
    const written = await importNow();

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
    const first = await importNow();
    expect(first.length).toBeGreaterThan(0);

    // Nothing is missing now, so the second run sends no statement at all: the
    // rows it was handed already answer for every migrated variable.
    const execute = vi.spyOn(db, "execute");
    const second = await importNow();

    expect(second).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
    const versions = await listSettingsVersions(db, "COLUMN_AI", 10);
    expect(versions).toHaveLength(1);
  });

  it("never overwrites a row an operator decided", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 1 },
      actor: "user_admin",
      reason: "throttling",
    });

    const written = await importNow();

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
    const written = await importNow();

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

    await importNow();
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

  it("removes a leftover row for a key the environment owns, in the same statement", async () => {
    // A row an earlier release let somebody store, before the resolution
    // started ignoring these keys. The running worker reads the variable at
    // module load, so this row has never been in force.
    await writeManySettings(db, {
      patch: { DASHBOARD_ORG_SLUG: "typo-inc" },
      actor: "user_admin",
      reason: "before the environment took this key back",
    });

    await importNow();

    const stored = new Map((await readAllSettings(db)).map((row) => [row.key, row.value]));
    expect(stored.has("DASHBOARD_ORG_SLUG")).toBe(false);
    // And the resolution says what the running code does.
    const { snapshot, sources } = await loadSettingsResolution();
    expect(snapshot.DASHBOARD_ORG_SLUG).toBe("acme");
    expect(sources.get("DASHBOARD_ORG_SLUG")).toBe("environment");
    // The removal is a change somebody can find, not a row that vanished.
    const [latest] = await listSettingsVersions(db, "DASHBOARD_ORG_SLUG", 1);
    expect(latest?.actor).toBe("environment import");
    expect(latest?.previousValue).toBe("typo-inc");
    expect(latest?.newValue).toBe("acme");
  });

  it("stops calling a value stored once the row is reset in the same process", async () => {
    await loadSettingsSnapshot();
    expect((await loadSettingsResolution()).sources.get("MAX_CONCURRENT_AGENTS")).toBe(
      "stored",
    );

    // What settings.reset does: the row goes, the key goes back to whatever
    // answered before it. The import is memoised and will not write it again.
    await expect(
      deleteSetting(db, {
        key: "MAX_CONCURRENT_AGENTS",
        resolvedValue: 7,
        actor: "operator",
        reason: "back to the environment",
      }),
    ).resolves.toBe(true);

    const resolution = await loadSettingsResolution();

    expect(resolution.sources.get("MAX_CONCURRENT_AGENTS")).toBe("environment");
    // And the banner says the variable is unsafe to remove again, because it is.
    expect(migratedVariablesUnstored(resolution)).toContain("MAX_CONCURRENT_AGENTS");
  });

  it("survives a database that refuses the write, and says which values are not stored", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const broken = {
      execute: () => Promise.reject(new Error("read only replica")),
      select: () => ({ from: () => Promise.resolve([]) }),
    };
    state.db = broken;

    // No throw: the resolution order still answers from the environment, and a
    // failed import must not take the settings read down with it.
    await expect(ensureEnvironmentSettingsImported(new Set())).resolves.toEqual([]);
    const { snapshot, sources } = await loadSettingsResolution();
    const unstored = migratedVariablesUnstored({ snapshot, sources });

    // And the failure is visible where an operator will look, not only in the
    // log: every variable it could not store is named as unsafe to remove.
    expect(unstored).toContain("MAX_CONCURRENT_AGENTS");
    expect(unstored).toContain("COLUMN_AI");
    expect(unstored).toContain("JOB_TIMEOUT_MS");
    expect(unstored).toEqual(migratedVariablesSet());
    expect(
      warn.mock.calls.filter((call) => call[1] === "settings_environment_import_failed"),
    ).toHaveLength(1);

    // Memoised: a process does not retry a refused write on every settings read.
    await ensureEnvironmentSettingsImported(new Set());
    expect(
      warn.mock.calls.filter((call) => call[1] === "settings_environment_import_failed"),
    ).toHaveLength(1);
    warn.mockRestore();
  });

  it("reports nothing unstored once the values are in the table", async () => {
    await loadSettingsSnapshot();

    const resolution = await loadSettingsResolution();

    expect(migratedVariablesUnstored(resolution)).toEqual([]);
    // The to-do list is not empty: the variables are still set, they are just
    // safe to remove now.
    expect(migratedVariablesSet().length).toBeGreaterThan(0);
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
