Status: current
Last-verified: 2026-09-12

# Repository scripts: config reference

Repository scripts is the generic successor to pre-PR checks: instead of one
flat list of "commands run before a PR", each repository declares named
groups of commands (`test`, `lint`, `verify`...). Any block can select one
group, several, or all of them; the publication gate is just the block that,
by default, requires every group.

This document describes the config contract implemented by
`apps/worker/src/pre-pr-checks/config.ts` (`repoScriptsConfigSchema`). The
contract is additive: the older pre-PR checks shape (`prePrCheckConfigSchema`,
a flat `commands: string[]` per repository) still works, both as its own
schema and as an input that `repoScriptsConfigSchema` accepts and normalizes.
The engine that executes these groups and the blocks that call it now exist:
`run_scripts` runs the groups a node names, and `run_pre_pr_checks` runs the
gating selection and records the publication gate.

## Canonical shape

```json
{
  "repositories": [
    {
      "provider": "gitlab",
      "repoPath": "acme/api",
      "setup": ["curl -LsSf https://astral.sh/uv/install.sh | sh"],
      "env": ["GITLAB_UNIFY_FRONTEND_TOKEN"],
      "groups": {
        "test": {
          "commands": ["uv run pytest"]
        },
        "lint": {
          "commands": ["uv run ruff check ."]
        },
        "format": {
          "commands": ["uv run ruff format ."],
          "restoreTree": false
        },
        "verify": {
          "commands": ["uv run mypy ."],
          "extends": ["test", "lint"]
        }
      },
      "gateGroups": ["verify"],
      "commandTimeoutMinutes": 15
    }
  ],
  "batchTimeoutMinutes": 30
}
```

Field reference:

- `repositories[].provider`: `"github"` or `"gitlab"`.
- `repositories[].repoPath`: trimmed, non-empty.
- `repositories[].setup`: commands that provision the workspace (toolchain
  installs the sandbox image does not ship, such as `uv`). Optional, defaults
  to `[]`.

  They run once per sandbox, as a visible substep of workspace creation rather
  than inside the first check batch, and a failing setup command fails the
  `prepare_workspace` block with the command named. That is the honest place
  for it: no code edit repairs a missing toolchain, so it is not a check
  result, and reporting it at provisioning time stops the run before an agent
  works for twenty minutes against a workspace that could never have been
  verified. Later batches find the marker the run writes (keyed on a hash of
  this array) and skip straight to their commands.

  **When it runs, and what that costs.** Workspace creation runs setup only
  when the definition being executed contains a block that can run scripts
  (`run_scripts`, `run_pre_pr_checks`, `run_checks`). A research or triage
  graph that never runs a command does not pay for a toolchain it will not
  use, and, more to the point, a setup command broken by an upstream mirror
  cannot brick a workflow that would never have touched it.

  For a definition that does run scripts, the price is paid per repository per
  workspace: a batch to run the commands, a poll to watch it, and a collect to
  read the result, all journaled. A run that parks for clarification and comes
  back rebuilds its workspace, so it verifies the marker again and re-runs
  setup if the new sandbox does not carry one. Keep `setup` to provisioning
  that is genuinely missing from the image; a minute of `uv sync` here is a
  minute on every workspace this definition creates.

  The blast radius is the whole run, not the batch: setup failing means no
  workspace, and a run with no workspace has nothing to hand the agent.
- `repositories[].env`: **names** of worker environment variables to expose
  to the commands in this repository, e.g. `GITLAB_UNIFY_FRONTEND_TOKEN`.
  Each name must match `/^[A-Z][A-Z0-9_]*$/`. This is a list of names only;
  values are never stored in this config.

  A name also has to be on the operator's allowlist, the comma separated
  `PRE_PR_CHECKS_ALLOWED_ENV` variable on the worker. Configuration names a
  variable; only the operator decides the worker may hand its value to a
  tenant's command, so an unset or empty allowlist forwards nothing. Saving a
  configuration that names a variable outside the allowlist is rejected with
  those names in the message, and batch start enforces the same rule again, so
  an allowlist shrunk after a save still fails loudly rather than quietly
  keeping a withdrawn variable alive. A name that is allowlisted but currently
  unset saves fine and fails at run time: a save is a statement of intent.

  The allowlist is read from the worker's own environment, which means a
  change to `PRE_PR_CHECKS_ALLOWED_ENV` reaches nothing until the worker is
  **redeployed**. Adding a name in the hosting dashboard and immediately
  retrying the save reproduces the same rejection, with the same message,
  because the running deployment still holds the old list. Redeploy first,
  then save. The same applies in the other direction: a name removed from the
  allowlist keeps working until the redeploy lands.

  `env` belongs to the named-groups shape. The legacy flat `commands` entry
  predates it and does not accept the key.
