Status: current
Last-verified: 2026-09-21

# ADR-010: Integrations

Decision status: Accepted

Source: the implementation decisions of
[docs/plans/2026-09-18-integrations.md](../plans/2026-09-18-integrations.md),
frozen in stage S0 (AIW-395) as the package `@integrations/sdk` under
`integrations/sdk`. The plan carries the stage table and the user stories;
this record carries the rules a reviewer applies, their reasons, and every
later change to the contract.

## Context

Every third party the product talks to (Jira, Slack, GitHub, GitLab, Arthur)
is wired into core by hand. Connecting one means editing environment
variables and redeploying, because settings hold no credentials
(`packages/contracts/settings-registry.ts:4-8`). The editor learns what can
run from provider conditions written in the middle of the engine
(`apps/worker/src/engine/definition/block-contract-resolver.ts:78-194`). Non-test
worker files outside the adapter directories name Jira 14 times, Arthur 14,
GitHub 9, Slack 7 and GitLab 7 (the plan's recon). One block, `investigate`, reads Jira through
the port and calls Slack directly
(`apps/worker/src/engine/blocks/investigate/execute.ts:345-433`), and the
Arthur check skips when Arthur is not configured
(`apps/worker/src/engine/blocks/arthur-injection-check/execute.ts:98-101`).
Nobody outside the core team can add a provider: there is no place, no
contract and no guide.

What constrains the answer, all true today:

- The Workflow DevKit discovers steps only under `apps/worker/src`, and a
  step's identity is its module path plus its function name
  (ADR-001, "The engine as a workspace package"). Step code from anywhere
  else is never found, and moving a step strands the runs suspended in it.
- The DevKit's flow bundle fails the Vercel build on any Node module in
  workflow scope, and the dashboard bundles for the browser.
- Production resolves zod 4 while the workspace pins zod 3
  (`pnpm-workspace.yaml:16-21`); a one-argument `z.record` passed every gate
  and took production down.
- An invocation has a 300 s ceiling (`apps/worker/src/infra/llm.ts:14-19`),
  and research blocks synthesise with a model today
  (`apps/worker/src/engine/blocks/investigate/execute.ts:298,477,532`).
- Preview deployments read the production database, and production runs
  neon-http, which has no interactive transactions.

## Decision

### The plan's decisions

1. **One word.** The concept is an *integration* everywhere (interface, code,
   MCP, docs). A seam an integration can fill is an *integration capability*,
   `IntegrationCapability*` in code, distinct from the model catalog's
   `HarnessCapability*`. Reason: two words for one thing split every search,
   and "capability" already meant something in the harness catalog.
2. **One package per integration** under a top-level `integrations/` workspace
   folder: `integrations/sdk` is the contract; `integrations/<id>` has a
   `manifest` entry (pure data, no Node modules), a `worker` entry (the
   runtime) and an optional `dashboard` entry; `integrations/_template` is
   what the scaffold copies. Packages are TypeScript sources with `main`,
   `types` and `exports` on `.ts`, exactly like `packages/*`, with their own
   `typecheck` script. Reason: that shape is proven on Vercel for Nitro, Next
   and the DevKit bundles without `transpilePackages` or `externals.inline`,
   and a package without the script drops out of `pnpm -r typecheck`. The
   three entries exist because the three bundles that read an integration
   (browser, workflow scope, server) tolerate different code.
3. **Registration is generated.** The block catalog generator grows into an
   integration generator that writes committed registries, with `--check`
   inside `build`. Reason: a hand-kept list is the drift this plan removes.
4. **No runtime code loading.** Integrations are compiled in; a deployment
   decides which are connected. Reason: the DevKit would not find step code
   installed at runtime, and loading third-party code at runtime is a security
   surface nobody needs.
5. **Integration code carries no `"use step"`.** Core owns one generic
   integration step that runs any integration block executor; an integration
   block is exactly one step. Reason: step identity is path plus function
   name, so directives inside integration packages would strand runs whenever
   a package moved. The migration itself changes step files, so every stage
   that adds, moves, renames or deletes a `"use step"` or `"use workflow"`
   file drains the runs in flight through it first.
6. **The context is the only thing an integration receives**: its resolved
   connection, an HTTP client with timeout, retry and redaction, a logger, the
   run and node identity while a block executes, the capabilities it declared,
   and a core-owned `llm`. No database, no process environment, no worker
   import. Reason: anything more couples integrations to worker internals and
   every internal change becomes a change to every integration. The context
   was designed from the inventory in Appendix A, not from first principles;
   after S0 it changes only additively, recorded in the change log below. The
   one exception is a row in the debt table: while a port's only
   implementations are core's own providers, the stage that owns the row may
   change that signature, and it writes the change into the change log. Once a
   port has an implementation outside this repository, even that stops.
7. **Capabilities**, with fixed ids and cardinality:

   | Capability | Port | Cardinality | Designed |
   |---|---|---|---|
   | `issue_tracker` | `IssueTrackerAdapter` | one active | S0 (moved) |
   | `vcs` | `VCSAdapter` | many, chosen per repository | S0 (moved) |
   | `messaging` | `MessagingAdapter` | one active | S0 (moved) |
   | `memory` | reserved | one active | S13 |
   | `agent_tracing` | reserved | many | S8 |
   | `agent_tools` | reserved | many | a later plan, after AIW-392 |

   Agent and LLM providers stay with the harness profile and the model
   catalog (ADR-006). Reason: these are the seams core has or needs; a
   reserved id lets core name the seam without guessing its shape.
   `agent_tracing` is the one declared exception to "secrets never leave the
   server": a secret it hands to a sandbox is declared in the manifest and
   redacted from run logs and traces.
8. **Webhooks** reach one generic route `/webhooks/[id]`, so the URLs
   providers already call keep working. A handler verifies the request and
   returns normalized core events; core dispatches. An event for a disabled
   integration is accepted, recorded as ignored with the reason, and
   dispatched nowhere. Reason: dispatch rules (capacity, ownership, stale
   heads) are core's and must not be reimplemented per provider; accepting
   the event stops the provider from retrying or disabling the hook.
9. **Connection state.** One source per integration, chosen explicitly: its
   declared environment variables or values stored from the dashboard. With
   nothing stored, a complete environment is the source, so running
   deployments need no action; a partial environment is Failing and names the
   missing variables. Only connection values come from the environment;
   operator behaviour (Jira columns, a Slack channel) is stored settings.
   Disable is a stored flag read live. A run pins a connection version,
   follows secret-only rotations and fails with `reconfigured` on a config
   change. Secrets are encrypted under `INTEGRATION_SECRETS_KEY` with a key id,
   never leave the server, and writes are refused on a deployment whose
   environment is not the database's. Reason: each rule answers a failure the
   pre-mortem found (a surprise override in production, rotation as an outage,
   a preview disabling production, a site mixed with another site's token).
10. **Built-ins live in core.** An implementation that needs core storage,
    such as built-in memory, is a core module registered as a provider, not an
    `integrations/*` package. Reason: an integration gets no database.
11. **Availability comes from the catalog.** The block contract resolver keeps
    its pure shape; its context becomes integration states and capability
    providers, and "this block needs integration X or capability Y" comes from
    the generated catalog. Reason: provider conditions written in core are
    what made every provider a special case.
12. **Unavailable is loud.** A run that needs a disconnected or disabled
    integration fails with `integration_unavailable` naming it and a reason;
    nothing is skipped, and the injection check fails closed. Memory is the
    one exception: a run continues without it and says so. Reason: a skipped
    safety check is worse than a failed run, and failing every run because an
    optional memory engine is down would make it the product's single point
    of failure.
13. **The editor** shows core blocks whose capabilities are provided and the
    blocks of connected, enabled integrations under the integration's name,
    and refuses to publish a workflow that uses an unavailable one. Reason:
    authors must learn about a missing integration before a run does.
14. **The sidebar** puts core groups first, then an Integrations separator,
    the Integrations page and one entry per connected, enabled integration,
    whose area has its pages and a Connection tab. Reason: third-party screens
    must not sit among core screens whether or not the provider exists.
15. **MCP covers what workflows can do, nothing more.** No integration
    management tool, no credential through MCP; `system.capabilities` reports
    connected integrations and the blocks they unlock, computed by the same
    resolver as the editor. Reason: a token pasted into a chat lands in the
    model's context and its provider's logs.
16. **Gates.** Nothing outside the generated registries imports an
    integration; an integration imports only `@integrations/sdk`,
    `@shared/contracts` and its own dependencies; integrations never import
    each other; conformance runs over every package under zod 3 and the
    production `zod4`; core naming a provider is a gate with a reasoned
    allowlist. The SDK re-exports `z`. Reason: the boundaries must hold
    without a reviewer noticing, and an integration picking its own zod would
    reopen the zod 4 incident.
17. **No backward compatibility for development data.** Removed blocks are
    deleted, not aliased, and the definitions using them are re-authored;
    runs in flight follow the drain rule. Reason: nobody depends on them, and
    aliases would keep provider names in core forever.
18. **Integration screens look like the product**: a `dashboard` entry may
    import a host UI package the gate allows, and Tailwind scans
    `integrations/*/dashboard`. Reason: Tailwind v4 does not scan workspace
    packages, and a page reaching for `@/components/ui` would couple the
    integration to the dashboard's internals.
19. **The repository provider is validated against the registry**, replacing
    the `github`/`gitlab` CHECK constraints in S10. Reason: a third VCS
    integration written from the guide would otherwise pass conformance and
    fail on import.
20. **Fixtures stay out of production**: the test integration lives in
    `integrations/_fixtures/*` and is generated only under a build flag that
    CI and the demo set. Reason: a fixture must never appear to production or
    the Arthur tenant.
21. **Memory is the capability core can serve itself.** The built-in store is
    a core module registered as the provider of `memory` (decision 10), and a
    deployment that has connected no memory integration gets it. Connecting
    one REPLACES the provider rather than supplying the first one, so a
    deployment that never opens the Integrations page keeps exactly the memory
    it has, and `builtin` is never something an admin has to connect. Two
    connected engines with none chosen is the refusal every other `one`
    capability answers; settings that could not be read is a refusal too, and
    deliberately NOT a fall back to the built-in store, which would split a
    deployment's memory across two stores with nobody told, and would buy
    nothing because the integration settings and the built-in store are rows in
    the same database. Reason: memory is the one capability whose absence is
    not a legitimate state, because this product has always had it.
22. **A run that cannot reach memory says so on the run.** Decision 12 makes
    memory the one capability a run continues without. That is only defensible
    while somebody can find out afterwards, so the run records a
    `memory_unavailable` observation naming the moment (the workspace it
    started in, the facts it could not seed, the prompt it went in with) and
    the provider's own reason. Reason: a run that started without the notebook
    an earlier run left was indistinguishable from the first run on a subject,
    and a best-effort catch that nobody can see is how an outage lasts weeks.

### What S0 decided inside that frame

These were open to the S0 executor. Each is a two-way door until an
integration package depends on it.

- **Layout of the SDK.** Flat, like `packages/harness`: `capabilities.ts`,
  `manifest.ts`, `context.ts`, `runtime.ts`, `errors.ts`, `conformance.ts`,
  the three port files, and a fixture integration (`fixture-manifest.ts`,
  `fixture-runtime.ts`) that the package typecheck compiles. The fixture is
  not exported; it is the type-level evidence.
- **Inference.** `defineIntegration` takes a `const` type parameter, so ids,
  field keys, block types and capability ids stay literals.
  `defineIntegrationRuntime(manifest, {...})` then requires exactly one
  executor per declared block, one adapter factory per declared capability
  and one probe per declared health check, and types each executor's params
  (the zod output), inputs, context and output from its block.
- **Declare to receive.** A block's `requires` (capabilities, `llm`) is both
  what the editor checks for availability and what the executor's context
  contains. A capability or `llm` a block did not declare is absent from its
  context type, so a block cannot use something the editor did not check.
  `run`, `llm` and `capabilities` exist only in the block context. Everything
  else (a capability adapter, a connection test, a health probe) receives the
  same `IntegrationContext`: the connection, `http`, `log` and a `signal`. The
  adapter gets the signal too, so a capability called from a webhook route
  cannot outlive the route's own deadline.
- **Widening a name is refused at the manifest.** Every later check rests on
  literal types, so a manifest that annotated a block `: IntegrationBlockManifest`
  or built its fields elsewhere would silently switch them off: `blocks: {}`
  and a misspelled `ctx.connection` key would both compile.
  `defineIntegration` and `defineIntegrationBlock` refuse a widened id, block
  type or field key, and the refusal carries the sentence that says what to do.
- **A block's required output fields are typed from its manifest**, through
  the same small value-schema mapping the inputs use, so a block that promises
  downstream bindings a field cannot omit it or give it another type. The
  optional properties stay under the catalog's JSON shape; typing them too
  would fight the `BlockOutput` index signature for no failure anybody has met.
- **Reserved slots are `never`.** A reserved capability id is not a member of
  the providable union, so declaring it or passing an adapter for it does not
  compile, and conformance refuses it with the stage that designs it. The
  runtime's `webhook` (S9) and `api` (S8, the handlers an integration's pages
  read) are optional properties typed `never`. The React side of pages is
  S7's; the manifest declares a page's id and label now so the card and the
  sidebar can say what connecting unlocks.
- **Webhooks are reserved, not defined.** The trigger cluster has a
  normalized event only for pull requests (`TriggerEvent` in
  `packages/contracts/trigger-events.ts:37`, closed to `github | gitlab`);
  ticket moves and slash commands have none, and Slack's handler depends on
  acknowledging within the request (`waitUntil`,
  `apps/worker/src/services/slack/handle-slash-command.ts:165`). A contract
  cut from pull request events alone would be cut to fit VCS, so S9 designs
  it and starts from `TriggerEvent`.
- **HTTP is `fetch`.** `ctx.http.fetch` has the standard signature (proved by
  a type assertion in the fixture), so it can be handed to a provider SDK that
  takes a custom fetch (Octokit does). Defaults are exported constants,
  `INTEGRATION_HTTP_DEFAULTS`, so the contract and core's implementation read
  one number: 30 s per attempt, 2 retries, and only for a read (GET, HEAD,
  OPTIONS), with `Retry-After` honoured up to 30 s. A PUT or a DELETE is a
  write at these providers (a GitLab merge or rebase, a GitHub file commit),
  and repeating one after an ambiguous 5xx reports a conflict for work that
  landed, so nothing else is retried unless the caller asks. A non-2xx
  response is returned, not thrown.
- **The logger keeps pino's argument order** (fields, then event). Reason:
  every provider module being moved logs that way, so the moves in S8 to S12
  stay mechanical, and core can back it with a pino child logger.
- **`llm.generateObject` takes a zod schema** and resolves with the parsed
  output. Core chooses the model (the run's default) and records usage
  against the block. Core can convert either zod major to JSON schema (the AI
  SDK's `zodSchema` handles both). There is no model parameter: model choice
  belongs to the harness and model catalog.
- **"Do not retry" is `FatalError` from the SDK**, whose `name` is
  `FatalError`. The DevKit decides fatality with `FatalError.is`, which checks
  the name only (`@workflow/errors` 4.2.1, called from the step handler of
  `@workflow/core` 4.8.0), so the SDK's error stops retries wherever it is
  thrown with no translation, and the port's error contract is what the
  GitHub and GitLab adapters already throw. The pin is
  `apps/worker/src/adapters/vcs/types.test.ts`: a DevKit upgrade that changes
  the check turns it red. A block's returned `failed` outcome is an expected
  failure with a message for people.
- **Core never re-runs a block executor that has started.** The DevKit retries
  a step three times by default and the limit is a property of the step
  function, so one generic step would impose one policy on every integration
  block, and a block that posted a comment and then threw would post it twice.
  S4's generic step therefore sets `maxRetries` to 0, the way core's own
  side-effecting steps already do
  (`apps/worker/src/engine/blocks/prepare-workspace/execute.ts:297,322`).
  Retrying a transient failure is the integration's own business, through
  `ctx.http`. There is no per-block retry flag: nobody has asked for one, and
  adding one later is additive.
- **Core rethrows run-control errors.** Integration code never recognises a
  cancelled run or an exhausted budget. The generic step records a
  run-control error when it raises one through the context and raises it
  again after the executor settles, so an executor that catches everything
  cannot turn a cancellation into a success or an ordinary failure. This is a
  requirement on S4's generic step. `ctx.signal` aborts on cancellation, on
  budget and near the invocation ceiling; `http` and `llm` are bound to it.
- **An integration whose fields are all optional must not read Connected by
  itself.** A manifest may declare only optional fields, and a complete
  environment would then be vacuously complete on every deployment, so a card
  would say "Connected (environment)" although nobody connected anything. The
  rule for S2: the environment is the source only when at least one declared
  variable is actually set; otherwise the integration is Not connected.
- **Connection fields.** Every field names its environment variable, states
  `secret` (no default), and may be `optional`, have a `default` (never a
  secret) and a `format` (`text`, `multiline`, `url`, `integer`). `integer`
  reaches the integration as a number, which keeps today's validation of
  `GITHUB_APP_ID` (`apps/worker/src/infra/runtime-env.ts:34`); `default`
  keeps `GITLAB_HOST` defaulting to `https://gitlab.com` (`:44`) and the Slack
  bot name (`:50`). There are no environment aliases:
  `VCS_BOT_LOGIN` is exposed to each VCS connection but applies only when one
  provider is configured. S10 resolves that count at capability use and strips
  the fallback in a mixed-provider deployment.
- **Identity rules.** An id is 3 to 32 lowercase letters and digits, starting
  with a letter, and not a word core already uses (`RESERVED_INTEGRATION_IDS`:
  capability ids, the core routes `/webhooks/custom` and `/webhooks/resend`,
  core screens and concepts). No underscore, so a block type
  `<id>_<snake_case>` names its integration unambiguously. A page id is a
  slug and never `connection`, the core tab.
- **The two review ledger limits moved with the VCS port**
  (`REVIEW_LEDGER_MAX_WORK_ITEMS`, `REVIEW_LEDGER_MAX_CONTEXT_THREADS`),
  because an adapter applies them when it builds the feed
  (`apps/worker/src/adapters/vcs/github.ts:1283`, `gitlab.ts:341`).
- **What stayed in the worker's VCS file:** the optional provider extensions
  (gate status, rich gate status, pull request files, reviews, manual
  dispatch snapshots), because `GateStatusRef` names GitHub and GitLab and
  generalizing it changes a signature; the review ledger's engine types; and
  the finding digest, which needs `node:crypto`. The worker files re-export
  every moved name with the same kind (type or value), checked with the
  compiler API against the files at the start commit.

### What S1 decided inside that frame

These were open to the S1 executor. Each is a two-way door.

- **The registries are a package, `integrations/registry`.** Core may import
  an integration only through it, and that is a rule the boundaries gate can
  state because the registry is its own tier. Two generated files, because
  they end up in different bundles: `manifests.generated.ts` behind the root
  entry is plain data, read by the dashboard in a browser and by the Workflow
  DevKit inside the flow bundle; `runtimes.generated.ts` behind
  `@integrations/registry/worker` carries provider SDKs and Node modules and
  is server only. A rule in `tiers.json` refuses an import that crosses
  between them, because that failure appears only in a Vercel build.
- **No dashboard registry yet.** The manifest and runtime shapes were frozen
  in S0; a dashboard entry has no type at all, and decision 18 leaves its host
  UI and its page shape to S7. Generating one now would either invent a
  contract S0 did not freeze or ship a `Record<string, unknown>` S7 would have
  to break. The manifest registry already carries each page's id and label,
  which is what a card and a sidebar read; only the React module needs a third
  registry, and it arrives with the types that describe it.
- **The manifest registry is an array in id order, and the worker registry a
  lookup by id.** The array is the honest generated artifact: its order is
  stable and its diff is reviewable. The indexes by id, by block type and by
  capability are hand-written derivations in `index.ts` and `worker.ts`, where
  they can be documented, and none of them names an id.
- **Entries are imported by relative path, as the block catalog imports block
  manifests.** `gen:integrations` stays a pure file write, with no dependency
  to add to the registry's `package.json` and no lockfile change, so adding an
  integration is a folder and one command.
- **The fixture flag is `INTEGRATION_FIXTURES`, read at generation time.** The
  committed registry is the one generated without it, so a production build
  carries no import of `integrations/_fixtures` at all; CI and demo regenerate
  with it. A runtime branch would bundle the fixture as dead code, and a
  package export condition would ask Nitro, Next and the DevKit bundler to
  agree on a custom resolve condition. `gen:integrations --check` runs in CI
  without the flag, so a fixture that reached the committed registry fails
  there.
- **A directory under `integrations/` without a manifest is refused, not
  skipped**, apart from `sdk` and `registry`, which the generator names. A
  half-written integration that quietly disappears from the registry is the
  failure this stage exists to prevent. A directory whose name starts with `_`
  is never registered: that is how `_template` stays out of every build, and
  `_fixtures/*` waits for its flag.
- **The generator reads manifests with the TypeScript parser rather than
  importing them**, so a build step never executes integration code, and it
  walks the whole reachable graph of a manifest: a manifest may import
  `@integrations/sdk` and files inside its own package, and each of those obeys
  the same rule. A Node module hidden one file away would fail only the Vercel
  build.
- **The core-reference gate is its own script**, `scripts/gates/core-references.mjs`,
  with `scripts/gates/core-references.json` beside it. Core is
  `apps/worker/src`, the dashboard's `app`, `components` and `lib`, and
  `packages`; `scripts/` is release and gate tooling, where the Arthur tenant
  repository is not the Arthur provider, and `changelog/` and `docs/` are
  prose. A mention is a case-insensitive substring of the id in the path or in
  the source with comments stripped: `"github"`, `GITHUB_TOKEN` and
  `githubClient` are one coupling written three ways, and a boundary rule that
  caught those while sparing `githubusercontent` is a rule nobody could
  predict. Comments are prose, so they do not count. Test files are not
  scanned: a test cannot create production coupling, it exercises core code
  that still names a provider, and it changes with its subject in S8 to S12;
  listing several hundred of them would churn on every test edit and get the
  gate switched off. A row may carry `incidental: true` when its files spell an
  id by accident, such as a CSS keyword or a URL; the gate keeps it listed and
  never reports it as stale, because such a hit comes and goes with ordinary
  edits and a failure on one could not be acted on.
- **Allowlist rows carry no counts, and a stale row fails.** The gate's job is
  to stop a new file, a new package or a new area of core learning a provider,
  and to make S8 to S12 shrink the list. A count per file would turn every
  unrelated edit inside a file those stages delete anyway into a failure whose
  fix is a meaningless number. The ratchet is the other way: a row whose file
  stopped naming its provider fails until `--prune` removes it. Nothing adds a
  row but a person with a reason, because a mode that adds rows is a mode that
  switches the gate off.
- **The watched ids are the registry's, asked of the generator through
  `--print-ids`, plus a `plannedIntegrations` table** naming the stage that
  takes each name away. An id in both fails, so the stage that lands an
  integration has to delete its planned entry and its rows.
- **Conformance runs from the registry package**, discovering packages rather
  than listing them, so the template, the fixtures and every integration a
  later stage adds are covered the day they land, whatever the fixture flag
  says. It runs under zod 3 and under the `zod4` alias; the second pass earns
  its place, a one-argument `z.record` in a block's params schema passes the
  first and fails the second.

### The conformance check

`checkIntegrationConformance(manifest, runtime)` returns every issue with a
code, a path and a sentence. It refuses: a manifest that does not parse; an
invalid or reserved id; a block type that is not `<id>_<snake_case>`;
duplicate block types, field keys, environment variables, health check ids or
page ids; a block without a zod params schema; a one-argument `z.record`
anywhere in a params schema (visible only under zod 4, which is why the suite
also runs there); a declared block without an executor; no connection test; no
health check, or one without a probe; an environment variable name that is not
`UPPER_SNAKE_CASE` or is one core reads for itself
(`RESERVED_ENVIRONMENT_VARIABLES`, which is why a field on `DATABASE_URL`
cannot read Connected from core's own database credentials; S1 asserts the
list stays equal to the core-owned names in
`apps/worker/src/infra/runtime-env.ts`, and the provider variables that move
out in S8 to S12 are deliberately absent from it); a field whose key or
variable names a credential (token, secret, password, passphrase, credential,
DSN, private key, API key, signing key, connection string) without
`secret: true`; a secret with a default; a default that fails its
format; an unknown or reserved capability, declared or required; a declared
capability without an adapter; an implementation for something the manifest
does not declare; and a reserved runtime slot that is filled.

## Consequences

- An integration author reads `integrations/sdk` alone: `index.ts` says what
  the three entries are, the types say what to write, and a mistake is a type
  error or a conformance issue that names the rule.
- Core behaviour did not change in S0: the ports moved, and
  `apps/worker/src/adapters/{issue-tracker,vcs,messaging}/types.ts` re-export
  every name.
- `verify:changed` plans a change under `integrations/` as its own scope: the
  root typecheck, the package suites under zod 3 and zod 4, the worker's seam
  tests, `gen:integrations --check` and the gates.
- Harder: every later change to the SDK is additive and recorded below; a
  reserved slot is filled only by the stage named for it.
- Everything S0 left to S1 is done: the lint, package-contracts and knip
  scopes now cover `integrations/`; the generator refuses an integration block
  type a core block already owns; the boundaries gate labels a package tier
  with the root it came from; `packages/AGENTS.md` names both roots;
  `integrations/registry/reserved-env.test.ts` holds
  `RESERVED_ENVIRONMENT_VARIABLES` equal to what the worker declares for
  itself.

### Debt the moved ports carry

The ports moved without signature changes, so provider-specific leftovers
moved with them. Each is removed by the stage that moves its provider. The last
two rows are of another kind: changes S8 made to the contract that are not
additive for everyone who compiles against it, recorded here so the change log
does not have to call them additive.

| Leftover | Where | Owner |
|---|---|---|
| ~~`searchTicketSummaries(jql, ...)` takes a JQL string; `searchTickets(query)` is JQL in practice~~ Resolved in S12: the two became `ticketsInStatus(status, {limit})` and `findTickets({keywords, limit, providerQuery})`, and no caller composes a provider query any more | `issue-tracker.ts` | done, S12 |
| `IssueTrackerTransitionTarget.transitionId` is named after a Jira transition action, though what it means is "the provider's own id for this move". S12 did not rename it: the three ids are connection VALUES on every deployment that has one, so the rename is a migration over saved connections rather than a rename, and it buys a word | `issue-tracker.ts` | when a second tracker needs a different word |
| `downloadAttachment` returns a Node `Buffer`, a Node type in a browser-safe package. S12 did not change it: `Uint8Array` would ripple through the attachment pipeline into the sandbox writer, which is a change to how files reach an agent and does not belong in the stage that moved Jira | `issue-tracker.ts` | AIW-14 (Linear), the first tracker that is not Jira |
| Comments still give examples from the two current providers (`PRRT_` node ids and discussions) | `vcs.ts` | S11 |
| `MessagingSender.notifyForTicket` takes a ticket key and `TicketEvent` has a `note` kind: both are shaped by a run having one subject. A future caller that is not a run would need a subject of its own. Nothing asks for it yet | `messaging.ts` | when something asks |
| `GITHUB_APP_PRIVATE_KEY` is base64 in the environment (`adapters/vcs/github-auth.ts:20-21`) while `multiline` invites a raw PEM in the dashboard, and the integration cannot tell the two apart. Proposal: a `pem` format core normalises, so both forms reach the integration the same way | `manifest.ts` | S11 |
| `IntegrationRunIdentity` gained two required fields in S8 (`subjectKey`, `state`). Additive for an integration, which only reads it; anything that builds one (core, a test double, a host other than ours) stops compiling until it supplies both. Proposal: the next field on it is optional, or this record says why not | `context.ts` | recorded in S8 |
| `IntegrationRuntimeDefinition` and `IntegrationRuntime` went from interfaces to type aliases over a conditional type in S8, so that `beginRun` is required exactly when `runState` is declared. An interface can no longer `extends` either for a generic manifest, and a class cannot `implements` one; nothing in this repository did, a provider package outside it that did would stop compiling. Proposal: keep the aliases (the drift they prevent is the costlier mistake) and revisit if a provider needs to extend one | `runtime.ts` | recorded in S8 |

## Options considered

**Mirror the worker's internals in the context** (hand integrations the
logger, the `env` object, the settings readers). It would have made the moves
in S8 to S12 a find-and-replace, and it would have made every future worker
refactor a breaking change to every integration, including those in
customers' forks.

**Typed capability access through a registry lookup** (`ctx.capabilities.get("messaging")`)
instead of declaring requirements. Smaller types, but a block could use a
capability the editor never checked, which is the "fails at run time instead
of in the palette" failure decision 13 exists to prevent.

**Define the webhook contract now from `TriggerEvent`.** It is the only
normalized event that exists, and it covers pull requests only; a contract
cut from it would be cut to fit VCS, and S9 would rewrite it.

**Accept `unknown` for reserved slots.** It would compile any object, so a
premature memory adapter would appear to work until S13 designs the port
differently.

## Appendix A: inventory of what the providers use from the worker

A read-only sweep of `main` at `31d8643d` (sweep agents, spot-checked by the
executor). Every item maps to a context member, to an integration's own
dependency, or to a stated reason it stays in core. "Own" means the
integration package declares the dependency itself; an integration's
`worker` entry may use Node and provider SDKs.

### Jira

| Uses today | file:line | Maps to |
|---|---|---|
| Global `fetch` with `AbortSignal.timeout` | `adapters/issue-tracker/jira.ts:100,122,446,457,515` | `ctx.http.fetch` (timeout, retry) and `ctx.signal` |
| Only its port types; no other worker import | `jira.ts:1-10` | the SDK's `issue-tracker.ts` |
| `JIRA_BASE_URL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` passed to the adapter | `engine/support/adapters.ts:83-87` | connection fields (`url`, `secret`, text) |
| `JIRA_WEBHOOK_SECRET` | `services/settings/integration-settings.ts:52` | secret connection field, read by the webhook handler (S9 slot, S12) |
| `JIRA_BACKLOG_TRANSITION_ID` and the board columns | `integration-settings.ts:31-37` | stays in core as `issue_tracker` capability settings (decision 9, S12) |
| HMAC signature check with `node:crypto` | `services/triggers/jira/handle-jira-webhook.ts:1,633-638` | the integration's own webhook handler (S9 slot); Node is allowed in `worker` |
| Dispatch, run lifecycle, clarification resume, run registry reads | `handle-jira-webhook.ts:4-24` | stays in core: a handler returns normalized events and core dispatches (decision 8) |
| Logger | `handle-jira-webhook.ts:8` | `ctx.log` |
| Health: base URL, token, project, webhook secret | `services/system/probes.ts:69-72` | declared health checks with probes |
| Jira research: JQL search scoped to `JIRA_PROJECT_KEY` | `engine/blocks/investigate/execute.ts:423-433` | a block requiring `issue_tracker` or a Jira block (S12), `ctx.connection` |

### Slack

| Uses today | file:line | Maps to |
|---|---|---|
| `chat`, `@chat-adapter/slack` | `adapters/messaging/chatsdk.ts:1-3` | own dependencies |
| Logger | `chatsdk.ts:4` | `ctx.log` |
| `ThreadStore`, the per-ticket parent message id in the database | `chatsdk.ts:7`, `engine/support/adapters.ts:79` | stays in core for now; an integration gets no database. S9 adds it additively, either as core-owned storage handed to the `messaging` factory or as a per-integration key-value store in the context |
| `JIRA_BASE_URL`, to link a ticket from a Slack message | `engine/support/adapters.ts:78` | stays in core; a cross-integration value. S9 passes a ticket link resolved through `issue_tracker` or adds one to `TicketEvent` (a port change S9 owns) |
| `CHAT_SDK_SLACK_TOKEN`, `CHAT_SDK_BOT_NAME` (default `ai-workflow`) | `adapters.ts:73-77`, `infra/runtime-env.ts:48-50` | the token became a connection field (`secret`, `identity`). The name did not: S9 retired it, because Slack only lets an app post under another name with a permission ordinary installs do not grant, and sending it without that permission can stop the message arriving. The app's own name is the author now |
| `CHAT_SDK_CHANNEL_ID` | `adapters.ts:76` | a connection field until S9; decision 9 classes a channel choice as operator behaviour, so S9 moves it to stored settings, which then needs a settings read in the context (additive) or a channel parameter on the port |
| Global `fetch` for search | `adapters/messaging/slack-search.ts:220` | `ctx.http.fetch` |
| `SLACK_SIGNING_SECRET`; HMAC check with `node:crypto` | `integration-settings.ts:87`, `services/slack/verify.ts:1,31-39` | secret connection field; own webhook handler (S9 slot) |
| `SLACK_ALLOWED_USER_IDS` | `integration-settings.ts:95-97` | stays in core as a stored setting: who may use a slash command is operator behaviour (S9) |
| `waitUntil` to answer within Slack's deadline | `services/slack/handle-slash-command.ts:10,165` | stays in core: the generic route owns the request lifecycle (S9) |
| Run cancel, dispatch, settings snapshot | `handle-slash-command.ts:12-35` | stays in core (decision 8) |
| Synthesis with `generateStructured` and `resolveCallLlmTarget` | `investigate/execute.ts:8,298,477,532` | `ctx.llm.generateObject` (block requires `llm`) |
| Health: token, channel, signing secret, allowed users | `services/system/probes.ts:103-106` | declared health checks |

### GitHub

| Uses today | file:line | Maps to |
|---|---|---|
| `FatalError` from `workflow` | `adapters/vcs/github.ts:1,504` | the SDK's `FatalError` |
| Logger | `github.ts:4` | `ctx.log` |
| `@octokit/rest`, `@octokit/auth-app` | `adapters/vcs/github-auth.ts:1-2` | own dependencies; Octokit's `request.fetch` takes `ctx.http.fetch` |
| Review ledger markers and bot identity helpers | `github.ts:38-50`, `adapters/vcs/vcs-bot-identity.ts` | stays in core until S11; the marker family core reads is part of the `vcs` contract, so S10/S11 move the pure helpers into the SDK additively |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` (integers), `GITHUB_APP_PRIVATE_KEY` (base64 PEM) | `infra/runtime-env.ts:34-36`, `infra/vcs-config.ts:32-46` | connection fields (`integer`; `secret`) |
| `GITHUB_OWNER`, `GITHUB_REPO` (legacy default repository) | `vcs-config.ts:49-51` | S11 decides: a legacy default repository is configuration, not a credential |
| `GITHUB_BOT_LOGIN`, falling back to `VCS_BOT_LOGIN` in a single-provider deployment | `vcs-config.ts:68-77`, `vcs-bot-identity.ts:11-23` | optional connection field; the fallback stays in core (no aliases, see above) |
| `GITHUB_WEBHOOK_SECRET` | `integration-settings.ts:56-64` | secret connection field |
| Webhook to a normalized `TriggerEvent` | `services/triggers/github/handle-github-webhook.ts` | the `webhook` slot (S9 designs, S11 moves) |
| Repository listing and profile source | `adapters/vcs/repository-directory.ts:2`, `github/profile-source.ts:14` | S10/S11 add them to the `vcs` capability additively |
| Skills loaded from GitHub for harness profiles | `harness-profiles/github-skills.ts` | stays in core: the harness profile owns skills (ADR-006); S11 decides whether a `vcs` method provides the archive |
| Health: App installation and webhook secret | `services/system/probes.ts:73-76,156` | declared health check |

### GitLab

| Uses today | file:line | Maps to |
|---|---|---|
| `FatalError` from `workflow` | `adapters/vcs/gitlab.ts:3,266,369,544,548,737` | the SDK's `FatalError` (the `instanceof` at `:548` becomes a check on the SDK's class) |
| `node:crypto`, `@gitbeaker/rest` | `gitlab.ts:1-2` | own dependencies (Node is allowed in `worker`) |
| `clampBothEnds` from `@shared/workflow-graph` | `gitlab.ts:34` | not importable by an integration (decision 16); S10 copies it or moves it to `@shared/contracts` |
| Logger | `gitlab.ts:35` | `ctx.log` |
| `GITLAB_TOKEN`, `GITLAB_HOST` (default `https://gitlab.com`) | `runtime-env.ts:41-44`, `vcs-config.ts:55-60` | connection fields (`secret`; `url` with `default`) |
| `GITLAB_PROJECT_ID` (legacy default repository) | `integrations/gitlab/manifest.ts` | Kept as `legacyProjectId`; retire after R1 confirms catalog activation on every deployment and a separate compatibility removal is approved |
| `GITLAB_BOT_LOGIN` with the `VCS_BOT_LOGIN` fallback | `integrations/gitlab/manifest.ts` | Provider field plus single-provider fallback; retire `VCS_BOT_LOGIN` in S11 after both VCS integrations own bot identity |
| `GITLAB_WEBHOOK_SECRET` | `integration-settings.ts:78-81` | secret connection field |
| Profile source | `adapters/vcs/gitlab/profile-source.ts:21-33` | S10, additively |

### Arthur

| Uses today | file:line | Maps to |
|---|---|---|
| Global `fetch` in the client | `sandbox/arthur-client.ts:86` | `ctx.http.fetch` |
| `GENAI_ENGINE_API_KEY`, `GENAI_ENGINE_TRACE_ENDPOINT` | `runtime-env.ts:82-83`, `arthur-injection-check/execute.ts:17-18` | connection fields (`secret`; `url`) |
| Logger | `arthur-injection-check/execute.ts:34` | `ctx.log` |
| `isRunControlError` to rethrow cancellation | `arthur-injection-check/execute.ts:2,33,144` | not needed: core rethrows run-control errors after the executor settles |
| `detectBlatantInjection`, the local prefilter | `arthur-injection-check/execute.ts:3,80` | S8 decides: copy into the integration, or keep a core prefilter that runs regardless of provider |
| Reads the run's ticket (description and comments) when no content is bound | `arthur-injection-check/execute.ts:67-72` | an input binding from the run's ticket snapshot, not a live port read, so the check scans exactly what the agent receives (S8) |
| The run's Arthur task id, created once and shared across steps | `prepare-workspace/execute.ts:326-333` (`ctx.arthur.taskId`), `agent-sandbox.ts:290` | S8, as part of `agent_tracing`'s per-run setup. It cannot be re-derived: `ensureTaskForTicket` creates `<identifier>.<n+1>` once any task for the ticket exists (`sandbox/arthur-client.ts:152-163`), which is why the run caches the id. So S8 designs per-run integration state that the workflow carries, serializable and additive to this contract |
| Tracer files, environment, `pip install` and hooks in the sandbox | `sandbox/agents/claude.ts:510-558`, `codex.ts:95-101`, `sandbox/arthur-tracer.ts` | `agent_tracing`, designed in S8 |
| Evals collection and route, `evaluationTraceSettings` | `services/overview/collect-eval-summary.ts:11,24`, `routes/api/v1/evals.get.ts` | the `api` slot (S8) and a page |
| Health probe of the API | `services/system/probes.ts:107-108,249-256` | a declared health check |

### What the inventory proves

No provider needs a database handle, the process environment or a worker
module that the context does not replace. What remains in core is dispatch
and run lifecycle (decision 8), operator settings (decision 9), request
lifecycle of webhooks (S9), per-run state tied to tracing (S8), and one
cross-integration value (the tracker's ticket link in Slack messages, S9).
Two needs are real and not yet in the context, each named with its stage:
durable per-ticket thread state for messaging (S9) and reading an
integration's stored settings (S9, when the Slack channel moves).

## Connection state, decided in S2

The one description S3, S4, S5 and S6 read instead of the code. Delivered in
stage S2 (AIW-407) as `apps/worker/src/services/integrations/`, the tables
`integration_connections` and `integration_connection_versions`, and the routes
under `/api/v1/integrations`.

### One resolver

`resolveIntegrationState(manifest, environment, stored, secretsKey)` in
`services/integrations/resolve.ts` is the only place a status is decided. It is
pure, so it holds no cache: disabling an integration is the kill switch an admin
reaches for when a bot misbehaves, and on Vercel the next request lands on a warm
invocation, where a module-level cache would keep the bot running until the
instance recycled. A second derivation anywhere is how the palette and the run
come to disagree about the same deployment, so there is not one.

Its output carries no secret and no ciphertext. That is a property of the type:
`IntegrationState` has no field one could be put in.

### The vocabulary

| Name | Values | Means |
|---|---|---|
| `source` | `environment`, `stored` | Where the values come from. Never both. With no row, `environment`. |
| `connection` | `connected`, `not_connected`, `failing` | What the connection is, before the enable flag. |
| `status` | the above plus `disabled` | What a card, the health page and the palette show. `disabled` wins, because an admin chose it and it explains the most. |
| `usable` | boolean | `enabled && connection === "connected"`. The one question the engine asks. |
| `verification` | `never_tested`, `stale`, `passed`, `failed` | What the last connection test proved, and whether it still applies. |
| `failure.reason` | nine values, see `packages/contracts/api.ts` | Split as finely as the admin's ACTION differs. |

Three rules decide `connected`:

- **Complete is not verified.** Stored values become the active version only when
  their test passed, so a stored connection that is `connected` always has a
  passing verdict behind it; the resolver states that as its own condition rather
  than trusting the write path.
- **Never tested is still connected, for the environment.** That is every
  deployment on the day this lands. Telling them they are disconnected would be
  false, and inventing a verification time would be worse, so `verification` is
  `never_tested` and carries no time at all. S5 and S6 render that; they do not
  build a sentence about it at the edge.

- **A provider that could not be REACHED does not demote anything.** A refusal is
  about the credential; a timeout, an aborted request or a transport failure is
  about the network, and with no "save it anyway" to climb back out with, a
  thirty second outage while an admin happens to press Test would otherwise
  record a failure that stops every run until a human pressed Test again.
  `credential_rejected` demotes to `failing`; `provider_unreachable` leaves the
  connection as it was, and `verification` still carries what happened and when,
  so nobody reads it as a check that passed.

  The boundary: core reads a thrown error from `testConnection` as unreachable
  and a returned `{ ok: false }` as a refusal, because a returned refusal means
  the provider answered about the credential. `ctx.http` returns a non-2xx rather
  than throwing, so **an integration that gets a 5xx decides**: it should throw
  (or rethrow) so core reads it as unreachable, and return `{ ok: false }` only
  when the provider has actually said something about the credential. This is
  written here rather than in the SDK because S2 may not change the S0 contract;
  a later stage that finds the distinction worth typing should add it to
  `ConnectionTestResult` and record it in the change log.

A partial environment is `failing` with the missing variable NAMES, never a
silent fall back to stored values: that would make a typo and a deliberate switch
look the same.

### Two counters, two questions

`latest_version` is the concurrency token a save carries as `expectedVersion`,
and it moves even when a save fails its test. `active_version` is the version
actually in use when `stored` is the source, and it moves only on a pass. A save
is therefore always minted and only sometimes activated, which is what lets an
admin close the tab mid-test, come back to the answer, and find the previous
working connection still running.

A save builds on the LAST version, not the active one. An admin who pastes a new
token together with a wrong URL, fails, then corrects the URL and leaves the
secret field blank must keep the new token; carrying the active version's secret
forward there would quietly restore the old one, pass the test, and report
Connected until the old token was revoked.

**There is no "save it anyway".** An override that activated a version whose test
failed would make the connection read Failing at once and stop every run, so the
escape hatch for a provider outage would take a working deployment down. If a
real deployment is ever blocked by a broken probe, the override to add is one
that stays usable, and its shape is decided then rather than guessed now.

**The first connection is one action.** A save whose test passed also becomes
the source when the environment is not a usable source for that integration, and
it does so **inside the same statement**: a second write would leave an
invocation killed between the two with stored values active, the source on
`environment`, and a card reading "Not connected" after a green test.

The condition is "can the environment serve this integration", not "did anyone
set a variable". A manifest whose fields are all optional, and one with no fields
at all, has a complete environment nobody set, and taking that over would move a
working deployment onto stored values it never asked for. An environment that is
half set, or whose variable names an upgrade renamed, cannot serve, and leaving
the connection on it would answer a green test with Failing and ask for a second
click to fix what was already fixed. The incomplete environment stays on the
card either way, so a typo is still visible.

### The pin: a fingerprint, not a number

A run pins `{ integrationId, configFingerprint }` and re-checks it at every use
through `checkIntegrationPin`.

The fingerprint is twelve hex characters over the connection's **non-secret**
values. Consequences, each deliberate:

| Change | Verdict | Why |
|---|---|---|
| A rotated token | followed | The plan's decision 11: rotation has to work mid-run. |
| A secret the manifest marks `identity` | `reconfigured` | See "An account named only by a secret" below. |
| A different site, engine or account | `reconfigured` | Mixing the old site with the new token is unexplainable. |
| A secret and a non-secret together | `reconfigured` | The non-secret half moved. |
| Re-saving byte-identical values | followed | A version whose configuration is unchanged is not a reconfiguration, whatever its number. This is why it is a fingerprint and not a counter. |
| Switching source, values identical | followed | The source is a route to values, not a value. Failing a run over it would be noise. |
| Enabling or disabling | not a reconfiguration | Read live and reported as `disabled`, which is the more useful answer. |
| An environment value changed by a redeploy | `reconfigured` | A row-based counter could not see this at all. |
| A manifest gaining a field this deployment leaves empty | followed | Only fields carrying a value are fingerprinted. Otherwise S8 to S12, which each rewrite a manifest, would stop every run in flight for a connection nobody touched. |

**A change to a manifest's connection fields is a drain event**, the same way a
moved `"use step"` file is (decision 5). Renaming a field key, changing its
`env`, changing a default or turning `identity` on or off moves the fingerprint
for every deployment that sets that field, and every run in flight through the
integration stops with `reconfigured`. Adding or removing a field nobody has set
does not.

**The check is a committed artefact**, because otherwise the rule is a paragraph
nobody reads at the moment it applies: renaming a field key is a one-line edit
inside an integration package, and nothing in a diff says a run will die of it.
`apps/worker/src/services/integrations/connection-shape.snapshot.json` holds
every shipped integration's connection shape (key, env, secret, identity,
optional, default, format), and
`connection-shape.test.ts` fails when it moves. So the edit and its consequence
arrive in one review.

**Who demands the drain line:** the stages that change a manifest, which from
here is S8 to S12 and S15. A moved snapshot in the diff is what obliges that
stage to add the drain to its definition of done, naming the integrations whose
shape moved, exactly as the `"use step"` guard tests do for a moved step. It is
a review obligation rather than a gate, because a gate cannot tell a first
manifest, where every field is new and no deployment has values, from a rename
on a live one.

`checkIntegrationPin` answers in this order: a pin for another integration
(a caller bug, answered rather than silently resolved against the wrong
integration), then `disabled`, then `disconnected`, then `reconfigured`.
Disconnecting also moves the fingerprint, so checking `reconfigured` first would
send an admin looking for an edit nobody made. The three run-facing reasons are
the plan's and stay three; the check also returns the resolver's own `failure`,
so a run view can say which of "a variable is missing", "the provider refused
the credential" and "the stored secret cannot be read" it is.

### An account named only by a secret

Some providers identify the account by the credential alone: a Slack bot token
names a workspace as much as it authenticates. An integration whose fields are
all secret would have a constant configuration fingerprint, so swapping the
token for another workspace's would read as a rotation and a run in flight would
post into the wrong company's channels.

`ConnectionField.identity` (additive to the S0 contract, see the change log)
marks a secret that names the account. Its value enters the configuration
fingerprint as a digest, never in the clear, so the swap stops the run with
`reconfigured`.

**The digest is of the plaintext, and it is stored.** It cannot be derived from
the ciphertext: AES-GCM uses a random initialisation vector, so the identical
token encrypts to different bytes on every save, and a fingerprint built from
those bytes would move whenever an admin re-pasted the same token or saved it
again while fixing a URL, stopping every run in flight for an account that never
changed. The save path is the only place the plaintext exists, so it writes one
marker per secret field into `integration_connection_versions.secret_digests`,
in the same statement as the ciphertext beside it. The resolver holds only the
key id, never decrypts, and compares markers. The environment source has the
plaintext in hand and computes the same marker through the same function, so
switching source with the same token moves no pin. A disconnect erases the
markers with the values: a digest of a credential must not outlive the
credential.

Chosen over storing the account identity a connection test reported, because a
manifest flag also works for the environment source, which may never have been
tested, and it needs no round trip to the provider to answer "is this the same
connection". The cost is that rotating a marked field also stops runs in flight;
an integration should prefer a non-secret field naming the account (a workspace
id, a site URL) and mark the secret only when the provider offers nothing else.

**Where the pin lives is S4's call.** It is a value, not a row, so the cheapest
home is the run's own workflow state, where replay restores it without a read.
S2 adds no column to any run table. (S10 added one; see "The pin became a column
too, and why S2's reasoning was incomplete".)

A second fingerprint, over every value including secrets, decides whether the
last test verdict still applies. The two questions differ: a rotated token is
exactly the change a run should follow and exactly the change that makes an old
refusal meaningless. It is stored, never returned, and hashes each secret with
its own slot as a salt.

### Secrets

AES-256-GCM under `INTEGRATION_SECRETS_KEY`, its own key and never the webhook
key, in `apps/worker/src/infra/secrets-crypto.ts`. Envelope:
`v1:<keyId>:<scope>:<iv>:<tag>:<ciphertext>`, where `scope` is
`<integration id>.<field key>` and is also the GCM additional authenticated data.

Unlike `webhook-crypto.ts`, which keeps its binding out of the envelope, the
scope is stored in the clear. Neither half is a secret, and having it readable is
what lets a read say "this row belongs to another integration" instead of "this
row is damaged". The four failures an admin can meet are four different
afternoons, so they are four reasons: `secrets_key_missing`,
`secrets_key_mismatch`, `secret_foreign` and `secret_corrupted`.

A secret left untouched on a save moves forward as bytes rather than being
re-encrypted, so correcting a URL never needs the key. Disconnecting empties
`config` and `secrets` on every past version in one statement and keeps who and
when.

Every message stored, returned or logged passes through `redactIntegrationText`
with this connection's own secrets, because providers echo credentials in error
bodies and that body is what an admin reads on the card.

### Writes, and where they are refused

Refused with **403** on any deployment whose environment differs from the
`env_marker` the database carries, and refused outright when the marker cannot be
read or the database cannot be reached. 403 rather than 409, because 409 on these
routes already means "your version is stale, reload", and this one never succeeds
from here. The refusal names both environments. The reason it is refused: an
unclaimed database has no answer to "who owns this", and defaulting to yes is
the wrong way to be wrong. The question is not "is this a preview": the demo
deployment is a preview pointed at production's branch
(`DATABASE_SHARED_WITH=production`), and a local worker with a production
`DATABASE_URL` is the same incident with fewer witnesses. Reads work everywhere.

Every write is one statement. Production runs neon-http, which cannot open an
interactive transaction, while the pglite driver used by tests can, so a
`db.transaction` would pass every test in this repository and 500 in production.

### Impact preview, completed in S9

The connection PUT accepts a read-only preview command before a disconnect or
a save. It reports enabled definitions by name from their deployed versions,
never drafts, and reaches an integration through `integrationsUsedBy`: both the
integration's own blocks and the active provider behind a capability used by a
core block. The run count comes from live run claims joined to those definition
ids. The candidate fingerprint is calculated in the worker, including identity
secret digests, so the browser receives neither a secret nor a second version
of the pin rule.

Definitions and run counts are nullable independently. Null means the read
failed and the confirmation says unknown; an empty list and zero are reserved
for reads that completed. The screen lists five names before "and N more" and
labels an action with unknown impact explicitly. A save whose candidate does
not move the fingerprint continues without another confirmation.

The active provider selection for a single-provider capability was assigned
here to S4 and moved to S6 during it: choosing between two providers is a
control on the Integrations page, and a stored selection with nothing to write
it is a refusal that sends an admin to a screen that does not exist. S4 refuses
the ambiguity by name and tells the admin to disable the provider they do not
want until the page can select one.

## What the engine decides, decided in S4

The one description S3, S5 and S6 read instead of the code. Delivered in stage
S4 (AIW-408) as `apps/worker/src/engine/definition/integration-availability.ts`,
`integration-block-contract.ts`, `integration-run.ts` and the generic step
`apps/worker/src/engine/steps/integration-block-step.ts`.

### Availability is one pure function over declared data

`deploymentIntegrations({ manifests, states, selected, builtinCapabilities })`
turns the registry and S2's states into the one value the engine reasons over,
and `integrationBlockAvailability(type, integrations)` is the only place a block
of an integration is judged. Both are pure: every input is an argument, so a
test declares a deployment instead of arranging a database, an environment and a
generated registry file, and there is no cache to go stale when an admin reaches
for the kill switch.

The read happens in the services tier (`connectedDeploymentIntegrations` in
`services/workflow-definitions/block-contracts.ts`) once per request, and inside
a step for a run. The resolver itself reads nothing, exactly as
`block-contract-environment.ts` already kept the environment out of it.

**It never reads `verification`.** A connection whose values are complete and
that nobody ever tested is usable, which is the state of every deployment alive
on the day this lands; reading the test verdict here would empty their palettes.
`usable` is `enabled && connection === "connected"`, and that is the whole
question.

Decision order for one block:

| Check | Answer |
|---|---|
| Its integration is disabled | `<Name> is disabled. Enable it on the Integrations page ...` |
| Its integration is failing | `<Name> is failing: <the resolver's own sentence>.` |
| Its integration is not connected | `<Name> is not connected. Connect it ...` |
| A required capability nobody provides | `No connected integration provides the <capability> capability, which this block needs.` |
| A required capability two usable integrations provide, with no selection | `<A> and <B> both provide the <capability> capability. Choose the active one ...` |
| Nothing in the build provides the block type | `No integration in this build provides the block "<type>". ...` |

A capability nobody serves is a named refusal and never a silent pick of the
first provider: a block that posted into one of two connected workspaces because
it happened to be first in the registry is the failure an admin cannot explain
afterwards. A provider an admin disabled does not count as a provider at all, so
disabling one of two trackers resolves the choice rather than raising it.

**`builtinCapabilities` is the bridge, and it shrinks to nothing.** Core still
serves `issue_tracker`, `vcs` and `messaging` from its own variables, which is
decision 10: an implementation that needs core configuration stays in core and
is the built-in provider of the capability. `builtinCapabilitiesOfDeployment()`
in `block-contract-environment.ts` is the only place that is stated, each entry
gated on the credentials core needs to serve it, and stages S8 to S13 remove a
line each as they move a provider out.

Until then, a capability that only an integration declares is **refused**, by
name. Execution hands a block whichever adapter core builds from its own
configuration (`engine/support/integration-capabilities.ts`), so offering the
block because an integration declared the capability would promise one provider
in the palette and use another in the run. Availability and execution have to
agree about which provider serves a block, and today that answer is core's.

### One sentence, four audiences

The palette, the publish refusal, the dispatch blocker and the run failure all
carry the same sentence, because they answer the same question for the same
person: what is missing and what do I do about it. The surfaces frame it, they
do not rewrite it. `Block "<id>" (<type>) is unavailable: <sentence>` at publish,
the blocker `message` at dispatch, and the ticket comment at failure.

### A stored definition may carry a block type core does not own

`isStorableWorkflowBlockType` (`packages/contracts/workflow-graph.ts`) accepts a
core type or one shaped like `<integration id>_<name>`. The graph package may not
import the registry (the boundaries gate fences it to `packages/contracts` and
`packages/conditions`), and it does not need to: whether the block can run is the
engine's question, answered by name through the contract.

Refusing an unknown type at the schema would make a definition published while an
integration existed unreadable the day the build stopped shipping it, and the
node would vanish from a canvas instead of saying what is missing. Writing a NEW
candidate carrying one is a different matter and is still refused, in
`validateWorkflowDefinitionCandidate`, with the sentence a misspelled block type
always produced.

`buildProvidesBlockType(contract)` is how a caller holding a contract asks
whether the build could describe the block at all. The signal is an explicit
`unprovided: true` on `WorkflowBlockContract` (`packages/contracts/domain.ts`),
set in exactly one place, `unknownBlockContract`. It is a field rather than a
shape read off some other value: an earlier draft inferred it from an empty
port list and then from an empty set of status variants, and both readings are
true of a block somebody may legitimately declare one day. A test in
`block-contract-integrations.test.ts` holds that no contract the registry
resolves carries it and that an unknown type's does.

### One port, named `out`, until S8

`blockTypeSpecOf` answers one action port named `out` for a type core does not
own, because the graph package may not read an integration manifest (the
boundaries gate fences it to `packages/contracts` and `packages/conditions`).
The editor, meanwhile, draws an integration block's ports from the contract the
engine resolves, which carries the manifest's own.

A block with two ports therefore reads one way in the palette and another
everywhere else: the second port is offered, refused at publish as an unknown
port, and at run time propagates to nothing, leaving a dead branch inside a
green run. Our own demo fixture shipped exactly that shape.

So an integration block declares exactly one port, named `out`, and branches on
its `status` output instead. It is enforced twice, because neither place sees
the other's integrations: `pnpm run gen:integrations` refuses the manifest, and
the SDK's conformance check refuses it as `block_ports_unsupported`. Both
messages name the stage that lifts the rule.

| Debt | Owner | What lifting it takes |
|---|---|---|
| An integration block has one port | S8, the first stage that ships an integration block | The graph has to learn a manifest's ports. Either a generated port table inside `packages/contracts` written by `gen:integrations`, or the contract threaded into the graph's port lookups. Then the generator rule, the conformance rule and this row all go. |

### What a run carries, and what stops it

A run pins `{ integrationId, configFingerprint }` for each integration its graph
uses. The pin is a value in the run's own workflow state, not a column:
`loadWorkflowDefinitionFor` (already a `"use step"`) computes it and returns it
on `LoadedWorkflowPlan`, so the Workflow DevKit restores it from that step's
recorded result on replay without reading the database again. A run suspended
across a deploy comes back holding the connection it started with and learns at
its next use that the connection moved. A column would have said the same and
cost a migration; S2 left the choice here for that reason. S10 reversed that
half of it and added the column as well, for a reader that is not the run: see
"The pin became a column too, and why S2's reasoning was incomplete".

The comparison only means anything because the pin is recorded: recomputing it
from live state on both sides would always agree and `reconfigured` could never
fire. `checkRunIntegrationUse` answers in S2's order, disabled, then
disconnected, then reconfigured, and `disabled` is re-read live at every use
because it is the kill switch.

A plan replayed from before this shipped carries no pins, compares nothing, and
behaves exactly as it did.

The same read feeds the validation that step runs before it builds the plan. The
run-load walk resolves contracts through `workflowBlockRegistryContext(undefined,
integrations)` and parameters through `blockParamsSchemasFor(integrations)`. Give
it core's registry instead and every integration block resolves to the contract
for a block nothing provides: a workflow whose integration is connected and
healthy dies as an invalid definition, which is a log line, no failure reason and
no ticket comment. Give it core's parameter map and an integration block's
parameters are never looked at, so a value its own schema rejects starts the run
and stops it at the block, after everything before it already ran. Both are one
call away from each other and neither shows up in a type, so both are held by
`definition-step-integrations.test.ts`.

Two moments stop a run:

- **Before any work.** `runIntegrationBlocker` over the plan's nodes; the run
  fails through the existing `failBeforeWork` exit, which records the reason,
  comments it on the ticket and moves the ticket back. One sentence instead of a
  workspace and an agent invocation nobody needed.
- **At the block.** The generic step re-reads the state, checks the pin and
  returns `unavailable` with one of the three reasons. The executor turns it into
  an execution error of category `configuration`, because no retry and no
  provider can change it and the person who can is an admin editing a
  connection.

Nothing is skipped and nothing degrades. The one exception the plan allows is
memory (decision 12), which S13 delivers.

### One generic step

`runIntegrationBlockStep` runs every integration block there will ever be, with
`maxRetries = 0`. Integration packages therefore carry no `"use step"`, so moving
or renaming an integration never strands a suspended run. Core never re-runs a
block executor that started: a block that posted a comment and then threw must
not post it twice, and retrying a transient failure is the integration's own
business through `ctx.http`.

The generated `BLOCK_EXECUTORS` table is written from core's own block
directories and keyed by block type, so it can hold neither a per-integration
entry nor a name core may not write. `executeBlock` asks that table first and the
one generic executor second.

Everything the step reads about the deployment it reads INSIDE the step, so the
DevKit records the answer and a replay reproduces it rather than asking a
database that has moved on.

### The core conditions that survive, and when each one goes

`availabilityFor` keeps a condition per provider that has not moved out yet.
Each reads an environment variable core owns, so the day an integration ships
under the same id, the condition keeps the old core block in the palette on
core's own credentials while the integration sits disabled: two answers about
one provider, and the one an admin acted on loses. Integration ids are free
strings and none of these five are reserved, so nothing in the type system
notices.

`apps/worker/src/engine/definition/core-provider-conditions.test.ts` fails when
a shipped integration id still has a condition in the resolver, and when the
resolver names a provider this table does not list.

| Provider named in `block-contract-resolver.ts` | Removed by |
|---|---|
| Arthur | S8 |
| Slack | S9 |
| GitLab | S10 |
| GitHub | S11 |
| Jira | S12 |

Rules that depend on a block's own parameters (which VCS providers a trigger
selected, whether an investigation asked for Slack) stay with the block that
owns them, which is decision 11; they leave with the same stage.

### The prose is what a human reads; the code is what a machine reads

A failed run records both. `status_reason` is the sentence, and it is copy: we
rewrite it whenever the wording can be clearer, so anything built on matching it
breaks silently the first time we improve it, in the direction of "this run
failed for no reason I recognise". `status_reason_code` is the machine's answer,
a member of a closed set (`RUN_FAILURE_CODES`, `packages/contracts/run-registry.ts`).
The code does not replace the sentence and is not derived from it: they answer
different readers. Decision 12 and the S3 definition of done both require the
machine-readable reason, so the cost belongs here rather than in a stage that
would have to reach back into the engine for it.

The set starts as the three this stage can produce, spelled `family.case`:
`integration_unavailable.disconnected`, `.disabled` and `.reconfigured`.
Membership is a type, so a code nobody agreed to fails the typecheck rather than
reaching the column, and `integrationUnavailableFailureCode` is the only way to
mint one: its template literal means a fourth `IntegrationUnavailableReason`
stops compiling until someone adds the row.

The pairing is a type, not a convention. `RunStatusReason` is either a bare
sentence or a sentence carrying a code, so there is no way to spell a code
without the prose it explains, and both writers
(`recordRunUsage`, `recordRunStatusReason`) split it into two columns of one
statement. Production runs on neon-http and cannot open a transaction, so a
second write would have been exactly the window in which a row holds one half.
Where the two disagree the code follows the prose through the identical branch:
a kept watchdog sentence keeps the watchdog's code.

Nothing is backfilled. Every run that failed before the column existed keeps
null, and null means "this failure carries no code", never "unknown failure".
Readers are unchanged for null, which is every failure the product produces
today: the dashboard query names its columns and does not name this one, the run
detail payload is built field by field, and
`apps/worker/src/db/repositories/runs/run-detail-read.test.ts` holds that a
failed run reads exactly as it did and that the field does not appear in what a
client receives. S3 is the first consumer, and it reads the column directly.

No user-facing sentence changed in this stage. `runRetiredWorkflowFailureExit`
splits the pair at its own boundary: the ticket comment, the log line and the
notification get the sentence, and only the durable record sees the code.

The manual-dispatch path already carried the typed code: `integration_unavailable`
is a `ManualDispatchBlockerCode`, and MCP maps it to `VALIDATION_FAILED`, not
retryable, nothing applied. The column is the run-side half of the same answer.

Migration `0071_run_status_reason_code`, one nullable `text` column on
`workflow_runs`.

### Where the engine reaches the integration service

`tiers.json` gains one edge exception: `engine -> apps/worker/src/services/integrations/runtime.ts`.
The engine has to resolve a connection to run a block, and the connection state,
the connection values and the context an integration receives are resolved in
exactly one place. A second resolution in the engine is how a palette and a run
come to disagree about the same deployment.

The exception names `runtime.ts` rather than `index.ts` deliberately.
`runtime.ts` re-exports reads only; the write surface (save, disconnect, set
enabled, set source, test) is not in it, so a run may use a connection and can
never change one, and the exception cannot widen by accident into the rest of
`services`.

### Vocabulary this stage adds

`ManualDispatchBlockerCode` gains `integration_unavailable`, distinct from
`provider_unavailable`: that one is a provider unreachable for THIS request and
may work on the next, while this one never succeeds until an admin changes a
connection. It maps to HTTP 422 and, over MCP, to `VALIDATION_FAILED`,
not retryable, nothing applied.

## Health, decided in S5

### One section per integration, contributed not listed

A scan has two halves. Core writes its own sections (database, Jira, GitHub,
GitLab, the agent, authentication, email, Slack, Arthur, MCP, custom webhooks)
exactly as before, and adds nothing to them. The integrations of this build
contribute theirs: `integrationHealthContributions` in
`apps/worker/src/services/system/integration-health.ts` is handed one entry per
manifest the registry ships, and returns the sections and the probes; core's
collector appends them and runs both halves through the same pipeline, the same
4 s per-probe timeout and the same summary. Nothing in
`apps/worker/src/services/system` names an integration, so adding one adds a
section and adding an outside developer's adds one too.

They land in a group of their own, `integrations`, rather than in core's three.
Core groups say what a service does for the product; an integration is
connected per deployment, and core cannot say which of its own groups a
provider it has never heard of belongs to.

An integration section is never `critical`. Criticality in this report means
"the product cannot work without it", which is what `criticalDown` counts. A
provider one workflow uses and another does not is not that, and a demo
integration that has never been connected must not read as the platform being
down. Criticality inside the integration is the manifest's per-check `critical`,
which decides whether a failing check takes the whole integration down.

### What a section says, and where each word comes from

Every section begins with one check core adds, `connection`, and continues with
the checks the manifest declares, in its order. The connection check is where
the resolver's answer becomes a row; nothing about connectedness is derived a
second time here, because the health page and the Integrations page must never
disagree about the same deployment.

| `IntegrationState` | Health mode | What the row says |
|---|---|---|
| `enabled: false` | `disabled` | Turned off on the Integrations page. No probe runs. |
| `connection: not_connected` | `not-configured` | Not connected. No probe runs. |
| `failing`, `environment_incomplete` or `stored_incomplete` or any secret-key reason | `misconfigured` | The resolver's own sentence, and the variables to set as the check's `envVars`: the missing ones only. |
| `failing`, `credential_rejected` or `provider_unreachable` | `down` | The provider answered and refused, or could not be reached. |
| `usable` | `configured`, then whatever the probes return | Where the values come from, and what the last connection test proved. |

`SystemHealthMode` gained `disabled` for the first row of that table. A
deliberate decision is neither an outage nor an unfinished configuration, and
reporting it as either sends somebody to fix what somebody else chose. The
union is exhaustive in three maps on the dashboard, so the compiler asked every
reader of a mode what it now means.

The declared checks of an integration that is not usable report the same mode
as its connection rather than a probe result: there is no connection to run them
against, and a scan never states a result nobody measured. Variable names appear
only when the environment is the source; stored values come from the database,
and naming a variable for them would send an admin to set something that changes
nothing.

### What a probe may do to a scan

A probe is called only for a usable integration, so a deployment that connected
nothing makes no provider request at all, and a disabled integration is left
alone. Each call is bounded by the collector's existing timeout and they run in
parallel, because the dashboard aborts the whole scan after 15 s and ten
providers hanging one after another would never finish.

A probe that throws is one failing check with the provider's own reason, never a
failed scan: the reason includes what the error hides in its `cause` (`fetch`
throws a flat "fetch failed" and keeps "connect ECONNREFUSED" underneath), and
it is redacted against this connection's secret values and bounded to 300
characters before it reaches the response or a log. A provider that echoes a
token in an error body is normal, and that body is what an admin reads on a
screen. Redaction covers each secret as written, percent-encoded, base64,
JSON-escaped, and line by line for a multiline value such as a PEM key, because
a provider quoting one line back would otherwise hand it over.

### An integration is code core did not write

Everything a probe returns is treated as input from outside this repository, not
as a value core can trust:

- **Only `live`, `degraded` and `down` are results.** A probe that returns
  nothing, an empty object, a status of another type, or a word this report has
  no meaning for is a check that is `down`, with a message saying the probe
  returned no usable result. The alternative is the one mistake a health screen
  must never make: painting Live over something nobody measured. Core's own
  probes keep their contract, where returning nothing means the call succeeded.
- **Contributed probe keys are namespaced** (`integration:<id>.<check>`).
  Probes are one map keyed by section and check, and an integration's id is its
  own to choose: an integration called `github` declaring a check called
  `repositories` would otherwise replace core's probe, and the page would show
  two GitHub rows that could disagree. Conformance refuses such an id as well,
  and the namespace is what holds for an integration conformance never saw.
- **The screen never breaks on an unknown word.** A mode or a group this build
  has no entry for renders as Unknown, in its own section, rather than throwing
  while somebody reads the page during an incident.

## What MCP says about integrations, decided in S3

The one description a later stage reads instead of the code. Delivered in stage
S3 (AIW-410) as `apps/worker/src/mcp/integration-facts.ts`,
`apps/worker/src/mcp/integration-redaction.ts` and the guard
`apps/worker/src/mcp/integration-management-guard.test.ts`.

### The caller is a model, and that is the whole design

An agent building a workflow over MCP needs one thing from integrations: which
blocks it may put in a graph right now, and, when it may not, what to tell the
person who can change that. It needs nothing else, and Jakub's boundary of
2026-09-18 (plan decision 15) is that it gets nothing else: connecting, testing,
enabling, disabling, switching the source and choosing a provider stay in the
dashboard, because a token that travelled through one of these tools would land
in a model's context and in a model provider's logs.

### What is exposed

`system.capabilities` gains one field, `integrations`, and no new tool. The plan
decided the surface; what S3 decided is its shape, one entry per integration
this build ships:

| Field | Means |
|---|---|
| `id`, `name` | The manifest's own, which is what an agent names to a person |
| `status` | `connected`, `not_connected`, `failing` or `disabled` |
| `usable` | Enabled and connected: whether its blocks can run at all |
| `capabilities` | The capability ids it declares. Not which one is active |
| `blocks[]` | `type`, `available`, and the resolver's own `unavailableReason` |

An empty list for a build that ships no integration, never an absent field: an
agent has to be able to tell "this deployment has none" from "I asked wrong".
That case also reaches no database, because there is nothing to read.

There is no sentence of MCP's own beside them. `status` and `usable` are the
machine-readable answer and the per-block sentence is the resolver's; a third
wording for the same state is how two surfaces start drifting. For the same
reason the verdict is read off the contracts the editor's palette is built from
rather than recomputed: `system.capabilities` and `blocks.list` answer from one
registry built from one read of the state, inside one call.

Nothing is cached. Disabling an integration is the kill switch an admin reaches
for, and on Vercel the next call lands on a warm invocation where a module-level
cache would answer with the catalog that admin just revoked.

### What is not exposed, and what that cost

**No management tool, under any name.** The guard is two rules, because neither
catches the other's case: a reviewed list of every published tool, so a tool
added under ANY name fails and the failure names it, and a shape rule over the
names and the scopes, so the likely spellings fail even in the edit that updated
the list. Both were seen failing against a planted `integrations.connect` and a
planted `vendors.rotate`.

**No variable name, anywhere.** This is the finding that changed the stage. S2
composes the sentence an admin needs, "Set `DEMO_API_TOKEN` on this deployment",
and S4's `integrationUnusableReason` embeds it, so every MCP surface that
relayed that sentence handed a model the exact name to ask a person to paste a
value for. That is the boundary itself, not a detail of it.

The split lives in the state, not in the prose:

- `agentFacingIntegrations` returns the same deployment with each presence's
  `failure` replaced by a code-owned, agent-safe one. `usable` and `status` are
  untouched, so the verdict stays exactly one verdict, and
  `missingVariables`/`missingFields` do not survive, since they are the same
  answer in structured form. Every sentence the resolver composes downstream,
  in the palette, in a draft issue and in a publish refusal, then comes out
  agent-safe without anybody rewriting a finished sentence.
- A redaction floor in the envelope sanitizer, and in the two places an error
  message leaves without passing through it (`issueText` and the dispatch
  refusal), replaces the declared names with `[a deployment variable]`. It is
  the floor and not the mechanism: a failed run's durable reason is written by
  code that answers an admin and never heard of this surface. The names come
  from the manifests, so an integration that adds a variable is covered the day
  it lands, and the match folds case, because provider tooling and log lines
  spell a variable whichever way they like. Names shorter than four characters
  are left alone, because the `env` pattern allows a one-letter name and
  redacting one would shred every answer that happened to contain those
  letters; that exemption is safe because `integrations/registry` holds every
  shipped manifest to the same four characters, so such a name cannot ship.

The dispatch preflight is the one surface that composes its own sentence from
the presence rather than from a block contract, so MCP passes it the
agent-facing deployment instead of relying on the floor. Doing that found the
defect below.

What survives is what a person can act on: which integration, what state it is
in, and that the Integrations page is where it is fixed.

**No failure reason enum either.** Nine reasons split as finely as an admin's
afternoon differs; an agent's action is the same for all of them. `status` is
what it branches on.

### A draft is stored and told why it cannot ship

`workflows.save_draft` keeps the draft and answers with `deployable`, the
editor's own `deploymentIssues` and `deploymentIssueCount`. It does not refuse.
Refusing would leave an agent unable to build a graph in steps toward an
integration a person has yet to connect, and would make MCP disagree with the
editor about the same graph, which is the failure the plan names. Publish is the
gate, and it already refuses naming the integration. What must be impossible is
reading a success without the reason it cannot ship, so `deployable` sits beside
the revision an agent came for rather than behind a second call. The count is
reported even when nothing was dropped, because an agent that fixed a capped
list of fifty and met fifty more would read the second page as damage it had
just caused.

**`deployable` is not a promise about publish, and that is recorded rather than
fixed.** `validateWorkflowDefinitionCandidate` resolves no pinned Harness
Profile versions; the deploy gate does. So a graph pinning a version this
deployment cannot resolve reads deployable here and is refused there, and a
parameter issue that depends on a resolved profile can appear here and not
there. Making this call database-bound would close that gap and open a worse
one: it would answer differently from the editor's own draft save, which runs
exactly this function (`validate.post.ts`), and "MCP and the editor never
disagree about one graph" is the rule this stage is built on. The two are
reconciled by teaching that one function about profiles, which is the engine's
call. Until then the tool description says what the field covers.

### The typed failure code is read, not inferred

S4 wrote `status_reason_code` and left the first consumer to S3. A failed run
now carries `failureCode` on `runs.result` and `runs.logs`, beside the prose
each of them already carried, and `runs.diagnose` gains an
`integration_unavailable` category decided from the code.

That category is ahead of every prose rule and is the only high-confidence rule
in the classifier that looks at a failure at all, which is the point: every
other rule matches a sentence, and a run stopped by an integration whose reason
happens to open like another category's was being diagnosed as that category. A
test holds exactly that case. The three reasons carry three different actions,
because a person answers them differently: enable it, reconnect it, or nothing
at all and run again.

`failureCode` travels beside the run rather than inside `RunDetail`, so the
dashboard's run detail payload is unchanged, exactly as S4 decided.

**The code travels wherever the prose does, and nowhere else.** `runs.get` is a
summary and carries neither, so an agent polling it sees a failed status and has
to call `runs.result` for the why. That is the rule rather than a gap: a code
without the sentence it explains is half an answer, and `runs.get` was never the
tool that gives one.

### One thing this stage fixed outside itself

`preflightConnectedManualDispatch`, which is the variant production runs,
computed no integration blocker at all: S4 added it to the database-bound
variant, and every test that proved the blocker ran that half. A workflow whose
integration was disconnected therefore preflighted as runnable over MCP and
failed the run at its first step. Both variants now report it from one helper,
which takes the deployment as an argument so each caller answers the audience it
serves.

`system.capabilities` also stopped letting that read fail the whole call.
Integrations are its one database-backed field and it is the first call every
client makes, so the field is `null` when the state could not be read, distinct
from `[]`, which means this build ships none.

### What this stage deliberately left

- Read-only integration data of an integration's own (an evals summary, say) is
  still an open question to Jakub. The plan says no, and nothing here prepares a
  slot for one.
- The response shapes are pinned by tests rather than by the contract hash,
  which covers tool names, descriptions, input schemas and annotations only. A
  field added to or removed from a response moves no hash, so the assertions on
  `system.capabilities`, `workflows.save_draft` and the `runs.result` outcome
  are what a client's expectations rest on.
## The Integrations screens, decided in S6

Two routes. `/integrations` lists every integration this build ships and writes
nothing. `/integrations/<id>/connection` is the one place a credential is typed
and the one place a destructive action is confirmed. S7 wraps the second in the
integration's own area, where it becomes the Connection tab.

The split is deliberate. A list that also saved tokens would put the only
credential field in the product next to nine other cards, and a first-timer
reading down the page would meet four ways to change something before meeting
the one they came for. Separating them also means the list has no failure mode:
it renders from one read and nothing on it can be clicked into a refusal.

### What the page refuses to do

- **It never decides a status.** `statusChip`, `sourceLine`, `verificationLine`
  and `statusDetailLines` (`apps/dashboard/lib/integrations/presentation.ts`)
  turn `IntegrationState` into sentences and compute nothing. The chip reads
  `status`, never `connection`, so an integration somebody switched off says
  Disabled rather than Connected with perfectly good credentials.
- **It never claims a source serves the integration when it does not.** After a
  first save fails its test, the source is still `environment` and the
  environment may set nothing; the line says so and names the variables rather
  than reporting that the values came from there.
- **It never shows a secret and never re-sends one it does not have.** A secret
  input starts empty under every source, says whether one is stored, and travels
  only when something was typed. Emptying one is `clearSecrets`, an action, not
  a blank input. After a save the secret inputs are cleared, because characters
  left on screen would suggest the field holds the stored value.
- **It never invents a number.** Disable and disconnect name their consequences
  and count nothing: how many published workflows and runs in flight depend on
  an integration is not in this API (see "What S2 does not decide"), and a count
  guessed in the browser is worse than a sentence. Delivering the count needs a
  worker endpoint S6 was scoped out of; it is the one part of decision 9's
  "impact before change" that is still open.
- **It never enforces a permission.** A member is shown no control because
  offering one that 403s is rude, not because the hiding is the rule. The worker
  refuses, and `canManageIntegrations(session.role)` on a server-verified role is
  what the screen reads.
- **It offers no "save it anyway".** Values that failed their test are stored
  and not used, and the screen says which of those two facts applies to the
  connection currently running.

### Three surfaces, one sentence, one source

The palette, the badge on a canvas node, the banner over the canvas and the
selected node's panel all read `options.blockRegistry[type].availability`, which
is the engine's own sentence (S4). The panel used to prefer the per-node
contract that validation resolved; that contract is refetched when the canvas
changes and not when an integration does, so an admin who reached for the kill
switch in another tab kept reading "this block can run". Ports and outputs are
per node; availability is a fact about the deployment and the block type, so it
comes from the registry the server last rendered with.

### How a screen learns something changed

`router.refresh()`, from `useIntegrationChangeRefresh`
(`apps/dashboard/lib/integrations/change-signal.ts`), on two triggers: a
`BroadcastChannel` message another tab of the same browser publishes after every
successful mutation, and this tab regaining focus, which covers a change made by
anybody else. The channel is one open instance per document: a channel closed
straight after `postMessage` drops the message, which is the shape this started
as.

All three screens use it, not just the editor. The gate found the connection
screen still reading Connected, and still offering a live Disconnect, half a
minute after another tab had erased everything: a screen that offers a control
for a connection that no longer exists is worse than one that flickers.

A refresh is not free, though, and the price is paid by anybody typing. These
pages read their data in an async server component under a `Suspense` boundary,
and that boundary suspending again unmounts the client tree under it: on the
connection screen, a colleague's save emptied the form. Worse, it emptied the
form while handing this tab a current version token, so the next save wrote the
seeded stale values back over the colleague's change with no conflict at all.
So the connection screen refuses the refresh while anything is typed and says
that something changed instead. The stale token is the point: the save that
follows collides, and the comparison above is what the admin gets. The editor
takes the refresh: its unsaved canvas was still there afterwards, with the
palette and the canvas banner both current.

### Saving against somebody else's save

A save carries `expectedVersion` and the worker answers 409 with the version
that won. The screen then re-reads the connection, takes every field nobody
here has touched from that read, and names the fields that still differ with
both values ("Site URL is now X here, and you typed Y") before offering Save
again, which now carries the version that won.

Seeding the form once is right while somebody is typing and was wrong here: the
first shape kept the whole form as this tab last knew it, so "Save again",
exactly as the sentence instructed, wrote a colleague's field back to the value
it had before they changed it. The read-back is the ordinary list endpoint; when
it fails, the screen says the values could not be read back and asks for a
reload rather than offering a second blind write.

### What the card is allowed to promise

A block an integration declares is not a block this build can run: core may
still own the capability it needs. The list therefore reads the editor's own
block registry (`/api/v1/workflow-definitions`, the endpoint the editor already
uses, in parallel with the integrations read) and says which blocks this build
runs and why the rest are refused. That answer is only read while the
integration is in use: an integration nobody connected has every block refused
for that one reason, which would turn the card whose job is to say what
connecting brings into a list of circular refusals. A deployment that refuses
the second read leaves the card describing the blocks rather than promising
them.

### Text from outside, bounded at the render edge

A provider that answers 401 with a sign-in page hands us two kilobytes of HTML,
and a forwarded worker error carries a stack and the worker's own URL. Both were
rendered whole. `readableProviderText` keeps the first line, drops markup,
replaces absolute URLs, collapses whitespace and bounds the length, and every
provider sentence and forwarded error goes through it. The worker stores the
same text on the connection, so bounding it at the write as well is S2's to
decide.

### Refusing to ask a question nobody answers

"Test what is in use" is refused while `connection` is `not_connected`: there is
nothing in use to ask about. Sent anyway, the worker built a request out of
empty values, and the `new URL("")` that threw came back as "the provider is not
answering, try again in a moment" and was written down as a failed verification
for everybody. The refusal is read off the status the API returned, never off a
status the browser worked out. The classification of that throw is the worker's
and is still open.

The same asymmetry decides the advice after a failed test: a save sent exactly
the values on screen, so "correct them and save again" is right, while a test of
a deployment reading its environment did not try those values at all, and says
so instead.

### Two defects this stage had to fix to exist

An integration's block type is storable and is in none of core's tables keyed by
block type. `BLOCK_PARAM_KEYS[type]` and `BLOCK_TYPE_SPECS[type]` each returned
`undefined`, and `ConfigFields` handed `createElement` an undefined renderer, so
the editor died with a client error the moment such a block reached the canvas.
The dashboard now falls back to the node's own params, to `blockTypeSpecOf`, and
to no fields. The last one is a gap rather than a fix: an integration block's
parameters are declared by its own schema and this build has no form for them.
The stage that ships the first real integration block owns that form.

### What is open

| Question | Owner |
|---|---|
| The numeric impact preview before a disable, a disconnect or a reconfiguration | a worker read that counts published workflows and runs in flight |
| A settings form built from an integration's parameter schema | the first stage that ships a real integration block |
| Choosing the active provider of a capability two integrations serve | S13, which is the first stage with two |
| A throw raised while building a request out of unconfigured values is reported as `provider_unreachable`, so a non-answer is recorded as a failed verification | S2, which owns the classifier; the dashboard only stops sending |
| Whether the text a provider returns is bounded where it is stored, not only where it is read | S2 |
| Inputs are 12 px on every cockpit form, which makes iOS zoom on focus | DESIGN.md and the shared `Input` primitive, not one screen |

## Where an integration lives in the cockpit, decided in S7

The sidebar was a flat list of thirteen, and "Arthur evals" sat sixth in it
whether Arthur existed or not. It now says which side of the product each entry
belongs to: three core groups, a separator, then Integrations. Above the line is
what we build. Below it is what this deployment was connected to.

### The sidebar

| Choice | Why |
|---|---|
| Three core groups, each with a heading that folds, and the fold persisted per person | The number of entries below the separator is not ours to decide. A person with five providers connected folds Observability and gets the room back; without a fold the only lever would have been ours, and we would have had to pick a cap. |
| A separator, not a fourth ordinary group | The line is the statement. An integration's screens are not a category of our product, they are somebody else's screens hosted in ours, and a person debugging one has to know which of us to blame. |
| The Integrations page is always an entry, and is the first one under the separator | "Nothing is connected" is an answer somebody has to be able to go and read. A section that disappeared with the last integration would hide the question along with it. |
| One entry per integration, and only for `state.usable` | `usable` is the resolver's own word for connected and enabled (S2). Reading `status` here, or recomputing it from `enabled` and `connection`, would be a second derivation of the one thing S2 exists to derive once. An integration somebody switched off leaves the sidebar, which is the answer to "why is nothing running". |
| The nav region scrolls, and says when it is scrollable; nothing is capped or hidden behind a "more" | A cap means an integration somebody connected is not in the list and nothing says so. Measured on the running cockpit with five connected: the column needs 859 px, so 1920x1080 has about 140 px to spare and a 1280x800 laptop is about 140 px short. It scrolls there, and macOS hides an overlay scrollbar nobody has touched, so the region carries `.ck-scroll-cue`: pure-CSS scrolling shadows, painted only while there is content past the edge, no measuring and so nothing that can disagree with the real scroll state. Folding a group is the other lever, and it is the person's. |
| A two-character monogram from the name's own capitals in the rail | Nothing in a manifest gives us a symbol, and the five providers coming next are camel-cased brands, so their capitals separate them: GitHub is GH and GitLab is GL, where a first letter would have drawn both as G. Every entry carries the full name as `title` and `aria-label`. If two ever collide, the answer is a `glyph` in the manifest, which is additive; S7 did not need it. |
| System health and Users became tabs of Settings, and `/health` and `/users` redirect permanently | They are things an administrator does to the deployment rather than places the product's work happens, and thirteen flat entries left no room for the section below the separator. Both paths are in bookmarks and in runbooks, so neither route was deleted. Next carries the query string across and a fragment never reaches the server, so `/health?provider=jira` arrives whole. |
| The phone's More sheet is the same list, grouped the same way, Integrations last | Somebody who learned where a screen lives on a laptop finds it in the same place on a phone. The bottom bar carries three screens, so anything the More sheet drops cannot be reached from a phone at all. |

**The shell no longer reads the first path segment.** It used to, and
`globalPollingAllowed` was `screen !== "health"`. Moving System health under
Settings would have made that comparison stop matching in silence, and the
cockpit would have started refreshing on a timer the one screen whose every
refresh contacts every configured provider. `cockpitScreen(pathname,
integrations)` in `apps/dashboard/lib/cockpit/navigation.ts` answers the three
questions instead: which entry is lit, what the topbar says, and whether the
timer may touch this screen. The topbar names the integration and the page
("Demo / Activity"), because four open tabs all saying "Integrations" is four
tabs nobody can tell apart.

**The sidebar's list is read once per request** in the cockpit layout, through
`readIntegrationsList` (`apps/dashboard/lib/integrations/list.ts`), which is
`cache`d so the sidebar, an integration's area and the Integrations screens get
one round trip and, more to the point, one answer. It is one call on the
critical path of every cockpit page load, which was not there before. Measured
from a laptop against the dev worker and the shared Neon branch, the round trip
to `/api/v1/integrations` takes 85 ms (five samples, 84 to 136 ms), almost all
of it the database round trip the session check makes to another region. That
number is the local shape, not the deployed one: on Vercel the worker and the
database are in the same region and the call is one more hop the layout already
makes for the session. Without the `cache` the same page would have made up to
three of these. A worker that does not
answer leaves the core groups standing and the Integrations page reachable: a
cockpit that refused to render because a list of plugins could not be read
would be the worse failure by a distance. The shell subscribes to S6's change
signal, so an integration connected in another tab becomes an entry here;
that refresh is refused while the cockpit holds unsaved work, and the
Connection form now registers there, because S7 put a tab strip one click from
its token field. A refused refresh is not silent: the topbar and the mobile
header say the sidebar is behind, because a nav that is quietly wrong is worse
than one that flickers.

### The integration area

`/integrations/<id>` is an area with horizontal tabs: the pages the manifest
declares, in its own order, then Connection.

- **Connection last.** Somebody who opened an integration from the sidebar came
  to read what it is doing. Connection is the setup: needed on the first
  afternoon and rarely again, and first would make every visit open on a form.
  The screen itself is S6's, unchanged, at the same URL.
- **`/integrations/<id>` redirects to the first tab**, which is the first
  declared page, or Connection when a manifest declares none. An integration
  with one tab gets no strip at all: a strip offering no choice is furniture
  that says an integration has more than it has.
- **The tabs come from the manifest registry, not from the worker**, which is
  what keeps the area layout synchronous. An async layout would put a Suspense
  boundary over the Connection screen, and a boundary that suspends again on a
  refresh takes the client tree with it, which is the failure S6 spent a round
  on.
- **Tabs navigate through the cockpit's `navigate`**, not through a link or
  `router.push`. `router.push` never fires `beforeunload`, and the only thing
  between a half-typed token and an empty form is that guard.
- **Four different nothings, each said in our words**
  (`contributedPageOutcome`, in `presentation.ts` with every other sentence):
  an integration this build does not ship, a page id the manifest does not
  declare, a declared page this build did not compile, and an integration that
  is not in use. A bare 404 collapses the four and sends people looking in the
  wrong place.
- **A page is not run at all while the integration is unusable.** Its own pages
  read the provider through the connection, so rather than let a package make
  what it will of a connection it does not have, the area says which of the
  three states applies and leaves Connection one click away. A worker that did
  not answer is not turned into a refusal: the page is handed no data of ours,
  so one that renders while we cannot confirm the connection shows its own
  static content and nothing worse.
- **A page that throws hits an `error.tsx` of its own, and one that is slow
  hits a `loading.tsx`.** A crash is expected here in a way it is nowhere else
  in the cockpit: without the boundary the route segment is replaced by the
  app's generic error screen and the chrome goes with it, and an admin would
  see the product break with no reason to suspect the plugin. The waiting state
  is the same argument about the other failure: a page fetches from its
  provider, the segment had no Suspense boundary of its own, so a slow provider
  left the previous screen on display and the tab click read as not having
  landed. The tab strip stays through both, because the layout is not what
  suspended.

### The host UI package

`@integrations/host-ui` (`integrations/host-ui`) is what an integration's
dashboard pages are built from, and the boundaries gate holds them to it.

| Choice | Why |
|---|---|
| Under `integrations/`, beside the SDK, not in `packages/` | It is the second half of one contract: the SDK types what an integration's worker code is handed, the host UI what its dashboard pages are built from. A package under `packages/` is reachable by every core tier, and a React package the Nitro worker can import is a Vercel build failure waiting for somebody to write the import. |
| Extracted primitives, not a re-export of `@/components/ui` | A package cannot import an app without inverting the dependency. More to the point, `@/components/ui` is internal and changes whenever a cockpit screen needs it to; a contract with third-party code has to be a thing that only grows. The cost is two definitions of a card, and the guard against drift is that both are drawn with the same `@theme` tokens, so a palette change reaches an integration's pages the same day it reaches ours. |
| Nine presentational primitives: `Page`, `Section`, `Card`, `KeyValue`, `Chip`, `Notice`, `EmptyState`, `ExternalLink`, `Table` | Enough to build a page that looks like ours out of what a provider returns, and nothing that decides anything. |
| No dialog, overlay, drawer or portal | A page renders inside the content area. Anything that escapes it is an integration taking the screen from the product. |
| No router, internal link or redirect | Where somebody is in the product is the product's to decide. `ExternalLink` leaves to the provider, in a new tab, with `noreferrer noopener`. |
| No inputs, selects or submitting buttons | A page has no write seam in this build, and a control that does nothing when clicked is worse than no control. The stage that gives pages a write seam brings the controls with it. |
| No `className` on any primitive | The look of a primitive is the product's. A page composes primitives with its own elements and writes Tailwind classes, arbitrary values included, on those. |
| A page is handed `{ integrationId }` and nothing else | Its props are the contract, and a narrow one is what keeps the next five stages from each inventing a different way in. What that is NOT is a sandbox: see below. |

### What a contributed page can actually reach

Say this plainly, because S14 hands it to an author outside this team.

A contributed page is a Server Component compiled into the dashboard and run in
its process. Its props carry the integration id and nothing else, and there is
no session, no database handle and no worker client in them. It could still
reach `process.env`, call global `fetch`, or use any dependency it declares:
nothing here is a sandbox, and building one would mean a separate process or an
iframe, which is the design this stage exists to avoid.

**An integration is trusted build-time code we review, like the rest of this
repository.** The rules below are against coupling, not against a hostile page.
They exist so an author does not reach for our runtime by accident, and so that
what "a page shows what its own package knows" means is checkable rather than
aspirational:

| Refused | By | Because |
|---|---|---|
| `@/...` | `forbiddenSpecifiers` in the boundaries gate | the dashboard's own alias; an integration pinned to it breaks on an afternoon nobody told them about |
| `next/*` | the same rule, on `dashboard.tsx` | `next/headers` reaches our cookies and `next/navigation` moves the person |
| `node:*` | the same rule | a page has no business in the filesystem, and it is the first step of anything that does |
| `server-only` | the same rule | it is how a module declares itself part of our server, which an integration's is not |
| `process.env` | the registry generator, on the entry and every file it imports inside the package | not an import, so no specifier rule can see it, and it is the one reach that needs no dependency at all: it would hand a page this deployment's `WORKER_BASE_URL` and everything beside it |

What remains possible, and is not claimed otherwise: a page may `fetch` the
open internet, and it may ship any dependency it declares. **A page bounds its
own fetches**, because the cockpit is what waits on it. The route has a
`loading.tsx`, so a slow page shows a waiting state instead of leaving the
previous screen up, but a page that never answers is a tab that never finishes,
and nothing on our side cancels it.

**A page runs only once the deployment says its integration is in use.** That is
true of the module, not only of the render: `dashboard.generated.ts` holds each
integration's page ids as data and its module behind a `load()` thunk, and
`ContributedPage` decides from the ids and the connection state before it
awaits that thunk. A static import would have run the top level of every
shipped integration on the first load of any integration route. "The worker did
not answer" is not "in use" either, so it blocks too, in words that name our
outage rather than the integration.

**Declaring pages is typed against the manifest.**
`defineIntegrationDashboard<typeof manifest>({ pages: { ... } })` keys the
components by the manifest's literal page ids, so a page declared without a
component and a component for a page nobody declared are both compile errors
where the mistake is. The manifest is imported with `import type`, so the
import erases and a manifest's zod schemas never reach the browser. The
generator refuses the same two mistakes for a build assembled from mismatched
commits.

**S7 needed nothing from `@integrations/sdk`.** The dashboard contract lives in
the host UI rather than the SDK because the SDK is browser-safe plain data with
no React in it and is imported by the worker; putting `ComponentType` there
would put React in the worker's type graph for a contract the worker never
reads. So the change log below has no S7 row.

### Three registries, three bundles

`pnpm run gen:integrations` now writes a third file,
`integrations/registry/dashboard.generated.ts`, behind
`@integrations/registry/dashboard`. It holds React components, keyed by id
because the route holds the id from the URL, and an integration with no pages is
absent rather than present with an empty object.

The boundaries gate states which bundle each registry belongs to, because every
one of these failures appears only in a Vercel build: the worker may not import
the dashboard registry, the root entry and the worker entry may not import it
either (the Workflow DevKit traces the flow bundle and there is no React in it),
and an integration's `dashboard.tsx` may not import its own `worker.ts`.

**The gate gained a rule keyed on the specifier, not the target.**
`@/components/ui` is the dashboard's own tsconfig alias, so from a file outside
`apps/` it resolves to nothing at all and every rule keyed on the resolved path
skips it: an edge the gate cannot resolve is an edge it cannot refuse, which is
exactly the hole an integration reaching into the dashboard would have sat in.
`forbiddenSpecifiers` in `scripts/gates/tiers.json` matches the specifier as
written.

### Tailwind compiles what an integration writes

`apps/dashboard/app/globals.css` gains an `@source` per dashboard entry.
Tailwind scans the project it is compiled in and nothing else, so without them a
contributed page renders with its markup intact and none of its classes defined.

The dashboard entries only, never a whole package: a worker entry holds provider
payloads and secrets-shaped strings and a README holds prose, and scanning
either would let a string in server code decide what CSS this app ships. So the
convention an integration follows, and the one its README states, is that page
code is `dashboard.tsx` or lives under a `dashboard/` directory beside it.

The failure is deceptive and worth naming for the five stages that follow. A
class a cockpit screen also uses is generated anyway, so a contributed page
looks fine until it writes something only it uses. Arbitrary values are the
honest detector, which is why the fixture page draws a bar with
`w-[137px] h-[9px] rounded-[11px] bg-[#FD6027]`: with the `@source` line
commented out that bar measures 855x0 with no radius and no background, while
the card beside it keeps its border.

### What S7 left open

| Question | Owner |
|---|---|
| A contributed page can read nothing. Every real provider will want its own data, and the seam that gives it any is a contract decision: the recommendation is a read-only call the host resolves through the integration's own worker runtime, never our database and never our session | the first stage whose provider contributes a page with data in it |
| Two integrations whose names yield the same monogram would draw the same mark in the collapsed rail | the stage that lands the second colliding name; an optional `glyph` on the manifest is the additive fix |
| The `ui-primitives` gate scans `apps/dashboard` only. Extending it to `integrations/host-ui` would read a primitive package as a call site, so `primitives.test.ts` and `primitives.render.test.tsx` carry that weight instead | open by choice; the lever we hold over an integration's own markup is what the host UI lends |
| The cockpit layout reads the integrations list on every page load, one round trip on top of the session check | acceptable today; a worker read light enough to be free would be a worker change |

## The first real provider, decided in S8

Arthur is `integrations/arthur`, and core no longer holds the word. Its blocks,
its health checks, its Evals page and the tracer every agent sandbox runs all
arrive through the contract. What follows is what that took, and it is the
template the four provider stages after it copy.

### What moved, and what core deleted

| Was | Is |
|---|---|
| `sandbox/arthur-client.ts` | `integrations/arthur/client.ts`, every request through `ctx.http` |
| `sandbox/arthur-tracer.ts` and `scripts/build-arthur-tracer.mjs` | `integrations/arthur/tracer.generated.ts` and its build script, handed to core as a file to write |
| `installArthurTracer` in `sandbox/agents/claude.ts` and `codex.ts`, and `ConfigureOpts.arthur` | the `agent_tracing` port, applied by `sandbox/agents/tracing.ts` |
| `blockPrepareWorkspaceEnsureArthurTaskStep` and `ensureArthurTask` | `createIntegrationRunStatesStep` and `engine/support/integration-run-state.ts`, for any integration |
| `engine/blocks/arthur-injection-check/**` | the `arthur_injection_check` block of the package, run by S4's generic step |
| `engine/blocks/support/injection-markers.ts` | `integrations/arthur/injection-markers.ts` (its only caller moved) |
| `services/overview/collect-evals.ts`, `collect-eval-summary.ts`, `routes/api/v1/evals.get.ts`, the `/evals` screen | the `evals` page of the package, read through the `api` slot; `/evals` redirects there permanently, so a bookmark still lands |
| `routes/api/v1/overview/eval-health.get.ts`, `EvalHealthResponse` and the overview's eval tile | nothing: the tile promised grading that was never wired up, and the Evals page is where grading is read |
| `arthurConfigured` in `block-contract-resolver.ts`, the `arthur` health section, `GENAI_ENGINE_*` in `runtime-env.ts` | the registry answers all three |

The `arthur` rows in `scripts/gates/core-references.json` went from fifty to
one, and `plannedIntegrations.arthur` is gone, which is what makes the gate
fail if core writes the name again. The row that stays is
`engine/support/run-analysis-report.ts`: the marker `Arthur report: <run>:<stage>`
is written into tickets and read back to find the comment to update, and the
two headings of those comments (`Arthur research complete`, `Arthur pull
requests ready`) are what the tenant's people read. All three name the tenant
this product is delivered to rather than the provider. Rewriting the marker
would post a second copy of every report already out there, and renaming the
headings is a product decision, not a refactor.

### `agent_tracing`: a description, not a client

A coding agent is a CLI inside a sandbox core provisions, so a tracing provider
cannot hold a client in our process: what it needs has to be in that sandbox
before the agent starts. The port is therefore a description of what a harness
needs (`packages`, `files`, `hookEnvironment`, `environment`, `hooks`) and core
applies it. The provider learns nothing about how a harness registers a hook,
and core learns nothing about the provider's protocol. A provider is told the
run (`runId`, `subjectKey`), its own run state, the harness, and, for a sandbox
that serves one node, `invocation` (`nodeId`, `attempt`), so traces from the
several sandboxes of one run can be told apart.

Four decisions inside that, each of which could have gone the other way:

- **The moments are named for what happened**, not for what a harness calls it:
  `prompt_submitted`, `tool_started`, `tool_finished`, `tool_failed`,
  `session_ended`. Core maps them per harness and silently drops one a harness
  does not have, which is how Codex, with no failure hook, takes the same setup
  that Claude does. A provider naming `PostToolUseFailure` itself would have
  been the Claude harness written into the contract.
- **Files land in the provider's own directory** (`$HOME/.aiw-tracing/<id>`),
  and a hook command writes `${TRACING_DIR}` where the path goes. Two providers
  shipping a `tracer.py` do not overwrite each other, and neither writes inside
  a harness's own configuration.
- **Nothing in tracing fails a run.** A package that will not install or a file
  that will not land leaves the run untraced and says so in the log, and a
  provider whose install failed contributes no hooks either, because a hook
  calling a script that never arrived fails on every tool call an agent makes.
  An untraced sandbox is still said out loud: `agent_tracing_off` is logged per
  sandbox with the harness and the reason (`no_tracing_integration` and
  `every_provider_declined` also carry the run and the node; `install_failed`
  carries the providers whose install failed).
- **A secret goes to the hooks, not to the agent.** `hookEnvironment` is
  written to `hook.env` in the provider's directory (mode 600, directory 700),
  and every hook command core registers for that provider sources it first.
  `environment` is exported into the agent's own env file, which everything the
  agent starts inherits: the test runner, the code under test, a script that
  prints its environment into a log. Arthur's key used to be there; it is now
  only in `hook.env`, and the agent env holds the run id and nothing secret.
  The sandbox has one user, so this keeps the key out of every inherited or
  printed environment, not away from an agent that reads the file on purpose.

The declared secret exception (decision 7) is held at one place: both files are
written through `writeFiles` and never put on a command line, because a command
is recorded with the sandbox and read back on a screen.
`sandbox/agents/tracing.test.ts` and `tracing-adapters.test.ts` hold it, the
second through the real Claude and Codex adapters with a sentinel value that
must appear in no command and in no agent env file.

**The foil is committed, not remembered.** `integrations/sdk/fixture-runtime.ts`
carries a second tracing provider that needs no run handle, no package, no file
and no hook: two variables and an endpoint, which is what an OpenTelemetry
collector asks for. It compiles and passes conformance in CI, so the day the
port grows a requirement only Arthur can meet, that file stops building, and
`engine/support/integration-tracing.test.ts` runs it through core's real plan
and install path, so the day core assumes a hook, a file or a task, the run id
it labels telemetry with stops reaching the agent. Writing it is what removed
the run handle from the port and put it on the runtime instead.

### Per-run integration state

Some providers cannot be asked twice for the same thing: this task API answers
a second request for `AWT-42` with `AWT-42.1`, so a run that asked once per use
would scatter itself over a new bucket every time. The contract therefore has
`manifest.runState` and `runtime.beginRun`, declared and served together, and
`ctx.run.state` wherever a block reads it.

Where it is created is the whole design:

- **At the run's first use of that integration, and of no other**, through
  `engine/support/integration-run-state.ts`, which every use goes through: the
  blocks it contributes and the tracing applied to each sandbox. Running one
  integration's block never creates another's state, a workflow that never
  touches an integration never asks its provider for anything, and a graph
  holding only the injection check still gets a task, which the old wiring got
  only because `prepare_workspace` happened to run first. The workflow keeps
  the answer per integration id, so a second use in the same invocation calls
  nothing.
- **Inside a step**, `createIntegrationRunStatesStep`, with no retries. The
  Workflow DevKit records the result, so a run that suspends for a person and
  resumes days later replays the recorded value instead of creating a second
  bucket. A plain function would have created one per replay.
- **One generic step, told which integrations by its argument**, and called
  exactly once per use: a step's identity is its module path plus its function
  name, so a step per integration would take its identity from an
  integration's id and moving that integration would strand every run
  suspended past it. The list is an argument, and that is the point:

  > **The number and order of the step calls a run makes must depend only on
  > its graph, never on which integrations the build contains.**

  A call per declaring integration satisfied the first half of that sentence
  and broke the second. The Workflow DevKit replays a run by its sequence of
  step calls, so shipping a second tracing integration, or dropping one, would
  have changed the number of calls before every sandbox and killed every run
  suspended past one with `ReplayDivergenceError`. Adding an integration would
  have been a drain event, which is the thing this plan exists to end. So a
  sandbox asks once for every tracing provider at once, **including when there
  are none** (one event-log row per sandbox is the price of never stranding a
  run), and a block asks once for its own integration, because which blocks run
  is a fact of the graph. Inside the one call each id is resolved on its own
  connection read, with its own 60 second bound and its own recorded outcome,
  so a provider that throws is recorded against itself alone and never spends
  another's time.
- **Five answers, not a nullable value.** `ready` carries the state; `none`
  means this build's integration declares none, which is a fact of the build
  and the same on every replay; `unavailable` means it declares one and is not
  usable on this deployment right now, and carries the cause (disabled,
  disconnected) so whatever reports it names something an admin can act on;
  `failed` means the provider was asked and produced nothing, recorded for the
  run because asking again could create a second bucket; `unreadable` means
  this deployment's own integration settings could not be read, so no provider
  was asked. The last two of those are about the moment rather than about the
  run, so neither is remembered: the next use asks again, and a connection
  restored mid-run is used. Collapsing `unavailable` into `none` is how "the
  engine created no state for this run" came to be printed at a person whose
  only problem was a switch somebody had flipped. An integration's own code
  still sees `ctx.run.state` as the value or `null`.
- **The cache holds the promise, not the answer.** Written after the await, two
  blocks reaching the same integration in one tick would both miss it and the
  provider would hand the run two buckets, which is the exact failure the step
  exists to prevent.
- **One name for the run.** `runSubjectKey` is the only place integration code
  is told what the run is about, so a block and a tracer in the same run cannot
  name it differently. It is the identifier of the run's ticket snapshot: the
  ticket key (`AWT-42`) for a ticket run, which is the name the old task was
  created under, and for a run with no ticket the identifier core gave its
  snapshot (a pull request run's subject key, a hash of a webhook delivery).
- **Only blocks and tracing see it.** Capability ports other than
  `agent_tracing` (an issue tracker, a VCS, messaging) do not receive run state:
  they are called by core on core's behalf, and nothing they do today needs a
  per-run handle. Persistent state an integration keeps across runs is a
  different thing and is not part of this contract.

### The injection check fails closed, and one verdict disappeared

`skipped` is gone from the block's `statusVariants`. The old block returned it
when Arthur was unconfigured, which is a security screen reporting that it did
not look, in a shape a graph could branch past. After this stage:

| Situation | Before | Now |
|---|---|---|
| Arthur disconnected or disabled | `skipped`, run continues | the run fails at dispatch with `integration_unavailable`, naming Arthur |
| The connection moved mid-run | `skipped` | the run fails at the block, reason `reconfigured` |
| No task on the engine | `skipped` | the block fails: nothing screened the content |
| The engine could not be reached | `skipped` when that stopped the task being created, a provider failure when it stopped the validation | the block fails with the network error either way, never read as a verdict |
| The worker could not read its own integration settings | could not happen: the settings were environment variables | the block fails, says the settings could not be read, and the run can be retried |
| Nothing bound to `content` | screened the ticket's description and comments | unchanged under a trigger whose runs carry authored text, and the editor says so on the field |
| Nothing bound and a run subject with no description and no comments | screened an empty string | the block fails at configuration and says to bind `content` |
| Nothing bound and a run whose subject core composed (a pull request with no ticket, a schedule occurrence) | screened our own sentence and reported `ok` | publishing is refused under those triggers, naming the input and the trigger, and such a run fails at the block |
| The engine evaluated no rule | `flagged`, `arthur_no_rules_evaluated` | unchanged |
| A flagged prompt | `flagged` | unchanged |
| A graph where nothing reads `status` | published, and the run continued whatever the verdict | refused at publish, naming the node |

The stored block type (`arthur_injection_check`), its `status` output and the
value `flagged` are unchanged, so a deployed graph that branches on them keeps
working with its bindings intact.

#### What the check reads when nothing is bound (`defaultFromSubject`)

The old block screened the ticket's description and comments when `content`
was not bound, and definition 28 on production binds nothing, so refusing an
unbound check would have stopped the one deployed graph that uses it. The SDK
therefore gained a closed, additive facility: a block input may declare
`defaultFromSubject`, a list drawn from the run subject's fields (`title`,
`description`, `comments`), and core fills an unbound input from those fields
before the block runs, in the declared order, comments as `author: body`,
joined by blank lines, which is what the old block did.
`packages/contracts/subject-default.ts` is the one place that text is built
and the one place the phrase describing it ("the run's description and
comments") comes from.

The subject is not always a ticket, and that is the whole difficulty. A run
with no ticket is given a ticket-shaped snapshot core composed itself: for a
pull request, its URL and head ref; for a schedule occurrence, the instruction
and the instants. A screen reading that by default screens OUR OWN SENTENCE,
finds nothing, and reports `ok`, while the pull request's body and its review
comments, which are the untrusted text on that trigger, are never looked at. A
screen that cannot fail is worse than no screen, because the author of the
graph believes it ran. So:

- **The snapshot says which it is.** `resolveWorkflowTicketStep` marks the
  branches it composes (`subjectTextIsPlaceholder`), and leaves a fetched
  ticket and a webhook delivery unmarked: a delivery's subject and description
  are the payload the sender sent, which is exactly what a screen is for.
  Absent means authored, which is what every recorded result from before the
  field existed was, so a replay is unaffected.
- **At run time**, an unbound `defaultFromSubject` input on a composed subject
  fails the block with the configuration error it already had for a subject
  holding none of the fields, worded so an admin knows the fix: this run
  carries no text a person wrote, bind the input. It never screens the
  placeholder and reports a verdict.
- **At publish time**, an unbound such input counts as satisfied only under
  triggers that guarantee authored text. The two halves are declared, exhaustive
  and gated against `TRIGGER_BLOCK_TYPES`, because a trigger nobody classified
  would default to "authored": ticket, plan approval and webhook carry text a
  person wrote; every pull request trigger and the schedule do not. A pull
  request run may carry a ticket key, but "may" is not a guarantee and publish
  is where a guarantee is what the author is owed. The refusal
  (`binding.subject_default`) names the input and the trigger, and only fires
  for a trigger that can reach the block. Definition 28 is a ticket trigger and
  still publishes with nothing bound.
- The input stays `required`. The graph validator counts a defaulted input as
  satisfied, so a graph that binds nothing publishes, and a graph that binds
  something screens exactly what it bound.
- The editor shows where the value comes from: an unbound field reads "Not
  bound, so it uses the run's description and comments. Bind a value to use
  something else.", its empty option reads "From the run's description and
  comments", and the Required badge is hidden because nothing is missing. The
  run's, never the ticket's: the same graph can be started by a delivery to a
  webhook, and a field that promises "the ticket's description" there is naming
  something the run does not have.
- The set is closed on purpose. An input that wants anything else binds it; a
  default that could name an arbitrary path would be a second binding language.

#### A verdict nobody reads cannot be published (`mustRead`)

A screen whose verdict nothing branches on is a screen the run walks past: it
runs, flags, and the next node starts anyway. The manifest can now declare, per
block, output fields a graph must read (`output.mustRead`), and the injection
check declares `status`. Graph validation refuses to publish a graph in which
no other node reads a declared field, with the issue `output.unread` on that
node:

> Block "injection" reports steps.injection.output.status and nothing in this
> workflow reads it, so the run would continue whatever it says. Add a Branch
> on steps.injection.output.status to decide what happens next.

The editor shows it live on the node, because the candidate validator runs the
deploy policy; the draft still saves, and only publishing is refused. Runtime
loads of already published graphs skip it, so a deployed graph that never read
the verdict keeps running until somebody edits and republishes it.

**Read means acted on, and that is checked on the graph rather than in the
text.** A mention proves nothing: a Transform formatting the verdict into a
sentence, a prompt holding `{{data:steps.check.output.status}}`, a Branch two
nodes after the agent has already read the flagged text, a Branch whose two
ports lead to the same place, and a reader only another trigger can reach all
mention the field, all published under the first version of this rule, and none
of them stops a flagged run. The rule is therefore structural: **on every
outgoing path of the declaring block the first node must be a Branch whose
condition reads that field of that block's output, and that Branch's two ports
must not reach the same set of nodes**, because a branch whose answers lead to
the same run decides nothing. A block with no outgoing path is left alone: the
run ends there. The reachability walk lives in `packages/workflow-graph`, beside
the rules that already walk the graph, and both refusals name the node and what
to add.

The deterministic prefilter moved with the block rather than staying in core.
It ran before the engine and still does, so a blatant override payload flags
identically on every run whatever a probabilistic classifier makes of it, and
it flags without a task and without a network call.

### What a contributed page can read

S7 left the seam open and named the recommendation: a read-only call the host
resolves through the integration's own worker runtime, never our database and
never our session. That is what `runtime.api` is, keyed by page id, and it is
the whole of what a page sees beyond what its own package ships.

- **The host waits for it** and hands the page the result as `data`. A page
  that fetched for itself would be a tab the cockpit could not cancel.
- **Three answers, kept apart**: the provider answered, this page has no reader,
  or we could not ask. Collapsing the last two is how "nothing to show" comes
  to read as "your provider is down", which on an evals page is the difference
  between nothing graded and nothing working.
- **A reader's error is redacted** against that connection's secrets and
  bounded, because a provider that echoes a key in an error body is normal and
  that body is what a person reads.
- The route is `/api/v1/integrations/<id>/pages/<page>`, readable by any
  signed-in role: it carries what the provider reports, never a connection
  value, and there is no write surface behind it.

### What core kept, and why it is not a leak

Three core reads now ask the registry instead of naming a provider:

- `integrationSecretValues()` feeds the redaction pass over MCP results and the
  credential scan a clarification snapshot runs. Core used to list
  `GENAI_ENGINE_API_KEY` by hand; an integration's variable names are its own,
  and a stored connection has no variable at all, so the set is resolved rather
  than listed. A tracing provider's key is inside a sandbox by design and an
  agent can echo its own environment, so dropping that coverage with the
  variable would have been a real regression.
- Integration settings that cannot be read mean "nothing usable" where the
  caller is doing something alongside the work (tracing a sandbox, drawing a
  page, where the page says the worker did not answer rather than that the
  provider is down). Creating run state is the exception: it records
  `unreadable` apart from `none`, because a block that needs the state must
  say the settings could not be read rather than that no provider is
  connected. `resolveUsableIntegrations` returns the two apart, and
  `usableIntegrations` is the "nothing usable" reading of it.
- `builtinCapabilitiesOfDeployment()` lost nothing: Arthur served no core
  capability, which is why it was the right provider to move first.

### What the next provider stage copies

1. Write the manifest against the variables the deployment already sets, and
   keep their meaning exactly (this one holds a full traces path, not a base
   URL; changing that would have pointed every deployment at the wrong paths
   while its card still read Connected).
2. Put the provider's client behind `ctx.http`, and let a connection test tell
   a refused credential (`{ ok: false }`) from a provider that could not be
   reached (throw).
3. Move the core block's directory into the package unchanged in type, output
   fields and status variants, so a deployed graph keeps its bindings.
4. Delete core's condition in `block-contract-resolver.ts`, its health section,
   its row in `CORE_HEALTH_SECTION_IDS`, its variables in `runtime-env.ts` and
   its prefix in the registry's `reserved-env.test.ts`, in one change.
5. Run `pnpm run gate:core-references -- --prune`, delete the
   `plannedIntegrations` entry, and write a reason for every row that stays.
6. Update `connection-shape.snapshot.json` and say in the stage report which
   step identities and which connection shapes moved, and assume the drain is
   total until a replay argument proves otherwise (below).

### The drain for this stage is total

Two step identities are gone (`blockArthurValidatePromptStep` and
`blockPrepareWorkspaceEnsureArthurTaskStep`) and one is new
(`createIntegrationRunStatesStep`). The old ensure-task step was recorded on
every run that reached a sandbox, configured or not, because it returned
`null` from inside the step. Any run suspended after that point replays
into a step call that no longer matches its event log, so every parked or
awaiting run on the deployment is affected, not a subset. Seven step
functions also changed their inputs (`blockPrepareWorkspaceProvisionStep`,
`blockInstallPromotedWorkspaceAgentsStep`, `blockProvisionAgentSandboxStep`,
`prepareHarnessAgentInvocationStep`, `restoreClarificationSandboxStep`,
`provisionDisposableReviewWorkspaceStep`, `runIntegrationBlockStep`); where it
was cheap the new value took the removed one's position rather than shifting
the rest, but a step queued with old arguments and executed by new code is
still wrong, which a total drain rules out.

Before this stage merges, run the drain protocol of
[the integrations plan](../plans/2026-09-18-integrations.md) ("The drain, as
somebody who was not here would run it") in full, on production and on demo.
It is written there rather than here because every stage of that plan runs it,
and it is written as steps because the two ways to get it wrong are both quiet:
`runs_stats` answers a page and cannot prove zero, and disabling the
definitions closes the triggers while leaving manual dispatch and
`workflows.dispatch` open.

## Slack, and messaging as a capability, decided in S9

Slack is `integrations/slack`, and messaging is something core asks for rather
than a product it names. The port grew two answers it did not have; the
conversation a ticket owns stayed core's; run control stayed core's; and one
block was renamed rather than deleted, which is the one place this stage
overrides the plan.

### The block was renamed, and the rename is expand, migrate, contract

Plan decision 17 deletes a removed block and re-authors the definitions that
used it. Filip overruled that for Slack on 2026-09-20, because two enabled
production definitions use `send_slack_message` and deploy day must not break
them. The rename is lossless by construction: there is no channel parameter
(the destination is the connection's), so `send_message` carries the same
`{ message?, sendOn? }`, the same single `out` port, the same
`allowsFailurePort`, and the same `statusVariants` `["ok", "skipped"]`.
Widening that set would silently change which stored branches match, which is
this repository's own trap.

The mechanism matters more than the rename:

- **The new build accepts the old type.** `canonicalizeWorkflowBlockTypes`
  (`@shared/contracts`) rewrites a node's type inside `parse`
  (`@shared/workflow-graph`), the one reader every graph goes through: a stored
  row, a candidate being published, a committed scenario snapshot, the run
  loader and the dashboard editor. It is settled there rather than at each call
  site because a call site that forgot would turn a working stored workflow
  into "this build has no such block", and two of them had already been missed
  when the rename was written per-reader. So the palette, the parameter
  schemas, the resolver, the editor and the run all see one name, an editor tab
  somebody opened before the deploy still publishes, and a publish writes the
  new type. The executor canonicalises the node it is about to run as well,
  because a run suspended before the rename replays a recorded plan that never
  went through `parse` and has to finish.
- **The stored rewrite is a separate, explicitly invoked one-off**
  (`apps/worker/scripts/rewrite-renamed-block-types.ts`), run after the new
  code is live, never from the build path. The reason is in this repository's
  own AGENTS.md: the worker's `build` runs `db:migrate` and a preview
  deployment reads production's database, so a rewrite carried by a build
  migration would rewrite production's definitions from a preview deploy of an
  unmerged branch while production still ran code that had never heard of the
  new type. It rewrites every version, not only the deployed one, so opening
  history, comparing and rolling back keep working; it is idempotent; and it
  writes one data-modifying statement, because neon-http has no interactive
  transaction
  and a loop could leave one definition half rewritten.
- **Until the rewrite runs, a revert to the previous build is safe.** That
  window is the point of doing it this way, and it belongs in the release
  notes.
- **The alias is removed in R1**, after the rewrite is verified on production
  and on the Arthur tenant. `RENAMED_WORKFLOW_BLOCK_TYPES` is the one place to
  empty; it carries that condition in its own comment so it cannot quietly
  become permanent.

### `ok` means delivered

`MessagingAdapter.notifyForTicket` still never throws, which is what lets a
notification be best effort. It now answers `MessagingDelivery` instead of
nothing, and that is the whole of decision 12's line between a block and a
notification: the block reports `skipped` with the reason (nothing to say, no
pull request yet, or the provider refused and why) where it used to report
`ok` for a message nobody received, and an author who wants the run to stop
branches on `skipped` exactly as before. The notifications that are not a
block (started, failed, clarification, plan approval, cancel) read the same
answer and ignore it, because a notification must never change a run's
outcome. `reason` is an optional output property, so a graph published before
it existed binds what it always did.

### The conversation is core's row, and the handle is opaque

`thread_parents` is keyed by ticket, not by run, and it outlives the run that
started it. It stays in core and the provider receives a `MessagingConversation`:
the handle core remembers, `remember` and `forget`. Three things follow.

A second messaging provider needs no table and no migration. The rows written
before this stage hold a Slack message timestamp, which is exactly what the
Slack provider expects, so nothing was migrated and a thread started yesterday
is the thread today. And a handle a provider no longer recognises is not an
error: it forgets it and anchors a new one, so a deployment that switched
providers heals itself at the first event rather than at a migration.

The slash command's `reset` reads and clears the same row, and it does so
through core (`services/run-control`), never through an integration reaching
into our database.

### Run control is core's; the integration verifies, parses, renders, delivers

The slash command used to decide things (which runs are active, cancel this
one) and speak Slack (ephemeral replies, `response_url`, the allowlist) in one
place. Split on that line, the surface is `RunControlCommand` and
`RunControlAnswer` in `@shared/contracts`: closed sets of values, never
sentences, because a provider handed prose could only paste it and the second
provider's copy would be ours. `list`, `status`, `cancel`, `redis summary`,
`redis inspect` and `redis reset` all come out the other side; the help text
and the unknown-command reply never reach core at all, because the syntax is
the provider's own.

The webhook slot is two calls rather than one, and that is the three-second
acknowledgement in the type: `receive` verifies the signature over the **raw
body** and returns what the provider gets back now; core then runs the command
and hands the outcome to `deliver`. The route therefore holds the bytes and
parses nothing, because a route that parsed JSON first would kill every
form-encoded slash command. A stale or bad signature is 401 and a missing
signing secret is 503, which is the difference between a request that is wrong
and a deployment that was never given what it needs to read one.

`deliver` is told about a failure as well as an answer. Without that, a
handler that threw left the person reading "Working on ..." for ever, which is
the first of the three defects this stage fixed on the way. `deliver` is
optional on the contract: an integration whose webhook never produces a run
control command should not have to write an empty function. When one is
missing, core still runs the command, because that is what the person asked
for, and logs `integration_webhook_reply_undeliverable` rather than swallowing
it.

### Availability, and what a capability an integration serves means

`slackConfigured` is gone from the resolver. `send_message` and the chat half
of `investigate` ask `coreCapabilityIssue("messaging", integrations)`, which is
the same function an integration's own block goes through, so the palette
cannot say one thing and a run another.

One rule changed shape. S4 refused a capability that only an integration
declared, because execution handed a block whichever adapter core built from
its own variables. That refusal now applies only to capabilities core cannot
yet reach through an integration (`INTEGRATION_SERVED_CAPABILITIES` in
`integration-availability.ts`); S9 added `messaging` to that set in the same
change that taught execution to resolve it
(`engine/support/messaging.ts`), and S10 to S13 each add theirs the same way.
`builtinCapabilitiesOfDeployment()` lost `messaging`, which is the shrink
decision 10 describes.

Resolution happens per call, not once per process: disabling an integration is
the kill switch an admin reaches for, and a sender built at start-up would
keep posting for as long as the process lived. Two usable providers with none
selected is a named refusal, never a silent pick of the first.

A capability nothing usable serves is refused by name where a name exists. An
integration that ships and declares the capability but sits disabled or
unconnected is said out loud with its state ("Test Chat would provide the
messaging capability this block needs, but is switched off"), and the flat
"nothing provides it" is kept for a build that ships no such integration at
all. The sentence is shared by every capability, so S10 to S13 inherit it: an
author reading "nothing provides messaging" while the Integrations page shows
Slack sitting there is the one reading that sends somebody looking for a second
provider they do not need.

### A run is pinned to the provider it started with, core blocks included

S4 pinned the connection of every integration a definition's nodes reach, and
read that reach from block types alone. A core block that consumes a capability
has no such type, so `send_message` and `investigate` reached a provider that
the pin knew nothing about: an admin who changed the channel while runs were in
flight moved where those runs posted, and nothing said so. The mechanism built
to notice exactly that change did not cover the blocks most likely to feel it.

The reach now has two halves, and `integrationsUsedBy` reads both: an
integration's own block type, and the active provider of every capability a
core block consumes. What a core block consumes is stated once, in
`coreBlockCapabilities` (`engine/definition/integration-availability.ts`), and
read by three callers that used to derive it separately: the palette's
availability, the run's pins, and the dispatch blocker. Deriving it three times
is how a palette and a run come to disagree about one deployment, which is the
failure this whole file keeps returning to.

Worth stating plainly for S10 to S12, because the cost of getting it wrong
grows with every stage: after those stages almost everything a run does is a
core block over a capability. Had the pin stayed blind to them, by S12 it would
have covered nearly nothing while still looking like a guarantee.

Where the comparison happens is not a detail. It reads this deployment's
integration settings, so it cannot happen in workflow scope, where the Workflow
DevKit allows no Node module; the first attempt put it there and the bundle
guard refused the build with four modules named. It happens inside the step
that sends (`notifyTicket`), which takes the run's pins and answers with a
delivery that can say the provider moved. A block stops the run on that answer,
with `integration_unavailable.<reason>` and the sentence an admin acts on; a
notification ignores it exactly as it ignores any other delivery failure. That
is the line decision 12 asks for, and it now lives in one type
(`CoreMessagingDelivery`) rather than in two code paths.

One boundary is deliberate: the pin guards sending, not the research block's
search. Sending writes into somebody's channel, and a run that writes to the
wrong one cannot be undone by reading the trace; searching is a read that
already reports what it could not search, in the theory a person reads. Pushing
the pin into the retrieval step would change that step's recorded input for
every run in flight, which is a real cost for a much smaller guarantee. If a
later stage gives that step a reason to change anyway, this is the moment to
reconsider.

### S10 makes version control a per-repository capability

S10 keeps provider ids as permanent stored values and opens the type to every
id the generated registry supplies. A repository selects its provider; there
is no deployment-wide active VCS choice. Core resolves that repository through
the `vcs` capability inside the step making the call, where the run's S9
connection pin can be compared with current deployment settings.

The shared head contract now carries only a green, red or running check state
and generic failed checks. Each integration maps its native CI model onto it.
Gate status references are opaque records minted and interpreted by the same
provider. Core stores and returns them without parsing. Stored check-trigger
definitions are upgraded on read from the two former producer filters into
`trustedProducers`; their rows are not rewritten. The upgrade lives in
`canonicalizeWorkflowBlockTypes`, the reader every stored graph goes through,
so dispatch, validation, the editor and a replaying run see the same list, and
a filter a node never set keeps the default it had.

The GitLab package owns its adapter, repository listing and profile read,
health checks, webhook verification and normalization. The generic route keeps
`/webhooks/gitlab` stable and core dispatches only normalized events. Existing
environment variables remain connection fields. `GITLAB_PROJECT_ID` continues
to select one legacy project. It may be removed only after R1 confirms every
deployment has activated the repository catalog and a separate compatibility
change is approved. `VCS_BOT_LOGIN` applies only when exactly one VCS provider
is configured and retires in S11, after the second provider moves into its
integration and both provider-specific bot fields are available.

Decision 19 is implemented as a constraint-only migration. The repository and
workflow-owned-branch provider checks are dropped without rewriting rows.
Import, save, enable and catalog activation validate provider ids against the
registry first, so an unsupported id produces an actionable sentence instead
of a database error.

### What the research path does when nobody can search

`searchMessages` is optional on the port and total on the sender: a provider
without it answers `unsupported`, a deployment with no provider answers
`not_connected`, and settings this deployment could not read answer
`unavailable`. That third one is not pedantry: "nothing is connected" sent in
front of an admin whose Slack is connected is an instruction to go and connect
it again, so the sender keeps the two apart in both vocabularies, the sentence
a person reads and the reason the search port carries. Neither is an error.
`investigate` reports what it could not read in the same "Not searched" line it
already had, and reasons from the evidence it has.

Its parameters still spell the provider as data (`providers: ["jira", "slack"]`,
`slackChannels`, `slackLookbackDays`): those are values inside graphs people
already published, and they leave with the block in S12. The one place outside
the block that reads that value takes it from the block
(`INVESTIGATE_CHAT_PROVIDER` in `engine/blocks/investigate/manifest.ts`), so the
availability resolver names no provider at all and the core-reference gate can
stay absolute rather than learning an exception.

### Two named exceptions in the gate, and one loss

`plannedIntegrations.slack` is gone, so the gate fails if core writes the name
again. Four entries stay, covering nine paths:

- Seven paths are `investigate`'s parameter vocabulary, listed above, removed
  by S12. The block's own manifest is one of them, and the availability
  resolver is no longer among them.
- One is the `send_slack_message` compatibility alias in the shared workflow
  contract. It has its own removal point, R1, once the rewrite of stored graphs
  has run and been verified: sharing a removal point with the `investigate`
  rows would have retired the alias three stages too early or kept the
  vocabulary three stages too long.
- One is `engine/blocks/leak-review/execute.ts`, whose secret scanner names the
  SHAPES of credentials it looks for so the finding a person reads says which
  kind of token leaked. It would be worth keeping if this product never talked
  to the provider, so no stage removes it.

The loss is the health check "Slash command signature", which reported whether
a signed command had arrived recently. It was answered from observations core
recorded under a scope derived from the signing secret, and the secret is the
integration's now; keeping it would have meant core reading an integration's
credential to key a health row. The two live probes the package declares (the
bot token, and delivery to the configured channel, proved the way a real
notification is) are better evidence, and the connection row core adds to every
integration says whether the secret is set at all.

### The other two defects this stage had to fix

**A token with no channel was a silent no-op.** `createAdapters` fell through
to an adapter that logged and dropped everything. Both fields are required on
the manifest now, so S2's resolver reports Failing and names the missing
variable, which is what an admin can act on. Because the channel is a
non-secret connection value it enters the configuration fingerprint by
construction, so changing it stops runs in flight with `reconfigured`: correct,
and the impact preview before saving says so.

**The channel delivery probe could leave rubbish in somebody's channel.** It
schedules a message sixty days out and deletes it. The delete is retried, an
already-deleted message counts as cleaned up (two overlapping scans race
there), and a cleanup that still could not be done reports `degraded` with the
date the message would arrive and where to delete it, rather than reporting
"delivery verified" over a message left in the queue.

### The drain for this stage

`notifyTicket` (`engine/steps/ticket-analysis.ts`) keeps its module path and
its function name and changes its recorded result from nothing to a
`MessagingDelivery`. A run that completed that step before the deploy replays
the recorded nothing, so the block reads `undefined` where it now expects an
answer. The executor takes that as delivered
(`engine/agent-workflow.ts`, `case "send_message"`): the block reported `ok`
unconditionally before, so `ok` is the only answer that leaves such a run on
the branch it was already taking, and the alternative is a run that dies on the
way back from a deploy nobody told it about. Guard:
`engine/tests/send-message-run.test.ts`, "keeps a run suspended before this
deploy on the path it was already taking". The drain below is still the
intended route; this is what happens to a run the drain missed.

No step identity is added, removed, moved or renamed.
`blockInvestigateRetrievalStep` keeps its identity and its recorded input
shape, and its inner reads changed.

That is a smaller drain than S8's, which is total for this branch anyway. The
branch's drain is run once, before it merges, under the protocol in
[the integrations plan](../plans/2026-09-18-integrations.md).

### The pin became a column too, and why S2's reasoning was incomplete

S2 decided the pin lives in the run's own workflow state and that no run table
gets a column, because replay restores it without a read and a column would say
the same thing for the price of a migration. S10 reverses the second half of
that: migration `0073_run_integration_pins` adds a nullable jsonb
`integration_pins` to `workflow_runs`.

The hole in the original reasoning was an assumption nobody stated: that every
reader of a pin is the run. Reconciliation is not. It is a cron pass over rows
that closes the PR checks a dead run left open
(`engine/runtime/pr-external-resources.ts`). There is no workflow state to
replay, because the run it acts for is over, and it still has to talk to a
provider, because closing a check means writing a verdict onto somebody's
merge request. Without the column it wrote that verdict through whichever
provider was connected at reconcile time. Once GitLab is a connection an admin
can edit rather than an environment variable a deploy sets, "whichever provider
is connected now" is a thing that changes while checks are still open, which is
what made the cost real enough to pay the migration for.

What did not change: workflow state is still where a live run reads its pin, so
no step's recorded input or result moved. The column is a second copy for
readers outside the run, written once (`coalesce(existing, excluded)` in
`db/repositories/runs/telemetry.ts`) so a replay cannot rewrite what the run
started with.

Nothing is backfilled, so every run row written before this deploy carries NULL
and its pins cannot be recovered. That is safe here only because this branch
merges after a total drain, and the code says so rather than leaving it to be
reconstructed: `RunIntegrationPins` in `engine/support/vcs-runtime.ts` names the
absence and the reconciler logs
`pr_check_reconcile_without_integration_pins` before proceeding for such a run.
That log line is the check on the drain: if it appears in production after the
drain, the drain did not hold.

The cheaper alternative, refusing to reconcile a check for a run with no pins,
was rejected: it leaves a pull request with a check stuck pending forever, which
is a worse outcome for the person waiting on it than closing it through the
provider they are almost certainly still using.

### One GitLab host per deployment

The connection model stores one active connection per integration, so this
stage supports one GitLab host per deployment. Repository identity remains the
pair `(provider, path)` and does not include a host. Changing the GitLab host
therefore retargets existing catalog rows with the same paths instead of
creating a second namespace. Multiple GitLab hosts require a new connection
identity in repository keys and are outside this decision.

## GitHub becomes an integration, decided in S11

S11 is the smaller half of the version control move. S10 made `vcs` a
capability, opened the provider id to the registry and shipped GitLab as a
package; what was left was GitHub itself, which is every deployment's actual
provider, plus the proof that nothing provider-shaped survives in core.

### What moved, and what core deleted

`integrations/github` owns App authentication, the REST and GraphQL adapter,
repository profiles, repository listing, the skill source client, the webhook
translator and three health probes. Core deleted `adapters/vcs/github.ts`,
`github-auth.ts`, `github/profile-source.ts`, `create-vcs.ts`,
`infra/github-webhook-sig.ts`, `routes/webhooks/github.post.ts`,
`services/triggers/github/` and the GitHub half of
`services/dispatch/trigger-events.ts`, `services/system/probes.ts`,
`services/system/collect.ts`, `services/settings/*` and `infra/runtime-env.ts`.
`infra/vcs-config.ts` keeps its name and exports the process environment, which
is what several hundred modules import it for, and describes no provider at all.

`createVCSForRepository` is gone rather than generalised. There is no `if` on a
kind left to generalise: `resolveIntegrationAdapter`
(`engine/support/vcs-runtime.ts`) asks the registry for the manifest of the
repository's provider and refuses a provider no integration in this build
serves. That refusal is the whole of the former core half.

### The private key is read, not decoded

`GITHUB_APP_PRIVATE_KEY` has always been base64, decoded with
`Buffer.from(value, "base64")`. That call does not throw on input that is not
base64: it drops every character outside the alphabet and returns whatever
bytes it can salvage. An admin pasting the `.pem` file GitHub downloads into a
dashboard field would therefore have saved a few hundred bytes of rubbish, seen
the connection accepted, and found out hours later from a message about a bad
key rather than about what they pasted.

Both forms are accepted and normalised at the edge (`integrations/github/auth.ts`),
and a value that is neither is refused with a sentence naming both. Accepting
rather than refusing one of them is deliberate: the admin holding the file has
no reason to know we ever wanted base64, and the two cannot be confused, since a
PEM says so on its first line and `-` is not in the base64 alphabet. A value
that arrives with its newlines written as backslash-n, which is what survives a
shell or a deployment variable editor, is read as the same key.

The refusal lands before anything is stored as the active connection: saving
runs the connection test first and activates only on a pass
(`services/integrations/authoring.ts`), and the test reads the key before it
sends a single request. A silent mangle is not an outcome of either path.

### No App install redirect yet

Connecting through the dashboard means supplying the App ID, the installation ID
and the private key, the same three values the environment supplies. The proper
product answer is GitHub's own install redirect, which needs an App registered
against a public callback URL: a different piece of work, and a bad one to start
in the middle of a refactor. Until then an admin creates the App by hand,
following `docs/runbooks/GITHUB-APP-SETUP.md`, and pastes the three values.

### The legacy environment keeps working, and when it dies

Every variable core read is a connection field on the manifest, so a deployment
configured entirely by its environment is Connected with nothing to touch:
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_LOGIN`, the `GITHUB_OWNER`/`GITHUB_REPO`
pair and `VCS_BOT_LOGIN` under the meaning S10 gave it. The three legacy fields
are named legacy on the form so nobody configures a new deployment with them,
and they die in R1, with the tenant's re-authoring, once no deployment reads
them.

Two startup checks left with them, and this is the trade. The worker used to
throw at boot on a half-configured App and on a missing webhook secret. It no
longer reads those variables, so the Integrations page reports the same two
facts instead: the connection row names the missing variable, and the App
webhook check says a secret is not set. Loud at boot became visible on a page,
which is the same trade S10 made for GitLab.

### The App webhook check moved, and one assertion narrowed

Core's `github.webhook-delivery` probe asked GitHub's own App API which events
the App subscribes to, whether TLS verification is on, whether the hook URL is
this worker's, and what status the last delivery got. Events, TLS and the last
delivery are the integration's `webhook` probe now, the 401 sentence included,
since a status code GitHub recorded is the one this worker answered with.

The URL assertion narrowed. The integration cannot know this deployment's
public address, so instead of asserting the hook points here it prints the URL
GitHub holds. The failure it caught is still caught: core's own
`webhook-delivery` check reads the deliveries that actually arrived and turns
degraded within the week when none does, and the two rows read together say
which deployment the App is talking to.

### `repositories` on the manifest, and the three branches it removed

Core branched on the name `github` in three places that had nothing to do with
credentials: which provider a pasted link belongs to, where a repository path
ends inside that link, and whether an operator's `owner/name` is well formed. A
fourth provider would have had to be added to each.

A `vcs` manifest may now declare `repositories`: the public `host` whose links
name it, and whether its paths may nest. GitHub declares `github.com` and no
nesting; GitLab declares nesting and no host, because a self-hosted instance is
the normal case and its host is the connection field an admin fills, whose
default core already read. A provider that declares neither gets the general
case, which is the safe one: cutting a nested path short would point at a
different repository, while a segment too many is only ever refused.

### Who decides that a push is ours, and the divergence this closes

S10 gave GitLab's normalizer a rule GitHub never had: drop a push whose author
is the automation account. Core's own rule, which both providers used before
S10, is `isWorkflowGeneratedPush`: the head a run published, with identity as a
backstop for a recorded head that lags. It needs the ownership record, which no
integration can see.

Both normalizers now emit the push and core decides, which is one rule in one
place for every provider. The identity-only drop was also stricter than the
rule it replaced, silencing a push by that account to a pull request no run of
ours owns. Nothing in the suite went red when it was removed, which says the
S10 change was never covered.

The other half of that seam was core reading GitLab's word for a push
(`legacyGate.action === "update"`) to decide whether to ask about the legacy
gate. The reception carries `headMoved` instead, which both integrations set,
because matching one provider's spelling leaves every other provider's push
unasked about.

### The defect the S10 gate predicted, found and fixed

The S10 skeptic noted that core minted a GitHub-shaped check handle in
`services/dispatch/trigger-events.ts` beside the adapter's own, with no test
binding a real event through the real comparator. Writing that test found the
two disagreeing: the webhook fell back to the sender's login for the handle's
owner while the adapter fell back to the empty string, so a check run whose
`app` carries no slug, which is exactly what GitHub's published `completed`
example is, minted two handles that never compared equal. Every such failed
check would have bound to nothing and been recorded as a stale head, with the
autofix path silent and no error anywhere. Both handles are minted in the same
package now and the test
(`engine/support/trigger-handle-binding.test.ts`) builds each side from real
bytes through real code.

`resolveIntegrationAdapter` also took `resolved.usable[0]` where the filter
happened to leave one entry. It finds by id now: the day a caller widens that
filter, position would send a repository's work to another company's server.

### What the stage is proved by

`engine/support/third-vcs-provider.test.ts` registers a provider core contains
nowhere and drives the real catalog validation, the real path rules, the real
link parser, the real per-repository selection and the real automation account
lookup against it, with a second unknown provider connected at the same time so
that "the repository's provider" and "the only provider" are different
sentences. A registry holding exactly the two we ship proves nothing here,
because a surviving branch on a known name passes that.

## Change log

Additive changes to `@integrations/sdk` after S0, newest first. Each entry
names the stage, what was added, and why the context or a port needed it.

| Date | Stage | Change | Reason |
|---|---|---|---|
| 2026-09-22 | S13 | `memory` designed and unreserved: `MemoryAdapter` with `recall` and `observe`, the optional `MemoryStoreAdapter` behind `adapter.store`, and `MemorySubject`, `MemoryScope`, `MemoryEntry`, `MemoryRecall`, `MemoryObservation`, `MemoryObserveRequest`, `MemoryWrite`, `MemoryFailure`, `MemoryStoreListing` and the stored-document types | The capability's port, reserved in S0 for this stage. Additive: a reserved id becoming providable makes nothing that compiled stop compiling. THE RUN-FACING HALF IS OBSERVATIONS IN, RENDERING OUT. "Read the document, merge it and write it back with the version you read" is a shape only our own store can implement, because a hosted engine does the merging itself and that merging is the product: Mem0 runs supersede and merge over what is added, Zep invalidates the edge a new fact contradicts. "Add, update by id, delete by id" is the opposite failure, where two runs both add and nobody reconciles. So core says what a run learned and asks what is known, and today's pure functions (parse, dedup, retract, stamp, evict, compare and swap) moved into the built-in provider. THE ADMIN HALF IS A SECOND INTERFACE, because listing, reading and erasing a stored document is a different caller with a different need, and conflating them is how the id-shaped port returns. It is optional: an engine that can search but not enumerate serves runs perfectly well, and core then says the store cannot be listed here rather than showing an empty one. `MemoryWrite.stored` is acceptance, not read-after-write: Mem0 answers an add with an event id to poll and Zep with 202 and a task id. Two decisions a provider may ignore and stay correct: `derived` marks an observation nothing can re-derive once its run is over, and `exclude` asks the provider to leave out what the caller already holds, so "the same thing said twice" stays one judgement. |
| 2026-09-21 | S11 | `IntegrationManifest.repositories`, with `host` and `nestedPaths`, and the type `IntegrationRepositoryShape` | Core branched on the name `github` in three places that decide nothing about credentials: which provider a pasted link belongs to, where a repository path ends inside that link, and whether `owner/name` is well formed. A fourth provider would have had to be added to each. Optional and absent by default, and a provider that declares nothing gets the general case (any host, paths may nest), so every manifest written before this is unchanged. |
| 2026-09-21 | S11 | `RepositorySkillSource` and `RepositorySkillTreeEntry`, and the optional `skillSource()` on `VcsIntegrationAdapter` | The harness skill importer held a second GitHub API client inside core, with the four provider calls it needs already behind an interface. Those four are the port now; everything a skill import decides (which paths are containers, what a valid `SKILL.md` is, how an artifact is hashed, what is persisted) stays core's. `getFiles` answers `Uint8Array` rather than Node's `Buffer` because this entry is bundled for a browser. Optional: an adapter without it simply cannot serve a skill import, and core says so naming the provider. |
| 2026-09-21 | S11 | `headMoved` on the webhook reception's `legacyGate` | Core read `action === "update"`, which is GitLab's word for a push, to decide whether to ask its ownership record about a delivery before starting the legacy gate. Every other provider's push went unasked about. The flag says the fact rather than the spelling. Optional, so an integration that never reaches the legacy gate is unchanged. |
| 2026-09-21 | S11 | `CORE_HEALTH_SECTION_IDS` lost `github` | Core's own GitHub health section is gone, so the id is the integration's to take. The shrink that entry describes. |
| 2026-09-21 | S9 | `CoreMessagingDelivery`, core's own widening of the port's answer, and `pins` on `notifyTicket` | The port says whether a message arrived. Only core can say whether the run may still use this provider at all, so that fact is core's to add rather than the port's to carry. It travels on the step's answer because the comparison reads deployment settings and therefore cannot happen in workflow scope, which the bundle guard proved by refusing the first attempt. A block stops the run on it; a notification ignores it. |
| 2026-09-20 | S9 | `webhook`, the reserved slot released: `IntegrationWebhook` with `receive` and an optional `deliver`, `IntegrationWebhookRequest`, `IntegrationWebhookReception`, `IntegrationWebhookResponse`, and conformance code `webhook_receive_missing` | S0 reserved it for the stage that had a provider to design it against. `receive` and `deliver` are two calls because a slash command has about three seconds to be acknowledged and the work happens after; `deliver` is told about a failure as well as an answer, because a handler that threw used to leave the person reading "Working on ...". The request carries the raw body, since that is what a provider signs. Additive: the slot was `never` and no manifest field changed. |
| 2026-09-20 | S9 | `MessagingDelivery` as the return of `notifyForTicket`, `MessagingConversation` as its third argument, `MessagingTicket` in place of a bare key, `MessagingSender` as what core calls, and the optional `searchMessages` with `MessageSearchQuery`, `MessageSearchMatch`, `MessageSearchSkip`, `MessageSearchOutcome` and `MessageRetrievalFailure` | The port never threw and therefore never said whether anything arrived, so a block reported `ok` for a message nobody received. It answers now. The conversation a ticket owns is core's row and is passed in as an opaque handle, so a second provider needs no table and the old Slack timestamps keep working. The ticket arrives with the link core built, because which tracker this deployment talks to is not a chat provider's business. Search became an operation of the capability so the research path stops importing a provider. Not additive for a provider: every messaging adapter changes signature, which is why it landed with the only one. |
| 2026-09-20 | S9 | `RunControlCommand`, `RunControlAnswer`, `RunControlOutcome` and their values re-exported from the SDK, alongside `RunPullRequest`, `pullRequestRef`, `pullRequestRepoLabels` and `JsonValue` | An integration may not depend on `@shared/contracts` directly (the boundaries gate and the conformance dependency check both say so), and a messaging provider has to render a run control answer and a pull request list. The SDK is where an integration reaches everything. |
| 2026-09-20 | S9 | `CORE_HEALTH_SECTION_IDS` lost `slack` | Core's own Slack health section is gone, so the id is the integration's to take. The shrink that entry describes. |
| 2026-09-19 | S8 | `@integrations/sdk/fixtures`, a second entry point exporting the OpenTelemetry-shaped tracing foil (`otelFixtureManifest`, `otelFixtureRuntime`) | Core's own test runs the foil through the real plan and install path, and a test in `apps/worker` may not reach into the package's source files. Test support only; nothing in production imports it. |
| 2026-09-19 | S8 | `IntegrationPageData` (in `@integrations/host-ui`): the unavailable answer carries `cause` (`worker`, `not_connected`, `provider`) | A page has to tell "the worker did not answer" from "this provider could not be read", and a message string is not something a page may branch on. Additive for a page that ignores it; required on the host, which is core alone. |
| 2026-09-19 | S8 | `IntegrationBlockOutput.mustRead` and, in `@shared/contracts`, `WorkflowBlockContract.output.mustRead`; conformance code `block_must_read_undeclared` | A security screen whose verdict no node acts on is a screen the run walks past. The manifest names the fields; publishing refuses a graph unless the first node on every path out of the block is a Branch on that field whose two answers reach different nodes (`output.unread`). Optional and absent by default. |
| 2026-09-19 | S8 | `defaultFromSubject` on a block input (`WorkflowBlockInputContract`), the closed set `WORKFLOW_SUBJECT_FIELDS` (`title`, `description`, `comments`) and `subjectDefaultText` in `@shared/contracts`; conformance code `block_input_default_invalid` | The injection check screened the ticket's description and comments when nothing was bound, and the one production graph that uses it binds nothing. A required input may now name where its value comes from when unbound; core fills it before the block runs and the validator counts it as satisfied, but only under a trigger whose runs carry text a person wrote: a run whose subject core composed refuses instead of screening it (`binding.subject_default` at publish, a configuration failure at run time). Optional and absent by default. |
| 2026-09-19 | S8 | `AgentTracingSetup.hookEnvironment` and `AgentTracingInvocation.invocation` (`nodeId`, `attempt`) | A tracing key does not belong in the environment everything the agent starts inherits; `hookEnvironment` reaches only the hook commands. `invocation` tells the several sandboxes of one run apart. Both optional. |
| 2026-09-19 | S8 | `agent_tracing` designed and unreserved: `AgentTracingAdapter`, `AgentTracingSetup`, `AGENT_TRACING_EVENTS`, `AGENT_TRACING_DIR_TOKEN` | The capability's port, reserved in S0 for this stage. Additive: a reserved id becoming providable makes nothing that compiled stop compiling. A block may now list `agent_tracing` in `requires.capabilities`, the type accepts it, and the requirement decides whether the block is offered at all; the block holds no adapter for it (core applies it to a sandbox), which `RequiredCapabilities` says by intersecting with the capabilities a block can reach, so `ctx.capabilities.agent_tracing` does not exist. |
| 2026-09-19 | S8 | `manifest.runState`, `runtime.beginRun`, `IntegrationRunState`, `IntegrationRunStart`, and `state` plus `subjectKey` on `ctx.run` | A provider whose per-run handle cannot be re-derived needs it created once and carried; this one numbers a second task for a name that already exists. Core creates it in one step call per use, whatever the build ships, because the number and order of a run's step calls must depend only on its graph: a call per declaring integration would make shipping a tracing integration a drain event. Optional and absent by default, and required in the runtime exactly when the manifest declares it, so every manifest written against S0 is unchanged. Two parts of it are not additive for everyone and are recorded as debt in "Debt the moved ports carry": the two new required fields of `IntegrationRunIdentity`, and `IntegrationRuntimeDefinition` and `IntegrationRuntime` becoming type aliases over a conditional type. |
| 2026-09-19 | S8 | `runtime.api`, the reserved slot released: one read-only reader per declared page, and `IntegrationPageData` on a page's props in `@integrations/host-ui` | S7 left the question of what a contributed page can read to the first provider with data in a page. A reader keyed by page id means a page's data comes from its own package through its own connection, never our database or session. Additive: the slot was `never` and no manifest field changed. |
| 2026-09-19 | S8 | `CORE_HEALTH_SECTION_IDS` lost `arthur` | Core's own Arthur health section is gone, so the id is the integration's to take. This is the shrink that entry describes. |
| 2026-09-18 | S5 | `CORE_HEALTH_SECTION_IDS` and `RESERVED_HEALTH_CHECK_ID`, both refused by conformance | Additive: no manifest field changes and nothing already written stops compiling; conformance refuses two more names. An id core's health page still holds (`github`, `jira`, `database`) would draw a second section for the same word, and a health check called `connection` would collide with the one core adds to every integration's section. `CORE_HEALTH_SECTION_IDS` shrinks: the stage that moves a provider out of core deletes its row in the same change as core's section, which is how the provider's own integration comes to be allowed to take the name. |
| 2026-09-18 | S4 | `secretsKeyMaterial` exported from `services/integrations` | The generic integration step resolves a connection through the same key material every other caller uses; a second reader of `INTEGRATION_SECRETS_KEY` in the engine would be a second derivation of the thing S2 exists to derive once. Additive: nothing that existed changed. |
| 2026-09-18 | S2 | `ConnectionField.identity` | An integration whose fields are all secret has a constant configuration fingerprint, so replacing a Slack bot token with another workspace's would read as a rotation and a run in flight would post into the wrong company's channels. The flag marks a secret that names the account; its value enters the pin as a digest, never in the clear. Optional and absent by default, so every manifest written against S0 is unchanged. |
| 2026-09-18 | S1 | `ErasedIntegrationRuntime` and `ErasedIntegrationCall` | The generated registry has to hold runtimes whose types come from manifests core does not know statically. `IntegrationRuntime<IntegrationManifest>` is not that type: a block executor typed against a literal block type is not assignable to one typed against `IntegrationBlockManifest`, because its parameters are contravariant, and the compiler says so. The erased interface keeps the keys and the results and erases only the parameters, so core can list an integration's blocks, health checks and capabilities and use what each call returns, and S4 narrows the call once where it builds the context. |
| 2026-09-18 | S0 | Contract created | This record |
