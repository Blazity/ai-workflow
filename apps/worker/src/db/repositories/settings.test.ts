import { describe, expect, it, vi } from "vitest";
import type { Db } from "../client.js";
import { settings, settingsVersions } from "../schema.js";
import { createTestDb } from "../test-db.js";
import {
  importEnvironmentSettings,
  latestSettingsVersions,
  listSettingsVersions,
  readAllSettings,
  seedSettings,
  writeManySettings,
} from "./settings.js";

/**
 * Counts the write surface a call reaches for. Production is neon-http, which
 * cannot open an interactive transaction, so a settings write and its version
 * row have to leave as one statement or a crash between them leaves a changed
 * setting nobody can explain.
 */
function countWrites(db: Db) {
  return {
    execute: vi.spyOn(db, "execute"),
    insert: vi.spyOn(db, "insert"),
    update: vi.spyOn(db, "update"),
    delete: vi.spyOn(db, "delete"),
  };
}

describe("settings repository", () => {
  it("writes the setting rows and their version rows in one statement", async () => {
    const db = await createTestDb();
    const writes = countWrites(db);

    const versions = await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 5, MCP_ENABLED: true },
      actor: "user_admin",
      reason: "raising capacity",
    });

    expect(writes.execute).toHaveBeenCalledTimes(1);
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.delete).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    expect(versions.map((row) => row.key)).toEqual([
      "MAX_CONCURRENT_AGENTS",
      "MCP_ENABLED",
    ]);
    expect(versions[0]).toMatchObject({
      key: "MAX_CONCURRENT_AGENTS",
      previousValue: null,
      newValue: 5,
      actor: "user_admin",
      reason: "raising capacity",
    });
    expect(versions[0]?.createdAt).toBeInstanceOf(Date);

    const rows = await readAllSettings(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.key === "MCP_ENABLED")).toMatchObject({
      value: true,
      updatedBy: "user_admin",
    });
  });

  it("records the previous value when a stored setting changes", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: { COLUMN_AI: "AI" },
      actor: "user_admin",
      reason: "first",
    });
    const versions = await writeManySettings(db, {
      patch: { COLUMN_AI: "Agent" },
      actor: "user_owner",
      reason: "renamed the column",
    });

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      key: "COLUMN_AI",
      previousValue: "AI",
      newValue: "Agent",
      actor: "user_owner",
    });
    const stored = await readAllSettings(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ value: "Agent", updatedBy: "user_owner" });
  });

  it("creates no version row for a second identical write", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 5, COLUMN_AI: "AI" },
      actor: "user_admin",
      reason: "first",
    });

    const versions = await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 5, COLUMN_AI: "Agent" },
      actor: "user_admin",
      reason: "second",
    });

    expect(versions.map((row) => row.key)).toEqual(["COLUMN_AI"]);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(3);
  });

  it("stores a cleared optional setting as a row rather than dropping it", async () => {
    const db = await createTestDb();
    const versions = await writeManySettings(db, {
      patch: { CLAUDE_MODEL: null },
      actor: "user_admin",
      reason: "back to the harness default",
    });

    expect(versions).toHaveLength(1);
    expect(versions[0]?.newValue).toBeNull();
    const rows = await readAllSettings(db);
    expect(rows).toEqual([
      expect.objectContaining({ key: "CLAUDE_MODEL", value: null }),
    ]);
  });

  it("keeps a list setting as a list", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: { PRE_PR_CHECKS_ALLOWED_ENV: ["NPM_TOKEN", "ARTHUR_TOKEN"] },
      actor: "user_admin",
      reason: "forwarding the registry token",
    });
    const rows = await readAllSettings(db);
    expect(rows[0]?.value).toEqual(["NPM_TOKEN", "ARTHUR_TOKEN"]);
  });

  it("lists one key's versions newest first and the newest row per key", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: { COLUMN_AI: "AI", MCP_ENABLED: true },
      actor: "user_admin",
      reason: "first",
    });
    await writeManySettings(db, {
      patch: { COLUMN_AI: "Agent" },
      actor: "user_admin",
      reason: "second",
    });
    await writeManySettings(db, {
      patch: { COLUMN_AI: "Robot" },
      actor: "user_admin",
      reason: "third",
    });

    const history = await listSettingsVersions(db, "COLUMN_AI", 2);
    expect(history.map((row) => row.newValue)).toEqual(["Robot", "Agent"]);

    const latest = await latestSettingsVersions(db);
    expect(
      latest.map((row) => [row.key, row.newValue, row.reason]),
    ).toEqual([
      ["COLUMN_AI", "Robot", "third"],
      ["MCP_ENABLED", true, "first"],
    ]);
  });

  it("seeds one row per given key in one statement and never overwrites", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: { COLUMN_AI: "Agent" },
      actor: "user_admin",
      reason: "operator decided",
    });

    const writes = countWrites(db);
    const seeded = await seedSettings(db, {
      rows: [
        { key: "COLUMN_AI", value: "AI" },
        { key: "MAX_CONCURRENT_AGENTS", value: 4 },
      ],
      actor: "environment",
    });
    expect(writes.execute).toHaveBeenCalledTimes(1);
    expect(writes.insert).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(seeded).toBe(1);

    const again = await seedSettings(db, {
      rows: [
        { key: "COLUMN_AI", value: "AI" },
        { key: "MAX_CONCURRENT_AGENTS", value: 4 },
      ],
      actor: "environment",
    });
    expect(again).toBe(0);

    const rows = await readAllSettings(db);
    expect(rows.map((row) => [row.key, row.value]).sort()).toEqual([
      ["COLUMN_AI", "Agent"],
      ["MAX_CONCURRENT_AGENTS", 4],
    ]);
    // Seeding is not an operator decision, so it records no history.
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(1);
  });

  it("imports every missing value and records one version row each", async () => {
    const db = await createTestDb();
    const writes = countWrites(db);

    const written = await importEnvironmentSettings(db, {
      rows: [
        { key: "MAX_CONCURRENT_AGENTS", value: 7 },
        { key: "MCP_ENABLED", value: true },
        { key: "SLACK_ALLOWED_USER_IDS", value: ["U1", "U2"] },
        { key: "GENAI_ENGINE_TRACE_ENDPOINT", value: null },
      ],
      actor: "environment import",
      reason: "Stored from the deployment environment so the variable can be removed.",
    });

    // One statement for the rows and their history: production is neon-http,
    // which cannot open a transaction, so a crash between the two would leave
    // stored values nobody can explain.
    expect(writes.execute).toHaveBeenCalledTimes(1);
    expect(writes.insert).not.toHaveBeenCalled();
    expect(written.sort()).toEqual([
      "GENAI_ENGINE_TRACE_ENDPOINT",
      "MAX_CONCURRENT_AGENTS",
      "MCP_ENABLED",
      "SLACK_ALLOWED_USER_IDS",
    ]);

    // Every JSON shape the registry holds survives the round trip through
    // jsonb, including a stored null, which is not the same as a missing row.
    const stored = new Map((await readAllSettings(db)).map((row) => [row.key, row.value]));
    expect(stored.get("MAX_CONCURRENT_AGENTS")).toBe(7);
    expect(stored.get("MCP_ENABLED")).toBe(true);
    expect(stored.get("SLACK_ALLOWED_USER_IDS")).toEqual(["U1", "U2"]);
    expect(stored.has("GENAI_ENGINE_TRACE_ENDPOINT")).toBe(true);
    expect(stored.get("GENAI_ENGINE_TRACE_ENDPOINT")).toBeNull();

    const versions = await latestSettingsVersions(db);
    expect(versions).toHaveLength(4);
    expect(versions.every((version) => version.actor === "environment import")).toBe(true);
    expect(versions.every((version) => version.previousValue === null)).toBe(true);
  });

  it("imports nothing twice, and never over a value somebody stored", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 1 },
      actor: "user_admin",
      reason: "throttling",
    });

    const written = await importEnvironmentSettings(db, {
      rows: [
        { key: "MAX_CONCURRENT_AGENTS", value: 7 },
        { key: "MCP_ENABLED", value: true },
      ],
      actor: "environment import",
      reason: "importing",
    });
    const again = await importEnvironmentSettings(db, {
      rows: [
        { key: "MAX_CONCURRENT_AGENTS", value: 7 },
        { key: "MCP_ENABLED", value: true },
      ],
      actor: "environment import",
      reason: "importing",
    });

    // `on conflict do nothing` is what makes this idempotent AND what keeps the
    // operator's decision: 1 stands, no second version pretends otherwise.
    expect(written).toEqual(["MCP_ENABLED"]);
    expect(again).toEqual([]);
    const stored = new Map((await readAllSettings(db)).map((row) => [row.key, row.value]));
    expect(stored.get("MAX_CONCURRENT_AGENTS")).toBe(1);
    const history = await listSettingsVersions(db, "MAX_CONCURRENT_AGENTS", 10);
    expect(history).toHaveLength(1);
    expect(history[0]?.actor).toBe("user_admin");
    expect(await listSettingsVersions(db, "MCP_ENABLED", 10)).toHaveLength(1);
  });

  it("writes nothing when the patch is empty", async () => {
    const db = await createTestDb();
    await expect(
      writeManySettings(db, { patch: {}, actor: "user_admin", reason: "nothing" }),
    ).resolves.toEqual([]);
    await expect(db.select().from(settings)).resolves.toHaveLength(0);
    await expect(
      seedSettings(db, { rows: [], actor: "environment" }),
    ).resolves.toBe(0);
  });
});
