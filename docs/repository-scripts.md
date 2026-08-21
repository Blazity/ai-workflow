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
- `repositories[].env`: **names** of worker environment variables to expose
  to the commands in this repository, e.g. `GITLAB_UNIFY_FRONTEND_TOKEN`.
  Each name must match `/^[A-Z][A-Z0-9_]*$/`. This is a list of names only;
  values are never stored in this config.
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

    Two traps. A `restoreTree: false` group in the publication gate's own
    selection leaves the workspace dirty and the gate fails loudly, which is
    the author's choice to make and not the schema's. And a `run_scripts` node
    that runs such a group **after** the checks gate has already passed drifts
    the tracked-file fingerprint the publication boundary re-verifies, so
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
- `batchTimeoutMinutes`: optional whole-batch timeout override (whole
  minutes, at least 1).

Every reference (`extends`, `gateGroups`) must name a group that exists on
the *same* repository entry; an unknown reference is a validation error that
names the offending reference. A cycle in `extends` is also a validation
error, naming the cycle path, e.g. `verify -> test -> verify`.

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
