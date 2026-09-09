Status: current
Last-verified: 2026-09-09

# ADR-004: Gates and required CI

Decision status: Accepted

Source: decisions D8 and D11 and assumption A1 of
[docs/plans/2026-09-09-architecture-restructure.md](../plans/2026-09-09-architecture-restructure.md).
Measurements cited below come from
[docs/research/2026-09-09-architecture-audit.md](../research/2026-09-09-architecture-audit.md),
section 6; they are not re-measured here.

## Context

The repository has checks and no enforcement. Audit section 6 lists what runs
where: `git diff --check` and the scoped typechecks run in `verify:changed` at
pre-push only; the unit suites (worker sharded into four, dashboard,
workflow-sdk) run in CI on every pull request behind an aggregate job named
`ci`; the validators run through `build:ci`; `verify-deployment-identity` and
the e2e suites run nightly, off the PR path. The worker has no linter, the
dashboard's `next lint` is defined and never run, and there is no import
boundary or unused-code tool at all.

None of it blocks a merge. `main` has no branch protection and no ruleset, by
recorded decision, so a red `ci` job stops nothing, and `core.hooksPath` makes
the local gate advisory: `AGENTS.md` says so itself, and `--no-verify` is one
flag away.

The cheapest large improvement is therefore a repository setting rather than
code. It has one precondition. A required check that never reaches a verdict
is worse than no required check: GitHub leaves the pull request on a permanent
"Expected", and within a week the admin bypass becomes the normal way to
merge. So the aggregator has to be made reportable before it is required, and
the bypass has to be narrow enough that using it is visible.

## Decision

### 1. One shape for every gate

Gates are dependency-free Node scripts under `scripts/gates/`, each with a
header stating why it exists and what makes it exit non-zero, a baseline JSON
where a ratchet is needed, a test under `scripts/ci/`, and one entry each in
`verify:changed` and `.github/workflows/ci.yml`. Third-party tools
(dependency-cruiser, knip, oxlint) are invoked by those scripts rather than
configured separately, so the ladder has one shape and one place to read.

### 2. The ladder

One line per gate: what it observes, and whether it carries a baseline.

| Gate | Observes | Baseline | Lands in |
|---|---|---|---|
| `git diff --check` | whitespace errors and conflict markers in the diff | no | exists (pre-push), stage 1 adds it to CI |
| typecheck | TypeScript across worker, dashboard and root scripts | no | exists (`source-checks`) |
| unit tests | worker (4 shards), dashboard, workflow-sdk | no | exists |
| `build:ci` | pre-sandbox config, local skills, MCP contract, Nitro build | no | exists |
| generated files current | MCP contract, prompt drift, carry-schema drift, and from stage 4 the block catalog (`gen:blocks --check`) | no | three exist, block catalog in stage 4 |
| import boundaries and cycles | dependency-cruiser with the tier rules of ADR-001 plus `no-circular` | yes, keyed by tier pair and distinct file cycle count | stage 1 |
| unused files, exports, dependencies | knip | yes, today's count | stage 1 |
| lint | oxlint on `apps/worker`, `apps/dashboard`, `scripts` and `packages` when present, `correctness` deny, `suspicious`, `perf` and `pedantic` warn, `style`, `restriction` and `nursery` off | yes, warning count ratcheted | stage 1 |
| workflow bundle imports | executable Node imports inside workflow VM code, distinguished from import-like text in string literals (AIW-325) | no | stage 1 |
| `no-resurrected-paths` | a path a completed stage deleted reappearing after a rebase | yes, a path list that starts empty and each stage appends to | stage 1 |
| `package-contracts` | every `packages/*/package.json` has a `description` | no | stage 1 |
| `docs-status` | `Status:` and `Last-verified:` headers, a `current` file older than 90 days, a current file unreachable in two hops | no | stage 2 |
| `check-deps-consistency` | the pnpm catalog and the four dependency rules | no | stage 3 |
| `single-schema-version` | a reinstated `schemaVersion === 1` branch | no | stage 3b |
| `transactions-in-repositories` | `.transaction(` outside `db/repositories` | no | stage 7 |
| `db-client-fence` | `db/client` imports outside `db/` | yes, 357 ratcheted down | stage 7 |

Baselines that ratchet are driven to zero and deleted in stage 11, at which
point the rules become hard. When a new root enters the lint scope, its
existing debt is stamped into the baseline once, in the stage that adds the
root, with the count recorded in that commit; from then on the baseline only
shrinks. The lint ratchet holds `correctness` at deny and `suspicious`, `perf`
and `pedantic` at warn, while `style`, `restriction` and `nursery` are off:
those three encode taste rather than defect (declaration order, magic numbers,
identifier length, key sorting, ternaries), they carried about 115000 of the
123000 warnings the ratchet once tracked, and because every added file grew
them, they failed the gate for stages that introduced no defect at all.

### 3. The aggregator must be reportable

A required check has to end green or red on every pull request that can touch
it. "Reportable" means all four of these, and all four are load bearing:

- The job runs with `if: always()`. Without it, a failed or cancelled
  dependency leaves the job skipped, and GitHub counts a skipped required
  check as satisfied.
