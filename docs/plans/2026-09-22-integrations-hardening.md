Status: draft
Last-verified: 2026-09-22

# Integrations hardening: what the branch review found and what we decided

This is the record of the round between stage S14 and stage S15 of
[the integrations plan](./2026-09-18-integrations.md). It exists so that every
change made in this round can be traced from the problem to the decision, the
test that proves it and the commit that carries it, and so that nobody has to
reconstruct why the code is shaped the way it is.

## Why this round exists

Before merging `feat/integrations-contract` into `main` we reviewed the whole
branch at `b6ba4a35` area by area. Each finding was then checked by one or two
independent verifiers whose only job was to refute it. The review was stopped
early to cap its cost, so part of the findings were never verified; those are
marked UNVERIFIED below and every executor checks them before acting.

Result, after dropping what the verifiers refuted: 3 blockers, 40 majors and
about 85 minors. The weight is not in the count, it is in what kind they are:

- **Regressions against `main`**: behavior `main` had that the branch lost
  while moving provider code into packages. For these, `main` is the
  specification unless the plan or ADR-010 changed it on purpose, and each fix
  cites which.
- **Rules with two homes**: the same rule written in two or more places that
  have already started to disagree (a stored definition read raw in one place
  and upgraded in another; secrets collected from `process.env` in five
  places; a contract copied into core by hand). The fix is always one home and
  deleting the copies, never a third copy.
- **Contracts that invite the mistake**: four providers made the same error
  in their connection test, which says the contract is shaped wrong, not that
  four authors were careless.

A separate gate on stage S14 (a skeptic and a reader who had only the guide)
found gaps in the memory contract that the next stage, S15, would otherwise
have hit while writing the Mem0 integration. They are handled here too
(section "Memory contract").

## How every fix is made

These rules bind every executor in this round (full text:
`lanes/fix-groups/PREAMBLE.md` in the working area):

1. Check a finding before touching it: reproduce it with a failing test at the
   public seam, or refute it with evidence. A refuted finding is recorded as
   REFUTED with the reason, not silently dropped.
2. Fix the cause at the seam where it lives, so each rule has one home. When
   the clean fix is bigger than the group, the executor returns a design
   proposal instead of a patch.
3. Every fix has a test that names the real mistake that turns it red, and the
   executor has seen it red once.
4. A one-way door (a contract between packages, a stored shape, a migration,
   removing behavior, auth) is a question to the advisor, not a decision.

After the executors, each fix branch gets an architecture review before it is
merged: does the change leave one home for its rule, is anything left dead,
would a new reader understand the shape.

## Decisions

Each decision names the problem, what we chose, what we rejected and why.

### D1. An adapter lives as long as whoever holds it (done, `47c5cd99`)

**Problem.** Every adapter's context was built with `AbortSignal.timeout(30 s)`
created when core resolved the integration. That signal became part of every
request, so 30 seconds after an adapter was built each request failed in under
a millisecond with a `TimeoutError` that looked exactly like the provider
timing out, and a POST was never retried. `main` did not have this. Live
effects on merge: Jira attachment downloads after the first 30 s, the poll
pass reusing one tracker for a tick, the answer path after a model read. With
Mem0, almost every write after distillation.

**Decision.** Three separate things end a request, each named: the context's
*lifetime* (owned by whoever holds the adapter, and for a held adapter it never
aborts on its own), the *attempt deadline* (per request attempt, in
`fetchWithPolicy`), and the *caller's own signal* (now honored instead of
overwritten). Single-shot work with a real deadline (a webhook request, a page
read, a block, a probe) keeps that deadline as its lifetime.

**Rejected.** A longer resolution timeout (moves the cliff, does not remove it);
a signal tied to the invocation deadline (nothing carries one today, and it
would mean threading it through about 40 callers).

### D2. Memory gets a time budget, not a clock (done, `47c5cd99`)

**Problem.** With D1 alone, an engine that accepts connections and never
answers costs 30 s per call, and distillation makes up to `1 + 3N` calls:
about 570 s for six repositories, past the 300 s function ceiling.

**Decision.** The resolved memory provider owns a budget of 60 seconds of time
spent *waiting on memory* per step. Time the step spends elsewhere (the model
call between a read and a write) is not charged; parallel calls are charged
once. When the budget is spent, the call in flight and every later call in
that step answer `unavailable` at once with a sentence saying so. The built-in
store has no budget and behaves as before.

**Rejected.** Wall-clock timeouts per step (charges the model call to memory);
timers inside each step (the rule would have one home per step).

### D3. A failing memory provider is never silently replaced (done, `47c5cd99`)

**Problem.** A memory integration whose key was refused became "not usable",
and the resolver then served the built-in store. Runs wrote into the built-in
store while the operator believed the engine was serving, splitting the
deployment's memory across two stores.

**Decision.** Enabled and Failing means runs continue without memory and say
which provider failed and why. Disabled or never connected means the built-in
store serves, because that is the operator's choice.

### D4. Choosing between two memory providers is enabling one (done, `47c5cd99`)

**Decision.** Two enabled memory integrations are refused as `ambiguous` with
the instruction to disable all but one on the Integrations page. No new
setting and no new stored field. A Failing one counts toward the two, so a
refused key cannot quietly hand memory to the other engine.

### D5. Secrets leave through no error (part done, part in group B)

**Problem.** The context's own comment promised that a failed request's message
is redacted, and it was not. Node's `fetch` quotes the whole header, key
included, when a pasted key contains a line break.

**Decision.** Everything an integration produces that core records (a thrown
error, a refusal detail) is redacted at one boundary core owns. Done for
requests through `ctx.http` and for memory refusals (`47c5cd99`). In progress:
one `adapterFor()` wrapper so a tracker, VCS or messaging adapter's own thrown
errors are redacted without any caller having to remember (group B).

### D6. One rule for "refused" versus "could not answer" (group B)

**Problem.** GitHub, GitLab, Jira and Slack connection tests caught every
failure and answered `{ ok: false }`, so a provider outage during Test was
filed as a refused credential and the card went Failing, stopping runs until
someone pressed Test again. The template taught the same thing.

**Decision.** The SDK gets one home for the rule (which responses are a
verdict about the values, which are no answer at all), every provider and the
template use it, and the SDK doc on `ConnectionTestResult` states it.

### D7. One reader for a deployed graph's trigger parameters (group A)

