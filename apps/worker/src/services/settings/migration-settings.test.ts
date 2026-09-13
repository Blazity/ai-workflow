import { describe, expect, it } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import { writeManySettings } from "../../db/repositories/settings.js";
import { loadMigrationSettings } from "./migration-settings.js";

describe("migration settings", () => {
  it("reads stored template settings and defaults only the missing row", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: {
        AGENT_KIND: "codex",
        ENABLE_REVIEW_PHASE: true,
      },
      actor: "test",
      reason: "migration fixture",
    });

    await expect(loadMigrationSettings(db)).resolves.toEqual({
      AGENT_KIND: "codex",
      ENABLE_REVIEW_PHASE: true,
      ENABLE_LEAK_REVIEW: false,
    });
  });
});