- It `needs` every source job.
- It checks each needed job's result by name and fails when that result is not
  `success`, printing the job name and the result it reported. A summary that
  only says "something failed" costs the reader a hunt through four job logs,
  and a name-by-name check also catches a job added to `needs:` that nothing
  asserts on.
- No `paths:` or `paths-ignore:` filter stands between a pull request and this
  job. A workflow filtered out by paths never creates its check runs at all,
  so a required check that is never created leaves the pull request on
  "Expected" forever. A docs-only pull request must still get a green `ci`.
  Path filtering belongs on the expensive jobs behind the aggregator (as in
  stage 5b), never on the aggregator or on the workflow trigger.

Job names are stable, because the ruleset references the string `ci` by name.

### 4. `ci` is required on `main` through a ruleset, with no standing bypass

The requirement is a repository branch ruleset targeting `main`, not classic
branch protection. Classic protection cannot express A1. Its only escape hatch
for a required status check is the repository-wide `enforce_admins` boolean,
which is on for every administrator or off for all of them; it has no per
account exemption, and its `restrictions` list governs who may push, not who
may merge past a red check. A ruleset does express it. The shape is:

- `enforcement: "active"`, target `branch`, condition `ref_name` including
  `~DEFAULT_BRANCH`;
- one `required_status_checks` rule whose `required_status_checks` parameter
  holds exactly one entry, `context: "ci"`;
- `bypass_actors` with exactly one entry: `actor_type: "User"`, the named
  account, `bypass_mode: "always"`. No `OrganizationAdmin` and no
  `RepositoryRole` entry, so there is no standing exemption by role: a ruleset
  binds administrators unless they are listed by name.

Every use of the bypass opens a Jira issue recording what was merged and why,
mirroring the `--no-verify` audit rule in `AGENTS.md`: the bypass is auditable,
so a merge that skipped `ci` is never reported as a merge that passed it.

PR #358 already merged the credential-free bundle and the validators into CI.
The ruleset itself was created on 2026-09-09 (id 22668605, name "main requires
ci") with exactly the shape above. AIW-313 is closed by it.

### 5. A behavioural gate is planned, not present

Static gates observe structure, not behaviour, and the failure mode they miss
is the one this repository actually has: green locally, broken only on Vercel.
Stage 5b adds a CI job that, for pull requests touching
`apps/worker/src/engine/**`, `apps/worker/src/db/**` or `packages/**`, deploys
a preview and runs both non-dry canaries (`e2e/replay/preview-canary.ts`,
`e2e/harness-profiles/preview-canary.ts`), dispatching one run that executes
at least one `"use step"` and one WDK webhook function. That job joins the
`ci` aggregator's `needs`, which is why its path filter lives on the job and
not on the workflow. Until 5b exists, stages 3 and 5 run the same canaries by
hand as their definition of done.

## Consequences

- A red merge stops being possible without a recorded bypass. The delivery
  gates document keeps its sentence that a green run is evidence of
  correctness and never proof that a red candidate could not land, because a
  bypass still exists; what changes is that using it leaves a trace.
- Every new CI job that a stage adds must either join the aggregator's `needs`
  or be irrelevant to the merge decision. A job outside `needs` is
  decoration.
- The aggregator's own timeout (5 minutes) is not a gate: it waits on jobs
  with 30-minute timeouts. A shard that hits its ceiling reports `failure` and
  the aggregator reports it by name.
- A cancelled dependency (a superseded push, a manual `gh run cancel`) is not
  `success`, so `ci` reports red rather than green. That is deliberate: the
  concurrency group cancels superseded runs, and the run that matters is the
  one for the current head SHA.
- The ruleset is a repository setting. It is not in the diff, it is not
  reviewed, and it can be turned off without a commit. ADR-004 is the record
  of what it is supposed to be; a periodic check against
  `gh api repos/Blazity/ai-workflow/rulesets`, followed by
  `gh api repos/Blazity/ai-workflow/rulesets/<id>` for the rule's `context`
  and the `bypass_actors` list, is the only way to know it still is.
  `gh api repos/Blazity/ai-workflow/branches/main/protection` is not that
  check: it reports classic protection only, so it answers 404 while a ruleset
  is enforcing, and a 404 there is evidence of nothing.

## Options considered

**Require the four source jobs individually instead of the aggregator.**
Rejected. `unit-worker` is a matrix of four shards that report as four
separate contexts, so the required list would carry seven entries, and every
job a stage adds or renames would need a ruleset edit made by an admin
outside the pull request. The aggregator keeps the required list at one string
and moves the composition into the diff.

**Leave `main` unprotected and rely on the pre-push hook.** Rejected. The hook
is opt-in through `core.hooksPath`, scoped to changed paths, and bypassable
with `--no-verify`; `AGENTS.md` already calls it advisory. It is a fast local
signal, not a merge gate.

**Require `ci` with a standing admin bypass.** Rejected by the owner (A1). A
standing bypass makes the gate advisory again the first time a shard is flaky,
and nothing records that it happened. One named actor plus a Jira issue per
use keeps the escape hatch and makes it visible.

**Require `ci` before making the aggregator reportable.** Rejected as the
ordering that produces the failure the pre-mortem names: a non-reportable
aggregator leaves every pull request on a permanent "Expected", and the bypass
becomes the default path within a week.
