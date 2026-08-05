# Legacy post-PR gate neutralization (AIW-220)

Status: **APPLIED** on branch `chore/dead-code-and-ci-cleanup`. Section 2 was
executed: `apps/worker/post-pr-gate.yaml` now carries the sentinel base branch
and `steps: []`. The gate machinery under `src/post-pr-gate/` was deliberately
left in place so that reverting is cheap.

Rollback is `git revert` of the whole neutralization commit, not of the yaml
alone. That commit also added the guard tests in
`src/post-pr-gate/config.test.ts`, which assert the shipped file still carries
the sentinel; restoring only the yaml would leave those tests failing.

Section 1 below describes the pre-neutralization state and is kept in the
present tense as the record of what was found. Read it as history.

Tenant decision: the neutralization applies to Arthur as well. The file is
source-owned, so `sync-artur-release` propagates it on the next release and
Arthur stops publishing `AI Workflow / code-hygiene` too. This was chosen
deliberately rather than adding the path to the destination-owned list.

Two consequences a reader should know about, neither of which the sections
below anticipate:

1. The three fall-through vectors in section 5 stop producing any check at all,
   not just a duplicate one. A bot pull request in a repository excluded by a
   definition's `repositoryScope` pin previously got `code-hygiene` as its only
   coverage; it now gets silence.
2. `cancelPreviousRun` (`post-pr-gate-dispatch.ts:106-159`) is now unreachable,
   so a gate check left in progress by an earlier crashed run can never be
   completed automatically. Verified empty for this repository at the time of
   application (one open pull request, on a non-managed branch, carrying no
   `AI Workflow /` check). Check the tenant before syncing.

Also note that `e2e/tier2/us22-gate-skips-non-bot.test.ts` and
`us26-gate-runon-filters.test.ts` assert the absence of gate checks. With the
gate neutralized they pass unconditionally and no longer prove that the
`botPrsOnly` and `draftPrs` filters work. They regain meaning only if this
runbook is reverted.

Line numbers are given as of branch `feat/arthur-review-agent-scenarios`. Symbol
names are the authoritative anchor; several of the cited route files are under
concurrent edit, so re-grep the symbol if a number does not line up.

## 1. Why this document exists

AIW-220 requires that "no duplicate checks/reviews are emitted by legacy and
editable post-PR paths". Today the legacy YAML gate is live, and not by
accident: **`apps/worker/post-pr-gate.yaml` is committed to this repository** and
explicitly enables the gate.

```yaml
# apps/worker/post-pr-gate.yaml, tracked at HEAD (comments elided)
postPrGate:
  runOn:
    botPrsOnly: true
    draftPrs: false
    baseBranches: [] # empty = all base branches
  steps:
    - uses: code-hygiene
      name: code-hygiene
      onFailure: continue
      timeoutMs: 180000
```

So `readFileSync` succeeds and `loadPostPrGateConfig`
(`apps/worker/src/post-pr-gate/config.ts:49-68`) returns **this file**.
`baseBranches: []` means the base-branch filter is inert
(`post-pr-gate-dispatch.ts:134` only filters when `length > 0`), so the gate is
armed on every base branch, with a real step attached. `nitro.config.ts:43-47`
lists `post-pr-gate.yaml` among `optionalYamlFiles` and ships whichever ones are
committed, so it lands in every emitted function bundle.

That step is not free: `code-hygiene` makes one Claude Haiku 4.5 call per changed
file (via `@ai-sdk/anthropic`, scoped to that file's unified diff, requiring
`ANTHROPIC_API_KEY`), so the legacy gate is spending model budget on every bot
pull request it touches, in addition to duplicating the editable workflow.

Secondary path, for tenants that do **not** have the file: on `ENOENT`
`loadPostPrGateConfig` returns the built-in `defaultPostPrGateConfig`
(`config.ts:10-15`), which is `botPrsOnly: true`, `draftPrs: false`,
`baseBranches: []`, one `code-hygiene` step. That is materially the same
gate-enabled shape, so removing the file does not disable anything. Both paths
end with the gate live; only the reason differs. This matters for the runbook in
section 6: absence of the file is not evidence of neutralization.

