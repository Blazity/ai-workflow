# Agent notes: dashboard

History and reasoning moved out of the agent instruction files on 2026-09-17,
from commit 1933fa8b. Nothing here is loaded automatically; the rules in
`.claude/rules/` link here.

## From `apps/dashboard/AGENTS.md`, Settings

The wording that claimed the worker ignored the store was false from stage B1
onward; do not bring it back.

There is deliberately no popstate sentinel: one per dirty form would push up to
ten history entries nobody asked for.
