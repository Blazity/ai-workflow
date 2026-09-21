/**
 * Rewrite every stored workflow graph that still names a block type this build
 * renamed (`RENAMED_WORKFLOW_BLOCK_TYPES` in `@shared/contracts`).
 *
 * Why this is a script and not a migration, which is the whole point of it:
 * the worker's `build` runs `db:migrate`, and a preview deployment reads the
 * production database. A rewrite carried by a build migration would therefore
 * rewrite production's definitions from a preview deploy of an unmerged
 * branch, while production still ran code that had never heard of the new
 * type. So the new build accepts the old type (it is canonicalised when a row
 * is read, and a run replaying an old plan still executes it), the rewrite is
 * explicitly invoked once the new code is live, and until it runs a revert to
 * the previous build is still safe. That window is the point.
 *
 * Every version is rewritten, not only the deployed one, so opening history,
 * comparing two versions and rolling back all keep working.
 *
 * Idempotent: a second run finds nothing to do.
 *
 *   pnpm --filter worker rewrite:renamed-blocks              # dry run
 *   pnpm --filter worker rewrite:renamed-blocks -- --apply
 */
import { sql } from "drizzle-orm";
import {
  RENAMED_WORKFLOW_BLOCK_TYPES,
  canonicalizeWorkflowBlockTypes,
} from "@shared/contracts";
import type { Db } from "../src/db/client.js";
import { workflowDefinitionVersions } from "../src/db/schema.js";

export interface RewriteOptions {
  apply: boolean;
  confirmProduction: boolean;
}

export interface RewriteCandidate {
  definitionId: number;
  version: number;
  /** The renamed types this row carries, in the order they appear. */
  types: string[];
}

export interface RewriteResult {
  mode: "dry-run" | "apply";
  candidates: RewriteCandidate[];
  rewritten: number;
  /** Rows still naming a renamed type after the write. Must be zero. */
  remaining: number;
}

export function parseRewriteArguments(argv: readonly string[]): RewriteOptions {
  const options: RewriteOptions = { apply: false, confirmProduction: false };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--confirm-production") options.confirmProduction = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return options;
}

export function assertProductionAcknowledged(
  options: RewriteOptions,
  environment: NodeJS.ProcessEnv,
): void {
  const isProduction =
    environment.NODE_ENV === "production" || environment.VERCEL_ENV === "production";
  if (options.apply && isProduction && !options.confirmProduction) {
    throw new Error("Refusing --apply in production without --confirm-production.");
  }
}

/** The renamed types one stored row names, read from the raw JSON. */
export function renamedTypesIn(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const found: string[] = [];
  for (const node of nodes) {
    const type = (node as { type?: unknown } | null)?.type;
    if (typeof type === "string" && RENAMED_WORKFLOW_BLOCK_TYPES[type]) found.push(type);
  }
  return found;
}

export async function planRewrite(db: Db): Promise<{
  candidates: RewriteCandidate[];
  rows: { definitionId: number; version: number; definition: unknown }[];
}> {
  const rows = await db
    .select({
      definitionId: workflowDefinitionVersions.definitionId,
      version: workflowDefinitionVersions.version,
      definition: workflowDefinitionVersions.definition,
    })
    .from(workflowDefinitionVersions);
  const candidates: RewriteCandidate[] = [];
  const affected: { definitionId: number; version: number; definition: unknown }[] = [];
  for (const row of rows) {
    const types = renamedTypesIn(row.definition);
    if (types.length === 0) continue;
    candidates.push({ definitionId: row.definitionId, version: row.version, types });
    affected.push(row);
  }
  return { candidates, rows: affected };
}

export async function runRewrite(db: Db, options: RewriteOptions): Promise<RewriteResult> {
  const { candidates, rows } = await planRewrite(db);
  // The same reader decides what needs rewriting and what the new graph is, so
  // a row that reached this list always maps.
  const writes = rows.map((row) => ({
    definitionId: row.definitionId,
    version: row.version,
    definition: canonicalizeWorkflowBlockTypes(row.definition),
  }));

  if (!options.apply) {
    return { mode: "dry-run", candidates, rewritten: 0, remaining: candidates.length };
  }

  // One statement. Production runs neon-http, which has no interactive
  // transaction, so a loop of updates could stop half way and leave some
  // versions of one definition rewritten and others not.
  if (writes.length > 0) {
    const values = sql.join(
      writes.map(
        (write) =>
          sql`(${write.definitionId}::integer, ${write.version}::integer, ${JSON.stringify(write.definition)}::jsonb)`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      update ${workflowDefinitionVersions}
      set definition = source.definition
      from (values ${values}) as source(definition_id, version, definition)
      where ${workflowDefinitionVersions.definitionId} = source.definition_id
        and ${workflowDefinitionVersions.version} = source.version
    `);
  }

  const after = await planRewrite(db);
  return {
    mode: "apply",
    candidates,
    rewritten: writes.length,
    remaining: after.candidates.length,
  };
}

export function formatRewriteResult(result: RewriteResult): string {
  const lines = [`${result.mode} candidates: ${result.candidates.length}`];
  for (const candidate of result.candidates) {
    lines.push(
      `definition ${candidate.definitionId} version ${candidate.version}\t${candidate.types.join(", ")}`,
    );
  }
  if (result.mode === "apply") {
    lines.push(
      `rewritten: ${result.rewritten}`,
      `still naming a renamed type: ${result.remaining}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface RewriteCliDependencies {
  environment?: NodeJS.ProcessEnv;
  getDb?: () => Promise<Db>;
  write?: (text: string) => void;
}

export async function runRewriteCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: RewriteCliDependencies = {},
): Promise<void> {
  const options = parseRewriteArguments(argv);
  assertProductionAcknowledged(options, dependencies.environment ?? process.env);
  const db = dependencies.getDb
    ? await dependencies.getDb()
    : (await import("../src/db/client.js")).getDb();
  const result = await runRewrite(db, options);
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  write(formatRewriteResult(result));
  if (result.mode === "apply" && result.remaining > 0) {
    throw new Error(
      `Rewrite postcondition failed: ${result.remaining} version(s) still name a renamed block type.`,
    );
  }
}

if (process.argv[1] === import.meta.filename) {
  try {
    await runRewriteCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
