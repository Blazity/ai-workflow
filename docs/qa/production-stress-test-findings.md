# Production stress test findings (2026-07-30)

Live bug list from a production stress test of the main ticket-to-PR workflow, run
against Jira project **AWP** (`blazity/ai-workflow-app`, prod deployment
`dpl_AnUuC6P3P1nnz9qWyzehpqjZBzXR`, commit `519345705d77ad2f59ccaeb07e73ab81adc8d9f9`
/ PR #190). Target repos: `Blazity/ai-workflow-prod`, `Blazity/ai-workflow-demo`,
`filipmaszota3/ai-workflow-integration-test` (GitLab).

Updated live during the session. Ordered roughly by severity/confidence.

---

## Confirmed / high confidence

### 1. `open-pr-finalize` canonical clone fails intermittently, error message truncated before the real cause
- **Where:** `apps/worker/src/sandbox/trusted-workspace-publisher.ts:367` (`canonical clone failed: ${await commandError(clone)}`), surfaced via `deriveFailureMessage` in `apps/worker/src/workflow-definition/failure-message.ts`.
- **Repro:** AWP-39, run `wrun_01KYSFRC85YWWMD6WH2FQG0C30`, diagnostic `AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1`, 2026-07-30 12:56 UTC. Planning + implementation + pre-PR checks all succeeded; the run died at "Finalize Workspace" with:
  > `An external service could not complete this block. (github:Blazity/ai-workflow-prod: canonical clone failed: Cloning into '/vercel/sandbox/publisher/0'... fatal: unable to)`
- **Why this is a bug, not just a transient clone failure:** `failure-message.ts:115-132` (`clampSingleLine`) is explicitly designed and commented to keep *both* the head and tail of a clamped message specifically so a trailing `fatal: unable to access '<url>': <reason>` line survives. The message we actually got has no ELISION marker, no closing quote, no URL, no HTTP status - it just stops at "unable to". Either the raw sandbox stderr is genuinely being cut off mid-line (sandbox/process killed early?) or the redaction/clamping has an edge case that eats the tail instead of preserving it. Either way, **the actual clone failure reason (auth? network? rate limit?) is unrecoverable from the UI, Slack, or Jira** - only "the worker logs for run X" is implied and even those don't have more.
- **Impact:** whole run fails with a diagnostic message that gives the operator nothing actionable.
- **Follow-up for next session:** find `operatorFailureDetail` (1000-char bound, `failure-message.ts:172`) for this diagnosticId in the DB/telemetry - it may have more of the tail than the 160-char user snippet. If it's *also* truncated at the same point, the raw stderr itself is short and the bug is upstream (sandbox/process), not in `clampSingleLine`.

### 2. Dashboard "Now running" widget shows long-finished runs as still executing
- **Where:** Overview page, "VERCEL WORKFLOW · LIVE / Now running" panel.
- **Repro:** Right now the panel lists `AWP-39` and `AWP-8` as `RUNNING`. The "Recent runs" table two inches below, on the same page load, shows `AWP-39` = **FAILED** (285 min ago, 1880s duration) and `AWP-8` = **SUCCESS** (159 min ago, 892s duration). Confirmed by opening the AWP-39 ticket detail page directly: terminal `FAILED` state, no steps left `NOT REACHED`.
- **Impact:** anyone glancing at the cockpit believes 2 runs are actively in flight when both finished hours ago. Directly undermines the "is anything stuck" use case the panel exists for.
- **Next step:** find what backs "Now running" (looks like it queries the Workflow SDK's live executing-set rather than `workflow_runs.status`) and why it isn't clearing on terminal state.

### 3. Branch-ref 404 immediately after `createRef`, still happening on nearly every run
- **Where:** `GitHubAdapter.getBranchSha`, called from `promoteRepositoryWriteScopeStep` (`apps/worker/src/workflows/repository-promotion.ts`).
- **Evidence:** `GET /repos/{owner}/{repo}/git/ref/heads%2F...` 404s appear for **almost every single ticket run in the last week** (AWP-22, 24, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, plus AWT-1044/45/48/49/50 on demo) - i.e. this is not an edge case, it's close to a 100% hit rate on fresh branches.
- **Context:** memory says PR #167 (2026-07-27) fixed this exact GitHub read-after-write race for the *open-pr-finalize/promotion* path by using the known `researchBaseSha` instead of re-reading. This 404 is clearly still happening from a **different call site** - `promoteRepositoryWriteScope` - after that fix shipped, and as recently as 2026-07-30 08:15 and 12:53.
- **Impact:** usually self-heals via retry (`Max retries reached, bubbling error to parent workflow` only fired once, for `wrun_01KYHK34GK1KXXB2PMSYGTEGTB`, where it exhausted retries and failed the run outright), but it's silently eating retry budget and adding latency on nearly every run, and occasionally causes a hard failure.
- **Next step:** apply the same "use the known SHA, don't re-read a just-created ref" fix to `promoteRepositoryWriteScope`.

### 4. Self-authored PR review 422 ("Can not request changes on your own pull request") may still occur after PR #180
- **Evidence:** an identical 422 on `POST /repos/Blazity/ai-workflow-prod/pulls/14/reviews` was logged on **`dpl_FEMXQHCS43N4cndkpJz1syS9gqC9`** (2026-07-28 16:24), which is the deployment that *includes* commit `6ebdb3f` / PR #180 ("Handle self-authored GitHub review publication"). PR #180's stated goal was exactly to stop this 422 from reaching the user by publishing a neutral comment instead.
- **Caveat:** could be a retried/stuck attempt from before the fix rather than a fresh post-fix occurrence - needs a live repro (see Use Case 4 below) to confirm one way or the other before treating as a regression.

### 5. `prompt-library/{id}/usage` endpoint 500s (zod parse crash)
- **Where:** `findPromptUsage` (`chunks/_/store4.mjs` in the built worker), `TypeError: Cannot read properties of undefined (reading '_zod')` inside `zod@4.3.6`'s `safeParse`.
- **Evidence:** recurring since **2026-07-11**, still happening today (2026-07-30 06:19 latest sample). Affects `/api/v1/prompt-library/1/usage`, `/2/usage`, `/3/usage` - i.e. every prompt in the library.
- **Impact:** whatever dashboard surface shows prompt usage stats (Prompts tab, per the sidebar) is presumably broken/empty for all prompts, silently, for 3 weeks.

### 6. Harness skill discovery 422s ungracefully on a repo outside the GitHub App install
- **Where:** `POST /api/v1/harness-skills/discover` → `discoverGitHubSkills` → `readProvider`.
- **Evidence:** `GET /repos/matt-pocock/skills - 404`, then `HarnessSkillImportError: GitHub repository could not be read with the organization installation` (422), 2026-07-13 through 2026-07-25.
- **Impact/question:** unclear whether the dashboard's Harness Profiles UI shows a friendly "that repo isn't installed" message or just surfaces a raw 422. Worth a live check (Use Case 12).

## Workflow definitions on production (recon)

Four ticket workflow definitions exist under Workflow editor → workflows list:

| Name | Engine | Status | Triggers |
|---|---|---|---|
| **Human-approved plan** | V2 | **ENABLED (current)** | Ticket assigned to AI, Plan approved |
| Fully modular | V1 (legacy, not migrated) | disabled | Ticket assigned to AI |
| Reviewed ticket workflow | V1 (legacy) | disabled | Ticket assigned to AI |
| Post-PR review | V1 (legacy) | disabled | PR ready for review (any PR), PR updated (any PR) |

Only **Human-approved plan** is live, so everything found so far (AWP-8..39) went through
that one. The three disabled ones are real, fully-built graphs, not stubs:
- **Fully modular**: plan → implement → run checks → branch on pass/fail → auto `Fix agent`
  retry loop (max 3, "on exhaust fail") → finalize/open PR. No human plan approval gate.
- **Reviewed ticket workflow**: plan → implement → fans out to three parallel specialist
  reviewers (Security review / Code quality review / Requirements review) → "all reviews
  approved?" branch → pass continues, fail → Fix agent → loop back.
- **Post-PR review**: triggers on *any* PR ready-for-review or PR-updated event (not scoped
  to bot-authored PRs) → prepares an exact-head workspace → same three-reviewer fan-out →
  posts a combined review.

**Not tested yet, deliberately** - all three are disabled, and two of them (`Fully modular`,
`Reviewed ticket workflow`) are legacy V1, which historically has had worse execution-error
diagnosability than V2 (see `arthur-run-failed-no-data-gap` prior findings). `Post-PR review`
in particular would start reviewing PRs opened by humans too, not just the bot, the moment
it's enabled - broader blast radius than anything else in this test. Enabling any of them is
a real production config change (affects every future ticket/PR matching the trigger, not
just a scoped test ticket), so it's called out to the user rather than flipped silently.

## Dashboard "live" status staleness - second sighting

The Workflow Editor's top banner also shows `AWP-8 · LIVE · Awaiting: questions on the ticket`
- but AWP-8 is `SUCCESS`, finished ~2.5h ago per Recent runs. Same staleness class as finding
#2 above, now confirmed in a second, independent surface (editor banner, not just the Overview
"Now running" panel). Increases confidence this is a shared underlying "live ticket state"
query that isn't invalidating on terminal status, rather than a one-off render bug.

## Checked and no longer reproducing

- **Italic body copy across the whole dashboard** (prod-config-gaps-2026-07-27 finding: only `Inter-Italic.ttf` registered in the Inter family). Zoomed into the live Overview page today (2026-07-30) - body text renders upright. Looks fixed or no longer applicable; **do not re-open blind**, but worth a final visual pass before release.

## Open configuration gaps (carried over, re-verify)

- **`GITHUB_BOT_LOGIN` still unset on production** (as of 2026-07-27 memory) → recursion suppression for the bot's own PR/review comments doesn't work for GitHub (only `GITLAB_BOT_LOGIN` is set, inherited from demo). If still true, a bot comment on its own PR could re-trigger a run. Needs a live env check + repro (Use Case 5).

---

## Live use case results

### Mid-run cancellation (AWP-43) - works, but with a short window where the step still shows running
- **Repro:** AWP-43 moved to Ai, run started (`wrun_01KYT4PN8N23KDB50ZFPM54HNB`), then ~15s later moved back to "Do zrobienia" (backlog) via the same transition API real users use.
- **Immediately after:** ticket detail correctly showed **BLOCKED** / `Ticket left the AI column (Ai -> To Do) via Jira webhook`, but the visual replay still showed step **"Planning Agent" = RUNNING / IN PROGRESS** for a beat.
- **~1 minute later (final state):** Planning Agent now correctly shows **CANCELLED**. So the end result is right - cancellation does propagate and stop the in-flight step - it just isn't instantaneous. Not a bug, just worth knowing there's a short eventual-consistency window between "ticket left the column" and "the in-flight step actually stops" where the UI can look contradictory.
- **Dashboard "Now running" panel, third data point:** the moment the ticket left the AI column, AWP-43 disappeared from the Overview "Now running" widget - which, combined with bug #2 (stale entries that never clear), suggests that widget keys off ticket-column membership rather than actual run/step execution state.

### Workflow Editor transiently shows "No provider connected" for the live, correctly-configured workflow
- Navigating straight to `/editor` (or reloading it) intermittently rendered `SOURCE SCOPE - Providers: No provider connected` for **Human-approved plan**, the enabled V2 workflow that in fact has `GitHub + GitLab` configured (confirmed correct on a subsequent reload, and confirmed correct in practice - tickets in flight at the same moment were resolving real GitHub repos fine). Toolbar still said `DEPLOYED V2` with `SAVE DRAFT` disabled, i.e. nothing was actually changed - this looks like a client-side data-race on the editor page (providers list not loaded yet vs. rendered as empty) rather than a real config loss. Did not click Deploy while this was showing, to avoid persisting a bogus state. Worth a operator-facing false alarm if someone hits this mid-incident and assumes the provider connection actually dropped.

### CRITICAL - runs parked at "awaiting_approval" are mislabeled SUCCESS, and the Approvals page cannot approve anything
This is the single biggest finding of the session, and it blocks most downstream verification below.

- **Every ticket that reaches the "Send plan for approval" gate in Human-approved plan (the only enabled default workflow) shows top-level status `SUCCESS`** in the ticket header and Recent Runs table, even though the sanitized observation is `{"status": "awaiting_approval", "approvalRequestId": "..."}`, `Trigger Plan Approved` through `Update Ticket Status` are all `SKIPPED`, and nothing has shipped (no PR, no ticket status change). Reproduced identically on AWP-41, AWP-45, AWP-47 (all "SUCCESS" badge, all actually just parked waiting for a human).
- **The Approvals page (sidebar - Approvals) cannot be used to approve anything:**
  - It lists only **1** pending approval (`AWP-8`, dated 30 Jul 16:44) when at least 4 were genuinely pending during this session (AWP-8, 41, 45, 47 - and likely 42, 44, 48 too). Confirmed after a hard refresh, so not a client cache issue.
  - The one row it does show is **not clickable** - clicking the row, the chevron, or via direct element reference does nothing at all: no navigation, no modal, no network request fires (confirmed via network tab - no XHR/fetch on click). There is no visible way to approve or reject a plan anywhere in the dashboard.
  - The row also renders **twice with two different timestamp formats** for the same approval ("30 Jul, 16:44" vs "Jul 30, 02:44 PM") - looks like an SSR/client hydration mismatch on top of everything else.
- **Net effect: on production right now, no ticket that needs plan approval can ever be completed through the dashboard.** Since "Human-approved plan" is the only enabled workflow and every non-trivial ticket goes through this gate, this is close to a full-severity blocker for the AWP instance - every plan that needs approval is invisible and stuck forever, but *looks* like a successful run to anyone glancing at ticket lists.
- **Independent confirmation from the team, same day:** in `#ai-workflow` Slack (2026-07-30 16:32 CEST), Karol Chudzik wrote while testing the same workflow: *"I realized there's really no plan revision step if it gets rejected, but I don't think Arthur is using that workflow."* So a colleague hit an adjacent gap (no revision path on rejection) independently today. **Important context from that same thread:** the team is targeting **Monday (2026-08-03) for the Arthur release**, and per Karol, **Arthur does not use the Human-approved plan workflow** - so this specific bug may not be a hard blocker for Monday, but it is a live, broken, shipped feature of the `ai-workflow-prod` product surface and should still be fixed.
- **Downstream impact on this test session:** because no plan can be approved, I could not verify several planned use cases end-to-end (repo pin destination, multi-repo PR creation from a fresh trigger, self-authored PR review, recursion suppression) for any ticket that hit this gate - they're stuck at "awaiting_approval" and I'm reporting that honestly rather than working around it. AWP-37/38 (multi-repo cross-provider, see below) predate this test and already reached PR/MR, so multi-repo publication itself is separately confirmed to work; what's blocked now is *triggering fresh verification*.

### Silent black hole: a ticket in the Ai column can get zero runs, forever, with no error anywhere
- **Repro:** AWP-49 was moved to Ai while "Reviewed ticket workflow" was briefly enabled (during the workflow-swap test below), got no run. Assumed a timing race, so re-tested cleanly: moved it back to "Do zrobienia" and back to "Ai" *after* "Human-approved plan" was already stably re-enabled and actively processing other tickets fine (AWP-41/42/44/45/46/47 all dispatched normally under it around the same time).
- **AWP-49 still gets zero runs.** Runtime logs show exactly why, on every single webhook delivery and every cron poll since (18:39, 18:53, and every minute in between): `"msg":"dispatch_skipped_no_definition"`, `"started":false,"reason":"no_definition"`. Meanwhile the ticket is correctly discovered every poll cycle (`poll_discovered_tickets`, `ticketCount: 2-3`) and correctly shows `status: Ai` in Jira - the system knows it's there and sees it every minute, and skips it every single time.
- **This is not a global outage** - Human-approved plan is dispatching normally for every other ticket at the exact same timestamps. Something about AWP-49 specifically got stuck resolving "no definition," most likely a workflow-definition binding captured at its *first* Ai-column entry (while "Reviewed ticket workflow" was enabled) that never gets refreshed when the enabled definition changes later.
- **Why this is worse than a failure:** a FAILED or BLOCKED run at least tells you something happened. This ticket sits in the Ai column indefinitely, gets silently skipped forever, and nothing anywhere (Jira, Slack, dashboard) says so. The only way I found it was by noticing "0 runs recorded" on the ticket page and then confirming the reason in raw runtime logs - an ordinary user has no path to discover this, let alone recover from it (moving it out and back in doesn't help, as shown above).

### Reconciler mislabels a genuinely-failed run as "cancelled" (old bug family, recurring)
- AWP-48 (Fully modular test) failed for a real reason at 18:37 (`Agent reported success but made no commits`, see below). At 18:41:41 the reconciler ran, logged `cancel_run_already_terminal` (correctly recognizing the run was already terminal), but *still* proceeded to log `reconcile_cancelled_orphaned_run`, update the Slack thread with `eventKind":"canceled"`, and send a "canceled" notification - for a run that had already failed with its own specific diagnostic. This is the same defect family as the `prod-e2e-findings-2026-07-27` note on `markRunSucceededOnSelfMove`/cancellation-vs-terminal-reason races (memory: *"udany run dostał status_reason o anulowaniu przez reconceler... własny ruch ticketa wyścigujący zakończenie runa"*) - looks like it's still not fully closed, now hitting the failure path too, not just the success path.

### Minor: cached Jira status name in a different language than the project's actual locale
- Runtime log at 18:41/18:53: `"configured":"REVIEW","statusId":"11418","statusName":"审查"` (Chinese for "review"). The actual Jira status name for id 11418 in this project is **"Weryfikacja"** (Polish), confirmed directly via the Jira API. Somewhere the worker has a stale/wrong cached label for this status ID - cosmetic (only shows up in structured logs, not user-facing yet), but suggests a status-name cache that isn't keyed correctly (maybe bled in from another project/environment).

### Positive: edge-case ticket content handled well
- **AWP-46** (mentions a nonexistent repo `Blazity/ai-workflow-billing-service`): correctly detected the repo isn't in the accessible catalog and asked a clarifying question (*"that repository is not present in the accessible catalog. Should I research the closest related repo instead, or is there a different repoPath I should use?"*) instead of crashing or silently guessing a repo. This is the right behavior.
- **AWP-44** (one-line ticket, "Update the README file.", no repo named, no acceptance criteria): correctly asked *"Which repository should I research for ticket AWP-44? The catalog only shows [the 3 allowlisted repos]... the ticket text does not identify which one."* - sensible, didn't guess, didn't crash on a near-empty ticket.
- **AWP-45** (ticket title/description entirely in Polish, with diacritics: "Dodaj sekcję FAQ do README"): planning completed cleanly, no mangling of the non-ASCII text visible anywhere in the trace. (It's still stuck at the approval-mislabel bug above like everything else, but the language handling itself is fine.)

### Minor: redaction false-positive mangles a UUID
- AWP-45's sanitized output: `"approvalRequestId": "0b363504-[REDACTED:phone]-0cdea08acfe2"` - the phone-number redaction pattern is matching a random hex segment inside a UUID and replacing it, corrupting the ID as displayed. Low severity (cosmetic, only affects reading the ID off the UI) but a real false positive in the PII scrubber.

### Repo pin (AWP-47) and Fully modular / Reviewed ticket workflow swap - partial results
- **Repo pin:** configured Source Scope to pin `Blazity/ai-workflow-demo` only, deployed as V3, created AWP-47 explicitly naming `ai-workflow-prod` in its text, triggered it, then reverted the pin and redeployed as V4 (~30s window). AWP-47 ran under "DEFINITION V3" (confirms the pinned version was in effect for this run) and completed planning successfully, but is stuck at the approval-mislabel bug above before implementation/repo-selection would become externally visible via a PR - **so whether the pin actually beat the naive ticket-content signal is unverified**, pending the approvals fix.
- **Fully modular (legacy V1, no approval gate):** AWP-48 (LICENSE badge) got a real run and **FAILED** with `An external service could not complete this block. (Agent reported success but made no commits)` - the implementation agent claimed success without actually writing/committing the change. This is an existing guardrail correctly catching a bad agent turn (the same check exists in `pr-external-resources.ts`), so it's more a note that the V1 "Fully modular" path hit a flaky agent turn during this smoke run than a new systemic bug - but also confirms V1's weaker observability first-hand ("Visual replay was not captured for this run. Showing the legacy step trace.").
- **Reviewed ticket workflow (legacy V1, parallel reviewers):** AWP-49 never got a run at all - see the black-hole bug above. Unverified whether the three-reviewer fan-out itself works.
- Both legacy workflows were disabled again and Human-approved plan + Post-PR review restored to their pre-test enabled state (Post-PR review is a genuine config change kept live per your go-ahead, see below).

### Concurrent tickets on the same repo - no cross-contamination
AWP-41 (Prettier badge) and AWP-42 (Node engine badge) were both moved to Ai within the same second, both targeting `ai-workflow-prod` README.md. Each planning run independently reasoned about its own scope only: AWP-41 planned the Prettier badge cleanly; AWP-42 correctly noticed the repo has no declared Node version anywhere (`package.json`, `.nvmrc`, `.tool-versions`, CI config) and asked a well-scoped clarifying question with concrete suggested answers, with zero mention of or interference from AWP-41's badge. No branch, workspace, or context bleed observed between the two. Good result - this is the one use case with no negative finding.

## Current production config left changed by this session

- **`Post-PR review` workflow definition (V1, legacy) is now ENABLED** (was disabled at session start). Triggers on any `PR ready for review` / `PR updated` event across all allowlisted repos, not just bot PRs. Left on deliberately to get organic exercise from the bot PRs this session generated. **Needs an explicit decision on whether to keep it enabled long-term** - it hasn't produced a confirmed clean run yet (worth checking `/approvals`-adjacent surfaces... actually check `Workflow runs` for any `Post PR review` executions once approvals are unblocked, since it can only fire once a PR actually exists, which none of this session's tickets reached).
- **`Fully modular`** and **`Reviewed ticket workflow`** (both V1 legacy) were enabled briefly for testing and are now back to **disabled**, matching session-start state.
- **`Human-approved plan`** is enabled (unchanged from session start) with its Source Scope back to "Automatic per ticket" (the repo pin used for AWP-47 was applied then reverted, net no-op - now at "DEPLOYED V4").
- **Test tickets left in Jira (AWP-41 through AWP-49)** are genuine test data, mostly parked at `awaiting_approval` because of the Approvals bug above - not real work, safe to close out once triaged.
- **`GITHUB_BOT_LOGIN` / `VCS_BOT_LOGIN` confirmed still absent from production env** (checked live via `vercel env ls production`, not just carried over from old memory) - GitHub-side recursion suppression for the bot's own comments is confirmed still not configured. Did not attempt a live self-comment-loop repro given the missing safeguard - risk of an uncontrolled retrigger loop in production wasn't worth it for a test that's already evidenced by the config gap alone.

## Priority summary for the next session

1. **Fix the Approvals page** (can't list all pending approvals, can't click the one it does list, mislabels the whole run as `SUCCESS`) - this is the top blocker; without it, "Human-approved plan" cannot actually ship anything through the dashboard.
2. **Fix the `AWP-49`-class black hole**: a ticket in the Ai column that resolves to `no_definition` gets silently skipped forever with zero user-visible signal. At minimum, this needs to surface an error/blocked state; ideally the workflow-definition binding should re-resolve against the currently-enabled definition rather than sticking to whatever was enabled at first entry.
3. **Fix or scope down the branch-ref-404 retry cost** in `promoteRepositoryWriteScope` (near-100% hit rate, mostly self-heals but wastes retry budget and occasionally hard-fails a run).
4. **Fix the truncated `open-pr-finalize` clone-failure message** (or confirm the raw stderr really is that short, in which case the bug is in the sandbox/clone step itself, not the message formatting).
5. **Fix the reconciler mislabeling a real FAILED run as "cancelled"** in Slack/dashboard (AWP-48 evidence) - same bug family as the 2026-07-27 terminal-status-accuracy fixes, not fully closed.
6. Re-verify self-authored-PR-review 422 and repo-pin-destination once (1) is fixed and plans can actually be approved.
7. Lower priority: prompt-library usage 500s, harness-skill-discovery 422 UX, redaction false-positive on UUIDs, Chinese-cached status name, dashboard "Now running"/HITL-panel staleness, SSR/client duplicate-row hydration mismatch on Approvals.

Per the team's Slack thread today, Arthur (Monday 2026-08-03 release target) does not use the
`Human-approved plan` workflow, so item 1 may not be a hard blocker for that specific release -
but it's a real, currently-broken, shipped feature of `ai-workflow-prod` and should still be
triaged before calling this workflow release-ready for anyone who does use it.
