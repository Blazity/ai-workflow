# Repository checks and the auto-fix loop

Status: design and delivery plan. Written 2026-08-19, after the invocation-ceiling
fix (`e94f5d7c`) landed and was proven on our own production.

This document supersedes the polling proposal in
[`2026-08-18-watch-external-ci-to-green.md`](./2026-08-18-watch-external-ci-to-green.md).
That note assumed we would have to poll the provider pipeline. We do not: an
event-driven trigger for failing CI already exists. What is left is smaller and
different from what that note describes.

---

## 1. How it works today, in plain words

A workflow that writes code does its work inside a disposable sandbox. Before it
pushes a branch and opens a pull request, it can run a list of shell commands in
that sandbox. If they pass, the branch is published. If they fail, publication is
blocked. That is the gate the product calls "Pre-PR checks".

Those commands do not live in the workflow. They live in one organization-wide
configuration edited on a separate page (`/checks`), versioned like a document,
with a history and a restore button. A workflow node called "Pre-PR checks" says
only "run whatever is configured", plus one number: how many times an AI agent may
try to repair a failure before the gate gives up.

That last part is the piece nobody can see. When a command fails, the node quietly
starts an agent inside the same sandbox, hands it the failing output, lets it edit
the code, then re-runs everything. Up to three times, by default. On the canvas
this is one box with a subtitle reading "3 fix cycles". There is no second box, no
edge, no progress. A user watching a run sees a node that says "running" for fifty
minutes.

After the pull request is open, the story stops. The provider (GitHub Actions,
GitLab CI) runs its own pipeline. Nothing in the product reacts to it. If that
pipeline goes red, a human has to notice, copy the failure into a ticket comment,
and move the ticket back into the AI column to start a completely new run.

That is the state a client is in right now: a merge request open, unit tests red,
and the only available answer being "paste the log into the ticket by hand".

---

## 2. What we learned the hard way

Evidence, so none of this is re-litigated later.

**The gate used to die silently at 300 seconds.** Every check, every setup
command, and every repair cycle ran inside a single `await` in a single durable
step. Vercel kills one function invocation at 300 s. A tenant whose checks take
longer lost the entire node, with no command output and no cause: the run reported
`terminated`. Their real batch was 810 s. Fixed in `e94f5d7c` by launching batches
detached and polling them across ticks. Proven on our production: run
`wrun_01M0CVHRXFY98A7F7EYHK3X94S` kept the checks node alive for **3157 seconds in
one attempt**, against a baseline (`wrun_01M0CGC9GEMEBC3THA2DNBECNJ`) that died at
358631 ms.

**Green runs were checking nothing.** The gate reads a single global
configuration. A tenant whose configuration lists two repositories, both with an
empty setup phase, gets checks that either fail on the first command or, worse,
exit 0 without doing anything. That tenant's configuration is now on version 12,
which reads "No pre-PR checks configured. The gate is disabled."

**There is no setup phase in practice, so people paste one into the commands.**
Reading one tenant's twelve configuration versions from the last 48 hours shows
exactly this. Their `unify-frontend` entry is four bare commands with no install
step at all:

```
yarn lint:ci
yarn check-upsolve-css
yarn typecheck
yarn test
```

Their `arthur-scope` entry puts the install into check number one, so checks two
through six run anyway and fail for a reason that has nothing to do with the code:

```
cd scope/app_plane && uv sync --frozen && uv pip install -r ../lint_requirements.txt
./scripts/openapi_client_utils.sh generate python && ./scripts/openapi_client_utils.sh install python
cd scope/app_plane/app && uv run black . --check
cd scope/app_plane/app && uv run python -m mypy . --strict --ignore-missing-imports ...
python scripts/check_alembic_single_head.py
cd scope/app_plane && ./local-dev/run_tests.sh -n 4
```

`uv` does not exist in the sandbox image at all, and command five needs `python`
on the path rather than `python3`. Meanwhile a third entry, for `arthur-engine`,
shows someone rediscovering the setup phase by hand, in production, twice:

```
curl -LsSf https://astral.sh/uv/install.sh | sh
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
```

Twelve versions in two days is not a configuration problem. It is a missing
product feature.

**The repair loop is expensive and blind.** Every cycle re-runs the entire batch,
setup included, not just the command that failed (`pre-pr-checks.ts`,
`runner.ts:206-244`). Three cycles of an 810 s batch is over 54 minutes against a
100 minute run budget. Observed on our own fixture: three full cycles and 52
minutes burned on `cd: genai-engine/ui: No such file or directory`. There was
nothing for an agent to repair, and it could not tell.

**Nothing owns the pull request after it opens.** `failedChecks` exists only in
the trigger and dispatch layer. A run started from a ticket never sees it.

---

## 3. What already exists (do not rebuild it)

This matters, because the obvious plan is bigger than the real one.

- **The trigger exists.** `trigger_pr_checks_failed`, registered at
  `block-registry.ts:414-448`, schema at `schema.ts:151-171`. It fires on a GitHub
  `check_run` completed with a failing conclusion and on a GitLab pipeline hook
  with `status: "failed"`. Both providers, signature-verified at the webhook route.
