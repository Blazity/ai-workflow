Status: draft
Last-verified: 2026-09-23

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

The attempt deadline covers reading the body (amended in the VCS
consolidation round). `fetch` settles at the headers while the deadline keeps
running, so a body still arriving when it passed failed in the caller's hands,
outside the retry loop, and Octokit reads a failed body as an empty one: a
late page of pull request files was a 200 with nothing in it. `ctx.http` now
reads the body inside the attempt and hands back a buffered Response, so a cut
body is a failed attempt (a read goes again, a write throws). Streaming is an
opt-in (`streamBody`) for a download too large to hold in memory, and that
request brings its own `timeoutMs` for the whole download.

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

### Round H1: core consolidation

Numbered H1.x rather than D12 onward, because other rounds write their
decisions into this file at the same time.

**H1.1. The tracker owns its links (F16, F122).** Core built
`<Site URL>/browse/<KEY>` from the raw connection value and filtered keys with
a Jira pattern, while Jira built its own links from the site's origin, so a
Site URL saved with a path gave every run view, message and MCP answer a link
that went nowhere. Chosen: an optional `ticketUrl(key)` on
`IssueTrackerAdapter` (pure, never throws, null for a key that is not a
ticket; additive, ADR-010 change log), and one pair of functions every core
link site calls (`engine/support/ticket-url.ts`, a leaf with no imports
because the workflow body reads it). A ticket run records the tracker's link
on its ticket snapshot and in `runs.ticket_url`. Every surface asks the
tracker in force and shows its link when it is on the same host as the
recorded one, which repairs the `<Site URL>/browse/KEY` links core recorded
from a Site URL with a path; a recorded link on another host (the tracker was
reconnected to another site, or replaced) or a tracker that gives none keeps
the recorded link. (Revised after the gate: the first version showed the
recorded link whenever there was one, which kept those broken links forever.)
`RunStartTracker.baseUrl` is
still written and no longer read, so a rollback finds it. Rejected: fixing the
path inside core (the rule stays in core and a second tracker still gets Jira
URLs); a required port member (breaks every tracker written against the
current SDK).

**H1.1a. The transition for runs resumed across the deploy.** A run that
started on a build before H1.1 and resumes on a build after it replays a
ticket snapshot recorded without a link. Declared, not hidden: such a run's
`{{ticket_url}}` is empty for the rest of it, and open_pr's body shows the key
without a link rather than `[KEY]()` (`withoutEmptyLinks`); its stored
`runs.ticket_url` is kept, because a null write no longer erases it
(`recordRunUsage`), and every view still links the ticket through the tracker
in force. Filling the link inside the run would need a new step on the
resumed path, which changes the step sequence of runs already suspended, so
it was not done.

**H1.2. Unreadable is not "none" (F61, F128, F112, second half of F124).**
`usableIntegrations` turned "the settings could not be read" into an empty
list, which every caller then read as "nothing is connected". It is deleted;
`resolveUsableIntegrations` is the one reader and answers `readable: false`
with the reason, and each caller says what that means where it is: a block
fails as an engine fault naming the unread settings (never "not connected"),
the Integrations page answers `cause: "worker"`, a sandbox is not traced and
the log says why, the VCS lookups throw `IntegrationSettingsUnreadableError`,
and manual dispatch answers 503. `system.capabilities` reads the deployment
once and hands the same read to all three fields (F112).

**H1.3. Capabilities are counted once (F121, F127).**
`builtinCapabilitiesOfDeployment` is deleted: the issue tracker, messaging and
version control are served only by integrations
(`INTEGRATION_SERVED_CAPABILITIES`), and `activeProviderOf` is the one answer
to "which provider serves this `one` capability", used by the editor, the
runtime, the capability overview and MCP. An integration block that requires
`llm` goes through the same credential gate as Call LLM, one function for
both.

**H1.4. Tracing follows its pin and never gates a run (first half of F124).**
Tracing providers were already pinned at run start and never compared. Now
the run-state step and each sandbox compare the pin; a tracer reconfigured
since the run started is not asked, and what that costs is that run's tracing
and nothing else, because a disabled tracer has always meant an untraced run
rather than a failed one. `recordedPinFor` gains the `every_provider`
selection for this. The impact preview does not count these runs as stopping.

**H1.5. The impact preview for version control says "may" and counts by
scope.** A workflow reaches a version control provider through the
repository it picks per ticket, so the pinned reach names every provider.
The preview now reads repository selection's own rule
(`pinnedScopeExcludesProvider`, replacing a copy that disagreed with it when a
scope sets both lists) to leave out workflows, and runs, whose scope rules the
provider out, and the dashboard says "Enabled workflows that may use" for a
version control provider, because an unscoped workflow's next repository is
not knowable before its ticket. Rejected: counting only runs whose selected
repository is on the provider (that fact lives in the run's repository record
and is not read here; worth doing when the record is).

**H1.6. One home for a capability's label.** `capabilityLabel` lives in the
SDK beside `INTEGRATION_CAPABILITIES`; the registry re-exports it and the
editor lowercases it into sentences.

### Round H2: hygiene

Numbered H2.x for the same reason as H1.

#### H2.1. A provider id is an integration id, on every path

**Problem.** The provider rule `[a-z][a-z0-9_-]{2,31}` was written out about
28 times (contracts, the graph schema, nine trigger manifests, the MCP catalog,
the research and discovery schemas, the pre-PR checks config, the sandbox
workspace, memory routing), and it was wider than the id an integration can
carry (`INTEGRATION_ID`, `[a-z][a-z0-9]{2,31}`). The research schema handed to
the harness said only `minLength: 1`, so the model was held to less than the
answer was validated with.

**Decision.** `INTEGRATION_ID` in `packages/contracts/integration-id.ts` is the
rule, and `repositoryCatalogProviderSchema` is its one zod form. Everything
that can import a value reads one of the two; a JSON schema handed to a model
carries `INTEGRATION_ID.source` as `pattern`; the MCP catalog rebuilds it in
its Zod 3 dialect from `INTEGRATION_ID`. The trigger manifests may import the
contracts only as types (ADR-002), so they keep a literal copy, and
`trigger-provider-rule-sync.test.ts` and `trigger-repository-policy-sync.test.ts`
hold every copy equal to the contract on values at the rule's edges.

The narrower rule applies to stored values as well as new ones, deliberately.
A rule may refuse only what never worked, and this one refuses nothing any
deployment stored: `origin/main` accepted exactly `github` and `gitlab` in every
one of these places (`z.enum` in the contracts, the graph schema, the manifests,
the MCP catalog, the pre-PR checks config, the sandbox workspace; `(github|gitlab)`
in memory routing; database checks on the catalog), both pass the narrow rule,
and the wider rule never reached a deployment because this branch was never
pushed (`git ls-remote origin` lists no integrations branch on 2026-09-23) and
demo was ruled out for it. What it refuses, an id with `-` or `_`, could never
name an integration. A separate reader rule for stored values would have been a
second rule with nothing to hold.

