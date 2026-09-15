import { pathToFileURL } from "node:url";
import {
  checkDeploymentIdentity,
  parseArgs,
  type HealthPayload,
} from "./verify-deployment-identity.ts";

const FINGERPRINT_PATTERN = /^[0-9a-f]{12}$/;

export interface EngineCanaryExpectations {
  target: string;
  commit: string;
  databaseEnv: string;
  databaseFingerprint: string;
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

export function evaluatePreflight(
  health: HealthPayload,
  expectations: EngineCanaryExpectations,
): PreflightResult {
  if (expectations.target === "production") {
    return {
      ok: false,
      reason: "declared Vercel target 'production' is forbidden for engine-canary",
    };
  }
  if (typeof health.databaseEnv !== "string") {
    return {
      ok: false,
      reason: "database environment is missing from /health",
    };
  }
  if (health.databaseEnv !== expectations.databaseEnv) {
    return {
      ok: false,
      reason: `database environment '${health.databaseEnv}' does not match declared '${expectations.databaseEnv}'`,
    };
  }
  if (!FINGERPRINT_PATTERN.test(expectations.databaseFingerprint)) {
    return {
      ok: false,
      reason: "declared database fingerprint is not 12 lowercase hex characters",
    };
  }

  const identityProblems = checkDeploymentIdentity(health, {
    commit: expectations.commit,
    databaseFingerprint: expectations.databaseFingerprint,
  });
  if (identityProblems.length > 0) {
    return { ok: false, reason: identityProblems[0]! };
  }
  return { ok: true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  const target = args.target;
  const commit = args.commit;
  const databaseEnv = args["database-env"];
  const databaseFingerprint = args["database-fingerprint"];
  if (!url || !target || !commit || !databaseEnv || !databaseFingerprint) {
    console.error(
      "FAIL usage: engine-canary-preflight --url <base-url> --target <name>" +
        " --commit <40-hex>" +
        " --database-env <name> --database-fingerprint <12-hex>",
    );
    process.exitCode = 2;
    return;
  }

  let health: HealthPayload;
  try {
    const healthUrl = new URL("/health", url).toString();
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const response = await fetch(healthUrl, {
      headers: {
        accept: "application/json",
        ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
      },
    });
    if (!response.ok) {
      console.error(
        `FAIL deployment health answered ${response.status} ${response.statusText}`,
      );
      process.exitCode = 1;
      return;
    }
    health = (await response.json()) as HealthPayload;
  } catch (error) {
    console.error(`FAIL could not read deployment health: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluatePreflight(health, {
    target,
    commit,
    databaseEnv,
    databaseFingerprint,
  });
  if (!result.ok) {
    console.error(`FAIL ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("OK engine-canary deployment and database identity verified");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
