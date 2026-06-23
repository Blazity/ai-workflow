/**
 * Build-time admin seeder. Runs after `db:migrate` in `pnpm build`, where
 * Vercel injects the env. Idempotent (see seedAuthUser). Locally, with env
 * missing, it warn-and-skips so `pnpm build` still works without secrets.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const {
  DATABASE_URL,
  BETTER_AUTH_SECRET,
  BETTER_AUTH_URL,
  DASHBOARD_ORIGIN,
  DASHBOARD_AUTH_EMAIL,
  DASHBOARD_AUTH_PASSWORD,
} = process.env;

if (
  !DATABASE_URL ||
  !BETTER_AUTH_SECRET ||
  !DASHBOARD_AUTH_EMAIL ||
  !DASHBOARD_AUTH_PASSWORD
) {
  console.warn("[seed-auth-user] missing env — skipping.");
  process.exit(0);
}

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const schema = await import("../src/db/schema.js");
const { createAuth, seedAuthUser } = await import("../src/auth.js");

const db = drizzle({ client: neon(DATABASE_URL), schema }) as unknown as Parameters<
  typeof createAuth
>[0];

const auth = createAuth(db, {
  secret: BETTER_AUTH_SECRET,
  baseURL: BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: DASHBOARD_ORIGIN ? [DASHBOARD_ORIGIN] : [],
});

const r = await seedAuthUser(auth, {
  email: DASHBOARD_AUTH_EMAIL,
  password: DASHBOARD_AUTH_PASSWORD,
});
console.log(
  `[seed-auth-user] ${r.created ? "created" : r.updated ? "updated password" : "unchanged"}.`,
);