**Problem.** Run load parses stored definitions and upgrades legacy trust
lists (`githubAppSlugs`, `gitlabPipelineSources`) to `trustedProducers`;
dispatch reads the stored JSON raw. Deployed graphs that still carry the
legacy lists stopped being trusted at dispatch.

**Decision.** One reader that parses and upgrades, used by every consumer. No
second upgrade inside dispatch.

### D8. One source of truth for the secrets this deployment knows (group C)

**Problem.** Secrets entered in the dashboard (source "stored") are decrypted
from the database and never reach `process.env`, while every redaction set
(run logs, replay, leak review, the snapshot credential scan) is still built
from `process.env`. A token pasted into the Integrations page could reach a
run log unredacted.

**Decision.** One function answers "every secret this deployment knows"
(environment plus stored connections) with one documented policy for when the
integration settings cannot be read, and every redaction set is built from it.

### D9. No tracker is a normal state, not an exception (group C)

**Problem.** The poll pass threw on its first line when no issue tracker was
usable, which also stopped claim reconciliation, manual dispatch recovery and
the pull request trigger drains. MCP tools turned "no tracker connected" into
an internal error.

**Decision.** Ticket work is separated from the rest of the pass, so an absent
tracker skips ticket work and says so. "No tracker" is a domain answer decided
once and rendered by the tools as a refusal.

### D10. Pull request meaning is defined in the SDK, not learned per provider (group A)

**Problem.** "Checks failed" was dropped whenever any other check on the head
was still running (`main` matched the failed check by id); GitLab reported the
temporary merge commit of a merged-results pipeline as the head.

**Decision.** The SDK states what "the head" and "a failed check" mean, both
providers answer that meaning, and core does not learn provider quirks.

### D11. The demo deployment is never a test target (S14 gate)

**Problem.** The guide told an integration author to test by setting variables
on the demo deployment and redeploying. The demo shares production's database,
and the worker build runs migrations.

**Decision.** The guide says so plainly: an integration is tested with its
package tests and conformance locally, and on production through the
Connection form after merge. No step anywhere suggests deploying to demo.

## Memory contract (from the S14 gate, before S15)

A reader given only the guide and the SDK tried to plan the Mem0 integration
and could not answer these. Each gets one answer, written into the SDK or the
guide, and where core owns the behavior, implemented in core:

| # | Question | Decision |
|---|---|---|
| M1 | Who removes secrets before memory text leaves the deployment? | Core, once, for every provider, using the D8 source of truth, before the text reaches any adapter; text that cannot be cleaned is refused. The built-in store's own scrubbing moves to that boundary. |
| M2 | How big may `rendering` be? | Core enforces the per-scope budget where it injects memory, with a visible truncation marker, and the SDK states the numbers. |
| M3 | Which `docPath` does the admin half receive? | Exactly the pairs the provider's own `list` returned. Core never invents a path. |
| M4 | Does core retry `observe` after `unavailable`? | No. An adapter must not repeat a write that may have landed. |
| M5 | Is memory isolated per deployment? | It follows the connection: deployments that share a connection share memory, as they share a database. The guide recommends one engine project per connection. |
| M6 | How does an operator know which account a key points at? | A passing connection test names the account or project when the provider can tell. |
| M7 | How do I prove a memory integration works? | The guide lists where a run calls memory and where each outcome is recorded. |
| M8 | Why is a block that requires memory refused on a default deployment? | A defect: the built-in store counts as a memory provider for block availability. |
| M9 | Must learned items go through the engine's own extraction? | The adapter decides and says why; core has already distilled them, so storing them verbatim is the default the guide recommends. |

## Findings ledger

Every finding the review kept, with its outcome. Updated as each group
reports. Outcome is one of OPEN, FIXED (commit), REFUTED (reason) or DEFERRED
(reason and where it went).

The table is generated from the review's own records plus each executor's
report, so an entry cannot be lost between the two.

<!-- ledger:start -->
Totals: 128 findings; FIXED 2, OPEN 126.