- `repositories[].groups`: a map of at least one named group. A group name
  must match `/^[a-z][a-z0-9-]*$/` and be at most 40 characters (`test`,
  `lint`, `verify`, not `Test` or `test_unit`).
  - `groups[name].commands`: the commands this group runs on its own.
    Defaults to `[]`, but a group needs at least one command **or** at least
    one `extends` entry; a group with neither is rejected.
  - `groups[name].restoreTree`: whether the runner puts back the tracked files
    this group's commands modified. Defaults to `true`, and an absent key means
    `true`. Set it to `false` for a group whose job **is** to edit the tree: a
    formatter run as `ruff format` or `prettier --write`, a codegen refresh.
    Its changes are then left in place and reported in the block's `dirtied`
    output, so a graph can go on to commit them, typically by branching on
    whether `dirtied` is empty.

    Two traps, and three different failures between them. A
    `restoreTree: false` group in the publication gate's own selection leaves
    the workspace dirty at the moment the gate is minted, and minting requires
    a clean tree, so the checks block itself fails with `Run Workspace is not
    clean for <repo>` naming the drifted paths. That is the author's choice to
    make and not the schema's.

    The second trap is a `run_scripts` node that runs such a group **after**
    the checks gate has already passed, and which code you get depends on what
    happened to the files. Left uncommitted, they are what the publication
    boundary's own inspection sees, and it refuses the tree with
    `workspace_unverifiable`, naming the drifted paths and saying which of them
    the scripts wrote rather than the agent. This is the case you will actually
    meet. Committed by a later node, the tree is clean again but the
    tracked-file fingerprint no longer matches the one the gate recorded, so
    Finalize fails with `workspace_changed`. Put mutating groups before the
    gate.
  - `groups[name].extends`: names of sibling groups (in the same repository
    entry only) whose commands run first. `extends` can be used to build a
    composite group, e.g. `verify` above runs `test`'s commands, then
    `lint`'s commands, then its own. A command that appears in more than one
    extended group only runs once, at its first occurrence. The `extends`
    graph must be a DAG: `verify extends test`, `test extends verify` is
    rejected as a cycle.
- `repositories[].gateGroups`: which group names the publication gate
  requires. Omit it and the gate requires every group declared on that
  repository. An **empty array is a validation error**, not a way to say
  "none": `[]` would run zero groups and pass every run forever with nothing
  verified, so the schema refuses it and omission is the only way to say
  "all".
- `repositories[].commandTimeoutMinutes`: optional per-command timeout
  override (whole minutes, at least 1).
- `batchTimeoutMinutes`: the checks phase's budget for one run, in whole
  minutes, between 1 and 180. Defaults to `PRE_PR_CHECK_BATCH_MAX_MINUTES`,
  which ships at 60. The upper bound is the sandbox's, not a preference: the
  ceiling is added to a sandbox lifetime, and a number large enough to overflow
  that lifetime buys a workspace that disappears instead of a batch that
  reports.

  Two things about it are easy to get wrong. It is a **run** budget, not a
  per-batch one: four repositories draw from the same minutes in turn, and the
  fourth is bounded by what the first three left. And it is **not** deducted
  from the run's duration budget: checks time is charged to this ceiling alone,
  so a nineteen minute test suite no longer spends two thirds of a thirty
  minute run budget that exists to pay for the agent's work.

  The workspace sandbox is created with a lifetime of `JOB_TIMEOUT_MS` plus
  this ceiling, and the number is fixed at workspace creation. Editing
  `batchTimeoutMinutes` mid-run therefore does nothing for a run already in
  flight, **in either direction**. Raising it cannot help, because the sandbox
  was sized against the old number and handing a batch a longer bound than its
  sandbox will live trades a reported timeout for an unexplained
  disappearance. Lowering it does not take effect either: the run keeps
  spending the ceiling it published at workspace creation, so an operator who
  edits the number to cut a run short is not cutting it short. Cancel the run
  for that; the edit applies to the next one.

  A repository that runs out of ceiling reports a failure naming the budget
  rather than a check result, because nothing verified it. The walk stops
  there: every repository the run never reached has its selected groups
  recorded as `not_run`, and one failure names the whole skipped slice instead
  of repeating the same paragraph per repository.

  **Total wall-clock.** Because the two budgets are separate, a run can last
  its duration budget *plus* this ceiling. A 30 minute duration budget with the
  default 60 minute ceiling is a run that may legitimately occupy a dispatch
  slot for 90 minutes. Read the duration budget as *agent* time, and size the
  pool against the sum rather than against the duration budget alone: this is
  the number to reach for when a queue of runs is waiting longer than the
  duration budgets say it should.

