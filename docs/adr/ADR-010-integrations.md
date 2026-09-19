Status: current
Last-verified: 2026-09-19

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
  `VCS_BOT_LOGIN` is read by both VCS providers and applies only when one
  provider is configured
  (`apps/worker/src/adapters/vcs/vcs-bot-identity.ts:11-23`), which is a rule
  across integrations, not a property of one field. S10 keeps it in core or
  retires it.
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
moved with them. Each is removed by the stage that moves its provider.

| Leftover | Where | Owner |
|---|---|---|
| `searchTicketSummaries(jql, ...)` takes a JQL string; `searchTickets(query)` is JQL in practice | `issue-tracker.ts` | S12 |
| `IssueTrackerTransitionTarget.transitionId` is a Jira transition | `issue-tracker.ts` | S12 |
| `downloadAttachment` returns a Node `Buffer`, a Node type in a browser-safe package | `issue-tracker.ts` | S12 |
| `PullRequestHead.headPipeline*` are GitLab's, `latestCheckRuns` and `LatestCheckRun.appSlug` GitHub's; `getLatestCheckRuns` is GitHub only | `vcs.ts` | S10, S11 |
| Comments describe GitHub and GitLab ids (`PRRT_` node ids, discussions) | `vcs.ts` | S10, S11 |
| `TicketEvent` comments describe Slack and Jira; the `note` kind names the `send_slack_message` block | `messaging.ts` | S9 |
| `TicketEvent.pr_ready` carries `RunPullRequest`, whose `provider` is `github | gitlab` in `@shared/contracts`, so a third VCS cannot be reported yet | `messaging.ts` | S10 (decision 19) |
| `GateStatusRef` names GitHub and GitLab, which is why the gate status extensions have not moved | worker `vcs/types.ts` | S10, S11 |
| `GITHUB_APP_PRIVATE_KEY` is base64 in the environment (`adapters/vcs/github-auth.ts:20-21`) while `multiline` invites a raw PEM in the dashboard, and the integration cannot tell the two apart. Proposal: a `pem` format core normalises, so both forms reach the integration the same way | `manifest.ts` | S11 |

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
| `CHAT_SDK_SLACK_TOKEN`, `CHAT_SDK_BOT_NAME` (default `ai-workflow`) | `adapters.ts:73-77`, `infra/runtime-env.ts:48-50` | connection fields (`secret`; `default`) |
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
| `GITLAB_PROJECT_ID` (legacy default repository) | `vcs-config.ts:60` | S10 decides, as for GitHub |
| `GITLAB_BOT_LOGIN` with the `VCS_BOT_LOGIN` fallback | `vcs-config.ts:75` | as for GitHub |
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
S2 adds no column to any run table.

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

### What S2 does not decide

The impact preview before a disable or a reconfigure (decision 9) needs to count
published workflows and runs in flight, which is the engine's knowledge: S4 and
S6. The active provider selection for a single-provider capability was assigned
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
cost a migration; S2 left the choice here for that reason.

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

## Change log

Additive changes to `@integrations/sdk` after S0, newest first. Each entry
names the stage, what was added, and why the context or a port needed it.

| Date | Stage | Change | Reason |
|---|---|---|---|
| 2026-09-18 | S5 | `CORE_HEALTH_SECTION_IDS` and `RESERVED_HEALTH_CHECK_ID`, both refused by conformance | Additive: no manifest field changes and nothing already written stops compiling; conformance refuses two more names. An id core's health page still holds (`github`, `jira`, `database`) would draw a second section for the same word, and a health check called `connection` would collide with the one core adds to every integration's section. `CORE_HEALTH_SECTION_IDS` shrinks: the stage that moves a provider out of core deletes its row in the same change as core's section, which is how the provider's own integration comes to be allowed to take the name. |
| 2026-09-18 | S4 | `secretsKeyMaterial` exported from `services/integrations` | The generic integration step resolves a connection through the same key material every other caller uses; a second reader of `INTEGRATION_SECRETS_KEY` in the engine would be a second derivation of the thing S2 exists to derive once. Additive: nothing that existed changed. |
| 2026-09-18 | S2 | `ConnectionField.identity` | An integration whose fields are all secret has a constant configuration fingerprint, so replacing a Slack bot token with another workspace's would read as a rotation and a run in flight would post into the wrong company's channels. The flag marks a secret that names the account; its value enters the pin as a digest, never in the clear. Optional and absent by default, so every manifest written against S0 is unchanged. |
| 2026-09-18 | S1 | `ErasedIntegrationRuntime` and `ErasedIntegrationCall` | The generated registry has to hold runtimes whose types come from manifests core does not know statically. `IntegrationRuntime<IntegrationManifest>` is not that type: a block executor typed against a literal block type is not assignable to one typed against `IntegrationBlockManifest`, because its parameters are contravariant, and the compiler says so. The erased interface keeps the keys and the results and erases only the parameters, so core can list an integration's blocks, health checks and capabilities and use what each call returns, and S4 narrows the call once where it builds the context. |
| 2026-09-18 | S0 | Contract created | This record |
