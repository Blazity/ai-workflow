import { fileURLToPath } from "node:url";
import { asc, and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import { activeRuns, workflowRuns } from "../src/db/schema.js";
import { sweepOrphanedRunningRuns } from "../src/lib/telemetry/run-telemetry.js";

export interface OrphanedRunningRunCandidate {
  runId: string;
  status: string | null;
  ticketKey: string | null;
}

export interface CleanupOptions {
  apply: boolean;
  confirmProduction: boolean;
}

export interface CleanupResult {
  mode: "dry-run" | "apply";
  candidates: OrphanedRunningRunCandidate[];
  remainingCandidates: number;
}

export type Sweep = (db: Db) => Promise<number>;

export interface CleanupCliDependencies {
  environment?: NodeJS.ProcessEnv;
  getDb?: () => Promise<Db>;
  sweep?: Sweep;
  write?: (text: string) => void;
}

export function parseCleanupArguments(argv: readonly string[]): CleanupOptions {
  const options: CleanupOptions = { apply: false, confirmProduction: false };
  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--confirm-production") {
      options.confirmProduction = true;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return options;
}

export function assertProductionAcknowledged(
  options: CleanupOptions,
  environment: NodeJS.ProcessEnv,
): void {
  const isProduction =
    environment.NODE_ENV === "production" ||
    environment.VERCEL_ENV === "production";
  if (options.apply && isProduction && !options.confirmProduction) {
    throw new Error(
      "Refusing --apply in production without --confirm-production.",
    );
  }
}

/**
 * Read-only view of the exact predicate used by sweepOrphanedRunningRuns.
 * Keep this query aligned with that sweep until a shared read helper exists.
 */
export async function listOrphanedRunningRuns(
  db: Db,
): Promise<OrphanedRunningRunCandidate[]> {
  return db
    .select({
      runId: workflowRuns.runId,
      status: workflowRuns.status,
      ticketKey: workflowRuns.ticketKey,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        isNotNull(workflowRuns.subjectKey),
        sql`not exists (
          select 1 from ${activeRuns}
          where ${activeRuns.runId} = ${workflowRuns.runId}
        )`,
      ),
    )
    .orderBy(asc(workflowRuns.runId));
}

export async function runCleanup(
  db: Db,
  options: CleanupOptions,
  sweep: Sweep = sweepOrphanedRunningRuns,
): Promise<CleanupResult> {
  const candidates = await listOrphanedRunningRuns(db);
  if (!options.apply) {
    return { mode: "dry-run", candidates, remainingCandidates: candidates.length };
  }

  await sweep(db);
  const remainingCandidates = await listOrphanedRunningRuns(db);
  if (remainingCandidates.length !== 0) {
    throw new Error(
      `Orphan cleanup postcondition failed: ${remainingCandidates.length} eligible run(s) remain.`,
    );
  }

  return { mode: "apply", candidates, remainingCandidates: 0 };
}

export function formatCleanupResult(result: CleanupResult): string {
  const lines = [`${result.mode} candidates: ${result.candidates.length}`];
  for (const candidate of result.candidates) {
    lines.push(
      `${candidate.runId}\t${candidate.status ?? "-"}\t${candidate.ticketKey ?? "-"}`,
    );
  }
  if (result.mode === "apply") {
    lines.push(`remaining candidates: ${result.remainingCandidates}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runCleanupCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CleanupCliDependencies = {},
): Promise<void> {
  const options = parseCleanupArguments(argv);
  assertProductionAcknowledged(options, dependencies.environment ?? process.env);

  const db = dependencies.getDb
    ? await dependencies.getDb()
    : (await import("../src/db/client.js")).getDb();
  const result = await runCleanup(db, options, dependencies.sweep);
  (dependencies.write ?? ((text: string) => process.stdout.write(text)))
    (formatCleanupResult(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCleanupCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
