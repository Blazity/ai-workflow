import type { ReviewLedgerState } from "../../adapters/vcs/types.js";
import type { AgentWorkflowInput } from "../agent-input.js";
import {
  buildReviewLedgerDurableState,
  type ReviewLedgerGuardWorkItem,
  type SettledThread,
} from "../helpers/review-ledger.js";
import { settleReviewLedgerStep } from "./review-ledger-settle.js";

/** Evidence quotes are short; a file this size is not a source file the model
 * legitimately quoted, and the whole content lands in the durable step output. */
const LEDGER_EVIDENCE_MAX_BYTES = 200_000;

/** Answer the review threads on the no-change terminal through one durable step. */
export async function settleReviewLedgerThreads(
  ctx: { entry: AgentWorkflowInput; reviewLedger?: ReviewLedgerState },
  headSha: string | null,
): Promise<SettledThread[]> {
  if (ctx.entry.kind !== "pr_trigger" || !ctx.reviewLedger) return [];
  const pr = ctx.entry.pr;
  return settleReviewLedgerStep({
    ledger: buildReviewLedgerDurableState(ctx.reviewLedger),
    headSha,
    prId: pr.prNumber,
    provider: pr.provider,
    repoPath: pr.repoPath,
    baseBranch: pr.baseRef,
  });
}

/**
 * Read one repository file out of the workspace so a claimed already_addressed
 * quote can be checked against the branch. Working tree first (that is what the
 * agent looked at), `git show HEAD:` as the fallback for a path the tree does
 * not hold. Null for anything unreadable, which the verifier treats as evidence
 * that is not there.
 */
export async function readLedgerEvidenceFileStep(
  sandboxId: string,
  repoLocalPath: string,
  filePath: string,
): Promise<string | null> {
  "use step";
  // The path comes from the model, so it never escapes the repository it named.
  if (
    filePath.length === 0 ||
    filePath.startsWith("/") ||
    filePath.split("/").includes("..")
  ) {
    return null;
  }
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const worktree = await sandbox.runCommand("cat", [`${repoLocalPath}/${filePath}`]);
  if (worktree.exitCode === 0) {
    return (await worktree.stdout()).slice(0, LEDGER_EVIDENCE_MAX_BYTES);
  }
  const head = await sandbox.runCommand("git", [
    "-C",
    repoLocalPath,
    "show",
    `HEAD:${filePath}`,
  ]);
  if (head.exitCode !== 0) return null;
  return (await head.stdout()).slice(0, LEDGER_EVIDENCE_MAX_BYTES);
}

/**
 * Tell the reviewer on the PR that this run died before it could answer their
 * threads. Silence here is indistinguishable from the dead webhook Arthur lived
 * with for weeks, so the note is posted even though the run is already failing.
 */
export async function postReviewLedgerFailureNoteStep(payload: {
  pr: { provider: "github" | "gitlab"; repoPath: string; baseRef: string; prNumber: number };
  runId: string;
  reason: string;
  unsettledAliases: string[];
  /** "threads": the run knew what it owed the reviewer. "pre_feed": it had no
   * ledger, either because it died before reading the feed or because the review
   * opened no thread, so the note must not imply anything about threads. */
  variant: "threads" | "pre_feed";
  /** What this run pushed to the PR's own repository before it died, if
   * anything. A run that pushed a fix and then lost the checks block must not
   * leave a note the reviewer reads as "your branch was never touched". */
  pushedHead: string | null;
  /** Threads settlement already replied in. A run that answered everyone and
   * then died owes the reviewer that fact, not an apology for silence. */
  answeredCount: number;
  /** Where the unsettled aliases live, so the note names files a reviewer can
   * open instead of run-internal labels. Narrow on purpose: this whole payload
   * is a step input, so it is serialized into the durable event log. */
  workItems: ReviewLedgerGuardWorkItem[];
}): Promise<{ posted: boolean; error?: string }> {
  "use step";
  const { loadVcsRuntimePort } = await import("../internal/ports.js");
  const { pr, runId, reason } = payload;
  const { createRepositoryVCS } = await loadVcsRuntimePort();
  const adapter = createRepositoryVCS({
    provider: pr.provider,
    repoPath: pr.repoPath,
    baseBranch: pr.baseRef,
  });
  if (payload.variant === "pre_feed") {
    // Deliberately silent about threads: this run either never read the feed or
    // read one with nothing in it, and it cannot tell the reviewer which.
    const body = [
      `AI Workflow run \`${runId}\` failed on this pull request: ${reason.slice(0, 300)}.`,
      payload.pushedHead ? `It pushed \`${payload.pushedHead}\` before failing.` : null,
    ]
      .filter((line): line is string => line !== null)
      .join(" ");
    try {
      await adapter.postRunFailureNote({ prId: pr.prNumber, runId, body });
      return { posted: true };
    } catch (err) {
      return { posted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const { postRunFailureNoteForRun } = await import("./review-ledger-settle.js");
  return postRunFailureNoteForRun({
    adapter,
    prId: pr.prNumber,
    runId,
    reason,
    unsettledAliases: payload.unsettledAliases,
    workItems: payload.workItems,
    pushedHead: payload.pushedHead,
    answeredCount: payload.answeredCount,
  });
}