Every reference (`extends`, `gateGroups`) must name a group that exists on
the *same* repository entry; an unknown reference is a validation error that
names the offending reference. A cycle in `extends` is also a validation
error, naming the cycle path, e.g. `verify -> test -> verify`.

**Which repositories a node runs.** The publication gate (`run_pre_pr_checks`)
runs only repositories this run actually changed: verifying an untouched
repository proves nothing about the diff and spends the ceiling doing it. A
`run_scripts` node is the opposite and does it deliberately: it runs its
selected groups on **every** repository in the workspace, changed or not,
because a generic script run is not a verification of the diff. A codegen or
formatter group therefore reaches repositories the agent never edited, which
is usually what its author wants and is occasionally a surprise worth
knowing about before it lands in `dirtied`.

**Do not edit the configuration while a run is in flight.** The configuration
is versioned, and the publication boundary re-reads the *current* version and
compares it against the one recorded when the gate was minted. Save an edit
between those two moments and the run fails at Finalize with
`configuration_changed`, naming both versions, however green its checks
were. Nothing is lost and nothing is published; the next run picks up the new
version. The same applies to the ceiling: `batchTimeoutMinutes` is read once,
at workspace creation, so an edit mid-run changes nothing for the run in
flight. Make configuration edits between runs, or expect to re-run the ticket.

## Profiles: groups live on the repository now

Script groups no longer live in one global versioned blob. Each repository in
the repository catalog carries a **profile**, and every change to it appends a
**profile version** recording the groups, the gate group selection, who changed
it and why. What a run executes is composed out of those profiles
(`apps/worker/src/db/repositories/repository-catalog.ts`,
`getCurrentCheckConfiguration`), one entry per repository whose profile carries
script groups. The canonical shape above is unchanged: a profile stores exactly
the repository entry this document describes, verbatim, and the engine
normalizes it at the same boundary it always did.

**Why it moved.** The global blob had one version counter for every repository,
and the publication gate compares the version its checks ran under with the
version now. So saving repository B's groups failed a run in flight on
repository A at Finalize with `configuration_changed`, having verified nothing
about A. The gate now also records, per repository, the **checks version** that
repository's checks were launched under, and Finalize compares those.

The checks version is not the profile version. A profile version is minted by
every save; the checks version moves only when the script groups or the gate
group selection actually change. Editing a repository's description, its rules
or its relationships therefore mints a profile version and fails no run.

The versions are pinned when the checks are **launched**, not when they pass:
they ride out of the one step that loads the configuration
(`loadPrePrCheckConfigStep`) and are handed to the gate. An edit that lands
while the checks are running is caught at Finalize rather than silently adopted,
and nothing on the gate path performs a second read.

Finalize then compares, per repository:

- a repository the gate did not record is not checked (it has no profile, or it
  joined the workspace after the gate was minted and records its own version
  when its own checks pass);
- a repository whose checks version moved fails the run, naming the repository
  and both versions;
- a gate checkpointed before profiles existed carries no per-repository record
  at all and still recovers and still passes. Both shapes are accepted
  indefinitely.

**What the legacy screen still does.** On the catalog path the per-repository
check is precise: editing **this** repository's groups while a run on **this**
repository is in flight fails that run at Finalize, and editing another
repository's does not. A save on the legacy Scripts screen still appends a blob
row and still moves the **global** counter, which every run in flight compares,
so a save there fails every run in flight until stage G removes the page. What
that save no longer does is move another repository's checks version: the screen
submits the whole configuration on every click, and the fan-out is a no-op for a
repository whose stored script groups and gate group selection are identical to
the incoming ones, so it writes nothing and mints no version for a repository
the operator did not actually change.

**The migration.** The build-time seed
(`apps/worker/scripts/db-seed-repository-catalog.ts`) copies the newest stored
blob into one repository row per entry (source `migrated`) plus one profile
version 1 per row, actor `migration`. A row created by that copy is **disabled**
unless the allowlist or a definition pin already granted the repository: the
checks configuration says what to run if the agent may touch a repository, never
that it may. The copy is idempotent, so a redeploy creates nothing new.

