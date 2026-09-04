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
  acquireMcpServiceClientScopeLocks,
  parsePrepareMcpServiceClientScopesArguments,
  prepareMcpServiceClientScopes,
  resolvePrepareMcpServiceClientScopesDeployment,
} from "./prepare-mcp-service-client-scopes.ts";

// Manual AIW-334 gate. It creates a disposable loopback PostgreSQL cluster,
// replays the committed migrations, and invokes the exact preparation core
// while another connection races service-client registration.
const { Pool } = pg;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(scriptDir, "..", "drizzle");
const tempRoot = await mkdtemp(join(tmpdir(), "aiw334-postgres-"));
const dataDir = join(tempRoot, "data");
const logPath = join(tempRoot, "postgres.log");
const postgresEnv = { ...process.env };
for (const key of Object.keys(postgresEnv)) {
  if (
    key.startsWith("PG") ||
    key === "DATABASE_URL" ||
    key === "DASHBOARD_ORG_SLUG"
  ) {
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

async function waitForLockWait(
  applicationName,
  connectionArgs,
  timeoutMs = 10_000,
) {
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

function assertApplied(result, expected, label) {
  if (result.applied.serviceClients !== expected) {
    throw new Error(
      `${label} applied mismatch: ${result.applied.serviceClients} !== ${expected}`,
    );
  }
}

const port = await reserveLoopbackPort();
const databaseUrl = `postgresql://aiw334@127.0.0.1:${port}/postgres`;
const connectionArgs = [
  "-X",
  "-h",
  "127.0.0.1",
  "-p",
  String(port),
  "-U",
  "aiw334",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
];
const dryRunOptions = parsePrepareMcpServiceClientScopesArguments([
  "--target-environment",
  "manual",
  "--organization-slug",
  "ai-workflow",
]);
const applyOptions = parsePrepareMcpServiceClientScopesArguments([
  "--apply",
  "--confirm-legacy-runtime-1-6",
  "--target-environment",
  "manual",
  "--organization-slug",
  "ai-workflow",
]);
const deployment = resolvePrepareMcpServiceClientScopesDeployment(
  applyOptions,
  {
    DATABASE_URL: databaseUrl,
    DASHBOARD_ORG_SLUG: "ai-workflow",
  },
);
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
    "aiw334",
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
      INSERT INTO organization (id, name, slug)
      VALUES ('manual-org', 'Manual Organization', 'ai-workflow');
      INSERT INTO oauth_client (
        id, client_id, client_secret, disabled, scopes,
        client_credentials_scopes, created_at, updated_at, name,
        redirect_uris, token_endpoint_auth_method, grant_types,
        public, type, reference_id, metadata
      ) VALUES (
        'manual-client-row', 'manual-client', 'manual-secret', false,
        ARRAY['prompts:write', 'mcp:read', 'prompts:write'],
        ARRAY[]::text[], '2026-08-27T10:00:00Z', '2026-08-27T11:00:00Z',
        'Manual client', ARRAY['https://manual.example/callback'],
        'client_secret_basic', ARRAY['client_credentials'], false, 'web',
        'manual-org', '{"fixture":true}'::jsonb
      );
    `,
  ]);

  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const db = drizzle({ client: pool, schema });
  const first = await prepareMcpServiceClientScopes(
    db,
    deployment,
    applyOptions,
    {
      acquireLocks: async (transactionDb) => {
        await acquireMcpServiceClientScopeLocks(transactionDb);
        concurrentClient = start("psql", [...connectionArgs, "-qAt"]);
        concurrentClient.child.stdin.write(`
          SET application_name = 'aiw334-concurrent-client';
          BEGIN;
          SELECT 'AIW334_CLIENT_STARTED';
          INSERT INTO oauth_client (
            id, client_id, client_secret, disabled, scopes,
            client_credentials_scopes, created_at, updated_at, name,
            redirect_uris, token_endpoint_auth_method, grant_types,
            public, type, reference_id
          ) VALUES (
            'concurrent-client-row', 'concurrent-client',
            'concurrent-secret', false, ARRAY['mcp:read'], ARRAY[]::text[],
            '2026-08-27T12:00:00Z', '2026-08-27T13:00:00Z',
            'Concurrent client', ARRAY['https://concurrent.example/callback'],
            'client_secret_post', ARRAY['client_credentials'], false, 'web',
            'manual-org'
          );
          COMMIT;
        `);
        concurrentClient.child.stdin.end();
        await waitForOutput(concurrentClient, "AIW334_CLIENT_STARTED");
        await waitForLockWait("aiw334-concurrent-client", connectionArgs);
      },
    },
  );
  assertApplied(first, 1, "first");
  const concurrentResult = await concurrentClient.result;
  if (concurrentResult.code !== 0) {
    throw new Error(
      `Concurrent client failed:\n${concurrentResult.stderr}${concurrentResult.stdout}`,
    );
  }

  const afterRace = await prepareMcpServiceClientScopes(
    db,
    deployment,
    dryRunOptions,
  );
  if (afterRace.planned.serviceClients !== 1) {
    throw new Error("The client committed after reconciliation was not reported");
  }
  const catchUp = await prepareMcpServiceClientScopes(
    db,
    deployment,
    applyOptions,
  );
  assertApplied(catchUp, 1, "catch-up");
  const retry = await prepareMcpServiceClientScopes(
    db,
    deployment,
    applyOptions,
  );
  assertApplied(retry, 0, "retry");

  await pool.query(`
    INSERT INTO oauth_client (
      id, client_id, client_secret, disabled, scopes,
      client_credentials_scopes, created_at, updated_at, name,
      redirect_uris, token_endpoint_auth_method, grant_types,
      public, type, reference_id
    ) VALUES (
      'rollback-client-row', 'rollback-client', 'rollback-secret', false,
      ARRAY['tickets:write', 'mcp:read'], ARRAY[]::text[],
      '2026-08-27T14:00:00Z', '2026-08-27T15:00:00Z',
      'Rollback client', ARRAY['https://rollback.example/callback'],
      'client_secret_basic', ARRAY['client_credentials'], false, 'web',
      'manual-org'
    )
  `);
  try {
    await prepareMcpServiceClientScopes(db, deployment, applyOptions, {
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
  const afterRollback = await prepareMcpServiceClientScopes(
    db,
    deployment,
    dryRunOptions,
  );
  if (afterRollback.planned.serviceClients !== 1) {
    throw new Error("Rollback did not restore the pending-scope plan");
  }
  const rollbackRetry = await prepareMcpServiceClientScopes(
    db,
    deployment,
    applyOptions,
  );
  assertApplied(rollbackRetry, 1, "rollback retry");

  const postconditions = await pool.query(`
    SELECT
      count(*)::int AS client_count,
      bool_and(client_credentials_scopes = scopes) AS scopes_exact,
      bool_and(client_secret IN (
        'manual-secret', 'concurrent-secret', 'rollback-secret'
      )) AS secrets_preserved,
      bool_and(created_at IN (
        '2026-08-27T10:00:00Z'::timestamp,
        '2026-08-27T12:00:00Z'::timestamp,
        '2026-08-27T14:00:00Z'::timestamp
      )) AS created_at_preserved,
      bool_and(updated_at IN (
        '2026-08-27T11:00:00Z'::timestamp,
        '2026-08-27T13:00:00Z'::timestamp,
        '2026-08-27T15:00:00Z'::timestamp
      )) AS updated_at_preserved,
      bool_and(reference_id = 'manual-org') AS organization_preserved,
      bool_and(cardinality(redirect_uris) = 1) AS redirects_preserved
    FROM oauth_client
  `);
  const checks = postconditions.rows[0];
  if (
    checks.client_count !== 3 ||
    Object.entries(checks)
      .filter(([key]) => key !== "client_count")
      .some(([, value]) => value !== true)
  ) {
    throw new Error(`Postconditions failed: ${JSON.stringify(checks)}`);
  }

  console.log(
    "PASS: exact AIW-334 core serialized concurrent registration, reconciled the post-run gap, copied scopes exactly, preserved protected data, rolled back, and retried idempotently.",
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
