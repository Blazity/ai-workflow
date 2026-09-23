import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../client.js";
import { createTestDb } from "../test-db.js";
import {
  disconnectIntegration,
  readIntegrationAudit,
  readIntegrationConnections,
  recordIntegrationTest,
  saveIntegrationVersion,
  saveIntegrationVersionStatement,
  setIntegrationEnabled,
  setIntegrationSource,
} from "./integrations.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const PASSED = {
  status: "passed",
  reason: null,
  message: null,
  fingerprint: "fp-1",
} as const;

const FAILED = {
  status: "failed",
  reason: "credential_rejected",
  message: "401 Unauthorized",
  fingerprint: "fp-2",
} as const;

function save(overrides: Partial<Parameters<typeof saveIntegrationVersion>[1]> = {}) {
  return saveIntegrationVersion(db, {
    integrationId: "fixture",
    expectedVersion: 0,
    config: { baseUrl: "https://fixture.example/site" },
    secrets: { apiToken: "v1:aaaaaaaa:fixture.apiToken:iv:tag:body" },
    secretDigests: { apiToken: "digest-one" },
    takeOverSource: false,
    test: PASSED,
    actorId: "user-1",
    ...overrides,
  });
}

describe("a deployment nobody ever configured from the dashboard", () => {
  it("has no row at all, so nothing has to be migrated for it", async () => {
    expect(await readIntegrationConnections(db)).toEqual(new Map());
  });
});

describe("saving stored values", () => {
  it("mints the first version and makes it the one in use when its test passed", async () => {
    expect(await save()).toEqual({ conflict: false, version: 1, activated: true });
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.latestVersion).toBe(1);
    expect(stored?.activeVersion).toBe(1);
    expect(stored?.active?.config).toEqual({ baseUrl: "https://fixture.example/site" });
  });

  it("leaves the source alone, so preparing values does not switch anything (INT-053)", async () => {
    await save();
    expect((await readIntegrationConnections(db)).get("fixture")?.source).toBe("environment");
  });

  it("makes stored the source in the same statement when the caller says to", async () => {
    // One statement, not two. An invocation killed between a save and a
    // follow-up switch would leave stored values active, the source on
    // environment, and a card reading Not connected after a green test.
    await save({ takeOverSource: true });
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.source).toBe("stored");
    expect(stored?.activeVersion).toBe(1);
  });

  it("does not take the source over when the version did not activate", async () => {
    await save({ takeOverSource: true, test: FAILED });
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.source).toBe("environment");
    expect(stored?.activeVersion).toBeNull();
  });

  it("keeps the markers the resolver compares, beside the ciphertexts", async () => {
    await save();
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.active?.secretDigests).toEqual({ apiToken: "digest-one" });
  });

  it("remembers a save whose test failed without putting it in use (INT-051, INT-018)", async () => {
    await save();
    const second = await save({
      expectedVersion: 1,
      config: { baseUrl: "https://fixture.example/typo" },
      test: FAILED,
    });
    expect(second).toEqual({ conflict: false, version: 2, activated: false });
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.activeVersion).toBe(1);
    expect(stored?.latestVersion).toBe(2);
    expect(stored?.active?.config).toEqual({ baseUrl: "https://fixture.example/site" });
    expect(stored?.latest?.testMessage).toBe("401 Unauthorized");
  });

  it("never puts values the provider refused into use, so an outage cannot take a deployment down", async () => {
    const result = await save({ test: FAILED });
    expect(result).toEqual({ conflict: false, version: 1, activated: false });
    expect((await readIntegrationConnections(db)).get("fixture")?.activeVersion).toBeNull();
  });

  it("refuses a save whose expected version moved, naming the current one (INT-017)", async () => {
    await save();
    expect(await save({ expectedVersion: 0 })).toEqual({ conflict: true, currentVersion: 1 });
    expect((await readIntegrationConnections(db)).get("fixture")?.latestVersion).toBe(1);
  });

  it("lets the database, not the snapshot, be the last word on a version number", async () => {
    // The concurrency predicate on the UPDATE cannot be exercised through a
    // single-connection driver: two statements here serialise. The unique index
    // is the backstop that a real race meets, so this plants the state a lost
    // race produces and shows the write refusing rather than overwriting.
    await save();
    await db.execute(
      "insert into integration_connection_versions (integration_id, version, test_status) values ('fixture', 2, 'passed')",
    );
    await expect(save({ expectedVersion: 1 })).rejects.toThrow();
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.latestVersion).toBe(1);
  });

  it("gives two saves racing on a fresh integration one version, not two (INT-016)", async () => {
    const [a, b] = await Promise.all([save(), save()]);
    const outcomes = [a, b].filter((r) => r.conflict === false);
    expect(outcomes).toHaveLength(1);
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.latestVersion).toBe(1);
    expect(await readIntegrationAudit(db, "fixture")).toHaveLength(1);
  });
});

