import { describe, expect, it, vi } from "vitest";
import type { Db } from "../client.js";
import { settings, settingsVersions } from "../schema.js";
import { createTestDb } from "../test-db.js";
import {
  latestSettingsVersions,
  listSettingsVersions,
  readAllSettings,
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

  it("writes nothing when the patch is empty", async () => {
    const db = await createTestDb();
    await expect(
      writeManySettings(db, { patch: {}, actor: "user_admin", reason: "nothing" }),
    ).resolves.toEqual([]);
    await expect(db.select().from(settings)).resolves.toHaveLength(0);
  });
});
