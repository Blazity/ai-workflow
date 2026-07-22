# AIW-140: Restore PR review-comment ingestion across workflow versions

- Ticket: [AIW-140](https://blazity.atlassian.net/browse/AIW-140) (Highest, epic AIW-118)
- Date: 2026-07-23
- Branch: `fix/aiw-140-pr-review-ingestion`
- Code references are as of commit `ea307e5`.

## 1. Scope and acceptance criteria

Human PR review comments do not reliably reach the right workflow run. This plan traces the real ingestion flow (webhook received -> matched to a run -> routed to a fix/review block) for both execution paths and states, per acceptance criterion, the root cause, the proposed fix, edge cases, and verification.

Acceptance criteria:

1. **AC1**: A human PR review comment reaches the correct run and its fix/review block.
2. **AC2**: Both legacy and definition-driven (v2) paths are covered.
3. **AC3**: Duplicate webhook deliveries do not create duplicate runs.
4. **AC4**: AI Workflow's own comments cannot recursively trigger the workflow (bot-loop guard).
5. **AC5**: Failed ingestion is visible via a safe diagnostic ID.

## 2. Current end-to-end flow (traced)

### 2.1 Shared entry and dispatch (both paths)

There is a single execution engine. "Legacy" is not a separate dispatcher: it is the built-in default graph (`defaultWorkflowDefinition`, `apps/worker/src/workflow-definition/default.ts:16`) selected via the `BUILTIN_FALLBACK_DEFINITION_VERSION` sentinel (`apps/worker/src/workflows/agent-input.ts:37`). Everything below is shared until definition resolution.

GitHub review-submission event, hop by hop:

| # | Step | Location |
|---|------|----------|
| 1 | HMAC signature verified (401 on failure) | `apps/worker/src/routes/webhooks/github.post.ts:22-30`, `apps/worker/src/lib/github-webhook-sig.ts:9-27` |
| 2 | Event type from `X-GitHub-Event`, delivery id from `X-GitHub-Delivery` | `github.post.ts:32-36` |
| 3 | Normalization to a `TriggerEvent` | `normalizeGitHubEvent`, `apps/worker/src/lib/trigger-events.ts:44-138` |
| 4 | `pull_request_review` (action `submitted`) becomes `trigger_pr_review` with `pr.review = { state, author, body }`; bot-authored reviews dropped | `trigger-events.ts:115-135` |
| 5 | Dispatch: enabled-definition gate, provider/scope filter, eligibility re-check | `dispatchTriggerEvent`, `apps/worker/src/lib/dispatch-trigger.ts:92-122` |
| 6 | Freshness: re-read live PR head, bind or reject stale | `dispatch-trigger.ts:129-132`, `apps/worker/src/lib/trigger-current-pull-request.ts:33-78` |
| 7 | Run matching: PR -> owning ticket -> subject key | `resolveSubjectIdentity`, `dispatch-trigger.ts:418-446`; `findWorkflowOwnedPullRequest`, `apps/worker/src/db/queries/workflow-owned-branches.ts:100-142` |
| 8 | Durable idempotent inbox insert | `acceptTriggerDelivery`, `apps/worker/src/lib/trigger-delivery-store.ts:38-71` (PK `(provider, delivery_id)`, `apps/worker/src/db/schema.ts:95`) |
| 9 | Capacity claim + workflow start (always a fresh run, never a resume) | `dispatchAcceptedTrigger`, `dispatch-trigger.ts:266-317`; `claimSubjectRun`, `apps/worker/src/lib/dispatch.ts:143-188` |
| 10 | Run loads the pinned definition version and walks the graph | `agentWorkflow`, `apps/worker/src/workflows/agent.ts:1234`; `loadWorkflowDefinitionFor`, `apps/worker/src/workflows/definition-step.ts:62` |

GitLab: `gitlab.post.ts:34-41` allows `Merge Request Hook`, `Pipeline Hook`, `Note Hook`. Every eligible MR note (discussion and inline diff notes alike) becomes `trigger_pr_review` with state `commented` (`trigger-events.ts:185-215`), then follows the same dispatch chain.

Concurrency and backlog around the shared chain:

- One pending semantic event per subject: partial unique index `trigger_deliveries_one_pending_per_subject_idx` (`schema.ts:96-98`); newer feedback merges into the pending row (`coalescePendingTrigger`, `trigger-delivery-store.ts:126-184`).
- Same-subject serialization through `active_runs` owner CAS (`schema.ts:29-53`); a second event while a run is active coalesces (`coalesceOrRecoverStarted`, `dispatch-trigger.ts:340-375`).
- After a run releases its subject, the cron poll drains at most one successor (`routes/cron/poll.get.ts:77` -> `drainOldestPendingTrigger`, `dispatch-trigger.ts:378-416`).

### 2.2 Definition-driven (v2) path

`trigger_pr_review` is an entry trigger node (`apps/shared/contracts/domain.ts:182`, params `providers`/`scope`/`on` at `apps/shared/contracts/workflow-graph.ts:83`; zod at `apps/worker/src/workflow-definition/schema.ts:132-144`). A review event starts a fresh run of the currently enabled definition (resolved by `getEnabledWorkflowDefinitionForTrigger`, `apps/worker/src/workflow-definition/store.ts:330`), pinned to `definitionId` + `definitionVersion` at accept time (`dispatch-trigger.ts:140-147`) so later deploys cannot change an in-flight run (this is the "across workflow versions" dimension).

Inside the run, the interpreter (`executeGraph`, `apps/worker/src/workflow-definition/interpreter.ts:254`) walks from the trigger. The reference shape is the integration-tested fixture `prReviewFixDefinition()` (`apps/worker/src/workflow-definition/graph-fixtures.ts:240-260`):

```
trigger_pr_review -> fetch_pr_context -> fix_agent -> finalize_workspace -> post_pr_comment
```

`fix_agent` folds `pr.review` into its context (`apps/worker/src/workflows/blocks/fix-agent.ts:122-135`); `fetch_pr_context` re-reads all PR comments with anchors (`apps/worker/src/workflows/blocks/fetch-pr-context.ts:37-71`, `apps/worker/src/adapters/vcs/github.ts:227-272`), surfaced to prompts as `{{pr_review_feedback}}` (`apps/shared/contracts/prompt-variables.ts:22`).

### 2.3 Legacy path

The built-in default graph is ticket-only: its single trigger is `trigger_ticket_ai` and it contains no `trigger_pr_review` and no `fix_agent` (`default.ts:17-54`). The PR-trigger dispatcher hard-requires a stored enabled definition: `if (!enabled?.current) return { result: "no_definition" }` (`dispatch-trigger.ts:104-105`). The ticket dispatcher has a builtin fallback (`dispatch.ts:108-110`) but the PR-trigger dispatcher does not, and `loadWorkflowDefinitionFor` only builds the builtin for ticket triggers (`definition-step.ts:118-128`, `:158-164`).

Net effect: on a legacy install, every `trigger_pr_review` webhook dies with `no_definition`. Review feedback is only consumed indirectly when a human moves the ticket back into the AI column: the ticket re-run pre-fetches PR comments into planning (`agent.ts:1925-1937`, remediation framing in `apps/worker/src/sandbox/context.ts:387-399`, shipped in `43c4f94`).

### 2.4 What works today, per event

| Provider event | Today | After this plan |
|---|---|---|
| GitHub `pull_request_review` submitted (`changes_requested`/`commented`) | v2 only, needs enabled definition with `trigger_pr_review` | v2 + legacy fallback |
| GitHub `pull_request_review_comment` (inline diff comment) | dropped: `ignored event_pull_request_review_comment` | ingested as `commented` review |
| GitHub `issue_comment` on a PR (conversation comment) | dropped: `ignored event_issue_comment` | ingested as `commented` review |
| GitLab MR note (discussion + inline) | v2 only, needs enabled definition | v2 + legacy fallback |

## 3. Gap analysis and fixes per acceptance criterion

### AC1: a human PR review comment reaches the correct run and its fix/review block

**Root causes**

1. GitHub comment events are not ingested at all. `normalizeGitHubEvent` handles only `pull_request`, `check_run`, `pull_request_review` and returns `null` for everything else (`trigger-events.ts:137`); the route then answers `{ status: "ignored", reason: "event_pull_request_review_comment" | "event_issue_comment" }` (`github.post.ts:124`). Zero references to `pull_request_review_comment` or `issue_comment` exist in `apps/worker/src`. GitLab already ingests the equivalent notes, so this is a GitHub-only parity gap.
2. `issue_comment` payloads carry no head SHA, head ref, or base ref (only `issue`), while freshness binding hard-compares `current.headSha !== pr.headSha` and `current.baseRef !== pr.baseRef` (`trigger-current-pull-request.ts:39,44`) and run matching requires branch-name equality (`workflow-owned-branches.ts:119`).

**Proposed fix**

- F1.1 Normalize `pull_request_review_comment` (action `created` only) in `normalizeGitHubEvent` (`trigger-events.ts`, new branch next to `:115`): `triggerType: "trigger_pr_review"`, `review = { state: "commented", author: comment.user.login, body: comment.body }`, delivery producer = comment author. The payload carries a full `pull_request` object, so `mapGitHubPullRequest` applies unchanged.
- F1.2 Normalize `issue_comment` (action `created`, only when `body.issue.pull_request` is present, which marks the issue as a PR): same review shape; `pr` built from issue fields (`prNumber = issue.number`, `prUrl = issue.pull_request.html_url`, `title = issue.title`, `author = issue.user.login`) with empty `headRef`/`headSha`/`baseRef`.
- F1.3 Route: extend the `reviewStates` pre-seed condition (`github.post.ts:75-78`) so the two new event names seed `["commented"]`, and pass them into normalization like today.
- F1.4 Freshness binding tolerance, restricted to `trigger_pr_review`: in `bindCurrentPullRequest` (`trigger-current-pull-request.ts:39-44`) treat an empty `pr.baseRef`/`pr.headSha` as "unknown, adopt the current provider value" instead of "stale". This mirrors the existing GitLab pattern (`:64` guards with `pr.headSha &&`, `:76` adopts `current.headSha`). Review feedback is about the PR, not about a specific head, so adopting the live head is semantically correct.
- F1.5 Run matching without a branch name: in `findWorkflowOwnedPullRequest` (`workflow-owned-branches.ts:100-142`) drop the `prBranchName` equality when the caller passes an empty `branchName` (the published-head-SHA and target-branch checks at `:120-127` remain, so we still only match PRs whose head the workflow itself published). `resolveSubjectIdentity` (`dispatch-trigger.ts:439-446`) passes the post-binding values, which after F1.4 are the provider-authoritative ones.

With these, both new events flow through the existing chain (section 2.1) to the same subject and, on v2, start the definition's `trigger_pr_review` entry (fix/review block per the definition graph). Legacy coverage is AC2.

**Edge cases**

- `issue_comment` on a plain issue (no `issue.pull_request`): ignored.
- Comment actions `edited`/`deleted`: ignored (only `created`), matching GitLab's `action === "create"` guard (`trigger-events.ts:196`).
- Comment on a closed/merged PR: `bindCurrentPullRequest` requires state `open` for review triggers (`trigger-current-pull-request.ts:40-42`) -> `ignored_stale_head`. Intentional: there is nothing to fix on a closed PR.
- Review-thread replies are `pull_request_review_comment` `created` events and are covered by F1.1.
- `approved` review submissions stay filtered by allowed states (`trigger-events.ts:120-121`).
- All new events carry state `commented`, which stays opt-in per definition (`on` param) and hard-gated on a configured bot login (`dispatch-trigger.ts:254-258`); without `GITHUB_BOT_LOGIN`/`VCS_BOT_LOGIN` comment ingestion stays off (fails safe, see AC4).
- GitLab needs no change here (Note Hook already covers both note kinds).

**Verification**

- `apps/worker/src/lib/trigger-events.test.ts`: new cases: review-comment maps to `commented` review; issue-comment on PR maps; issue-comment on non-PR returns null; `edited` returns null; bot author returns null.
- `apps/worker/src/routes/webhooks/github.post.test.ts`: the two new event names dispatch; unrelated events still `ignored`.
- New unit tests for `bindCurrentPullRequest` adoption (empty headSha/baseRef) and `findWorkflowOwnedPullRequest` empty-branch lookup (`apps/worker/src/db/queries/workflow-owned-branches.test.ts`).
- Manual reproduction: section 5.

### AC2: both legacy and definition-driven paths are covered

**Root cause**

`dispatchTriggerEvent` returns `no_definition` when no stored enabled definition exists for `trigger_pr_review` (`dispatch-trigger.ts:104-105`); the builtin fallback exists only for ticket dispatch (`dispatch.ts:108-110`) and only ticket triggers may load the builtin graph (`definition-step.ts:118-128`). The builtin graph itself has no review path (`default.ts:17-54`). Additionally `trigger_deliveries.definition_id`/`definition_version` are `NOT NULL` with a composite FK to `workflow_definition_versions` (`schema.ts:86-87,99-106`), so a builtin-fallback delivery cannot even be recorded today.

**Proposed fix**

- F2.1 Add `defaultReviewFixDefinition()` to `apps/worker/src/workflow-definition/default.ts`, shaped exactly like the already integration-tested fixture (`graph-fixtures.ts:240-260`): `trigger_pr_review` (providers `github`+`gitlab`, scope `workflow_owned`, on `["changes_requested","commented"]`) -> `fetch_pr_context` -> `fix_agent` -> `finalize_workspace` -> `post_pr_comment`.
- F2.2 Builtin fallback in `dispatchTriggerEvent` (`dispatch-trigger.ts:104-105`): when `!enabled?.current` and `event.triggerType === "trigger_pr_review"` **and the install is pure legacy** (no enabled workflow definitions exist at all, checked via the store), proceed using the builtin trigger params and `definitionId = null`, `definitionVersion = null`, with the run input carrying `BUILTIN_FALLBACK_DEFINITION_VERSION` exactly like ticket dispatch does (`dispatch.ts:108-110`). The legacy-only guard matters: if an org runs v2 definitions but deliberately did not wire `trigger_pr_review`, we must respect that choice and keep returning `no_definition`.
- F2.3 Migration (drizzle, `apps/worker/drizzle/`): make `trigger_deliveries.definition_id` and `definition_version` nullable. The composite FK stops being enforced for NULLs (Postgres MATCH SIMPLE), existing rows are unaffected. Adjust `AcceptedTriggerDelivery` and `acceptTriggerDelivery` typing (`trigger-delivery-store.ts:38-71`).
- F2.4 Extend the sentinel branch of `loadWorkflowDefinitionFor` (`definition-step.ts:118-128`): for `BUILTIN_FALLBACK_DEFINITION_VERSION` + `trigger_pr_review`, build `defaultReviewFixDefinition()` (today the branch returns null for non-ticket triggers at `:119-122`).

**Edge cases**

- Subject serialization: the review-fix run shares the ticket's `subjectKey` (`dispatch-trigger.ts:498-521`), so it can never run concurrently with the ticket run of the same PR. Desired.
- Capacity: falls under `MAX_CONCURRENT_AGENTS` like every claim (`dispatch.ts:143-188`); at capacity the delivery stays pending and drains later. Existing behavior.
- `ENABLE_REVIEW_PHASE` only controls the `review_agent` node inside the ticket default (`definition-step.ts:110`); it does not gate this new fallback graph.
- The fallback graph must not include `update_ticket_status`, so it cannot fight the ticket-status flow.
- `commented` remains bot-login-gated even on the fallback path (`dispatch-trigger.ts:254-258`); a legacy install without a configured bot login gets `changes_requested`-only ingestion. Document this in SETUP.
- v2 remains the primary path: any enabled definition for `trigger_pr_review` takes precedence, pinned per delivery, and definition authors keep full control of the graph shape.

**Verification**

- `apps/worker/src/lib/dispatch-trigger.test.ts`: fallback dispatch happens when no definitions are enabled; `no_definition` still returned when some other definition is enabled; delivery recorded with null pin.
- `definition-step` tests: sentinel + `trigger_pr_review` loads the review-fix builtin.
- `apps/worker/src/workflow-definition/revisions-lifecycle.integration.test.ts`: extend with a legacy-fallback scenario next to the existing versioned scenarios.
- Migration applies cleanly against the test DB (`apps/worker/src/db/test-db.ts` harness).

### AC3: duplicate webhook deliveries do not create duplicate runs

**Current state (mostly solid)**

- Exact redeliveries: the PK `(provider, delivery_id)` plus `onConflictDoNothing` replay (`trigger-delivery-store.ts:45-71`, `dispatch-trigger.ts:148-152`) makes provider retries and manual redeliveries idempotent. GitHub redeliveries reuse the delivery GUID; GitLab uses idempotency headers or a content hash (`gitlab.post.ts:165-177`).
- Concurrent same-subject events: one-pending-per-subject index + coalescing + at-most-one-successor drain (section 2.1).
- Documented residual race at `dispatch-trigger.ts:319-337` (candidate vs recovery owner) resolves by re-reading the stored winner; no duplicate run results.

**Gap: semantic fan-out of one human action**

One review submission containing N inline comments emits 1 `pull_request_review` + N `pull_request_review_comment` webhooks, each with a distinct delivery id. After AC1 lands, all N+1 normalize to `trigger_pr_review` on the same subject: the first starts a run, the rest coalesce into one pending row, and after the run finishes the drain starts a second run for the same human action. Not an unbounded dupe, but a systematic double-run.

**Proposed fix**

- F3.1 Add a nullable `semantic_key` column to `trigger_deliveries` plus a partial unique index on `(provider, semantic_key) WHERE semantic_key IS NOT NULL` (migration next to F2.3). Key derivation at normalization:
  - `pull_request_review` submitted: `review:<review.id>`
  - `pull_request_review_comment`: `review:<comment.pull_request_review_id>` when present (GitHub wraps inline comments in a review container, so the N comment events and their parent review share one key), else `comment:<comment.id>`
  - `issue_comment`: `comment:<comment.id>`
  - GitLab note: `note:<object_attributes.id>`
- F3.2 `acceptTriggerDelivery` treats a semantic-key conflict exactly like a PK conflict: return the stored winner's envelope, replay its result (`trigger-delivery-store.ts:45-71`). Nothing is lost: the winning run's `fetch_pr_context` re-reads all PR comments from the provider anyway (`fetch-pr-context.ts:37-71`).

**Edge cases**

- Uncertain review-id semantics (e.g. thread replies): the `comment:<id>` fallback is always safe; the worst case is one extra coalesced pending event, never a lost comment or a duplicate exact-delivery run.
- Old rows have `semantic_key = NULL` and never collide (partial index).
- Two genuinely separate human comments have distinct semantic keys by construction; subject coalescing still merges them into at most one successor run, which is intended (new feedback = new work).

**Verification**

- `apps/worker/src/lib/trigger-delivery-store.test.ts`: semantic conflict returns the stored envelope; NULL keys never conflict.
- `apps/worker/src/lib/dispatch-pr-trigger-coalesce.test.ts`: a review + its N comment deliveries produce exactly one run and no successor; two independent comments produce one run + one coalesced successor.
- Manual reproduction step 3 (redelivery button) and step 4 (multi-comment review).

### AC4: AI Workflow's own comments cannot recursively trigger the workflow

**Current state**

Identity-only, layered: normalization drops bot-authored reviews/notes (`trigger-events.ts:122`, `:191-200`), dispatch re-checks author and producer (`dispatch-trigger.ts:214-221`), and the `commented` state is only selectable when a bot login is configured (`dispatch-trigger.ts:254-258`). Two real holes:

1. `normalizeVcsLogin` (`apps/worker/src/lib/vcs-bot-identity.ts:32-35`) only trims and lowercases. GitHub App installations comment as `<app-slug>[bot]`; with `GITHUB_BOT_LOGIN=blazebot` and actual author `blazebot[bot]`, `vcsLoginsMatch` fails and the guard silently stops working. This is the likeliest real-world loop scenario.
2. The bot's own comments carry no machine-readable marker (`post-pr-comment.ts` posts the body verbatim, `:61`, body resolution `:117-127`), so a misconfigured login has no second line of defense.

**Proposed fix**

- F4.1 Apply the same author guard to the new AC1 events at normalization (`comment.user.login` vs `botLogin`); the dispatch-layer re-check at `dispatch-trigger.ts:214-221` covers them automatically since they produce a standard `review` payload.
- F4.2 Harden `normalizeVcsLogin`: strip a trailing `[bot]` suffix before comparison. GitHub usernames cannot contain brackets, so `blazebot[bot]` == `blazebot` cannot be spoofed by a registered user. Additionally, for the new GitHub comment events, drop any comment whose `user.type === "Bot"`: other bots' comments (CI, linters) are not human review feedback and must not start fix runs either.
- F4.3 Defense-in-depth marker: append an invisible HTML comment `<!-- ai-workflow:bot -->` to every body posted by `post_pr_comment` (single place: body resolution in `apps/worker/src/workflows/blocks/post-pr-comment.ts:117-127`), and drop any incoming comment/note whose body contains the marker (new GitHub branches + GitLab note branch `trigger-events.ts:185-215`). This holds even when the bot login is unset or wrong, and it covers GitLab bot users that `user.type` cannot identify.

**Edge cases**

- A human deliberately pasting the marker disables triggering for their own comment: harmless self-inflicted opt-out.
- HTML comments do not render on GitHub or GitLab, so PR cosmetics are unchanged.
- Existing bot comments posted before the marker ships only matter for triggering via identity match, which F4.2 fixes independently: the two guards overlap on purpose.
- Explicitly not in scope for AC4: `getPRComments` (`github.ts:227-272`) re-reads the bot's own comments into planning/fix context (prompt pollution, not a trigger loop). Worth a follow-up ticket: tag or filter marker-bearing comments in `formatPRComments` (`sandbox/context.ts:293-318`).

**Verification**

- `apps/worker/src/lib/vcs-bot-identity.test.ts`: `[bot]` suffix matching cases.
- `apps/worker/src/lib/trigger-events.test.ts`: bot-authored comment dropped; `user.type === "Bot"` dropped; marker-bearing body dropped (GitHub + GitLab).
- `apps/worker/src/workflows/blocks/post-pr-comment.test.ts`: marker appended exactly once.
- Manual reproduction step 5.

### AC5: failed ingestion is visible via a safe diagnostic ID

**Root cause**

No failure path returns a referenceable identifier. Rejections return bare reason strings (`{ status: "ignored", reason }`), retryable failures return `503 trigger_<result>` (`github.post.ts:151-156`, `gitlab.post.ts:183-188`), and 401s surface the raw internal error message (`github.post.ts:29`). Logs carry the delivery id only on some branches (`dispatch-trigger.ts:154-159`). A user reporting "my comment did nothing" has nothing to quote, and the operator has nothing to grep.

**Proposed fix**

- F5.1 Mint a per-request `diagnosticId` at the top of both webhook routes: the provider delivery id when present (GitHub GUID / GitLab derived id, already unique and durable), else `crypto.randomUUID()` (covers 401 and missing-header branches).
- F5.2 Include `diagnosticId` in every non-dispatched response: `{ status: "ignored" | "error", reason, diagnosticId }` for 200-level rejects, and in the `data` of `createError` for 401/503. Keep the existing coarse reason strings (they leak nothing); keep the current 401 messages (signature-header hints are standard webhook-config feedback and contain no secrets).
- F5.3 Emit one structured log event `trigger_ingestion_rejected` with `{ diagnosticId, provider, event, reason }` on every rejected/errored branch of `github.post.ts` and `gitlab.post.ts` (info for ignores, warn for errors), complementing the existing `trigger_webhook_retryable_failure` and `trigger_delivery_dispatch_failed` logs. The GitHub/GitLab delivery UIs display the response body, so the ID becomes visible to whoever inspects the delivery, and `rg`-able in worker logs.

"Safe" holds because the ID is either the provider's own delivery GUID or a random UUID: it encodes no configuration, repo names, or internal state.

**Edge cases**

- Malformed payload / missing delivery id: random UUID still gives a quotable handle.
- Successful dispatch keeps returning `runId` (a stronger handle than any diagnostic id).
- Log volume: ignores are logged at info and are already low-frequency per repo.

**Verification**

- `github.post.test.ts` / `gitlab.post.test.ts`: every rejected branch carries `diagnosticId`; 401 includes it in error data; log spy sees `trigger_ingestion_rejected`.
- Manual reproduction step 6.

## 4. Implementation order

Each step ends green on `pnpm --filter worker test` and `pnpm --filter worker typecheck`.

1. **AC4 groundwork**: `normalizeVcsLogin` `[bot]` handling + tests (tiny, unblocks safe AC1 work).
2. **AC1**: normalization branches for the two GitHub events, route `reviewStates` seed, binding tolerance (F1.4), matching relaxation (F1.5), AC4 guards (author, `Bot` type, marker check) built in from the start; unit tests.
3. **AC4 marker emit**: `post_pr_comment` marker append + tests.
4. **AC3**: `semantic_key` migration + store conflict handling + coalesce tests.
5. **AC2**: pin-columns migration, `defaultReviewFixDefinition`, dispatch fallback with the legacy-only guard, `definition-step` sentinel branch; integration test extension.
6. **AC5**: diagnosticId plumbing in both routes + tests.
7. e2e pass (`apps/worker/e2e/tier2/us03-review-fix-cycle.test.ts`, `us13-webhook-immediate-dispatch.test.ts`) and the manual reproduction below.

Estimated blast radius: `apps/worker/src/lib/` (trigger-events, dispatch-trigger, trigger-delivery-store, trigger-current-pull-request, vcs-bot-identity), `apps/worker/src/routes/webhooks/`, `apps/worker/src/workflow-definition/default.ts`, `apps/worker/src/workflows/definition-step.ts`, `apps/worker/src/workflows/blocks/post-pr-comment.ts`, `apps/worker/src/db/` (schema + 2 migrations + queries). No dashboard changes required (the editor already renders `trigger_pr_review`, `apps/dashboard/components/cockpit/flow-editor/blocks.ts:39`).

## 5. Manual reproduction (one honest end-to-end check)

Prereqs: local worker (`pnpm --filter worker dev`) with a test DB, `GITHUB_WEBHOOK_SECRET` set, `GITHUB_BOT_LOGIN` set, a seeded `workflow_owned_branches` row for a real or fabricated PR (`ticket_key`, `repo_path`, `pr_id`, `pr_branch_name`, `pr_published_head_sha`, `pr_target_branch`).

Helper to send a signed event:

```bash
payload='{"action":"created","repository":{...},"pull_request":{...},"comment":{"id":1,"user":{"login":"human","type":"User"},"body":"please fix the null check"}}'
sig="sha256=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -s -X POST localhost:3000/webhooks/github \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request_review_comment" \
  -H "x-github-delivery: manual-test-1" \
  -H "x-hub-signature-256: $sig" \
  -d "$payload"
```

Expected sequence:

1. POST the inline-comment payload: response `{ status: "dispatched", runId }`; the run appears and executes the fix path (fallback graph on a legacy DB, the enabled definition otherwise).
2. Re-POST the identical request (same `x-github-delivery`): same stored result replayed, no second run (AC3 exact).
3. POST a sibling comment of the same review (different delivery id, same `pull_request_review_id`): rejected as semantic duplicate (AC3 semantic).
4. POST with `"user":{"login":"<bot login>[bot]","type":"Bot"}`: `ignored` (AC4 identity), and again with a human login but marker-bearing body: `ignored` (AC4 marker).
5. POST with a broken signature: 401 carrying a `diagnosticId`; `rg <diagnosticId>` over worker logs finds the `trigger_ingestion_rejected` line (AC5).
6. On a DB with an enabled v2 definition lacking `trigger_pr_review`: response `no_definition` (AC2 guard respects definition authors).

## 6. Explicitly out of scope

- Pruning `trigger_deliveries` (no TTL today, rows grow forever): known issue, separate ticket.
- Filtering the bot's own comments out of `{{pr_review_feedback}}` context (prompt pollution, not a trigger loop): follow-up ticket.
- Carrying per-comment file/line anchors inside the trigger payload: unnecessary, `fetch_pr_context` fetches anchored comments in-run.
- GitLab note sub-typing (discussion vs diff): both already map to `commented` and nothing downstream distinguishes them.
- Any dashboard/editor UI changes.

## 7. Assumptions to confirm during implementation

- GitHub manual "Redeliver" reuses the original delivery GUID (basis of exact-dedup). Confirm once against a staging webhook before relying on it in the AC3 tests' naming.
- `comment.pull_request_review_id` is present on all inline review comments, including thread replies (fallback `comment:<id>` already handles absence).
- `createRepositoryVCS` (`trigger-current-pull-request.ts:11-15`) tolerates an empty `baseBranch` for `getPRHead`; if not, thread the base ref from the post-binding value instead.
