Status: current
Last-verified: 2026-09-23

# Writing an integration

This page is for someone who has never seen this repository and wants their
own service on the Integrations page and usable in a workflow. It assumes you
know your provider's API and nothing about our engine. With this page, the
template (`integrations/_template`) and the SDK (`integrations/sdk`) open, you
should not need anything else. Where you do, that is a gap in this page:
say so in your pull request.

The five integrations that ship (`integrations/arthur`, `slack`, `gitlab`,
`github`, `jira`) and the built-in memory provider
(`apps/worker/src/memory/builtin/adapter.ts`) are the worked examples. Each one
solved a different problem, and this page points at the one that solved yours.
[ADR-010](../adr/ADR-010-integrations.md) holds the reasons behind every rule
here, stage by stage.

## Before you write a line: read the current documentation

Your adapter is only as right as the page you wrote it against, and a fixture
is only as true as the page it was recorded from. Read your provider's
current API reference before you start, and again whenever you are about to
write a header name, a status code or a field you have not read today:

- how it authenticates, and what it answers to a wrong credential;
- every call you will make: its path, its parameters, and exactly what it
  returns, including whether a write is done when it answers or only
  accepted for later;
- its webhooks: which events exist, what a payload looks like, what is
  signed, how, and in which header;
- its rate limits, what it answers when you hit one, and whether it sends
  `Retry-After`;
- its error codes, and which of them mean "your credential is wrong" rather
  than "try again".

An agent does this with the `ctx7` CLI: `ctx7 library <provider> "<question>"`
finds the library id, then `ctx7 docs <id> "<question>"` answers from current
documentation, one question per concept. When `ctx7` has no entry, read the
provider's published reference directly. Either way, write down what you read
and when: the template's README has a table for it, and every recorded
payload carries its source (see "Recorded payloads").

What skipping this costs: an adapter written from memory passes every test
you wrote from the same memory, and fails its first real call. A fixture
copied from a page that changed since proves the old behaviour. Providers do
move: in September 2026 one hosted memory engine's documentation carried a
migration to a new API version whose add only appends, and answers with a
pending status and an event id to poll rather than with the stored memory.

Two things the documentation will not settle for you:

