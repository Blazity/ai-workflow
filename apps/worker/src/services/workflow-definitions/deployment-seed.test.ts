import { beforeEach, describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { defaultBuiltinHarnessProfile } from "@shared/harness";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { harnessProfiles, workflowDefinitions } from "../../db/schema.js";
import { getCurrentSystemHarnessProfileReference } from "../../db/repositories/harness-profiles.js";
import { seedDeploymentDefaults } from "./deployment-seed.js";

const provider = defaultBuiltinHarnessProfile().harness.provider;

/**
 * `createTestDb` applies the committed migrations and nothing else, which is
 * the state `db:migrate` hands its seeding step on a database nobody has
 * served yet: the state that used to end the migration with
 * "builtin-codex has no published version".
 */
describe("the deployment seed on a database that has only been migrated", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("starts from a schema no migration has put a harness profile into", async () => {
    const [profiles] = await db.select({ value: count() }).from(harnessProfiles);
    expect(profiles?.value).toBe(0);
    await expect(getCurrentSystemHarnessProfileReference(db, provider)).rejects.toThrow(
      /has no published version/,
    );
  });

  it("publishes a system harness profile before the templates that pin it", async () => {
    const [before] = await db.select({ value: count() }).from(workflowDefinitions);

    await seedDeploymentDefaults(db);

    const reference = await getCurrentSystemHarnessProfileReference(db, provider);
    expect(reference.version).toBeGreaterThan(0);
    const [after] = await db.select({ value: count() }).from(workflowDefinitions);
    expect(after?.value).toBeGreaterThan(before?.value ?? 0);
  });

  it("is safe to apply again, the way every redeploy applies it", async () => {
    await seedDeploymentDefaults(db);
    const [once] = await db.select({ value: count() }).from(workflowDefinitions);

    await seedDeploymentDefaults(db);

    const [twice] = await db.select({ value: count() }).from(workflowDefinitions);
    expect(twice?.value).toBe(once?.value);
  });
});
