import type { PRFile } from "../adapters/vcs/types.js";
import type { PreSandboxPromptAddition } from "../sandbox/context.js";
import type { AgentWorkflowInput } from "./agent-input.js";

/** The pull request a review run must judge. Serializable, so it survives the
 *  step boundary. */
export interface PullRequestChangeSetTarget {
  provider: "github" | "gitlab";
  repoPath: string;
  prNumber: number;
  prUrl: string;
  headRef: string;
  headSha: string;
  baseRef: string;
}

export const PULL_REQUEST_CHANGE_SET_TITLE = "Pull request change set";

// Prompt-budget protection. The review checkout is the agent's only source of
// code, and this section its only source of the change, so the caps are
// generous; whatever they drop is stated in the rendered text so the agent
// never mistakes a subset for the whole change.
const MAX_LISTED_FILES = 200;
const MAX_FILE_PATCH_CHARS = 20_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;
// Below this a slice is a hunk fragment rather than a reviewable diff, so the
// file is reported as omitted instead.
const MIN_FILE_PATCH_CHARS = 500;
// A provider error can carry a whole response body, which is the one piece of
// rendered text that does not come from a bounded source.
const MAX_REASON_CHARS = 500;

const SCOPE_NOTE =
  "The review checkout is a detached snapshot of the head commit with no base branch, " +
  "so it cannot produce this diff itself. Treat the change set below as the definition " +
  "of what this pull request changed.";

/**
 * The change set target for a run, or null when the run is not reviewing a pull
 * request. Ticket and plan-approved runs review a workspace the agent built
 * itself and need no provider diff.
 */
export function pullRequestChangeSetTarget(
  entry: AgentWorkflowInput,
): PullRequestChangeSetTarget | null {
  if (entry.kind !== "pr_trigger") return null;
  const { pr } = entry;
  return {
    provider: pr.provider,
    repoPath: pr.repoPath,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    headRef: pr.headRef,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
  };
}

/**
 * Assemble the review agent's change set addition. Runs in workflow scope so a
 * provider failure degrades the addition to a stated "diff unavailable" instead
 * of failing the run: a review without the diff is still worth more than no
 * review, as long as the agent is told what it is missing.
 */
export async function assembleReviewChangeSetAddition(
  target: PullRequestChangeSetTarget,
): Promise<PreSandboxPromptAddition> {
  try {
    return await fetchPullRequestChangeSetStep(target);
  } catch (error) {
    const { isRunControlError } = await import("./run-control-error.js");
    if (isRunControlError(error)) throw error;
    return renderPullRequestChangeSet(target, {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fetch the pull request's changed files and render them. Rendering happens
 * inside the step so the bounded prompt text crosses the step boundary rather
 * than an unbounded file list.
 */
export async function fetchPullRequestChangeSetStep(
  target: PullRequestChangeSetTarget,
): Promise<PreSandboxPromptAddition> {
  "use step";
  const { createRepositoryVCS } = await import("../lib/vcs-runtime.js");
  const { hasPRFilesCapability } = await import("../adapters/vcs/types.js");
  const vcs = createRepositoryVCS({
    provider: target.provider,
    repoPath: target.repoPath,
    baseBranch: target.baseRef,
  });
  if (!hasPRFilesCapability(vcs)) {
    // Permanent for this provider, so render it here rather than throwing into
    // step retries that cannot change the outcome.
    return renderPullRequestChangeSet(target, {
      ok: false,
      reason: `${target.provider} cannot list pull request files`,
    });
  }
  const files = await vcs.listPRFiles(target.prNumber);
  return renderPullRequestChangeSet(target, { ok: true, files });
}

export function renderPullRequestChangeSet(
  target: PullRequestChangeSetTarget,
  changeSet: { ok: true; files: PRFile[] } | { ok: false; reason: string },
): PreSandboxPromptAddition {
  const body = changeSet.ok
    ? renderChangeSet(changeSet.files)
    : renderUnavailable(changeSet.reason);
  return {
    target: ["review"],
    title: PULL_REQUEST_CHANGE_SET_TITLE,
    content: `${renderIdentity(target)}\n\n${SCOPE_NOTE}\n\n${body}`,
  };
}

function renderIdentity(target: PullRequestChangeSetTarget): string {
  return [
    `- Provider: ${target.provider}`,
    `- Repository: ${target.repoPath}`,
    `- Pull request: #${target.prNumber}`,
    `- URL: ${target.prUrl}`,
    `- Head: ${target.headRef} at ${target.headSha}`,
    `- Base: ${target.baseRef}`,
  ].join("\n");
}

function renderUnavailable(reason: string): string {
  return `### Changed files

The change set could not be fetched from the provider: ${reason.slice(0, MAX_REASON_CHARS)}. The diff is unavailable for this review.

Review the checked-out head commit as best you can and say in your feedback that the pull request diff was unavailable. Do not report that nothing changed.`;
}

function renderChangeSet(files: PRFile[]): string {
  if (files.length === 0) {
    return "### Changed files\n\nThe provider reported no changed files for this pull request.";
  }
  const listed = files.slice(0, MAX_LISTED_FILES);
  const unlisted = files.length - listed.length;
  const listHeading =
    unlisted > 0
      ? `### Changed files (${files.length}, first ${listed.length} listed)`
      : `### Changed files (${files.length})`;
  const list = listed.map(
    (file) =>
      `- \`${file.path}\` ${file.changeType} +${file.additions} -${file.deletions}`,
  );
  if (unlisted > 0) {
    list.push(
      `- [TRUNCATED] ${unlisted} further changed files are not listed, to fit the prompt budget.`,
    );
  }

  const diffs: string[] = [];
  let used = 0;
  let omitted = unlisted;
  for (const file of listed) {
    if (!file.patch) {
      diffs.push(
        `#### ${file.path}\n\nNo textual diff available for this file (binary, or too large for the provider).`,
      );
      continue;
    }
    const budget = Math.min(MAX_FILE_PATCH_CHARS, MAX_TOTAL_PATCH_CHARS - used);
    if (budget < MIN_FILE_PATCH_CHARS) {
      omitted++;
      continue;
    }
    const patch = file.patch.slice(0, budget);
    used += patch.length;
    const note =
      patch.length < file.patch.length
        ? `\n\n[TRUNCATED] The diff for ${file.path} is cut off after ${patch.length} characters, to fit the prompt budget.`
        : "";
    diffs.push(`#### ${file.path}\n\n${patch}${note}`);
  }
  if (omitted > 0) {
    diffs.push(
      `[TRUNCATED] The diffs for ${omitted} further changed files are omitted, to fit the prompt budget. ` +
        "This section is a subset of the change: do not treat a file you cannot see here as unchanged.",
    );
  }

  return `${listHeading}\n\n${list.join("\n")}\n\n### Diff\n\n${diffs.join("\n\n")}`;
}
