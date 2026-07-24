import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/test-db.js";
import {
  harnessProfiles,
  harnessProfileVersions,
  organization,
  user,
} from "../db/schema.js";
import {
  ensureMigratedHarnessProfiles,
  planMigratedHarnessProfile,
} from "./v2-migration-harness-profiles.js";

describe("v2 migration Harness Profiles", () => {
  it("plans a deterministic exact-model profile", () => {
    const first = planMigratedHarnessProfile({
      organizationId: "org-a",
      provider: "codex",
      modelId: "gpt-custom",
    });
    const repeated = planMigratedHarnessProfile({
      organizationId: "org-a",
      provider: "codex",
      modelId: "gpt-custom",
    });
    const differentModel = planMigratedHarnessProfile({
      organizationId: "org-a",
      provider: "codex",
      modelId: "gpt-other",
    });

    expect(repeated).toEqual(first);
    expect(first.reference).toMatchObject({ version: 1 });
    expect(first.manifest).toMatchObject({
      system: false,
      harness: { provider: "codex" },
      model: { id: "gpt-custom" },
    });
    expect(differentModel.reference.profileId).not.toBe(
      first.reference.profileId,
    );
  });

  it("creates or reuses the same immutable profile idempotently", async () => {
    const db = await createTestDb();
    await db
      .insert(organization)
      .values({ id: "org-a", name: "Org A", slug: "org-a" });
    await db.insert(user).values({
      id: "admin",
      name: "Admin",
      email: "admin@example.com",
      emailVerified: true,
    });
    const plan = planMigratedHarnessProfile({
      organizationId: "org-a",
      provider: "codex",
      modelId: "gpt-custom",
    });
    const input = {
      plans: [plan],
      actor: {
        organizationId: "org-a",
        role: "admin" as const,
        id: "admin",
      },
    };

    await ensureMigratedHarnessProfiles(db, input);
    await ensureMigratedHarnessProfiles(db, input);

    expect(
      await db
        .select()
        .from(harnessProfiles)
        .where(eq(harnessProfiles.id, plan.reference.profileId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(harnessProfileVersions)
        .where(
          eq(
            harnessProfileVersions.profileId,
            plan.reference.profileId,
          ),
        ),
    ).toHaveLength(1);
  });
});
