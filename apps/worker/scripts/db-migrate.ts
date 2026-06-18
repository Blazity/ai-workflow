/**
 * Build-time migration runner + environment-isolation guard.
 *
 * Runs as part of `pnpm build` on Vercel, where the Neon Marketplace
 * integration injects DATABASE_URL per environment (branch-per-env).
 * Keeps deployment one-click: every deploy is schema-self-healing.
 *
 * Guard: the env_marker row pins this database branch to one VERCEL_ENV.
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

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[db-migrate] DATABASE_URL not set — skipping migrations.");
  process.exit(0);
}

execSync("pnpm exec drizzle-kit migrate", { stdio: "inherit" });

const sql = neon(url);
const vercelEnv = process.env.VERCEL_ENV ?? "development";
// Normalize: strip Neon's -pooler suffix and any port so pooled vs direct
// URLs for the same branch compare equal (a host mismatch takes the
// permissive re-claim path, which must mean a genuinely different endpoint).
const host = new URL(url).hostname.toLowerCase().replace(/-pooler(?=\.)/, "");

await sql`
  INSERT INTO env_marker (id, env, endpoint_host)
  VALUES (1, ${vercelEnv}, ${host})
  ON CONFLICT (id) DO NOTHING
`;
const rows = await sql`SELECT env, endpoint_host FROM env_marker WHERE id = 1`;
const marker = rows[0] as { env: string; endpoint_host: string };

if (marker.endpoint_host !== host) {
  console.warn(
    `[db-migrate] branch copied from '${marker.env}' (${marker.endpoint_host}) — re-claiming for '${vercelEnv}'.`,
  );
  await sql`UPDATE env_marker SET env = ${vercelEnv}, endpoint_host = ${host} WHERE id = 1`;
} else if (marker.env !== vercelEnv) {
  console.error(
    `[db-migrate] FATAL: this Neon branch is already claimed by VERCEL_ENV='${marker.env}', ` +
      `but this build is VERCEL_ENV='${vercelEnv}'. Environments must not share a branch — ` +
      `enable branch-per-environment in the Neon Vercel integration (see SETUP.md §4).`,
  );
  process.exitCode = 1;
} else {
  console.log(`[db-migrate] OK — branch claimed by '${vercelEnv}'.`);
}