Either way, both webhook routes call `dispatchPostPrGateWebhook` whenever the
editable definition did not claim the delivery
(`routes/webhooks/github.post.ts:107-116` and `:127-137`;
`routes/webhooks/gitlab.post.ts:99-107` and `:117-119`).

So the gate runs, it publishes `AI Workflow / code-hygiene`
(`gateCheckName`, `apps/worker/src/lib/workflow-naming.ts:40-42`, prefix
`GATE_CHECK_NAME_PREFIX = "AI Workflow / "` at `:4`), and the editable Post-PR
review workflow publishes `AI Workflow / Review`
(`apps/worker/src/workflow-definition/templates.ts:696`). Two systems, one head
SHA, adjacent check names.

The companion change in this branch adds `trigger_pr_ready` and
`trigger_pr_updated` to `PR_TRIGGER_TYPES`
(`apps/worker/src/lib/post-pr-gate-dispatch.ts:19-25`), so
`warnIfSupersededByDefinition` (`:109-119`) can actually fire
`post_pr_gate_deprecated` for the Post-PR review template, whose two triggers are
exactly those (`templates.ts:677` and `:685`). That change is observability only.
It does not turn the gate off. This document is how you turn it off.

## 2. The exact file to apply

**Replace the contents of `apps/worker/post-pr-gate.yaml`** in the tenant
repository. The file already exists and is tracked at HEAD with the
gate-enabling config quoted in section 1. This is a replacement, not a creation.
An operator who goes to create it, finds it present, and stops has changed
nothing.

The path matters and is not the monorepo root. The build copies optional YAML
from `nitro.options.rootDir` (`apps/worker/nitro.config.ts:52-66`), which is
`apps/worker/`, into every emitted `*.func` bundle, and runtime resolves it
against `process.cwd()` (`= /var/task`) in `defaultPostPrGateConfigPath`
(`apps/worker/src/post-pr-gate/config.ts:44-47`). A second copy at the monorepo
root is never read and would leave the tracked one in force. `SETUP.md:393` used
to say "repo root"; it is corrected in this branch.

New content, replacing the file wholesale:

```yaml
postPrGate:
  runOn:
    botPrsOnly: true
    draftPrs: false
    baseBranches: ["__ai-workflow-gate-disabled__.lock"]
  steps: []
```

Add nothing else. The schema is `.strict()` at every level
(`config.ts:17-42`), so a stray key throws at load time on the first webhook
delivery rather than failing quietly.

## 3. Why this exact shape works

Verified against `apps/worker/src/lib/post-pr-gate-dispatch.ts`.

`dispatchPostPrGateWebhook` (`:32`) does exactly two things before any side
effect:

1. `loadPostPrGateConfig()` (`:37`)
2. `checkPostPrGateEligibility(workflowInput, config)` (`:38-39`), and returns
   immediately if it produced a verdict.

Only after that does it construct the `GateStore` (`:41`), take the per-PR
advisory lock (`gateStore.acquireLock`, `:43`), touch `gate_dedupe` /
`gate_current`, and call `start(postPrGateWorkflow, ...)` (`:81`). So a verdict
from `checkPostPrGateEligibility` costs one log line and one database-free
return. No lock row, no dedupe row, no pointer row, no Vercel Workflow run.

`checkPostPrGateEligibility` (`:121-139`) evaluates in this order:

1. `botPrsOnly && !isManagedBranch(headRef)` -> `{status:"ignored", reason:"not_bot_branch"}`, log `post_pr_gate_skipped_not_bot_branch` (`:125-128`)
2. `!draftPrs && isDraft` -> `{status:"ignored", reason:"draft"}`, log `post_pr_gate_skipped_draft` (`:129-132`)
3. `baseBranches.length > 0 && !baseBranches.includes(baseRef)` -> `{status:"ignored", reason:"base_branch"}`, log `post_pr_gate_skipped_base_branch` (`:133-136`)

