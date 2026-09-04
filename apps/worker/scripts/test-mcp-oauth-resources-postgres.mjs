import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/db/schema.ts";
import {
  acquireMcpOauthResourceLocks,
  parsePrepareMcpOauthResourcesArguments,
  prepareMcpOauthResources,
  resolvePrepareMcpOauthResourcesDeployment,
} from "./prepare-mcp-oauth-resources.ts";

// Manual AIW-330 gate. It creates a disposable loopback PostgreSQL cluster,
// replays the committed migrations, then invokes the exact preparation core
// against that database while a second connection races client registration.
const { Pool } = pg;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(scriptDir, "..", "drizzle");
const tempRoot = await mkdtemp(join(tmpdir(), "aiw330-postgres-"));
const dataDir = join(tempRoot, "data");
const logPath = join(tempRoot, "postgres.log");
const postgresEnv = { ...process.env };
for (const key of Object.keys(postgresEnv)) {
  if (key.startsWith("PG") || key === "DATABASE_URL" || key === "BETTER_AUTH_URL") {
    delete postgresEnv[key];
  }
}

function start(command, args) {
  const child = spawn(command, args, {
    env: postgresEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stderr, stdout }),
    );
  });
  return { child, result, stdout: () => stdout };
}

async function run(command, args, { allowFailure = false } = {}) {
  const process = start(command, args);
  process.child.stdin.end();
  const result = await process.result;
  if (!allowFailure && result.code !== 0) {
    throw new Error(
      `${command} failed (${result.code ?? result.signal}):\n` +
        `${result.stderr}${result.stdout}`,
    );
  }
  return result;
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

async function waitForOutput(process, marker, timeoutMs = 10_000) {
  if (process.stdout().includes(marker)) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for PostgreSQL marker: ${marker}`));
    }, timeoutMs);
    const onData = () => {
      if (!process.stdout().includes(marker)) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      process.child.stdout.off("data", onData);
    };
    process.child.stdout.on("data", onData);
    process.result.then((result) => {
      if (process.stdout().includes(marker)) return;
      cleanup();
      reject(
        new Error(
          `PostgreSQL process exited before ${marker} (${result.code ?? result.signal}):\n` +
            `${result.stderr}${result.stdout}`,
        ),
      );
    }, reject);
  });
}

async function waitForLockWait(applicationName, connectionArgs, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await run("psql", [
      ...connectionArgs,
      "-qAt",
      "-c",
      `SELECT coalesce(wait_event_type, '')
       FROM pg_stat_activity
       WHERE application_name = '${applicationName}'`,
    ]);
    if (state.stdout.trim() === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on a lock`);
}

function assertMutations(result, expected, label) {
  const actual = JSON.stringify(result.applied);
  if (actual !== JSON.stringify(expected)) {
    throw new Error(`${label} mutations mismatch: ${actual}`);
  }
}

const canonical = "https://worker.example.com/mcp";
const port = await reserveLoopbackPort();
const databaseUrl = `postgresql://aiw330@127.0.0.1:${port}/postgres`;
const connectionArgs = [
  "-X",
  "-h",
  "127.0.0.1",
  "-p",
  String(port),
  "-U",
  "aiw330",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
];
const dryRunOptions = parsePrepareMcpOauthResourcesArguments([
  "--target-environment",
  "manual",
]);
const applyOptions = parsePrepareMcpOauthResourcesArguments([
  "--apply",
  "--confirm-single-audience-history",
  "--target-environment",
  "manual",
]);
const deployment = resolvePrepareMcpOauthResourcesDeployment(applyOptions, {
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_URL: "https://worker.example.com",
});
let postgresStarted = false;
let pool;
let concurrentClient;

