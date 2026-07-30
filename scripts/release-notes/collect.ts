import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { classifyPullRequest } from "./classify.js";
import type { ReleaseCollection, ReleasePullRequest } from "./types.js";

const execFileAsync = promisify(execFile);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const ghPullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.object({ name: z.string() })),
  mergedAt: z.string(),
  mergeCommit: z.object({ oid: shaSchema }).nullable(),
  url: z.string().url(),
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
  const previousCommit = await resolveRef(run, options.previousRef);
  const targetCommit = await resolveRef(run, options.targetRef);
  if (!(await isAncestor(run, previousCommit, targetCommit))) {
    throw new Error(`${options.previousRef} is not an ancestor of ${options.targetRef}`);
  }

  const raw = await run("gh", [
    "pr",
    "list",
    "--repo",
    options.repository,
    "--state",
    "merged",
    "--limit",
    "1000",
    "--json",
    "number,title,body,labels,mergedAt,mergeCommit,url",
  ]);
  const rows = z.array(ghPullSchema).parse(JSON.parse(raw));
  const unique = new Map<number, ReleasePullRequest>();
  for (const row of rows) {
    if (!row.mergeCommit) continue;
    const sha = row.mergeCommit.oid;
    if (!(await isAncestor(run, sha, targetCommit))) continue;
    if (await isAncestor(run, sha, previousCommit)) continue;
    unique.set(row.number, {
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      labels: row.labels.map((label) => label.name),
      mergedAt: row.mergedAt,
      mergeCommitSha: sha,
      url: row.url,
    });
  }

  const classified = [...unique.values()]
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number)
    .map(classifyPullRequest);
  if (classified.length === 0) throw new Error("The selected Git range contains no merged pull requests");

  return {
    repository: options.repository,
    previousCommit,
    targetCommit,
    included: classified.filter((pr) => pr.included && pr.customerFacing),
    internal: classified.filter((pr) => pr.included && !pr.customerFacing),
    skipped: classified.filter((pr) => !pr.included),
    warnings: classified.flatMap((pr) => pr.warnings),
  };
}
