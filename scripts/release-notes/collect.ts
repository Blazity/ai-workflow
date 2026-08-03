import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { classifyPullRequest } from "./classify.js";
import type { ReleaseCollection, ReleasePullRequest } from "./types.js";

const execFileAsync = promisify(execFile);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const ghPullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.object({ name: z.string() })),
  merged_at: z.string().nullable(),
  merge_commit_sha: shaSchema.nullable(),
  html_url: z.string().url(),
});

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

const defaultRun: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
};

async function resolveRef(run: CommandRunner, ref: string): Promise<string> {
  return shaSchema.parse((await run("git", ["rev-parse", "--verify", `${ref}^{commit}`])).trim());
}

async function isAncestor(run: CommandRunner, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
      return false;
    }
    throw error;
  }
}

export async function collectRelease(
  options: { repository: string; previousRef: string; targetRef: string },
  deps: { run?: CommandRunner } = {},
): Promise<ReleaseCollection> {
  const run = deps.run ?? defaultRun;
  const repository = repositorySchema.parse(options.repository);
  const previousCommit = await resolveRef(run, options.previousRef);
  const targetCommit = await resolveRef(run, options.targetRef);
  if (!(await isAncestor(run, previousCommit, targetCommit))) {
    throw new Error(`${options.previousRef} is not an ancestor of ${options.targetRef}`);
  }
  const exactRange = new Set(
    (await run("git", ["rev-list", `${previousCommit}..${targetCommit}`]))
      .split("\n")
      .filter(Boolean),
  );

  const raw = await run("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/pulls?state=closed&per_page=100`,
  ]);
  const rows = z.array(z.array(ghPullSchema)).parse(JSON.parse(raw)).flat();
  const unique = new Map<number, ReleasePullRequest>();
  for (const row of rows) {
    if (!row.merged_at || !row.merge_commit_sha) continue;
    const sha = row.merge_commit_sha;
    if (!exactRange.has(sha)) continue;
    unique.set(row.number, {
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      labels: row.labels.map((label) => label.name),
      mergedAt: row.merged_at,
      mergeCommitSha: sha,
      url: row.html_url,
    });
  }

  const classified = [...unique.values()]
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number)
    .map(classifyPullRequest);
  if (classified.length === 0) throw new Error("The selected Git range contains no merged pull requests");

  return {
    repository,
    previousCommit,
    targetCommit,
    included: classified.filter((pr) => pr.included && pr.customerFacing),
    internal: classified.filter((pr) => pr.included && !pr.customerFacing),
    skipped: classified.filter((pr) => !pr.included),
    warnings: classified.flatMap((pr) => pr.warnings),
  };
}