- **Log retrieval exists.** `VCSAdapter.getCheckRunResults(prId)` returns entries
  with an optional `logs` field (`adapters/vcs/types.ts:86-113`). GitHub downloads
  the Actions job log; GitLab reads the job trace. It is already called from
  `fetch-pr-context.ts:176`.
- **The whole workflow exists as a template.** `reviewFixAfterPrDefinition` in
  `templates.ts:169-260` wires exactly the shape we want:
  `trigger_pr_checks_failed` and `trigger_pr_review` into `prepare_workspace` into
  `fetch_pr_context` into `fix_agent` into `run_pre_pr_checks` into
  `finalize_workspace` into `post_pr_comment`.
- **Pushing onto the open pull request exists.** `createOrFindPullRequest`
  (`repository-prs.ts:183-201`) finds the existing PR and returns it rather than
  opening a second one.
- **Re-triggering after our own fix push is intended.** `workflow-push-suppression`
  only suppresses push-derived triggers as self-echo; a checks-failed event comes
  from the CI producer, so the loop closes naturally.
- **The canvas can already draw a bounded repair loop.** `loop`, `branch` and a
  `generic_agent` with a writable workspace are enough (see Step 2).

So the event-driven loop is not a research project. Three concrete things stop it
from working.

---

## 4. The three gaps, precisely

### Gap 1: the trigger is a no-op as shipped

`checkNames` defaults to `[]`, and an empty list makes `selectEligibleEvent` drop
the event silently (`dispatch-trigger.ts:359`). It is an **allow-list of exact
names**, not an ignore-list and not a pattern. The template hardcodes `["CI"]`,
which matches no job name any real tenant uses.

Two consequences worth stating plainly: a user who adds this trigger and saves it
gets a workflow that never fires and no explanation; and "ignore Meticulous" is
not expressible as an ignore, only as an exhaustive list of everything that is not
Meticulous.

### Gap 2: there is no per pull-request cap

`enforceTriggerRateLimit` is keyed on `{definitionId, nodeId}`
(`trigger-rate-limit.ts:8-11`) over fixed UTC windows of a minute, hour, day or
month. That is a global valve on a trigger node. It cannot express "at most two
attempts on this pull request", and it has a bad failure mode for our purpose: one
noisy repository exhausts the window for every other repository sharing the
definition.

The loop needs a counter keyed on the pull request, persisted, that survives
invocations and resets when the pull request's head moves for a reason that is not
our own fix.

### Gap 3: the fix loop is invisible and unaddressable

The repair agent is a hidden `while` loop inside the checks node. It cannot be
seen, re-ordered, given a different model, pointed at different instructions, or
skipped for one repository. The only control is a number from 0 to 5.

---

## 5. The plan

### Step 0 (done): turn the hidden loop off by default

`MAX_PRE_PR_FIX_CYCLES` and the block default move from 3 to 0. The pre-PR gate
goes back to being a gate: it runs commands and blocks publication. Repair moves
to where the evidence is, after the pull request is open. A graph that wants the
old behaviour can still author a number per node.

This also removes a real failure mode for free. `agent.ts` refuses to run repair
when there is no pinned write-capable harness profile, which is what produced the
client comment "The Pre-PR repair process could not be launched." With zero cycles
that guard is never reached.

Verify: a run whose checks fail reports the failing command, exit code and output,
and blocks publication, in one cycle, with no agent started.

### Step 1: reusable, named script sets per repository

Rename the concept. It is not "pre-PR checks", it is **repository checks**: a named
set of commands attached to a repository, usable wherever the product runs
commands.

Shape:

- Each repository gets named **phases** rather than one flat list. At minimum
  `setup` (install toolchains and dependencies, failure aborts the batch) and one
  or more named check groups (`lint`, `typecheck`, `test`, `build`), each a list of
  commands.
- A check group is addressable by name, so a workflow node can say "run `lint` and
  `typecheck` for every changed repository" while the post-PR loop says "run
  `test`".
- Setup phases become shareable, because the evidence above is three repositories
  pasting the same `uv` installer with three different sets of typos.

Constraints that must survive: the configuration stays versioned and append-only
in `pre_pr_check_config_versions` (`schema.ts:834-840`), existing configurations
keep working unchanged (an existing flat `commands` list reads as one unnamed
group), and the root schema stays `.strict()`.

