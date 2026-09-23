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

    const { versions } = await writeManySettings(db, {
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
    const { versions } = await writeManySettings(db, {
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

    const { versions } = await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 5, COLUMN_AI: "Agent" },
      actor: "user_admin",
      reason: "second",
    });

    expect(versions.map((row) => row.key)).toEqual(["COLUMN_AI"]);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(3);
  });

  it("stores a cleared optional setting as a row rather than dropping it", async () => {
    const db = await createTestDb();
    const { versions } = await writeManySettings(db, {
      patch: { V2_MAX_BLOCK_CONCURRENCY: null },
      actor: "user_admin",
      reason: "back to the harness default",
    });

    expect(versions).toHaveLength(1);
    expect(versions[0]?.newValue).toBeNull();
    const rows = await readAllSettings(db);
    expect(rows).toEqual([
      expect.objectContaining({ key: "V2_MAX_BLOCK_CONCURRENCY", value: null }),
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
    ).resolves.toEqual({ versions: [], stale: [] });
    await expect(db.select().from(settings)).resolves.toHaveLength(0);
  });

  it("refuses a whole patch when one key moved on since the caller read it", async () => {
    // Two tabs read COLUMN_AI at no version. Tab A stores first; tab B, still
    // holding version 0, must not overwrite A silently, and must not write its
    // unrelated key either: half a patch is a state nobody asked for.
    const db = await createTestDb();
    const first = await writeManySettings(db, {
      patch: { COLUMN_AI: "QA-A" },
      actor: "user_a",
      reason: "tab A",
      expectedVersions: { COLUMN_AI: 0 },
    });
    expect(first.stale).toEqual([]);
    const winner = first.versions[0]!.id;

    const writes = countWrites(db);
    const second = await writeManySettings(db, {
      patch: { COLUMN_AI: "QA-B", MAX_CONCURRENT_AGENTS: 5 },
      actor: "user_b",
      reason: "tab B",
      expectedVersions: { COLUMN_AI: 0, MAX_CONCURRENT_AGENTS: 0 },
    });
    // Still one statement: the guard travels with the write.
    expect(writes.execute).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();

    expect(second).toEqual({
      versions: [],
      stale: [{ key: "COLUMN_AI", currentVersion: winner }],
    });
    expect(await readAllSettings(db)).toEqual([
      expect.objectContaining({ key: "COLUMN_AI", value: "QA-A", updatedBy: "user_a" }),
    ]);
    await expect(db.select().from(settingsVersions)).resolves.toHaveLength(1);
  });

  it("writes when the caller saw the newest version, and when it names none", async () => {
    const db = await createTestDb();
    const first = await writeManySettings(db, {
      patch: { COLUMN_AI: "QA-A" },
      actor: "user_a",
      reason: "tab A",
    });
    const current = first.versions[0]!.id;

    const fresh = await writeManySettings(db, {
      patch: { COLUMN_AI: "QA-B" },
      actor: "user_b",
      reason: "reloaded first",
      expectedVersions: { COLUMN_AI: current },
    });
    expect(fresh.stale).toEqual([]);
    expect(fresh.versions.map((row) => row.newValue)).toEqual(["QA-B"]);

    // No token at all is today's behaviour: the last write wins.
    const blind = await writeManySettings(db, {
      patch: { COLUMN_AI: "QA-C" },
      actor: "user_c",
      reason: "old client",
    });
    expect(blind.stale).toEqual([]);
    expect(blind.versions.map((row) => row.newValue)).toEqual(["QA-C"]);
  });

  it("does not call it a conflict when the other tab already stored the same value", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: { COLUMN_AI: "Agent" },
      actor: "user_a",
      reason: "tab A",
      expectedVersions: { COLUMN_AI: 0 },
    });
    const second = await writeManySettings(db, {
      patch: { COLUMN_AI: "Agent" },
      actor: "user_b",
      reason: "tab B",
      expectedVersions: { COLUMN_AI: 0 },
    });
    expect(second).toEqual({ versions: [], stale: [] });
  });
});
