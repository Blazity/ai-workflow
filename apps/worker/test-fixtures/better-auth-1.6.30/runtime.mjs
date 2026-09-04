import { realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, jwt } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import pg from "pg";

const EXPECTED_NODE = "24.20.0";
const EXPECTED_VERSION = "1.6.30";
const EXPECTED_WORKER_ZOD = "3.25.76";
const EXPECTED_INTERNAL_ZOD = "4.3.6";
const fixtureRoot = realpathSync(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

if (process.versions.node !== EXPECTED_NODE) {
  throw new Error(
    `Better Auth rollback fixture requires Node ${EXPECTED_NODE}; found ${process.versions.node}`,
  );
}

function packageMetadata(specifier, resolver = require) {
  let directory = dirname(realpathSync(resolver.resolve(specifier)));
  while (true) {
    const candidate = join(directory, "package.json");
    try {
      const metadata = JSON.parse(readFileSync(candidate, "utf8"));
      if (metadata.name === specifier) {
        return {
          packageJsonPath: realpathSync(candidate),
          version: metadata.version,
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate package metadata for ${specifier}`);
    }
    directory = parent;
  }
}

function assertInsideFixture(path, label) {
  const pathFromFixture = relative(fixtureRoot, path);
  if (
    pathFromFixture === "" ||
    pathFromFixture === ".." ||
    pathFromFixture.startsWith(`..${sep}`) ||
    pathFromFixture.startsWith("/")
  ) {
    throw new Error(`${label} resolved outside the isolated fixture`);
  }
}

function assertResolvedVersion(resolver, specifier, expected, label) {
  const metadata = packageMetadata(specifier, resolver);
  if (metadata.version !== expected) {
    throw new Error(
      `${label} resolved ${specifier}@${metadata.version}, expected ${expected}`,
    );
  }
  assertInsideFixture(metadata.packageJsonPath, `${label} ${specifier}`);
  return metadata;
}

function dependencyResolver(resolver, specifier) {
  return createRequire(resolver.resolve(specifier));
}

function assertBetterCallUsesWorkerZod(resolver, label) {
  const betterCallRequire = dependencyResolver(resolver, "better-call");
  assertResolvedVersion(
    betterCallRequire,
    "zod",
    EXPECTED_WORKER_ZOD,
    `${label} better-call`,
  );
}

function assertRuntimeVersions() {
  const directVersions = {
    "@better-auth/core": EXPECTED_VERSION,
    "@better-auth/oauth-provider": EXPECTED_VERSION,
    "@opentelemetry/api": "1.9.0",
    "better-auth": EXPECTED_VERSION,
    "drizzle-orm": "0.45.2",
    jose: "6.2.3",
    kysely: "0.29.2",
    nanostores: "1.3.0",
    pg: "8.20.0",
    zod: EXPECTED_WORKER_ZOD,
  };
  for (const [specifier, version] of Object.entries(directVersions)) {
    assertResolvedVersion(require, specifier, version, "direct fixture");
  }

  const providerRequire = dependencyResolver(
    require,
    "@better-auth/oauth-provider",
  );
  for (const [specifier, version] of Object.entries({
    "@better-auth/core": EXPECTED_VERSION,
    "better-auth": EXPECTED_VERSION,
    jose: "6.2.3",
    zod: EXPECTED_INTERNAL_ZOD,
  })) {
    assertResolvedVersion(providerRequire, specifier, version, "OAuth provider");
  }
  assertBetterCallUsesWorkerZod(providerRequire, "OAuth provider");

  const coreRequire = dependencyResolver(require, "@better-auth/core");
  for (const [specifier, version] of Object.entries({
    "@opentelemetry/api": "1.9.0",
    jose: "6.2.3",
    kysely: "0.29.2",
    nanostores: "1.3.0",
    zod: EXPECTED_INTERNAL_ZOD,
  })) {
    assertResolvedVersion(coreRequire, specifier, version, "Better Auth core");
  }
  assertBetterCallUsesWorkerZod(coreRequire, "Better Auth core");

  const betterAuthRequire = dependencyResolver(require, "better-auth");
  for (const [specifier, version] of Object.entries({
    "@better-auth/core": EXPECTED_VERSION,
    "@opentelemetry/api": "1.9.0",
    "drizzle-orm": "0.45.2",
    jose: "6.2.3",
    kysely: "0.29.2",
    nanostores: "1.3.0",
    zod: EXPECTED_INTERNAL_ZOD,
  })) {
    assertResolvedVersion(betterAuthRequire, specifier, version, "better-auth");
  }
  assertBetterCallUsesWorkerZod(betterAuthRequire, "better-auth");

  const drizzleRequire = dependencyResolver(require, "drizzle-orm");
  for (const [specifier, version] of Object.entries({
    "@opentelemetry/api": "1.9.0",
    kysely: "0.29.2",
    pg: "8.20.0",
  })) {
    assertResolvedVersion(drizzleRequire, specifier, version, "drizzle-orm");
  }
}

assertRuntimeVersions();

// This schema intentionally describes the exact 1.6 reader/writer surface.
// PostgreSQL has already been expanded through 0059, so unknown 1.7 columns
// remain untouched while the rollback trigger mirrors the legacy client fields.
const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  activeOrganizationId: text("active_organization_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

const oauthClient = pgTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret"),
  disabled: boolean("disabled"),
  skipConsent: boolean("skip_consent"),
  enableEndSession: boolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: text("scopes").array(),
  userId: text("user_id"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts").array(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris").array().notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  grantTypes: text("grant_types").array(),
  responseTypes: text("response_types").array(),
  public: boolean("public"),
  type: text("type"),
  requirePKCE: boolean("require_pkce"),
  referenceId: text("reference_id"),
  metadata: jsonb("metadata"),
});

const oauthRefreshToken = pgTable("oauth_refresh_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  clientId: text("client_id").notNull(),
  sessionId: text("session_id"),
  userId: text("user_id").notNull(),
  referenceId: text("reference_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at"),
  revoked: timestamp("revoked"),
  authTime: timestamp("auth_time"),
  scopes: text("scopes").array().notNull(),
});

const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  token: text("token"),
  clientId: text("client_id").notNull(),
  sessionId: text("session_id"),
  userId: text("user_id"),
  referenceId: text("reference_id"),
  refreshId: text("refresh_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at"),
  scopes: text("scopes").array().notNull(),
});

const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id"),
  referenceId: text("reference_id"),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

const schema = {
  user,
  session,
  account,
  verification,
  jwks,
  oauthClient,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
};

function createLegacyAuth(databaseUrl, baseURL, secret, organizationId, canonicalResource) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    application_name: "aiw331-ba-1-6-rollback-fixture",
  });
  const db = drizzle({ client: pool, schema });
  const scopes = ["mcp:read", "runs:dispatch", "offline_access"];
  const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg", transaction: true }),
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    plugins: [
      bearer(),
      jwt(),
      oauthProvider({
        scopes,
        validAudiences: [canonicalResource],
        grantTypes: ["authorization_code", "client_credentials", "refresh_token"],
        loginPage: `${baseURL}/mcp-auth/login`,
        consentPage: `${baseURL}/mcp-auth/consent`,
        allowPublicClientPrelogin: true,
        allowDynamicClientRegistration: false,
        storeTokens: "hashed",
        clientRegistrationDefaultScopes: scopes,
        clientRegistrationAllowedScopes: scopes,
        clientCredentialGrantDefaultScopes: ["mcp:read", "runs:dispatch"],
        codeChallengeMethodsSupported: ["S256"],
        silenceWarnings: { oauthAuthServerConfig: true },
        clientReference: async () => organizationId,
        customAccessTokenClaims: async ({ user: tokenUser }) =>
          tokenUser
            ? {
                organization_id: organizationId,
                organization_role: "owner",
              }
            : {
                organization_id: organizationId,
                organization_role: "service",
              },
      }),
    ],
  });
  return { auth, pool };
}

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  for (const key of [
    "databaseUrl",
    "baseURL",
    "secret",
    "organizationId",
    "canonicalResource",
  ]) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      throw new Error(`Rollback fixture input is missing ${key}`);
    }
  }
  if (!input.request || typeof input.request.path !== "string") {
    throw new Error("Rollback fixture input is missing request.path");
  }
  return input;
}

function responseBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes("application/json")) return JSON.parse(text);
  return text;
}

let pool;
try {
  const input = await readInput();
  const runtime = createLegacyAuth(
    input.databaseUrl,
    input.baseURL,
    input.secret,
    input.organizationId,
    input.canonicalResource,
  );
  pool = runtime.pool;
  await runtime.auth.$context;

  const headers = new Headers(input.request.headers ?? {});
  const request = new Request(new URL(input.request.path, input.baseURL), {
    method: input.request.method ?? "GET",
    headers,
    body: input.request.body ?? undefined,
    redirect: "manual",
  });
  const response = await runtime.auth.handler(request);
  const text = await response.text();
  process.stdout.write(
    JSON.stringify({
      status: response.status,
      location: response.headers.get("location"),
      body: responseBody(text, response.headers.get("content-type") ?? ""),
    }),
  );
} finally {
  await pool?.end();
}