`"__ai-workflow-gate-disabled__.lock"` is not a valid Git ref for any real base
branch, so rule 3 can never pass. Precisely: with this config every delivery
short-circuits before the lock, but not all of them with the same reason.
Non-managed head branches stop at rule 1 with `not_bot_branch`, drafts on managed
branches stop at rule 2 with `draft`, and everything else stops at rule 3 with
`base_branch`. The load-bearing property (nothing is locked, claimed or started)
holds for all three.

Provider coverage: both routes reach the gate only through
`dispatchPostPrGateWebhook`, so the short-circuit is provider-independent by
construction. It covers GitHub (`github.post.ts:116`, `:137`) and GitLab
(`gitlab.post.ts:141`, via `dispatchMergeRequestGate` at `:126-142`) alike.

Rollback: `git revert` the neutralization commit, restoring the gate-enabling
config, and redeploy. No migration, no environment change. Revert the commit
rather than the yaml alone: the same commit carries the guard tests in
`src/post-pr-gate/config.test.ts`, which assert the shipped file still holds the
sentinel and would fail if the yaml went back on its own. Do not rollback by
deleting the file either: on `ENOENT` the built-in default takes over and the
gate is live again anyway, just for a different reason.

Side effect worth knowing: any config that is not deep-equal to the built-in
default makes `loadPostPrGateConfig` emit `post_pr_gate_yaml_deprecated` on every
load (`config.ts:64-66`). The **currently committed** file already trips this,
because its step carries `name: code-hygiene` and the built-in default omits
`name`, so `isDeepStrictEqual` is false today. The warning therefore says nothing
about whether this runbook was applied. See section 6 step 4.

## 4. Alternatives that were rejected

**`steps: []` alone.** It empties the gate's work but not its machinery.
`checkPostPrGateEligibility` returns `null` for an eligible bot PR, so dispatch
proceeds to `acquireLock` (`post-pr-gate-dispatch.ts:43`), writes the
`gate_current` pointer (`:75-79`), and calls `start(postPrGateWorkflow, ...)`
(`:81`). A real Vercel Workflow run is created for zero steps, the advisory lock
is taken and released, and `post_pr_gate_started` is logged as if the gate were
live. Every log-based and run-based verification below would keep reporting a
live gate.

**`botPrsOnly: true` alone.** It is already the default
(`config.ts:12`), so setting it changes nothing. It also does not mean what the
name suggests: `isManagedBranch` (`workflow-naming.ts:22-28`) tests the head
branch prefix, not the PR author. Bot-authored pull requests on
`ai-workflow/*` or `blazebot/*` branches are exactly the ones it lets through,
and those are precisely where the client reported false-red checks.

**`GITHUB_OWNER` / `GITHUB_REPO`.** This narrows only the GitHub route, via
`isLegacyGateRepositoryAllowed` (`github.post.ts`, around `:178`). GitLab is
untouched.
It also has side effects well outside the gate: the pair populates
`legacyRepoPath` on the GitHub provider config (`apps/worker/env.ts:373-375`),
which flips `getVcsConfig()` (`env.ts:416-447`) from throwing
"legacy VCS config requires a repository" to returning a single pinned
repository. `env.ts:235-240` additionally rejects setting one without the other.
Wrong tool for a gate switch.

## 5. Three duplication vectors an operator must test for

These are the shapes where the legacy gate and the editable workflow can both
speak about the same head SHA. Test each on the tenant before declaring
AIW-220's criterion met.

### 5.1 `ignored_provider` from the definition repository pin

Both routes fall through to the legacy gate when the dispatcher returns
`no_definition`, `ignored_not_workflow_owned`, or `ignored_provider`
(`github.post.ts:107-111`, `gitlab.post.ts:99-105`).

`ignored_provider` is returned by `dispatchTriggerEvent` in three places
(`apps/worker/src/lib/dispatch-trigger.ts`):