- **Which revision you read.** `ctx7` answers from current documentation and
  cites a file on the provider's default branch, with no commit. Record the
  file, its URL and the day you read it, and where the documentation lives in
  a public repository, the commit that file had that day (its history on the
  repository's host shows it). That is the pinned revision the provenance
  table and a recorded payload ask for.
- **Which of two pages is right.** Providers contradict themselves: a path with
  and without a trailing `s`, one field named two ways on two pages. Settle it
  with one live call from your own machine to the provider, with a test
  account's key, and keep the answer as a recorded payload. Ask whoever
  requested the integration for that test key; never use a production key,
  and never one of this product's deployments.

The same holds for our own stack. Before you rely on how the Workflow DevKit,
zod (both majors, see "zod 3 in tests, zod 4 in production"), Next.js or your
test runner behaves, read the version this repository pins: `zod`, `zod4`,
`typescript`, `tsx`, `vitest` and `react` in the `catalog:` of
`pnpm-workspace.yaml`, the Workflow DevKit (`workflow`) in
`apps/worker/package.json`, and Next.js in `apps/dashboard/package.json`.

## From nothing to a connected integration

The whole path, so you can see where each section below fits. Commands run
from the repository root.

1. **Pick an id.** 3 to 32 lowercase letters and digits, starting with a
   letter: `hippo`, not `Hippo`, `hippo-ai` or `hippo_ai`. It names the package
   (`@integrations/<id>`), the webhook URL (`/webhooks/<id>`), the screen
   (`/integrations/<id>`) and the prefix of every block type, and it is
   written into stored rows, so it is permanent once shipped (see "Things you
   may not do").
2. **Create the package.** `pnpm run new:integration -- <id> --name "Display Name"`
   copies `integrations/_template` to `integrations/<id>` with the template's
   names replaced, a `test` script and a first test included. It refuses,
   before writing anything, an id the SDK reserves, one an integration
   already has, and one that core source already spells where no allowlist
   row covers it, because the core-reference gate would fail your first run
   on every such file. What the gate reads as core, and what it counts as
   spelling an id, in the words it prints with every failure and the
   scaffold with every refusal:

   > Core is apps/worker, apps/dashboard, packages, as git lists them, minus
   > every path matching an `exclude` pattern in
   > scripts/gates/core-references.json.
   >
   > Core spells a provider id where one word starts with it, or where
   > consecutive words join to exactly the id, in any case, in a file's path
   > or in one identifier, string, template, regular expression or piece of
   > JSX text; words split at punctuation and at case changes, so
   > GITHUB_TOKEN, githubClient, GitHub, jira-client and mem0ai each spell
   > their id, while scriptsEntry does not spell sentry and Team settings
   > does not spell teams. Comments and the text of a className or style
   > attribute are not read.

   The refusal names the files. Where one is not about your provider (sample
   data, a URL on a host that merely starts with the word), add the id to an
   allowlist row with the reason and run the scaffold again; otherwise pick
   another id. `acme` appears in core's examples, so it is refused.
3. **Install and register it.** `pnpm install` links the new workspace package
   and adds it to the lockfile; `pnpm run gen:integrations` adds it to the
   generated registries in `integrations/registry`. From here the worker, the
   dashboard and the Workflow DevKit know it exists.
4. **Record its connection shape.**
   `pnpm --dir apps/worker exec vitest run src/services/integrations/connection-shape.test.ts -u`
   writes your fields into `connection-shape.snapshot.json`. That test fails
   whenever a shipped integration's connection fields change (see "What the
   run pin does to you"); for a new integration the change is only the
   addition. It reads the generated registry and the committed snapshot and
   nothing else: no database, no network, safe on any machine.
5. **Check it.** `pnpm --filter @integrations/<id> run typecheck` and
   `pnpm --filter @integrations/registry run test` (the conformance suite).
   Both pass before you have edited anything. From here on, run them after
   every change.
6. **Make it yours:** the manifest, then the worker, then the tests, using
   the sections below. The scaffold sets the block's `glyph` to your name's
   initial; choose its `color` and `softColor` too. Delete what you do not
   need, and what goes with it:
   - **No page:** delete `dashboard.tsx`, set `pages: []`, remove the
     `./dashboard` entry from `exports` in `package.json`, the
     `@integrations/host-ui`, `react` and `@types/react` dependencies, and the
     page's line in the README. The generator refuses a `dashboard.tsx` with
     no page declared, and a page with no `dashboard.tsx`; it does not read
     `package.json`, but the unused-code gate (`pnpm run gate:unused`) fails
     on a dependency nothing imports.
   - **No block:** `blocks: []` in the manifest and `blocks: {}` in
     `worker.ts` (the typecheck holds the two together), the block's tests and
     its line in the README.
   - **No webhook:** leave `webhook` out of `worker.ts`; the route answers
     404 for you. A memory integration normally has none.
7. **Prove it** with its own tests and conformance, locally (see "Your own
   tests"). The live proof comes after the merge, on production, by an
   operator through the Connection form ("Proving it works"): there is no
   deployment you may change before then.
8. **Open the pull request** with the checklist at the end of this page.

What a person sees once it is deployed: the Integrations page lists a card
for it, Not connected, with its description, its docs link and what it
unlocks. On a deployment whose environment sets every required variable, it
reads Connected (environment) with nothing to click. Otherwise an admin opens
the card's Connection tab (`/integrations/<id>/connection`), fills the fields
your manifest declares and saves; saving runs your connection test first and
activates the values only if it passes. Once connected and enabled, its
blocks appear in the editor's palette under its name, its pages appear in the
sidebar below the Integrations separator, its checks appear on the System
health page, and `system.capabilities` over MCP lists it with its blocks.

## What an integration is

One package under `integrations/<id>` with up to three entry points, because
three different bundles read it and each tolerates different code:

| Entry | Holds | Read by | May import |
|---|---|---|---|
| `manifest.ts` | Plain data: identity, connection fields, capabilities, blocks, pages, health checks | The dashboard in a browser, the worker, and the Workflow DevKit's flow bundle | `@integrations/sdk` and files inside the package, nothing else |
| `worker.ts` | The code: connection test, capability adapters, block executors, health probes, webhook handler, page readers | Worker steps and routes only | Anything the package declares, Node included |
| `dashboard.tsx` | One React component per page the manifest declares | The dashboard | `@integrations/host-ui` and files inside the package |

It is compiled into every build of the product. There is no runtime loading
and no install from a registry: a deployment decides only whether it is
connected and enabled. A fork adds its own integrations the same way.

The package also carries a `README.md` (the generator refuses a package
without one), a `package.json` named `@integrations/<id>` with a `typecheck`
script (without it the package silently drops out of `pnpm -r typecheck`), and
a strict `tsconfig.json`. Relative imports carry no extension (`./manifest`,
never `./manifest.js`): Nitro tolerates the second form and the dashboard's
webpack build does not.

### What it is handed, and what it can reach

Core hands your code an `IntegrationContext` (`integrations/sdk/context.ts`)
and nothing else: your resolved connection values, an HTTP client, a logger,
a deadline, and while a block runs, the run's identity, the capabilities the
block declared and a model. A dashboard page is handed `{ integrationId,
data }`. There is no session, no database handle and no client of the worker
in any of it.

That is a statement about what is **handed**, not about what is **reachable**.
Your worker code runs in the worker's process and your pages run in the
dashboard's, as Server Components. Nothing is sandboxed: global `fetch`,
`process.env` and any dependency your package declares are there without an
import from us. The registry generator refuses some of them in what you write
(Node's globals in a manifest's files, `process` in a page's, see below), but
that is a check on your source, not a sandbox. Integration code is trusted build-time code that we review
like our own, and the rules on this page exist so that it does not couple
itself to our runtime by accident, not to stop code that means harm.

So the rules are about consequences. Reading `process.env` in `worker.ts`, for
example, is not refused by any gate, and it is still wrong: the value
bypasses the connection source an admin chose, is not pinned to a run, is not
redacted from logs, and does not exist on a deployment that connected you
from the dashboard. Everything your code needs from an operator goes through
a connection field.

## Capabilities

A capability is a seam in core that an integration can fill: core does the
work (a run notification, a pull request, reading memory into a prompt) and
asks whichever integration serves the capability to talk to the provider.
Declare the ones you serve in `manifest.capabilities`, and give each an
adapter factory under `capabilities` in `worker.ts`. The factory receives your
context and returns the port's adapter.

| Capability | Port (in `integrations/sdk`) | Providers at once | Served today by | Read first |
|---|---|---|---|---|
| `issue_tracker` | `IssueTrackerAdapter` (`issue-tracker.ts`), plus `issueTrackerQueryRule` on the runtime | one | Jira | `integrations/jira`: the tracker a deployment runs its board on. The board's columns are settings of the capability, not connection fields, so the next tracker reads the same ones. `jql.ts` is its rule for a query an author typed. |
| `vcs` | `VCSAdapter` (`vcs.ts`) | many, chosen per repository | GitHub, GitLab | `integrations/gitlab`: a provider chosen per repository, self-hosted, with nested paths. `integrations/github`: a credential that is not a token (an App id, an installation id and a private key, read in `auth.ts`). A `vcs` manifest also declares `repositories` (host and whether paths nest). |
| `messaging` | `MessagingAdapter` (`messaging.ts`) | one | Slack | `integrations/slack`: one active provider, run notifications in one thread per ticket, a slash command. |
| `memory` | `MemoryAdapter` (`memory.ts`) | one | built-in, in core | "Memory" below, which states every rule an engine needs. The built-in store (`apps/worker/src/memory/builtin/adapter.ts`) is the one implementation today, for reference. |
| `agent_tracing` | `AgentTracingAdapter` (`agent-tracing.ts`) | many | Arthur | `integrations/arthur`: a description of files, packages, environment and hooks that core applies to every agent sandbox. `otelFixtureRuntime` in `integrations/sdk/fixture-runtime.ts` is a second, minimal provider. |
| `agent_tools` | reserved | many | nobody | Declaring it is a type error and a conformance failure until a later plan designs it. |

**"One" means one active provider per deployment.** When two connected,
enabled integrations serve the same `one` capability, core refuses to guess:
every use answers with a sentence naming both, and nothing is sent, read or
written through either. There is no control to choose between them yet; an
admin disables the one they do not want.

**A tracker also says how it reads a query an author typed.** The investigate
block's query template is written in the tracker's own language, so a runtime
that serves `issue_tracker` carries `issueTrackerQueryRule: { problem(query) }`
(`IssueTrackerQueryRule`), required by the type and by conformance: why the
tracker would not run the query, in a sentence for the author, or `null`.
Your adapter's `findTickets` must use a `providerQuery` exactly when this
finds no problem with it, so the two cannot disagree (Jira's `findTickets`
calls the same function). A tracker with no query language says so here
rather than accepting a query it would ignore. Core asks it without a
connection, and only while exactly one tracker is connected, in two places:

- **When a definition is saved or deployed**, it refuses a template the rule
  refuses, unless the deployed version already runs that same template. That
  one the editor shows as a notice, which never blocks Deploy, and rolling
  back, restoring or enabling a version does not ask at all: a rule newer
  than a stored template never takes away what runs today
  (`apps/worker/src/services/workflow-definitions/tracker-query-templates.ts`).
- **When the investigate block runs**, before it searches. A template the
  rule refuses is left out, the search narrows by the ticket's keywords alone
  (or does not run when there are none), and the block's theory says so in a
  sentence, with a warning in the log.

**A block uses a capability by requiring it**, not by serving it. List it in
the block's `requires.capabilities` and the editor offers the block only
while the capability is served here; the executor's `ctx.capabilities` then
has exactly those keys (`integrations/_fixtures/demo/worker.ts` requires
`messaging`). `memory` and `agent_tracing` have no key there: core applies
them around a run, so naming one only decides whether the block is offered,
by the rule a run is served by. `memory` is offered whenever runs here
remember: with no memory integration switched on (the built-in store serves)
and with one switched on and working; not while that one is Failing, and not
while two are switched on. `agent_tracing` is offered while at least one
tracing integration is usable.

**Ports speak the product's language, never a provider's.** When your port
needs a fact core does not give you, the fix is a new provider-neutral field
in the SDK, added and recorded in ADR-010's change log, not your provider's
word in a shared type. S11 is the example: core read GitLab's word for a push
(`action === "update"`), so every other provider's push went unchecked, and
the fix was a flag that states the fact (`headMoved` in
`integrations/sdk/webhook.ts`). The leftovers that still name a provider are
listed in ADR-010, "Debt the moved ports carry", with who removes each.

### Memory

Memory is the one capability core serves by itself. A deployment that
connects nothing uses the built-in store, a core module rather than a package
because it needs core's database. Everything the author of a memory engine
needs is in this section and in the port's comments
(`integrations/sdk/memory.ts`, read them whole). The built-in store
(`apps/worker/src/memory/builtin/adapter.ts`) is the one implementation today:
useful to read, not required.

**Who serves.** Connecting a memory integration **replaces** the built-in
store; disabling the integration returns the deployment to the built-in
store, which was not touched in between. Two things never fall back to the
built-in store, because either would split a deployment's memory across two
stores with nobody told: settings that cannot be read, and a memory
integration that is enabled but Failing (a refused key, say). Runs then go on
without memory and say which provider failed. Two enabled memory integrations
are refused the same way until an admin disables all but one. The editor asks
the same rule (`memoryProviderChoice` in
`apps/worker/src/engine/definition/integration-availability.ts`), so a block
that requires `memory` is offered exactly where runs remember.

**Switching is not migrating.** Nothing is copied when an admin connects an
engine: the first runs after it find nothing, the repository seed writes
again (with repository memory on, below), and the next run of a ticket in
flight starts without the notebook it had. Disconnecting
sends nothing to the engine and deletes nothing there; reconnecting the same
project brings its memory back as it was. Your README says all of this, and
your manifest's `description` says the first part in one line, because the
card shows it to the admin before they press Connect.

#### What core does for every provider

Four things are core's, done once for every provider, so your adapter does not
do them and cannot get them wrong:

- **Secrets are out of the text before you see it.** Every observation reaches
  `observe` with every secret this deployment knows taken out of `learned`,
  `refuted` and a document's `text`: the environment's, and those an admin
  stored in the dashboard, which no integration is ever handed
  (`withoutKnownSecrets` in `apps/worker/src/engine/support/memory-runtime.ts`,
  reading `knownSecretValues()`). When that set cannot be read, the write
  answers `unavailable` and nothing is sent; text the redaction cannot process
  is `rejected`. Addresses (the subject key, a notebook's name, the run id, the
  ticket key) are left as they are. A value your engine stored before it
  became a known secret stays in your engine, where core cannot reach it, and
  goes nowhere else: core takes known secrets out of everything you recall,
  the `rendering` and every entry, before it reaches a prompt, a workspace or
  the model that distils. A run that retracts such an entry therefore quotes it
  cleaned, so an engine that matches `refuted` against raw stored text misses
  it. The set is read once per step, so a secret added mid-step is taken out
  from the next step on. (The built-in store also cleans what it holds at its
  next write into a document; the rule for all of this is
  `apps/worker/src/memory/known-secrets.ts`.)
- **Size in a prompt is capped.** One agent prompt carries at most
  `MEMORY_PROMPT_BUDGET_BYTES` of renderings: 16 KiB of facts and 16 KiB of
  lessons, summed over the owner and every repository in the prompt. A
  rendering that does not fit what is left is cut and ends with a marker line
  the model reads (at the last line end that keeps at least half the room, and
  inside a line when none does); the renderings after it are left out, and
  both are logged (`repo_memory_injection_budget_exceeded`). A notebook is a
  file in the agent's workspace, not a prompt section, and is capped at
  `MEMORY_NOTEBOOK_MAX_BYTES` (256 KiB) the same way. So your rendering does not
  have to be small. It has to be ordered, because core cuts from the end: put
  first what must survive (entries that arrived `derived`, then what a recent
  run confirmed).
- **Time is budgeted per step.** Core resolves the provider once per step and
  may make many calls through it. They share `MEMORY_CALL_BUDGET_MS`, 60
  seconds of time spent waiting on your provider in that step; time the step
  spends elsewhere (a model call between a read and a write) is not charged,
  and calls made side by side are charged once. When it runs out, core aborts
  `ctx.signal`, and the call in flight and every later one in that step answer
  `unavailable` at once. Core races your call against the budget, so even an
  adapter that ignores its signal is bounded; still turn an aborted request
  into `unavailable`, never a throw.
- **Core never retries.** A `recall` or `observe` that answered, with any code,
  is not repeated: the next step or the next run asks again. So the only repeat
  a write can suffer is one your adapter makes.

#### Where a run calls memory, and where you see it

Six places. A minimal workflow reaches the first and the fourth: a ticket
trigger and one agent block that works on a repository (an implementation,
planning or review agent) prepares a workspace, which hydrates the notebook,
and tears it down, which persists it. The other three run only while the
**repository memory** setting is on (`ENABLE_REPO_MEMORY` on the Settings page,
off by default); promotion to an owner's facts also needs
`ENABLE_ORG_MEMORY_PROMOTION`. N below is the number of repositories.

| When | What it calls | Subject and scope | Logged as | Seen by a person |
|---|---|---|---|---|
| A workspace is prepared, once per run (`hydrateWorkspaceMemoryStep`, `apps/worker/src/engine/steps/memory-steps.ts`) | `recall`; an `observe` of a `document` only when nothing is held and the checkout carries an old committed notebook | `ticket:<tracker>:<KEY>` (or a pull request's key), `notebook` | `memory_document_hydrated_from_store`, `memory_document_seeded_from_repo`; `memory_provider_unavailable` and `memory_document_seed_refused`, both with `provider`, `code` and `detail`; `memory_document_hydrate_failed` | a refusal is a `memory_unavailable` observation (`where: "hydrate"`) on the block attempt: the Metadata tab of the run's trace (`/trace/<runId>`), `runs.trace` over MCP |
| Right after it, repository memory on (`seedRepoMemoryStep`, `repo-seed-steps.ts`) | per repository: `recall` of facts; an `observe` of `items` marked `derived` and `onlyIfEmpty` when nothing is held; an `observe` with only `refuted` to retract a script the repository no longer has | `repo:<provider>:<path>`, `facts` | `repo_memory_seeded`, `repo_memory_seed_refused`, `repo_memory_prune_refused`, `memory_provider_unavailable` | `memory_unavailable` (`where: "seed"`), as above |
| Every agent invocation, repository memory on (`loadRepoMemorySourcesStep`, `repo-memory-steps.ts`) | `recall` of each owner's facts, then each repository's facts and lessons: up to 1 + 2N calls | `org:<provider>:<owner>` facts; `repo:...` facts and lessons | `repo_memory_injected` (documents, bytes, dropped, truncated), `repo_memory_injection_budget_exceeded`, `memory_provider_unavailable` (`provider`, how many refused), `repo_memory_load_deadline_exceeded` | the memory sections of what the agent was sent: `runs.briefing` over MCP and the node's last briefing in the editor; a refusal as `memory_unavailable` (`where: "prompt"`) |
| Teardown, whatever the outcome, failed and cancelled runs included (`persistWorkspaceMemoryStep`) | `observe` of the agent's notebook `document` | as the first row | `memory_document_persisted`; `memory_provider_unavailable` (`provider`, `code`, `detail`); `memory_capture_unavailable` with the run id | **logs only** |
| After a run that succeeded and published, repository memory on (`distillRepoMemoryStep`) | `recall` of the notebook and of each write-scoped repository's facts and lessons; an `observe` of `items` (`learned`, `refuted`) per repository and scope; with promotion on, facts again and an `observe` on the owner: up to 1 + 3N calls | notebook, `repo:...`, `org:...` | `repo_memory_distilled` on every path, with an `outcome`; `repo_memory_write_refused`; `memory_provider_unavailable`; `memory_distill_unavailable` with the run id | **logs only** |
| The memory screen (`/memory`) and the `memory.list`, `memory.get` and `memory.forget` MCP tools | `store.list`, `store.read`, `store.forget` | the pairs your `list` returned | | the screen shows your listing and, when you cannot answer, your sentence; `complete: false` adds a notice that the list may be partial |

Which provider answered is on those log lines (`provider`) and nowhere else: no
run field records it yet, and the persist and distill outcomes reach no screen.
Read them in the worker's runtime logs by the run id.

#### The rules that bite

- **Observations in, rendering out.** Core says what a run learned about a
  subject (`observe`) and asks what is known (`recall`). Your engine decides
  what to keep, merge and forget, and renders what it knows in `rendering`.
- **`recall` and `observe` never throw.** A failure is an answer
  (`{ ok: false, code, detail }`), because memory must not be able to change a
  run's outcome. A throw is caught by core and recorded as `unavailable`, but
  that is a bug in your adapter, not a contract.
- **Each scope receives one kind of observation.** `facts` and `lessons`
  receive `items`; a `notebook` receives a `document`. Core never sends the
  other combination, and you may refuse it as `rejected`.
- **Items are already distilled: store them as written.** Core's own model
  wrote each `learned` item as one line of at most 200 characters, against what
  you already hold, and a `derived` item is what a repository's manifest says.
  One stored memory per item, verbatim, is the recommended default, and the
  only right one for `derived`. Passing items through your engine's own
  extraction model is your decision, and your README says why: it costs a
  model call per observation, may reword or drop an item (so a later `refuted`
  quoting the original no longer matches), and applies whatever instructions
  the engine project carries.
- **Forget what `refuted` names, even when your engine only adds.** Ignoring it
  leaves a fact and its refutation side by side, and the next run trusts
  whichever it reads first. Against an engine that only adds: list what the
  subject and scope hold, and delete by id each memory whose text matches a
  refuted entry, by the comparison you dedup with. Never by a similarity score
  or a search ranking, which deletes a neighbour, and never by a delete that
  takes a filter, which cannot say what it removed. `removed` counts the
  deletes the engine confirmed. Do not store a `learned` entry that restates
  one you hold.
- **A notebook is replaced, not appended.** The next recall returns exactly the
  last text stored, not joined to the one before it. Against an engine that
  only adds, that is an add of the whole text and a delete of the previous
  version. Prefer a write that is done when it answers: the same run reads the
  notebook back seconds later to distil it.
- **`stored` is acceptance, not read-after-write.** An engine that accepts a
  write and merges it later answers `stored: true`. `removed`, `dropped` and
  `remaining` are only logged, and only when one of the first two is above
  zero, so an engine that cannot know them yet answers zeros.
- **"Held nothing" is an answer; an unreadable body is not.** An HTML error
  page, an empty 200 or JSON without the field you read is `ok: false,
  unavailable`. Answering `held: false` for it makes the seed write into a store
  that is already full, and makes a run take an old committed file for the
  ticket's notebook.
- **`onlyIfEmpty` is yours to honour**: a deterministic seed may create a
  subject's memory and never edit what a run wrote. Check `held` first.
- **`subject.key` and a notebook's `name` are addresses, not text.** Store
  them and compare them exactly; never parse or rewrite them, or everything
  already stored is orphaned, and never hand one to a call that reads it as a
  pattern: a key containing `*` sent to an engine that deletes by filter
  deletes every subject.
- **`runId` is provenance, never a partition.** Keep it as metadata if at all.
  Filing memories under an engine's run or session field puts each run's
  knowledge where the next run never looks.
- **Isolation follows the connection.** Subject keys are the same on every
  deployment, so deployments whose connections point at one engine project
  share one memory per subject, as deployments that share a database share
  the built-in store. That is intended, and the recommendation is one engine
  project per connection. Sharing a project with another application is never
  intended: write a namespace of your own (the engine's application or agent
  field, or a metadata key) on every write and require it on every read, list
  and delete, so a chatbot's memories in the same project never reach a
  prompt, the memory screen or an erasure.
- **`store` is optional** and has the opposite rule: its three methods may
  throw. An engine that cannot list what it holds leaves it out, and the memory
  screen and the three MCP tools say so instead of showing an empty list; a
  person's request to see or erase what one ticket left then has to be carried
  out in the engine's own console. Your README says that.

#### Failures, timeouts and retries

- **`unavailable`** for anything that may go better later: the engine could not
  be reached, answered 408, 429 or 5xx, or did not answer in time. Say "rate
  limited" in the detail for a 429. **`rejected`** for what will fail the same
  way again: a 4xx about the request, text the engine refuses.
- **A write whose fate you cannot tell** (a timeout after the request was sent,
  a reset mid-answer) is `unavailable`. Core will not send it again; resending
  it yourself can store it twice against an engine with no idempotency key. So
  never pass `retries` on an add unless the engine documents it as idempotent.
- **A read your engine spells as a POST** (a search, a filtered listing) is
  still a read, and may pass `retries`: core sees only the method and retries
  GET, HEAD and OPTIONS by itself.
- **Bound each request below the step's budget.** An attempt defaults to 30
  seconds (`INTEGRATION_HTTP_DEFAULTS.timeoutMs`), so one slow page could spend
  half of `MEMORY_CALL_BUDGET_MS`. Pass `timeoutMs` of about 10 seconds on
  memory calls, and read only as many pages as the prompt budget can carry.
- **A provider SDK is bound by the same rules** (see "What the context gives
  you"): handed `ctx.http.fetch` and `ctx.signal`, or not used.

#### The admin half

`list`, `read` and `forget` address a document by a pair: `subjectKey` is the
key you were given, `docPath` is whatever string you chose for one document.
Core never builds a pair: `read` and `forget` receive exactly the pairs your
own `list` returned, carried by a person or an MCP client. So they arrive as
input and can be anything: match both exactly, refuse a pattern (`*`, an empty
string) instead of handing it to the engine, and answer null or false for any
pair your `list` could not have produced. `forget` answers true only once what
was stored is gone, so delete by id where the engine deletes in the background
by filter.

For an engine that stores single memories rather than documents, map one
document to each subject and scope: `docPath` is the scope's word (`facts`,
`lessons`) or `notebook/<name>`; `content` is what `recall` would render;
`bytes` its UTF-8 length; `createdAt` the oldest memory's time and `updatedAt`
the newest's; `sourceRunId` the newest memory's run id, or empty; `forget`
deletes every memory under the pair. `list({ ticketKey })` lists what
observations carrying that ticket left (store `ticketKey` where you can filter
on it); an engine that refuses a listing without an entity filter lists under
your namespace, never under a wildcard. Newest first, and `complete: false`
whenever you stopped before the end. `list({ subjectKey })` is how the
repository page (`/repositories/<id>`) and `memory.list` show one subject's
documents, whatever `docPath`s you chose, on a deployment that holds far more
than one listing: honour it in the engine's query, or page until you have
every document of that subject, because core cuts a listing that carries
another subject's document to the asked one and reports it incomplete.

This is the shape, compiled and checked with everything else on this page:

```ts file=memory.ts
import {
  z,
  type IntegrationContext,
  type MemoryAdapter,
  type MemoryFailure,
  type MemoryRecall,
  type MemoryScope,
  type MemoryWrite,
} from "@integrations/sdk";
import type { manifest } from "./manifest";

type Context = IntegrationContext<typeof manifest>;

const searchAnswer = z.object({ memories: z.array(z.object({ text: z.string() })) });

/** Core's scope, in the one string this engine files it under. Never parsed back. */
function scopeName(scope: MemoryScope): string {
  return scope.kind === "notebook" ? `notebook/${scope.name}` : scope.kind;
}

/** A status the engine answered with, as the port's word for it. */
function failureOf(status: number): MemoryFailure {
  const retryable = status === 408 || status === 429 || status >= 500;
  return retryable ? "unavailable" : "rejected";
}

function described(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hippoMemory(ctx: Context): MemoryAdapter {
  const headers = {
    authorization: `Bearer ${ctx.connection.apiKey}`,
    "content-type": "application/json",
  };

  async function recall(request: Parameters<MemoryAdapter["recall"]>[0]): Promise<MemoryRecall> {
    try {
      const url = new URL(`/v1/projects/${ctx.connection.projectId}/search`, ctx.connection.baseUrl);
      url.searchParams.set("subject", request.subject.key);
      url.searchParams.set("scope", scopeName(request.scope));
      // Well below the step's memory budget, so one slow answer cannot spend it.
      const response = await ctx.http.fetch(url, { headers, timeoutMs: 10_000 });
      if (!response.ok) {
        return { ok: false, code: failureOf(response.status), detail: `Hippo answered ${response.status}` };
      }
      const answer = searchAnswer.safeParse(await response.json().catch(() => null));
      if (!answer.success) {
        return { ok: false, code: "unavailable", detail: "Hippo answered in a shape this integration does not read" };
      }
      const excluded = new Set(request.exclude ?? []);
      const entries = answer.data.memories
        .filter((memory) => !excluded.has(memory.text))
        .map((memory) => ({ text: memory.text }));
      return {
        ok: true,
        held: answer.data.memories.length > 0,
        entries,
        rendering: entries.map((entry) => `- ${entry.text}`).join("\n"),
      };
    } catch (error) {
      return { ok: false, code: "unavailable", detail: described(error) };
    }
  }

  return {
    recall,
    async observe(request): Promise<MemoryWrite> {
      try {
        const { observation } = request;
        if (observation.kind === "items" && observation.onlyIfEmpty) {
          // A seed may create a subject's memory and never edit one a run wrote.
          const current = await recall({ subject: request.subject, scope: request.scope });
          if (!current.ok) return current;
          if (current.held) return { ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 };
        }
        // Hippo reconciles on its side (its documentation says so): it forgets
        // what `refuted` names and replaces a notebook, so the observation goes
        // as it is. An engine that only adds needs the adapter to list and
        // delete by id first ("Forget what `refuted` names", above).
        const url = new URL(`/v1/projects/${ctx.connection.projectId}/memories`, ctx.connection.baseUrl);
        const response = await ctx.http.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subject: request.subject.key,
            scope: scopeName(request.scope),
            // Provenance only: stored beside the memory, never a partition.
            metadata: { runId: request.runId, ticketKey: request.ticketKey },
            observation,
          }),
        });
        if (!response.ok) {
          return { ok: false, code: failureOf(response.status), detail: `Hippo answered ${response.status}` };
        }
        // Hippo answers 202 and merges later: `stored` means it took the
        // observation, never that the next recall returns it. The three counts
        // are what the engine knows at this moment, which for an engine that
        // merges later is nothing.
        return { ok: true, stored: true, removed: 0, dropped: 0, remaining: 0 };
      } catch (error) {
        return { ok: false, code: "unavailable", detail: described(error) };
      }
    },
  };
}
```

Hippo is invented; its paths and status codes are placeholders for the ones
your engine's documentation gives you. What is not a placeholder is the
shape: every path out of both methods is an answer. Its test is under "Your
own tests".

A run is not yet held to the memory provider it started with: the comparison
exists and no call site passes it a pin (`memory-runtime.ts`), so a run in
flight when an admin connects you may read from the built-in store and write
to you. That is why the proof below starts with a drain.

## One connection

An integration has one connection per deployment. The fields your manifest
declares are the whole of what an operator gives you:

```ts file=manifest.ts
import { defineIntegration } from "@integrations/sdk";

export const manifest = defineIntegration({
  id: "hippo",
  name: "Hippo",
  description: "Keeps what each run learned in Hippo instead of the built-in memory, which stays as it was: nothing is copied either way.",
  docsUrl: "https://hippo.example/docs",
  connection: {
    fields: [
      {
        key: "baseUrl",
        label: "API URL",
        description: "Where the Hippo API answers.",
        env: "HIPPO_BASE_URL",
        secret: false,
        format: "url",
        optional: true,
        default: "https://api.hippo.example",
      },
      {
        key: "projectId",
        label: "Project",
        description: "The Hippo project this deployment writes into. The connection test checks that the key reaches it.",
        env: "HIPPO_PROJECT_ID",
        secret: false,
      },
      {
        key: "apiKey",
        label: "API key",
        env: "HIPPO_API_KEY",
        secret: true,
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        description: "Only needed if Hippo should call back when it has processed a write.",
        env: "HIPPO_WEBHOOK_SECRET",
        secret: true,
        optional: true,
      },
    ],
  },
  capabilities: ["memory"],
  blocks: [],
  pages: [],
  health: [
    {
      id: "api",
      label: "API access",
      description: "Hippo accepts the API key for the configured project.",
      critical: true,
    },
  ],
});
```

Write the manifest inline, as above, or declare blocks with
`defineIntegrationBlock`. `defineIntegration` keeps every id, block type and
field key as a literal type, which is what types `ctx.connection` and every
executor from the manifest; TypeScript's `const` type parameters infer
literals only for values written in the call. A manifest built from a
variable annotated `: IntegrationBlockManifest`, or a field list assembled
elsewhere, would silently switch those checks off, so the SDK refuses it at
the manifest with a sentence saying what to do.

What each field property does, and what it costs to get wrong:

- **`key`** is the name in `ctx.connection`; **`env`** is the variable that
  carries the value when the environment is the source. Every field names
  one, so a deployment can be configured without touching the dashboard. Use
  `UPPER_SNAKE_CASE`, at least four characters (MCP hides every declared name
  from agents, and cannot hide a shorter one inside ordinary words), and
  never a variable core reads for itself (`RESERVED_ENVIRONMENT_VARIABLES`).
- **`secret: true`** makes a value write-only: it reaches your server code
  and nothing else, never an API response, an MCP result, the browser or a log
  line (your logger and your error messages are redacted against it).
  Conformance refuses a field whose key or variable reads like a credential
  (token, key, secret, password and the like) without it, and a secret with a
  default.
- **`identity: true`** is for a secret that also names the account, so that
  swapping it for another account's stops runs in flight instead of reading
  as a rotation. Slack's bot token is the case: nothing else says which
  workspace it is. It has a cost: rotating that secret also stops runs in
  flight. Prefer a non-secret field that names the account, as `projectId`
  does above and Jira's site URL does, and leave the token unmarked.
  Such a field means something only if the connection test checks that the
  key really reaches it (Hippo's test reads the project with the key). Where
  the provider decides the account from the key alone and has no call that
  checks a claimed one, declare no account field: have the test ask the
  provider which account the key belongs to and name it in its message.
  Memory has no run pin today (see "What the run pin does to you"), so
  `identity` changes nothing for a memory integration now; leave it off and
  keep to a checked non-secret field, because the pin is planned and the
  connection shape is permanent once shipped.
- **`optional`** and **`default`**: absent means required. `default` is used
  when the source leaves the field unset; a secret has none.
- **`format`**: `text`, `multiline` (a PEM key), `url`, or `integer`, which
  reaches `ctx.connection` as a number. There is no `pem` format: GitHub reads
  both a raw PEM and its base64 form itself (`integrations/github/auth.ts`)
  because an admin will paste either.

Operator behaviour that is not about reaching the provider (which board
columns a tracker watches, who may run a command) is not a connection field.
It is a stored setting of the capability, like Jira's columns. Slack's
channel is the documented exception, kept as a field because moving it would
have been a data migration.

### Where the values come from

Exactly one source at a time, per integration: the **environment** variables
your fields name, or values an admin **stored** from the dashboard. They never
mix. With nothing stored, the environment is the source when every required
field has its variable set; when some but not all are set, the card reads
Failing and names the missing variables. A manifest whose fields are all
optional never reads Connected on its own. Stored secrets are encrypted under
the deployment's `INTEGRATION_SECRETS_KEY`; without it, stored values are
unavailable and environment values still work.

An admin can prepare and test stored values while the environment is still
the source, and switch in one action. **Disable** is a stored flag that works
for either source and is read at every use: it is the kill switch an admin
reaches for, and your blocks stop with `integration_unavailable.disabled` at
their next use.

**Writes are refused on a deployment that does not own its database.**
Preview deployments, and the demo deployment, read production's database, so
a toggle there would change production. Every write on the Connection tab is
refused there with 403, naming both environments and ending "Use the
production deployment". For an integration that has shipped, that is where an
admin connects it. For one that has not merged yet, it is not an instruction:
no deployment here owns a database of its own, so do not set your variables on
a preview or on the demo either, and never deploy an unmerged branch there,
because the worker's build runs its migrations against production's database.
A Disable or stored values on production reach the demo and every preview
too, because the rows are shared. How an integration is proven instead is
under "Proving it works".

### The connection test

`testConnection` runs before stored values become the active connection and
whenever an admin presses Test. It answers one question, and the difference
between its two failure paths is the difference between a failed button and
a stopped deployment:

- return `{ ok: false, reason }` **only for a verdict about the values**: a
  status the provider documents as a credential or configuration problem (401
  and 403 are the usual ones; 404 for a project the key cannot see). Core
  records the connection as Failing, and every run that needs it stops until
  somebody fixes it;
- **throw** for everything else: a timeout, a 429, a 5xx, a body that is not
  your provider's. Core records "could not be reached" and leaves a working
  connection as it was.

You do not draw that line yourself: `refusedOrThrow(responseOrError, reason)`
from the SDK returns the refusal for a failure that is one and throws for
every other, by one rule for every integration
(`integrations/sdk/provider-failure.ts`: a 4xx refuses except 408, 425, 429
and a 403 that carries rate-limit headers). Where your provider documents a
status differently, a bare 403 that means a quota for instance, read that
status yourself first and hand the rest to `refusedOrThrow`.

**A pass names what the values reached.** Return `{ ok: true, message }` with
the account, workspace or project the key reached, as the provider names it.
The admin reads it before any run uses the values, and it is the only place a
valid key for the wrong project shows. When the provider cannot tell, say so
in the message.

```ts file=worker.ts
import {
  defineIntegrationRuntime,
  refusedOrThrow,
  z,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { manifest } from "./manifest";
import { hippoMemory } from "./memory";
import { webhook } from "./webhook";

const projectAnswer = z.object({ name: z.string() });

const definition: IntegrationRuntimeDefinition<typeof manifest> = {
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(
      new URL(`/v1/projects/${ctx.connection.projectId}`, ctx.connection.baseUrl),
      { headers: { authorization: `Bearer ${ctx.connection.apiKey}` }, retries: 0 },
    );
    if (!response.ok) {
      // Hippo answers 401 and 403 for a key it refuses and 404 for a project
      // this key cannot see; a 429, a 5xx or a timeout says nothing about
      // either, and throws, which leaves a working connection as it was.
      return refusedOrThrow(
        response,
        `Hippo refused this API key for project ${ctx.connection.projectId} (${response.status}).`,
      );
    }
    const project = projectAnswer.safeParse(await response.json().catch(() => null));
    if (!project.success) {
      throw new Error(`${ctx.connection.baseUrl} did not answer the way the Hippo API does.`);
    }
    return { ok: true, message: `Connected to the Hippo project ${project.data.name}.` };
  },
  capabilities: {
    memory: hippoMemory,
  },
  blocks: {},
  health: {
    api: async (ctx) => {
      const response = await ctx.http.fetch(
        new URL(`/v1/projects/${ctx.connection.projectId}`, ctx.connection.baseUrl),
        { headers: { authorization: `Bearer ${ctx.connection.apiKey}` }, retries: 0, timeoutMs: 3_000 },
      );
      if (response.ok) return { status: "live" };
      return { status: "down", message: `Hippo answered ${response.status}.` };
    },
  },
  webhook,
};

export const runtime = defineIntegrationRuntime(manifest, definition);
```

Keep the `IntegrationRuntimeDefinition<typeof manifest>` annotation. Written
inline as the second argument of `defineIntegrationRuntime`, the health
probes lose their types: `ctx` becomes an implicit `any` and a returned status
widens to `string`.

### What the context gives you

- **`ctx.connection`**: the resolved values, typed from your fields. A
  connection test receives the values being tested, which may not be the
  active ones yet.
- **`ctx.http.fetch`**: standard `fetch` signature, so it can be handed to a
  provider SDK that accepts a custom fetch. Each attempt has a 30 second
  timeout; a read (GET, HEAD, OPTIONS) is retried twice after a network error,
  a 429 or a 5xx, honouring `Retry-After` up to 30 seconds; nothing else is
  retried unless you pass `retries`, because repeating a write after an
  ambiguous 5xx reports a conflict for work that landed. The three numbers are
  `timeoutMs`, `retries` and `maxRetryAfterMs` in `INTEGRATION_HTTP_DEFAULTS`
  (`integrations/sdk/context.ts`). Core sees only the method, so a read your
  provider spells as a POST (a search, a filtered listing) is sent once unless
  you pass `retries`, and it may. A non-2xx response is returned, not thrown. It is bound to `ctx.signal`, and a `signal` you pass
  in its options is honoured alongside it, across retries and the waits
  between them. A thrown error keeps its `name` (`TimeoutError`,
  `AbortError`) and has this connection's secrets taken out of its message.
- **`ctx.log`**: pino's argument order, fields first, then an event name in
  snake_case: `ctx.log.info({ matches }, "hippo_search_answered")`. Secrets
  are redacted.
- **`ctx.signal`**: the context's lifetime, set by whatever core is doing
  when it calls you. It is not tied to a run being cancelled. Work with a
  deadline of its own gets that deadline: a block has 240 seconds
  (`INTEGRATION_BLOCK_TIMEOUT_MS`, `apps/worker/src/engine/steps/integration-block-step.ts`),
  a connection test 20 (`TEST_TIMEOUT_MS`, `services/integrations/authoring.ts`),
  a page reader 20 (`PAGE_READ_TIMEOUT_MS`, `services/integrations/page-data.ts`),
  a webhook request 120 (`WEBHOOK_TIMEOUT_MS`, `routes/webhooks/[id].post.ts`),
  `beginRun` 60 (`RUN_STATE_TIMEOUT_MS`, `engine/steps/integration-run-state-step.ts`),
  a health probe 4 (`PROBE_TIMEOUT_MS`, `services/system/collect.ts`); the
  last five are under `apps/worker/src`. A capability adapter core holds for a stretch of
  work (a poll pass, a run's downloads) gets a lifetime that does not abort on
  its own, so each of your requests is bounded by its attempt timeout
  instead; memory is the exception, aborted once your provider has used up
  the time core gives memory in one step (see "Memory"). Pass it to anything
  you wait on that is not `ctx.http`.
- **`ctx.webhookUrl`**: where this deployment receives your deliveries, for a
  health check that compares it with what the provider holds. Absent when
  the deployment does not know its public URL.

**A provider SDK gets the context, or is not used.** Add it to your package's
`dependencies` (`pnpm --filter @integrations/<id> add <package>`) and hand it
`ctx.http.fetch` and `ctx.signal`: redaction, the attempt timeout, read
retries and the memory budget hold only for requests that go through them.
Read how the SDK behaves before you add it. Many fall back to `process.env`
for a key their constructor was not given, send telemetry unless an
environment variable says otherwise, and carry a timeout of their own: switch
each of those off in code, because a fallback to `process.env` bypasses the
connection an admin chose. Where an SDK cannot be given a fetch, a signal or
a telemetry switch, call the provider through `ctx.http` instead.

Most of GitHub's and GitLab's calls go through their own provider SDKs
(Octokit, gitbeaker) rather than `ctx.http`, so none of the above applies to
those calls. Prefer `ctx.http`; Arthur, Slack and Jira go through it.

### What the run pin does to you

A run records, at its start, a fingerprint of each integration's connection
it uses: the values of its non-secret fields, plus a digest of every secret
marked `identity`. At every later use core compares it with the connection in
force:

| What changed | What the run does |
|---|---|
| A secret was rotated | Follows it, so rotation needs no outage |
| An `identity` secret, or any non-secret value | Stops at its next use with `integration_unavailable.reconfigured` |
| The integration was disabled | Stops at its next use with `.disabled` |
| It was disconnected | Stops at its next use with `.disconnected` |
| The same values saved again, or the source switched with identical values | Nothing |

Where the comparison happens today: the blocks your integration contributes,
and the `messaging` and `vcs` capabilities that core blocks consume. The
`issue_tracker` and `memory` capabilities have the comparison written and no
caller passes it a pin yet
(`apps/worker/src/engine/support/issue-tracker-runtime.ts`,
`memory-runtime.ts`), so a run using them follows the connection as it is now.

What it means for the manifest of an integration that has shipped: renaming a
field's key or `env`, changing its `default`, or turning `identity` on or off
moves the fingerprint on every deployment that sets that field, and stops
every run in flight through the integration. That is why the connection shape
is a committed snapshot (`apps/worker/src/services/integrations/connection-shape.snapshot.json`):
the edit and its consequence arrive in the same review, and a pull request
that moves a shipped integration's row says which runs have to be drained
first. Adding a field nobody has set moves nothing.

## Health checks

A health check tells an admin, on the System health page, whether something
your integration depends on works right now, without running a workflow: a
token that still authenticates, a channel the bot can post in, a webhook the
provider still points here. Declare at least one in `manifest.health` and
give each a probe of the same id under `health` in `worker.ts`.

- Core adds a `connection` row to your section and runs your probes only
  while the integration is usable, each bounded at four seconds
  (`PROBE_TIMEOUT_MS`), in parallel. Ask once; do not retry inside a probe.
- A probe returns `live`, `degraded` or `down` with a message. A throw is a
  `down` row carrying your error's message, redacted and cut to 300
  characters. Anything else, including nothing, is `down` as well: a health
  page must never paint Live over something nobody measured.
- `critical` decides what a failing check does to your section: a critical
  check that is down makes the section Down, a non-critical one makes it
  Degraded. It never changes whether your integration is usable. Only the
  connection decides that, so a failing probe does not stop a single run.
- A check may not be called `connection`, which is core's row.

The connection test and a health check look alike and answer different
questions: the test decides whether values may become the connection; a check
reports, later, on what the connection depends on. Slack's `channel` check
(`integrations/slack/worker.ts`) schedules a message sixty days out and
deletes it, because that is the only way to prove the bot may post in a
channel; Jira's `webhook-registration` is non-critical because a deployment
can run on its poller alone.

## Blocks

An integration block is one step of a workflow that belongs to your
integration: the palette groups it under your name, and it is offered only
while you are connected and enabled. The template's `example_lookup`
(`integrations/_template/manifest.ts`, `worker.ts`) is a complete one.

In the manifest:

- **`type`** is `<id>_<name>` in lowercase words joined by underscores. It is
  stored in every workflow that uses the block.
- **`paramsSchema`** is a zod schema written with the `z` the SDK exports.
  **The editor has no form for an integration block's parameters yet**: a node
  starts with the manifest's `defaults` and an author cannot change them in
  the editor, only through MCP or an imported definition. Take what an author
  must choose as an **input** they bind, and keep parameters to what has a
  sensible default, written both in the schema and in `defaults`.
  Conformance parses `defaults` with `paramsSchema` under both zod majors and
  refuses a default the schema rejects, because a new node starts with it and
  nothing in the editor could fix it. It also refuses a `z.record` keyed by an
  enum or a literal, which zod 3 reads as every key optional and zod 4 as every
  key required: write `z.object` with each key optional instead.
- **`contract.ports`** is exactly `["out"]`. A second port would be offered in
  the editor, refused at publish and propagate to nothing at run time, so the
  generator and conformance both refuse it. Branch on `status` instead.
- **`output.statusVariants`** lists every value `status` can take; stored
  graphs branch on them. **`output.required`** fields are typed from the
  manifest, so an executor cannot forget one.
- **`output.mustRead`** names a field a published graph has to act on: the
  first node on every path out of the block must be a Branch on it. Arthur's
  injection check declares `status`, because a verdict nobody reads lets the
  run carry on whatever it says.
- **`inputs`** are values bound from upstream blocks. An input may declare
  `defaultFromSubject` (`title`, `description`, `comments`) to be filled from
  what the run is about when nothing is bound.
- **`requires`**: the capabilities the block uses, and `llm: true` if it calls
  `ctx.llm`.

In the worker, an executor receives `{ params, inputs }` (params parsed by your
schema, inputs typed from the manifest) and the block context, and returns:

- `{ kind: "next", output }` to continue, `status` included;
- `{ kind: "failed", message, detail? }` for an expected failure: `message` is
  what a person reads on the run and in the ticket comment, `detail` goes to
  the log.

A throw is reported like `failed`, with the error's own message. Either way
the run stops at the block unless the author wired its failure port.

What core does around it, and what that asks of you:

- **It runs your executor once, and never again.** The generic step that runs
  every integration block has no retries, so a block that posted a comment
  and then threw does not post it twice. Retrying a transient failure is
  yours, through `ctx.http`. `FatalError` from the SDK changes nothing inside
  a block; it matters in a capability adapter, which core calls from its own
  steps, where any other error may be retried.
- **One block is one step, bounded at 240 seconds** (`INTEGRATION_BLOCK_TIMEOUT_MS`). Waiting for a person,
  looping and sleeping belong to core and are reached through a capability.
  A block that hangs is stopped and says so.
- **`ctx.run`** carries `runId`, `nodeId`, `attempt` (higher when the graph
  runs the node again, inside a Loop) and `subjectKey`, the name of what the
  run is about (a ticket key for a ticket run).
- **`ctx.llm.generateObject({ prompt, schema })`** answers with output your
  schema accepted, using the run's model. It is bounded under the 300 second
  invocation ceiling, but not by `ctx.signal`.
- **Per-run state**, for a provider that cannot be asked twice for the same
  thing: declare `runState: true` and implement `beginRun`. Core calls it once
  per run, at the run's first use of your integration, records the JSON it
  returns, and hands it to every block as `ctx.run.state` (`null` when it
  failed). Arthur needs one task per run because its API numbers a second task
  for a name that exists.

## Webhooks

A provider that calls you back posts to `/webhooks/<id>`, and core hands the
request to your `webhook.receive`. You own the transport: verify the
signature over the **raw bytes** (`request.rawBody`, before anything parsed
it), read the provider's encoding, decide who may speak. Core owns the
decision: what a ticket moving or a pull request event means for a run.

`receive` answers one of five things (`integrations/sdk/webhook.ts`):

| Answer | When | Example |
|---|---|---|
| `answered` | Verified, nothing for core to decide | Help text, an event you ignore |
| `run_control` | A person asked for a run command; core runs it, then calls your `deliver` | Slack's slash command, which has three seconds to acknowledge |
| `trigger_events` | Pull request events, normalized | GitHub, GitLab |
| `ticket_events` | Ticket events, normalized, or `ignored` with a reason | Jira |
| `refused` | Bad or stale signature (401), missing configuration (503) | All of them |

Declare a webhook only when your provider calls you back about something core
acts on: a memory integration normally has none, and Hippo's below exists to
show the shape. A webhook also cannot start a workflow from events of the
provider's own kind (an incident, a support request): the five answers below
are everything core acts on. Point such a provider at core's generic trigger
instead (`trigger_webhook`, which gives each deployed workflow its own
`POST /webhooks/custom/<endpointId>`; SETUP.md, "Webhook trigger").

Your `reason` on a refusal goes back to the sender as the status message
(`apps/worker/src/routes/webhooks/[id].post.ts`), so keep it to what you would
tell them. Before your code runs, core answers for you: 404 when your runtime
declares no webhook, 503 when your integration is not connected here, and 202
with nothing dispatched when it is disabled, so the provider neither retries
nor switches the webhook off.

```ts file=webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IntegrationWebhook } from "@integrations/sdk";
import type { manifest } from "./manifest";

/** How old a signed request may be before it is treated as a replay. */
const REPLAY_WINDOW_SECONDS = 5 * 60;

/**
 * Hippo signs `<timestamp>.<raw body>` with HMAC-SHA256 and sends the hex
 * digest in `x-hippo-signature`. That sentence is the provider's, not ours:
 * read it off the provider's own page before writing this function.
 */
export function signatureMatches(input: {
  readonly rawBody: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly secret: string;
}): boolean {
  const sentAt = Number(input.timestamp);
  if (!Number.isInteger(sentAt)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - sentAt) > REPLAY_WINDOW_SECONDS) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest("hex");
  const sent = Buffer.from(input.signature);
  const wanted = Buffer.from(expected);
  return sent.length === wanted.length && timingSafeEqual(sent, wanted);
}

export const webhook: IntegrationWebhook<typeof manifest> = {
  receive: async (request, ctx) => {
    const secret = ctx.connection.webhookSecret;
    if (!secret) {
      return { kind: "refused", status: 503, reason: "no webhook secret is configured" };
    }
    const valid = signatureMatches({
      rawBody: request.rawBody,
      timestamp: request.headers["x-hippo-timestamp"] ?? "",
      signature: request.headers["x-hippo-signature"] ?? "",
      secret,
    });
    if (!valid) return { kind: "refused", status: 401, reason: "signature did not verify" };
    ctx.log.info({ bytes: request.rawBody.length }, "hippo_callback_received");
    return { kind: "answered", response: { status: 200 } };
  },
};
```

Header names arrive lowercased. Two connection keys are not yours in a
webhook: the route removes `legacyBotLogin` from the connection it hands
`receive` and sets `botLogin` to the automation account of a `vcs` provider,
`undefined` for anything else, so do not give a field either name. The URLs
providers already call
(`/webhooks/jira`, `/webhooks/github`, `/webhooks/gitlab`, `/webhooks/slack`)
are the same generic route, which is why an integration's id can never
change once a provider has been told where to send.

## Dashboard pages

An integration with something to show declares pages in `manifest.pages`,
ships one component per page in `dashboard.tsx`, and gives each page that
shows provider data a reader under `api` in `worker.ts`. The template has a
complete one (`integrations/_template/dashboard.tsx`), and Arthur's Evals
page is a real one.

- **The page reads what its own reader returned.** Core resolves the
  connection, calls `api[pageId]` on the server, and hands the result to the
  page as `data`: `ok` with a value, `none` when the page has no reader, or
  `unavailable` with a `cause` (`worker`: ours; `not_connected`; `provider`:
  your reader threw, with its message redacted). Read `data.value`
  defensively: the dashboard and the worker can be one deploy apart. What a
  reader returns reaches the browser, so it carries no secret.
- **A page runs only while the integration is usable.** Otherwise the area
  says why and offers Connection. A page that throws gets its own error
  screen and a slow one a loading state, with the tab strip still standing.
- **Build it from `@integrations/host-ui`**: `Page`, `Section`, `Card`,
  `KeyValue`, `Chip`, `Notice`, `EmptyState`, `ExternalLink`, `Table`. No
  primitive takes a `className`; write Tailwind classes on your own elements
  around them, with the cockpit's tokens (`integrations/host-ui/README.md`).
  The dashboard's stylesheet scans `dashboard.tsx` and anything under a
  `dashboard/` directory beside it, so keep page code there.
- **Refused, and why.** `@/...` is the dashboard's internal alias and changes
  whenever a screen needs it to. `next/*` reaches our cookies
  (`next/headers`) or moves the person (`next/navigation`), `node:*` reaches
  the filesystem, and `server-only` declares a module part of our server. The
  boundaries gate refuses all four in `dashboard.tsx` (and `@/` anywhere in
  the package). The registry generator compiles `dashboard.tsx` and the files
  it imports against what a browser has, so `process` (in the cockpit's
  server, this deployment's environment and every secret it runs with),
  `Buffer` and `require` are refused with the file and line that use them,
  and so are `globalThis`, `eval` and `Function`, which reach a global by a
  name the check cannot read. So is an import of one of Node's own modules by
  its bare name (`"process"`, `"fs"`), which the `node:` rule above does not
  see, and a `declare` statement, which would describe a global the page is
  not given. Comments and a local binding of the same name are not. There are
  no dialogs, no internal links and no form controls: pages have no write seam
  yet.
- **A page that moved here from core keeps its old address.** Declare the
  paths it used to live at in the page's `legacyPaths` (Arthur's Evals page
  declares `["/evals"]`). The dashboard builds a permanent redirect to the page
  from each one in `next.config.ts`, so bookmarks and links in old messages
  keep working. Each is one lowercase segment, and conformance refuses
  anything else or a path declared twice; the dashboard's own tests refuse one
  that a live screen serves or another page already claims.
- **Import the manifest with `import type`** in `dashboard.tsx`, so its zod
  schemas never reach the browser, and declare the pages with
  `defineIntegrationDashboard<typeof manifest>({ pages })`: a declared page
  without a component, a component nobody declared, and any component at all
  for a manifest that declares no page are compile errors
  (`integrations/host-ui/contract.test.ts`). A manifest with no page has no
  `dashboard.tsx`; the generator refuses one.

## MCP

Integrations contribute no MCP tools, and there is nothing for you to write.
Connecting, testing, enabling and choosing a provider are dashboard actions
only, so a credential never passes through a chat with a model.
`system.capabilities` lists your integration, whether it is usable, the
capabilities it declares and its blocks, computed by the same resolver as the
editor's palette, and, per capability, which provider serves it on this
deployment (the Integrations page's Capabilities rows). Anything an agent
reads has your declared variable names replaced, which is why a name shorter
than four characters is refused, and a refusal sentence about your connection
is replaced whole by one that names no configuration.

## Testing without our production credentials

**Conformance** (`pnpm --filter @integrations/registry run test`) finds every
package under `integrations/` without being told, so yours is covered the day
it lands. It imports your manifest and runtime and checks them against the
contract: ids and block types, reserved names, secrets flagged, an executor
per block, an adapter per capability, a probe per check, a reader only for a
declared page, `beginRun` exactly when `runState` is declared, no workflow
directive in any file, and no one-argument `z.record` in a block's parameter
schema. `pnpm run test:packages:zod4` runs the same suite again against zod 4.

**Your own tests** exercise your code against a context you build, with no
network and no credential:

```ts file=webhook.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { IntegrationContext } from "@integrations/sdk";
import type { manifest } from "./manifest";
import { webhook } from "./webhook";

/**
 * A delivery the provider signed, downloaded from its documentation. The file
 * beside it, `signed-delivery.source.txt`, says where from, on which date,
 * and the SHA-256 of these bytes.
 */
const recorded = JSON.parse(
  readFileSync(new URL("./test-fixtures/signed-delivery.json", import.meta.url), "utf8"),
) as { secret: string; timestamp: string; signature: string; rawBody: string };

function context(webhookSecret: string | undefined): IntegrationContext<typeof manifest> {
  return {
    connection: {
      baseUrl: "https://api.hippo.example",
      projectId: "p_1",
      apiKey: "not-used-here",
      webhookSecret,
    },
    http: { fetch: () => Promise.reject(new Error("this test makes no request")) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: AbortSignal.timeout(1_000),
  };
}

function delivery(overrides: { rawBody?: string } = {}) {
  return {
    method: "POST",
    rawBody: overrides.rawBody ?? recorded.rawBody,
    headers: { "x-hippo-timestamp": recorded.timestamp, "x-hippo-signature": recorded.signature },
    query: {},
  };
}

test("accepts the delivery the provider itself signed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Number(recorded.timestamp) * 1000 });
  const reception = await webhook.receive(delivery(), context(recorded.secret));
  assert.equal(reception.kind, "answered");
});

test("refuses the same bytes with one character changed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Number(recorded.timestamp) * 1000 });
  const reception = await webhook.receive(
    delivery({ rawBody: `${recorded.rawBody} ` }),
    context(recorded.secret),
  );
  assert.deepEqual(reception, { kind: "refused", status: 401, reason: "signature did not verify" });
});

test("says the deployment was never given a secret, rather than that the sender is wrong", async () => {
  const reception = await webhook.receive(delivery(), context(undefined));
  assert.equal(reception.kind, "refused");
  assert.equal(reception.kind === "refused" && reception.status, 503);
});
```

A memory adapter is tested the same way: a context whose `http.fetch` answers
from the provider's recorded bodies, and one case for each rule a run depends
on (what it renders, what an unreadable answer is, that it answers rather than
throws, that a seed never edits what a run wrote):

```ts file=memory.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { IntegrationContext, MemoryObserveRequest } from "@integrations/sdk";
import type { manifest } from "./manifest";
import { hippoMemory } from "./memory";

/**
 * Hippo's answer to a search, as its documentation shows it. A real package
 * keeps this in `test-fixtures/` with its `.source.txt` beside it (see
 * "Recorded payloads"); it is inline here because Hippo is invented.
 */
const SEARCH_ANSWER = { memories: [{ text: "Run tests with: pnpm test" }, { text: "Uses pnpm 9" }] };
const SUBJECT = { key: "repo:github:acme/api", label: "acme/api" };
const LEARNED: MemoryObserveRequest = {
  subject: SUBJECT,
  scope: { kind: "facts" },
  runId: "run_1",
  ticketKey: null,
  observation: { kind: "items", learned: ["Uses pnpm 9"], refuted: [] },
};

/** Hippo, as `respond` answers each request; every request is kept. */
function hippo(respond: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const ctx: IntegrationContext<typeof manifest> = {
    connection: {
      baseUrl: "https://api.hippo.example",
      projectId: "p_1",
      apiKey: "not-a-real-key",
      webhookSecret: undefined,
    },
    http: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return respond(request);
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
  return { memory: hippoMemory(ctx), requests };
}

test("renders what Hippo holds, leaving out what the caller already has", async () => {
  const { memory } = hippo(async () => Response.json(SEARCH_ANSWER));

  const answer = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" }, exclude: ["Uses pnpm 9"] });

  assert.deepEqual(answer, {
    ok: true,
    held: true,
    entries: [{ text: "Run tests with: pnpm test" }],
    rendering: "- Run tests with: pnpm test",
  });
});

test("reads an answer it cannot parse as unavailable, never as holding nothing", async () => {
  const { memory } = hippo(async () => new Response("<html>Bad gateway</html>", { status: 200 }));

  const answer = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });

  assert.equal(answer.ok === false && answer.code, "unavailable");
});

test("answers rather than throws when the request is aborted", async () => {
  const { memory } = hippo(async () => {
    throw new DOMException("This operation was aborted", "AbortError");
  });

  const read = await memory.recall({ subject: SUBJECT, scope: { kind: "facts" } });
  const write = await memory.observe(LEARNED);

  assert.equal(read.ok === false && read.code, "unavailable");
  assert.equal(write.ok === false && write.code, "unavailable");
});

test("a seed writes nothing where something is already held", async () => {
  const { memory, requests } = hippo(async () => Response.json(SEARCH_ANSWER));

  const write = await memory.observe({
    ...LEARNED,
    observation: { kind: "items", learned: ["Uses pnpm 9"], refuted: [], derived: true, onlyIfEmpty: true },
  });

  assert.deepEqual(write, { ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 });
  assert.deepEqual(requests.map((request) => request.method), ["GET"]);
});
```

The scaffold ships the runner and a first test (`worker.test.ts`): a `test`
script, `node --import tsx --test "!(node_modules)/**/*.test.{ts,tsx}" "*.test.{ts,tsx}"`,
and `test:zod4`, the same files under the zod production loads through
`../../packages/zod4-alias.mjs`, with `tsx` and `zod4` in `devDependencies`.
Keep both globs: Node's runner reads a bare `"*.test.ts"` as the package root
only, so a test beside page code in `dashboard/` would never run and a test
broken on purpose would stay green. GitHub, GitLab and Jira use `vitest run`
instead, which finds nested files on its own. Then add
`--filter @integrations/<id>` to the root `test:packages` and
`test:packages:zod4` scripts in `package.json`: those lists are what CI runs,
and `scripts/ci/verify-changed.test.ts` fails when a package that owns a
`test` script is missing from them, when a test file in a package is one its
script does not run, and when a package has a `test` script and no test.

### Recorded payloads

A test of how you read a provider's payload is worth what its bytes are
worth. Record real ones and keep their provenance beside them, as
`integrations/github/test-fixtures/*.source.txt` do: the URL, the pinned
revision, the retrieval date and the SHA-256 of the bytes, with the digest
pinned in a test so a fixture reshaped to make an assertion pass fails loudly.

A recorded payload **signed by the same function that verifies it proves
nothing**: sign and verify agree with each other whatever the header, the
encoding or the string that is signed, so the test passes and the provider's
first real delivery is refused. You find out from the provider's delivery log,
and a provider that meets enough failures switches the webhook off. Use a
signed example the provider published (Slack's is
`integrations/slack/fixtures/signed-slash-command.json`: secret, timestamp,
body and signature all Slack's). When the provider publishes payloads without
signatures, as GitHub and GitLab do, sign them in the test with a helper
short enough to read against the provider's page, and say so beside it.

### zod 3 in tests, zod 4 in production

The workspace pins zod 3 and every local run uses it. The deployed worker
bundle resolves zod 4, traced from the Workflow DevKit. Where the two majors
disagree, a schema passes every local test and fails in production at its
first parse: a one-argument `z.record(value)` does not exist in zod 4 (write
`z.record(z.string(), value)`), and `.default()` short-circuits in zod 4 and
applies inside `.optional()`, where zod 3 did neither. Conformance checks your
block parameter schemas under both; the schemas in your worker code that read
a provider's answers are checked only by your own `test:zod4`. Always write
`z` from `@integrations/sdk`, never your own `zod` dependency.

### Proving it works

No deployment here is yours to try an integration on before it merges.
Previews and the demo deployment read production's database, and the
worker's build runs its migrations against whatever database it is given, so
deploying an unmerged branch to either changes production without the review
a merge gets. For the same reason, do not start a worker locally: on our
machines `DATABASE_URL` points at production. So the proof comes in two
halves:

1. **Before the merge, locally**: your package's tests against recorded
   payloads, conformance, the typecheck, and for a question the documentation
   leaves open, a live call from your own machine to the provider with a test
   account's key (see "Before you write a line"). `integrations/_fixtures/demo`
   is a provider with no network at all, registered only in a registry a
   developer generates locally with `INTEGRATION_FIXTURES=1 pnpm run
   gen:integrations`. No deployment and no CI job sets that flag, the
   committed registry is the one generated without it, and
   `gen:integrations --check` compares against that whatever the flag says;
   tests that need the fixture ask the generator for it directly. Copy its
   approach for a network-free double of your own.
2. **After the merge, on production**, by an operator, through the Connection
   form with stored values, which need no redeploy: Save runs your connection
   test, its message names the account, and the
   integration reads Connected; its card, pages and health rows appear, and a
   workflow can use its blocks. Disable, from the same form, is how it is
   switched off again.

For a memory integration, the operator's half is this:

1. **Drain first.** No run is running or waiting (the Runs page, or
   `runs.stats` over MCP): a run in flight when you connect may read from the
   built-in store and write to yours.
2. **Connect** through the form, and check that Test names the project meant.
3. **Turn on repository memory** on the Settings page if it is off, and run a
   ticket through a workflow with one agent block on one repository.
4. **In the worker's logs for that run**, by its id: `repo_memory_seeded`
   (logged only when the seed wrote something, which on a first run it does
   when the repository's manifest names its package manager or scripts),
   `repo_memory_injected`, `memory_document_persisted` at teardown (when the
   agent wrote a notebook), `repo_memory_distilled` with an `outcome` other
   than `memory_unavailable`, and no `memory_provider_unavailable`, whose
   `provider` field would name who refused.
5. **In the engine's own console**: memories under the ticket's subject key and
   under `repo:<provider>:<path>`, carrying your namespace. The memory screen
   (`/memory`) lists the same documents by your `docPath`s.
6. **Run the same ticket again**: the notebook the first run wrote is back in
   the agent's workspace (`memory_document_hydrated_from_store`), and the seed
   writes nothing (no `repo_memory_seeded` line).
7. **Disable the integration**: the next run uses the built-in store, and the
   memory screen shows the built-in documents as they were before step 2.

## What an integration cannot do

Some things look possible from the context and are not, and each has a pattern
that works:

- **No install flow, and nothing written back.** There is no OAuth install or
  callback route, and an integration has no database: it reads its connection
  values and writes none. A refresh token that the provider rotates on every
  use therefore breaks at the second refresh (`invalid_grant`), although the
  card said Connected. Use a long-lived token, or a credential that mints
  short-lived tokens on demand without storing anything, as GitHub's App
  private key does (`integrations/github/auth.ts`).
- **No workflow started by a provider's own events.** `webhook.receive` answers
  one of five things, and none of them starts a workflow from an incident, an
  alert or a support request. Core's generic trigger does (`trigger_webhook`,
  SETUP.md "Webhook trigger"): point the provider there.
- **No MCP tools, and no memory of its own.** Integrations contribute no MCP
  tools (see "MCP"). A block cannot read or write memory either: `memory` has
  no key on the context, because which subject a run may write to is core's
  decision.

## Things you may not do, and what happens if you do

| If you | What breaks, and when you find out |
|---|---|
| Import a Node module or a provider SDK into `manifest.ts`, directly or through a file it imports | The Workflow DevKit's flow bundle fails the Vercel build, and nothing local would notice. `pnpm run gen:integrations` refuses it first, naming the import. |
| Use a global the Workflow DevKit's VM lacks in `manifest.ts` or a file it imports (`Buffer`, `EventTarget`, `setTimeout`, `fetch`, `process`), one it makes differ (`Date`, `Math.random`, and `crypto`, whose `randomUUID` and `getRandomValues` it seeds), or one that reaches past the check (`globalThis`, `eval`, `Function`, a `declare` statement) | Conformance and the typecheck run in Node and pass; the deployed workflow throws a ReferenceError, hits a stub that throws, or reads a value the dashboard does not see. `pnpm run gen:integrations` refuses it first: it compiles the manifest's files against the language plus what the VM provides (`WORKFLOW_VM_GLOBALS` in `scripts/gates/generate-integration-registry/graph-globals.ts`, held to the pinned DevKit by a test) and names each use with its line. A type that mentions `Buffer`, or a local named `process`, is not a use. |
| Put `"use step"` or `"use workflow"` in integration code | A step's identity is its module path plus its function name (the DevKit's id is `step//<module path>//<function>`), so a step inside your package would strand every run suspended in it the day the package moved or was renamed. Conformance refuses the directive in any file of the package. |
| Put your provider's word into a shared type, or core's code | The next provider cannot implement the port without inventing a meaning for your word, and core grows a branch on your name. The core-reference gate fails on any core file that spells a shipped integration's id, its package names and the identifiers built from it included (`jira-client`, `JiraAdapter`). |
| Pick an id core source already spells | The core-reference gate fails your first run on every core file that spells it where no allowlist row covers it (the rule is quoted under "From nothing to a connected integration"). `new:integration` refuses such an id and names the files. |
| Parse with a zod feature zod 4 changed | Production fails at the first parse while every local test passes. |
| Test a webhook against bytes you signed yourself | The provider's first real delivery is refused, discovered from its delivery log. |
| Return `{ ok: false }` from `testConnection` for a timeout or a 5xx | A provider blip while an admin presses Test marks the connection Failing and stops every run until somebody presses Test again. |
| Read your configuration from `process.env` | It bypasses the source an admin chose, is not pinned or redacted, and is missing on a deployment connected from the dashboard. |
| Give a block a second port, or a parameter with no default | The port is refused by the generator. The parameter cannot be set in the editor, so the block cannot be published from it. |
| Rename a block type, a status variant or the id after shipping | Stored workflows stop resolving the block or take another branch; the id is also written into stored rows (`ticket:jira:<KEY>` for every Jira run), so renaming it is a migration, not an edit. |
| Rename a connection field's key or `env`, or change its default or `identity`, after shipping | Every run in flight through the integration stops with `reconfigured` on every deployment that set it. The connection-shape snapshot test makes the change visible in review; the drain happens before merge. |
| Import another integration, `@shared/*` or anything in `apps/` | The boundaries gate and conformance refuse it. The SDK re-exports what you need from `@shared/contracts`. |
| Return a secret from a page reader, or put one in a message | A reader's value reaches the browser. Messages and logs are redacted against your declared secrets, values are not. |
| Leave a fetch in a page or a probe unbounded | A page is what the cockpit waits on, and a probe that hangs is cut off as down. |
| Deploy an unmerged branch to the demo or a preview, or set your variables there | Its build runs your branch's migrations against production's database, and a connection there is production's connection. You find out when production changes. |
| Answer `held: false` for a memory answer you could not read | The seed writes into a store that is already full, and a run takes an old committed file for the ticket's notebook. Nothing fails; memory is quietly wrong. |
| Resend a memory write that may have landed | An engine without idempotency keys stores it twice. Core never resends; answer `unavailable` instead. |
| Hand a subject key or a notebook name to an engine call that reads it as a pattern, or leave your namespace off a read or a delete | A key containing `*` deletes every subject; another application's memories reach a prompt, the memory screen and an erasure. |
| Let a provider SDK read `process.env`, keep its own timeout or send telemetry | It bypasses the connection an admin chose, the redaction and the memory budget, silently. |

## Before you open a pull request

```sh
pnpm install
pnpm run gen:integrations
pnpm --filter @integrations/<id> run typecheck
pnpm --filter @integrations/registry run test
pnpm --dir apps/worker exec vitest run src/services/integrations/connection-shape.test.ts
pnpm run gate:core-references
pnpm run verify:changed -- --worktree
```

- The package's README says what it connects, which values an admin needs and
  where to find them, what connecting unlocks, and which provider pages you
  read and when. A memory integration's README also says: that connecting
  copies nothing and disconnecting deletes nothing; that deployments sharing
  its connection share memory, and one engine project per connection keeps
  them apart; which namespace it writes; whether items go through the
  engine's own extraction, and why; and, when it has no `store`, that the
  memory screen cannot list or erase what it holds.
- `changelog/unreleased/<slug>.md` carries one bullet saying what a person can
  do now and where (a page, a block, an MCP tool). Never a defect, an
  incident, a ticket key, a commit, a pull request number or a person, and
  never the words fix, bug, broken or finally; `changelog/README.md` has the
  whole rule and its examples.
- The pull request says which provider documentation the adapter was written
  against, and, for a change to an integration that has shipped, which
  connection shapes and block types moved.

## Where to look

| For | Open |
|---|---|
| Every type and its rule | `integrations/sdk`: `manifest.ts`, `context.ts`, `runtime.ts`, and one file per port |
| What conformance refuses, with each rule's sentence | `integrations/sdk/conformance.ts` |
| The starting point | `integrations/_template`, and `scripts/gates/new-integration.ts` which copies it |
| A tracing provider, per-run state, a block that must be read, a page with data | `integrations/arthur` |
| One active messaging provider, a slash command, a probe that cleans up after itself | `integrations/slack` |
| A per-repository provider on a self-hosted host | `integrations/gitlab` |
| A credential that is not a token, recorded webhook payloads with provenance | `integrations/github` |
| The one issue tracker, ticket events, a permanent id | `integrations/jira` |
| The built-in memory provider | `apps/worker/src/memory/builtin/adapter.ts`, `apps/worker/src/engine/support/memory-runtime.ts` |
| A provider with no network, for demos | `integrations/_fixtures/demo` |
| Why any of this is shaped the way it is | [ADR-010](../adr/ADR-010-integrations.md) |
