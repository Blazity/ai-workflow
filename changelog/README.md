# Changelog entries

`CHANGELOG.md` at the repository root is user-facing. Nobody edits it by hand:
a pull request that ships a user-visible change adds one small file here, and
a scheduled workflow folds every pending file into `CHANGELOG.md` once a day
(`.github/workflows/changelog.yml`, also runnable by hand for a same-day
entry). Writing the entry in the pull request that ships the change means the
wording gets reviewed with the code, and two pull requests never edit the same
line of `CHANGELOG.md`.

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
request that touches `apps/**` or `packages/**` without either.

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

## Why one file per pull request

A single shared `CHANGELOG.md` edited by every pull request is a conflict
magnet: two authors touching the same top section fight over the same lines.
A small file named after the change has nothing to conflict with. The daily
collation is the only thing that ever rewrites `CHANGELOG.md`.
