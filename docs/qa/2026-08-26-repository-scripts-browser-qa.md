# Repository scripts: browser click-through, edge cases and fixes (2026-08-26)

Second production pass over the repository scripts feature, after the ticket-driven matrix of [2026-08-23](./2026-08-23-repository-scripts-prod-qa.md). This time the dashboard was driven in a real browser (Claude in Chrome against `ai-workflow-app-dashboard.vercel.app`), the run traces and Jira comments of runs A, B, C, D and G were inspected screen by screen, and the MCP `runs_diagnose` classifier was queried for the failing runs. Every defect found was fixed at its root on `fix/repository-scripts-qa-findings` (see "Fixes"), not patched over. Screenshots live in [`assets/2026-08-26-repository-scripts/`](./assets/2026-08-26-repository-scripts/).

## What was exercised in the browser

| Area | Steps | Result |
|---|---|---|
| `/scripts` editor, three shapes in one document | legacy `commands` entry (Blazity/ai-workflow), echo-stub legacy entry, fixture with 9 named groups (shots 01 to 10) | renders, history v1..v14 visible with restore per version |
| Gate groups | untick every gate group | flips to "Gate on all groups" with the note "Now gating on all groups." (an empty gate cannot be produced from the UI) |
| Batch timeout | type 200 | input clamps to 180 (shot 11); non-positive values block Save |
| Duplicate group name | rename `hang` to `fail` | Save disabled, in-card "A group named "fail" already exists." plus the Save blocker |
| Extends cycle | tick "verify" in the `lint` card while `verify` extends `lint` | Save stayed enabled, no message; only the server 400 would have reported it (shot 12): finding 3 |
| Install-command hint | echo stub whose quoted text mentions `yarn install` | red hint fired on prose (shot 01): finding 1 |
| Workflow editor, `run_scripts` panel | add the block from the palette | free-text group list plus "Configured" chips with the live group names (shot 14) |
| Branch on typed outcome | add Branch after Run scripts, open the value picker | fields typed (status TEXT, ok BOOLEAN, outcome ENUM, allPassed/anyFailed BOOLEAN, lists); `outcome` value is a select with passed / failed / skipped / missing_configuration, booleans get True/False (shots 16, 17) |
| Run trace, run A (green, 647 s batch) | open the Run pre-PR checks node | per-command results with status badge, exit code, group, duration; dirtied repositories; raw JSON; "1 REDACTION" (shots 18, 19) |
| Secret scrub | search the DOM of run A and C traces for `aiw-fixture-secret-9143` | never present; inline secret in a command shows `[REDACTED:command_argument]` |
| Run trace, runs B, C, G | open the checks node | failure blocks with exit 3 / exit 124 / phase batch (shots 21, 22, 23); but the run-level error and the group statuses exposed findings 6 and 7 |
| Jira comments AWP-112, 113, 114, 116 | read the failure comments | findings 4, 5, 10 (shots 24 to 27) |
| MCP `runs_diagnose` | B, C, D, G | finding 8 |

## Findings and root-cause fixes

