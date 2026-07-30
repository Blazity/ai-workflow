import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { validateReleaseNotes } from "./render.js";

const execFileAsync = promisify(execFile);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export type ManifestRunner = (command: string, args: string[]) => Promise<string>;

const defaultRun: ManifestRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
};

export interface CandidateValidation {
  version: string;
  candidateCommit: string;
  previousCommit: string;
  targetCommit: string;
  notesPath: string;
  databaseMigrations: string[];
}

export async function validateReleaseCandidate(
  input: { version: string; markdown: string; mainRef: string },
  deps: { run?: ManifestRunner } = {},
): Promise<CandidateValidation> {
  const run = deps.run ?? defaultRun;
  const parsed = validateReleaseNotes(input.markdown, input.version);
  const notesPath = `docs/releases/artur/${input.version}.md`;
  const log = await run("git", [
    "log",
    "--first-parent",
    "--format=%H",
    "--diff-filter=A",
    "--",
    notesPath,
  ]);
  const candidateCommit = shaSchema.parse(log.trim().split("\n")[0]);
  try {
    await run("git", ["merge-base", "--is-ancestor", candidateCommit, input.mainRef]);
  } catch {
    throw new Error(`Release candidate ${candidateCommit} is not part of ${input.mainRef}`);
  }

  const changed = (await run("git", [
    "diff",
    "--name-only",
    `${parsed.metadata.targetCommit}..${candidateCommit}`,
  ]))
    .split("\n")
    .filter(Boolean);
  if (changed.length !== 1 || changed[0] !== notesPath) {
    throw new Error(`Release candidate contains unexpected changes: ${changed.join(", ") || "none"}`);
  }

  const existingTag = await run("git", ["tag", "--list", `artur-v${input.version}`]);
  if (existingTag.trim()) throw new Error(`Tag artur-v${input.version} already exists`);

  const scopeNumbers = new Set(
    [...input.markdown.matchAll(/\[#(\d+)\]\(https:\/\/github\.com\//g)].map((match) => Number(match[1])),
  );
  for (const source of parsed.sources) {
    if (!scopeNumbers.has(source)) throw new Error(`Source PR #${source} is absent from the exact release scope`);
  }

  const migrationPaths = await run("git", [
    "diff",
    "--name-only",
    `${parsed.metadata.previousCommit}..${parsed.metadata.targetCommit}`,
    "--",
    "apps/worker/drizzle/*.sql",
  ]);
  return {
    version: input.version,
    candidateCommit,
    previousCommit: parsed.metadata.previousCommit,
    targetCommit: parsed.metadata.targetCommit,
    notesPath,
    databaseMigrations: migrationPaths
      .split("\n")
      .filter(Boolean)
      .map((file) => path.basename(file))
      .sort(),
  };
}

const manifestInputSchema = z.object({
  version: z.string(),
  candidateCommit: shaSchema,
  workerUrl: z.string().url(),
  dashboardUrl: z.string().url(),
  workflowVersion: z.string().min(1),
  databaseMigrations: z.array(z.string()),
  testRun: z.string().url(),
  approvedBy: z.string().min(1),
  now: z.date(),
});

export function createReleaseManifest(input: z.infer<typeof manifestInputSchema>) {
  const value = manifestInputSchema.parse(input);
  return {
    version: value.version,
    releasedAt: value.now.toISOString(),
    commit: value.candidateCommit,
    environment: "artur-production" as const,
    workerDeployment: { url: value.workerUrl },
    dashboardDeployment: { url: value.dashboardUrl },
    workflowDefinitionVersion: value.workflowVersion,
    databaseMigrations: value.databaseMigrations,
    testRun: value.testRun,
    approvedBy: value.approvedBy,
  };
}