describe("the disable switch", () => {
  it("keeps the stored values so re-enabling finds them (INT-046)", async () => {
    await save();
    await setIntegrationEnabled(db, { integrationId: "fixture", enabled: false, actorId: "u" });
    const off = (await readIntegrationConnections(db)).get("fixture");
    expect(off?.enabled).toBe(false);
    expect(off?.activeVersion).toBe(1);

    await setIntegrationEnabled(db, { integrationId: "fixture", enabled: true, actorId: "u" });
    const on = (await readIntegrationConnections(db)).get("fixture");
    expect(on?.enabled).toBe(true);
    expect(on?.active?.config).toEqual({ baseUrl: "https://fixture.example/site" });
  });

  it("works for an integration that was never saved from the dashboard (INT-043)", async () => {
    await setIntegrationEnabled(db, { integrationId: "jira", enabled: false, actorId: "u" });
    const stored = (await readIntegrationConnections(db)).get("jira");
    expect(stored?.enabled).toBe(false);
    expect(stored?.source).toBe("environment");
    expect(stored?.latestVersion).toBe(0);
  });

  it("mints no version, so a run in flight sees no reconfiguration", async () => {
    await save();
    await setIntegrationEnabled(db, { integrationId: "fixture", enabled: false, actorId: "u" });
    expect(await readIntegrationAudit(db, "fixture")).toHaveLength(1);
  });
});

describe("recording what the provider said about the live configuration", () => {
  it("keeps the verdict next to the values it was about, for either source", async () => {
    await recordIntegrationTest(db, {
      integrationId: "jira",
      status: "failed",
      reason: "credential_rejected",
      message: "401 Unauthorized",
      fingerprint: "fp-live",
      actorId: "u",
    });
    const stored = (await readIntegrationConnections(db)).get("jira");
    expect(stored?.lastTest).toMatchObject({
      status: "failed",
      reason: "credential_rejected",
      message: "401 Unauthorized",
      fingerprint: "fp-live",
    });
    // Recording a verdict is not a version: nothing an admin stored changed.
    expect(stored?.latestVersion).toBe(0);
  });

  it("replaces the previous verdict rather than stacking them up", async () => {
    await recordIntegrationTest(db, {
      integrationId: "jira", status: "failed", reason: "credential_rejected",
      message: "401", fingerprint: "fp-1", actorId: "u",
    });
    await recordIntegrationTest(db, {
      integrationId: "jira", status: "passed", reason: null,
      message: null, fingerprint: "fp-2", actorId: "u",
    });
    const stored = (await readIntegrationConnections(db)).get("jira");
    expect(stored?.lastTest?.status).toBe("passed");
    expect(stored?.lastTest?.fingerprint).toBe("fp-2");
  });
});