| # | Surface | Observation | Root cause | Fix |
|---|---|---|---|---|
| 1 | `/scripts` editor | install hint fires on `echo "yarn install was not run; ..."; exit 0` | bare regexes tested against the whole line, no quoting or command-position awareness | shell-aware `looksLikeInstallCommand`: quoted runs blanked (a `'` inside a word is prose), segments split on `&&` `\|\|` `;` `\|` newline, match only at segment start after `VAR=x` / `sudo` / `env`; patterns widened (`npm i`, `apt install`, `pip3`, `python -m pip`, `corepack`, `nvm install`, `make install`, `pnpm --filter x install`, bare `yarn`); 28 must-flag and 7 must-not-flag cases |
| 2 | editor + worker + reports | group order follows jsonb key order (length, then alphabet), so cards jump after save/reload and the default gate order differs from the editor | Postgres jsonb does not keep object key order; nothing sorted | groups are a set: the store canonicalizes key order on every read (`withCanonicalGroupOrder`, current and versions), every worker listing uses `sortedGroupNames`, the editor keeps the server order and does not sort on its own (a client sort plus `key={i}` plus per-keystroke rename would re-target keystrokes) and says so: "Script groups are listed by name. Run order follows extends, not the position in this list." |
| 2b | editor | renaming `test` to `2fa` moved the card under the cursor: `"2"` became an array-index key, `Object.keys` put it first, the focused input now belonged to another group | an invalid draft was committed as an object key | invalid or duplicate drafts stay uncommitted (`PendingGroupNameDraft` with reason), Save blocked with `group name "2fa" is invalid (...)`; the empty name is held the same way |
| 3 | editor | extends cycle not caught client-side | detector lived privately in the worker | `findExtendsCycle` moved to `apps/shared/contracts/repository-scripts.ts`, used by the worker schema and by the editor: Save blocker `cycle in extends: lint -> verify -> lint`, plus an in-card line on every group on the path; unknown extends targets reported too; the blocker is a `role="status"` region referenced by the Save button's `aria-describedby` |
| 4 | Jira comment | failing command and tail rendered twice | `repositoryScriptsFailureComment` included both `scripts.summary` (already renders every failure) and its own per-failure renderer | summary only when `failures` is empty (unreadable configuration) |
| 5 | Jira comment | batch stopped by `batchTimeoutMinutes` after partial progress led with "Repository scripts could not be started." | phase `batch` fell into the not-started bucket | own lead "Repository scripts were stopped before finishing." (failed > budget > batch > not started) |
| 6 | block output, branch semantics | `deps`, `lint`, `unit` read `skipped` while their commands ran and passed inside `verify`'s expansion; results carried `group: verify` (shots 18, 21, 22) | `planRepository` tagged commands with the SELECTING group; `groupStatusesFor` returned `skipped` for any group outside the selection before looking at results | results carry the DECLARING group; a group's status derives from its full expansion: failed > timed_out > passed (all commands have results) > not_run (selected, not reached) > skipped; block-registry docs restated |
| 7 | run trace and Jira lead | run-level error read "No repository scripts gate was recorded ... the scripts reported failures" and never named the command (shots 20, 24) | finalize reduced the recovered scripts output to a boolean before building the message | the recovered output is threaded to the gate; refusal reads `Repository scripts failed, so publication was refused: <repo>: <command> (exit N); and K more` (variants for timed out / stopped); missing-gate wording only when no scripts failure is known; stems live in one module (`blocks/repository-scripts-output.ts`) shared by the comment, the gate and the diagnose classifier |
| 8 | MCP `runs_diagnose` | B, C, G classified `workspace_gate` with the next action "Confirm the run workspace was not modified after checks passed"; D (setup exit 7) classified `unknown` | wording match; the after-failure gate sentence carried no scripts keyword; the setup summary matched nothing | structural rules into `repository_scripts_failed` (imported constants), ahead of `workspace_gate`; next actions point at the run trace and the Repository scripts screen; setup flavour has its own pair |
| 9 | batch stopped message | "5 of 8 commands had finished" while the block listed 1 result (shot 22): the 4 setup verification commands were counted | progress counted every marker in the batch script | script commands only: "1 of 4 script commands had finished" |
| 10 | Jira comment, setup failure | `(SETUP FAILED for ... Command: e [...] ng but the missing toolchain ...)`: command and exit code elided (shot 26) | the structured setup failure was flattened into one bounded line at prepare | run reason `Setup failed in 1 of 1 repositories: <repo>: <command> (exit N). Fix the setup command on the Repository scripts screen.`; the ticket comment renders setup failures as structured blocks via `EngineCtx.setupFailures` |

Observations outside the feature (documented, not changed): definitions saved through MCP carry no layout, so the editor stacks every node at the origin (shot 13); a fresh Branch node from the palette opens with "This pre-release Branch uses an obsolete configuration" and needs "Replace condition" first (shot 15); a block with no path from the trigger disables every downstream picker entry with "can be skipped on a path" (correct, the hint could name reachability); the failure summary in the trace output panel collapses line breaks into one paragraph (shot 21).

## Verification

- Worker: `vitest` over the 17 touched test files plus 9 neighbouring consumers of the changed exports, 26 files / 776 tests green; `pnpm --filter worker typecheck` clean. Dashboard: 25 tests green (`node --test` on `repository-scripts.test.tsx`), `tsc --noEmit` clean. Wide verification through CI on the PR.
- Reviewer and skeptic gates on both stages; every finding either fixed or recorded above with its reason.
- Production re-verification after deploy: see "Production re-check" below.

## Production re-check

_Filled in after the deploy._
