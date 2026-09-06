# Arthur release runbook: ship fixes without the skills-drift bug (2026-08-18)

Target version **2026.08.4** (latest tag `artur-v2026.08.3`). Candidate PRs:
- #302 `fix/gitlab-catalog-retry` (GitLab catalog retry)
- #304 `fix/pre-pr-checks-deps` (pre-PR checks stop silent-skip)
- #303 `refactor/db-node-postgres-driver` (db driver swap) — **only if we migrate off Neon; see note at bottom**

All three are OPEN, not merged. Nothing releases until they merge into `Blazity/ai-workflow` main.

## A. The skills-drift bug ("no longer ships skills/X")

**Trigger (exact):** dashboard `LocalSkillPinNotice` (`apps/dashboard/components/cockpit/harness-profiles/profile-editor.tsx:205-229`) compares each pinned deployment skill against `discoverLocalSkills` = what the *running bundle* ships (`apps/worker/src/harness-profiles/local-skills.ts:307-321`). Branches: hash match -> "Matches"; same path, different hash -> "Refresh"; **no skill at that path -> "This deployment no longer ships skills/X."** The `@55583a45...` is the truncated `artifactHash`, NOT a git commit.

**Why the 3 review skills show unshipped now:** the dirs `skills/arthur-engine-review|arthur-scope-review|unify-frontend-review` DO exist on Arthur main. The sync no longer drops them (`skills/` is in `DESTINATION_OWNED_PATHS`, `scripts/release-notes/sync.ts:22-36`, since PR #241). So the "no longer ships" state comes from a **stale running production bundle** built before the skills reached Arthur main (or without the compile-hook copying `skills/` into the function bundle). It is a stale DEPLOYMENT, not a lost directory.

**Resolution: RESTORE, do not de-profile.** These are Arthur's core review skills; removing them from the profile strips its review capability. Ship a deploy whose bundle includes `skills/`, then re-open the profile: "Matches" = done; "different contents, Refresh" = click **Refresh** and re-publish.

## B. Release runbook (2026.08.4)

1. Merge #302/#304 (+ #303 only if migrating) to source main. They then fall inside the release range.
2. Prepare notes: `gh workflow run prepare-artur-release.yml --repo Blazity/ai-workflow -f version=2026.08.4 -f dry_run=false`. Baseline auto-resolves from `artur-v2026.08.3`; never hand-edit frontmatter `targetSourceCommit`.
3. Notes PR: edit only inside the PR; keep `## Exact release scope` as generated (validator recomputes: `manifest.ts:140-153`). Approve + merge -> sync runs.
4. Gate **immutable version**: `guard-artur` (`cli.ts:323-338` -> `ensureArturReleaseSlot`; workflow `sync-artur-release.yml:106-114`) fails if `artur-v2026.08.4` exists. Fresh version only.
5. Gate **frozen base.sha**: snapshot checked out at approved `target_sha`, HEAD == `targetSourceCommit` (`sync.ts:190-195`), baseline = newest tag. Don't override.
6. Gate **skills/ drift**: snapshot PR body must list "Preserved destination paths: ... `skills/`" (`sync-artur-release.yml:159`); `deleted` must contain no `skills/` path.
7. Gate **patch-id drift**: `findUnbackportedDestinationCommits` (`sync.ts:54-159`) must report "Drift report: none". Legit false-positive -> add SHA+reason to `scripts/release-notes/acknowledged-drift.json` (`cli.ts:340-378`) and re-dispatch. Never commit app code directly to Arthur.
8. Merge snapshot PR = prod GO (Vercel worker + dashboard; worker build runs Neon migrations).
9. Verify (`artur-release-SKILL.md:47-51`): `/health`->200, **`/cron/poll`->200** (proves env boots, critical after #303's driver switch if included), dashboard 3xx/200, `gh release view artur-v2026.08.4` (manifest sourceCommit == approved SHA).
10. Clear drift: open Arthur profile editor -> each pinned skill "Matches"; if "different contents", **Refresh + republish**.

## C. Pre-flight checklist (don't repeat yesterday's bug)

- [ ] #302/#304 (+#303 if migrating) merged to source main first.
- [ ] `skills/` still in `DESTINATION_OWNED_PATHS`; snapshot PR "Preserved ... skills/" present, zero `skills/` in `deleted`.
- [ ] Version 2026.08.4 has no existing `artur-v` tag/branch/PR.
- [ ] Baseline auto-resolved from `artur-v2026.08.3`; frontmatter SHAs untouched.
- [ ] Drift report "none" (or SHA acknowledged before re-run).
- [ ] Post-deploy: `/cron/poll`->200; profile "Matches" (Refresh+republish if drifted).
- [ ] Provider env pairs added together (`artur-release-SKILL.md:75`).

## NOTE: #303 depends on the DB decision

If we do NOT migrate off Neon (instead right-size Neon compute to cut cost), then **#303 (neon-http -> node-postgres driver swap) should NOT ship to Arthur**: it adds pooling/TLS/bundling risk on the client deployment for zero benefit while we stay on Neon. In that case the Arthur release is **#302 + #304 only**, and #303 stays open (or is closed) as migration prep. Decide once the Neon cost recon lands.