- the trigger's `providers` list does not include the event's provider (`:140-146`)
- scope `any` and the repository is outside the composed allowlist plus pin (`:149-158`, via `isRepoAllowedForScope`)
- scope `any` and the definition's `repositoryScope` pin excludes the repository (`:162-186`, via `isRepositoryWithinPinnedScope`; the `return` sits at `:184`, guarded by `if (scope === "any")`)

The counter-intuitive consequence: **restricting a workflow to a subset of
repositories increases the surface where the legacy gate fires.** Every bot pull
request in a repository outside the pin now returns `ignored_provider`, falls
through, and gets the legacy gate instead of the editable workflow. The pin does
not narrow the product, it hands the excluded repositories back to the legacy
path.

Test: open a bot pull request in a repository the definition's pin excludes, and
confirm no gate check appears on its head SHA.

### 5.2 Draft bot pull requests

`normalizeGitHubEvents` (`apps/worker/src/lib/trigger-events.ts:255-280`) adds a
`trigger_pr_ready` event alongside `trigger_pr_created` only when the action is
`opened` **and** `pull_request.draft !== true` (`:265-278`).

So for a draft `opened`:

1. Only `trigger_pr_created` is normalized.
2. No enabled definition owns `trigger_pr_created` (the Post-PR review template
   uses `trigger_pr_ready` and `trigger_pr_updated`, `templates.ts:677`, `:685`),
   so the dispatcher returns `no_definition`.
3. `opened` is in `GATE_ACTIONS` (`github.post.ts:21`), so the fall-through fires
   and the legacy gate runs.
4. The gate's own draft rule then applies: with the shipped default
   `draftPrs: false`, `checkPostPrGateEligibility` stops at rule 2 with
   `reason: "draft"`. With `draftPrs: true` the gate would actually run on the
   draft.
5. The later `ready_for_review` delivery normalizes to `trigger_pr_ready` and is
   claimed by the editable workflow.

If no commit landed between steps 3 and 5, both systems have spoken about the
same head SHA on the same pull request: two verdicts, one commit. The `draftPrs:
false` default narrows this to configurations that enable drafts, but the
fall-through itself is unconditional, so verify rather than assume.

Test: open a draft bot pull request, mark it ready without pushing, and inspect
the check runs on the single unchanged head SHA.

### 5.3 A narrowed `providers` list on the trigger

Both template triggers ship with `providers: ["github", "gitlab"]`
(`templates.ts:681`, `:689`). Editing a deployed definition down to one provider
makes `dispatchTriggerEvent` return `ignored_provider` for the other
(`dispatch-trigger.ts:140-146`), which is a fall-through result in both routes.
Every bot pull request on the dropped provider is then handled by the legacy gate
alone. On GitLab this is easy to miss because there is no per-repository
narrowing to catch it: `checkProjectScope` (`gitlab.post.ts:152-163`) admits any
project the configured GitLab provider lists.

Test: after any edit to a trigger's `providers`, open a bot pull request on each
provider the tenant actually uses.

## 6. Verification runbook: is the gate live on this tenant?

Run top to bottom. Steps 3 to 5 are evidence of execution; steps 1, 2 and 6 are
evidence of configuration. Configuration alone is not proof.

**1. READ the file at the deployed commit. Do not test for its existence.**

```bash
git show <deployed-sha>:apps/worker/post-pr-gate.yaml
```

The file ships committed and gate-enabling, so "it is there" is the default
state, not a sign anyone did anything. There are three outcomes and only one of
them is neutralized:

| What you see | Verdict |
| --- | --- |
| (a) `fatal: path ... does not exist` | Built-in default applies (`config.ts:10-15`): `baseBranches: []` plus one `code-hygiene` step. **Gate live.** |
| (b) File present with `baseBranches: []` or any list of real branch names, and a non-empty `steps:` | **Gate live.** This is the shipped state, unchanged. |
| (c) File present with `baseBranches: ["__ai-workflow-gate-disabled__.lock"]` and `steps: []` | Neutralization applied. Go to step 3 and confirm no recent execution. |

