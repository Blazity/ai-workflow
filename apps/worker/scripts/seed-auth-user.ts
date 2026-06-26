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
  DASHBOARD_ORG_NAME,
  DASHBOARD_ORG_SLUG,
  SSO_ISSUER,
  SSO_ALLOWED_DOMAIN,
  SSO_CLIENT_ID,
  SSO_CLIENT_SECRET,
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

const ssoKeys = [SSO_ISSUER, SSO_ALLOWED_DOMAIN, SSO_CLIENT_ID, SSO_CLIENT_SECRET];
if (ssoKeys.some(Boolean) && !ssoKeys.every(Boolean)) {
  throw new Error(
    "[seed-auth-user] SSO_ISSUER, SSO_ALLOWED_DOMAIN, SSO_CLIENT_ID, and SSO_CLIENT_SECRET must be set together.",
  );
}

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const schema = await import("../src/db/schema.js");
const { bootstrapDashboardAuth, createAuth } = await import("../src/auth.js");

const db = drizzle({ client: neon(DATABASE_URL), schema }) as unknown as Parameters<
  typeof createAuth
>[0];

const auth = createAuth(db, {
  secret: BETTER_AUTH_SECRET,
  baseURL: BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: DASHBOARD_ORIGIN ? [DASHBOARD_ORIGIN] : [],
});

const r = await bootstrapDashboardAuth(auth, db, {
  owner: {
    email: DASHBOARD_AUTH_EMAIL,
    password: DASHBOARD_AUTH_PASSWORD,
  },
  organization: {
    name: DASHBOARD_ORG_NAME ?? "AI Workflow",
    slug: DASHBOARD_ORG_SLUG ?? "ai-workflow",
  },
  sso:
    SSO_ISSUER && SSO_ALLOWED_DOMAIN && SSO_CLIENT_ID && SSO_CLIENT_SECRET
      ? {
          issuer: SSO_ISSUER,
          allowedDomain: SSO_ALLOWED_DOMAIN,
          clientId: SSO_CLIENT_ID,
          clientSecret: SSO_CLIENT_SECRET,
        }
      : undefined,
});
console.log(
  [
    `[seed-auth-user] owner ${r.user.created ? "created" : r.user.updated ? "updated password" : "unchanged"}`,
    `organization ${r.organization.created ? "created" : "ready"}`,
    `owner membership ${
      r.membership.created ? "created" : r.membership.updated ? "repaired" : "ready"
    }`,
    `sso ${
      r.ssoProvider
        ? r.ssoProvider.created
          ? "created"
          : r.ssoProvider.updated
            ? "updated"
            : "ready"
        : "not configured"
    }`,
  ].join("; ") + ".",
);
