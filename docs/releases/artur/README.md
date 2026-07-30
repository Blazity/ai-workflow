# Artur releases

Customer-readable release notes live in this directory as
`YYYY.MM.PATCH.md`. The corresponding immutable Git tag is
`artur-vYYYY.MM.PATCH`.

## Prepare

Run **Actions → Prepare Artur Release**. For the first release, provide the
commit Zak last reviewed as `previous_ref`. Later runs use the newest
`artur-v*` tag automatically. Keep `dry_run` enabled to inspect artifacts
without creating a branch.

Creating the review pull request requires the repository secrets
`RELEASE_BOT_APP_ID` and `RELEASE_BOT_APP_PRIVATE_KEY`. AI drafting is optional:
when `ANTHROPIC_API_KEY` is unavailable or the response is invalid, the
generator produces a deterministic draft for human rewriting.

## Pull request metadata

Use exactly one of `release:feature`, `release:improvement`, `release:fix`,
`release:internal`, or `release:skip`. Complete the **User impact**,
**Required action**, and **Release note** sections. Missing metadata is reported
during preparation but does not block ordinary PR merges.

The generated release-note PR is docs-only. Reviewers own every
customer-facing statement; merging the PR approves copy but does not deploy.
