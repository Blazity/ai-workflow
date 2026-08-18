/**
 * Build-time admin seeder. Runs after `db:migrate` in `pnpm build`, where
 * Vercel injects the env. Idempotent (see seedAuthUser). Missing required env
 * fails closed outside local development so deployments cannot silently build
 * without a usable dashboard owner.
 */
import { config } from "dotenv";
import { resolveSeedAuthEnv } from "../src/lib/auth/seed-auth-env.js";

config({ path: [".env.local", ".env"], quiet: true });

const { values, missingRequiredEnv } = resolveSeedAuthEnv(process.env);
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
} = values;

if (missingRequiredEnv.length > 0) {
  const message = `[seed-auth-user] missing required env: ${missingRequiredEnv.join(", ")}`;
  const allowLocalSkip =
    process.env.AI_WORKFLOW_ALLOW_MISSING_AUTH_SEED === "1" ||
    (!process.env.CI && !process.env.VERCEL && process.env.NODE_ENV !== "production");
  if (allowLocalSkip) {
    console.warn(`${message} — skipping local bootstrap.`);
    process.exit(0);
  }
  throw new Error(message);
}

const ssoKeys = [SSO_ISSUER, SSO_ALLOWED_DOMAIN, SSO_CLIENT_ID, SSO_CLIENT_SECRET];
if (ssoKeys.some(Boolean) && !ssoKeys.every(Boolean)) {
  throw new Error(
    "[seed-auth-user] SSO_ISSUER, SSO_ALLOWED_DOMAIN, SSO_CLIENT_ID, and SSO_CLIENT_SECRET must be set together.",
  );
}

// pg is CommonJS whose module.exports is a constructed instance, so Pool is
// only reachable via the default export, not as a named binding.
const { default: pg } = await import("pg");
const { drizzle } = await import("drizzle-orm/node-postgres");
const schema = await import("../src/db/schema.js");
const { bootstrapDashboardAuth, createAuth } = await import("../src/auth.js");

// TLS matches the runtime client (src/db/client.ts): Neon and Railway both
// require it; the explicit ssl object wins over the URL's sslmode and
// rejectUnauthorized:true verifies the server cert against node's built-in CA
// bundle (Neon chains to public roots). Single connection — this seeder makes
// one short burst of writes.
const pool = new pg.Pool({
  connectionString: DATABASE_URL!,
  ssl: { rejectUnauthorized: true },
  max: 1,
});
const db = drizzle({ client: pool, schema }) as unknown as Parameters<
  typeof createAuth
>[0];

const auth = createAuth(db, {
  secret: BETTER_AUTH_SECRET!,
  baseURL: BETTER_AUTH_URL!,
  trustedOrigins: DASHBOARD_ORIGIN ? [DASHBOARD_ORIGIN] : [],
});

const r = await bootstrapDashboardAuth(auth, db, {
  owner: {
    email: DASHBOARD_AUTH_EMAIL!.toLowerCase(),
    password: DASHBOARD_AUTH_PASSWORD!,
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

// Close the pool so the process exits (a node-postgres Pool keeps the event
// loop alive; the old fetch-based neon client did not).
await pool.end();
