# Agent notes: worker settings and repository catalog

History and reasoning moved out of the agent instruction files on 2026-09-17,
from commit 1933fa8b. Nothing here is loaded automatically; the rules in
`.claude/rules/` link here.

## From `apps/worker/AGENTS.md`, Settings

Two reasons, and both bite silently: a run outlives its read by hours, so a second
read gives one run two different answers and a replay a different branch than the
first execution took; and a read per element inside a loop over repositories is a
database round trip per element.

## From `apps/worker/AGENTS.md`, the catalog trap

`repositories`, `repository_profile_versions` and the one-row
`repository_catalog_state` (migration 0060) hold what the deployment knows about
each repository and the versioned profile carrying its description, rules,
relationships and script groups.

A definition's repository pin is a **selection inside the catalog** and extends
nothing, neither dispatch nor in-run access, which is why the stage C seed
imported every pinned repository as an enabled row.

There is no build-time catalog seed after H2: `AGENT_ALLOWED_REPOS` is unused, and
the Repositories page owns catalog activation and access.
