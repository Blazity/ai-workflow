# Design note: watch the external PR/MR CI pipeline to green

Status: proposal, not implemented. Recommendation: file as its own ticket.

## Problem

Today the workflow bot runs the dashboard-configured pre-PR checks inside the Run
Workspace, then pushes the branch and opens the PR/MR. Once the PR is open, the
provider (GitHub Actions / GitLab CI) runs its own pipeline. The bot never looks
at that pipeline. When the provider pipeline fails (for reasons the in-sandbox
pre-PR checks did not or could not catch), nobody feeds that failure back into a
fix loop. A client hit exactly this: an MR opened, GitLab's `lint` /
`Lint-Docker-Frontend` jobs failed, and the run had already reported success.

The related fix in this PR stops one silent-skip (a pre-PR check that exits 0
while its dependencies are not installed now fails loudly). Watching the external
pipeline is the broader, separate capability the client also asked for and is
intentionally out of scope here.

## Proposed behavior

After `open_pr` publishes a PR/MR, a new optional block (working name
`watch_ci_pipeline`) polls the provider's pipeline for the pushed head SHA until
it reaches a terminal state, then branches on the result:

1. Resolve the pipeline for the PR's head SHA via the VCS adapter
   (`apps/worker/src/adapters/vcs/*`): GitHub check runs / commit statuses for a
   ref; GitLab pipelines + jobs for a ref.
2. Poll on an interval with a bounded deadline, driven by the run budget's
   remaining duration (reuse `ctx.observeBudget()` so a stuck pipeline cannot
   outlive the run). Poll cadence and max wait are block params.
3. Ignore non-gating checks. Meticulous is explicitly excluded (it posts its own
   visual-review status that must not gate the bot). Maintain an ignore-list of
   check/job names (and/or contexts), defaulting to a Meticulous matcher, so the
   watcher only waits on and reacts to gating jobs.
4. Terminal outcomes:
   - all gating jobs succeeded -> `ok: true` (branch to done / Slack / ticket move);
   - one or more gating jobs failed -> collect each failed job's name + log tail
     and feed them into the existing fix loop (same shape the pre-PR runner uses
     for `runFixAgent`: a prompt with the failing job output, then re-push and
     re-watch), capped by a max-attempts param and the run budget;
   - pipeline never reaches terminal state before the deadline -> surface a
     bounded, transparent failure (budget/deadline), never a silent pass.

## Where it plugs in

- New block type registered in `apps/worker/src/workflow-definition/block-registry.ts`
  and a matching case in the interpreter/agent block switch (`agent.ts`).
- New VCS adapter methods: `getPipelineForRef(headSha)` / `listCheckRunsForRef`
  returning a normalized `{ name, status, conclusion, logsUrl }[]` across GitHub
  and GitLab, plus a way to fetch a failed job's log tail.
- Reuse the fix-agent machinery already in `pre-pr-checks/runner.ts`
  (`runFixAgent`, `buildFixPrompt`) so external-CI failures and pre-PR failures
  share one repair path and one budget accounting.
- Ignore-list config (Meticulous by default) alongside the pre-PR checks config
  so it is dashboard-managed and versioned like the rest of the gate config.

## Risks / open questions (for the ticket)

- Polling long pipelines against the per-invocation limit: this must be
  budget-bounded and heartbeat-safe; a pipeline that runs for an hour cannot pin
  the run. Confirm the WDK invocation model tolerates the poll loop.
- Re-push after a fix re-triggers the provider pipeline, which re-triggers the
  watcher: needs a clear max-attempts and loop-boundary so it cannot ping-pong.
- Which statuses gate (required checks only vs all): should read the provider's
  branch-protection / required-checks set where available rather than guessing.
- Meticulous-style checks that are `pending` forever must be treated as ignored,
  not as "still running", or the watcher waits on them until the deadline.

## Recommendation

File as its own ticket (its own block type, adapter surface, and budget/loop
design). Do not fold it into the missing-dependency pre-PR fix, which is a
narrow, self-contained correctness fix.