Cases (a) and (b) are the same verdict by different routes, so deleting the file
is not a fix. Also check the monorepo root
(`git show <deployed-sha>:post-pr-gate.yaml`): a file there is never read
(section 2), and if someone put the sentinel config there, the tracked
`apps/worker/` one is still in force and the verdict is (b).

**2. Is `POST_PR_GATE_CONFIG_PATH` set?**

```bash
vercel env ls production | grep POST_PR_GATE_CONFIG_PATH
```

It overrides the resolved path entirely (`config.ts:44-47`). If set, the file in
step 1 is irrelevant and you must inspect whatever that path points at inside the
function bundle.

**3. Query the `GateStore` tables. This is proof of execution.**

Tables are `gate_locks`, `gate_dedupe` and `gate_current`
(`apps/worker/src/db/schema.ts:201`, `:213`, `:230`; documented in
`apps/worker/src/post-pr-gate/gate-store.ts:7-27`).

```sql
select repo, pr, head_sha, run_id, expires_at from gate_current order by expires_at desc limit 50;
select repo, pr, head_sha, run_id, expires_at from gate_dedupe order by expires_at desc limit 50;
```

Any row whose `expires_at` is inside the last 14 days is a gate run that actually
started, because `setCurrent` and `claimRun` are only reached past the eligibility
check (`post-pr-gate-dispatch.ts:75-83`). Rows are written with a 14 day TTL
(`gate-store.ts:29`) and physically purged by the poll cron
(`purgeExpired`, `gate-store.ts:281-289`), so an empty table after a long quiet
period is weak evidence; recent rows are strong evidence.

**4. Grep worker logs.**

| Message | Means |
| --- | --- |
| `post_pr_gate_started` | the gate ran. Definitive. |
| `post_pr_gate_skipped_not_bot_branch` | reached the gate, stopped at rule 1 |
| `post_pr_gate_skipped_draft` | reached the gate, stopped at rule 2 |
| `post_pr_gate_skipped_base_branch` | reached the gate, stopped at rule 3. This is what the neutralization file should produce. |
| `post_pr_gate_superseded_by_definition` | the editable workflow claimed the delivery and the gate was not called |
| `post_pr_gate_deprecated` | both systems are live for an overlapping trigger |
| `post_pr_gate_yaml_deprecated` | **Evidence of nothing.** See below. |

`post_pr_gate_yaml_deprecated` fires whenever the loaded YAML is not deep-equal
to the built-in default (`config.ts:64-66`). The **shipped, untouched** file
already trips it: its step carries `name: code-hygiene`, which the built-in
default omits, so `isDeepStrictEqual` is false on a tenant where nobody has done
anything. It fires equally after this runbook is applied. Treating it as a
success signal would convince an operator the fix landed when the gate is fully
live. Read the file (step 1) instead.

Note that `post_pr_gate_skipped_*` still proves the gate is wired in and reached.
Only `post_pr_gate_skipped_base_branch` on every delivery indicates the
neutralization file is in force.

**5. Inspect recent bot pull request heads.**

```bash
gh api repos/<owner>/<repo>/commits/<head-sha>/check-runs --jq '.check_runs[].name'
gh api repos/<owner>/<repo>/commits/<head-sha>/status --jq '.statuses[].context'
```

Look for a `gateCheckName` output (`workflow-naming.ts:40-42`), which for both
the shipped file (`name: code-hygiene`) and the built-in default is
`AI Workflow / code-hygiene`, appearing alongside
`AI Workflow / Review` from the editable workflow (`templates.ts:696`). Both
present on one head SHA is the duplication AIW-220 forbids. Older deployments may
show the legacy prefix `blazebot / ` instead
(`LEGACY_GATE_CHECK_NAME_PREFIX`, `workflow-naming.ts:5`); both spellings count.

On GitLab use commit statuses on the MR head rather than check runs.

**6. Check the repository scoping variables.**

```bash
vercel env ls production | grep -E 'GITHUB_OWNER|GITHUB_REPO|AGENT_ALLOWED_REPOS'
```