**Who may be dispatched.** The catalog decides this on exactly four paths
today: a pull request or merge request event arriving on the GitHub or GitLab
webhook, the legacy post-PR gate those two fall back to, a manual dispatch of a
pull request, and an MCP dispatch (with save and publish reporting the same
answer for a graph's pins). Each of those entry points reads one catalog
snapshot per HTTP request, cron tick or MCP call and asks
`isRepositoryDispatchable` (`apps/worker/src/services/dispatch/repo-allowlist.ts`),
which answers from the enabled set alone. While the catalog is **not activated**
it answers yes for everything, which is how a deployment that has never opened
the Repositories page keeps behaving; once activated, only enabled rows pass, a
refusal says the repository is not enabled in the catalog, and the delivery is
recorded as `ignored_repository_not_enabled` rather than as a provider mismatch.
A pending event that was queued while the deployment was busy is asked again on
the tick that drains it, so a repository disabled in the meantime is dropped
rather than dispatched late. A workflow definition's repository pin is a
**selection inside** the catalog and no longer extends dispatch, so events from a
repository nobody enabled are refused whatever the graph pins; MCP authoring
reports exactly that list as `pinnedRepositoriesNotEnabled` on a save and a
publish.

**Who may be touched INSIDE a run.** The same catalog, read once. A run's first
step (`loadRunStartSettingsStep`,
`apps/worker/src/engine/steps/run-start-settings.ts`) loads the settings
snapshot and the list of enabled repository keys and puts both on the run
context; every step and block below it answers from that list through
`mayRunTouchRepository` / `filterRunRepositories`
(`apps/worker/src/engine/support/repository-access.ts`), which are synchronous
and side effect free, so no loop over a repository listing costs a database
read. Repository discovery drops a repository the list does not carry, and a
direct action on one fails the run with `Refusing to ... : this repository is
not enabled in the repository catalog`. Enabling a row on the Repositories page
is therefore the whole action: there is no variable to keep in step with it.

Two consequences worth stating plainly:

- **A run finishes under the rules it started with.** The list is frozen at run
  start, so an operator who disables a repository at 14:03 does not move a run
  that started at 14:00; the next run sees the change. This is the same promise
  `appliesToRunsInFlight: "next run"` makes for settings, and it is what keeps a
  replay of a suspended run from taking a different branch than its first
  execution did.
- **A pin never widens access.** A workflow definition's repository pin is a
  selection inside the catalog for a run exactly as it is for dispatch: a graph
  that pins a repository nobody enabled cannot reach it, whichever way the run
  started.

A ticket-driven run still chooses WHICH repositories it works on inside the run,
from discovery and the expansion protocol; what changed is that it chooses from
the catalog's enabled rows rather than from an environment variable.

**What still reads the blob.** The `pre_pr_check_config_versions` table is read
by the legacy Scripts screen alone: its history list and its restore, plus two
fields the composed configuration still takes from the newest row, the global
version counter the publication gate has recorded on every run ever minted and
the deployment-wide `batchTimeoutMinutes`. Its `repositories` payload is read by
nothing. Saving on that screen appends a blob row **and** fans the save out to
one profile version per repository it names, dropping the script groups of any
repository it stopped naming; the Repositories page replaces the screen, and the
cleanup stage drops the table.

## Getting a repository into the catalog: import

Repositories are added by importing them from the connected provider, not by
typing a path. The screen asks the worker twice.

**Preview** (`POST /api/v1/repository-catalog/import-preview`, open to every
dashboard role) lists what the installation exposes and marks each entry with
whether the catalog already holds it. The listing is the repository picker's own
service, through the one-minute cache that service owns
(`listCachedRepositoryDirectory` in
`apps/worker/src/services/repository-discovery/directory.ts`), so the picker,
the preview and the commit share one listing instead of asking every provider
three times for one admin's sequence of clicks. The cache is process local: a
second worker instance asks again, and a repository created at the provider
appears within a minute. Each candidate carries both its **key**
(`provider:owner/name`, cased down, the thing the catalog compares on) and its
**path** (the provider's own casing, the thing a row stores).

**Commit** (`POST /api/v1/repository-catalog/import`, owner or admin) takes the
keys and one `enabled` flag for the whole selection, and is checked against the
same listing rather than against the keys it was handed. Every submitted key
ends in exactly one of three places, and the three mean different things:
`imported` counts the rows this call created, `alreadyPresent` names the keys
the catalog already held, and `skipped` names the keys a **successful** listing
of their provider did not contain, which means the installation does not expose
that repository any more.

A provider that could not be listed at all is refused rather than reported:
if any submitted key belongs to a provider whose status is `error`, the whole
call answers **503 `provider_unavailable`** and writes nothing. "We could not
ask" is not "it is not there", and reporting the first as the second is how an
admin reloads the screen, sees most of their repositories gone from the
selection, and re-imports them later as duplicates. The insert is the seed's
insert
(`importConnectedRepositoryCatalogEntries` in
`apps/worker/src/db/repositories/repository-catalog.ts`), which is one statement
with a case-insensitive `NOT EXISTS` guard and `ON CONFLICT DO NOTHING`, because
neon-http has no interactive transactions. Importing twice therefore creates
nothing and, in particular, does not re-enable a repository somebody switched
off. Rows are created with `current_profile_version` 0, source `imported`, and
`enabled` exactly as the admin asked.

**No suggestion runs on an import.** Importing says the catalog knows about a
repository; describing it is a separate, deliberate click.

## Suggesting a profile

`POST /api/v1/repository-catalog/suggest` (owner or admin) proposes a
description, rules and script groups for **one** repository, and writes nothing.
The proposal comes back to the caller and dies there unless the admin saves it
through the profile route, which is the only path that mints a version.

**What the model reads.** A profile source
(`apps/worker/src/adapters/vcs/repository-profile-source.ts`, with a GitHub and
a GitLab implementation beside it) returns the default branch, the provider's
description, the README, the root manifests it recognises, the NAMES of the
lockfiles, the CI definitions and the languages. Lockfile content is never read:
it is megabytes of hashes saying nothing the manifest beside it did not. The
bundle is cut to about 32 KB of text, README first and CI second, manifests
last, and every cut is recorded in the bundle **and stated in the prompt**, so a
model reading half a README writes a shorter description instead of a confident
one. A repository with no README and no manifests still yields a bundle from the
provider metadata alone, and still gets a proposal.

Two things the source refuses to paper over. A **404 on the repository's own
metadata** is the repository being gone from the provider, not a missing README,
so it is read first and alone and raises `RepositoryMissingAtProviderError`
rather than being swallowed: every other read would answer 404 too, and a
deleted repository would otherwise come back as a bundle of empty strings and be
described confidently from nothing. And the GitLab root listing is **one page of
100 entries**, so a full page is recorded as a truncation and said out loud in
the prompt, because a root with more files than that can hold a manifest the
read never saw.

**The README is prose, not instructions.** The system prompt says so, and says
that commands come only from the manifests and the CI definitions. That is a
mitigation, not a boundary: the real defence is that a proposal is never a
profile. What comes back carries `source: "suggested"` and a `provenance` on
every group, is a LIST of proposed groups rather than the stored entry the
profile route accepts, and cannot be posted back as a save without deliberate
work in the dashboard. Two kinds of group never even reach the admin: one whose
name the checks engine could not resolve (`invalid_name`, never slugified into
something the model did not write) and one carrying a command shaped like fetch
and run (`remote_execution`, `curl ... | sh` and its relatives). Both come back
in `droppedGroups` with their commands, because a screen that cannot tell "this
repository declares no tests" from "a proposed group was refused" teaches people
not to trust the suggestion.

**Which model.** The same one the `call_llm` block uses,
`CALL_LLM_DEFAULT_MODEL` in `packages/harness/model-catalog.ts`, with the
provider inferred from the model id. Stated plainly because the plan asked for
something slightly different: it asked for "the cheapest model of the default
harness profile", and neither half of that is derivable here. The default
harness profile manifest names exactly one model (`DEFAULT_MODELS.claude`, the
dearest of the four), and the repo holds no price table at all: prices are
fetched at runtime from `CODEX_PRICING_URL`. Resolving "cheapest" would have put
an HTTP dependency on the suggestion path and made the model non-deterministic.
The model actually used is recorded on every row, so the cost page reports what
ran rather than what was configured.

**Bounds: there are two, and what matters is their sum.** The profile read is
capped at **60 seconds for the whole bundle**
(`REPOSITORY_PROFILE_DEADLINE_MS`), as one `AbortSignal.timeout` shared by every
request the source makes rather than a timeout per request: a dozen sequential
requests each under their own bound would add up to minutes. The model call is
capped at **90 seconds** (`REPOSITORY_SUGGESTION_TIMEOUT_MS`). The worst case is
therefore **150 seconds**, and that total is the number to check when either
bound moves.

The worker declares **no route-level maximum duration**, and there is no
convention for one: `apps/worker/vercel.json` carries only crons, the Nitro
config declares no route rules, and the vercel preset bundles the routes into
one function, so a declaration would move every route's ceiling together. The
platform default of 300 seconds per invocation already covers the 120 seconds
the plan asked for, and 150 sits well inside it. A path that could reach the
platform ceiling would surface as an opaque kill instead of the retryable
failure these bounds exist to produce.

**A cap per repository.** More than **10 suggestions in 60 minutes** for one
repository answers **429 `suggestion_rate_limited`** with the seconds to wait,
in the body and in the `Retry-After` header. The wait is computed from the
oldest row in the window, so an admin who spent the budget fifty minutes ago
waits ten minutes and not an hour. The cap is checked after the role check and
before the provider is touched, and a refusal records nothing: it is not a call,
it spent nothing, and a history filling with refusals would bury the rows that
cost money. It is counted from the recorded rows, so unlike the in-flight join
it holds across restarts and across worker instances.

**A second click joins the first.** A process-local map keyed by repository id
holds the call in flight, so two clicks are one provider call and one recorded
row. Process local means **per worker instance**: two instances answering two
clicks make two calls, which is accepted, because the case this exists for is
one admin clicking twice on one screen.

**Every call is recorded exactly once**, in `repository_suggestions` (migration
0061): repository, actor and label, model, outcome (`proposed`, `timeout`,
`malformed`, `failed`, `missing`), the tokens the provider reported, an error
message and a timestamp. One insert on every path, written after the work, so a
failure can never produce two rows for one click. Timeouts and malformed answers
cost what a proposal costs and are recorded for exactly that reason.

The recorded `error` is the provider's own message, prefixed with the phase it
came out of (`profile source:` or `provider call:`); the error the **caller**
gets back is a code and nothing else, because a provider message quotes the
request it failed on and a dashboard is not where that belongs. Before the
message is stored it is redacted (`sk-`, `ghp_`, `github_pat_`, `glpat-`,
`Bearer `, and any run of 32 or more base64 or hex characters become
`[redacted]`) and then cut to 2000 characters.

`cost_usd` is written null, as the `call_llm` block leaves its own usage: the
cost page prices a page of rows at once rather than making each call fetch a
price table. A row whose **tokens are null is unpriced, not free**: the call
ended before the provider reported anything (a timeout, a repository missing at
the provider, a bundle that never loaded), and a cost page must render those as
unpriced rather than as 0.00, because zero would say the call was free and a
timeout against a provider that had already begun work is not.

**Every error these routes can answer.** The dashboard reads the code, not the
message.

| Code | HTTP | Retryable | What happened |
|---|---|---|---|
| `provider_unavailable` | 503 | yes | An import named a key whose provider could not be listed. Nothing was written. |
| `invalid_script_group_name` | 400 | no | A profile save carried a group name the checks engine cannot resolve. Refused, never repaired. |
| `suggestion_rate_limited` | 429 | yes, after `retryAfterSeconds` | This repository has had 10 suggestions in the last hour. Nothing was spent or recorded. |
| `repository_missing_at_provider` | 404 | no | The provider does not have the repository any more. Recorded as `missing`, no model call, no spend. |
| `profile_source_timed_out` | 503 | yes | The 60 second profile read deadline fired. Recorded as `timeout`. |
| `profile_source_failed` | 502 | no | The provider refused the read, or no provider of that kind is configured here. Recorded as `failed`. |
| `suggestion_timed_out` | 503 | yes | The 90 second model call deadline fired. Recorded as `timeout`. |
| `suggestion_provider_unavailable` | 503 | yes | The model provider was rate limited or down (`APICallError.isRetryable`, or HTTP 429 or 5xx). Recorded as `failed`. |
| `suggestion_failed` | 502 | no | The model provider refused (a 401 or 403 is a key, and no retry fixes one). Recorded as `failed`. |
| `suggestion_malformed` | 502 | no | The answer did not parse against the contract. Recorded as `malformed`, tokens included. |

Every row of that table except the first two and `suggestion_rate_limited`
writes exactly one `repository_suggestions` row. A 403 (wrong role) and a 404
(`Unknown repository`) write none: neither reached the provider.

## Where an operator edits all of this

The dashboard's Repositories page (`apps/dashboard/app/(cockpit)/repositories/`)
is the whole surface. The list carries the display name, the provider and path,
the first line of the description, the source badge, the checks version and one
switch per row; the switch is the enabled flag and nothing else, so flipping it
mints no profile version and moves no run already in flight. The not-activated
banner sits above the list while the bridge is on, and its Activate opens the
dialog that states both populations (how many repositories stop passing, and
which of those hold a run claim right now), takes a typed reason, and only then
confirms.

One repository is `repositories/[id]`, five tabs over one Save bar: Overview,
Rules, Scripts (the script group editor this document describes, bound to this
repository's profile), Memory and History. A tab reports the reason Save is
disabled upward rather than rendering its own bar, and the save is one
`PUT /api/v1/repository-catalog/:id` carrying the WHOLE merged profile, because
the upsert defaults the fields a request omits rather than leaving them alone.
"Suggest from repository" lives on the entry and never prefills a form: the
proposal is shown beside the current values with one tick per script group, a
dropped group is shown greyed out with its reason and its commands and can never
be accepted, and accepted groups land in the Scripts tab's draft, which the
admin still saves with a reason.

The Repository scripts screen that used to own all of this is gone. `/scripts`
redirects permanently to `/repositories` (`apps/dashboard/next.config.ts`), the
older `/checks` path redirects there too, and every workflow editor panel that
linked to the old screen links to the new page. The editor's own repository
picker reads the catalog as well as the provider directory: once the catalog is
activated only the rows it enables can be pinned, and while the bridge is on a
row the catalog does not enable is shown and marked.

## The same actions through MCP

Every action the Repositories page and the Settings page offer an owner or an
admin is also a tool on the remote MCP server (`apps/worker/src/mcp/tools/`),
under the same rules, with the same reason recorded and the same refusals.

| On the screen | Tool | Kind | Scope | Roles |
|---|---|---|---|---|
| The Repositories list | `repositories.list` | read | `mcp:read` | any role |
| Opening one repository (Overview, Rules, Scripts) | `repositories.get` | read | `mcp:read` | any role |
| The History tab | `repositories.list_versions` | read | `mcp:read` | any role |
| Save on the entry, and "Add repository" | `repositories.upsert` | mutation | `repositories:write` | admin, owner |
| The switch on a row | `repositories.set_enabled` | mutation | `repositories:write` | admin, owner |
| The Activate dialog, before confirming | `repositories.activate_preview` | read | `repositories:write` | admin, owner |
| Activate, confirmed | `repositories.activate` | mutation | `repositories:write` | owner |
| The import picker | `repositories.import_preview` | read | `repositories:write` | admin, owner |
| Import selected | `repositories.import` | mutation | `repositories:write` | admin, owner |
| "Suggest from repository" | `repositories.suggest` | mutation | `repositories:write` | admin, owner |
| The Settings page | `settings.list` | read | `mcp:read` | any role |
| One setting with its history | `settings.get` | read | `mcp:read` | any role |
| Saving one setting | `settings.set` | mutation | `settings:write` | admin, owner |
| Clearing a setting back to its default | `settings.reset` | mutation | `settings:write` | owner |

The plain reads are open to every token that holds `mcp:read`, a
client-credentials token included: knowing which repositories exist and what
limit is in force is not a privilege. The two previews are not plain reads -- the
activation preview names the tickets and runs in flight and the import preview
lists everything the installation exposes -- so they sit behind the same scope
and the same admin-or-owner list as the writes they feed, and are person-backed
like them.

**The two configuration scopes are new and deliberate.** `repositories:write`
and `settings:write` are separate from `workflows:write`: authoring a workflow
says what the platform should do, while the catalog says which repositories it
may do it to and the settings registry says under what limits. A token granted
the authoring scope to draft a definition holds neither. A client-credentials
token holds neither either, whatever it registered for, because
`withoutAuthoringScopes` strips both from a token with no `sub` exactly as it
strips `prompts:write` and `workflows:write`.

Rolling this out is not automatic. A client carries the ceiling it registered
with, so a client registered before these two scopes existed cannot reach the
configuration tools however it re-authorizes: the next consent screen can only
offer what its registration already allows. Register a new client, or update the
stored client row's scopes, before expecting the catalog and settings tools to
answer.

Seven things differ from the HTTP routes the dashboard calls, each on purpose:

- **Omitted fields keep their stored value.** The dashboard sends the whole
  merged profile because `PUT /api/v1/repository-catalog/:id` defaults what a
  request omits. `repositories.upsert` reads the stored profile and merges, so a
  caller that sends only `rules` does not silently clear the description. It also
  takes an optional `expectedProfileVersion` and refuses with `CONFLICT` when the
  profile moved since the caller read it; the atomic refusal is the service's
  own, raised by the statement that writes, and the tool's check only turns the
  common case into a message that names the version you are behind.
  `scriptGroups` is the exception to "omitted means unchanged" and matches the
  route: send the full set that should remain, because a group left out of that
  field is deleted.
- **Activation is confirmed against what the caller was shown.**
  `repositories.activate_preview` returns a `previewDigest` over the two
  populations and the run claims; `repositories.activate` takes that digest back
  and refuses when the catalog moved in between. That is the agent's equivalent
  of reading the dialog before pressing the button. A catalog with nothing
  enabled is refused outright, in the dialog's own words.
- **Activation and clearing a setting are owner only.** The HTTP routes admit an
  admin. Ending the bridge changes what every future run may enter, and clearing
  a setting hands the key back to a value nobody on the call stated (the
  environment's, on a deployment that sets the variable), so through MCP both are
  the owner's, the same way `runs.answer_clarification` is a person's.
- **Every mutation is person backed**, by the scope mechanism above.
- **A reason is asked for exactly where one is recorded.** `repositories.upsert`
  and `settings.set` write the reason to the profile or settings version, as the
  screens do, and `repositories.activate` stores it with the activation state.
  `repositories.set_enabled`, `repositories.import` and `repositories.suggest`
  take no reason at all: nothing behind them has a column for one and the
  dashboard asks for none either, so requiring one would promise a record
  nobody could later find.
- **`repositories.activate_preview` counts only the catalog.** The dashboard
  dialog also counts repositories the provider directory lists that the catalog
  has never seen; the tool does not read the provider directory, and says so.
  Both derivations of that population have to move together: the dialog builds
  it from the activate route's 409 body, the tool from
  `services/repository-catalog/activation-preview.ts`, and the service's own
  acknowledgement check is what refuses an activation either of them got wrong.
- **Both histories are paged.** `repositories.list_versions` and `settings.get`
  take `limit` (50 by default, 200 at most) and a `before` cursor and answer with
  `hasMore`, because an agent has no scrollbar to tell it there is more.
  `repositories.get` reports `versionsCount` from a count query rather than the
  length of a page, and `changedFields` is null for a version whose predecessor
  is on the next page rather than a diff against something the caller was not
  shown. There is no per-version cost: a profile save spends nothing, and what a
  suggestion cost is on the suggestion, which `repositories.suggest` returns as
  `usage` (null there means unpriced, not free).

`settings.set` and `settings.reset` refuse two groups. The `repositories` group
is the same refusal `PATCH /api/v1/settings` gives: `catalog.activated` moves
through `repositories.activate` and its preview, never through a settings write.
The `mcp` group and `MCP_ENABLED` are refused on the MCP surface only, and the
HTTP patch still writes them: those keys are the transport itself, so a client
that could write them could raise the ceilings it is held to, or switch off the
surface it is talking through and leave nobody able to switch it back from
there. Both point at the dashboard Settings page.

`settings.list` also carries `requiresRedeploy`, and reports
`appliesToRunsInFlight: "after redeploy"` for those keys. Today that is
`PRE_PR_CHECKS_ALLOWED_ENV`, which the checks runner still reads straight from
`process.env`: storing it records the decision and changes nothing until the
worker is redeployed, and saying "next run" would be a promise the key does not
keep.

## Legacy shape (still accepted)

A repository entry stored before repository scripts existed looked like
this, with a flat `commands` array and no `groups` key at all:

```json
{
  "provider": "github",
  "repoPath": "acme/web",
  "setup": ["make bootstrap"],
  "commands": ["pnpm typecheck", "pnpm test"]
}
```

`repoScriptsConfigSchema` still parses this shape wherever it appears in
`repositories[]`, no migration required. It normalizes it to the canonical
shape above, as a single group named `checks`:

```json
{
  "provider": "github",
  "repoPath": "acme/web",
  "setup": ["make bootstrap"],
  "env": [],
  "groups": {
    "checks": { "commands": ["pnpm typecheck", "pnpm test"] }
  }
}
```

The output of `repoScriptsConfigSchema` is always the canonical shape,
whichever shape the stored config was in.

## Setup presets

### uv (Python toolchain)

The sandbox image is bare Node 24: it has no Python toolchain, so a Python
repository needs a `setup` step that installs `uv` before any `commands` run.

```json
"setup": [
  "curl -LsSf https://astral.sh/uv/install.sh | sh",
  "if [ -f \"$HOME/.bash_profile\" ]; then PROFILE=\"$HOME/.bash_profile\"; elif [ -f \"$HOME/.bash_login\" ]; then PROFILE=\"$HOME/.bash_login\"; else PROFILE=\"$HOME/.profile\"; fi; echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> \"$PROFILE\"",
  "uv --version"
]
```

Steps, and why each one matters:

1. **Install via the official installer, to `~/.local/bin`.** `curl -LsSf
   https://astral.sh/uv/install.sh | sh` is astral.sh's own installer; it
   places the `uv` binary at `~/.local/bin/uv` without needing root.
2. **Append the PATH export to the profile file bash actually reads on
   login**, in this order of preference: `.bash_profile` if it already
   exists, else `.bash_login` if that exists, else `.profile`. This mirrors
   bash's own login-shell lookup order. Do **not** unconditionally create
   `.bash_profile`: if the sandbox image ships a `.profile` and no
   `.bash_profile`, creating one would shadow the existing `.profile` (bash
   reads only the first file it finds in that order), silently dropping
   whatever the image already sets up there.
3. **Verify with `uv --version`.** This both confirms the install succeeded
   and, because each command in `commands` runs via a fresh login shell,
   confirms the PATH edit actually took effect for the *next* command, not
   just the current one.

A `commands` entry that looks like an install step (`uv sync`, `pip install
...`, `yarn install`, `npm ci`) belongs in `setup`, not `commands`: `setup`
runs once per workspace and its result doesn't count as a check outcome,
while `commands` runs on every batch and its exit code does.
