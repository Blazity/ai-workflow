import { describe, expect, it } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import { writeManySettings } from "../../db/repositories/settings.js";
import { loadSeedAuthOrganizationName } from "./seed-auth-settings.js";

describe("auth seed settings", () => {
  it("uses the registry default only until an organization name is stored", async () => {
    const db = await createTestDb();

    await expect(loadSeedAuthOrganizationName(db)).resolves.toBe("AI Workflow");
    await writeManySettings(db, {
      patch: { DASHBOARD_ORG_NAME: "Acme Engineering" },
      actor: "test",
      reason: "organization fixture",
    });
    await expect(loadSeedAuthOrganizationName(db)).resolves.toBe(
      "Acme Engineering",
    );
  });
});