The probes found one reader that disagreed: the repository key accepted
`github :acme/api`, because it checked its provider half with the trimming
schema. A key is compared as the string it is, so the key rule now tests the
half with `INTEGRATION_ID` directly, as `main`'s enum did.

#### H2.2. A cancel names the claim it holds; a reconcile pass reads its tracker once

**Problem.** `cancelRunDetailed` derived the subject to cancel from the ticket
key, which resolved the issue tracker again. The reconciler and the stall
watchdog already held both the claim and the pass's one tracker resolution, so
every stalled or orphaned claim cost another connection read, and a tracker
switched mid-pass would have named a subject the claim does not hold. On a
deployment with no tracker the watchdog's own re-derivation threw, so a dead
pull request run that carried a ticket key was never settled.

**Decision.** The caller passes the subject its claim holds (`subjectKey` on
`CancelRunDetailedInput`); only `cancelRun`, which is handed a bare ticket key,
derives it. The watchdog takes the pass's tracker id and decides whether a
claim follows its ticket with `ticketSubjectKey`, never asking the deployment.

#### H2.3. Tracing never fails a run, and one function keeps that promise

**Problem.** The SDK and `tracing.ts` promise that tracing never fails a run,
but a rejected sandbox write or command escaped the install, and the hook merge
went through each harness's settings writer, which throws on a non-zero exit
because the commit guard it also writes must fail loudly.

