import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Manual focused gate, intentionally not part of the default test/CI scripts.
// It requires local initdb, pg_ctl and psql binaries and creates its own
// disposable cluster; it never connects to an existing database.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(scriptDir, "..", "drizzle");
const tempRoot = await mkdtemp(join(tmpdir(), "aiw329-postgres-"));
const dataDir = join(tempRoot, "data");
const logPath = join(tempRoot, "postgres.log");
const postgresEnv = { ...process.env };

// Every connection below has an explicit loopback host, random port, user and
// database. Ignore ambient PG* settings and never read DATABASE_URL.
for (const key of Object.keys(postgresEnv)) {
  if (key.startsWith("PG")) delete postgresEnv[key];
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
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
  return { child, result, stderr: () => stderr, stdout: () => stdout };
}

async function run(command, args, { allowFailure = false } = {}) {
  const process = start(command, args);
  process.child.stdin.end();
  const result = await process.result;
  if (!allowFailure && result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.code ?? result.signal}):\n` +
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
      reject(new Error(`Timed out waiting for PostgreSQL writer marker: ${marker}`));
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
          `PostgreSQL writer exited before marker (${result.code ?? result.signal}):\n` +
            `${result.stderr}${result.stdout}`,
        ),
      );
    }, reject);
  });
}

async function waitForLockWait(process, applicationName, timeoutMs = 10_000) {
  let completed;
  process.result.then((result) => {
    completed = result;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (completed) {
      throw new Error(
        `Issuer update completed before the migration lock (${completed.code ?? completed.signal}):\n` +
          `${completed.stderr}${completed.stdout}`,
      );
    }
    const waitState = await run("psql", [
      ...connectionArgs,
      "-qAt",
      "-c",
      `SELECT coalesce(wait_event_type, '')
       FROM pg_stat_activity
       WHERE application_name = '${applicationName}'`,
    ]);
    if (waitState.stdout.trim() === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the issuer update to block on migration DDL");
}

const port = await reserveLoopbackPort();
const connectionArgs = [
  "-X",
  "-h",
  "127.0.0.1",
  "-p",
  String(port),
  "-U",
  "aiw329",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
];
let postgresStarted = false;
let deleteSession;
let migrationAccountWriter;
let migrationIssuerUpdate;
let migrationSession;
let legacyWriter;

try {
  const postgresVersion = await run("initdb", ["--version"]);
  console.log(`Running ${postgresVersion.stdout.trim()}`);
  await run("initdb", [
    "-D",
    dataDir,
    "-U",
    "aiw329",
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
    .filter((file) => file.endsWith(".sql") && file.slice(0, 4) <= "0057")
    .sort();
  for (const migration of migrations) {
    await run("psql", [...connectionArgs, "-f", join(migrationsDir, migration)]);
  }

  await run("psql", [
    ...connectionArgs,
    "-c",
    `
      INSERT INTO "user" (id, name, email, email_verified) VALUES
        ('concurrent-owner', 'Concurrent Owner', 'concurrent@example.com', true),
        ('delete-owner', 'Delete Owner', 'delete@example.com', true);
      INSERT INTO sso_provider (
        id, issuer, user_id, provider_id, domain, domain_verified
      ) VALUES
        (
          'concurrent-provider', 'https://idp.original.example',
          'concurrent-owner', 'concurrent-sso', 'example.com', true
        ),
        (
          'delete-provider', 'https://idp.delete.example',
          'delete-owner', 'delete-sso', 'delete.example', true
        );
      INSERT INTO account (id, user_id, account_id, provider_id)
      VALUES ('delete-account', 'delete-owner', 'delete-subject', 'delete-sso');
    `,
  ]);

  // Hold account first, matching Better Auth's account-then-provider delete
  // path. The migration must wait for account without acquiring provider, so
  // this transaction can finish its provider delete instead of deadlocking.
  deleteSession = start("psql", [...connectionArgs, "-qAt"]);
  deleteSession.child.stdin.write(`
    SET application_name = 'aiw329-delete-path';
    BEGIN;
    DELETE FROM account WHERE id = 'delete-account';
    SELECT 'AIW329_DELETE_ACCOUNT_READY';
  `);
  await waitForOutput(deleteSession, "AIW329_DELETE_ACCOUNT_READY");

  // Pause 0058 after its early locks and trigger DDL. Its transaction must
  // block first on account, then—after the delete finishes—hold both identity
  // tables so legacy account/provider writers wait on a stable preflight.
  const expandMigration = await readFile(
    join(migrationsDir, "0058_better_auth_schema_expand.sql"),
    "utf8",
  );
  const preflightMarker = "-- Better Auth 1.7 identifies accounts";
  const preflightOffset = expandMigration.indexOf(preflightMarker);
  if (preflightOffset < 1) {
    throw new Error("0058 is missing the expected post-guard preflight marker");
  }
  migrationSession = start("psql", [...connectionArgs, "-qAt"]);
  migrationSession.child.stdin.write(`
    SET application_name = 'aiw329-migration';
    BEGIN;
    ${expandMigration.slice(0, preflightOffset)}
    SELECT 'AIW329_MIGRATION_GUARD_READY';
  `);
  await waitForLockWait(migrationSession, "aiw329-migration");

  const migrationLockOrder = await run("psql", [
    ...connectionArgs,
    "-qAt",
    "-F",
    "|",
    "-c",
    `SELECT
       count(*) FILTER (
         WHERE locks.relation = 'public.account'::regclass
           AND locks.mode = 'ShareRowExclusiveLock'
           AND NOT locks.granted
       ),
       count(*) FILTER (
         WHERE locks.relation = 'public.sso_provider'::regclass
           AND locks.mode = 'ShareRowExclusiveLock'
           AND locks.granted
       )
     FROM pg_locks AS locks
     JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
     WHERE activity.application_name = 'aiw329-migration'`,
  ]);
  if (migrationLockOrder.stdout.trim() !== "1|0") {
    throw new Error(
      "Migration did not wait for account before acquiring sso_provider: " +
        migrationLockOrder.stdout.trim(),
    );
  }

  deleteSession.child.stdin.end(`
    DELETE FROM sso_provider WHERE id = 'delete-provider';
    COMMIT;
    \\q
  `);
  const deleteResult = await deleteSession.result;
  deleteSession = undefined;
  if (deleteResult.code !== 0) {
    throw new Error(
      `Delete-order probe failed (${deleteResult.code ?? deleteResult.signal}):\n` +
        `${deleteResult.stderr}${deleteResult.stdout}`,
    );
  }
  await waitForOutput(migrationSession, "AIW329_MIGRATION_GUARD_READY");

  migrationAccountWriter = start("psql", [...connectionArgs, "-qAt"]);
  migrationAccountWriter.child.stdin.end(`
    SET application_name = 'aiw329-migration-account-writer';
    INSERT INTO account (id, user_id, account_id, provider_id)
    VALUES (
      'migration-account', 'concurrent-owner',
      'migration-subject', 'concurrent-sso'
    );
  `);
  await waitForLockWait(
    migrationAccountWriter,
    "aiw329-migration-account-writer",
  );

  migrationIssuerUpdate = start("psql", [...connectionArgs, "-qAt"]);
  migrationIssuerUpdate.child.stdin.end(`
    SET application_name = 'aiw329-migration-issuer-update';
    UPDATE sso_provider
    SET issuer = 'https://idp.during-migration.example'
    WHERE provider_id = 'concurrent-sso';
  `);
  await waitForLockWait(
    migrationIssuerUpdate,
    "aiw329-migration-issuer-update",
  );

  migrationSession.child.stdin.end(`
    ${expandMigration.slice(preflightOffset)}
    COMMIT;
    \\q
  `);
  const migrationResult = await migrationSession.result;
  migrationSession = undefined;
  if (migrationResult.code !== 0) {
    throw new Error(
      `0058 migration failed (${migrationResult.code ?? migrationResult.signal}):\n` +
        `${migrationResult.stderr}${migrationResult.stdout}`,
    );
  }

  const migrationWriterResult = await migrationAccountWriter.result;
  migrationAccountWriter = undefined;
  if (migrationWriterResult.code !== 0) {
    throw new Error(
      `Migration-time legacy writer failed (${migrationWriterResult.code ?? migrationWriterResult.signal}):\n` +
        `${migrationWriterResult.stderr}${migrationWriterResult.stdout}`,
    );
  }

  const migrationUpdateResult = await migrationIssuerUpdate.result;
  migrationIssuerUpdate = undefined;
  if (
    migrationUpdateResult.code === 0 ||
    !/issuer cannot change during the Better Auth compatibility window/i.test(
      `${migrationUpdateResult.stderr}${migrationUpdateResult.stdout}`,
    )
  ) {
    throw new Error(
      "Issuer update waiting on the migration was not rejected after commit:\n" +
        `${migrationUpdateResult.stderr}${migrationUpdateResult.stdout}`,
    );
  }

  const migratedIdentity = await run("psql", [
    ...connectionArgs,
    "-qAt",
    "-F",
    "|",
    "-c",
    `SELECT account.issuer, provider.issuer
     FROM account
     JOIN sso_provider AS provider ON provider.provider_id = account.provider_id
     WHERE account.id = 'migration-account'`,
  ]);
  if (
    migratedIdentity.stdout.trim() !==
    "https://idp.original.example|https://idp.original.example"
  ) {
    throw new Error(
      `Migration-time legacy identity diverged: ${migratedIdentity.stdout.trim()}`,
    );
  }

  // Keep a 1.6-style account insert uncommitted on connection one. A guard
  // based on querying linked accounts cannot see this row from connection two.
  legacyWriter = start("psql", [...connectionArgs, "-qAt"]);
  legacyWriter.child.stdin.write(`
    BEGIN;
    INSERT INTO account (id, user_id, account_id, provider_id)
    VALUES ('concurrent-account', 'concurrent-owner', 'subject', 'concurrent-sso');
    SELECT 'AIW329_LEGACY_INSERT_READY';
  `);
  await waitForOutput(legacyWriter, "AIW329_LEGACY_INSERT_READY");

  const issuerUpdate = await run(
    "psql",
    [
      ...connectionArgs,
      "-c",
      `UPDATE sso_provider
       SET issuer = 'https://idp.changed.example'
       WHERE provider_id = 'concurrent-sso'`,
    ],
    { allowFailure: true },
  );
  if (
    issuerUpdate.code === 0 ||
    !/issuer cannot change during the Better Auth compatibility window/i.test(
      `${issuerUpdate.stderr}${issuerUpdate.stdout}`,
    )
  ) {
    throw new Error(
      "Concurrent SSO issuer update was not rejected by the compatibility guard:\n" +
        `${issuerUpdate.stderr}${issuerUpdate.stdout}`,
    );
  }

  legacyWriter.child.stdin.end("COMMIT;\n\\q\n");
  const writerResult = await legacyWriter.result;
  legacyWriter = undefined;
  if (writerResult.code !== 0) {
    throw new Error(
      `Legacy writer failed (${writerResult.code ?? writerResult.signal}):\n` +
        `${writerResult.stderr}${writerResult.stdout}`,
    );
  }

  const identity = await run("psql", [
    ...connectionArgs,
    "-qAt",
    "-F",
    "|",
    "-c",
    `SELECT account.issuer, provider.issuer
     FROM account
     JOIN sso_provider AS provider ON provider.provider_id = account.provider_id
     WHERE account.id = 'concurrent-account'`,
  ]);
  if (
    identity.stdout.trim() !==
    "https://idp.original.example|https://idp.original.example"
  ) {
    throw new Error(`Concurrent identity diverged: ${identity.stdout.trim()}`);
  }

  await run("psql", [
    ...connectionArgs,
    "-c",
    `UPDATE sso_provider
     SET domain = 'updated.example', domain_verified = true
     WHERE provider_id = 'concurrent-sso'`,
  ]);

  console.log(
    "AIW-329 real PostgreSQL concurrency tests passed: account-first lock ordering avoided the delete-path deadlock; migration-time account/provider writers waited; issuer updates failed and legacy inserts kept the correct issuer.",
  );
} finally {
  if (migrationAccountWriter) {
    migrationAccountWriter.child.kill("SIGTERM");
    await migrationAccountWriter.result.catch(() => undefined);
  }
  if (migrationIssuerUpdate) {
    migrationIssuerUpdate.child.kill("SIGTERM");
    await migrationIssuerUpdate.result.catch(() => undefined);
  }
  if (migrationSession) {
    migrationSession.child.kill("SIGTERM");
    await migrationSession.result.catch(() => undefined);
  }
  if (deleteSession) {
    deleteSession.child.stdin.end("ROLLBACK;\n\\q\n");
    await deleteSession.result.catch(() => undefined);
  }
  if (legacyWriter) {
    legacyWriter.child.stdin.end("ROLLBACK;\n\\q\n");
    await legacyWriter.result.catch(() => undefined);
  }
  if (postgresStarted) {
    await run("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
      allowFailure: true,
    });
  }
  await rm(tempRoot, { force: true, recursive: true });
}