If `GITHUB_OWNER` and `GITHUB_REPO` are both unset **and** `AGENT_ALLOWED_REPOS`
is unset, the legacy gate is allowed on every repository in the GitHub App
installation:

- `isLegacyGateRepositoryAllowed` (`github.post.ts`, around `:178`) returns
  `true` unconditionally on `if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return true;`
  when the legacy pair is unset.
- `isRepoAllowed` (`apps/worker/src/lib/repo-allowlist.ts:70-73`) fails OPEN:
  `set.size === 0 || set.has(...)`. `allowedSet` (`:35-66`) returns an empty set
  when `AGENT_ALLOWED_REPOS` is unset, and logs a one-time warning
  "AGENT_ALLOWED_REPOS is empty; the agent may branch/PR on ANY installed repo"
  (`:57-63`).

Grep for that warning as a fast confirmation of the fail-open state.

## 7. Applying it

1. **Replace** the contents of the existing, tracked
   `apps/worker/post-pr-gate.yaml` in the tenant repository with the exact
   content in section 2. The file is already there and currently enables the
   gate; you are overwriting it, not creating it. If your editor reports the file
   as new, you are at the wrong path.
2. Deploy.
3. Open one bot pull request. Expect `post_pr_gate_skipped_base_branch` in the
   logs, no new `gate_current` or `gate_dedupe` row for that repo/PR, and exactly
   one AI check on the head SHA (`AI Workflow / Review`).
4. Re-run section 6 vectors 5.1 to 5.3 as regression checks.

Rollback: `git revert` the neutralization commit (not the yaml alone, the guard
tests ship with it), redeploy. Do not delete the file; the built-in default
would take over and the gate would be live again.

## 8. Corrections to the working assumptions

Recorded so the next reader does not re-derive them.

- **`apps/worker/post-pr-gate.yaml` exists and is tracked.** The first draft of
  this document claimed no such file existed anywhere in the repository and that
  the gate was live purely through the `ENOENT` default. Wrong on the mechanism.
  The file is committed at HEAD (923 bytes, `git ls-files apps/worker/post-pr-gate.yaml`),
  `readFileSync` succeeds, and the gate is live because that file arms it on all
  base branches with a real `code-hygiene` step. The conclusion is unchanged and
  stronger; the mechanism and therefore the whole verification procedure changed.
  Verify with `git show HEAD:apps/worker/post-pr-gate.yaml` before trusting any
  claim in this document about what is or is not on disk.
- **`post_pr_gate_yaml_deprecated` already fires on an untouched tenant**, because
  the shipped step carries `name: code-hygiene` and the built-in default omits
  `name`. It is not a signal that this runbook was applied. Section 6 step 4.
- **GitLab does have a repository scope check on the gate path.** The working
  brief said the GitLab path has no repository allowlist at all. It does:
  `dispatchMergeRequestGate` (`gitlab.post.ts:126-142`) calls `checkProjectScope`
  (`:152-163`), which calls `gitLabProjectIsAllowed` (`:201-230`), which applies
  `isRepoAllowed` and then either `GITLAB_PROJECT_ID` or the configured GitLab
  provider's repository listing, and fails closed with a 503 when the listing is
  unreachable. It is looser than a real allowlist when `GITLAB_PROJECT_ID` is
  unset, but it is not absent. The neutralization file still covers GitLab,
  because it short-circuits inside `dispatchPostPrGateWebhook`, downstream of
  every route-level check.
- **The short-circuit reason is not always `base_branch`.** With `botPrsOnly:
  true` retained, non-managed branches stop earlier at `not_bot_branch` and
  drafts at `draft`. All three stop before the lock, which is the property that
  matters. Section 3 states this precisely.
- **The fail-open lives in `isRepoAllowed`, not `allowedSet`.** `allowedSet`
  (`repo-allowlist.ts:35-66`) just returns an empty set; `isRepoAllowed`
  (`:70-73`) is where `set.size === 0` means "allowed".