**Decision.** `applyTracingPlans` in `sandbox/agents/tracing.ts` is what both
harnesses call. It contains every install failure (removing staged copies,
which may hold the provider's key) and catches the hook registration, leaving
the sandbox untraced with `agent_tracing_off` in the log. The harness's writer
keeps throwing for everything that is not tracing.

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
Totals: 169 findings; FIXED 164, DEFERRED 4, REFUTED 1.

| Id | Severity | Review | Where | Problem | Group | Outcome |
|---|---|---|---|---|---|---|
| F11 | blocker | CONFIRMED | `apps/worker/src/engine/support/issue-tracker-runtime.ts:98` | Every JiraAdapter core builds is bound to a signal that aborts 30 s after the adapter is built, so every Jira request the adapter makes later fails with TimeoutError. | C-engine | FIXED `47c5cd99`: D1: held adapters get a lifetime that does not abort on its own |
| F19 | blocker | CONFIRMED | `apps/worker/src/engine/support/trigger-current-pull-request.ts:56` | The GitHub 'PR checks failed' trigger is dropped as ignored_stale_head whenever any other check on the head is still queued or in progress. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F91 | blocker | UNVERIFIED | `packages/workflow-graph/graph-issues.ts:277` | Stored `trigger_pr_checks_failed` nodes that still carry `githubAppSlugs` / `gitlabPipelineSources` are no longer accepted. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| S14-9 | blocker | gate:fresh-reader | `Plan S14; docs/architecture/integrations.md:95-104 and 951-965` | The guide gives no way to prove a capability-only integration works. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-32 | blocker | gate:skeptic | `docs/architecture/integrations.md:951-965 and :470-474; contradicts docs/plans/2026-09-18-` | The S15 executor gets only the guide and the SDK (plan row S15). | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| F1 | major | CONFIRMED | `integrations/slack/worker.ts:118` | The Slack connection test reports a slow or broken Slack as a rejected credential. | B-connections | FIXED `865233f1`: D6: one verdict rule in integrations/sdk/provider-failure.ts, used by every provider and the template (merged) |
| F2 | major | CONFIRMED | `integrations/slack/api.ts:41` | Rate-limited Slack writes are no longer retried. | B-connections | FIXED `865233f1`: review round 2: a write is resent only when opted in (Slack post) after a 429 with Retry-After (merged) |
| F3 | major | CONFIRMED | `integrations/slack/manifest.ts:55` | `allowedUserIds` (who may use the slash command) is a non-secret connection field, so it enters the run's configuration fingerprint (resolve.ts:545-557). | B-connections | FIXED `356a1d72`: allowlist is an operator setting, out of the connection and the pin |
| F12 | major | CONFIRMED | `apps/worker/src/services/integrations/context.ts:115` | fetchWithPolicy calls `fetch(target, { ...init, signal })`, and that spread overwrites the caller's `init.signal`. | B-connections | FIXED `47c5cd99`: D1: the caller's signal joins every attempt and retry wait |
| F13 | major | CONFIRMED | `integrations/jira/issue-tracker.ts:787` | hasBalancedJqlStructure only treats double quotes as string delimiters, but JQL accepts single-quoted strings (Atlassian docs: 'enclose them in single or double quotation marks'). | E-sdk-gates | FIXED `a9bb49b4`: JQL rule in the Jira package; refuses only a newly written template; a refused template is reported in the run, never dropped silently |
| F20 | major | CONFIRMED | `apps/worker/src/services/triggers/polling/poll-pass.ts:283` | runTicketPhases throws on its first line when no issue tracker is usable, and it wraps work that has nothing to do with tickets: reconcileRuns for every claim, manual-dispatch recovery, and both the released and the pend... | C-engine | FIXED `ecd612a2`: D9: poll pass without a tracker skips only ticket phases and says why (merged) |
| F21 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:475` | Dispatch reads only params.trustedProducers from the deployed graph. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F22 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:463` | The rule that a 'commented' review may start a run only when the bot login is known was removed from selectEligibleEvent and selectedReviewStates (:507-516). | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F23 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:1106` | For workflow-owned PRs, a deliberately disconnected or disabled issue tracker is treated as a retryable lookup failure, so every such delivery answers 503. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F32 | major | CONFIRMED | `scripts/gates/generate-integration-registry/types.ts:44` | No build runs the integration generator, so the `--check` promised in plan decision 3 never runs in a build. | E-sdk-gates | FIXED `a9bb49b4`: every static check runs before db:migrate on the worker build; dashboard build checks too |
| F33 | major | CONFIRMED | `integrations/sdk/vcs.ts:261` | The SDK never states how core learns a VCS integration's automation account. | E-sdk-gates | FIXED `a370cb93`: bot login field constants in the SDK, conformance vcs_bot_login_missing, core reads the constants |
| F34 | major | CONFIRMED | `integrations/sdk/vcs.ts:172` | Part of the core/provider VCS contract lives outside the SDK and is copied by hand three times. | E-sdk-gates | FIXED `a370cb93`: VCS extension contract in sdk/vcs-extensions.ts, all marker families in sdk/review-markers.ts (main literals as fixtures), package copies deleted |
| F42 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:777` | Switching the source ('Use the stored values' / 'Use the environment', lines 739 and 777, handler switchSource at 505) fires immediately, with no impact preview and no confirmation. | D-dashboard | FIXED `d28e3464`: impact preview: config change counts pin-compared paths only, disable counts every run that reaches X; cancel sticks |
| F43 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:829` | The kill-switch confirmation shows only static lines (disableConsequence). | D-dashboard | FIXED `d28e3464`: Disable shows the workflows and runs it may stop, from the one engine answer |
| F44 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:269` | The screen treats `stored.latestVersion > 0` as 'values are stored', but the contract defines latestVersion as the highest version ever minted and the concurrency token. | D-dashboard | FIXED `7fe54192`: group D: presence read from field values, erased versions excluded (merged) |
| F45 | major | SPLIT | `apps/dashboard/components/cockpit/agent-visibility/repositories-panel.tsx:47` | ticketSubjectKey now throws when the BUILD ships more than one issue_tracker integration, and RepositoriesPanel calls it in render (line 156) with no boundary of its own. | D-dashboard | DEFERRED: cannot fire in any current build (one tracker); the clean fix is a tracker-qualified ticket identity, a contract change for later |
| F46 | major | CONFIRMED | `apps/dashboard/components/ui.tsx:369` | GitLab merge requests lost their noun and sigil. | D-dashboard | FIXED `d28e3464`: change request naming has one home in the registry; core stamps the reference for messaging |
| F47 | major | CONFIRMED | `apps/dashboard/lib/integrations/page-data.ts:27` | Contributed-page data is read through getJSON, which aborts at FETCH_TIMEOUT_MS = 10 s (lib/api/server.ts:8). | D-dashboard | FIXED `a7e53d63 + c558a70d`: group D: one provider wait budget in contracts, dashboard waits it plus 10 s (merged) |
| F48 | major | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/integrations-screen.tsx:185` | The Integrations page renders only `integrations` from listIntegrations, which maps integrationManifests alone (worker services/integrations/authoring.ts:159-168). | D-dashboard | FIXED `d28e3464`: capability overview carries the resolver decision; MCP system.capabilities carries it too |
| F55 | major | CONFIRMED | `apps/worker/src/services/integrations/authoring.ts:285` | Every `{ok:false}` from a connection test is recorded as `credential_rejected`. | B-connections | FIXED `865233f1`: D6: one verdict rule in integrations/sdk/provider-failure.ts, used by every provider and the template (merged) |
| F56 | major | CONFIRMED | `integrations/slack/manifest.ts:56` | The slash-command allowlist (`SLACK_ALLOWED_USER_IDS`) is modelled as a Slack connection field. | B-connections | FIXED `356a1d72`: manifest-declared operator setting, survives a source switch, env fallback as main parsed |
| F57 | major | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:107` | `request_accepted` is recorded before any dispatch, and the `trigger_events` branch never records a rejection. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F58 | major | SPLIT | `integrations/gitlab/webhook.ts:50` | The GitLab legacy post-PR gate lost its project scope. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F59 | major | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:312` | The verdict written to the provider's delivery log is wrong on the most common path. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F60 | major | CONFIRMED | `apps/worker/src/services/integrations/resolve.ts:480` | For the stored source, `resolveVerification` answers from the active version's own verdict, and that verdict is always `passed` with `testedAt` set, because a version only activates when its test passes. | B-connections | FIXED `865233f1`: newer Test verdict on the same fingerprint wins for stored values (merged) |
| F70 | major | CONFIRMED | `integrations/gitlab/webhook.ts:238` | The Pipeline Hook now sets pr.headSha from object_attributes.sha. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F71 | major | CONFIRMED | `integrations/gitlab/vcs.ts:687` | getManualDispatchPullRequest stamps every failed check with producer "", and core's selectManualTriggerEvent skips any check without a producer (apps/worker/src/services/manual-dispatch/resolve.ts:563). | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F72 | major | CONFIRMED | `integrations/gitlab/webhook.ts:285` | The GITLAB_PROJECT_ID (legacyProjectId) restriction on the legacy post-PR gate silently stopped. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F73 | major | CONFIRMED | `integrations/gitlab/vcs.ts:315` | listRepositories throws a plain Error with no status and no timedOut. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F79 | major | CONFIRMED | `integrations/github/vcs.ts:786` | getPRHead now reports checks.state "running" whenever ANY check run on the head is not completed, and core's bindCurrentPullRequest (apps/worker/src/engine/support/trigger-current-pull-request.ts:56) drops a trigger_pr_c... | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F80 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:475` | Check-trigger trust reads params.trustedProducers from the raw stored node configuration. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F81 | major | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:507` | selectedReviewStates no longer drops "commented" when the provider's bot login is unknown. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F92 | major | UNVERIFIED | `scripts/gates/core-references.mjs:47` | `strippedSource` does not track string, template or regex literals. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F105 | major | UNVERIFIED | `apps/worker/src/run-observability/configured-secrets.ts:8` | A tracing secret an admin stored in the dashboard reaches the sandbox but is left out of the run-log, replay and leak-review redaction sets. | C-engine | FIXED `ecd612a2`: D8: knownSecretValues() is the one source (env plus stored), fail closed (merged) |
| F106 | major | UNVERIFIED | `apps/worker/src/mcp/tools/run-control.ts:366` | The MCP ticket and run-control tools read deps.adapters.issueTracker, a getter that now throws when no tracker is usable (engine/support/adapters.ts:128-130). | C-engine | FIXED `ecd612a2`: the throwing tracker getter is gone; absence is in the type; dispatch, live runs, gate, approvals and run control each tested |
| F116 | major | UNVERIFIED | `apps/worker/src/engine/blocks/leak-review/execute.ts:399` | Core's secret sets are still built only from process.env (configuredReplaySecrets). | C-engine | FIXED `ecd612a2`: D8: knownSecretValues() is the one source (env plus stored), fail closed (merged) |
| F117 | major | UNVERIFIED | `apps/worker/src/engine/definition/integration-availability.ts:311` | coreBlockCapabilities declares vcs only for VCS_BLOCKS. | C-engine | FIXED `ecd612a2`: integrationsUsedBy is the one answer from workflowWorkspaceAccessOf; runs suspended before deploy keep working (missing VCS pin reads as not pinned) |
| F118 | major | UNVERIFIED | `apps/worker/src/engine/definition/block-params-schemas.ts:93` | The ADR says stored checks triggers are upgraded on read from githubAppSlugs/gitlabPipelineSources to trustedProducers. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F119 | major | UNVERIFIED | `apps/worker/src/engine/definition/block-params-schemas.ts:133` | The resolver's refusal "GitLab review triggers must include commented" was deleted without a replacement. | A-triggers | FIXED `8267544f`: one default for review states; manifests declare webhook.reviewStates; availability refuses impossible selections (merged) |
| F120 | major | UNVERIFIED | `apps/worker/src/engine/steps/clarification-snapshot-steps.ts:355` | The snapshot credential scan now takes the tracing key from integrationSecretValues(), which returns [] when integration settings cannot be read (services/integrations/secret-values.ts). | C-engine | FIXED `ecd612a2`: clarification scan fails closed with a distinct message carrying the cause |
| S14-10 | major | gate:fresh-reader | `Plan S9; guide Memory section integrations.md:192-347; SDK memory.ts:139-198; apps/worker/` | Who scrubs secrets before memory text leaves the deployment? The built-in provider scrubs this deployment's configured secrets inside the adapter and fails closed. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-11 | major | gate:fresh-reader | `Plan S9; integrations.md:206-209 and 338-347; SDK memory.ts:49-57 and 118-124` | What size may `rendering` and `entries` be? The port says scopes are 'injected into prompts under separate budgets' and core puts `rendering` 'into a prompt as is', but gives no number, and never says whether core trunca... | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-12 | major | gate:fresh-reader | `Plan S9 (refuted, merge); integrations.md:47-50, 206-209; SDK memory.ts:9-18 and 145-149` | Mem0 v3 add is ADD-only: 'no UPDATE/DELETE', 'Memories accumulate over time; nothing is overwritten'. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-13 | major | gate:fresh-reader | `Plan S9 (learned items); SDK memory.ts:132-160` | Should the `learned` items go through Mem0's extraction or be stored verbatim? With infer=true, which is Mem0's default, Mem0 runs another LLM pass over text core already distilled. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-14 | major | gate:fresh-reader | `Plan S10; integrations.md:225-227; SDK memory.ts:278-337; adapter.ts:102-116` | The contract for the store half is undefined for a provider that is not built in. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-15 | major | gate:fresh-reader | `Plan S7/S9; SDK memory.ts:33-37` | Should memories be isolated per deployment? subject.key is 'stable across deployments of this product'. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-16 | major | gate:fresh-reader | `Plan S9 (write failures); integrations.md:210-216; SDK memory.ts:235-249; context.ts:158-1` | `unavailable` is 'worth retrying', but the guide never says whether core retries recall or observe after one. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-17 | major | gate:fresh-reader | `Plan S7/S8; integrations.md:434-439, 572-601 (memory has no pin, 587-592)` | A Mem0 API key is scoped to an org and project that Mem0 resolves server-side. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-18 | major | gate:fresh-reader | `Plan S1/S2; integrations.md:67-73, 973-974; SDK memory.ts:207; conformance.ts RESERVED_INT` | `mem0` passes the id regex and the reserved list. | S14-gate | FIXED `a9bb49b4`: group E tooling |
| S14-19 | major | gate:fresh-reader | `Plan S14; integrations.md:344-347, 470-474, 951-965` | Operator test setup. Previews and the demo read production's database, and Connection tab writes are refused there, so the environment is the only lever. The guide never says to scope the MEM0_* variables to one branch. ... | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-33 | major | gate:skeptic | `apps/worker/src/engine/support/memory-runtime.ts:128-132 with apps/worker/src/services/int` | Scenario: an admin connected Mem0 through the form. | S14-gate | FIXED `47c5cd99`: D3: a failing memory provider refuses instead of falling back |
| S14-34 | major | gate:skeptic | `docs/architecture/integrations.md:908-918 (with :805-806); scripts/ci/verify-changed.test.` | A reader copies the guide's test script, `node --import tsx --test "*.test.ts"`. | S14-gate | FIXED `a9bb49b4`: group E tooling |
| S14-35 | major | gate:skeptic | `scripts/gates/generate-integration-registry/manifest-imports.ts:45-90; docs/architecture/i` | A reader writes `default: Buffer.from("...").toString("base64")` in manifest.ts, or computes a value from `process.cwd()`. | S14-gate | FIXED `a9bb49b4`: the compiler decides which globals a manifest may use, asserted against the pinned WDK VM |
| S14-36 | major | gate:skeptic | `docs/architecture/integrations.md:176-181; integrations/sdk/capabilities.ts:100-103; integ` | S15 writes a `mem0_search` block with requires.capabilities ["memory"], trusting the guide's line that a block "may name them only to be offered or not". | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-37 | major | gate:skeptic | `scripts/gates/new-integration.ts:9-13, :118-130; docs/architecture/integrations.md:67-73, ` | Linear is the next planned integration (plan: AIW-14, "first candidate after it"). | S14-gate | FIXED `a9bb49b4`: mention rule stated once (MENTION_RULE), word-start matching for joined identifiers |
| F4 | minor | CONFIRMED | `integrations/slack/slash-command.ts:132` | When a run control command fails, core's raw `error.message` ([id].post.ts:369-373) is posted with `response_type: "in_channel"` and rendered verbatim (render.ts:35-39). | B-connections | FIXED `356a1d72`: failed command answers ephemerally with a reference; raw error only in the log |
| F5 | minor | CONFIRMED | `integrations/slack/slash-command.ts:71` | The move dropped the slash command's audit trail. | B-connections | FIXED `865233f1`: slash command decisions logged (merged) |
| F6 | minor | CONFIRMED | `integrations/slack/messaging.ts:141` | `delivered` means two different things depending on which half of the header failed. | B-connections | FIXED `865233f1`: delivered means the event message went out; status line failure logged (merged) |
| F7 | minor | CONFIRMED | `integrations/slack/api.ts:31` | The comment says the history reads are retried by ctx.http, but every call is sent as `method: "POST"` (line 42). | B-connections | FIXED `865233f1`: Slack reads go as documented GET (merged) |
| F8 | minor | CONFIRMED | `integrations/arthur/worker.ts:133` | Arthur's testConnection treats every non-5xx failure except 401/403 as a refused configuration, including 429 (rate limited) and 408 (request timeout). | B-connections | FIXED `865233f1`: D6: one verdict rule in integrations/sdk/provider-failure.ts, used by every provider and the template (merged) |
| F9 | minor | CONFIRMED | `integrations/arthur/worker.ts:71` | AIW_RUN_ID, AIW_NODE_ID and AIW_ATTEMPT go into hookEnvironment, but the tracer never reads them. | B-connections | FIXED `865233f1`: Arthur sets OTEL_RESOURCE_ATTRIBUTES; unused AIW_* removed (merged) |
| F10 | minor | CONFIRMED | `integrations/sdk/messaging.ts:181` | The messaging port's contract says a vanished handle is re-anchored 'without re-anchoring on an event that is not `started`'. | E-sdk-gates | FIXED `a9bb49b4`: contract text states what Slack does; Slack pinning test at assembly |
| F14 | minor | CONFIRMED | `integrations/jira/issue-tracker.test.ts:814` | The seven buildInvestigateJql tests that guarded the tenant scope were deleted with the function (origin/main investigate.test.ts:207-250). | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F15 | minor | CONFIRMED | `integrations/jira/issue-tracker.test.ts:11` | The 47 adapter tests all build JiraAdapter without `config.fetch`, so they exercise the global-fetch default that no production path uses: worker.ts:54 and webhook.ts:123 always pass ctx.http.fetch. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F16 | minor | CONFIRMED | `integrations/jira/issue-tracker.ts:104` | The `browseOrigin` getter was added in this branch ('for a link core shows next to a run'), but it is not on the port and nothing reads it. | E-sdk-gates | FIXED `32a212e1`: optional ticketUrl(key) on the tracker port; Jira builds every link in one method |
| F17 | minor | CONFIRMED | `integrations/jira/worker.ts:63` | The `api` health check reports every error as 'Jira authentication failed: the Site URL or the API token was not accepted.' (lines 63-75), and the `project` check reports every error as 'project is not accessible' (lines... | B-connections | FIXED `865233f1`: D6: one verdict rule in integrations/sdk/provider-failure.ts, used by every provider and the template (merged) |
| F18 | minor | CONFIRMED | `integrations/jira/webhook.ts:25` | Several comments state history that is false. | E-sdk-gates | FIXED `3fee9800`: false history comments removed |
| F24 | minor | CONFIRMED | `apps/worker/src/engine/support/trigger-current-pull-request.ts:58` | Pending or error-retry PR envelopes recorded before this branch carry failedChecks with checkRunId/appSlug (and pipelineId) but no handle. | A-triggers | FIXED `8267544f`: legacy envelopes rebuilt by the provider that wrote them (recordedCheckIdentity); live path fixed in round 3 (merged) |
| F25 | minor | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.ts:450` | isConfiguredTriggerRepository is now `Boolean(pr.provider && pr.repoPath)`, a tautology behind a name that claims a configuration check. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F26 | minor | CONFIRMED | `apps/worker/src/services/dispatch/dispatch-trigger.test.ts:204` | The default dispatch test double builds the provider's 'current' pull request from the event itself: checks come from pr.failedChecks with state 'red', using the same object references. | A-triggers | FIXED `3fee9800`: dispatch double reports declared provider state |
| F27 | minor | CONFIRMED | `integrations/github/webhook.ts:44` | The rule for which check names are our own gate's now lives in three places: core isManagedGateCheckName (workflow-naming.ts:55, still used by isGateCheckName in trigger-events.ts:43), GitHub MANAGED_CHECK_PREFIXES, and ... | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F28 | minor | CONFIRMED | `apps/worker/src/services/triggers/polling/poll-pass.ts:466` | Every failure of the ticket half becomes the same warn line and ticketPhases 'skipped', whether the deployment has no tracker (expected) or has a connected tracker that is broken, for example Jira returning 401 or reconc... | C-engine | FIXED `ecd612a2`: D9: poll pass without a tracker skips only ticket phases and says why (merged) |
| F29 | minor | CONFIRMED | `apps/worker/src/services/dispatch/dispatch.ts:79` | dispatchTicket resolves the active tracker twice per ticket, via issueTrackerWiring() at :79 and ticketSubject() at :95. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F30 | minor | CONFIRMED | `apps/worker/src/services/clarifications/answer-core.ts:333` | The backlog move target is built inline by calling issueTrackerWiring() twice, and the AI move target at :279 through aiColumnMoveTarget plus another wiring read. | C-engine | FIXED `ecd612a2`: group C (merged) |
| F31 | minor | CONFIRMED | `apps/worker/src/services/repository-catalog/provider-validation.ts:23` | assertVcsProviderAvailable checks the build registry (integrationsProviding), not connection state. | C-engine | FIXED `ecd612a2`: group C (merged) |
| F35 | minor | CONFIRMED | `integrations/sdk/conformance.ts:472` | Plan decision 16 requires conformance to check that 'every schema the package declares parses the same under zod 3 and under the zod4 alias'. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F36 | minor | CONFIRMED | `integrations/sdk/conformance.ts:241` | The conformance `manifestSchema` does not mention `repositories` or `ConnectionField.identity`, so `z.object` strips both before any rule runs. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F37 | minor | CONFIRMED | `integrations/sdk/conformance.ts:452` | The integration-id and block-type rules are written three times and already disagree. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F38 | minor | CONFIRMED | `integrations/registry/conformance.test.ts:102` | Nothing checks environment variables across packages. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F39 | minor | CONFIRMED | `integrations/registry/reserved-env.test.ts:39` | `PROVIDER_PREFIXES` is empty, so the second test ('no provider variable is reserved', line 66) and the third ('every provider prefix still names a variable', line 78) iterate nothing and cannot fail. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F40 | minor | CONFIRMED | `integrations/host-ui/primitives.test.ts:21` | The export guards read index.ts with a regex that only matches lines shaped ` Name,`. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F41 | minor | CONFIRMED | `scripts/gates/generate-integration-registry/read-integrations.ts:158` | Several comments and messages in this area describe a state that no longer holds. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F49 | minor | CONFIRMED | `apps/dashboard/components/cockpit/flow-editor/block-palette.ts:329` | The new `contributedGroups`/`groupLabel` path (lines 297-340) can never fire. | D-dashboard | DEFERRED: fallback kept on purpose for a worker one deploy ahead; comment now says why (0006161d) |
| F50 | minor | CONFIRMED | `apps/dashboard/next.config.ts:28` | `{ source: "/evals", destination: "/integrations/arthur/evals", permanent: true }` names a provider in core dashboard config. | D-dashboard | FIXED `a9bb49b4`: group E: legacyPaths in the manifest, redirects built from the registry, gate reads package-root configs |
| F51 | minor | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/[page]/error.tsx:43` | 'Try again' calls `reset()` only. Contributed pages are async Server Components (ContributedPage, and Arthur's dashboard.tsx has no 'use client'), so their errors are server render errors, and Next documents `reset()` as... | D-dashboard | FIXED `2993b742`: group D: Try again refetches the page (merged) |
| F52 | minor | CONFIRMED | `apps/dashboard/app/(cockpit)/integrations/[id]/connection/connection-screen.tsx:113` | The credential form registers with trackUnsavedSettings (line 250) but installs no `beforeunload` listener, which the dashboard-settings rule requires of every form (settings-group-form.tsx:184, repository-entry.tsx:268 ... | D-dashboard | FIXED `8b4816dd`: group D: unsaved work guard on reload and back (merged) |
| F53 | minor | CONFIRMED | `apps/dashboard/app/memory-data.tsx:39` | The memory provider's reason is parsed out of getJSON's error message, which carries only `res.statusText`, the HTTP reason phrase. | D-dashboard | FIXED `a7e53d63`: group D: refusal reason read from the body (merged) |
| F54 | minor | CONFIRMED | `apps/dashboard/components/cockpit/flow-editor/blocks/pr-trigger-fields.tsx:52` | The PR trigger 'Providers' field went from two checkboxes to a free-text list of provider ids, although the registry already lists them (PINNABLE_PROVIDERS / integrationsProviding("vcs") in repository-scope.ts, used for ... | A-triggers | FIXED `f1a8ec8f`: group D: one checkbox per VCS integration (merged) |
| F61 | minor | CONFIRMED | `apps/worker/src/services/integrations/usable.ts:42` | `usableIntegrations` turns "could not read this deployment's integration settings" into an empty list. | B-connections | FIXED `32a212e1`: usableIntegrations deleted; each caller says what unreadable settings mean |
| F62 | minor | CONFIRMED | `apps/worker/src/services/integrations/vcs-bot-login.ts:17` | `getVcsBotLogin` became an async database read and maps "unreadable" to `undefined`, meaning no automation account. | B-connections | FIXED `60fe42b4`: webhook route, dispatch and manual dispatch fail closed on an unreadable bot login (group A) |
| F63 | minor | CONFIRMED | `apps/worker/src/services/integrations/usable.ts:93` | `resolveUsableIntegrations` reads the connections twice: `readIntegrationStates()` already runs `readConnectedIntegrationConnections()`, then line 94 runs it again. | B-connections | FIXED `865233f1`: connections read once (no dedicated test) (merged) |
| F64 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:455` | Webhook observations are now written under the default `deployment` scope, and integration-health.ts:141-144 reads them across all scopes. | A-triggers | FIXED `8267544f`: observations scoped by a hash of the deployment public base URL, one write/read pair (merged) |
| F65 | minor | CONFIRMED | `apps/worker/src/services/integrations/resolve.ts:303` | The format check for `url` and `integer` connection values was lost in the move. | B-connections | FIXED `865233f1`: value_malformed: format rule in the SDK, applied to status, stored values and ctx.http; compatibility with main under review (merged) |
| F66 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:68` | The route serves a webhook only when the whole integration is usable, so the Slack slash command now needs `CHAT_SDK_SLACK_TOKEN` and `CHAT_SDK_CHANNEL_ID`. | A-triggers | FIXED `356a1d72`: webhook.requires; slash command served on the signing secret alone |
| F67 | minor | CONFIRMED | `apps/worker/src/services/integrations/vcs-bot-login.ts:45` | Core finds a VCS provider's automation account by the literal connection field keys `botLogin` and `legacyBotLogin` (here, engine/definition/integration-availability.ts:129, and [id].post.ts:78). | B-connections | FIXED `a370cb93`: same as F33: the field key is an SDK constant a vcs integration must declare |
| F68 | minor | CONFIRMED | `apps/worker/src/services/system/integration-probes.ts:97` | `secretsKeyMaterial` is re-implemented here although `services/integrations/index.ts` already exports the same function from authoring.ts:85-89. | C-engine | FIXED `ecd612a2`: group C (merged) |
| F69 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:8` | The header comment says core's own routes (`/webhooks/jira`, ...) keep their own files and win over this dynamic route. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F74 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:107` | For trigger_events (the GitLab and GitHub path) the route records webhook-delivery 'accepted' before dispatch, and records nothing when dispatch then fails: a retryable 503 at 288-296, or an uncaught throw from dispatchP... | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F75 | minor | CONFIRMED | `integrations/gitlab/normalize.test.ts:115` | Every bot-filter test passes the legacy alias `botUsername` (lines 115, 133, 171, 247, 279, 446). | Z-other | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F76 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:89` | The route awaits botLoginFor(id), a second full resolveUsableIntegrations read of integration settings with a 30 s timeout, before webhook.receive checks X-Gitlab-Token. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F77 | minor | CONFIRMED | `integrations/gitlab/vcs.ts:704` | parsePullRequestUrl compares only the host and takes every path segment before '/-/merge_requests' as the project path. | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F78 | minor | CONFIRMED | `integrations/gitlab/review-markers.ts:79` | Orphans and a stale comment in the package. | Z-other | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F82 | minor | CONFIRMED | `integrations/github/skills.ts:78` | The skill source calls Octokit without translating its errors. | Z-other | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F83 | minor | CONFIRMED | `apps/worker/src/services/dispatch/trigger-events.ts:31` | 'Trusted by default' for check producers now lives in two places: the GitHub webhook sets trustedByDefault: appSlug === "github-actions" (integrations/github/webhook.ts:289), and core hardcodes "github-actions" in isLega... | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F84 | minor | CONFIRMED | `integrations/github/webhook.ts:44` | The managed gate-check prefixes are copied as literals ("AI Workflow / ", "blazebot / ") and are separate from core's GATE_CHECK_NAME_PREFIX/LEGACY_GATE_CHECK_NAME_PREFIX (apps/worker/src/engine/support/workflow-naming.t... | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F85 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:107` | For GitHub's trigger_events the route records webhook-delivery 'accepted/request_accepted' before dispatch and never records a rejection when dispatch then fails: the retryable 503 at :288-296, a bot-login read failure (... | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F86 | minor | CONFIRMED | `apps/worker/src/routes/webhooks/[id].post.ts:306` | The legacy post-PR gate's own answer is discarded: `await dispatchPostPrGateWebhook(reception.legacyGate); gateDispatched = true;` reports {status:"dispatched", reason:"post_pr_gate"} even when the gate returned ignored ... | A-triggers | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F87 | minor | CONFIRMED | `integrations/github/auth.ts:66` | readPrivateKey accepts base64 only when it is padded to a multiple of 4 and uses the standard alphabet. | Z-other | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F88 | minor | CONFIRMED | `apps/worker/src/engine/support/trigger-current-pull-request.ts:63` | The failed-check envelope shape changed from {checkRunId, appSlug} (main packages/contracts/trigger-events.ts) to {handle}. | A-triggers | FIXED `8267544f`: same as F24; plan S11 drain note corrected (merged) |
| F89 | minor | CONFIRMED | `integrations/github/review-markers.ts:81` | isReviewLedgerWorkItem is a private copy of the SDK's isReviewLedgerWorkItem (integrations/sdk/vcs.ts), which the SDK says it hosts so that 'both core and the provider packages ask it'. | Z-other | FIXED `8267544f`: group A (four rounds, reviewed); merged (merged) |
| F90 | minor | CONFIRMED | `integrations/github/worker.ts:163` | The webhook health row explains any 5xx in GitHub's delivery log as this deployment's deliberate 'busy, nothing was started' answer and tells the operator to check run capacity. | B-connections | FIXED `865233f1`: GitHub 5xx message no longer blames run capacity (merged) |
| F93 | minor | UNVERIFIED | `packages/contracts/settings-registry.ts:89` | `GITLAB_BASE_BRANCH` was deleted from `RETIRED_ENVIRONMENT_VARIABLES`, and from the SETUP.md list to match, in commit a84792ca. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F94 | minor | CONFIRMED | `packages/prompts/default-prompts.ts:145` | Provider names are split into fragments so the core-reference gate cannot see them, instead of being listed on the allowlist with a reason as ADR-010 decision 16 requires. | E-sdk-gates | FIXED `a9bb49b4`: prompt part; githubAppSlugs wording at assembly |
| F95 | minor | UNVERIFIED | `packages/contracts/domain.ts:63` | `pullRequestRef` now returns `#<id>` for every provider. | E-sdk-gates | FIXED `d28e3464`: GitLab MR !12 in Slack through the stamped reference |
| F96 | minor | UNVERIFIED | `packages/contracts/block-catalog.generated.ts:1015` | The default for `trigger_pr_review.on` now differs by where it is read. | E-sdk-gates | FIXED `8267544f`: group A: DEFAULT_REVIEW_TRIGGER_STATES in the trigger manifest, used everywhere (merged) |
| F97 | minor | CONFIRMED | `scripts/gates/core-references.mjs:133` | The gate source uses literal NUL bytes as the `path`/`id` key separator: 6 of them, the first at byte 4503, inside template literals at lines 133, 170, 176, 199, 200 and 207. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F98 | minor | UNVERIFIED | `scripts/gates/tiers.json:197` | The dashboard-bundle rules only match a file named `dashboard.tsx`: the worker-import ban at :197 and the `next/`, `node:` and `server-only` specifier ban at :209, both `^integrations/.*dashboard\\.tsx$`. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F99 | minor | UNVERIFIED | `packages/contracts/repository-catalog.ts:40` | The provider-id rule is copied inline 28 times as `[a-z][a-z0-9_-]{2,31}`. | E-sdk-gates | FIXED `3fee9800`: INTEGRATION_ID is the one provider id rule; manifests held equal by tests |
| F100 | minor | UNVERIFIED | `docs/adr/ADR-010-integrations.md:367` | The docs promise registry checks that nothing runs. | Z-other | FIXED `a9bb49b4`: group E: docs, rules and changelog paths |
| F101 | minor | UNVERIFIED | `.claude/rules/arthur-engine.md:3` | The area rules still point at where the code used to be. | Z-other | FIXED `a9bb49b4`: group E: docs, rules and changelog paths |
| F102 | minor | UNVERIFIED | `.claude/skills/init-vcs/SKILL.md:8` | Setup guidance still describes variables this branch stopped reading. | Z-other | FIXED `a9bb49b4`: group E: docs, rules and changelog paths |
| F103 | minor | UNVERIFIED | `packages/contracts/work-scope.ts:89` | One file applies two opposite policies to refusal examples. | E-sdk-gates | FIXED `a9bb49b4`: group E, merged |
| F104 | minor | UNVERIFIED | `changelog/unreleased/github-integration.md:4` | The new changelog entries break the contract in `changelog/README.md`: "one or two Markdown bullets" per file, never the word "fix", and read forward rather than "what used to be wrong". | Z-other | FIXED `a9bb49b4`: group E: docs, rules and changelog paths |
| F107 | minor | UNVERIFIED | `apps/worker/src/db/repositories/integrations.ts:275` | An activating save keeps the previous last_test_reason and last_test_message, because the UPDATE writes the new value only when it is non-null (`activates && input.test.reason ? new : old`). | C-engine | FIXED `ecd612a2`: group C (merged) |
| F108 | minor | UNVERIFIED | `apps/worker/src/mcp/tools/memory.ts:76` | memory.list/get/forget put the provider's raw error text into McpPublicError messages. | C-engine | FIXED `ecd612a2`: group C (merged) |
| F109 | minor | UNVERIFIED | `apps/worker/src/adapters/vcs/types.ts:39` | The optional VCS capability contracts (ManualDispatchPullRequestSnapshot, GateStatusCapableVCS, RichGateStatusCapableVCS, PRFilesCapableVCS, PRReviewCapableVCS, PRReviewPublication, CheckRunAnnotation) stay in core, whil... | C-engine | FIXED `a370cb93`: extension types in the SDK and type-checked through VcsIntegrationAdapter; digest stays in core, its package copies gone |
| F110 | minor | UNVERIFIED | `apps/worker/src/sandbox/agents/types.ts:341` | The research output's provider field is constrained differently in its two schemas. | C-engine | FIXED `3fee9800`: research JSON schema carries the same pattern |
| F111 | minor | UNVERIFIED | `apps/worker/src/mcp/execute-tool.ts:236` | prepare() now resolves integrationSecretValues() before the rate limiter, whose comment still says 'Cheapest guard first'. | C-engine | FIXED `ecd612a2`: secret set read in one statement, every stored version not yet redacted |
| F112 | minor | UNVERIFIED | `apps/worker/src/mcp/server.ts:60` | system.capabilities calls deps.loadDeploymentIntegrations twice, once for authoringAnnouncements (line 60) and once for integrations (line 67). | C-engine | FIXED `32a212e1`: system.capabilities reads the deployment once |
| F113 | minor | UNVERIFIED | `apps/worker/src/sandbox/context.ts:26` | sandbox/ now imports engine/support/repository-path-example.ts. | C-engine | FIXED `3fee9800`: helpers moved to repository-map, engine/sandbox loop gone |
| F114 | minor | UNVERIFIED | `apps/worker/src/mcp/tools/repositories.test.ts:1469` | The 'nothing is connected that can read this repository' case no longer exercises that state. | C-engine | FIXED `3fee9800`: test runs the real resolver |
| F115 | minor | UNVERIFIED | `apps/worker/src/sandbox/agents/tracing.ts:174` | The module header (line 10) and the SDK contract (integrations/sdk/agent-tracing.ts:69-72) both promise that a tracing install or file write 'never fails the run'. | C-engine | FIXED `3fee9800`: applyTracingPlans: tracing never fails a run |
| F121 | minor | UNVERIFIED | `apps/worker/src/engine/definition/block-contract-environment.ts:74` | builtinCapabilitiesOfDeployment still lists issue_tracker as core's built-in whenever coreServesIssueTracker() is true. | C-engine | FIXED `32a212e1`: builtinCapabilities removed |
| F122 | minor | UNVERIFIED | `apps/worker/src/engine/support/ticket-url.ts:24` | Core builds every ticket link as `${base}/browse/${KEY}` and filters keys with a Jira-shaped pattern. | C-engine | FIXED `32a212e1`: every core link site goes through ticketLinksOf/ticketLinkFor; a ticket run records the tracker link |
| F123 | minor | UNVERIFIED | `apps/worker/src/engine/definition/integration-availability.ts:384` | integrationsUsedBy passes `node.params` to coreBlockCapabilities, but every caller (definition-step.ts:172,180, services/integrations/impact.ts:55,138, manual-dispatch) passes v2 nodes, which carry `configuration`. | C-engine | FIXED `ecd612a2`: group C (merged) |
| F124 | minor | UNVERIFIED | `apps/worker/src/engine/support/integration-tracing.ts:48` | agent_tracing providers are never pinned (integrationsUsedBy has no rule for agent nodes), and neither the run-state step (integration-run-state-step.ts:100) nor agentTracingPlans compares a pin. | C-engine | FIXED `32a212e1`: tracing and the run-state step compare their pin; unreadable is not none |
| F125 | minor | UNVERIFIED | `apps/worker/src/engine/steps/memory-steps.ts:291` | Secret redaction of memory text (prepareMemoryContent, fail closed) used to run in core before every store write. | C-engine | FIXED `c5eb72a5`: M1: core scrubs every observation and recall; built-in store keeps cleaning held items |
| F126 | minor | UNVERIFIED | `apps/worker/src/engine/steps/run-start-settings.ts:288` | readTrackerWiring swallows every failure (`.catch(() => null)`, `!resolved?.ok → undefined`) with no log. | C-engine | FIXED `ecd612a2`: group C (merged) |
| F127 | minor | UNVERIFIED | `apps/worker/src/engine/definition/integration-availability.ts:181` | An integration block that declares requires.llm is offered without the LLM-credential gate core applies to call_llm (block-contract-resolver.ts:157). | C-engine | FIXED `32a212e1`: an integration block requiring llm passes the Call LLM credential gate |
| F128 | minor | UNVERIFIED | `apps/worker/src/engine/steps/integration-block-step.ts:111` | readIntegrationStates() and readConnectedIntegrationConnections() (lines 111, 134) run outside the step's try, so a settings read failure throws out of a maxRetries=0 step. | C-engine | FIXED `32a212e1`: integration block step returns unreadable, an engine failure |
| S14-6 | minor | gate:reviewer | `scripts/ci/integration-guide-samples.test.ts:97-105 (self-check item 1 in the report)` | CI compiles the guide's webhook.test.ts sample with tsc but never executes it, so a sample that typechecks but is behaviorally wrong would pass CI silently. | S14-gate | FIXED `a9bb49b4`: group E tooling |
| S14-7 | minor | gate:reviewer | `engine/support/issue-tracker-runtime.ts and memory-runtime.ts, cited in ADR-010's new 'Lef` | The connection/run pin comparison exists in code but nothing calls it with real pins yet, so the documented protection against a mid-run provider swap does nothing today for issue_tracker and memory. | S14-gate | DEFERRED: wiring pins changes use step inputs; needs its own drain |
| S14-20 | minor | gate:fresh-reader | `Plan S9; integrations.md:229-332 (Hippo treats all scopes alike); SDK memory.ts:139-184; a` | The guide never says which observation kinds core sends for which scope. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-21 | minor | gate:fresh-reader | `Plan S6; integrations.md:88-90; _template/package.json:22-38; _template/dashboard.tsx:14-1` | 'Delete what you do not need' does not cover the package metadata. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-22 | minor | gate:fresh-reader | `Plan S9; integrations.md:547-554; context.ts:146-176` | Mem0's list and search are reads sent as POST. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-23 | minor | gate:fresh-reader | `Plan S9; integrations.md:338-347, 558-563` | Every memory call in a step shares one 30 second window, yet each ctx.http attempt defaults to 30 seconds, so a single slow list page can use up the whole window. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-24 | minor | gate:fresh-reader | `Plan S11; integrations.md:832-918` | The only test example is for a webhook. The guide has no example of a memory adapter test with a fake ctx.http and a recorded provider body, and no shared behavioural suite for the port's rules (never throws, onlyIfEmpty... | S14-gate | FIXED `c5eb72a5`: guide memory test sample runs in CI; SDK port-contract helper deferred |
| S14-25 | minor | gate:fresh-reader | `Plan S0/S11; integrations.md:38-43, 920-926; _template/README.md:38-44` | Provenance asks for a 'pinned revision', but ctx7 answers cite files on mem0ai/mem0 `main` with no commit. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-26 | minor | gate:fresh-reader | `Plan S6/S9; integrations.md:307-316 and 387-394, 725-772` | The Hippo example posts `run: request.runId` and ships a webhook with a webhookSecret field. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-27 | minor | gate:fresh-reader | `Plan S4; integrations.md:78-83 and 953-957` | Step 4 runs vitest inside apps/worker. The guide also warns that DATABASE_URL on our machines points at production, but never says whether this test is database-free and safe to run locally. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-28 | minor | gate:fresh-reader | `Plan S12/S14; integrations.md:196-200` | Connecting Mem0 replaces the built-in store, but existing memories are not carried over. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-29 | minor | gate:fresh-reader | `Plan S8; integrations.md:483-485` | The rule treats any 403 as a wrong credential. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-30 | minor | gate:fresh-reader | `Plan S0; integrations.md:52-54 and 939-949` | The guide says to read 'the version this repository pins' of zod, the DevKit, Next.js and the test runner, but never says where the pins live, so I could not look them up within the allowed files. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-31 | minor | gate:fresh-reader | `integrations.md:9-11 versus 166 and 1019` | The guide claims that the guide, the template and the SDK are enough on their own, yet for memory it says 'Read first: apps/worker/src/memory/builtin/adapter.ts'. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round (SDK, guide, core scrub and budget) |
| S14-38 | minor | gate:skeptic | `docs/architecture/integrations.md:140, :547, :568-570; apps/worker/src/engine/support/memo` | S15 follows Mem0's quickstart and adds `mem0ai`. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round |
| S14-39 | minor | gate:skeptic | `docs/architecture/integrations.md:149-150, :708-716` | (a) A reader building an Atlassian 3LO or Google integration stores the refresh token as a secret field and refreshes on each call. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round |
| S14-40 | minor | gate:skeptic | `AGENTS.md:57-59 (uncommitted, wt-integrations only)` | The user asked that agents always read docs with ctx7 before they start. | S14-gate | DEFERRED: ctx7 line in AGENTS.md is configuration, its own PR to main |
| S14-1 | nit | prove:samples+scaffold | `docs/architecture/integrations.md:819-820 (same sentence in integrations/host-ui/README.md` | The guide says "a component nobody declared is a compile error", but that only holds when the manifest declares at least one page. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round |
| S14-2 | nit | prove:samples+scaffold | `integrations/host-ui/README.md:13` | This tsx sample has no `file=` tag, and scripts/ci/integration-guide-samples.test.ts:27 reads only docs/architecture/integrations.md, so nothing compiles this sample. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round |
| S14-3 | nit | prove:samples+scaffold | `scripts/gates/new-integration.ts:176-177` | The id is lost when the display name is spelled the same as the id. | S14-gate | FIXED `a9bb49b4`: group E tooling |
| S14-4 | nit | prove:samples+scaffold | `scripts/gates/new-integration.ts:154-156` | A display name containing the word Example (`--name "Example Co"`) is refused with "README.md still carries a name of the template after the rename. | S14-gate | FIXED `a9bb49b4`: group E tooling |
| S14-5 | nit | prove:samples+scaffold | `integrations/_template/manifest.ts:30-32` | The rename does not touch the block's `glyph: "E"` or its template colours. | S14-gate | FIXED `c5eb72a5`: memory contract and guide round |
| S14-8 | nit | gate:fresh-reader | `PLAN (context for the gaps below, not a gap). Worktree /Users/filip/Desktop/Blazity/ai-wor` | The plan, from an empty directory to a Mem0 memory integration an operator can test. | S14-gate | REFUTED: context by its own text, not a gap |
| S14-41 | nit | gate:skeptic | `docs/architecture/integrations.md:547-563` | Scenario 22: the guide quotes 30 s, 2 retries, 240, 20, 120, 60, about 4 and 30 s without naming INTEGRATION_HTTP_DEFAULTS, INTEGRATION_BLOCK_TIMEOUT_MS, TEST_TIMEOUT_MS, PAGE_READ_TIMEOUT_MS, WEBHOOK_TIMEOUT_MS, RUN_STA... | S14-gate | FIXED `c5eb72a5`: memory contract and guide round |
<!-- ledger:end -->
