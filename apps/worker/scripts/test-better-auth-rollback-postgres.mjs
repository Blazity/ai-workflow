import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createAuth } from "../src/auth.js";
import * as schema from "../src/db/schema.js";
import { canonicalMcpResource } from "../src/mcp/oauth.js";
import { prepareMcpOauthResources } from "./prepare-mcp-oauth-resources.js";
import { prepareMcpServiceClientScopes } from "./prepare-mcp-service-client-scopes.js";

// Manual focused gate. It owns a new loopback-only PostgreSQL cluster and an
// isolated Better Auth 1.6.30 runtime. It is intentionally absent from default
// CI and refuses any Node version other than the rollout runtime.
const EXPECTED_NODE = "24.20.0";
const EXPECTED_PNPM = "9.15.9";
const EXPECTED_CURRENT_BETTER_AUTH = "1.7.2";
const DEFAULT_CHILD_TIMEOUT_MS = 45_000;
const FIXTURE_INSTALL_TIMEOUT_MS = 180_000;
const DCR_FAULT_MESSAGE = "injected oauth_client_resource rollback failure";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerDir = join(scriptDir, "..");
const migrationsDir = join(workerDir, "drizzle");
const legacyFixtureDir = join(
  workerDir,
  "test-fixtures",
  "better-auth-1.6.30",
);
const legacyRuntime = join(legacyFixtureDir, "runtime.mjs");
const organizationId = "aiw331-rollback-org";
const organizationSlug = "ai-workflow";
const userId = "aiw331-rollback-user";
const sessionId = "aiw331-rollback-session";
const sessionToken = "aiw331-rollback-session-token";
const secret = "aiw331-rollback-secret-is-local-only-and-long-enough";
const baseURL = "http://127.0.0.1:43199";
const canonicalResource = canonicalMcpResource(baseURL);
const expectedIssuer = `${baseURL}/api/auth`;
const localRequire = createRequire(import.meta.url);
const activeChildren = new Map();
const childEnvironmentKeys = [
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_PROXY",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "TZ",
  "USER",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

function childEnvironment(additions = {}) {
  const environment = {};
  for (const key of childEnvironmentKeys) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...additions };
}

const runtimeEnv = childEnvironment();
assert.equal(runtimeEnv.NODE_OPTIONS, undefined);

if (process.versions.node !== EXPECTED_NODE) {
  throw new Error(
    `Better Auth rollback smoke requires Node ${EXPECTED_NODE}; found ${process.versions.node}`,
  );
}