| Id | Severity | Review | Where | Problem | Group | Outcome |
|---|---|---|---|---|---|---|
| F11 | blocker | CONFIRMED | `apps/worker/src/engine/support/issue-tracker-runtime.ts:98` | Every JiraAdapter core builds is bound to a signal that aborts 30 s after the adapter is built, so every Jira request the adapter makes later fails with TimeoutError. | C-engine | FIXED `47c5cd99`: D1: held adapters get a lifetime that does not abort on its own |
| F19 | blocker | CONFIRMED | `apps/worker/src/engine/support/trigger-current-pull-request.ts:56` | The GitHub 'PR checks failed' trigger is dropped as ignored_stale_head whenever any other check on the head is still queued or in progress. | A-triggers | OPEN |
| F91 | blocker | UNVERIFIED | `packages/workflow-graph/graph-issues.ts:277` | Stored `trigger_pr_checks_failed` nodes that still carry `githubAppSlugs` / `gitlabPipelineSources` are no longer accepted. | A-triggers | OPEN |
| F1 | major | CONFIRMED | `integrations/slack/worker.ts:118` | The Slack connection test reports a slow or broken Slack as a rejected credential. | B-connections | OPEN |
| F2 | major | CONFIRMED | `integrations/slack/api.ts:41` | Rate-limited Slack writes are no longer retried. | B-connections | OPEN |
| F3 | major | CONFIRMED | `integrations/slack/manifest.ts:55` | `allowedUserIds` (who may use the slash command) is a non-secret connection field, so it enters the run's configuration fingerprint (resolve.ts:545-557). | B-connections | OPEN |
| F12 | major | CONFIRMED | `apps/worker/src/services/integrations/context.ts:115` | fetchWithPolicy calls `fetch(target, { ...init, signal })`, and that spread overwrites the caller's `init.signal`. | B-connections | FIXED `47c5cd99`: D1: the caller's signal joins every attempt and retry wait |
| F13 | major | CONFIRMED | `integrations/jira/issue-tracker.ts:787` | hasBalancedJqlStructure only treats double quotes as string delimiters, but JQL accepts single-quoted strings (Atlassian docs: 'enclose them in single or double quotation marks'). | E-sdk-gates | OPEN |
| F20 | major | CONFIRMED | `apps/worker/src/services/triggers/polling/poll-pass.ts:283` | runTicketPhases throws on its first line when no issue tracker is usable, and it wraps work that has nothing to do with tickets: reconcileRuns for every claim, manual-dispatch recovery, and both the released and the pend... | C-engine | OPEN |
| F21 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:475` | Dispatch reads only params.trustedProducers from the deployed graph. | A-triggers | OPEN |
| F22 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:463` | The rule that a 'commented' review may start a run only when the bot login is known was removed from selectEligibleEvent and selectedReviewStates (:507-516). | A-triggers | OPEN |
| F23 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:1106` | For workflow-owned PRs, a deliberately disconnected or disabled issue tracker is treated as a retryable lookup failure, so every such delivery answers 503. | A-triggers | OPEN |
| F32 | major | CONFIRMED | `scripts/gates/generate-integration-registry/types.ts:44` | No build runs the integration generator, so the `--check` promised in plan decision 3 never runs in a build. | E-sdk-gates | OPEN |
| F33 | major | CONFIRMED | `integrations/sdk/vcs.ts:261` | The SDK never states how core learns a VCS integration's automation account. | E-sdk-gates | OPEN |
| F34 | major | CONFIRMED | `integrations/sdk/vcs.ts:172` | Part of the core/provider VCS contract lives outside the SDK and is copied by hand three times. | E-sdk-gates | OPEN |
| F42 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:777` | Switching the source ('Use the stored values' / 'Use the environment', lines 739 and 777, handler switchSource at 505) fires immediately, with no impact preview and no confirmation. | D-dashboard | OPEN |
| F43 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:829` | The kill-switch confirmation shows only static lines (disableConsequence). | D-dashboard | OPEN |
| F44 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:269` | The screen treats `stored.latestVersion > 0` as 'values are stored', but the contract defines latestVersion as the highest version ever minted and the concurrency token. | D-dashboard | OPEN |
| F45 | major | SPLIT | `apps/dashboard/components/cockpit/agent-visibility/repositories-panel.tsx:47` | ticketSubjectKey now throws when the BUILD ships more than one issue_tracker integration, and RepositoriesPanel calls it in render (line 156) with no boundary of its own. | D-dashboard | OPEN |
| F46 | major | CONFIRMED | `apps/dashboard/components/ui.tsx:369` | GitLab merge requests lost their noun and sigil. | D-dashboard | OPEN |
| F47 | major | CONFIRMED | `apps/dashboard/lib/integrations/page-data.ts:27` | Contributed-page data is read through getJSON, which aborts at FETCH_TIMEOUT_MS = 10 s (lib/api/server.ts:8). | D-dashboard | OPEN |
| F48 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/integrations-screen.tsx:185` | The Integrations page renders only `integrations` from listIntegrations, which maps integrationManifests alone (worker services/integrations/authoring.ts:159-168). | D-dashboard | OPEN |
| F55 | major | CONFIRMED | `apps/worker/src/services/integrations/authoring.ts:285` | Every `{ok:false}` from a connection test is recorded as `credential_rejected`. | B-connections | OPEN |
| F56 | major | CONFIRMED | `integrations/slack/manifest.ts:56` | The slash-command allowlist (`SLACK_ALLOWED_USER_IDS`) is modelled as a Slack connection field. | B-connections | OPEN |
| F57 | major | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:107` | `request_accepted` is recorded before any dispatch, and the `trigger_events` branch never records a rejection. | A-triggers | OPEN |
| F58 | major | SPLIT | `integrations/gitlab/webhook.ts:50` | The GitLab legacy post-PR gate lost its project scope. | A-triggers | OPEN |
| F59 | major | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:312` | The verdict written to the provider's delivery log is wrong on the most common path. | A-triggers | OPEN |
| F60 | major | CONFIRMED | `apps/worker/src/services/integrations/resolve.ts:480` | For the stored source, `resolveVerification` answers from the active version's own verdict, and that verdict is always `passed` with `testedAt` set, because a version only activates when its test passes. | B-connections | OPEN |
| F70 | major | CONFIRMED | `integrations/gitlab/webhook.ts:238` | The Pipeline Hook now sets pr.headSha from object_attributes.sha. | A-triggers | OPEN |
| F71 | major | CONFIRMED | `integrations/gitlab/vcs.ts:687` | getManualDispatchPullRequest stamps every failed check with producer "", and core's selectManualTriggerEvent skips any check without a producer (apps/worker/src/services/manual-dispatch/resolve.ts:563). | A-triggers | OPEN |
| F72 | major | CONFIRMED | `integrations/gitlab/webhook.ts:285` | The GITLAB_PROJECT_ID (legacyProjectId) restriction on the legacy post-PR gate silently stopped. | A-triggers | OPEN |
| F73 | major | CONFIRMED | `integrations/gitlab/vcs.ts:315` | listRepositories throws a plain Error with no status and no timedOut. | A-triggers | OPEN |
| F79 | major | CONFIRMED | `integrations/github/vcs.ts:786` | getPRHead now reports checks.state "running" whenever ANY check run on the head is not completed, and core's bindCurrentPullRequest (apps/worker/src/engine/support/trigger-current-pull-request.ts:56) drops a trigger_pr_c... | A-triggers | OPEN |
| F80 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:475` | Check-trigger trust reads params.trustedProducers from the raw stored node configuration. | A-triggers | OPEN |
| F81 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:507` | selectedReviewStates no longer drops "commented" when the provider's bot login is unknown. | A-triggers | OPEN |
| F92 | major | UNVERIFIED | `scripts/gates/core-references.mjs:47` | `strippedSource` does not track string, template or regex literals. | E-sdk-gates | OPEN |
| F105 | major | UNVERIFIED | `apps/worker/src/run-observability/configured-secrets.ts:8` | A tracing secret an admin stored in the dashboard reaches the sandbox but is left out of the run-log, replay and leak-review redaction sets. | C-engine | OPEN |
| F106 | major | UNVERIFIED | `apps/worker/src/mcp/tools/run-control.ts:366` | The MCP ticket and run-control tools read deps.adapters.issueTracker, a getter that now throws when no tracker is usable (engine/support/adapters.ts:128-130). | C-engine | OPEN |
| F116 | major | UNVERIFIED | `apps/worker/src/engine/blocks/leak-review/execute.ts:399` | Core's secret sets are still built only from process.env (configuredReplaySecrets). | C-engine | OPEN |
| F117 | major | UNVERIFIED | `apps/worker/src/engine/definition/integration-availability.ts:311` | coreBlockCapabilities declares vcs only for VCS_BLOCKS. | C-engine | OPEN |
| F118 | major | UNVERIFIED | `apps/worker/src/engine/definition/block-params-schemas.ts:93` | The ADR says stored checks triggers are upgraded on read from githubAppSlugs/gitlabPipelineSources to trustedProducers. | A-triggers | OPEN |
| F119 | major | UNVERIFIED | `apps/worker/src/engine/definition/block-params-schemas.ts:133` | The resolver's refusal "GitLab review triggers must include commented" was deleted without a replacement. | A-triggers | OPEN |
| F120 | major | UNVERIFIED | `apps/worker/src/engine/steps/clarification-snapshot-steps.ts:355` | The snapshot credential scan now takes the tracing key from integrationSecretValues(), which returns [] when integration settings cannot be read (services/integrations/secret-values.ts). | C-engine | OPEN |
| F4 | minor | CONFIRMED | `integrations/slack/slash-command.ts:132` | When a run control command fails, core's raw `error.message` ([id].post.ts:369-373) is posted with `response_type: "in_channel"` and rendered verbatim (render.ts:35-39). | B-connections | OPEN |
| F5 | minor | CONFIRMED | `integrations/slack/slash-command.ts:71` | The move dropped the slash command's audit trail. | B-connections | OPEN |
| F6 | minor | CONFIRMED | `integrations/slack/messaging.ts:141` | `delivered` means two different things depending on which half of the header failed. | B-connections | OPEN |
| F7 | minor | CONFIRMED | `integrations/slack/api.ts:31` | The comment says the history reads are retried by ctx.http, but every call is sent as `method: "POST"` (line 42). | B-connections | OPEN |
| F8 | minor | CONFIRMED | `integrations/arthur/worker.ts:133` | Arthur's testConnection treats every non-5xx failure except 401/403 as a refused configuration, including 429 (rate limited) and 408 (request timeout). | B-connections | OPEN |
| F9 | minor | CONFIRMED | `integrations/arthur/worker.ts:71` | AIW_RUN_ID, AIW_NODE_ID and AIW_ATTEMPT go into hookEnvironment, but the tracer never reads them. | B-connections | OPEN |
| F10 | minor | CONFIRMED | `integrations/sdk/messaging.ts:181` | The messaging port's contract says a vanished handle is re-anchored 'without re-anchoring on an event that is not `started`'. | E-sdk-gates | OPEN |
| F14 | minor | CONFIRMED | `integrations/jira/issue-tracker.test.ts:814` | The seven buildInvestigateJql tests that guarded the tenant scope were deleted with the function (origin/main investigate.test.ts:207-250). | E-sdk-gates | OPEN |
| F15 | minor | CONFIRMED | `integrations/jira/issue-tracker.test.ts:11` | The 47 adapter tests all build JiraAdapter without `config.fetch`, so they exercise the global-fetch default that no production path uses: worker.ts:54 and webhook.ts:123 always pass ctx.http.fetch. | E-sdk-gates | OPEN |
| F16 | minor | CONFIRMED | `integrations/jira/issue-tracker.ts:104` | The `browseOrigin` getter was added in this branch ('for a link core shows next to a run'), but it is not on the port and nothing reads it. | E-sdk-gates | OPEN |
| F17 | minor | CONFIRMED | `integrations/jira/worker.ts:63` | The `api` health check reports every error as 'Jira authentication failed: the Site URL or the API token was not accepted.' (lines 63-75), and the `project` check reports every error as 'project is not accessible' (lines... | B-connections | OPEN |
| F18 | minor | CONFIRMED | `integrations/jira/webhook.ts:25` | Several comments state history that is false. | E-sdk-gates | OPEN |
| F24 | minor | CONFIRMED | `apps/worker/src/engine/support/trigger-current-pull-request.ts:58` | Pending or error-retry PR envelopes recorded before this branch carry failedChecks with checkRunId/appSlug (and pipelineId) but no handle. | A-triggers | OPEN |
| F25 | minor | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:450` | isConfiguredTriggerRepository is now `Boolean(pr.provider && pr.repoPath)`, a tautology behind a name that claims a configuration check. | A-triggers | OPEN |
| F26 | minor | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.test.ts:204` | The default dispatch test double builds the provider's 'current' pull request from the event itself: checks come from pr.failedChecks with state 'red', using the same object references. | A-triggers | OPEN |
| F27 | minor | CONFIRMED | `integrations/github/webhook.ts:44` | The rule for which check names are our own gate's now lives in three places: core isManagedGateCheckName (workflow-naming.ts:55, still used by isGateCheckName in trigger-events.ts:43), GitHub MANAGED_CHECK_PREFIXES, and ... | A-triggers | OPEN |
| F28 | minor | CONFIRMED | `apps/worker/src/services/triggers/polling/poll-pass.ts:466` | Every failure of the ticket half becomes the same warn line and ticketPhases 'skipped', whether the deployment has no tracker (expected) or has a connected tracker that is broken, for example Jira returning 401 or reconc... | C-engine | OPEN |
| F29 | minor | CONFIRMED | `apps/worker/src/services/dispatch/dispatch.ts:79` | dispatchTicket resolves the active tracker twice per ticket, via issueTrackerWiring() at :79 and ticketSubject() at :95. | A-triggers | OPEN |
| F30 | minor | CONFIRMED | `apps/worker/src/services/clarifications/answer-core.ts:333` | The backlog move target is built inline by calling issueTrackerWiring() twice, and the AI move target at :279 through aiColumnMoveTarget plus another wiring read. | C-engine | OPEN |
| F31 | minor | CONFIRMED | `apps/worker/src/services/repository-catalog/provider-validation.ts:23` | assertVcsProviderAvailable checks the build registry (integrationsProviding), not connection state. | C-engine | OPEN |
| F35 | minor | CONFIRMED | `integrations/sdk/conformance.ts:472` | Plan decision 16 requires conformance to check that 'every schema the package declares parses the same under zod 3 and under the zod4 alias'. | E-sdk-gates | OPEN |
| F36 | minor | CONFIRMED | `integrations/sdk/conformance.ts:241` | The conformance `manifestSchema` does not mention `repositories` or `ConnectionField.identity`, so `z.object` strips both before any rule runs. | E-sdk-gates | OPEN |
| F37 | minor | CONFIRMED | `integrations/sdk/conformance.ts:452` | The integration-id and block-type rules are written three times and already disagree. | E-sdk-gates | OPEN |
| F38 | minor | CONFIRMED | `integrations/registry/conformance.test.ts:102` | Nothing checks environment variables across packages. | E-sdk-gates | OPEN |
| F39 | minor | CONFIRMED | `integrations/registry/reserved-env.test.ts:39` | `PROVIDER_PREFIXES` is empty, so the second test ('no provider variable is reserved', line 66) and the third ('every provider prefix still names a variable', line 78) iterate nothing and cannot fail. | E-sdk-gates | OPEN |
| F40 | minor | CONFIRMED | `integrations/host-ui/primitives.test.ts:21` | The export guards read index.ts with a regex that only matches lines shaped ` Name,`. | E-sdk-gates | OPEN |
| F41 | minor | CONFIRMED | `scripts/gates/generate-integration-registry/read-integrations.ts:158` | Several comments and messages in this area describe a state that no longer holds. | E-sdk-gates | OPEN |
| F49 | minor | CONFIRMED | `apps/dashboard/components/cockpit/flow-editor/block-palette.ts:329` | The new `contributedGroups`/`groupLabel` path (lines 297-340) can never fire. | D-dashboard | OPEN |
| F50 | minor | CONFIRMED | `apps/dashboard/next.config.ts:28` | `{ source: "/evals", destination: "/integrations/arthur/evals", permanent: true }` names a provider in core dashboard config. | D-dashboard | OPEN |
| F51 | minor | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/[page]/error.tsx:43` | 'Try again' calls `reset()` only. Contributed pages are async Server Components (ContributedPage, and Arthur's dashboard.tsx has no 'use client'), so their errors are server render errors, and Next documents `reset()` as... | D-dashboard | OPEN |
| F52 | minor | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:113` | The credential form registers with trackUnsavedSettings (line 250) but installs no `beforeunload` listener, which the dashboard-settings rule requires of every form (settings-group-form.tsx:184, repository-entry.tsx:268 ... | D-dashboard | OPEN |
| F53 | minor | CONFIRMED | `apps/dashboard/app/memory-data.tsx:39` | The memory provider's reason is parsed out of getJSON's error message, which carries only `res.statusText`, the HTTP reason phrase. | D-dashboard | OPEN |
| F54 | minor | CONFIRMED | `apps/dashboard/components/cockpit/flow-editor/blocks/pr-trigger-fields.tsx:52` | The PR trigger 'Providers' field went from two checkboxes to a free-text list of provider ids, although the registry already lists them (PINNABLE_PROVIDERS / integrationsProviding("vcs") in repository-scope.ts, used for ... | A-triggers | OPEN |
| F61 | minor | CONFIRMED | `apps/worker/src/services/integrations/usable.ts:42` | `usableIntegrations` turns "could not read this deployment's integration settings" into an empty list. | B-connections | OPEN |
| F62 | minor | CONFIRMED | `apps/worker/src/services/integrations/vcs-bot-login.ts:17` | `getVcsBotLogin` became an async database read and maps "unreadable" to `undefined`, meaning no automation account. | B-connections | OPEN |
| F63 | minor | CONFIRMED | `apps/worker/src/services/integrations/usable.ts:93` | `resolveUsableIntegrations` reads the connections twice: `readIntegrationStates()` already runs `readConnectedIntegrationConnections()`, then line 94 runs it again. | B-connections | OPEN |
| F64 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:455` | Webhook observations are now written under the default `deployment` scope, and integration-health.ts:141-144 reads them across all scopes. | A-triggers | OPEN |
| F65 | minor | CONFIRMED | `apps/worker/src/services/integrations/resolve.ts:303` | The format check for `url` and `integer` connection values was lost in the move. | B-connections | OPEN |
| F66 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:68` | The route serves a webhook only when the whole integration is usable, so the Slack slash command now needs `CHAT_SDK_SLACK_TOKEN` and `CHAT_SDK_CHANNEL_ID`. | A-triggers | OPEN |
| F67 | minor | CONFIRMED | `apps/worker/src/services/integrations/vcs-bot-login.ts:45` | Core finds a VCS provider's automation account by the literal connection field keys `botLogin` and `legacyBotLogin` (here, engine/definition/integration-availability.ts:129, and [id].post.ts:78). | B-connections | OPEN |
| F68 | minor | CONFIRMED | `apps/worker/src/services/system/integration-probes.ts:97` | `secretsKeyMaterial` is re-implemented here although `services/integrations/index.ts` already exports the same function from authoring.ts:85-89. | C-engine | OPEN |
| F69 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:8` | The header comment says core's own routes (`/webhooks/jira`, ...) keep their own files and win over this dynamic route. | A-triggers | OPEN |
| F74 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:107` | For trigger_events (the GitLab and GitHub path) the route records webhook-delivery 'accepted' before dispatch, and records nothing when dispatch then fails: a retryable 503 at 288-296, or an uncaught throw from dispatchP... | A-triggers | OPEN |
| F75 | minor | CONFIRMED | `integrations/gitlab/normalize.test.ts:115` | Every bot-filter test passes the legacy alias `botUsername` (lines 115, 133, 171, 247, 279, 446). | Z-other | OPEN |
| F76 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:89` | The route awaits botLoginFor(id), a second full resolveUsableIntegrations read of integration settings with a 30 s timeout, before webhook.receive checks X-Gitlab-Token. | A-triggers | OPEN |
| F77 | minor | CONFIRMED | `integrations/gitlab/vcs.ts:704` | parsePullRequestUrl compares only the host and takes every path segment before '/-/merge_requests' as the project path. | A-triggers | OPEN |
| F78 | minor | CONFIRMED | `integrations/gitlab/review-markers.ts:79` | Orphans and a stale comment in the package. | Z-other | OPEN |
| F82 | minor | CONFIRMED | `integrations/github/skills.ts:78` | The skill source calls Octokit without translating its errors. | Z-other | OPEN |
| F83 | minor | CONFIRMED | `apps/worker/src/services/dispatch/trigger-events.ts:31` | 'Trusted by default' for check producers now lives in two places: the GitHub webhook sets trustedByDefault: appSlug === "github-actions" (integrations/github/webhook.ts:289), and core hardcodes "github-actions" in isLega... | A-triggers | OPEN |
| F84 | minor | CONFIRMED | `integrations/github/webhook.ts:44` | The managed gate-check prefixes are copied as literals ("AI Workflow / ", "blazebot / ") and are separate from core's GATE_CHECK_NAME_PREFIX/LEGACY_GATE_CHECK_NAME_PREFIX (apps/worker/src/engine/support/workflow-naming.t... | A-triggers | OPEN |
| F85 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:107` | For GitHub's trigger_events the route records webhook-delivery 'accepted/request_accepted' before dispatch and never records a rejection when dispatch then fails: the retryable 503 at :288-296, a bot-login read failure (... | A-triggers | OPEN |
| F86 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:306` | The legacy post-PR gate's own answer is discarded: `await dispatchPostPrGateWebhook(reception.legacyGate); gateDispatched = true;` reports {status:"dispatched", reason:"post_pr_gate"} even when the gate returned ignored ... | A-triggers | OPEN |
| F87 | minor | CONFIRMED | `integrations/github/auth.ts:66` | readPrivateKey accepts base64 only when it is padded to a multiple of 4 and uses the standard alphabet. | Z-other | OPEN |
| F88 | minor | CONFIRMED | `apps/worker/src/engine/support/trigger-current-pull-request.ts:63` | The failed-check envelope shape changed from {checkRunId, appSlug} (main packages/contracts/trigger-events.ts) to {handle}. | A-triggers | OPEN |
| F89 | minor | CONFIRMED | `integrations/github/review-markers.ts:81` | isReviewLedgerWorkItem is a private copy of the SDK's isReviewLedgerWorkItem (integrations/sdk/vcs.ts), which the SDK says it hosts so that 'both core and the provider packages ask it'. | Z-other | OPEN |
| F90 | minor | CONFIRMED | `integrations/github/worker.ts:163` | The webhook health row explains any 5xx in GitHub's delivery log as this deployment's deliberate 'busy, nothing was started' answer and tells the operator to check run capacity. | B-connections | OPEN |
| F93 | minor | UNVERIFIED | `packages/contracts/settings-registry.ts:89` | `GITLAB_BASE_BRANCH` was deleted from `RETIRED_ENVIRONMENT_VARIABLES`, and from the SETUP.md list to match, in commit a84792ca. | E-sdk-gates | OPEN |
| F94 | minor | CONFIRMED | `packages/prompts/default-prompts.ts:145` | Provider names are split into fragments so the core-reference gate cannot see them, instead of being listed on the allowlist with a reason as ADR-010 decision 16 requires. | E-sdk-gates | OPEN |
| F95 | minor | UNVERIFIED | `packages/contracts/domain.ts:63` | `pullRequestRef` now returns `#<id>` for every provider. | E-sdk-gates | OPEN |
| F96 | minor | UNVERIFIED | `packages/contracts/block-catalog.generated.ts:1015` | The default for `trigger_pr_review.on` now differs by where it is read. | E-sdk-gates | OPEN |
| F97 | minor | CONFIRMED | `scripts/gates/core-references.mjs:133` | The gate source uses literal NUL bytes as the `path`/`id` key separator: 6 of them, the first at byte 4503, inside template literals at lines 133, 170, 176, 199, 200 and 207. | E-sdk-gates | OPEN |
| F98 | minor | UNVERIFIED | `scripts/gates/tiers.json:197` | The dashboard-bundle rules only match a file named `dashboard.tsx`: the worker-import ban at :197 and the `next/`, `node:` and `server-only` specifier ban at :209, both `^integrations/.*dashboard\\.tsxStatus: draft
Last-verified: 2026-09-22

# Integrations hardening: what the branch review found and what we decided

This is the record of the round between stage S14 and stage S15 of
[the integrations plan](./2026-09-18-integrations.md). It exists so that every
change made in this round can be traced from the problem to the decision, the
test that proves it and the commit that carries it, and so that nobody has to
reconstruct why the code is shaped the way it is.

## Why this round exists

Before merging `feat/integrations-contract` into `main` we reviewed the whole
branch at `b6ba4a35` area by area. Each finding was then checked by one or two
independent verifiers whose only job was to refute it. The review was stopped
early to cap its cost, so part of the findings were never verified; those are
marked UNVERIFIED below and every executor checks them before acting.

Result, after dropping what the verifiers refuted: 3 blockers, 40 majors and
about 85 minors. The weight is not in the count, it is in what kind they are:

- **Regressions against `main`**: behavior `main` had that the branch lost
  while moving provider code into packages. For these, `main` is the
  specification unless the plan or ADR-010 changed it on purpose, and each fix
  cites which.
- **Rules with two homes**: the same rule written in two or more places that
  have already started to disagree (a stored definition read raw in one place
  and upgraded in another; secrets collected from `process.env` in five
  places; a contract copied into core by hand). The fix is always one home and
  deleting the copies, never a third copy.
- **Contracts that invite the mistake**: four providers made the same error
  in their connection test, which says the contract is shaped wrong, not that
  four authors were careless.

A separate gate on stage S14 (a skeptic and a reader who had only the guide)
found gaps in the memory contract that the next stage, S15, would otherwise
have hit while writing the Mem0 integration. They are handled here too
(section "Memory contract").

## How every fix is made

These rules bind every executor in this round (full text:
`lanes/fix-groups/PREAMBLE.md` in the working area):

1. Check a finding before touching it: reproduce it with a failing test at the
   public seam, or refute it with evidence. A refuted finding is recorded as
   REFUTED with the reason, not silently dropped.
2. Fix the cause at the seam where it lives, so each rule has one home. When
   the clean fix is bigger than the group, the executor returns a design
   proposal instead of a patch.
3. Every fix has a test that names the real mistake that turns it red, and the
   executor has seen it red once.
4. A one-way door (a contract between packages, a stored shape, a migration,
   removing behavior, auth) is a question to the advisor, not a decision.

After the executors, each fix branch gets an architecture review before it is
merged: does the change leave one home for its rule, is anything left dead,
would a new reader understand the shape.

## Decisions

Each decision names the problem, what we chose, what we rejected and why.

### D1. An adapter lives as long as whoever holds it (done, `47c5cd99`)

**Problem.** Every adapter's context was built with `AbortSignal.timeout(30 s)`
created when core resolved the integration. That signal became part of every
request, so 30 seconds after an adapter was built each request failed in under
a millisecond with a `TimeoutError` that looked exactly like the provider
timing out, and a POST was never retried. `main` did not have this. Live
effects on merge: Jira attachment downloads after the first 30 s, the poll
pass reusing one tracker for a tick, the answer path after a model read. With
Mem0, almost every write after distillation.

**Decision.** Three separate things end a request, each named: the context's
*lifetime* (owned by whoever holds the adapter, and for a held adapter it never
aborts on its own), the *attempt deadline* (per request attempt, in
`fetchWithPolicy`), and the *caller's own signal* (now honored instead of
overwritten). Single-shot work with a real deadline (a webhook request, a page
read, a block, a probe) keeps that deadline as its lifetime.

**Rejected.** A longer resolution timeout (moves the cliff, does not remove it);
a signal tied to the invocation deadline (nothing carries one today, and it
would mean threading it through about 40 callers).

### D2. Memory gets a time budget, not a clock (done, `47c5cd99`)

**Problem.** With D1 alone, an engine that accepts connections and never
answers costs 30 s per call, and distillation makes up to `1 + 3N` calls:
about 570 s for six repositories, past the 300 s function ceiling.

**Decision.** The resolved memory provider owns a budget of 60 seconds of time
spent *waiting on memory* per step. Time the step spends elsewhere (the model
call between a read and a write) is not charged; parallel calls are charged
once. When the budget is spent, the call in flight and every later call in
that step answer `unavailable` at once with a sentence saying so. The built-in
store has no budget and behaves as before.

**Rejected.** Wall-clock timeouts per step (charges the model call to memory);
timers inside each step (the rule would have one home per step).

### D3. A failing memory provider is never silently replaced (done, `47c5cd99`)

**Problem.** A memory integration whose key was refused became "not usable",
and the resolver then served the built-in store. Runs wrote into the built-in
store while the operator believed the engine was serving, splitting the
deployment's memory across two stores.

**Decision.** Enabled and Failing means runs continue without memory and say
which provider failed and why. Disabled or never connected means the built-in
store serves, because that is the operator's choice.

### D4. Choosing between two memory providers is enabling one (done, `47c5cd99`)

**Decision.** Two enabled memory integrations are refused as `ambiguous` with
the instruction to disable all but one on the Integrations page. No new
setting and no new stored field. A Failing one counts toward the two, so a
refused key cannot quietly hand memory to the other engine.

### D5. Secrets leave through no error (part done, part in group B)

**Problem.** The context's own comment promised that a failed request's message
is redacted, and it was not. Node's `fetch` quotes the whole header, key
included, when a pasted key contains a line break.

**Decision.** Everything an integration produces that core records (a thrown
error, a refusal detail) is redacted at one boundary core owns. Done for
requests through `ctx.http` and for memory refusals (`47c5cd99`). In progress:
one `adapterFor()` wrapper so a tracker, VCS or messaging adapter's own thrown
errors are redacted without any caller having to remember (group B).

### D6. One rule for "refused" versus "could not answer" (group B)

**Problem.** GitHub, GitLab, Jira and Slack connection tests caught every
failure and answered `{ ok: false }`, so a provider outage during Test was
filed as a refused credential and the card went Failing, stopping runs until
someone pressed Test again. The template taught the same thing.

**Decision.** The SDK gets one home for the rule (which responses are a
verdict about the values, which are no answer at all), every provider and the
template use it, and the SDK doc on `ConnectionTestResult` states it.

### D7. One reader for a deployed graph's trigger parameters (group A)

**Problem.** Run load parses stored definitions and upgrades legacy trust
lists (`githubAppSlugs`, `gitlabPipelineSources`) to `trustedProducers`;
dispatch reads the stored JSON raw. Deployed graphs that still carry the
legacy lists stopped being trusted at dispatch.

**Decision.** One reader that parses and upgrades, used by every consumer. No
second upgrade inside dispatch.

### D8. One source of truth for the secrets this deployment knows (group C)

**Problem.** Secrets entered in the dashboard (source "stored") are decrypted
from the database and never reach `process.env`, while every redaction set
(run logs, replay, leak review, the snapshot credential scan) is still built
from `process.env`. A token pasted into the Integrations page could reach a
run log unredacted.

**Decision.** One function answers "every secret this deployment knows"
(environment plus stored connections) with one documented policy for when the
integration settings cannot be read, and every redaction set is built from it.

### D9. No tracker is a normal state, not an exception (group C)

**Problem.** The poll pass threw on its first line when no issue tracker was
usable, which also stopped claim reconciliation, manual dispatch recovery and
the pull request trigger drains. MCP tools turned "no tracker connected" into
an internal error.

**Decision.** Ticket work is separated from the rest of the pass, so an absent
tracker skips ticket work and says so. "No tracker" is a domain answer decided
once and rendered by the tools as a refusal.

### D10. Pull request meaning is defined in the SDK, not learned per provider (group A)

**Problem.** "Checks failed" was dropped whenever any other check on the head
was still running (`main` matched the failed check by id); GitLab reported the
temporary merge commit of a merged-results pipeline as the head.

**Decision.** The SDK states what "the head" and "a failed check" mean, both
providers answer that meaning, and core does not learn provider quirks.

### D11. The demo deployment is never a test target (S14 gate)

**Problem.** The guide told an integration author to test by setting variables
on the demo deployment and redeploying. The demo shares production's database,
and the worker build runs migrations.

**Decision.** The guide says so plainly: an integration is tested with its
package tests and conformance locally, and on production through the
Connection form after merge. No step anywhere suggests deploying to demo.

## Memory contract (from the S14 gate, before S15)

A reader given only the guide and the SDK tried to plan the Mem0 integration
and could not answer these. Each gets one answer, written into the SDK or the
guide, and where core owns the behavior, implemented in core:

| # | Question | Decision |
|---|---|---|
| M1 | Who removes secrets before memory text leaves the deployment? | Core, once, for every provider, using the D8 source of truth, before the text reaches any adapter; text that cannot be cleaned is refused. The built-in store's own scrubbing moves to that boundary. |
| M2 | How big may `rendering` be? | Core enforces the per-scope budget where it injects memory, with a visible truncation marker, and the SDK states the numbers. |
| M3 | Which `docPath` does the admin half receive? | Exactly the pairs the provider's own `list` returned. Core never invents a path. |
| M4 | Does core retry `observe` after `unavailable`? | No. An adapter must not repeat a write that may have landed. |
| M5 | Is memory isolated per deployment? | It follows the connection: deployments that share a connection share memory, as they share a database. The guide recommends one engine project per connection. |
| M6 | How does an operator know which account a key points at? | A passing connection test names the account or project when the provider can tell. |
| M7 | How do I prove a memory integration works? | The guide lists where a run calls memory and where each outcome is recorded. |
| M8 | Why is a block that requires memory refused on a default deployment? | A defect: the built-in store counts as a memory provider for block availability. |
| M9 | Must learned items go through the engine's own extraction? | The adapter decides and says why; core has already distilled them, so storing them verbatim is the default the guide recommends. |

## Findings ledger

Every finding the review kept, with its outcome. Updated as each group
reports. Outcome is one of OPEN, FIXED (commit), REFUTED (reason) or DEFERRED
(reason and where it went).

The table is generated from the review's own records plus each executor's
report, so an entry cannot be lost between the two.

. | E-sdk-gates | OPEN |
| F99 | minor | UNVERIFIED | `packages/contracts/repository-catalog.ts:40` | The provider-id rule is copied inline 28 times as `[a-z][a-z0-9_-]{2,31}`. | E-sdk-gates | OPEN |
| F100 | minor | UNVERIFIED | `docs/adr/ADR-010-integrations.md:367` | The docs promise registry checks that nothing runs. | Z-other | OPEN |
| F101 | minor | UNVERIFIED | `.claude/rules/arthur-engine.md:3` | The area rules still point at where the code used to be. | Z-other | OPEN |
| F102 | minor | UNVERIFIED | `.claude/skills/init-vcs/SKILL.md:8` | Setup guidance still describes variables this branch stopped reading. | Z-other | OPEN |
| F103 | minor | UNVERIFIED | `packages/contracts/work-scope.ts:89` | One file applies two opposite policies to refusal examples. | E-sdk-gates | OPEN |
| F104 | minor | UNVERIFIED | `changelog/unreleased/github-integration.md:4` | The new changelog entries break the contract in `changelog/README.md`: "one or two Markdown bullets" per file, never the word "fix", and read forward rather than "what used to be wrong". | Z-other | OPEN |
| F107 | minor | UNVERIFIED | `apps/worker/src/db/repositories/integrations.ts:275` | An activating save keeps the previous last_test_reason and last_test_message, because the UPDATE writes the new value only when it is non-null (`activates && input.test.reason ? new : old`). | C-engine | OPEN |
| F108 | minor | UNVERIFIED | `apps/worker/src/mcp/tools/memory.ts:76` | memory.list/get/forget put the provider's raw error text into McpPublicError messages. | C-engine | OPEN |
| F109 | minor | UNVERIFIED | `apps/worker/src/adapters/vcs/types.ts:39` | The optional VCS capability contracts (ManualDispatchPullRequestSnapshot, GateStatusCapableVCS, RichGateStatusCapableVCS, PRFilesCapableVCS, PRReviewCapableVCS, PRReviewPublication, CheckRunAnnotation) stay in core, whil... | C-engine | OPEN |
| F110 | minor | UNVERIFIED | `apps/worker/src/sandbox/agents/types.ts:341` | The research output's provider field is constrained differently in its two schemas. | C-engine | OPEN |
| F111 | minor | UNVERIFIED | `apps/worker/src/mcp/execute-tool.ts:236` | prepare() now resolves integrationSecretValues() before the rate limiter, whose comment still says 'Cheapest guard first'. | C-engine | OPEN |
| F112 | minor | UNVERIFIED | `apps/worker/src/mcp/server.ts:60` | system.capabilities calls deps.loadDeploymentIntegrations twice, once for authoringAnnouncements (line 60) and once for integrations (line 67). | C-engine | OPEN |
| F113 | minor | UNVERIFIED | `apps/worker/src/sandbox/context.ts:26` | sandbox/ now imports engine/support/repository-path-example.ts. | C-engine | OPEN |
| F114 | minor | UNVERIFIED | `apps/worker/src/mcp/tools/repositories.test.ts:1469` | The 'nothing is connected that can read this repository' case no longer exercises that state. | C-engine | OPEN |
| F115 | minor | UNVERIFIED | `apps/worker/src/sandbox/agents/tracing.ts:174` | The module header (line 10) and the SDK contract (integrations/sdk/agent-tracing.ts:69-72) both promise that a tracing install or file write 'never fails the run'. | C-engine | OPEN |
| F121 | minor | UNVERIFIED | `apps/worker/src/engine/definition/block-contract-environment.ts:74` | builtinCapabilitiesOfDeployment still lists issue_tracker as core's built-in whenever coreServesIssueTracker() is true. | C-engine | OPEN |
| F122 | minor | UNVERIFIED | `apps/worker/src/engine/support/ticket-url.ts:24` | Core builds every ticket link as `${base}/browse/${KEY}` and filters keys with a Jira-shaped pattern. | C-engine | OPEN |
| F123 | minor | UNVERIFIED | `apps/worker/src/engine/definition/integration-availability.ts:384` | integrationsUsedBy passes `node.params` to coreBlockCapabilities, but every caller (definition-step.ts:172,180, services/integrations/impact.ts:55,138, manual-dispatch) passes v2 nodes, which carry `configuration`. | C-engine | OPEN |
| F124 | minor | UNVERIFIED | `apps/worker/src/engine/support/integration-tracing.ts:48` | agent_tracing providers are never pinned (integrationsUsedBy has no rule for agent nodes), and neither the run-state step (integration-run-state-step.ts:100) nor agentTracingPlans compares a pin. | C-engine | OPEN |
| F125 | minor | UNVERIFIED | `apps/worker/src/engine/steps/memory-steps.ts:291` | Secret redaction of memory text (prepareMemoryContent, fail closed) used to run in core before every store write. | C-engine | OPEN |
| F126 | minor | UNVERIFIED | `apps/worker/src/engine/steps/run-start-settings.ts:288` | readTrackerWiring swallows every failure (`.catch(() => null)`, `!resolved?.ok → undefined`) with no log. | C-engine | OPEN |
| F127 | minor | UNVERIFIED | `apps/worker/src/engine/definition/integration-availability.ts:181` | An integration block that declares requires.llm is offered without the LLM-credential gate core applies to call_llm (block-contract-resolver.ts:157). | C-engine | OPEN |
| F128 | minor | UNVERIFIED | `apps/worker/src/engine/steps/integration-block-step.ts:111` | readIntegrationStates() and readConnectedIntegrationConnections() (lines 111, 134) run outside the step's try, so a settings read failure throws out of a maxRetries=0 step. | C-engine | OPEN |
<!-- ledger:end -->
