# GitLab MR review comments: multi-round live verification

**Date:** 2026-08-21 · **Instance:** our production (`ai-workflow-app`, main at `73d612ce`, includes fix PR #325) · **Repo:** `gitlab.com/filipmaszota3/ai-workflow-integration-test` (billing-core) · **Ticket:** AWP-107 · **MR:** [!11](https://gitlab.com/filipmaszota3/ai-workflow-integration-test/-/merge_requests/11)

## Verdict

| Round | Comments posted on the MR | Run | Outcome | Comments addressed |
| --- | --- | --- | --- | --- |
| 1 | ticket only (no comments) | `wrun_01M0HHAPHNNP11VC4GCC0TCGKF` (def 14, Haiku) | SUCCESS, MR !11 opened | n/a |
| 2 | 3 human + 3 from our reviewer | `wrun_01M0HHXQ9JH6P3C2CXR4NCX8HB` (def 29 autofix, Codex, fired by webhook) | SUCCESS, commit `bf1b7aed` | **6 / 6** |
| 2b (control) | none left | `wrun_01M0HJ2DFN3NCXE48RNXRZ6AXD` (def 14, Haiku), `wrun_01M0HJX86WGA1AXNNJA3YDMFP1` (def 30, Opus) | FAILED, "made no commits" | no duplicate work, no fake success |
| 3 | 2 human | `wrun_01M0HNS7E4CQ6VAPGTT6TTE8CK` (def 14, Haiku) | FAILED, "made no commits" | **0 / 2** (model judged them covered; caught by finalize) |
| 3 (retry) | same 2 | `wrun_01M0HP9FP71FMDVT2X4VR0PQPE` (def 30, Opus) | SUCCESS, commit `596b37a6` | **2 / 2** |

Eight review comments across two rounds, eight changes on the branch, each traceable to its comment, zero duplicated work, zero silent "already resolved" exits. Details and evidence below.

## Question under test

Does a ticket re-trigger really deliver GitLab MR review comments to the planning and implementation agents, and does the workflow address **all** of them across **multiple review rounds** (the UP-4859 scenario, where Arthur's bot answered "nothing to do" to an explicit review request)?

## Method

One ticket, one MR, successive rounds of human review comments posted directly on the GitLab MR (never in Jira). The comment content exists **only** on the MR, so any implemented change proves the MR comment feed reached an agent. After every round: MR diff and commit inspection (GitLab API), dashboard trace inspection, screenshots. All timestamps UTC.

Workflows involved on our instance:

| Definition | Role | Model |
| --- | --- | --- |
| def 14 "Default ticket workflow" v6 | ticket run: prepare → planning → implementation → checks → finalize → open MR | Claude Haiku 4.5 ("Test - Cheap" profile) |
| def 30 "Release rehearsal" v2 | same graph, manual dispatch only | Claude Opus |
| def 12 Post-PR review | reviews a fresh MR, posts findings, sets commit status `AI Workflow / Review` | |
| def 29 "PR checks failed autofix" v3 | `trigger_pr_checks_failed` → prepare → fetch PR context → fix agent → checks → finalize → MR comment | Codex gpt-5.4 |

## Rounds

### Round 1: baseline implementation (def 14, Haiku)

- Run `wrun_01M0HHAPHNNP11VC4GCC0TCGKF`, SUCCESS, 350 s, 9 blocks.
- Ticket asked for a "Pricing module" README section (Money contract + 3 helpers). Implemented in commit `2e88fbaf`, MR !11 opened at 06:54.
- Evidence: [trace](assets/2026-08-21-mr-comments/round1-run-trace-success.jpg), [MR overview](assets/2026-08-21-mr-comments/round1-mr11-overview.jpg).

### Round 2: three human comments at once

Three separate MR notes posted as `filipmaszota3` at 06:58:17 to 06:58:19 (notes 3714699671, 3714699722, 3714699757):

1. Add an "Error cases" subsection (empty basket, mixed currencies in `totalForItems` and `formatMoneyRange`).
2. State that `amountMinor` is meant to be an integer + mention the known rounding issue.
3. Add a worked example (2 × 10.00 PLN, 10% discount, 23% tax → 4428 minor → "44.28 zl").

Evidence of the posted comments: [screenshot](assets/2026-08-21-mr-comments/round2-three-comments-posted.jpg).

What happened next was not the path I planned, and it is the most interesting result of the day:

**2a. The platform fixed all three comments on its own, before any manual re-trigger.**

Timeline reconstructed from the GitLab API and the run traces:

| Time | Event |
| --- | --- |
| 06:54:44 | MR pipeline 2778706000 on `2e88fbaf` starts; both CI jobs (`gitlab-smoke-test`, `unit-tests`) pass. |
| 06:55:14 | def 12 review posts commit status `AI Workflow / Review` = **failed** on `2e88fbaf` (a Blocker: the README omits the known rounding bug). GitLab attaches the external status to the MR pipeline, so the pipeline itself becomes `failed` at 06:57:53. |
| 06:57:33 | def 12 posts its findings as MR notes (3 inline + 1 summary). |
| 06:58:17 | The 3 human comments above are posted. |
| 07:00:43 | The failed pipeline webhook fires `trigger_pr_checks_failed`: run `wrun_01M0HHXQ9JH6P3C2CXR4NCX8HB` on def 29 (autofix). |
| 07:01:00 | `fetch-context` collects the MR comments (bot + human). |
| 07:01:07 to 07:03:03 | `fix` (Codex gpt-5.4, 116 s) edits README.md. |
| 07:02:14 | Commit `bf1b7aed` "docs: expand pricing module readme" created; pushed at 07:03:00. |
| 07:03:02 to 07:03:17 | New MR pipeline 2778721601 on `bf1b7aed`: **success**. |
| 07:03:35 | Bot note "Automated fix pushed. Please re-review." |

The diff of `bf1b7aed` (README.md only, +64/−5) covers every one of the six open comments:

| Comment (source) | Where it landed in README.md @ `bf1b7aed` |
| --- | --- |
| Error cases subsection (human #1) | `### Error cases`: `totalForItems([])`, mixed currencies in `totalForItems`, `formatMoneyRange` across currencies |
| `amountMinor` is an integer + rounding issue (human #2) | Money contract bullet: "Consumers should treat this as an integer amount even though `applyDiscount` and `applyTax` currently have a known rounding issue…" |
| Worked example 2 × 10.00 PLN → 44.28 zl (human #3) | `### Worked example`: 4000 → 3600 → 4428 minor → `44.28 zl` |
| format.ts helpers undocumented (bot, Medium) | `#### formatMoney`, `#### formatMoneyRange` |
| Rounding bug omitted (bot, Blocker) | "Known limitation" paragraphs under `applyDiscount` and `applyTax` |
| DiscountRule / LineItem undocumented (bot, Medium) | `### Supporting types` |

Evidence: [autofix commit + "please re-review" note + round 3 comments](assets/2026-08-21-mr-comments/round2-autofix-pushed-and-round3-comments.jpg), [autofix run trace](assets/2026-08-21-mr-comments/round2-autofix-run-trace.jpg).

**2b. Two manual ticket re-triggers ran after the fix had already landed, and both refused to fake work.**

I dispatched def 14 manually at 07:02:54 (before I had noticed the autofix). Its `prepare` block cloned the branch at 07:03:18, i.e. **after** `bf1b7aed` was pushed (07:03:00), so the agent saw a README with every comment already addressed.

- Run `wrun_01M0HJ2DFN3NCXE48RNXRZ6AXD` (def 14, Haiku), **FAILED**, 562 s: "Agent reported success but made no commits" (finalize guard).
  - The planner's structured output enumerates the comments one by one and marks each as addressed ([screenshot](assets/2026-08-21-mr-comments/round2-planner-output-lists-comments.jpg)). That is a truthful description of the branch it was looking at, and it proves again that the MR comments are in the planner's prompt.
  - Planning took 301 s because the no-change gate (PR #325) refused the first "already resolved" declaration and forced a retry. The retry found nothing to do either, implementation made no commit, and `finalize` failed the run instead of letting a green no-op through.
- Run `wrun_01M0HJX86WGA1AXNNJA3YDMFP1` (def 30, Claude Opus), **FAILED**, 426 s, same finalize guard, same reason: nothing left to implement.

So the "honest failure" path works with both a cheap and a strong model. The only thing these two runs could have done wrong was to duplicate or rewrite the sections that `bf1b7aed` had just added, and neither did.

### Round 3: two more human comments, manual re-trigger

Two MR notes posted at 07:29:28 to 07:29:29 (notes 3714803578, 3714803617):

1. Add a "Formatting" subsection: PLN renders as `zl` (ASCII, no diacritics), EUR/USD as their codes, values shown with two decimals.
2. "Error cases" should also state that `applyDiscount` and `applyTax` accept out-of-range percentages without validation, and advise validating before calling.

No automatic run fired this time: the MR pipeline on `bf1b7aed` is green and def 12 did not post a new failed status, so there was nothing for `trigger_pr_checks_failed` to react to. A plain MR comment is not a trigger on any of our definitions (see Findings), so the re-trigger was manual:

- Run `wrun_01M0HKVTBYJA04909CP78X3DKY` (def 14, Haiku), **FAILED**, 292 s at `implementation`: "Claude emitted a result envelope without structured JSON". A harness-level flake (the CLI returned a malformed envelope), not a decision by the agent; no commits, branch untouched.
- Retry: run `wrun_01M0HNS7E4CQ6VAPGTT6TTE8CK` (def 14, Haiku), **FAILED**, 352 s, finalize guard "Agent reported success but made no commits". Branch untouched (still at `bf1b7aed`).
  - The planner saw both new comments and **folded them into text that already existed**: its plan lists "formatMoney documented with currency suffix mapping (PLN→zl, EUR→EUR, USD→USD)" and "Percentage validation warnings (both helpers explicitly state no bounds checking)" as done, and opens with "No implementation needed, ticket is already complete" while still returning `status: "ready"` ([screenshot](assets/2026-08-21-mr-comments/round3-haiku-planner-already-complete.jpg)).
  - Implementation repeated the same summary with `commits: []` ([screenshot](assets/2026-08-21-mr-comments/round3-haiku-implementation-no-commits.jpg)).
  - Neither request was literally done: there is no "Formatting" subsection, and "Error cases" says nothing about out-of-range percentages or validating before the call. The existing sentences the model pointed at ("appending the currency suffix (zl, EUR, or USD)", "does not validate percentage bounds") are adjacent, not the requested change. The finalize guard was the only thing standing between this run and a green no-op.
- Same round on a stronger model: run `wrun_01M0HP9FP71FMDVT2X4VR0PQPE` (def 30, Claude Opus 4.6), **SUCCESS**, 394 s, all 8 blocks green through `open-pr` and `status`.
  - Planner output opens with "Two remaining human-reviewer requests need to be addressed in `README.md`. No other file should be modified." and plans exactly those two edits, leaving the six already-handled comments alone ([screenshot](assets/2026-08-21-mr-comments/round3-opus-planner-two-remaining.jpg)).
  - Commit `596b37a6` "docs: add formatting subsection and percentage-validation warning to README" (README.md only, +12/−2). MR pipeline 2778953277 on it: success.
  - Evidence: [run trace](assets/2026-08-21-mr-comments/round3-opus-run-trace-success.jpg), [MR commits tab](assets/2026-08-21-mr-comments/round3-mr11-commits-tab.jpg), [round-3 comments followed by the bot commit](assets/2026-08-21-mr-comments/round3-comments-then-opus-commit.jpg), [MR overview with green pipeline](assets/2026-08-21-mr-comments/round3-mr11-three-commits-pipeline-green.jpg).

README.md on `ai-workflow/awp-107` at `596b37a6`, the two requested changes:

```markdown
63  ### Formatting
64
65  Currency suffixes used in formatted output:
66
67  - `PLN` renders as `zl` (ASCII approximation, without diacritics).
68  - `EUR` renders as `EUR`.
69  - `USD` renders as `USD`.
...
93  ### Error cases
94
95  - `totalForItems([])` throws `Cannot total an empty basket`.
96  - `totalForItems(items)` throws `Cannot total items across currencies` when any `LineItem.unitPrice.currency` differs from the first item.
97  - `formatMoneyRange(from, to)` throws `Cannot format a range across currencies` when `from.currency !== to.currency`.
98  - `applyDiscount` and `applyTax` accept any numeric percentage, including negative values and values above 100, without validation. Consumers should validate percentage inputs before calling these helpers.
```

Final MR state: 3 commits (`2e88fbaf` round 1, `bf1b7aed` autofix for round 2, `596b37a6` round 3), 3 pipelines all green on their final status, "Ready to merge".

### Round 4 (control): re-trigger with nothing new pending

Covered by the two runs in 2b: with every comment already implemented, a re-trigger produces no duplicated work and no silent "already resolved" success; it ends as a FAILED run with an explicit reason.

## Findings

1. **MR comment ingestion works on GitLab, in both directions we ship.** The ticket re-trigger path (def 14/30: planner output enumerating the comments, AWP-105 on 2026-08-20 implementing an MR-only comment) and the autofix path (def 29: `fetch-context` → fix agent implementing six comments in one commit).
2. **Multiple comments in one round are all addressed, and later rounds only touch what is still open.** `bf1b7aed` maps 1:1 onto the six open comments of round 2 (three human, three from our own reviewer). In round 3 the Opus planner named "two remaining human-reviewer requests", implemented exactly those in `596b37a6`, and did not rewrite anything from the earlier rounds. Over three rounds, eight comments in, eight changes out, zero duplicates.
3. **The no_change_needed regression fix (PR #325) behaves as designed.** With review comments pending, the "already resolved" exit is refused and retried (round 2b: planning 301 s with two passes); a run that then produces no commits fails loudly ("Agent reported success but made no commits") instead of reporting success. This is the exact failure Arthur hit on UP-4859, now closed.
4. **Model quality is a separate axis, and the cheap model fails in a second, subtler way.** In round 3 Haiku did not take the `noChangeNeeded` exit at all; it returned `status: "ready"` with a plan that says "No implementation needed" and mapped the two new requests onto adjacent sentences that already existed. The gate from PR #325 never sees this shape, only the finalize guard catches it (as a FAILED run). Opus, given the identical prompt and branch, implemented both requests literally on the first pass. This is direct evidence for running Arthur's planning and implementation on a strong model (the Luna → Sol change already made on 2026-08-20), and an argument for a future check that a "ready" plan with pending review comments actually declares edits.
5. **On our instance the review → fix loop is closed automatically.** The post-PR reviewer sets a failed commit status, GitLab folds it into the MR pipeline, the pipeline webhook fires the autofix, and the autofix reads every comment on the MR, human ones included. This is why the three round-2 comments were fixed within 5 minutes without anyone touching the ticket. **Arthur does not have this loop**: its GitLab webhook was never registered (zero deliveries in 14 days of logs), so on Arthur a comment only reaches an agent when someone re-triggers the ticket.
6. **"Nothing left to do" is reported as a FAILED run.** Once all comments are implemented, a further re-trigger can only end in the finalize guard. Correct for the UP-4859 regression, but noisy. Follow-up: let the no-change gate treat *resolved* review threads as not pending, so a clean re-trigger can end as `no_change_needed` again.
7. **Harness flake observed once**: "Claude emitted a result envelope without structured JSON" (Haiku, `implementation`, 291 s). The run failed cleanly with no commits; the retry ran through. Worth a counter in diagnostics, not a blocker.
8. **No trigger on MR comments exists.** None of our definitions listens to `note` events, and Arthur's webhook is not live either. Until that changes, "add a comment and wait" does nothing on Arthur by design; the human has to re-trigger the ticket or push a failing pipeline.

## Reproduction notes

- Ticket and MR: AWP-107 / MR !11 in `filipmaszota3/ai-workflow-integration-test`, branch `ai-workflow/awp-107`.
- Manual dispatch: MCP `workflows_dispatch_preflight` + `workflows_dispatch` on def 14 (trigger node `trigger`, deployed version 6). A ticket keeps its claim for 6 to 17 min after a run ends; a dispatch in that window returns CONFLICT, wait and retry.
- Our cron poll runs `*/15`, so a Jira transition is picked up with up to 15 min delay; manual MCP dispatch bypasses it.