function packageMetadata(specifier, resolver = localRequire) {
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

function assertPackageVersion(metadata, expected, label) {
  assert.equal(
    metadata.version,
    expected,
    `${label} resolved ${metadata.version} at ${metadata.packageJsonPath}`,
  );
}

function assertCurrentRuntimeVersions() {
  const currentCore = packageMetadata("@better-auth/core");
  const currentProvider = packageMetadata("@better-auth/oauth-provider");
  const currentBetterAuth = packageMetadata("better-auth");
  assertPackageVersion(
    currentCore,
    EXPECTED_CURRENT_BETTER_AUTH,
    "current @better-auth/core",
  );
  assertPackageVersion(
    currentProvider,
    EXPECTED_CURRENT_BETTER_AUTH,
    "current @better-auth/oauth-provider",
  );
  assertPackageVersion(
    currentBetterAuth,
    EXPECTED_CURRENT_BETTER_AUTH,
    "current better-auth",
  );

  const providerRequire = createRequire(
    localRequire.resolve("@better-auth/oauth-provider"),
  );
  assertPackageVersion(
    packageMetadata("better-auth", providerRequire),
    EXPECTED_CURRENT_BETTER_AUTH,
    "current provider -> better-auth",
  );
  assertPackageVersion(
    packageMetadata("@better-auth/core", providerRequire),
    EXPECTED_CURRENT_BETTER_AUTH,
    "current provider -> @better-auth/core",
  );

  const betterAuthRequire = createRequire(localRequire.resolve("better-auth"));
  assertPackageVersion(
    packageMetadata("@better-auth/core", betterAuthRequire),
    EXPECTED_CURRENT_BETTER_AUTH,
    "current better-auth -> @better-auth/core",
  );
}

function start(command, args, options = {}) {
  const {
    timeoutMs = DEFAULT_CHILD_TIMEOUT_MS,
    env = runtimeEnv,
    ...spawnOptions
  } = options;
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...spawnOptions,
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let killTimer;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    killTimer.unref();
  }, timeoutMs);
  timeout.unref();
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      activeChildren.delete(child);
      return true;
    };
    child.once("error", (error) => {
      if (finish()) reject(error);
    });
    child.once("close", (code, signal) => {
      if (finish()) resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
  activeChildren.set(child, result);
  return { child, result };
}

async function runResult(command, args, options = {}) {
  const running = start(command, args, options);
  running.child.stdin.end();
  const result = await running.result;
  if (result.timedOut) {
    throw new Error(
      `${command} timed out after ${options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS}ms`,
    );
  }
  return result;
}

async function run(command, args, options = {}) {
  const result = await runResult(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} failed (${result.code ?? result.signal}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result;
}

async function prepareLegacyFixture() {
  const pnpmVersion = await run("pnpm", ["--version"]);
  assert.equal(
    pnpmVersion.stdout.trim(),
    EXPECTED_PNPM,
    "rollback fixture must be installed with the repository pnpm version",
  );
  await run(
    "pnpm",
    [
      "--dir",
      legacyFixtureDir,
      "--ignore-workspace",
      "install",
      "--frozen-lockfile",
    ],
    {
      env: childEnvironment({ CI: "true" }),
      timeoutMs: FIXTURE_INSTALL_TIMEOUT_MS,
    },
  );
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback PostgreSQL port");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function jsonBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes("application/json")) return JSON.parse(text);
  return text;
}

async function currentRequest(auth, input) {
  const response = await auth.handler(
    new Request(new URL(input.path, baseURL), {
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body,
      redirect: "manual",
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: jsonBody(text, response.headers.get("content-type") ?? ""),
  };
}

async function legacyRequest(databaseUrl, input) {
  const running = start(process.execPath, [legacyRuntime], {
    cwd: legacyFixtureDir,
    timeoutMs: DEFAULT_CHILD_TIMEOUT_MS,
  });
  running.child.stdin.end(
    JSON.stringify({
      databaseUrl,
      baseURL,
      secret,
      organizationId,
      canonicalResource,
      request: input,
    }),
  );
  const result = await running.result;
  if (result.timedOut) {
    throw new Error(
      `Better Auth 1.6.30 fixture timed out after ${DEFAULT_CHILD_TIMEOUT_MS}ms`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `Better Auth 1.6.30 fixture failed (${result.code ?? result.signal}): ` +
        result.stderr.trim(),
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Better Auth 1.6.30 fixture returned malformed output");
  }
}

function assertStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label} returned HTTP ${result.status}`);
}

function errorChainText(value) {
  if (!(value instanceof Error)) return String(value);
  const messages = [];
  const seen = new Set();
  let current = value;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return messages.join(" caused by ");
}

function redirectDestination(result, label) {
  const candidate =
    result.location ??
    (result.body && typeof result.body === "object"
      ? result.body.url ?? result.body.redirect_uri
      : null);
  assert.equal(typeof candidate, "string", `${label} did not return a redirect`);
  return new URL(candidate);
}

function tokenResponse(result, label) {
  assertStatus(result, 200, label);
  assert(result.body && typeof result.body === "object", `${label} returned no JSON`);
  assert.equal(typeof result.body.access_token, "string", `${label} returned no access token`);
  return result.body;
}

function assertCanonicalAudience(claims, label) {
  assert(
    claims.aud === canonicalResource ||
      (Array.isArray(claims.aud) &&
        claims.aud.length === 1 &&
        claims.aud[0] === canonicalResource),
    `${label} did not contain the canonical resource audience`,
  );
}

function normalizedScope(scope, label) {
  assert.equal(typeof scope, "string", `${label} did not contain a scope claim`);
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

async function verifyCurrentJwt(auth, token, expected, label) {
  assert.equal(token.split(".").length, 3, `${label} was not a JWT`);
  const verification = await auth.api.verifyMcpAccessToken({
    body: { token },
  });
  const claims = verification.claims;
  assert.equal(claims.active, true, `${label} was not active`);
  assert.equal(claims.iss, expectedIssuer, `${label} had the wrong issuer`);
  assert.equal(claims.sub, expected.subject, `${label} had the wrong subject`);
  assert.equal(claims.azp, expected.clientId, `${label} had the wrong azp`);
  assert.equal(
    claims.client_id,
    expected.clientId,
    `${label} had the wrong client_id`,
  );
  assert.equal(
    claims.organization_id,
    organizationId,
    `${label} had the wrong organization`,
  );
  assert.equal(
    claims.organization_role,
    expected.role,
    `${label} had the wrong organization role`,
  );
  assert.deepEqual(
    normalizedScope(claims.scope, label),
    [...expected.scopes].sort(),
    `${label} had the wrong scope set`,
  );
  assertCanonicalAudience(claims, label);
  assert.equal("legacyUnboundAudience" in verification, false);
  return claims;
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function registrationBody(redirectUri, applicationType) {
  return JSON.stringify({
    client_name: `AIW-331 ${applicationType} rollback client`,
    token_endpoint_auth_method: "none",
    application_type: applicationType,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [redirectUri],
    scope: "mcp:read runs:dispatch offline_access",
  });
}

async function registerClient(auth, redirectUri, applicationType) {
  const result = await currentRequest(auth, {
    path: "/api/auth/oauth2/register",
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseURL,
    },
    body: registrationBody(redirectUri, applicationType),
  });
  assertStatus(result, 201, `${applicationType} DCR`);
  assert(result.body && typeof result.body === "object", "DCR returned no JSON");
  assert.equal(typeof result.body.client_id, "string", "DCR returned no client_id");
  return result.body;
}

async function createLegacyManagedClient(requester, redirectUri) {
  const result = await requester({
    path: "/api/auth/oauth2/create-client",
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      origin: baseURL,
    },
    body: JSON.stringify({
      client_name: "AIW-331 Better Auth 1.6 rollback client",
      token_endpoint_auth_method: "none",
      type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [redirectUri],
      scope: "mcp:read runs:dispatch offline_access",
    }),
  });
  assertStatus(result, 200, "Better Auth 1.6 managed client creation");
  assert(
    result.body && typeof result.body === "object",
    "Better Auth 1.6 managed client creation returned no JSON",
  );
  assert.equal(
    typeof result.body.client_id,
    "string",
    "Better Auth 1.6 managed client creation returned no client_id",
  );
  return result.body;
}

async function authorizeAndConsent(requester, clientId, redirectUri, options = {}) {
  const verifier = `${clientId}-pkce-verifier-with-more-than-forty-three-characters`;
  const challenge = sha256Base64Url(verifier);
  const state = `${clientId}-state`;
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "mcp:read runs:dispatch offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (options.resource !== false) query.set("resource", canonicalResource);
  if (options.forceConsent) query.set("prompt", "consent");

  const authorize = await requester({
    path: `/api/auth/oauth2/authorize?${query}`,
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
  });
  const consentPage = redirectDestination(authorize, `${clientId} authorize`);
  assert.equal(consentPage.pathname, "/mcp-auth/consent");
  assert(consentPage.searchParams.has("sig"), "consent redirect was not signed");

  const consent = await requester({
    path: "/api/auth/oauth2/consent",
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      accept: true,
      oauth_query: consentPage.search.slice(1),
    }),
  });
  const callback = redirectDestination(consent, `${clientId} consent`);
  assert.equal(
    callback.origin + callback.pathname,
    new URL(redirectUri).origin + new URL(redirectUri).pathname,
  );
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert(code, `${clientId} consent returned no authorization code`);
  return { code, verifier };
}

async function requestCodeExchange(
  requester,
  clientId,
  redirectUri,
  grant,
  resource = true,
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code: grant.code,
    code_verifier: grant.verifier,
    redirect_uri: redirectUri,
  });
  if (resource) body.set("resource", canonicalResource);
  return requester({
    path: "/api/auth/oauth2/token",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function exchangeCode(requester, clientId, redirectUri, grant, resource = true) {
  return tokenResponse(
    await requestCodeExchange(
      requester,
      clientId,
      redirectUri,
      grant,
      resource,
    ),
    `${clientId} authorization-code exchange`,
  );
}

async function refresh(requester, clientId, refreshToken, resource = true) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (resource) body.set("resource", canonicalResource);
  return requester({
    path: "/api/auth/oauth2/token",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

async function clientCredentials(requester, clientId, clientSecret, resource = true) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "mcp:read runs:dispatch",
  });
  if (resource) body.set("resource", canonicalResource);
  return tokenResponse(
    await requester({
      path: "/api/auth/oauth2/token",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    `${clientId} client-credentials exchange`,
  );
}

async function countRows(pool, table) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
  return result.rows[0].count;
}

async function assertDcrRow(pool, registration, expected) {
  const row = await pool.query(
    `SELECT
       token_endpoint_auth_method, application_type, public, type,
       reference_id, dpop_bound_access_tokens
     FROM oauth_client WHERE client_id = $1`,
    [registration.client_id],
  );
  assert.equal(row.rowCount, 1);
  assert.deepEqual(row.rows[0], {
    token_endpoint_auth_method: "none",
    application_type: expected.applicationType,
    public: true,
    type: expected.legacyType,
    reference_id: organizationId,
    dpop_bound_access_tokens: false,
  });
  const link = await pool.query(
    `SELECT resource_id FROM oauth_client_resource WHERE client_id = $1`,
    [registration.client_id],
  );
  assert.deepEqual(link.rows, [{ resource_id: canonicalResource }]);
}

async function assertRefreshRow(pool, rawToken, expected) {
  const result = await pool.query(
    `SELECT client_id, reference_id, resources, revoked
     FROM oauth_refresh_token WHERE token = $1`,
    [sha256Base64Url(rawToken)],
  );
  assert.equal(result.rowCount, 1, "refresh token row was not persisted");
  assert.equal(result.rows[0].client_id, expected.clientId);
  assert.equal(
    result.rows[0].reference_id,
    Object.hasOwn(expected, "referenceId")
      ? expected.referenceId
      : organizationId,
  );
  assert.deepEqual(result.rows[0].resources, expected.resources);
  if (expected.revoked) {
    assert(
      result.rows[0].revoked instanceof Date,
      "rotated refresh token row was not revoked",
    );
  } else {
    assert.equal(result.rows[0].revoked, null, "active refresh token was revoked");
  }
}

let requestContextImport = 0;

async function importRequestContextWithLocalDependencies(auth, db) {
  requestContextImport += 1;
  const importId = requestContextImport;
  const globals = {
    auth: `__aiw331RollbackAuth${importId}`,
    db: `__aiw331RollbackDb${importId}`,
    env: `__aiw331RollbackEnv${importId}`,
  };
  globalThis[globals.auth] = auth;
  globalThis[globals.db] = db;
  globalThis[globals.env] = {
    BETTER_AUTH_URL: baseURL,
    DASHBOARD_ORG_SLUG: organizationSlug,
  };
  const requestContextPath = join(workerDir, "src", "mcp", "request-context.ts");
  const requestContextUrl = pathToFileURL(requestContextPath).href;
  const mock = (source) =>
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentPath = context.parentURL?.startsWith("file:")
        ? fileURLToPath(context.parentURL.split("?")[0])
        : null;
      if (parentPath === requestContextPath) {
        if (specifier === "../../env.js") {
          return {
            shortCircuit: true,
            url: mock(`export const env = globalThis.${globals.env};`),
          };
        }
        if (specifier === "../auth-instance.js") {
          return {
            shortCircuit: true,
            url: mock(`export const auth = globalThis.${globals.auth};`),
          };
        }
        if (specifier === "../db/client.js") {
          return {
            shortCircuit: true,
            url: mock(
              `const db = globalThis.${globals.db}; export function getDb() { return db; }`,
            ),
          };
        }
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    return await import(
      `${requestContextUrl}?aiw331-rollback-smoke=${importId}`
    );
  } finally {
    hooks.deregister();
    delete globalThis[globals.auth];
    delete globalThis[globals.db];
    delete globalThis[globals.env];
  }
}

let tempRoot;
let dataDir;
let logPath;
let postgresStartAttempted = false;
let pool;
let cleanupPromise;

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function observeSettlement(promise) {
  let settled = false;
  const result = promise
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    .finally(() => {
      settled = true;
    });
  return { result, isSettled: () => settled };
}

async function assertWaitingForAdvisoryLock(database, backendPid, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await database.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks
         WHERE pid = $1
           AND locktype = 'advisory'
           AND NOT granted
       ) AS waiting`,
      [backendPid],
    );
    if (waiting.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} did not wait for the rollback advisory lock`);
}

async function verifyRollbackBootstrapSerialization(database) {
  const first = await database.connect();
  const second = await database.connect();
  let firstOpen = false;
  let secondOpen = false;
  try {
    await first.query("BEGIN");
    firstOpen = true;
    await second.query("BEGIN");
    secondOpen = true;
    const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;

    await first.query(`
      INSERT INTO oauth_resource (id, identifier, name, disabled)
      VALUES (
        'concurrency-resource-winner',
        'https://concurrency-winner.example/mcp',
        'Concurrency winner', false
      )
    `);
    const competingResource = observeSettlement(second.query(`
      INSERT INTO oauth_resource (id, identifier, name, disabled)
      VALUES (
        'concurrency-resource-loser',
        'https://concurrency-loser.example/mcp',
        'Concurrency loser', false
      )
    `));
    await assertWaitingForAdvisoryLock(
      database,
      secondPid,
      "concurrent enabled resource",
    );
    assert.equal(competingResource.isSettled(), false);
    await first.query("COMMIT");
    firstOpen = false;
    const resourceOutcome = await competingResource.result;
    assert.equal(resourceOutcome.ok, false, "concurrent resources both succeeded");
    assert(
      resourceOutcome.error?.code === "23514" ||
        (resourceOutcome.error?.code === "23505" &&
          resourceOutcome.error?.constraint ===
            "oauth_resource_single_enabled_rollback_idx"),
      `concurrent resource failed for the wrong reason: ${errorChainText(resourceOutcome.error)}`,
    );
    await second.query("ROLLBACK");
    secondOpen = false;
  } finally {
    if (firstOpen) await first.query("ROLLBACK").catch(() => undefined);
    if (secondOpen) await second.query("ROLLBACK").catch(() => undefined);
    first.release();
    second.release();
  }
  assert.equal(await countRows(database, "oauth_resource"), 1);
  await database.query(
    `DELETE FROM oauth_resource WHERE id = 'concurrency-resource-winner'`,
  );

  const clientFirst = await database.connect();
  const resourceSecond = await database.connect();
  let clientFirstOpen = false;
  let resourceSecondOpen = false;
  try {
    await clientFirst.query("BEGIN");
    clientFirstOpen = true;
    await resourceSecond.query("BEGIN");
    resourceSecondOpen = true;
    const resourcePid = (
      await resourceSecond.query("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;

    await clientFirst.query(`
      INSERT INTO oauth_client (
        id, client_id, redirect_uris, scopes, reference_id, public, type
      ) VALUES (
        'concurrency-client-first', 'concurrency-client-first',
        ARRAY['http://127.0.0.1/callback'], ARRAY['mcp:read'],
        'concurrency-org', true, 'native'
      )
    `);
    const resourceInsert = observeSettlement(resourceSecond.query(`
      INSERT INTO oauth_resource (id, identifier, name, disabled)
      VALUES (
        'concurrency-resource-second',
        'https://concurrency-client-first.example/mcp',
        'Concurrency client first', false
      )
    `));
    await assertWaitingForAdvisoryLock(
      database,
      resourcePid,
      "resource following an uncommitted client",
    );
    assert.equal(resourceInsert.isSettled(), false);
    await clientFirst.query("COMMIT");
    clientFirstOpen = false;
    const resourceOutcome = await resourceInsert.result;
    assert.equal(resourceOutcome.ok, true, errorChainText(resourceOutcome.error));
    await resourceSecond.query("COMMIT");
    resourceSecondOpen = false;
  } finally {
    if (clientFirstOpen) await clientFirst.query("ROLLBACK").catch(() => undefined);
    if (resourceSecondOpen) {
      await resourceSecond.query("ROLLBACK").catch(() => undefined);
    }
    clientFirst.release();
    resourceSecond.release();
  }
  const clientFirstLink = await database.query(
    `SELECT resource_id
     FROM oauth_client_resource
     WHERE client_id = 'concurrency-client-first'`,
  );
  assert.deepEqual(clientFirstLink.rows, [
    { resource_id: "https://concurrency-client-first.example/mcp" },
  ]);
  await database.query(
    `DELETE FROM oauth_resource WHERE id = 'concurrency-resource-second';
     DELETE FROM oauth_client WHERE id = 'concurrency-client-first'`,
  );

  const resourceFirst = await database.connect();
  const clientSecond = await database.connect();
  let resourceFirstOpen = false;
  let clientSecondOpen = false;
  try {
    await resourceFirst.query("BEGIN");
    resourceFirstOpen = true;
    await clientSecond.query("BEGIN");
    clientSecondOpen = true;
    const clientPid = (
      await clientSecond.query("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;

    await resourceFirst.query(`
      INSERT INTO oauth_resource (id, identifier, name, disabled)
      VALUES (
        'concurrency-resource-first',
        'https://concurrency-resource-first.example/mcp',
        'Concurrency resource first', false
      )
    `);
    const clientInsert = observeSettlement(clientSecond.query(`
      INSERT INTO oauth_client (
        id, client_id, redirect_uris, scopes, reference_id, public, type
      ) VALUES (
        'concurrency-client-second', 'concurrency-client-second',
        ARRAY['http://127.0.0.1/callback'], ARRAY['mcp:read'],
        'concurrency-org', true, 'native'
      )
    `));
    await assertWaitingForAdvisoryLock(
      database,
      clientPid,
      "client following an uncommitted resource",
    );
    assert.equal(clientInsert.isSettled(), false);
    await resourceFirst.query("COMMIT");
    resourceFirstOpen = false;
    const clientOutcome = await clientInsert.result;
    assert.equal(clientOutcome.ok, true, errorChainText(clientOutcome.error));
    await clientSecond.query("COMMIT");
    clientSecondOpen = false;
  } finally {
    if (resourceFirstOpen) await resourceFirst.query("ROLLBACK").catch(() => undefined);
    if (clientSecondOpen) await clientSecond.query("ROLLBACK").catch(() => undefined);
    resourceFirst.release();
    clientSecond.release();
  }
  const resourceFirstLink = await database.query(
    `SELECT resource_id
     FROM oauth_client_resource
     WHERE client_id = 'concurrency-client-second'`,
  );
  assert.deepEqual(resourceFirstLink.rows, [
    { resource_id: "https://concurrency-resource-first.example/mcp" },
  ]);
  await database.query(
    `DELETE FROM oauth_resource WHERE id = 'concurrency-resource-first';
     DELETE FROM oauth_client WHERE id = 'concurrency-client-second'`,
  );
}

async function verifyHistoricalOpaqueCompatibility({
  connectionArgs,
  databasePassword,
  databaseUrl,
  migrations,
}) {
  const historicalDatabase = "aiw331_historical";
  const historicalConnectionArgs = [...connectionArgs];
  historicalConnectionArgs[historicalConnectionArgs.indexOf("-d") + 1] =
    historicalDatabase;
  const historicalDatabaseUrl = new URL(databaseUrl);
  historicalDatabaseUrl.pathname = `/${historicalDatabase}`;

  await run(
    "psql",
    [...connectionArgs, "-c", `CREATE DATABASE ${historicalDatabase}`],
    { env: childEnvironment({ PGPASSWORD: databasePassword }) },
  );
  for (const migration of migrations.filter((file) => file.slice(0, 4) <= "0058")) {
    await run(
      "psql",
      [
        ...historicalConnectionArgs,
        "--single-transaction",
        "-f",
        join(migrationsDir, migration),
      ],
      { env: childEnvironment({ PGPASSWORD: databasePassword }) },
    );
  }

  const historicalPool = new pg.Pool({
    connectionString: historicalDatabaseUrl.href,
    max: 6,
    application_name: "aiw331-ba-historical-opaque-smoke",
  });
  try {
    const historicalDb = drizzle({ client: historicalPool, schema });
    await historicalPool.query(
      `INSERT INTO env_marker (id, env, endpoint_host)
       VALUES (1, 'historical-smoke', '127.0.0.1')`,
    );
    await historicalPool.query(
      `INSERT INTO "user" (
         id, name, email, email_verified, created_at, updated_at
       ) VALUES ($1, 'Historical Owner', 'historical@example.test', true, now(), now())`,
      [userId],
    );
    await historicalPool.query(
      `INSERT INTO organization (id, name, slug, created_at, updated_at)
       VALUES ($1, 'AI Workflow Historical', $2, now(), now())`,
      [organizationId, organizationSlug],
    );
    await historicalPool.query(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES ('aiw331-historical-member', $1, $2, 'owner', now())`,
      [organizationId, userId],
    );
    await historicalPool.query(
      `INSERT INTO session (
         id, user_id, token, expires_at, active_organization_id,
         created_at, updated_at
       ) VALUES ($1, $2, $3, now() + interval '1 day', $4, now(), now())`,
      [sessionId, userId, sessionToken, organizationId],
    );

    const callHistorical16 = (input) =>
      legacyRequest(historicalDatabaseUrl.href, input);
    const noResourceRedirect = "http://127.0.0.1:43201/callback";
    const resourceRedirect = "http://127.0.0.1:43202/callback";
    const noResourceClient = await createLegacyManagedClient(
      callHistorical16,
      noResourceRedirect,
    );
    const resourceClient = await createLegacyManagedClient(
      callHistorical16,
      resourceRedirect,
    );
    const noResourceGrant = await authorizeAndConsent(
      callHistorical16,
      noResourceClient.client_id,
      noResourceRedirect,
      { forceConsent: true, resource: false },
    );
    const noResourceTokens = await exchangeCode(
      callHistorical16,
      noResourceClient.client_id,
      noResourceRedirect,
      noResourceGrant,
      false,
    );
    assert.equal(noResourceTokens.access_token.split(".").length, 1);
    assert.equal(typeof noResourceTokens.refresh_token, "string");

    const resourceGrant = await authorizeAndConsent(
      callHistorical16,
      resourceClient.client_id,
      resourceRedirect,
      { forceConsent: true },
    );
    const resourceTokens = await exchangeCode(
      callHistorical16,
      resourceClient.client_id,
      resourceRedirect,
      resourceGrant,
    );
    assert.equal(resourceTokens.access_token.split(".").length, 3);
    assert.equal(typeof resourceTokens.refresh_token, "string");

    const serviceClientId = "aiw331-historical-service";
    const serviceSecret = "aiw331-historical-service-secret";
    await historicalPool.query(
      `INSERT INTO oauth_client (
         id, client_id, client_secret, disabled, scopes, redirect_uris,
         token_endpoint_auth_method, grant_types, response_types,
         public, type, reference_id
       ) VALUES (
         'aiw331-historical-service-row', $1, $2, false,
         ARRAY['mcp:read','runs:dispatch']::text[],
         ARRAY['https://historical-service.example.test/callback']::text[],
         'client_secret_post', ARRAY['client_credentials']::text[],
         ARRAY[]::text[], false, NULL, $3
       )`,
      [serviceClientId, sha256Base64Url(serviceSecret), organizationId],
    );
    const serviceTokens = await clientCredentials(
      callHistorical16,
      serviceClientId,
      serviceSecret,
      false,
    );
    assert.equal(serviceTokens.access_token.split(".").length, 1);

    const historicalAccessRows = await historicalPool.query(
      `SELECT client_id, user_id, reference_id, resources
       FROM oauth_access_token
       WHERE token = ANY($1::text[])
       ORDER BY client_id`,
      [[
        sha256Base64Url(noResourceTokens.access_token),
        sha256Base64Url(serviceTokens.access_token),
      ]],
    );
    assert.equal(historicalAccessRows.rowCount, 2);
    assert.deepEqual(
      historicalAccessRows.rows.find(
        (row) => row.client_id === noResourceClient.client_id,
      ),
      {
        client_id: noResourceClient.client_id,
        user_id: userId,
        reference_id: null,
        resources: null,
      },
    );
    assert.deepEqual(
      historicalAccessRows.rows.find((row) => row.client_id === serviceClientId),
      {
        client_id: serviceClientId,
        user_id: null,
        reference_id: null,
        resources: null,
      },
    );
    const historicalRefreshRows = await historicalPool.query(
      `SELECT client_id, reference_id, resources, revoked
       FROM oauth_refresh_token
       WHERE token = ANY($1::text[])
       ORDER BY client_id`,
      [[
        sha256Base64Url(noResourceTokens.refresh_token),
        sha256Base64Url(resourceTokens.refresh_token),
      ]],
    );
    assert.equal(historicalRefreshRows.rowCount, 2);
    for (const clientId of [noResourceClient.client_id, resourceClient.client_id]) {
      assert.deepEqual(
        historicalRefreshRows.rows.find((row) => row.client_id === clientId),
        {
          client_id: clientId,
          reference_id: null,
          resources: null,
          revoked: null,
        },
      );
    }

    const oauthDeployment = {
      databaseUrl: historicalDatabaseUrl.href,
      betterAuthUrl: baseURL,
      canonicalResource,
      endpointHost: "127.0.0.1",
      targetEnvironment: "historical-smoke",
    };
    const preparation = await prepareMcpOauthResources(
      historicalDb,
      oauthDeployment,
      {
        apply: true,
        confirmProduction: false,
        confirmSingleAudienceHistory: true,
        targetEnvironment: "historical-smoke",
      },
    );
    assert.deepEqual(preparation.planned, {
      resources: 1,
      clientLinks: 3,
      consents: preparation.applied.consents,
    });
    assert.deepEqual(preparation.applied, preparation.planned);

    const bridgeMigration = migrations.find((file) => file.startsWith("0059_"));
    assert(bridgeMigration, "missing migration 0059");
    await run(
      "psql",
      [
        ...historicalConnectionArgs,
        "--single-transaction",
        "-f",
        join(migrationsDir, bridgeMigration),
      ],
      { env: childEnvironment({ PGPASSWORD: databasePassword }) },
    );

    const historicalRowsAfterBridge = await historicalPool.query(
      `SELECT
         (SELECT resources FROM oauth_access_token WHERE token = $1)
           AS access_resources,
         (SELECT resources FROM oauth_refresh_token WHERE token = $2)
           AS no_resource_refresh_resources,
         (SELECT resources FROM oauth_refresh_token WHERE token = $3)
           AS resource_refresh_resources`,
      [
        sha256Base64Url(noResourceTokens.access_token),
        sha256Base64Url(noResourceTokens.refresh_token),
        sha256Base64Url(resourceTokens.refresh_token),
      ],
    );
    assert.deepEqual(historicalRowsAfterBridge.rows, [{
      access_resources: null,
      no_resource_refresh_resources: null,
      resource_refresh_resources: null,
    }]);

    const historicalAuth17 = createAuth(historicalDb, {
      secret,
      baseURL,
      trustedOrigins: [baseURL],
      mcp: {
        organizationId,
        allowPublicDcr: true,
        allowLegacyUnboundAccessTokens: true,
      },
    });
    await historicalAuth17.$context;
    const callHistorical17 = (input) => currentRequest(historicalAuth17, input);
    const userVerification = await historicalAuth17.api.verifyMcpAccessToken({
      body: { token: noResourceTokens.access_token },
    });
    assert.equal(userVerification.legacyUnboundAudience, true);
    assert.equal(userVerification.claims.aud, undefined);
    assert.equal(userVerification.claims.organization_id, organizationId);
    assert.equal(userVerification.claims.sub, userId);
    const serviceVerification = await historicalAuth17.api.verifyMcpAccessToken({
      body: { token: serviceTokens.access_token },
    });
    assert.equal(serviceVerification.legacyUnboundAudience, true);
    assert.equal(serviceVerification.claims.aud, undefined);
    assert.equal(serviceVerification.claims.organization_role, "service");

    const { requireMcpActor } = await importRequestContextWithLocalDependencies(
      historicalAuth17,
      historicalDb,
    );
    const userActor = await requireMcpActor(
      new Request(`${baseURL}/mcp`, {
        headers: { authorization: `Bearer ${noResourceTokens.access_token}` },
      }),
    );
    assert.equal(userActor.kind, "user");
    assert.equal(userActor.userId, userId);
    assert.equal(userActor.clientId, noResourceClient.client_id);
    const serviceActor = await requireMcpActor(
      new Request(`${baseURL}/mcp`, {
        headers: { authorization: `Bearer ${serviceTokens.access_token}` },
      }),
    );
    assert.equal(serviceActor.kind, "service");
    assert.equal(serviceActor.clientId, serviceClientId);

    await historicalPool.query(
      `UPDATE oauth_client SET reference_id = 'wrong-org' WHERE client_id = $1`,
      [noResourceClient.client_id],
    );
    await assert.rejects(
      requireMcpActor(
        new Request(`${baseURL}/mcp`, {
          headers: { authorization: `Bearer ${noResourceTokens.access_token}` },
        }),
      ),
      "historical opaque token crossed a mismatched tenant binding",
    );
    await historicalPool.query(
      `UPDATE oauth_client SET reference_id = $1 WHERE client_id = $2`,
      [organizationId, noResourceClient.client_id],
    );
    await historicalPool.query(
      `UPDATE oauth_access_token SET scopes = ARRAY['offline_access'] WHERE token = $1`,
      [sha256Base64Url(noResourceTokens.access_token)],
    );
    await assert.rejects(
      requireMcpActor(
        new Request(`${baseURL}/mcp`, {
          headers: { authorization: `Bearer ${noResourceTokens.access_token}` },
        }),
      ),
      "historical opaque token crossed the MCP scope boundary",
    );
    await historicalPool.query(
      `UPDATE oauth_access_token
       SET scopes = ARRAY['mcp:read','runs:dispatch','offline_access']
       WHERE token = $1`,
      [sha256Base64Url(noResourceTokens.access_token)],
    );

    const refreshedWithoutResource = tokenResponse(
      await refresh(
        callHistorical17,
        noResourceClient.client_id,
        noResourceTokens.refresh_token,
        false,
      ),
      "1.7 refresh of historical 1.6 no-resource token",
    );
    const refreshedWithResource = tokenResponse(
      await refresh(
        callHistorical17,
        resourceClient.client_id,
        resourceTokens.refresh_token,
      ),
      "1.7 refresh of historical 1.6 resource token",
    );
    await assertRefreshRow(historicalPool, noResourceTokens.refresh_token, {
      clientId: noResourceClient.client_id,
      referenceId: null,
      resources: null,
      revoked: true,
    });
    await assertRefreshRow(historicalPool, resourceTokens.refresh_token, {
      clientId: resourceClient.client_id,
      referenceId: null,
      resources: null,
      revoked: true,
    });
    await assertRefreshRow(historicalPool, refreshedWithoutResource.refresh_token, {
      clientId: noResourceClient.client_id,
      resources: [canonicalResource],
      revoked: false,
    });
    await assertRefreshRow(historicalPool, refreshedWithResource.refresh_token, {
      clientId: resourceClient.client_id,
      resources: [canonicalResource],
      revoked: false,
    });
    const refreshedActor = await requireMcpActor(
      new Request(`${baseURL}/mcp`, {
        headers: {
          authorization: `Bearer ${refreshedWithoutResource.access_token}`,
        },
      }),
    );
    assert.equal(refreshedActor.kind, "user");
    assert.equal(refreshedActor.userId, userId);
    await verifyCurrentJwt(
      historicalAuth17,
      refreshedWithResource.access_token,
      {
        clientId: resourceClient.client_id,
        role: "owner",
        scopes: ["mcp:read", "offline_access", "runs:dispatch"],
        subject: userId,
      },
      "1.7 refresh of historical resource-bound 1.6 token",
    );
  } finally {
    await historicalPool.end();
  }
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const failures = [];
    let databaseStopped = true;
    const runningChildren = [...activeChildren.entries()];
    for (const [child] of runningChildren) child.kill("SIGTERM");
    if (runningChildren.length > 0) {
      try {
        await withTimeout(
          Promise.allSettled(runningChildren.map(([, result]) => result)),
          5_000,
          "child process cleanup",
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (pool) {
      const closingPool = pool;
      pool = undefined;
      try {
        await withTimeout(closingPool.end(), 10_000, "PostgreSQL pool cleanup");
      } catch (error) {
        failures.push(error);
      }
    }
    if (postgresStartAttempted && dataDir) {
      try {
        const status = await runResult(
          "pg_ctl",
          ["-D", dataDir, "status"],
          { timeoutMs: 10_000 },
        );
        if (status.code === 0) {
          await run(
            "pg_ctl",
            ["-D", dataDir, "-m", "immediate", "-w", "stop"],
            { timeoutMs: 20_000 },
          );
        } else if (status.code !== 3) {
          databaseStopped = false;
          failures.push(
            new Error(
              `Could not prove PostgreSQL stopped (pg_ctl status ${status.code ?? status.signal})`,
            ),
          );
        }
      } catch (error) {
        databaseStopped = false;
        failures.push(error);
      } finally {
        postgresStartAttempted = false;
      }
    }
    if (tempRoot && databaseStopped) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Rollback harness cleanup failed");
    }
  })();
  return cleanupPromise;
}

