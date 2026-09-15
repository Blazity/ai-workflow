/**
 * Build-time migration runner + environment-isolation guard.
 *
 * Runs as part of `pnpm build` on Vercel, where the Neon Marketplace
 * integration injects DATABASE_URL per environment (branch-per-env).
 * Keeps deployment one-click: every deploy is schema-self-healing.
 *
 * Guard: the env_marker row pins this database branch to one VERCEL_ENV.
 * - DATABASE_SHARED_WITH lets a nonproduction build use its owner's already
 *   claimed branch without changing the marker.
 * - Same endpoint host, different env  → FAIL the build. Preview and
 *   production are sharing a branch; the run registries would collide
 *   (preview claiming production tickets, deleting its Slack threads).
 * - Different endpoint host             → the branch was copied (Neon
 *   branches copy data, marker included) — re-claim it for this env.
 *
 * Locally (no DATABASE_URL) this is a warn-and-skip no-op so `pnpm build`
 * still works without a database.
 */
import { config } from "dotenv";

// Load .env.local (where `vercel env pull` writes) before .env; dotenv never
// overrides vars already set, so real env (Vercel build) always wins.
config({ path: [".env.local", ".env"], quiet: true });

import { execSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { getCurrentSystemHarnessProfileReference } from "../src/db/repositories/harness-profiles.js";
import { assertNoRetiredEnvironmentVariables } from "../src/services/settings/retired-environment.js";
import { seedWorkflowDefinitionTemplates } from "../src/services/workflow-definitions/template-seed.js";
import { defaultBuiltinHarnessProfile } from "@shared/harness";
import { decideMarkerAction } from "../src/db/migrate-marker.js";

assertNoRetiredEnvironmentVariables(process.env);

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[db-migrate] DATABASE_URL not set, skipping migrations.");
  process.exit(0);
}

// The engine canary job skips deployment when a pull request changes drizzle,
// so a shared build never applies an unmerged migration.
execSync("pnpm exec drizzle-kit migrate", { stdio: "inherit" });

const sql = neon(url);
const vercelEnv = process.env.VERCEL_ENV ?? "development";
const sharedWith = process.env.DATABASE_SHARED_WITH;
// Normalize: strip Neon's -pooler suffix and any port so pooled vs direct
// URLs for the same branch compare equal (a host mismatch takes the
// permissive re-claim path, which must mean a genuinely different endpoint).
const host = new URL(url).hostname.toLowerCase().replace(/-pooler(?=\.)/, "");

const readMarker = async () => {
  const rows = await sql`SELECT env, endpoint_host FROM env_marker WHERE id = 1`;
  const row = rows[0] as
    | { env: string; endpoint_host: string }
    | undefined;
  return row
    ? { env: row.env, endpointHost: row.endpoint_host }
    : null;
};

let marker = await readMarker();
let decision = decideMarkerAction({ marker, host, vercelEnv, sharedWith });

if (decision.action === "claim") {
  await sql`
    INSERT INTO env_marker (id, env, endpoint_host)
    VALUES (1, ${vercelEnv}, ${host})
    ON CONFLICT (id) DO NOTHING
  `;
  marker = await readMarker();
  decision = decideMarkerAction({ marker, host, vercelEnv, sharedWith });
}

if (decision.action === "reclaim") {
  console.warn(decision.message);
  await sql`UPDATE env_marker SET env = ${vercelEnv}, endpoint_host = ${host} WHERE id = 1`;
} else if (decision.action === "fatal") {
  console.error(decision.message);
  process.exitCode = 1;
} else if (decision.action === "claim") {
  console.error("[db-migrate] FATAL: failed to claim the database marker.");
  process.exitCode = 1;
} else {
  console.log(decision.message);
}

if (process.exitCode !== 1) {
  const db = drizzle({ client: sql, schema }) as unknown as Db;
  const provider = defaultBuiltinHarnessProfile().harness.provider;
  const profileReference =
    await getCurrentSystemHarnessProfileReference(db, provider);
  console.log("[db-migrate] System harness profiles are ready.");
  await seedWorkflowDefinitionTemplates(db, {
    includeReview: false,
    includeLeakReview: false,
    provider,
    profileReference,
  });
  console.log("[db-migrate] Workflow templates are ready.");
}