try {
  const postgresVersion = await run("initdb", ["--version"]);
  console.log(`Running ${postgresVersion.stdout.trim()}`);
  await run("initdb", [
    "-D",
    dataDir,
    "-U",
    "aiw330",
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
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
  postgresStarted = true;

  const migrations = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= "0058")
    .sort();
  for (const migration of migrations) {
    await run("psql", [
      ...connectionArgs,
      "--single-transaction",
      "-f",
      join(migrationsDir, migration),
    ]);
  }
  await run("psql", [
    ...connectionArgs,
    "-c",
    `
      INSERT INTO env_marker (id, env, endpoint_host)
      VALUES (1, 'manual', '127.0.0.1');
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('manual-user', 'Manual User', 'manual@example.com', true);
      INSERT INTO oauth_client (id, client_id, redirect_uris, scopes)
      VALUES (
        'manual-client-row', 'manual-client',
        ARRAY['https://manual.example/callback'], ARRAY['mcp:read']
      );
      INSERT INTO oauth_refresh_token (
        id, token, client_id, user_id, scopes, expires_at
      ) VALUES (
        'manual-refresh', 'manual-refresh-fixture', 'manual-client',
        'manual-user', ARRAY['mcp:read', 'offline_access'], now() + interval '1 day'
      );
      INSERT INTO oauth_access_token (id, token, client_id, user_id, scopes)
      VALUES (
        'manual-access', 'manual-access-fixture', 'manual-client',
        'manual-user', ARRAY['mcp:read']
      );
      INSERT INTO oauth_consent (id, client_id, user_id, scopes)
      VALUES (
        'manual-consent', 'manual-client', 'manual-user',
        ARRAY['mcp:read', 'offline_access']
      );
    `,
  ]);

  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const db = drizzle({ client: pool, schema });
  const first = await prepareMcpOauthResources(
    db,
    deployment,
    applyOptions,
    {
      acquireLocks: async (transactionDb) => {
        await acquireMcpOauthResourceLocks(transactionDb);
        concurrentClient = start("psql", [...connectionArgs, "-qAt"]);
        concurrentClient.child.stdin.write(`
          SET application_name = 'aiw330-concurrent-client';
          BEGIN;
          SELECT 'AIW330_CLIENT_STARTED';
          INSERT INTO oauth_client (id, client_id, redirect_uris, scopes)
          VALUES (
            'concurrent-client-row', 'concurrent-client',
            ARRAY['https://concurrent.example/callback'], ARRAY['mcp:read']
          );
          COMMIT;
        `);
        concurrentClient.child.stdin.end();
        await waitForOutput(concurrentClient, "AIW330_CLIENT_STARTED");
        await waitForLockWait("aiw330-concurrent-client", connectionArgs);
      },
    },
  );
  assertMutations(first, { resources: 1, clientLinks: 1, consents: 1 }, "first");
  const concurrentResult = await concurrentClient.result;
  if (concurrentResult.code !== 0) {
    throw new Error(
      `Concurrent client failed:\n${concurrentResult.stderr}${concurrentResult.stdout}`,
    );
  }

  const afterRace = await prepareMcpOauthResources(
    db,
    deployment,
    dryRunOptions,
  );
  if (afterRace.planned.clientLinks !== 1) {
    throw new Error("The client committed after reconciliation was not reported");
  }
  const catchUp = await prepareMcpOauthResources(
    db,
    deployment,
    applyOptions,
  );
  assertMutations(catchUp, { resources: 0, clientLinks: 1, consents: 0 }, "catch-up");
  const retry = await prepareMcpOauthResources(db, deployment, applyOptions);
  assertMutations(retry, { resources: 0, clientLinks: 0, consents: 0 }, "retry");

  await pool.query(`
    INSERT INTO oauth_client (id, client_id, redirect_uris, scopes)
    VALUES (
      'rollback-client-row', 'rollback-client',
      ARRAY['https://rollback.example/callback'], ARRAY['mcp:read']
    )
  `);
  try {
    await prepareMcpOauthResources(db, deployment, applyOptions, {
      afterWrites: async () => {
        throw new Error("forced post-write rollback");
      },
    });
    throw new Error("Forced rollback unexpectedly committed");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "forced post-write rollback") {
      throw error;
    }
  }
  const afterRollback = await prepareMcpOauthResources(
    db,
    deployment,
    dryRunOptions,
  );
  if (afterRollback.planned.clientLinks !== 1) {
    throw new Error("Rollback did not restore the missing-link plan");
  }
  const rollbackRetry = await prepareMcpOauthResources(
    db,
    deployment,
    applyOptions,
  );
  assertMutations(
    rollbackRetry,
    { resources: 0, clientLinks: 1, consents: 0 },
    "rollback retry",
  );

  const postconditions = await pool.query(`
    SELECT
      (SELECT count(*) = 1 FROM oauth_resource
        WHERE identifier = '${canonical}'
          AND name = '${canonical}'
          AND access_token_ttl IS NULL
          AND refresh_token_ttl IS NULL
          AND signing_algorithm IS NULL
          AND signing_key_id IS NULL
          AND allowed_scopes IS NULL
          AND custom_claims IS NULL
          AND dpop_bound_access_tokens_required = false
          AND disabled = false
          AND policy_version = 1) AS resource_ok,
      (SELECT count(*) FROM oauth_client) =
        (SELECT count(*) FROM oauth_client_resource
          WHERE resource_id = '${canonical}') AS links_ok,
      (SELECT resources IS NULL
          AND token = 'manual-refresh-fixture'
          AND scopes = ARRAY['mcp:read', 'offline_access']
        FROM oauth_refresh_token WHERE id = 'manual-refresh') AS refresh_ok,
      (SELECT resources IS NULL
          AND token = 'manual-access-fixture'
          AND scopes = ARRAY['mcp:read']
        FROM oauth_access_token WHERE id = 'manual-access') AS access_ok,
      (SELECT resources = ARRAY['${canonical}']
          AND scopes = ARRAY['mcp:read', 'offline_access']
        FROM oauth_consent WHERE id = 'manual-consent') AS consent_ok
  `);
  const checks = postconditions.rows[0];
  if (!Object.values(checks).every((value) => value === true)) {
    throw new Error(`Postconditions failed: ${JSON.stringify(checks)}`);
  }

  console.log(
    "PASS: exact AIW-330 core serialized concurrent registration, exposed and reconciled the post-run gap, preserved grants, rolled back, and retried idempotently.",
  );
} finally {
  if (concurrentClient && concurrentClient.child.exitCode === null) {
    concurrentClient.child.stdin.end();
    concurrentClient.child.kill("SIGTERM");
    await concurrentClient.result.catch(() => undefined);
  }
  await pool?.end().catch(() => undefined);
  if (postgresStarted) {
    await run("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
      allowFailure: true,
    });
  }
  await rm(tempRoot, { recursive: true, force: true });
}