const signalHandlers = new Map(
  [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ].map(([signal, exitCode]) => [
    signal,
    () => {
      void cleanup()
        .catch((error) => console.error(error))
        .finally(() => process.exit(exitCode));
    },
  ]),
);
for (const [signal, handler] of signalHandlers) process.once(signal, handler);

try {
  assertCurrentRuntimeVersions();
  await prepareLegacyFixture();

  tempRoot = await mkdtemp(join(tmpdir(), "aiw331-ba-rollback-"));
  dataDir = join(tempRoot, "data");
  logPath = join(tempRoot, "postgres.log");
  const passwordPath = join(tempRoot, "database-password");
  const databasePassword = randomBytes(32).toString("base64url");
  await writeFile(passwordPath, `${databasePassword}\n`, { mode: 0o600 });
  const port = await reserveLoopbackPort();
  const connectionArgs = [
    "-X",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "aiw331",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ];
  const databaseUrl = `postgresql://aiw331:${databasePassword}@127.0.0.1:${port}/postgres`;
  const postgresVersion = await run("initdb", ["--version"]);
  console.log(
    `1/10 isolated database: ${postgresVersion.stdout.trim()}, SCRAM authentication`,
  );
  await run("initdb", [
    "-D",
    dataDir,
    "-U",
    "aiw331",
    "--auth=scram-sha-256",
    `--pwfile=${passwordPath}`,
    "--encoding=UTF8",
    "--no-locale",
  ]);
  postgresStartAttempted = true;
  await run("pg_ctl", [
    "-D",
    dataDir,
    "-l",
    logPath,
    "-o",
    `-F -p ${port} -h 127.0.0.1`,
    "-w",
    "start",
  ]);

  const migrations = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= "0059")
    .sort();
  assert(migrations.some((file) => file.startsWith("0058_")), "missing migration 0058");
  assert(migrations.some((file) => file.startsWith("0059_")), "missing migration 0059");
  for (const migration of migrations) {
    await run("psql", [
      ...connectionArgs,
      "--single-transaction",
      "-f",
      join(migrationsDir, migration),
    ], {
      env: childEnvironment({ PGPASSWORD: databasePassword }),
    });
  }
  pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    application_name: "aiw331-ba-rollback-smoke",
  });
  await verifyRollbackBootstrapSerialization(pool);
  await verifyHistoricalOpaqueCompatibility({
    connectionArgs,
    databasePassword,
    databaseUrl,
    migrations,
  });
  console.log(
    "2/10 schema: migrations through 0059 applied transactionally; " +
      "bootstrap races and historical 1.6 opaque handoff verified",
  );
  const db = drizzle({ client: pool, schema });
  await pool.query(
    `INSERT INTO env_marker (id, env, endpoint_host)
     VALUES (1, 'rollback-smoke', '127.0.0.1')`,
  );
  await pool.query(
    `INSERT INTO "user" (
       id, name, email, email_verified, created_at, updated_at
     ) VALUES ($1, 'Rollback Owner', 'rollback@example.test', true, now(), now())`,
    [userId],
  );
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at, updated_at)
     VALUES ($1, 'AI Workflow Rollback', $2, now(), now())`,
    [organizationId, organizationSlug],
  );
  await pool.query(
    `INSERT INTO member (id, organization_id, user_id, role, created_at)
     VALUES ('aiw331-rollback-member', $1, $2, 'owner', now())`,
    [organizationId, userId],
  );
  await pool.query(
    `INSERT INTO session (
       id, user_id, token, expires_at, active_organization_id,
       created_at, updated_at
     ) VALUES ($1, $2, $3, now() + interval '1 day', $4, now(), now())`,
    [sessionId, userId, sessionToken, organizationId],
  );
  console.log("3/10 bootstrap: organization, owner membership and active session persisted");

  const auth17 = createAuth(db, {
    secret,
    baseURL,
    trustedOrigins: [baseURL],
    mcp: {
      organizationId,
      allowPublicDcr: true,
      allowLegacyUnboundAccessTokens: true,
    },
  });
  await auth17.$context;
  const call17 = (input) => currentRequest(auth17, input);
  const call16 = (input) => legacyRequest(databaseUrl, input);

  let clientAutoLinkDisabled = false;
  let dcrFaultInstalled = false;
  try {
    await pool.query(
      `ALTER TABLE oauth_client
       DISABLE TRIGGER oauth_client_rollback_resource_link`,
    );
    clientAutoLinkDisabled = true;
    await pool.query(`
      CREATE FUNCTION fail_aiw331_oauth_client_resource_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '${DCR_FAULT_MESSAGE}';
      END;
      $$;
      CREATE TRIGGER fail_aiw331_oauth_client_resource_insert
      BEFORE INSERT ON oauth_client_resource
      FOR EACH ROW EXECUTE FUNCTION fail_aiw331_oauth_client_resource_insert();
    `);
    dcrFaultInstalled = true;
    const originalConsoleError = console.error;
    const capturedErrors = [];
    let failedDcr;
    try {
      // Better Auth logs the database exception before returning its sanitized
      // 500. Capture the message without printing generated client identifiers.
      console.error = (...values) => {
        capturedErrors.push(
          values
            .map((value) => errorChainText(value))
            .join(" "),
        );
      };
      failedDcr = await call17({
        path: "/api/auth/oauth2/register",
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: registrationBody("http://127.0.0.1:43110/failure", "native"),
      });
    } finally {
      console.error = originalConsoleError;
    }
    assertStatus(failedDcr, 500, "fault-injected DCR");
    assert(
      capturedErrors.some((message) => message.includes(DCR_FAULT_MESSAGE)),
      "fault-injected DCR did not log the injected trigger error",
    );
    assert.equal(await countRows(pool, "oauth_client"), 0);
    assert.equal(await countRows(pool, "oauth_client_resource"), 0);
  } finally {
    try {
      if (dcrFaultInstalled) {
        await pool.query(`
          DROP TRIGGER IF EXISTS fail_aiw331_oauth_client_resource_insert
            ON oauth_client_resource;
          DROP FUNCTION IF EXISTS fail_aiw331_oauth_client_resource_insert();
        `);
      }
    } finally {
      if (clientAutoLinkDisabled) {
        await pool.query(
          `ALTER TABLE oauth_client
           ENABLE TRIGGER oauth_client_rollback_resource_link`,
        );
      }
    }
  }
  const autoLinkTriggerState = await pool.query(
    `SELECT tgenabled
     FROM pg_trigger
     WHERE tgrelid = 'oauth_client'::regclass
       AND tgname = 'oauth_client_rollback_resource_link'`,
  );
  assert.deepEqual(autoLinkTriggerState.rows, [{ tgenabled: "O" }]);
  console.log("4/10 DCR transaction: injected link failure left zero client/link rows");

  const nativeRedirect = "http://127.0.0.1:43110/callback";
  const webRedirect = "https://client.example.test/callback";
  const nativeClient = await registerClient(auth17, nativeRedirect, "native");
  const webClient = await registerClient(auth17, webRedirect, "web");
  await assertDcrRow(pool, nativeClient, {
    applicationType: "native",
    legacyType: "native",
  });
  await assertDcrRow(pool, webClient, {
    applicationType: "web",
    legacyType: "user-agent-based",
  });
  console.log("5/10 DCR compatibility: native + web clients carry exact 0059 dual-write fields");

  const code17 = await authorizeAndConsent(
    call17,
    nativeClient.client_id,
    nativeRedirect,
  );
  const tokens16From17Code = await exchangeCode(
    call16,
    nativeClient.client_id,
    nativeRedirect,
    code17,
  );
  await verifyCurrentJwt(
    auth17,
    tokens16From17Code.access_token,
    {
      clientId: nativeClient.client_id,
      role: "owner",
      scopes: ["mcp:read", "offline_access", "runs:dispatch"],
      subject: userId,
    },
    "1.6 exchange of 1.7 code",
  );
  assert.equal(typeof tokens16From17Code.refresh_token, "string");

  const code16 = await authorizeAndConsent(
    call16,
    webClient.client_id,
    webRedirect,
  );
  const wrongPkce = await requestCodeExchange(
    call17,
    webClient.client_id,
    webRedirect,
    {
      ...code16,
      verifier: `${code16.verifier}-wrong`,
    },
  );
  assertStatus(wrongPkce, 401, "wrong PKCE verifier");
  assert.equal(
    wrongPkce.body?.error,
    "invalid_request",
    "wrong PKCE verifier returned an unexpected OAuth error",
  );
  const code16AfterPkceFailure = await authorizeAndConsent(
    call16,
    webClient.client_id,
    webRedirect,
    { forceConsent: true },
  );
  const tokens17From16Code = await exchangeCode(
    call17,
    webClient.client_id,
    webRedirect,
    code16AfterPkceFailure,
  );
  await verifyCurrentJwt(
    auth17,
    tokens17From16Code.access_token,
    {
      clientId: webClient.client_id,
      role: "owner",
      scopes: ["mcp:read", "offline_access", "runs:dispatch"],
      subject: userId,
    },
    "1.7 exchange of 1.6 code",
  );
  assert.equal(typeof tokens17From16Code.refresh_token, "string");
  console.log("6/10 authorization code: S256 + consent exchanged successfully in both directions");

  const refresh1 = tokens16From17Code.refresh_token;
  await assertRefreshRow(pool, refresh1, {
    clientId: nativeClient.client_id,
    resources: [canonicalResource],
    revoked: false,
  });
  const refresh17Result = tokenResponse(
    await refresh(call17, nativeClient.client_id, refresh1),
    "1.7 refresh of 1.6 token",
  );
  await verifyCurrentJwt(
    auth17,
    refresh17Result.access_token,
    {
      clientId: nativeClient.client_id,
      role: "owner",
      scopes: ["mcp:read", "offline_access", "runs:dispatch"],
      subject: userId,
    },
    "1.7 refreshed access token",
  );
  const refresh2 = refresh17Result.refresh_token;
  assert.equal(typeof refresh2, "string");
  assert.notEqual(refresh2, refresh1, "first refresh rotation reused its token");
  await assertRefreshRow(pool, refresh1, {
    clientId: nativeClient.client_id,
    resources: [canonicalResource],
    revoked: true,
  });
  await assertRefreshRow(pool, refresh2, {
    clientId: nativeClient.client_id,
    resources: [canonicalResource],
    revoked: false,
  });
  const refresh16Result = tokenResponse(
    await refresh(call16, nativeClient.client_id, refresh2),
    "1.6 refresh of 1.7 token",
  );
  await verifyCurrentJwt(
    auth17,
    refresh16Result.access_token,
    {
      clientId: nativeClient.client_id,
      role: "owner",
      scopes: ["mcp:read", "offline_access", "runs:dispatch"],
      subject: userId,
    },
    "1.6 refreshed access token",
  );
  const refresh3 = refresh16Result.refresh_token;
  assert.equal(typeof refresh3, "string");
  assert.equal(
    new Set([refresh1, refresh2, refresh3]).size,
    3,
    "refresh rotations did not issue three distinct tokens",
  );
  await assertRefreshRow(pool, refresh2, {
    clientId: nativeClient.client_id,
    resources: [canonicalResource],
    revoked: true,
  });
  await assertRefreshRow(pool, refresh3, {
    clientId: nativeClient.client_id,
    resources: [canonicalResource],
    revoked: false,
  });
  const replay1 = await refresh(call17, nativeClient.client_id, refresh1);
  const replay2 = await refresh(call17, nativeClient.client_id, refresh2);
  assertStatus(replay1, 400, "first rotated refresh token replay");
  assertStatus(replay2, 400, "second rotated refresh token replay");
  console.log("7/10 refresh rotation: 1.6 -> 1.7 -> 1.6 worked; prior tokens rejected");

  const rollbackRedirect = "http://127.0.0.1:43111/callback";
  const rollbackClient = await createLegacyManagedClient(
    call16,
    rollbackRedirect,
  );
  await assertDcrRow(pool, rollbackClient, {
    applicationType: "native",
    legacyType: "native",
  });
  const noResourceCode = await authorizeAndConsent(
    call16,
    rollbackClient.client_id,
    rollbackRedirect,
    { forceConsent: true, resource: false },
  );
  const noResourceInitial = await exchangeCode(
    call16,
    rollbackClient.client_id,
    rollbackRedirect,
    noResourceCode,
    false,
  );
  assert.equal(noResourceInitial.access_token.split(".").length, 1);
  assert.equal(typeof noResourceInitial.refresh_token, "string");
  const noResourceRefreshed = tokenResponse(
    await refresh(
      call16,
      rollbackClient.client_id,
      noResourceInitial.refresh_token,
      false,
    ),
    "1.6 no-resource refresh",
  );
  assert.equal(noResourceRefreshed.access_token.split(".").length, 1);
  await assertRefreshRow(pool, noResourceInitial.refresh_token, {
    clientId: rollbackClient.client_id,
    resources: [canonicalResource],
    revoked: true,
  });
  await assertRefreshRow(pool, noResourceRefreshed.refresh_token, {
    clientId: rollbackClient.client_id,
    resources: [canonicalResource],
    revoked: false,
  });
  const opaqueRow = await pool.query(
    `SELECT reference_id, resources, client_id, user_id
     FROM oauth_access_token WHERE token = $1`,
    [sha256Base64Url(noResourceRefreshed.access_token)],
  );
  assert.deepEqual(opaqueRow.rows, [
    {
      reference_id: organizationId,
      resources: [canonicalResource],
      client_id: rollbackClient.client_id,
      user_id: userId,
    },
  ]);
  const opaqueVerification = await auth17.api.verifyMcpAccessToken({
    body: { token: noResourceRefreshed.access_token },
  });
  assert.equal("legacyUnboundAudience" in opaqueVerification, false);
  assert.equal(opaqueVerification.claims.active, true);
  assert.equal(opaqueVerification.claims.iss, expectedIssuer);
  assert.equal(opaqueVerification.claims.aud, canonicalResource);
  assert.equal(opaqueVerification.claims.organization_id, organizationId);
  assert.equal(opaqueVerification.claims.sub, userId);
  assert.deepEqual(
    normalizedScope(opaqueVerification.claims.scope, "1.6 no-resource opaque token"),
    ["mcp:read", "offline_access", "runs:dispatch"],
  );
  await assert.rejects(
    pool.query(
      `UPDATE oauth_access_token SET reference_id = $1 WHERE token = $2`,
      ["org-mismatched", sha256Base64Url(noResourceRefreshed.access_token)],
    ),
    /oauth rollback bridge rejected token reference/,
    "database guard accepted a mismatched bound token reference",
  );
  await auth17.api.verifyMcpAccessToken({
    body: { token: noResourceRefreshed.access_token },
  });

  await assert.rejects(
    pool.query(
      `INSERT INTO oauth_resource (
         id, identifier, name, dpop_bound_access_tokens_required,
         disabled, policy_version, created_at, updated_at
       ) VALUES (
         'aiw331-second-resource', 'https://second.example.test/mcp',
         'second', false, false, 1, now(), now()
       )`,
    ),
    /requires exactly one enabled resource after resource/,
    "database guard accepted a second enabled resource",
  );
  assert.equal(await countRows(pool, "oauth_resource"), 1);

  const removedRollbackLink = await pool.query(
    `DELETE FROM oauth_client_resource
     WHERE client_id = $1 AND resource_id = $2
     RETURNING id`,
    [rollbackClient.client_id, canonicalResource],
  );
  assert.equal(removedRollbackLink.rowCount, 1);
  const unlinkedRefresh = await refresh(
    call16,
    rollbackClient.client_id,
    noResourceRefreshed.refresh_token,
    false,
  );
  assertStatus(unlinkedRefresh, 500, "unlinked Better Auth 1.6 refresh");
  await assertRefreshRow(pool, noResourceRefreshed.refresh_token, {
    clientId: rollbackClient.client_id,
    resources: [canonicalResource],
    revoked: true,
  });
  await pool.query(
    `INSERT INTO oauth_client_resource (id, client_id, resource_id, created_at)
     VALUES ('aiw331-rollback-client-link-restored', $1, $2, now())`,
    [rollbackClient.client_id, canonicalResource],
  );
  await auth17.api.verifyMcpAccessToken({
    body: { token: noResourceRefreshed.access_token },
  });
  console.log(
    "8/10 rollback client: linked 1.6 flow stayed green; " +
      "artificial unlink failed closed and consumed only its refresh token",
  );

  const serviceClientId = "aiw331-service-client";
  const serviceSecret = "aiw331-local-service-secret";
  await pool.query(
    `INSERT INTO oauth_client (
       id, client_id, client_secret, disabled, scopes,
       client_credentials_scopes, redirect_uris,
       token_endpoint_auth_method, grant_types, response_types,
       public, type, reference_id, dpop_bound_access_tokens
     ) VALUES (
       'aiw331-service-row', $1, $2, false,
       ARRAY['mcp:read','runs:dispatch']::text[],
       ARRAY['mcp:read','runs:dispatch']::text[],
       ARRAY['https://service.example.test/callback']::text[],
       'client_secret_post', ARRAY['client_credentials']::text[],
       ARRAY[]::text[], false, NULL, $3, false
     )`,
    [serviceClientId, sha256Base64Url(serviceSecret), organizationId],
  );
  const serviceAutoLink = await pool.query(
    `SELECT resource_id FROM oauth_client_resource WHERE client_id = $1`,
    [serviceClientId],
  );
  assert.deepEqual(serviceAutoLink.rows, [{ resource_id: canonicalResource }]);
  const service16 = await clientCredentials(call16, serviceClientId, serviceSecret);
  const service17 = await clientCredentials(call17, serviceClientId, serviceSecret);
  await verifyCurrentJwt(
    auth17,
    service16.access_token,
    {
      clientId: serviceClientId,
      role: "service",
      scopes: ["mcp:read", "runs:dispatch"],
      subject: undefined,
    },
    "1.6 service access token",
  );
  await verifyCurrentJwt(
    auth17,
    service17.access_token,
    {
      clientId: serviceClientId,
      role: "service",
      scopes: ["mcp:read", "runs:dispatch"],
      subject: serviceClientId,
    },
    "1.7 service access token",
  );

  const { requireMcpActor } = await importRequestContextWithLocalDependencies(
    auth17,
    db,
  );
  for (const accessToken of [service16.access_token, service17.access_token]) {
    const actor = await requireMcpActor(
      new Request(`${baseURL}/mcp`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    assert.equal(actor.kind, "service");
    assert.equal(actor.subject, serviceClientId);
    assert.equal(actor.userId, null);
    assert.equal(actor.clientId, serviceClientId);
  }
  console.log(
    "9/10 service tokens: real 1.6 missing-sub and 1.7 client-sub " +
      "both classified by current requireMcpActor",
  );

  const oauthDeployment = {
    databaseUrl,
    betterAuthUrl: baseURL,
    canonicalResource,
    endpointHost: "127.0.0.1",
    targetEnvironment: "rollback-smoke",
  };
  const normalizedConsents = await pool.query(
    `UPDATE oauth_consent SET resources = $1 RETURNING id`,
    [[canonicalResource]],
  );
  assert(
    normalizedConsents.rowCount > 0,
    "authorization-code flows did not persist an OAuth consent",
  );
  const consentDelta = await pool.query(
    `UPDATE oauth_consent
     SET resources = NULL
     WHERE id = (
       SELECT id FROM oauth_consent
       WHERE client_id = $1
       ORDER BY id
       LIMIT 1
     )
     RETURNING id`,
    [webClient.client_id],
  );
  assert.equal(consentDelta.rowCount, 1, "could not create one consent delta");
  const removedLinks = await pool.query(
    `DELETE FROM oauth_client_resource RETURNING client_id`,
  );
  assert.deepEqual(
    removedLinks.rows.map((row) => row.client_id).sort(),
    [
      nativeClient.client_id,
      rollbackClient.client_id,
      serviceClientId,
      webClient.client_id,
    ].sort(),
  );
  const removedResource = await pool.query(
    `DELETE FROM oauth_resource WHERE identifier = $1 RETURNING identifier`,
    [canonicalResource],
  );
  assert.deepEqual(removedResource.rows, [{ identifier: canonicalResource }]);

  const oauthPreflight = await prepareMcpOauthResources(
    db,
    oauthDeployment,
    {
      apply: false,
      confirmProduction: false,
      confirmSingleAudienceHistory: false,
      targetEnvironment: "rollback-smoke",
    },
  );
  assert.equal(oauthPreflight.mode, "dry-run");
  assert.equal(oauthPreflight.counts.clients, 4);
  assert.equal(oauthPreflight.counts.resources, 0);
  assert.equal(oauthPreflight.counts.clientLinks, 0);
  assert.equal(oauthPreflight.counts.consents, normalizedConsents.rowCount);
  assert.deepEqual(oauthPreflight.planned, {
    resources: 1,
    clientLinks: 4,
    consents: 1,
  });
  assert.deepEqual(oauthPreflight.applied, {
    resources: 0,
    clientLinks: 0,
    consents: 0,
  });
  assert.equal(oauthPreflight.singleAudienceHistoryConfirmed, false);
  assert.equal(oauthPreflight.consentHistoryConfirmationRequired, true);
  assert.equal(await countRows(pool, "oauth_resource"), 0);
  assert.equal(await countRows(pool, "oauth_client_resource"), 0);

  const oauthApply = await prepareMcpOauthResources(
    db,
    oauthDeployment,
    {
      apply: true,
      confirmProduction: false,
      confirmSingleAudienceHistory: true,
      targetEnvironment: "rollback-smoke",
    },
  );
  assert.equal(oauthApply.mode, "apply");
  assert.deepEqual(oauthApply.planned, oauthPreflight.planned);
  assert.deepEqual(oauthApply.applied, oauthPreflight.planned);
  assert.equal(oauthApply.consentHistoryConfirmationRequired, false);

  const canonicalResourceRow = await pool.query(
    `SELECT
       identifier, access_token_ttl, refresh_token_ttl, signing_algorithm,
       signing_key_id, allowed_scopes, custom_claims,
       dpop_bound_access_tokens_required, disabled, policy_version
     FROM oauth_resource
     WHERE identifier = $1`,
    [canonicalResource],
  );
  assert.deepEqual(canonicalResourceRow.rows, [
    {
      identifier: canonicalResource,
      access_token_ttl: null,
      refresh_token_ttl: null,
      signing_algorithm: null,
      signing_key_id: null,
      allowed_scopes: null,
      custom_claims: null,
      dpop_bound_access_tokens_required: false,
      disabled: false,
      policy_version: 1,
    },
  ]);
  const restoredLinks = await pool.query(
    `SELECT client_id, resource_id
     FROM oauth_client_resource
     ORDER BY client_id`,
  );
  assert.deepEqual(
    restoredLinks.rows,
    [
      nativeClient.client_id,
      rollbackClient.client_id,
      serviceClientId,
      webClient.client_id,
    ]
      .sort()
      .map((clientId) => ({ client_id: clientId, resource_id: canonicalResource })),
  );
  const restoredConsent = await pool.query(
    `SELECT resources FROM oauth_consent WHERE id = $1`,
    [consentDelta.rows[0].id],
  );
  assert.deepEqual(restoredConsent.rows, [{ resources: [canonicalResource] }]);

  const oauthPostflight = await prepareMcpOauthResources(
    db,
    oauthDeployment,
    {
      apply: false,
      confirmProduction: false,
      confirmSingleAudienceHistory: true,
      targetEnvironment: "rollback-smoke",
    },
  );
  assert.equal(oauthPostflight.mode, "dry-run");
  assert.equal(oauthPostflight.counts.clients, 4);
  assert.equal(oauthPostflight.counts.resources, 1);
  assert.equal(oauthPostflight.counts.clientLinks, 4);
  assert.deepEqual(oauthPostflight.planned, {
    resources: 0,
    clientLinks: 0,
    consents: 0,
  });

  const servicePostflight = await prepareMcpServiceClientScopes(
    db,
    {
      databaseUrl,
      endpointHost: "127.0.0.1",
      organizationSlug,
      sourceRuntimeVersion: "1.6.30",
      targetEnvironment: "rollback-smoke",
    },
    {
      apply: false,
      confirmLegacyRuntime16: true,
      confirmProduction: false,
      organizationSlug,
      targetEnvironment: "rollback-smoke",
    },
  );
  assert.equal(servicePostflight.mode, "dry-run");
  assert.deepEqual(servicePostflight.planned, { serviceClients: 0 });
  assert.deepEqual(servicePostflight.applied, { serviceClients: 0 });
  assert.deepEqual(servicePostflight.counts, {
    oauthClients: 4,
    serviceCandidates: 1,
    eligibleServiceCandidates: 1,
    pendingServiceCandidates: 0,
    compliantServiceCandidates: 1,
    ignoredNonServiceClients: 3,
    blockedRows: 0,
  });
  assert(
    Object.values(servicePostflight.blockers).every((count) => count === 0),
    "service scope postflight contained a blocker",
  );
  const serviceScopeRow = await pool.query(
    `SELECT scopes, client_credentials_scopes
     FROM oauth_client WHERE client_id = $1`,
    [serviceClientId],
  );
  assert.deepEqual(serviceScopeRow.rows, [
    {
      scopes: ["mcp:read", "runs:dispatch"],
      client_credentials_scopes: ["mcp:read", "runs:dispatch"],
    },
  ]);
  console.log(
    "10/10 reconciliation: exact dry-run/apply delta, row invariants, " +
      "and zero postflight verified",
  );
  console.log("PASS Better Auth 1.7.2 <-> 1.6.30 disposable PostgreSQL rollback smoke");
} finally {
  await cleanup();
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
}
