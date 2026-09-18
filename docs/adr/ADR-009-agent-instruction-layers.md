Status: current
Last-verified: 2026-09-18

# ADR-009: Agent instruction layers and their ceilings

Decision status: Accepted

Narrows decision 5 of [ADR-005](./ADR-005-documentation-taxonomy.md): the
per-area instruction files keep how to run, test and navigate the area, and the
area's gotchas move to path-scoped rules. Every other ADR-005 decision stands.

## Context

Claude Code loads a nested `CLAUDE.md` in full the first time it reads any file
below it, and a `.claude/rules/*.md` file only when a read matches its `paths:`
list ([memory docs](https://code.claude.com/docs/en/memory)). Codex reads
`AGENTS.md` files from the repository root down to its working directory, so a
session started at the root sees the root file alone, and it does not read
`.claude/rules` at all.

Measured at commit `1933fa8b`:

| File | Bytes | When it loaded |
|---|---|---|
| `AGENTS.md`, through `CLAUDE.md` | 7708 | every session and every subagent |
| `apps/worker/AGENTS.md` | 16103 | first read of any worker file |
| `apps/dashboard/AGENTS.md` | 12345 | first read of any dashboard file |
| `packages/AGENTS.md` | 8888 | never in Claude Code: there was no `packages/CLAUDE.md` |
| `.claude/rules/*.md`, eight files | 11332 | on a matching read |

Half of the worker file was one section of gotchas (8250 bytes), four of which
repeated the root file, and most of `packages/AGENTS.md` was the stage by stage
history of the workflow graph package. A check against the code found false
statements in the root router, in all three per-area files and in three of the
eight rules: a dependency field the MCP tools do not have, a deleted directory,
a settings group that does not exist, a clarification function that was
renamed, a branch reset the adapter does not perform. Nothing measured these
files, so they grew with every stage.

## Decision

1. `apps/worker/AGENTS.md`, `apps/dashboard/AGENTS.md` and
   `packages/AGENTS.md` say what the area is, how to run and test it, its
   directory map, and which rules cover it. `packages/CLAUDE.md` bridges the
   last one the way ADR-005 bridges the apps.
2. A gotcha that is true of some files only lives in a
   `.claude/rules/<name>.md` whose `paths:` names those files, one topic per
   file. The root router lists every rule with what it covers, for agents that
   do not read `paths:`.
3. The four production gotchas stay in the root router, because the failure
   they prevent is writing code before any file that would load a rule has been
   read.
4. History, incident dates and the longer reasoning behind a rule move to
   `docs/archive/agent-notes/`, one file per area, copied word for word. A rule
   ends with a link to its notes.
5. `.claude/context-budget.tsv` holds a byte ceiling per instruction file, a
   default per rule and a collective ceiling for all rules, each with its
   reason. The `PreToolUse` hook `.claude/hooks/context-budget-guard.mjs` tells
   the model when an edit would cross a ceiling, leave a rule without `paths:`,
   or add an em or en dash. It never blocks an edit, and no CI gate measures
   these sizes.
6. Codex reads the same TSV through `.codex/hooks.json`, which registers
   `.codex/hooks/context-budget-guard.mjs` on `PreToolUse` for `apply_patch`
   and on `PostToolUse` for `apply_patch` and `Bash`. What counts as too large,
   and the wording the model reads, live in `.claude/hooks/context-budget-core.mjs`,
   which both guards import, so the two harnesses cannot drift apart. The
   `PostToolUse` pass measures the files on disk, which is the only way to
   catch a write made through the shell.

## Consequences

- A session pays for the area it touches. The first read of a database schema
  file loads about 6 KB of instructions instead of 18 KB. A file that several
  rules match pays for each of them: an engine step loads about 14 KB.
- The shared packages' instructions reach Claude Code for the first time.
- `scripts/ci/gates.test.ts` pins the set of `CLAUDE.md` bridges, so a new
  bridge is a deliberate edit to that test. `scripts/ci/agent-hooks.test.ts`
  pins what the hook tells the model.
- A rule loads on a file read, not on a topic: a session that only runs
  commands sees none, which is why decision 3 exists.
- The ceilings are advisory in both harnesses: every message is a warning, no
  edit is refused, and any other editor exceeds them silently. Raising a
  ceiling needs a reason in the TSV.
- Codex runs a project hook only once it is trusted, and skips an untrusted
  hook without saying so. Trust it once per machine with `/hooks` in the
  interactive CLI; an automated `codex exec` run needs
  `--dangerously-bypass-hook-trust`. The trust `~/.codex/config.toml` records
  is a hash of the hook entry, so changing the command in `.codex/hooks.json`
  means granting it again.
- A hook command is run from the session's working directory, so a Codex
  session started in a subdirectory would lose a hook registered by a relative
  path. Both commands resolve the repository root first, and
  `scripts/ci/agent-hooks.test.ts` pins that.
- A rule whose `paths:` stops matching any file stops loading without an error.

## Options considered

- **Delete the per-area `AGENTS.md` files and keep only rules.** Rejected:
  Codex sessions would lose the area map, and `gate:docs-status` checks those
  files.
- **Enforce the ceilings in CI.** Not chosen by the owner: a warning in the
  editing turn was judged enough, and the TSV keeps a gate cheap to add later.
- **Keep the gotchas in the per-area files.** Rejected: the whole file loads on
  any read in the area, so every gotcha costs every session there.
