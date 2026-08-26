import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import type { PrePrCheckConfig } from "./config.js";
import {
  getCurrentPrePrCheckConfig,
  listPrePrCheckConfigVersions,
  restorePrePrCheckConfig,
  savePrePrCheckConfig,
} from "./store.js";

const CONFIG_A: PrePrCheckConfig = {
  repositories: [{ provider: "github", repoPath: "acme/web", commands: ["pnpm test"] }],
};
const CONFIG_B: PrePrCheckConfig = {
  repositories: [{ provider: "gitlab", repoPath: "acme/api", commands: ["bun test"] }],
};
const CONFIG_WITH_SETUP: PrePrCheckConfig = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/service",
      setup: ["make bootstrap", "make deps"],
      commands: ["make lint"],
    },
  ],
};
/** New-shape entry, authored with its groups out of order. Typed through the
 *  legacy interface the store still declares, exactly as a stored new-shape
 *  config reaches it. */
const CONFIG_WITH_GROUPS = {
  repositories: [
    {
      provider: "github",
      repoPath: "acme/web",
      groups: {
        zeta: { commands: ["pnpm zeta"], restoreTree: true },
        alpha: { commands: ["pnpm alpha"], restoreTree: true },
      },
    },
  ],
} as unknown as PrePrCheckConfig;
const ACTOR = { actorRole: "admin" as const, actorId: "user_admin", actorLabel: "admin@example.com" };

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("pre-PR check config store", () => {
  it("returns null/empty when no config was ever saved", async () => {
    expect(await getCurrentPrePrCheckConfig(db)).toBeNull();
    expect(await listPrePrCheckConfigVersions(db)).toEqual([]);
  });

  it("appends versions and returns the latest as current", async () => {
    const v1 = await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_A });
    const v2 = await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_B });
    expect(v1.version).toBeLessThan(v2.version);

    const current = await getCurrentPrePrCheckConfig(db);
    expect(current?.version).toBe(v2.version);
    expect(current?.config).toEqual(CONFIG_B);
    expect(current?.createdByLabel).toBe("admin@example.com");

    const versions = await listPrePrCheckConfigVersions(db);
    expect(versions.map((v) => v.version)).toEqual([v2.version, v1.version]);
  });

  it("round-trips a repository setup phase", async () => {
    const saved = await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_WITH_SETUP });
    expect(saved.config).toEqual(CONFIG_WITH_SETUP);
    expect((await getCurrentPrePrCheckConfig(db))?.config).toEqual(CONFIG_WITH_SETUP);
  });

  it("keeps a config saved without a setup key readable as-is", async () => {
    await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_A });
    const current = await getCurrentPrePrCheckConfig(db);
    expect(current?.config).toEqual(CONFIG_A);
    expect(current?.config.repositories[0]!.setup).toBeUndefined();
  });

  it("reads groups back in code-point order, on both the current config and the listing", async () => {
    // jsonb reorders object keys (by length, then alphabetically), so the order
    // a config comes back in is not the order it was saved in. The editor
    // compares versions[0].config with the config on screen to decide whether
    // there are unsaved changes, so a listing that is not canonical shows a
    // freshly loaded screen as dirty.
    await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_WITH_GROUPS });

    const current = await getCurrentPrePrCheckConfig(db);
    const [latest] = await listPrePrCheckConfigVersions(db);
    const groupsOf = (row: typeof current) =>
      Object.keys(
        (row?.config.repositories[0] as { groups?: Record<string, unknown> } | undefined)
          ?.groups ?? {},
      );

    expect(groupsOf(current)).toEqual(["alpha", "zeta"]);
    expect(groupsOf(latest)).toEqual(["alpha", "zeta"]);
  });

  it("rejects writes from members with 403", async () => {
    await expect(
      savePrePrCheckConfig(db, { ...ACTOR, actorRole: "member", config: CONFIG_A }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("owner can write", async () => {
    const row = await savePrePrCheckConfig(db, { ...ACTOR, actorRole: "owner", config: CONFIG_A });
    expect(row.version).toBeGreaterThan(0);
  });

  it("restore appends a copy with the restored_from marker", async () => {
    const v1 = await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_A });
    await savePrePrCheckConfig(db, { ...ACTOR, config: CONFIG_B });

    const restored = await restorePrePrCheckConfig(db, { ...ACTOR, version: v1.version });
    expect(restored.config).toEqual(CONFIG_A);
    expect(restored.restoredFromVersion).toBe(v1.version);

    const current = await getCurrentPrePrCheckConfig(db);
    expect(current?.version).toBe(restored.version);
  });

  it("restore of an unknown version fails with 404", async () => {
    await expect(restorePrePrCheckConfig(db, { ...ACTOR, version: 999 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
