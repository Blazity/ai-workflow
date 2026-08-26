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
