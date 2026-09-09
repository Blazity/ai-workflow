/**
 * Refuses to agree that a URL serves a candidate.
 *
 * `docs/delivery-gates.md` records G3 as BLOCKED because nothing proves that an
 * endpoint serves the exact candidate commit, or that the deployment and the
 * database behind it belong together. A deployment URL, an alias, and the order
 * two pipelines happened to finish in prove none of that: an alias is re-pointed
 * by whoever deploys last, and a preview sharing a production database looks
 * identical from outside.
 *
 * So this asks the deployment itself, over its own /health, and treats every
 * unproven answer as a refusal. Silence is never a pass.
 *
 * Usage:
 *   node --import tsx scripts/ci/verify-deployment-identity.ts \
 *     --url https://example.vercel.app --commit <40-hex> --env production \
 *     [--database-url "$DATABASE_URL"]
 *
 * With --database-url it also proves the caller's database is the deployment's
 * database, which `apps/worker/e2e/scripts/check-db.ts` says outright it cannot
 * do: two migrated branches are indistinguishable from a connection string
 * alone. Neither side shows the other its host; both fingerprint it.
 */
import { databaseFingerprintFromUrl } from "../../apps/worker/src/db/database-fingerprint.ts";

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface HealthPayload {
  status?: unknown;
  commit?: unknown;
  env?: unknown;
  databaseEnv?: unknown;
  databaseFingerprint?: unknown;
}

export interface IdentityExpectation {
  commit: string;
  env: string;
  /** Omitted when the caller holds no connection string; the branch check is
   *  then simply not made, and the report says so rather than implying it
   *  passed. */
  databaseFingerprint?: string;
}

/**
 * Every reason this deployment is not the candidate, in one pass. All of them,
 * not the first: a report naming one mismatch invites a fix-and-retry loop that
 * discovers the next one a deploy later.
 */
export function checkDeploymentIdentity(
  payload: HealthPayload,
  expected: IdentityExpectation,
): string[] {
  const problems: string[] = [];

  if (!SHA_PATTERN.test(expected.commit)) {
    problems.push(
      `the expected commit '${expected.commit}' is not a 40-character sha; an` +
        " abbreviated sha, a branch or a tag cannot identify a candidate",
    );
  }

  if (payload.status !== "ok") {
    problems.push(`/health reported status '${String(payload.status)}', not 'ok'`);
  }

  if (typeof payload.commit !== "string") {
    problems.push(
      "/health did not report a commit, so nothing proves which code answers" +
        " here (on Vercel this is the project's system environment variables" +
        " not being exposed to the runtime)",
    );
  } else if (payload.commit !== expected.commit) {
    problems.push(
      `/health serves commit ${payload.commit}, and the candidate is ${expected.commit}`,
    );
  }

  if (typeof payload.env !== "string") {
    problems.push("/health did not report an environment");
  } else if (payload.env !== expected.env) {
    problems.push(
      `/health reports environment '${payload.env}', and '${expected.env}' was expected`,
    );
  }

  if (typeof payload.databaseEnv !== "string") {
    problems.push(
      "/health could not read the database env marker, so nothing proves the" +
        " deployment and its database belong together",
    );
  } else if (payload.databaseEnv !== expected.env) {
    problems.push(
      `the database behind this deployment is claimed by '${payload.databaseEnv}',` +
        ` and this deployment is '${expected.env}'`,
    );
  }

  if (expected.databaseFingerprint !== undefined) {
    if (typeof payload.databaseFingerprint !== "string") {
      problems.push(
        "/health did not report a database fingerprint, so nothing proves this" +
          " deployment reads the same branch the caller does",
      );
    } else if (payload.databaseFingerprint !== expected.databaseFingerprint) {
      problems.push(
        "this deployment reads a different database branch than the caller" +
          ` (deployment ${payload.databaseFingerprint}, caller ${expected.databaseFingerprint})`,
      );
    }
  }

  return problems;
}

export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    args[key] = value;
    index += 1;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const commit = args.commit;
  const environment = args.env;
  if (!url || !commit || !environment) {
    console.error(
      "usage: verify-deployment-identity --url <base-url> --commit <40-hex> --env <environment>",
    );
    process.exit(2);
  }

  const health = new URL("/health", url).toString();
  let payload: HealthPayload;
  try {
    const response = await fetch(health, { headers: { accept: "application/json" } });
    if (!response.ok) {
      console.error(`FAIL ${health} answered ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    payload = (await response.json()) as HealthPayload;
  } catch (error) {
    console.error(`FAIL could not read ${health}: ${(error as Error).message}`);
    process.exit(1);
  }

  let fingerprint: string | undefined;
  if (args["database-url"]) {
    const derived = databaseFingerprintFromUrl(args["database-url"]);
    if (derived === null) {
      console.error("FAIL --database-url is not a parseable connection string");
      process.exit(1);
    }
    fingerprint = derived;
  }

  const problems = checkDeploymentIdentity(payload, {
    commit,
    env: environment,
    ...(fingerprint ? { databaseFingerprint: fingerprint } : {}),
  });
  if (problems.length > 0) {
    console.error(`FAIL ${health} does not serve ${commit}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `OK ${health} serves ${commit} in ${environment}` +
      (fingerprint ? ` on database branch ${fingerprint}` : ", database branch not checked"),
  );
}

// Only when run as a program: importing this from a test must not make a request.
if (process.argv[1]?.endsWith("verify-deployment-identity.ts")) {
  await main();
}
