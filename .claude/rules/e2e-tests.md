---
paths:
  - "apps/worker/e2e/**"
  - ".github/workflows/e2e.yml"
---

# End-to-end suites

- `@vercel/sandbox` reads credentials from `process.env`, so a repository
  secret is not enough: it has to be mapped in the job's `env:` block. Prefer a
  long-lived `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` over
  OIDC, whose tokens expire in about 12 hours and whose refresh path needs a
  `.vercel/project.json` that CI does not have.
- Reconcile skips registry entries younger than `ORPHAN_GRACE_MS` (30 s). A
  test that seeds an entry and expects the next cron tick to cancel it must
  backdate the timestamp past that window, otherwise it passes only when the
  cron happens to fire late.
- Jira's JQL search index is eventually consistent and not monotonic: one
  positive read does not guarantee the next request sees the ticket. Poll in a
  bounded `waitFor` and assert on the effect, not on a single-shot `discovered`
  count.
