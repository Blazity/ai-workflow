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

const PULLS_FOR_COMMIT_PAGE_SIZE = 100;
const pullForCommitSchema = z.array(z.object({ number: z.number().int().positive() }));
const reviewedPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  mergedAt: z.string().min(1),
  mergeCommit: z.object({ oid: shaSchema }),
  baseRefName: z.string(),
  reviewDecision: z.string().nullable(),
  files: z.array(z.object({ path: z.string() })),
});
const reviewPagesSchema = z.array(
  z.array(
    z.object({
      state: z.string(),
      user: z.object({ login: z.string().min(1) }).nullable(),
    }),
  ),
);

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

  // A commit merged into main belongs to one pull request, so there is nothing
  // to page through here and the page size is stated rather than inherited from
  // the API default of 30. Stating it is what makes a full page recognisable:
  // without that, "more pull requests than fit on a page" and "exactly this many
  // pull requests" arrive as the same number and the refusal below would name a
  // count nobody measured.
  const pullCandidates = pullForCommitSchema.parse(
    JSON.parse(
      await run("gh", [
        "api",
        `repos/${parsed.metadata.repository}/commits/${candidateCommit}/pulls?per_page=${PULLS_FOR_COMMIT_PAGE_SIZE}`,
        "--method",
        "GET",
      ]),
    ),
  );
  if (pullCandidates.length >= PULLS_FOR_COMMIT_PAGE_SIZE) {
    throw new Error(
      `Cannot count the pull requests introducing release candidate ${candidateCommit}: GitHub filled its page of ${PULLS_FOR_COMMIT_PAGE_SIZE} and the rest was never read. Release from a commit that belongs to one pull request into main.`,
    );
  }
  if (pullCandidates.length !== 1) {
    throw new Error(
      `Release candidate must be introduced by exactly one merged pull request, but GitHub associates ${pullCandidates.length} with ${candidateCommit}`,
    );
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
        "number,state,mergedAt,mergeCommit,baseRefName,reviewDecision,files",
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
  // `files` comes back from the same call and carries the same cap of 100. It
  // needs no cap handling: a capped read reports 100, never the 1 this check
  // demands, so truncation can only refuse a release and the refusal it prints
  // is true of a pull request that large.
  if (pullRequest.data.files.length !== 1 || pullRequest.data.files[0].path !== notesPath) {
    throw new Error("Release-note pull request is not docs-only");
  }
  // Read the reviews on their own rather than through `gh pr view --json
  // reviews`, which stops at 100 and says nothing: the approver names below are
  // the release record, and a record missing a name reads exactly like a record
  // of a smaller review.
  const reviews = reviewPagesSchema
    .parse(
      JSON.parse(
        await run("gh", [
          "api",
          "--paginate",
          "--slurp",
          `repos/${parsed.metadata.repository}/pulls/${pullRequest.data.number}/reviews?per_page=100`,
        ]),
      ),
    )
    .flat();
  const approvedBy = [
    ...new Set(
      reviews
        .filter((review) => review.state === "APPROVED")
        .flatMap((review) => (review.user ? [review.user.login] : [])),
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
