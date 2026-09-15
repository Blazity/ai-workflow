Status: current
Last-verified: 2026-09-14

# Product changelog

Asked for at the sync of 2026-09-14: a changelog in the repository root, dated entries, appended automatically, written in product tone (what a user can do now, what got better), never in the tone of "this never worked".

## Problem

The repository is public and changes go straight to `main`. There is no place a reader (a customer, a teammate, a future contributor) can see what the product gained week by week without reading pull requests. Pull request bodies already carry a "Release note" line, but nothing collects it, and the batched Artur release notes serve one tenant only.

## Solution

A root `CHANGELOG.md` with one section per day, newest first, each entry one or two sentences in product tone. Authors add an entry as a small file in the pull request that ships the change, so the wording is reviewed with the code and two pull requests never edit the same lines. A scheduled workflow folds the pending entries into `CHANGELOG.md` once a day through a pull request that auto-merges when `ci` passes, because the `main` ruleset requires `ci` and allows no bot bypass.

## User stories

1. As a reader I want to open one file and see what changed, dated, in plain language, so that I can follow the product without reading code.
2. As an author (human or agent) I want to add a changelog entry without merge conflicts, so that parallel pull requests do not fight over one file.
3. As a maintainer I want a pull request that changes product code and carries no entry to be flagged, so that the changelog stays complete without anyone policing it.
4. As the owner I want the tone enforced by a written rule with examples, so that an agent writing an entry cannot drift into defect language.

## Implementation decisions

- Entries live in `changelog/unreleased/<kebab-slug>.md`, one file per pull request, plain markdown bullets (one or two), no frontmatter. The folder README states the tone rule with allowed and forbidden examples.
- Tone rule: describe what a user can do now or what is better; name the surface (dashboard page, MCP tool, workflow block); never name a defect, an incident, a ticket number, a commit or a person; no "fix", "bug", "broken", "finally", "no longer fails". Internal-only changes (refactors, CI, tests, docs) get no entry.
- `CHANGELOG.md` sections are `## YYYY-MM-DD` (merge day of the collation), newest first; entries are bullets in the order the files were added. The file carries a two-line intro and no status header (registered under "Artifacts, not documents" in `docs/index.md`).
- Collation is a small script under `scripts/changelog/` with a unit test, run by `.github/workflows/changelog.yml` on a daily schedule and on manual dispatch. It moves every file in `changelog/unreleased/` into today's section, deletes the files, and opens a pull request with the GitHub App token the release workflows already use, then enables auto-merge. No entries, no pull request.
- Completeness check: a job in `ci.yml` (source-checks) fails a pull request that changes `apps/**` or `packages/**` without adding a file under `changelog/unreleased/`, unless the pull request carries the label `changelog: skip`. Forks are exempt (no label access).
- The pull request template gains a "Changelog" line pointing at the folder, replacing the "Release note" reminder for this repository (the Artur release tooling keeps reading its own section, which stays).
- The first version of `CHANGELOG.md` is seeded with the user-visible changes merged since 2026-09-01, drafted from merged pull request titles and rewritten in the tone rule, reviewed by the owner before merge.

## Out of scope

- Versioned releases or tags for this repository.
- Replacing the Artur tenant release notes pipeline.

## Assumptions

- A daily collation is often enough; the owner can dispatch the workflow by hand for a same-day entry.
- Auto-merge on the collation pull request is acceptable because it only moves text the pull request review already approved.

## Stages

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 1 | Entry folder, collation script, workflow, ci check, template, seeded changelog | collation script (pure: files in, markdown out) | `CHANGELOG.md`, `changelog/README.md`, `changelog/unreleased/`, `scripts/changelog/*.ts`, `.github/workflows/changelog.yml`, `.github/workflows/ci.yml` (one job), `scripts/ci/ci-workflow.test.ts`, `.github/PULL_REQUEST_TEMPLATE.md`, `docs/index.md` (artifact row), `AGENTS.md` (one routing row) | sonnet | no | yes | no | `pnpm run test:ci` green including the new collation test and the ci-workflow assertions; `node scripts/gates/docs-status.mjs` green; `git diff --check` clean; a dry run of the collation on two sample entries produces the expected section |
