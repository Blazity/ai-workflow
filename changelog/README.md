# Changelog entries

`CHANGELOG.md` at the repository root is user-facing. Nobody edits it by hand:
a pull request that ships a user-visible change adds one small file here, and
once a day the Changelog workflow (`.github/workflows/changelog.yml`) turns
every pending file into a versioned release: a new section of `CHANGELOG.md`
and a GitHub Release. Writing the entry in the pull request that ships the
change means the wording gets reviewed with the code, and two pull requests
never edit the same line of `CHANGELOG.md`.

## Adding an entry

Create `changelog/unreleased/<kebab-slug>.md`, one file per pull request. The
slug is yours to pick; it only has to be unique and readable, for example
`repositories-page-import.md`. The file is one or two Markdown bullets, no
frontmatter, no heading:

```markdown
- The dashboard has a new Repositories page: import a repository and see suggested profiles for it.
```

A change that has no user-visible effect (a refactor, a CI change, a test, a
documentation move) gets no entry at all. Apply the label `changelog: skip` to
the pull request instead; a completeness check in CI otherwise fails a pull
request that touches `apps/**`, `packages/**` or `integrations/**` without
either.

That check counts an entry only when the entry reaches a reader. A file the
pull request deletes is not an entry it adds, and a file that yields no bullet
is not an entry either: the check asks the collation's own question through the
collation's own code, so a blank file and a file of bullet-less prose both fail
for the single reason that neither puts a line into `CHANGELOG.md`. That is why
the bullet above is the format and not a preference. The rule, and the sentence
each way of failing prints, live in `scripts/ci/changelog-entry-gate.ts`.

## Tone rule

Describe what a user can do now, or what is better, and name the surface it
lives on: a dashboard page, an MCP tool, a workflow block. Never name a
defect, an incident, a ticket key, a commit, a pull request number, or a
person. Never use the words fix, bug, broken, finally, or the phrases "no
longer fails" and "regression". A changelog reads forward, not backward: it
tells a reader what they can do today, not what used to be wrong.

**Allowed**

- The dashboard Settings page now shows run capacity, timeouts and block
  limits in one place.
- MCP tools can list, read and update the repository catalog directly.
- Workflow triggers now enforce the same run capacity limit as manual
  dispatch.

**Forbidden**

- Fixed a bug where MCP dispatch ignored the run capacity limit (AIW-373).
- The dashboard Settings page no longer crashes when a value is left empty.
- Merged #424 to replace the old Scripts page.

## Releases

Production deploys on every merge to `main`, so a release is not a deploy: it
is the dated, numbered digest of what reached users since the previous one.

**Versions** are `vYYYY.MM.N`: the year and month of the collation, and `N`
counting that month's releases from 1 (`v2026.09.1`, `v2026.09.2`, then
`v2026.10.1`). A number already used by a tag or by a `CHANGELOG.md` heading is
never handed out again. The rule lives in `scripts/changelog/version.ts`.

**One release per collation.** The workflow runs at 23:30 UTC and on manual
dispatch; with no pending entries it does nothing and no version is used up.
Otherwise it runs in two steps:

1. `collate` (`pnpm run changelog:collate`) folds every pending entry into a
   new `## vYYYY.MM.N (date)` section at the top of `CHANGELOG.md`, deletes the
   entry files, and opens the `docs(changelog): release vYYYY.MM.N` pull
   request, which merges on its own once `ci` passes.
2. `release` (`pnpm run changelog:release`) runs when that section reaches
   `main`. It tags the `main` commit the collation read, so the tag holds
   exactly the changes the release lists, and publishes the GitHub Release. It
   also runs on the daily schedule and on dispatch, and it is safe to repeat: a
   version that already has its release is left alone, and a tag without a
   release gets one.

**Two readers, one text.** The `CHANGELOG.md` section carries the short
version, then one `### Area` per area with a one-sentence summary and the
entry bullets, and follows the tone rule: no pull request numbers, no people.
The GitHub Release body is rendered from that same section, in the shape of
[Orca's releases](https://github.com/stablyai/orca/releases): an opening line,
"The short version", a rule, then each area with its summary in italics and
each bullet ending with the pull request that shipped it and its author,
linked, and a Full Changelog link to the previous version.

**The short version and the area summaries are written by a model**
(`claude-sonnet-5`, see `scripts/changelog/summaries.ts`), prompted with the
tone rule above, which it reads from this file. It needs the repository secret
`ANTHROPIC_API_KEY`. The model never blocks a release: without the key, or when
the call fails or its answer does not fit, the release ships with the grouped
bullets, a plain line per area ("Two changes in this area.") and no short
version, and the workflow log says why.

### How an entry gets its area

Authors never name an area; the file format above does not change. The
collation reads the area from git: the scope of the commit that added the
entry file when that scope names an area (`feat(dashboard): ...`), otherwise
the paths that commit changed, otherwise the paths of the whole pull request
that merged it, otherwise Other. The areas are Dashboard, Runs and workflows,
Integrations, MCP, Setup and operations, and Other; the path and scope lists
live in one place, `scripts/changelog/areas.ts`. The commit comes before the
pull request because one large pull request often ships entries for several
areas. To move an entry to another area, add it in a commit whose scope or
files say where it belongs.

### Cutting a release by hand

- **Now, with today's pending entries:** run the Changelog workflow from the
  Actions tab (`gh workflow run changelog.yml`). The collation pull request
  merges once `ci` passes, and the release follows.
- **A release that did not publish** (a failed job, a missed push event): run
  the workflow again. The release job publishes the newest `CHANGELOG.md`
  section if its tag or release is missing.
- **Preview without creating anything:** `pnpm run changelog:collate --
  --dry-run` prints the version, the `CHANGELOG.md` section and the GitHub
  Release body the pending entries would produce (set `ANTHROPIC_API_KEY` to
  see the model's prose), and `pnpm run changelog:release -- --dry-run` prints
  the body the release job would publish for the newest section.

## Why one file per pull request

A single shared `CHANGELOG.md` edited by every pull request is a conflict
magnet: two authors touching the same top section fight over the same lines.
A small file named after the change has nothing to conflict with. The daily
collation is the only thing that ever rewrites `CHANGELOG.md`, and it never
rewrites a section it already wrote: the dated sections from before versions
stay as they are.