Open question for the product: does a check group belong to the organization
(today's model) or to a workflow definition? Today one global configuration serves
every definition, which is why one tenant's admin disabling the gate silently
disabled it for everything.

### Step 2: make the fix agent a node on the canvas

Both of Filip's first two requirements are the same requirement: what happens
should be visible where the workflow is drawn.

The good news, verified against the graph model rather than assumed: **the canvas
can already express this. Nothing new has to be built to draw it.**

- `loop` is a control block with ports `continue` and `exhausted`, a bounded
  `maxAttempts` of 1 to 20, an `onExhaust` policy and a typed carry
  (`schema.ts:794-808`). A loop body may contain several nodes, and the graph
  validator requires `continue` to return to the loop while forbidding cycles
  anywhere else (`schema.ts:2797-2813`).
- `branch` has ports `true` and `false` and reads an expression, so
  `steps.checks.output.ok` routes a failing batch (`workflow-graph.ts:78`).
- `generic_agent` takes a free-text `prompt` from a binding
  (`block-registry.ts:717`) and, with `workspaceMode: read_write`, edits and
  commits in the same workspace. It is the only agent block that accepts arbitrary
  text; `fix_agent` has typed slots (`reviewFeedback`, `reviewResults`) and no slot
  for a failing command.

So the visible loop is authored, not coded:

```
loop (maxAttempts: 2)
  -> run_pre_pr_checks
  -> branch on steps.checks.output.ok
       true  -> finalize_workspace
       false -> generic_agent (workspaceMode: read_write,
                               prompt bound to steps.checks.output.summary)
                -> back to loop.continue
loop.exhausted -> post_pr_comment / update_ticket_status
```

That is what Step 0 unlocks. With the internal repair off, the checks node reports
and the graph decides. The user sees three boxes and two edges instead of one box
with a subtitle, can point the repair node at a cheaper model, can change its
instructions, and can delete it for one workflow without touching another.

Real work that remains, and it is small:

1. **A palette template for this shape**, so nobody has to wire five nodes by
   hand. The existing `reviewFixAfterPrDefinition` is the post-PR sibling of it.
2. **Per-node live iteration display.** The canvas already shows a per-node run
   status with a glow and a pulsing dot (`flow-editor.tsx:271-384`), but the
   subtitle is static text from `nodeSummary` (`blocks.ts:64,179`) and inner
   iterations exist only in the trace. A loop that is on its second of two
   attempts should say so on the canvas.
3. **Decide what the repair node actually receives.** Today the only bindable
   failure material is `summary`, a formatted string. If that turns out to be too
   thin, the checks output needs a structured `failures` array rather than a new
   block.

### Step 3: the post-PR auto-fix workflow

Deploy the existing template, then close the three gaps.

The loop: CI fails, the trigger fires, `fetch_pr_context` pulls the failing job
names **and their logs**, the fix agent commits onto the same branch,
`finalize_workspace` pushes to the open pull request, CI re-runs, and if it is
still red the trigger fires again.

Work items, smallest first:

1. **Make `checkNames` usable.** Support an empty list meaning "any failing
   check", add an explicit ignore-list for the Meticulous case, and surface a
   validation warning in the editor when a saved trigger cannot ever fire.
2. **Per pull-request attempt cap.** A new counter keyed on
   `(definitionId, provider, repoPath, prNumber)` with a configurable maximum,
   default 2. On exhaustion: stop, post one comment on the pull request saying the
   automatic fix gave up and why, and do not start a run. The counter resets when
   a human pushes to the branch.
3. **Deploy and prove it**, on our own production first, on a repository whose CI
   we control and can make fail on demand.

Explicitly out of scope: polling the provider pipeline. The event-driven path
makes it unnecessary.

---

## 6. Sequencing

The order is forced by what blocks what.

1. Step 0 ships with the next release. It is a default change and it removes a
   live failure mode for the client.
2. Step 1 unblocks the client's two configuration-only repositories
   (`unify-frontend` and `arthur-scope` both need nothing but a setup phase) and
   should ship before anyone is asked to write another twelve config versions.
3. Step 3 items 1 and 2 are independent of Step 1 and can run in parallel.
4. Step 2 is mostly authoring, not engineering, and it becomes possible the moment
   Step 0 ships. Ship the template early; the live iteration display and the
   structured failures output can follow.

Nothing here is released to a client tenant before it has been reproduced and
proven on our own production, on a fixture repository shaped like theirs.

---

## 7. Risks and open questions

- **Turning the hidden loop off makes some green runs red.** That is the point:
  a check that exits 0 having done nothing stops passing. It will still read as a
  regression to whoever is watching. It has to be communicated before the release,
  not after.
- **A fix push re-runs CI, which costs the client money and minutes.** The per-PR
  cap is the only thing standing between a bad prompt and an expensive loop. It is
  a requirement, not a nicety.
- **The fix agent will sometimes be wrong on the pull request.** Post-PR repair
  pushes commits a reviewer has to read. Whether the loop should push directly or
  propose is a product decision, not an engineering one.
- **Sandbox environment variables do not exist.** The sandbox is created and
  commands are run without any `env` (`sandbox/manager.ts:90`,
  `pre-pr-checks/runner.ts:204`, `:273`), and the config schema has no field for a
  secret. Any repository whose install needs a token cannot be checked at all
  today except by pasting the token into the command text, which writes it to the
  database and the logs. This blocks one client repository outright and needs its
  own ticket.
- **Which checks are gating.** Reading the provider's required-checks set is more
  honest than an allow-list maintained by hand, and it is not in this plan.
