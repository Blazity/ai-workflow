import { describe, expect, it } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import { writeManySettings } from "../../db/repositories/settings.js";
import { loadMigrationSettings } from "./migration-settings.js";

describe("migration settings", () => {
  it("reads the stored agent kind used by built-in templates", async () => {
    const db = await createTestDb();
    await writeManySettings(db, {
      patch: {
        AGENT_KIND: "codex",
      },
      actor: "test",
      reason: "migration fixture",
    });

    await expect(loadMigrationSettings(db)).resolves.toEqual({
      AGENT_KIND: "codex",
    });
  });
});