describe("a save that activates after a failed test", () => {
  // The verdict is one fact. A passing save carries no reason and no message,
  // and the update kept the previous ones whenever the new value was null, so
  // the card read "passed" beside the words of the failure it replaced.
  it("clears the failure's reason and message rather than keeping them beside a pass", async () => {
    await save();
    await recordIntegrationTest(db, {
      integrationId: "fixture",
      status: "failed",
      reason: "credential_rejected",
      message: "401 Unauthorized",
      fingerprint: "fp-live",
      actorId: "u",
    });

    await save({ expectedVersion: 1, test: PASSED });

    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.lastTest).toMatchObject({
      status: "passed",
      reason: null,
      message: null,
      fingerprint: "fp-1",
    });
  });
});

describe("switching the source", () => {
  it("is one action that changes no value (INT-054)", async () => {
    await save();
    await setIntegrationSource(db, { integrationId: "fixture", source: "stored", actorId: "u" });
    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.source).toBe("stored");
    expect(stored?.active?.config).toEqual({ baseUrl: "https://fixture.example/site" });
  });
});

describe("disconnecting (INT-070)", () => {
  it("empties the values and every secret in every past version", async () => {
    await save();
    await save({ expectedVersion: 1, config: { baseUrl: "https://fixture.example/two" } });
    await setIntegrationSource(db, { integrationId: "fixture", source: "stored", actorId: "u" });

    await disconnectIntegration(db, { integrationId: "fixture", actorId: "u" });

    const stored = (await readIntegrationConnections(db)).get("fixture");
    expect(stored?.source).toBe("environment");
    expect(stored?.activeVersion).toBeNull();
    expect(stored?.lastTest).toBeNull();

    const raw0 = await db.execute(
      "select secret_digests::text as digests from integration_connection_versions",
    );
    for (const row of (raw0 as { rows?: { digests: string }[] }).rows ?? []) {
      expect(row.digests).toBe("{}");
    }

    const versions = await readIntegrationAudit(db, "fixture");
    expect(versions).toHaveLength(2);
    for (const version of versions) {
      expect(version.redactedAt).not.toBeNull();
    }
    const raw = await db.execute(
      // The audit is what an admin reads; this looks past it at the columns
      // themselves, because "no secret survives a disconnect" is about the bytes.
      "select config::text as config, secrets::text as secrets from integration_connection_versions",
    );
    for (const row of (raw as { rows?: { config: string; secrets: string }[] }).rows ?? []) {
      expect(row.config).toBe("{}");
      expect(row.secrets).toBe("{}");
    }
  });

  it("keeps who saved each version and when", async () => {
    await save();
    await disconnectIntegration(db, { integrationId: "fixture", actorId: "u" });
    const [entry] = await readIntegrationAudit(db, "fixture");
    expect(entry?.actorId).toBe("user-1");
    expect(entry?.testStatus).toBe("passed");
  });
});

describe("the statement a save is", () => {
  /**
   * The one thing about this write that no test with a database can observe.
   *
   * A lost update needs two connections committing against each other, and every
   * driver in this repository serialises: pglite has one connection, and the
   * production driver is HTTP. So the guard reads the SQL instead. It is here
   * because dropping the predicate is silent: the loser of the race writes
   * version N+2, activates it, and nothing errors. Removing
   * `AND latest_version = <expected>` from the UPDATE turns this red.
   */
  it("re-states the version it read as a qualifier on the row it writes", () => {
    const { sql: text } = new PgDialect().sqlToQuery(
      saveIntegrationVersionStatement({
        integrationId: "fixture",
        expectedVersion: 4,
        config: {},
        secrets: {},
        secretDigests: {},
        takeOverSource: false,
        test: PASSED,
        actorId: null,
      }),
    );
    const update = text.slice(text.indexOf("), updated AS ("), text.indexOf("), target AS ("));
    expect(update).toContain("UPDATE");
    // The qualifier, against the row being written, not against the snapshot.
    expect(update).toMatch(/WHERE[\s\S]*latest_version\s*=\s*\$\d+/);
  });
});
