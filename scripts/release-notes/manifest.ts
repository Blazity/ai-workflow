import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { collectRelease } from "./collect.js";
import { validateReleaseNotes } from "./render.js";
import type { ApprovedSourceRelease } from "./types.js";

const execFileAsync = promisify(execFile);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export type ManifestRunner = (command: string, args: string[]) => Promise<string>;

const defaultRun: ManifestRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
};

const pullForCommitSchema = z.array(z.object({ number: z.number().int().positive() }));
const reviewedPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  mergedAt: z.string().min(1),
  mergeCommit: z.object({ oid: shaSchema }),
  baseRefName: z.string(),
  reviewDecision: z.string().nullable(),
  reviews: z.array(
    z.object({
      state: z.string(),
      author: z.object({ login: z.string().min(1) }).nullable(),
    }),
  ),
  files: z.array(z.object({ path: z.string() })),
});

async function requireAncestor(
  run: ManifestRunner,
  ancestor: string,
  descendant: string,
  message: string,
): Promise<void> {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
  } catch {
    throw new Error(message);
  }
}

export async function validateApprovedSourceRelease(
  input: { version: string; markdown: string; mainRef: string },
  deps: { run?: ManifestRunner } = {},
): Promise<ApprovedSourceRelease> {
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
  await requireAncestor(
    run,
    candidateCommit,
    input.mainRef,
    `Release candidate ${candidateCommit} is not part of ${input.mainRef}`,
  );
  await requireAncestor(
    run,
    parsed.metadata.targetSourceCommit,
    input.mainRef,
    `Release target ${parsed.metadata.targetSourceCommit} is not part of ${input.mainRef}`,
  );
  await requireAncestor(
    run,
    parsed.metadata.previousSourceCommit,
    parsed.metadata.targetSourceCommit,
    "Release metadata previousSourceCommit is not an ancestor of targetSourceCommit",
  );

  const candidateMarkdown = await run("git", ["show", `${candidateCommit}:${notesPath}`]);
  if (candidateMarkdown !== input.markdown) {
    throw new Error("Current release notes differ from the reviewed candidate");
  }

  const pullCandidates = pullForCommitSchema.parse(
    JSON.parse(
      await run("gh", [
        "api",
        `repos/${parsed.metadata.repository}/commits/${candidateCommit}/pulls`,
        "--method",
        "GET",
      ]),
    ),
  );
  if (pullCandidates.length !== 1) {
    throw new Error("Release candidate must be introduced by exactly one merged pull request");
  }
  const pullRequest = reviewedPullSchema.safeParse(
    JSON.parse(
      await run("gh", [
        "pr",
        "view",
        String(pullCandidates[0].number),
        "--repo",
        parsed.metadata.repository,
        "--json",
        "number,state,mergedAt,mergeCommit,baseRefName,reviewDecision,reviews,files",
      ]),
    ),
  );
  if (
    !pullRequest.success ||
    pullRequest.data.state !== "MERGED" ||
    pullRequest.data.mergedAt.length === 0 ||
    pullRequest.data.mergeCommit.oid !== candidateCommit ||
    pullRequest.data.baseRefName !== "main"
  ) {
    throw new Error("Release candidate is not the merge commit of a pull request into main");
  }
  if (pullRequest.data.reviewDecision !== "APPROVED") {
    throw new Error("Release-note pull request has no approved review");
  }
  if (pullRequest.data.files.length !== 1 || pullRequest.data.files[0].path !== notesPath) {
    throw new Error("Release-note pull request is not docs-only");
  }
  const approvedBy = [
    ...new Set(
      pullRequest.data.reviews
        .filter((review) => review.state === "APPROVED")
        .flatMap((review) => (review.author ? [review.author.login] : [])),
    ),
  ].sort();
  if (approvedBy.length === 0) throw new Error("Release-note pull request has no approved review");

  const collected = await collectRelease(
    {
      repository: parsed.metadata.repository,
      previousRef: parsed.metadata.previousSourceCommit,
      targetRef: parsed.metadata.targetSourceCommit,
    },
    { run },
  );
  const collectedScope = [...collected.included, ...collected.internal]
    .map((pullRequest) => ({ number: pullRequest.number, category: pullRequest.category }))
    .sort((a, b) => a.number - b.number);
  if (JSON.stringify(parsed.scopeEntries) !== JSON.stringify(collectedScope)) {
    throw new Error("Exact release scope does not match pull requests collected from the Git range");
  }

  return {
    version: input.version,
    previousSourceCommit: parsed.metadata.previousSourceCommit,
    targetSourceCommit: parsed.metadata.targetSourceCommit,
    notesPath,
    releaseNotesPullRequest: pullRequest.data.number,
    releaseNotesApprovedBy: approvedBy,
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
  initiatedBy: z.string().min(1),
  productionApprovedBy: z.array(z.string().min(1)).min(1),
  releaseNotesPullRequest: z.number().int().positive(),
  releaseNotesApprovedBy: z.array(z.string().min(1)).min(1),
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
    initiatedBy: value.initiatedBy,
    productionApprovedBy: [...new Set(value.productionApprovedBy)].sort(),
    releaseNotesReview: {
      pullRequest: value.releaseNotesPullRequest,
      approvedBy: [...new Set(value.releaseNotesApprovedBy)].sort(),
    },
  };
}
