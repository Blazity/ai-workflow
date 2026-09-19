import { defaultBuiltinHarnessProfile } from "@shared/harness";
import type { Db } from "../../db/types.js";
import { getCurrentSystemHarnessProfileReference } from "../../db/repositories/harness-profiles.js";
import { ensureSystemHarnessProfilesOnDb } from "../../harness-profiles/system-seed.js";
import { seedWorkflowDefinitionTemplates } from "./template-seed.js";

/**
 * What a deployment seeds once its schema is in place, in the one order that
 * works on a database nobody has served yet.
 *
 * The starter templates pin the published version of a system harness profile,
 * and no migration writes those profiles: a running worker seeds them the
 * first time it resolves one. Reading the reference first therefore ends
 * `db:migrate` with "builtin-codex has no published version" on every empty
 * database, so a fresh environment could not come up without a hand-run seed.
 */
export async function seedDeploymentDefaults(db: Db): Promise<void> {
  await ensureSystemHarnessProfilesOnDb(db);
  const provider = defaultBuiltinHarnessProfile().harness.provider;
  const profileReference = await getCurrentSystemHarnessProfileReference(db, provider);
  await seedWorkflowDefinitionTemplates(db, {
    includeReview: false,
    includeLeakReview: false,
    provider,
    profileReference,
  });
}
